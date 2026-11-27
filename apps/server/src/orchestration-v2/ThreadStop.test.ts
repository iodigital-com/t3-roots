import { assert, it } from "@effect/vitest";
import {
  CommandId,
  AuthSessionId,
  ContextTransferId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Stream from "effect/Stream";
import * as EventStore from "./EventStore.ts";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CLAUDE_PROVIDER } from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import { OrchestrationEffectRequestV2 } from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as SafeShutdownService from "./SafeShutdownService.ts";
import * as SafeShutdownHttp from "./SafeShutdownHttp.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "thread-stop" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);
const layerShutdownTest = SafeShutdownService.layer.pipe(
  Layer.provideMerge(layerTest),
  Layer.provide(Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) })),
  Layer.provideMerge(ThreadCommandExecutor.layer),
  Layer.provide(
    Layer.mock(TerminalManager.TerminalManager)({ hasTerminalProcesses: Effect.succeed(false) }),
  ),
);

const encodeEffectRequest = Schema.encodeSync(Schema.fromJsonString(OrchestrationEffectRequestV2));

const pullRequest = (number: number) => ({
  host: "github.com",
  repository: "pingdotgg/t3code",
  number,
});

const createWatchingThread = (threadId: ThreadId, number: number) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:thread-stop"),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* watch(threadId, number);
  });

const watch = (threadId: ThreadId, number: number) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make(`watch:${threadId}:${number}`),
      threadId,
      ...pullRequest(number),
      watching: true,
      link: { url: `https://github.com/pingdotgg/t3code/pull/${number}`, source: "agent" },
    });
  });

const send = (threadId: ThreadId, text: string, type: "start_immediately" | "queue_after_active") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type },
      createdBy: "user",
      creationSource: "web",
    });
  });

const delegate = (parentThreadId: ThreadId, task: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate:${task}`),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const projection = yield* orchestrator.getThreadProjection(parentThreadId);
    return projection.subagents.find((candidate) => candidate.prompt === task)!.childThreadId!;
  });

const threadState = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return {
      runs: projection.runs.map((run) => `${run.status}${run.queueHeld === true ? ":held" : ""}`),
      watched: (projection.thread.pullRequests ?? [])
        .filter((link) => link.watch !== undefined)
        .map((link) => link.number),
    };
  });

it.effect.each([
  ["idle", "thread.stop"],
  ["idle", "run.interrupt"],
  ["idle", "subagent.stop"],
  ["running", "subagent.stop"],
  ["bound", "subagent.stop"],
  ["correlated", "subagent.stop"],
  ["archived", "thread.stop"],
  ["missing", "thread.stop"],
  ["running", "thread.stop"],
  ["queued", "thread.stop"],
  ["waiting", "thread.stop"],
  ["correlated", "thread.stop"],
  ["provider-active", "thread.stop"],
  ["roster", "thread.stop"],
  ["background", "thread.stop"],
  ["question", "thread.stop"],
  ["restart", "thread.stop"],
] as const)(
  "Stop clears an orphaned follow-up when its child is finished; its own Stop does unless a run is bound (%s via %s)",
  ([childState, type]) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const parentThreadId = ThreadId.make(`thread:orphan-parent:${childState}`);
      yield* createWatchingThread(parentThreadId, 1);
      yield* send(parentThreadId, "parent", "start_immediately");
      const childThreadId = yield* delegate(parentThreadId, "original task");
      const parent = yield* orchestrator.getThreadProjection(parentThreadId);
      const child = yield* orchestrator.getThreadProjection(childThreadId);
      const original = parent.subagents[0]!;
      const originalItem = parent.turnItems.find((item) => item.type === "subagent")!;
      const originalNode = parent.nodes.find((node) => node.id === original.id)!;
      const taskId = NodeId.make(`node:orphan-followup:${childState}`);
      const itemId = TurnItemId.make(`item:orphan-followup:${childState}`);
      const followupChildThreadId =
        childState === "missing" ? ThreadId.make("thread:missing-child") : childThreadId;
      const now = yield* DateTime.now;
      let sequence = 0;
      const apply = (event: Omit<OrchestrationV2DomainEvent, "id">) =>
        projections.apply({
          ...event,
          id: EventId.make(`event:orphan:${childState}:${sequence++}`),
        } as OrchestrationV2DomainEvent);
      yield* apply({
        type: "subagent.updated",
        threadId: parentThreadId,
        occurredAt: now,
        payload: {
          ...original,
          status: "completed",
          result: "Original result",
          completedAt: now,
          completionDelivery: { state: "acknowledged", observedByRunId: null },
        },
      });
      yield* apply({
        type: "context-transfer.created",
        threadId: parentThreadId,
        occurredAt: now,
        payload: {
          ...child.contextTransfers[0]!,
          id: ContextTransferId.make(`transfer:original-result:${childState}`),
          type: "subagent_result",
          sourceThreadId: childThreadId,
          targetThreadId: parentThreadId,
          sourcePoint: { threadId: childThreadId, runId: child.runs[0]!.id },
          targetRunId: parent.runs[0]!.id,
        },
      });
      yield* apply({
        type: "node.updated",
        threadId: parentThreadId,
        occurredAt: now,
        payload: { ...originalNode, status: "completed", completedAt: now },
      });
      yield* apply({
        type: "turn-item.updated",
        threadId: parentThreadId,
        occurredAt: now,
        payload: { ...originalItem, status: "completed", completedAt: now },
      });
      yield* apply({
        type: "subagent.updated",
        threadId: parentThreadId,
        occurredAt: now,
        payload: {
          ...original,
          id: taskId,
          childThreadId: followupChildThreadId,
          status: "running",
          result: null,
          completedAt: null,
        },
      });
      yield* apply({
        type: "node.updated",
        threadId: parentThreadId,
        occurredAt: now,
        payload: { ...originalNode, id: taskId, status: "running" },
      });
      assert.equal(originalItem.type, "subagent");
      if (originalItem.type !== "subagent") return;
      yield* apply({
        type: "turn-item.updated",
        threadId: parentThreadId,
        occurredAt: now,
        payload: {
          ...originalItem,
          id: itemId,
          nodeId: taskId,
          subagentId: taskId,
          childThreadId: followupChildThreadId,
          status: "running",
        },
      });
      const runAtStart = child.runs[0]!;
      const childRunStatus =
        childState === "running" || childState === "queued" || childState === "waiting"
          ? childState
          : childState === "bound"
            ? "running"
            : "completed";
      yield* apply({
        type: "run.updated",
        threadId: childThreadId,
        occurredAt: now,
        payload: { ...runAtStart, status: "running", delegatedTaskId: taskId },
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]?.delegatedTaskId,
        taskId,
      );
      // A terminal write based on the attempt's start snapshot loses a later steer binding.
      yield* apply({
        type: "run.updated",
        threadId: childThreadId,
        occurredAt: now,
        payload: {
          ...runAtStart,
          status: childRunStatus,
          completedAt: childRunStatus === "completed" ? now : null,
          ...(childState === "correlated" || childState === "bound"
            ? { delegatedTaskId: taskId }
            : {}),
        },
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]?.delegatedTaskId,
        childState === "correlated" || childState === "bound" ? taskId : undefined,
      );
      if (childState === "provider-active" || childState === "roster") {
        yield* apply({
          type: "provider-thread.updated",
          threadId: childThreadId,
          occurredAt: now,
          payload: {
            ...child.providerThreads[0]!,
            status: childState === "provider-active" ? "active" : "idle",
            pendingBackgroundTasks:
              childState === "roster" ? [{ taskId: "background-task", kind: "command" }] : [],
          },
        });
      }
      if (childState === "background") {
        yield* apply({
          type: "turn-item.updated",
          threadId: childThreadId,
          occurredAt: now,
          payload: {
            ...originalItem,
            id: TurnItemId.make("item:child-background"),
            threadId: childThreadId,
            runId: runAtStart.id,
            nodeId: runAtStart.rootNodeId,
            type: "command_execution",
            status: "running",
            input: "test background work",
          },
        });
      }
      if (childState === "question") {
        yield* apply({
          type: "runtime-request.updated",
          threadId: childThreadId,
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make("request:child-question"),
            nodeId: runAtStart.rootNodeId!,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        });
      }
      if (childState === "restart") {
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        yield* outbox.enqueue([
          {
            id: `effect:restart-continuation:${runAtStart.id}`,
            commandId: CommandId.make("command:child-restart"),
            threadId: childThreadId,
            request: { type: "provider-runtime.continue", sourceRunId: runAtStart.id },
          },
        ]);
      }
      yield* apply({
        type: "run.updated",
        threadId: parentThreadId,
        occurredAt: now,
        payload: { ...parent.runs[0]!, status: "completed", completedAt: now },
      });
      if (type === "run.interrupt") {
        const run = parent.runs[0]!;
        yield* apply({
          type: "provider-turn.updated",
          threadId: parentThreadId,
          occurredAt: now,
          payload: {
            id: ProviderTurnId.make("provider-turn:orphan-parent"),
            providerThreadId: run.providerThreadId!,
            nodeId: run.rootNodeId!,
            runAttemptId: run.activeAttemptId!,
            nativeTurnRef: null,
            ordinal: 1,
            status: "completed",
            startedAt: now,
            completedAt: now,
          },
        });
        yield* apply({
          type: "run-attempt.updated",
          threadId: parentThreadId,
          occurredAt: now,
          payload: { ...parent.attempts[0]!, status: "completed", completedAt: now },
        });
        yield* apply({
          type: "node.updated",
          threadId: parentThreadId,
          occurredAt: now,
          payload: {
            ...parent.nodes.find((node) => node.id === run.rootNodeId)!,
            status: "completed",
            completedAt: now,
          },
        });
      }
      if (childState === "archived") {
        yield* apply({
          type: "thread.archived",
          threadId: childThreadId,
          occurredAt: now,
          payload: { ...child.thread, archivedAt: now },
        });
      }
      const childBeforeStop = yield* orchestrator.getThreadProjection(childThreadId);
      assert.lengthOf(
        ((yield* orchestrator.getThreadShell(parentThreadId))?.pendingBackgroundTasks ?? []).filter(
          (task) => task.kind === "subagent",
        ),
        1,
      );
      const stop = {
        commandId: CommandId.make(`stop-orphan:${childState}`),
        threadId: parentThreadId,
      };
      yield* orchestrator.dispatch(
        type === "run.interrupt"
          ? { ...stop, type, runId: parent.runs.at(-1)!.id, holdQueue: true }
          : type === "subagent.stop"
            ? { ...stop, type, runId: original.runId!, subagentId: taskId }
            : { ...stop, type },
      );
      const after = yield* orchestrator.getThreadProjection(parentThreadId);
      // The Lineage stop of one subagent leaves the parent's watches alone.
      assert.lengthOf(
        (after.thread.pullRequests ?? []).filter((link) => link.watch !== undefined),
        type === "subagent.stop" ? 1 : 0,
      );
      // A task with a bound run, live or ended, keeps its settlement path.
      const expected =
        childState === "bound" || childState === "correlated"
          ? "running"
          : type === "subagent.stop" || childState === "idle" || childState === "archived"
            ? "cancelled"
            : "running";
      assert.equal(after.subagents.find((task) => task.id === taskId)?.status, expected);
      assert.equal(after.nodes.find((node) => node.id === taskId)?.status, expected);
      assert.equal(after.turnItems.find((item) => item.id === itemId)?.status, expected);
      assert.equal(
        after.subagents.find((task) => task.id === taskId)?.completionDelivery?.state,
        type === "subagent.stop" && expected === "running" ? undefined : "disposed",
      );
      assert.equal(
        after.subagents.find((task) => task.id === original.id)?.result,
        "Original result",
      );
      assert.deepEqual(yield* orchestrator.getThreadProjection(childThreadId), childBeforeStop);
      if (expected === "cancelled") {
        assert.lengthOf(
          (
            (yield* orchestrator.getThreadShell(parentThreadId))?.pendingBackgroundTasks ?? []
          ).filter((task) => task.kind === "subagent"),
          0,
        );
        yield* orchestrator.recoverDelegatedTasks;
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`stop-orphan-again:${childState}`),
          threadId: parentThreadId,
        });
        const repeated = yield* orchestrator.getThreadProjection(parentThreadId);
        assert.equal(repeated.subagents.find((task) => task.id === taskId)?.status, "cancelled");
        assert.deepEqual(repeated.messages, after.messages);
        assert.deepEqual(repeated.contextTransfers, after.contextTransfers);
        if (type === "subagent.stop") {
          // A client that missed the cancel, such as one resumed from an older cache, still
          // shows the task as running. Its Stop gets the ended task back.
          const eventStore = yield* EventStore.EventStoreV2;
          const afterSequence = yield* eventStore.latestSequence({ threadId: parentThreadId });
          yield* orchestrator.dispatch({
            ...stop,
            commandId: CommandId.make(`stop-orphan-stale-client:${childState}`),
            type,
            runId: original.runId!,
            subagentId: taskId,
          });
          const resent = yield* eventStore
            .read({ threadId: parentThreadId, afterSequence })
            .pipe(Stream.runCollect);
          assert.deepEqual(
            resent.flatMap(({ event }) =>
              event.type === "subagent.updated" ? [event.payload.status] : [],
            ),
            ["cancelled"],
          );
        }
      }
    }).pipe(Effect.provide(layerTest)),
);

it.effect("Stop still stops the thread when a delegated child cannot be read", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sql = yield* SqlClient.SqlClient;
    const parentThreadId = ThreadId.make("thread:unreadable-child-parent");
    yield* createWatchingThread(parentThreadId, 1);
    yield* send(parentThreadId, "parent", "start_immediately");
    const childThreadId = yield* delegate(parentThreadId, "unreadable child");
    yield* sql`
      UPDATE orchestration_v2_projection_runs
      SET payload_json = '{"obsolete":true}'
      WHERE thread_id = ${childThreadId}
    `;
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("stop:unreadable-child"),
      threadId: parentThreadId,
      runId: (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!.id,
      holdQueue: true,
    });
    assert.deepEqual(yield* threadState(parentThreadId), { runs: ["interrupted"], watched: [] });
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["run.interrupt", "thread.stop"] as const)(
  "%s Stop ends watches, holds queues, and stops the delegated tasks under the thread",
  (type) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const sql = yield* SqlClient.SqlClient;
      const parentThreadId = ThreadId.make("thread:stop-parent");
      yield* createWatchingThread(parentThreadId, 1);
      yield* send(parentThreadId, "first", "start_immediately");
      const childThreadId = yield* delegate(parentThreadId, "child task");
      assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(childThreadId, 2))));
      const grandchildThreadId = yield* delegate(childThreadId, "grandchild task");
      yield* send(childThreadId, "child follow-up", "queue_after_active");

      const now = yield* DateTime.now;
      const firstRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
      yield* projections.apply({
        id: EventId.make("event:stop-parent:first-run-completed"),
        type: "run.updated",
        threadId: parentThreadId,
        runId: firstRun.id,
        occurredAt: now,
        payload: { ...firstRun, status: "completed", completedAt: now },
      });
      yield* send(parentThreadId, "second", "start_immediately");
      const secondRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;

      const stopCommandId = CommandId.make("stop-parent");
      yield* orchestrator.dispatch(
        type === "thread.stop"
          ? { type, commandId: stopCommandId, threadId: parentThreadId }
          : {
              type,
              commandId: stopCommandId,
              threadId: parentThreadId,
              runId: secondRun.id,
              holdQueue: true,
            },
      );

      assert.deepEqual(yield* threadState(parentThreadId), {
        runs: ["completed", "interrupted"],
        watched: [],
      });
      const parent = yield* orchestrator.getThreadProjection(parentThreadId);
      assert.equal(parent.subagents[0]?.completionDelivery?.state, "disposed");
      const effects = yield* sql<{ readonly effect_type: string }>`
      SELECT effect_type FROM orchestration_v2_effect_outbox WHERE command_id = ${stopCommandId}
    `;
      assert.include(
        effects.map((row) => row.effect_type),
        "delegated-tasks.stop",
      );

      yield* threads.stopDelegatedTasks({ threadId: parentThreadId, commandId: stopCommandId });
      assert.deepEqual(yield* threadState(childThreadId), {
        runs: ["interrupted", "queued:held"],
        watched: [],
      });
      assert.deepEqual((yield* threadState(grandchildThreadId)).runs, ["interrupted"]);

      yield* threads.stopDelegatedTasks({ threadId: parentThreadId, commandId: stopCommandId });
      assert.deepEqual((yield* threadState(childThreadId)).runs, ["interrupted", "queued:held"]);
      // The walk stops each level itself, so the child stops it sends queue no walk of their own.
      const walks = yield* sql<{ readonly command_id: string }>`
      SELECT command_id FROM orchestration_v2_effect_outbox
      WHERE effect_type = 'delegated-tasks.stop'
    `;
      assert.deepEqual(
        walks.map((row) => row.command_id),
        [stopCommandId],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a repeated Stop that changes nothing still stops the delegated tasks", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const parentThreadId = ThreadId.make("thread:stop-again");
    yield* createWatchingThread(parentThreadId, 1);
    yield* send(parentThreadId, "first", "start_immediately");
    yield* delegate(parentThreadId, "stop-again child");
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
    yield* projections.apply({
      id: EventId.make("event:stop-again:run-completed"),
      type: "run.updated",
      threadId: parentThreadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "completed", completedAt: now },
    });
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-again:first"),
      threadId: parentThreadId,
    });

    // The first Stop already disposed the delivery and ended the watch, so this one writes no
    // events, like Stop on a thread an older server stopped without stopping its children.
    const again = yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-again:second"),
      threadId: parentThreadId,
    });
    assert.lengthOf(again.storedEvents, 0);
    const walks = yield* sql<{ readonly command_id: string }>`
      SELECT command_id FROM orchestration_v2_effect_outbox
      WHERE effect_type = 'delegated-tasks.stop'
    `;
    assert.deepEqual(
      walks.map((row) => row.command_id),
      ["stop-again:first", "stop-again:second"],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["thread.stop", "run.interrupt"] as const)(
  "%s cancels buffered wakes and preserves durable queued messages",
  (type) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make(`thread:stop-buffered:${type}`);
      yield* createWatchingThread(threadId, 5);
      yield* send(threadId, "active", "start_immediately");
      yield* send(threadId, "user follow-up", "queue_after_active");
      for (const creationSource of ["provider", "server"] as const) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`notification:${type}:${creationSource}`),
          threadId,
          messageId: MessageId.make(`notification:${type}:${creationSource}`),
          text: "Background activity updated",
          attachments: [],
          createdBy: "agent",
          creationSource,
          notification: {
            source: { kind: "background_task" },
            outcome: "updated",
            summary: "Background activity updated",
          },
          dispatchMode: { type: "queue_after_active" },
        });
      }
      const before = yield* orchestrator.getThreadProjection(threadId);
      const buffered = before.runs.find((run) =>
        before.messages.some(
          (message) => message.id === run.userMessageId && message.creationSource === "provider",
        ),
      )!;
      const stop = { commandId: CommandId.make(`stop:${type}`), threadId };
      yield* orchestrator.dispatch(
        type === "run.interrupt"
          ? { ...stop, type, runId: before.runs[0]!.id, holdQueue: true }
          : { ...stop, type },
      );
      const stopped = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(stopped.runs.find((run) => run.id === buffered.id)?.status, "cancelled");
      assert.equal(
        stopped.attempts.find((attempt) => attempt.runId === buffered.id)?.status,
        "cancelled",
      );
      assert.equal(
        stopped.nodes.find((node) => node.id === buffered.rootNodeId)?.status,
        "cancelled",
      );
      assert.deepEqual(
        stopped.runs.filter((run) => run.status === "queued").map((run) => run.queueHeld),
        [true, true],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a message the user sends after Stop releases the held queue; an agent's does not", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:stop-release");
    const agentSend = (text: string) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`agent-send:${text}`),
        threadId,
        messageId: MessageId.make(`message:${threadId}:${text}`),
        text,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "mcp",
      });
    yield* createWatchingThread(threadId, 6);
    yield* send(threadId, "active", "start_immediately");
    yield* send(threadId, "queued before the stop", "queue_after_active");
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-release"),
      threadId,
    });
    assert.deepEqual((yield* threadState(threadId)).runs, ["interrupted", "queued:held"]);

    // An agent's message starts on the idle thread, but the hold is the user's.
    yield* agentSend("agent nudge");
    assert.deepEqual((yield* threadState(threadId)).runs, [
      "interrupted",
      "queued:held",
      "starting",
    ]);
    const nudge = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make("event:stop-release:nudge-completed"),
      type: "run.updated",
      threadId,
      runId: nudge.id,
      occurredAt: now,
      payload: { ...nudge, status: "completed", completedAt: now },
    });

    // A scheduled task the user created is not the user coming back.
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("scheduled-send"),
      threadId,
      messageId: MessageId.make(`message:${threadId}:scheduled`),
      text: "Nightly check",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
      scheduledTaskId: ScheduledTaskId.make("scheduled:nightly"),
    });
    const scheduled = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
    assert.deepEqual((yield* threadState(threadId)).runs, [
      "interrupted",
      "queued:held",
      "completed",
      "starting",
    ]);
    yield* projections.apply({
      id: EventId.make("event:stop-release:scheduled-completed"),
      type: "run.updated",
      threadId,
      runId: scheduled.id,
      occurredAt: now,
      payload: { ...scheduled, status: "completed", completedAt: now },
    });

    // The user is back: the held message follows their run, and a wake that
    // queues behind it is not held by the old Stop.
    yield* send(threadId, "back", "start_immediately");
    yield* agentSend("task finished");
    assert.deepEqual((yield* threadState(threadId)).runs, [
      "interrupted",
      "queued",
      "completed",
      "completed",
      "starting",
      "queued",
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "an agent's auto send queues behind a run that is still stopping instead of steering it",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const threadId = ThreadId.make("thread:stop-mcp-send");
      yield* createWatchingThread(threadId, 6);
      yield* send(threadId, "active", "start_immediately");
      const initial = yield* orchestrator.getThreadProjection(threadId);
      const run = initial.runs[0]!;
      const providerSessionId = ProviderSessionId.make("session:stop-mcp-send");
      const now = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make("event:stop-mcp-send:session"),
        type: "provider-session.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: providerSessionId,
          driver: adapter.driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: "/repo",
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
      yield* projections.apply({
        id: EventId.make("event:stop-mcp-send:provider-thread"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: { ...initial.providerThreads[0]!, providerSessionId },
      });
      yield* projections.apply({
        id: EventId.make("event:stop-mcp-send:running"),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status: "running", startedAt: now },
      });
      yield* projections.apply({
        id: EventId.make("event:stop-mcp-send:turn"),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: ProviderTurnId.make("provider-turn:stop-mcp-send"),
          providerThreadId: run.providerThreadId!,
          nodeId: run.rootNodeId!,
          runAttemptId: run.activeAttemptId!,
          nativeTurnRef: null,
          ordinal: 1,
          status: "running",
          startedAt: now,
          completedAt: null,
        },
      });
      yield* send(threadId, "queued before the stop", "queue_after_active");
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-mcp-send"),
        threadId,
      });
      assert.deepEqual((yield* threadState(threadId)).runs, ["running", "queued:held"]);

      const result = yield* threads.sendToThread({
        projectId: ProjectId.make("project:thread-stop"),
        commandId: CommandId.make("command:stop-mcp-send"),
        threadId,
        messageId: MessageId.make("message:stop-mcp-send"),
        text: "Follow up after Stop",
        attachments: [],
        mode: "auto",
        createdBy: "agent",
        creationSource: "mcp",
      });
      assert.equal(result.delivery, "queued");
      assert.deepEqual((yield* threadState(threadId)).runs, [
        "running",
        "queued:held",
        "queued:held",
      ]);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a conditional Stop refuses a replacement run", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:conditional-stop-replacement");
    yield* createWatchingThread(threadId, 32);
    yield* send(threadId, "old", "start_immediately");
    const workToken = yield* orchestrator.stopWorkToken(threadId);
    const old = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make("event:conditional-stop:old-completed"),
      type: "run.updated",
      threadId,
      runId: old.id,
      occurredAt: now,
      payload: { ...old, status: "completed", completedAt: now },
    });
    yield* send(threadId, "replacement", "start_immediately");

    const result = yield* orchestrator.stopIfWorkUnchanged({
      commandId: CommandId.make("stop:conditional-replacement"),
      threadId,
      workToken,
    });
    assert.equal(result, "changed");
    assert.deepEqual(yield* threadState(threadId), {
      runs: ["completed", "starting"],
      watched: [32],
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a shutdown snapshot binds consent to work and leaves its queue held", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const shutdown = yield* SafeShutdownService.SafeShutdownService;
    const threadId = ThreadId.make("thread:shutdown-snapshot");
    yield* createWatchingThread(threadId, 37);
    yield* send(threadId, "active", "start_immediately");
    yield* send(threadId, "queued", "queue_after_active");
    const snapshot = yield* shutdown.snapshot;
    assert.deepEqual(
      snapshot.threads.map((thread) => thread.id),
      [threadId],
    );
    assert.isTrue(yield* shutdown.acquire("lease", snapshot.snapshotToken));
    yield* send(threadId, "not confirmed", "queue_after_active").pipe(Effect.flip);
    assert.equal(
      yield* shutdown.stop("lease", threadId, snapshot.threads[0]!.workToken),
      "stopped",
    );
    assert.equal(yield* shutdown.status("lease"), "ready");
    assert.deepEqual((yield* threadState(threadId)).runs, ["interrupted", "queued:held"]);
    assert.isTrue(yield* shutdown.release("lease"));
    yield* orchestrator.resumeQueuedRuns;
    assert.deepEqual((yield* threadState(threadId)).runs, ["interrupted", "queued:held"]);
  }).pipe(Effect.provide(layerShutdownTest)),
);

it.effect("the authenticated backend protocol holds stopped work through exit", () =>
  Effect.gen(function* () {
    let exitRequested = false;
    const service = SafeShutdownService.layerWithExit(
      Effect.sync(() => {
        exitRequested = true;
      }),
    ).pipe(
      Layer.provideMerge(layerTest),
      Layer.provide(
        Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
      ),
      Layer.provideMerge(ThreadCommandExecutor.layer),
      Layer.provide(
        Layer.mock(TerminalManager.TerminalManager)({
          hasTerminalProcesses: Effect.succeed(false),
        }),
      ),
    );
    const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
      authenticateHttpRequest: () =>
        Effect.succeed({
          sessionId: AuthSessionId.make("session:desktop"),
          subject: "desktop-bootstrap",
          method: "bearer-access-token",
          scopes: ["orchestration:operate"],
        }),
    });
    yield* Effect.gen(function* () {
      const commands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const threadId = ThreadId.make("thread:shutdown-http");
      yield* createWatchingThread(threadId, 48);
      yield* send(threadId, "active", "start_immediately");
      yield* send(threadId, "queued", "queue_after_active");
      const call = (command: unknown) =>
        Effect.gen(function* () {
          const request = HttpServerRequest.fromWeb(
            new Request("http://localhost/api/orchestration/desktop-safe-shutdown", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(command),
            }),
          );
          const response = HttpServerResponse.toWeb(
            yield* SafeShutdownHttp.handler.pipe(
              Effect.provideService(HttpServerRequest.HttpServerRequest, request),
            ),
          );
          assert.equal(response.status, 200);
          return yield* Effect.promise(() => response.json());
        });
      const snapshot = (yield* call({ type: "snapshot" })) as {
        snapshotToken: string;
        threads: Array<{ id: string; workToken: string }>;
      };
      assert.deepEqual(
        snapshot.threads.map((thread) => thread.id),
        [threadId],
      );
      assert.deepEqual(
        yield* call({ type: "acquire", leaseId: "lease", snapshotToken: snapshot.snapshotToken }),
        { type: "acquire", acquired: true },
      );
      assert.deepEqual(
        yield* call({
          type: "stop",
          leaseId: "lease",
          threadId,
          workToken: snapshot.threads[0]!.workToken,
        }),
        { type: "stop", status: "stopped" },
      );
      assert.deepEqual(yield* call({ type: "status", leaseId: "lease" }), {
        type: "status",
        status: "ready",
      });
      assert.deepEqual(yield* call({ type: "seal", leaseId: "lease" }), {
        type: "seal",
        sealed: true,
      });
      assert.deepEqual(yield* call({ type: "backend-exit", leaseId: "lease" }), {
        type: "backend-exit",
        accepted: true,
      });
      assert.isTrue(exitRequested);
      yield* TestClock.adjust("60 seconds");
      assert.equal(
        (yield* Effect.flip(commands.withStartAdmission(Effect.void)))._tag,
        "StartAdmissionBlocked",
      );
      assert.deepEqual(yield* call({ type: "release", leaseId: "lease" }), {
        type: "release",
        released: false,
      });
      assert.deepEqual((yield* threadState(threadId)).runs, ["interrupted", "queued:held"]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          service,
          auth,
          Layer.succeed(ServerConfig.ServerConfig, {
            mode: "desktop",
          } as ServerConfig.ServerConfig["Service"]),
        ),
      ),
    );
  }),
);

it.effect("shutdown waits for the confirmed stop's provider interrupt to finish", () =>
  Effect.gen(function* () {
    const shutdown = yield* SafeShutdownService.SafeShutdownService;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const threadId = ThreadId.make("thread:shutdown-interrupt-pending");
    yield* createWatchingThread(threadId, 45);
    const snapshot = yield* shutdown.snapshot;
    assert.isTrue(yield* shutdown.acquire("lease", snapshot.snapshotToken));
    assert.equal(
      yield* shutdown.stop("lease", threadId, snapshot.threads[0]!.workToken),
      "stopped",
    );
    yield* outbox.enqueue([
      {
        id: "effect:shutdown-interrupt-pending",
        commandId: CommandId.make(`command:safe-shutdown:lease:${threadId}`),
        threadId,
        request: {
          type: "provider-turn.interrupt",
          providerSessionId: ProviderSessionId.make("session:shutdown-interrupt-pending"),
          providerThreadId: ProviderThreadId.make("provider-thread:shutdown-interrupt-pending"),
          providerTurnId: ProviderTurnId.make("provider-turn:shutdown-interrupt-pending"),
        },
      },
    ]);
    assert.equal(yield* shutdown.status("lease"), "quiescing");
    yield* outbox.claimNext({ workerId: "shutdown-test" });
    assert.isTrue(
      yield* outbox.succeed({
        effectId: "effect:shutdown-interrupt-pending",
        workerId: "shutdown-test",
      }),
    );
    assert.equal(yield* shutdown.status("lease"), "ready");
    yield* outbox.enqueue([
      {
        id: "effect:shutdown-interrupt-failed",
        commandId: CommandId.make(`command:safe-shutdown:lease:${threadId}`),
        threadId,
        request: {
          type: "provider-turn.interrupt",
          providerSessionId: ProviderSessionId.make("session:shutdown-interrupt-failed"),
          providerThreadId: ProviderThreadId.make("provider-thread:shutdown-interrupt-failed"),
          providerTurnId: ProviderTurnId.make("provider-turn:shutdown-interrupt-failed"),
        },
      },
    ]);
    yield* outbox.claimNext({ workerId: "shutdown-test" });
    assert.isTrue(
      yield* outbox.fail({
        effectId: "effect:shutdown-interrupt-failed",
        workerId: "shutdown-test",
        error: "interrupt failed",
      }),
    );
    assert.equal(yield* shutdown.status("lease"), "quiescing");
  }).pipe(Effect.provide(layerShutdownTest)),
);

it.effect("an abandoned shutdown releases admission but keeps stopped queues held", () =>
  Effect.gen(function* () {
    const shutdown = yield* SafeShutdownService.SafeShutdownService;
    const commands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:shutdown-abandoned");
    yield* createWatchingThread(threadId, 46);
    yield* send(threadId, "active", "start_immediately");
    yield* send(threadId, "queued", "queue_after_active");
    const snapshot = yield* shutdown.snapshot;
    assert.isTrue(yield* shutdown.acquire("abandoned", snapshot.snapshotToken));
    assert.equal(
      yield* shutdown.stop("abandoned", threadId, snapshot.threads[0]!.workToken),
      "stopped",
    );
    yield* TestClock.adjust("31 seconds");
    yield* commands.withStartAdmission(Effect.void);
    yield* orchestrator.resumeQueuedRuns;
    assert.deepEqual((yield* threadState(threadId)).runs, ["interrupted", "queued:held"]);
  }).pipe(Effect.provide(layerShutdownTest)),
);

it.effect("a confirmed Stop cancels a claimed paused start so its interrupt can run", () =>
  Effect.gen(function* () {
    const shutdown = yield* SafeShutdownService.SafeShutdownService;
    const commands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const claimed = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const threadId = ThreadId.make("thread:shutdown-claimed-start");
    yield* createWatchingThread(threadId, 44);
    yield* send(threadId, "active", "start_immediately");
    const snapshot = yield* shutdown.snapshot;
    assert.isTrue(yield* shutdown.acquire("lease", snapshot.snapshotToken));
    const layerExecutor = Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, {
      execute: (effect) =>
        effect.request.type === "provider-turn.interrupt"
          ? Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid)
          : Deferred.succeed(claimed, undefined).pipe(
              Effect.andThen(commands.awaitStartAdmission(Effect.die("stopped start ran"))),
            ),
    });
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.provide(
        EffectWorker.layerWithOptions({ workerId: "shutdown-test" }).pipe(
          Layer.provide(layerExecutor),
          Layer.provide(Layer.succeed(EffectOutbox.EffectOutboxV2, outbox)),
        ),
      ),
    );
    const running = yield* worker.runOnce().pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(claimed);
    assert.equal(
      yield* shutdown.stop("lease", threadId, snapshot.threads[0]!.workToken),
      "stopped",
    );
    yield* Fiber.join(running);
    yield* outbox.enqueue([
      {
        id: "effect:shutdown-interrupt",
        commandId: CommandId.make("command:shutdown-interrupt"),
        threadId,
        request: {
          type: "provider-turn.interrupt",
          providerSessionId: ProviderSessionId.make("session:shutdown-interrupt"),
          providerThreadId: ProviderThreadId.make("provider-thread:shutdown-interrupt"),
          providerTurnId: ProviderTurnId.make("provider-turn:shutdown-interrupt"),
        },
      },
    ]);
    assert.isTrue(yield* worker.runOnce());
    assert.isTrue(yield* Deferred.isDone(interrupted));
    assert.isTrue(yield* shutdown.release("lease"));
  }).pipe(Effect.provide(layerShutdownTest)),
);

it.effect("a shutdown acquisition refuses work that appeared after inspection", () =>
  Effect.gen(function* () {
    const shutdown = yield* SafeShutdownService.SafeShutdownService;
    const threadId = ThreadId.make("thread:shutdown-changed");
    yield* createWatchingThread(threadId, 38);
    yield* send(threadId, "active", "start_immediately");
    const snapshot = yield* shutdown.snapshot;
    yield* send(threadId, "new", "queue_after_active");
    assert.isFalse(yield* shutdown.acquire("lease", snapshot.snapshotToken));
    yield* send(threadId, "another", "queue_after_active");
    assert.deepEqual((yield* threadState(threadId)).runs, ["starting", "queued", "queued"]);
  }).pipe(Effect.provide(layerShutdownTest)),
);

it.effect("shutdown inspection refuses while an embedded terminal process is alive", () =>
  Effect.gen(function* () {
    const shutdown = yield* SafeShutdownService.SafeShutdownService;
    const threadId = ThreadId.make("thread:shutdown-terminal");
    yield* createWatchingThread(threadId, 47);
    yield* send(threadId, "active", "start_immediately");
    const failure = yield* Effect.flip(shutdown.snapshot);
    assert.equal(failure._tag, "SafeShutdownTerminalBusy");
    assert.deepEqual((yield* threadState(threadId)).runs, ["starting"]);
  }).pipe(
    Effect.provide(
      SafeShutdownService.layer.pipe(
        Layer.provideMerge(layerTest),
        Layer.provide(
          Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
        ),
        Layer.provideMerge(ThreadCommandExecutor.layer),
        Layer.provide(
          Layer.mock(TerminalManager.TerminalManager)({
            hasTerminalProcesses: Effect.succeed(true),
          }),
        ),
      ),
    ),
  ),
);

it.effect("the shutdown snapshot includes an archived running thread", () =>
  Effect.gen(function* () {
    const shutdown = yield* SafeShutdownService.SafeShutdownService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:shutdown-archived");
    yield* createWatchingThread(threadId, 39);
    yield* send(threadId, "active", "start_immediately");
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive:shutdown"),
      threadId,
    });
    const snapshot = yield* shutdown.snapshot;
    assert.deepEqual(
      snapshot.threads.map((thread) => thread.id),
      [threadId],
    );
  }).pipe(Effect.provide(layerShutdownTest)),
);

it.effect("shutdown inspection includes silent compaction until its queue is held", () =>
  Effect.gen(function* () {
    const shutdown = yield* SafeShutdownService.SafeShutdownService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:shutdown-silent-compaction");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create:shutdown-compaction"),
      threadId,
      projectId: ProjectId.make("project:thread-stop"),
      title: "Compacting",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* send(threadId, "active", "start_immediately");
    const initial = yield* orchestrator.getThreadProjection(threadId);
    const run = initial.runs[0]!;
    const message = initial.messages.find((candidate) => candidate.id === run.userMessageId)!;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make("event:shutdown-silent-message"),
      type: "message.updated",
      threadId,
      occurredAt: now,
      payload: { ...message, text: "/compact", createdBy: "agent", creationSource: "server" },
    });
    assert.isNull(
      (yield* orchestrator.getShellSnapshot()).threads.find((thread) => thread.id === threadId)!
        .activityRunStatus,
    );
    assert.deepEqual(
      (yield* shutdown.snapshot).threads.map((thread) => thread.id),
      [threadId],
    );
    yield* projections.apply({
      id: EventId.make("event:shutdown-silent-queued"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "queued", startedAt: null, queueHeld: false },
    });
    assert.deepEqual(
      (yield* shutdown.snapshot).threads.map((thread) => thread.id),
      [threadId],
    );
    yield* projections.apply({
      id: EventId.make("event:shutdown-silent-held"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "queued", startedAt: null, queueHeld: true },
    });
    yield* (yield* EffectOutbox.EffectOutboxV2).cancelUnsettled({
      threadId,
      effectTypes: EffectOutbox.START_EFFECT_TYPES,
      reason: "The held run has no pending start.",
    });
    assert.isEmpty((yield* shutdown.snapshot).threads);
  }).pipe(Effect.provide(layerShutdownTest)),
);

it.effect("a shutdown token cannot stop a different thread", () =>
  Effect.gen(function* () {
    const shutdown = yield* SafeShutdownService.SafeShutdownService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const first = ThreadId.make("thread:shutdown-consented");
    const other = ThreadId.make("thread:shutdown-other");
    yield* createWatchingThread(first, 40);
    yield* send(first, "active", "start_immediately");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create:shutdown-other"),
      threadId: other,
      projectId: ProjectId.make("project:thread-stop"),
      title: "Other",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const snapshot = yield* shutdown.snapshot;
    assert.deepEqual(
      snapshot.threads.map((thread) => thread.id),
      [first],
    );
    assert.isTrue(yield* shutdown.acquire("lease", snapshot.snapshotToken));
    const before = yield* orchestrator.getThreadEventSequence(other);
    assert.equal(yield* shutdown.stop("lease", other, snapshot.threads[0]!.workToken), "changed");
    assert.equal(yield* orchestrator.getThreadEventSequence(other), before);
    assert.isTrue(yield* shutdown.release("lease"));
  }).pipe(Effect.provide(layerShutdownTest)),
);

it.effect("the admission barrier rejects new messages while leaving Stop available", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const threadId = ThreadId.make("thread:admission-barrier");
    yield* createWatchingThread(threadId, 35);
    yield* send(threadId, "active", "start_immediately");
    assert.isTrue(yield* executor.acquireStartBarrier("lease", Effect.succeed(true)));

    yield* send(threadId, "new", "queue_after_active").pipe(Effect.flip);
    assert.deepEqual((yield* threadState(threadId)).runs, ["starting"]);
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop:admission-barrier"),
      threadId,
      stopDelegatedTasks: false,
    });
    assert.deepEqual((yield* threadState(threadId)).runs, ["interrupted"]);
    assert.isTrue(yield* executor.releaseStartBarrier("lease"));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("automatic limit recovery waits for shutdown admission before rechecking state", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const threadId = ThreadId.make("thread:admission-limit-recovery");
    yield* createWatchingThread(threadId, 43);
    yield* send(threadId, "active", "start_immediately");
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    assert.isTrue(yield* executor.acquireStartBarrier("lease", Effect.succeed(true)));
    const arm = yield* orchestrator
      .autoArmLimitRecovery({
        commandId: CommandId.make("arm:admission-limit-recovery"),
        threadId,
        limitRecovery: {
          runId: run.id,
          resetAt: "2026-11-27T12:00:00.000Z",
          autoResume: true,
          snooze: false,
        },
      })
      .pipe(Effect.forkChild({ startImmediately: true }));
    assert.isNotTrue(
      (yield* orchestrator.getThreadProjection(threadId)).thread.limitRecovery?.autoResume,
    );
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop:admission-limit-recovery"),
      threadId,
    });
    assert.isTrue(yield* executor.releaseStartBarrier("lease"));
    assert.equal((yield* Fiber.join(arm).pipe(Effect.flip))._tag, "OrchestratorDispatchError");
    assert.isNotTrue(
      (yield* orchestrator.getThreadProjection(threadId)).thread.limitRecovery?.autoResume,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("the admission barrier prevents queued-run recovery from starting work", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:admission-queue");
    yield* createWatchingThread(threadId, 36);
    yield* send(threadId, "active", "start_immediately");
    yield* send(threadId, "queued", "queue_after_active");
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make("event:admission-queue:completed"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "completed", completedAt: now },
    });
    assert.isTrue(yield* executor.acquireStartBarrier("lease", Effect.succeed(true)));
    assert.equal(yield* orchestrator.resumeQueuedRuns, 0);
    assert.deepEqual((yield* threadState(threadId)).runs, ["completed", "queued"]);
    assert.isTrue(yield* executor.releaseStartBarrier("lease"));
    yield* orchestrator.resumeQueuedRuns;
    assert.deepEqual((yield* threadState(threadId)).runs, ["completed", "starting"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a conditional Stop holds queued work and does not cascade to children", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:conditional-stop-queue");
    yield* createWatchingThread(threadId, 33);
    yield* send(threadId, "active", "start_immediately");
    yield* delegate(threadId, "child");
    yield* send(threadId, "queued", "queue_after_active");
    const workToken = yield* orchestrator.stopWorkToken(threadId);

    const result = yield* orchestrator.stopIfWorkUnchanged({
      commandId: CommandId.make("stop:conditional-queue"),
      threadId,
      workToken,
    });
    assert.equal(result, "stopped");
    assert.deepEqual((yield* threadState(threadId)).runs, ["interrupted", "queued:held"]);
    const walks = yield* sql<{ readonly effect_id: string }>`
      SELECT effect_id FROM orchestration_v2_effect_outbox
      WHERE effect_type = 'delegated-tasks.stop' AND thread_id = ${threadId}
    `;
    assert.isEmpty(walks);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a conditional Stop refuses work added to the same run", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:conditional-stop-child");
    yield* createWatchingThread(threadId, 34);
    yield* send(threadId, "active", "start_immediately");
    const workToken = yield* orchestrator.stopWorkToken(threadId);
    const childThreadId = yield* delegate(threadId, "new child");
    const result = yield* orchestrator.stopIfWorkUnchanged({
      commandId: CommandId.make("stop:conditional-child"),
      threadId,
      workToken,
    });
    assert.equal(result, "changed");
    assert.equal(
      (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]?.status,
      "starting",
    );
    assert.deepEqual((yield* threadState(threadId)).runs, ["starting"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a conditional Stop refuses a link request added after consent", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:conditional-stop-link");
    yield* createWatchingThread(threadId, 41);
    yield* send(threadId, "active", "start_immediately");
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    const token = yield* orchestrator.stopWorkToken(threadId);
    const turnItemId = TurnItemId.make("item:conditional-stop-link");
    yield* orchestrator.dispatch({
      type: "link_request.record",
      commandId: CommandId.make("link:conditional-stop"),
      threadId,
      runId: run.id,
      nodeId: run.rootNodeId!,
      turnItemId,
      reason: "",
      linkStatus: "pending",
    });
    const result = yield* orchestrator.stopIfWorkUnchanged({
      commandId: CommandId.make("stop:conditional-link"),
      threadId,
      workToken: token,
    });
    assert.equal(result, "changed");
    const item = (yield* orchestrator.getThreadProjection(threadId)).turnItems.find(
      (candidate) => candidate.id === turnItemId,
    );
    assert.equal(item?.type === "link_request" && item.linkStatus, "pending");
    assert.deepEqual((yield* threadState(threadId)).runs, ["starting"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a conditional Stop refuses a secret request added after consent", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:conditional-stop-secret");
    yield* createWatchingThread(threadId, 42);
    yield* send(threadId, "active", "start_immediately");
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    const token = yield* orchestrator.stopWorkToken(threadId);
    const turnItemId = TurnItemId.make("item:conditional-stop-secret");
    yield* orchestrator.dispatch({
      type: "secret_request.record",
      commandId: CommandId.make("secret:conditional-stop"),
      threadId,
      runId: run.id,
      nodeId: run.rootNodeId!,
      turnItemId,
      label: "Token",
      reason: "Needed for the work",
      secretStatus: "pending",
    });
    const result = yield* orchestrator.stopIfWorkUnchanged({
      commandId: CommandId.make("stop:conditional-secret"),
      threadId,
      workToken: token,
    });
    assert.equal(result, "changed");
    const item = (yield* orchestrator.getThreadProjection(threadId)).turnItems.find(
      (candidate) => candidate.id === turnItemId,
    );
    assert.equal(item?.type === "secret_request" && item.secretStatus, "pending");
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "thread.stop ends an idle thread's watches and accepts a thread with nothing to stop",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:stop-idle");
      yield* createWatchingThread(threadId, 3);

      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-idle"),
        threadId,
      });
      assert.deepEqual(yield* threadState(threadId), { runs: [], watched: [] });

      const again = yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-idle-again"),
        threadId,
      });
      assert.lengthOf(again.storedEvents, 0);
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each([false, true])(
  "a completed watch records whether it ended through Stop (%s)",
  (stopped) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make(`thread:watch-completion:${stopped}`);
      yield* createWatchingThread(threadId, 7);
      yield* send(threadId, "watch", "start_immediately");
      const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      const now = yield* DateTime.now;
      const completedRun = {
        ...run,
        providerThreadId: run.providerThreadId ?? ProviderThreadId.make("provider-thread:watch"),
        status: "completed" as const,
        startedAt: now,
        completedAt: now,
      };
      yield* projections.apply({
        id: EventId.make("event:watch-completed"),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: completedRun,
      });
      assert.isFalse((yield* projections.getThreadShell(threadId))?.latestRunStopRequested);

      yield* orchestrator.dispatch(
        stopped
          ? { type: "thread.stop", commandId: CommandId.make("stop-watch"), threadId }
          : {
              type: "thread.pull-request.watch",
              commandId: CommandId.make("finish-watch"),
              threadId,
              ...pullRequest(7),
              watching: false,
            },
      );
      const shell = yield* projections.getThreadShell(threadId);
      const snapshot = (yield* projections.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      );
      const memoryShell = ProjectionStore.threadShellFromProjection(
        yield* orchestrator.getThreadProjection(threadId),
      );
      for (const result of [shell, snapshot, memoryShell]) {
        assert.equal(result?.status, "completed");
        assert.isEmpty(result?.pendingBackgroundTasks ?? []);
        assert.equal(result?.latestRunStopRequested, stopped);
      }

      yield* send(threadId, "next", "start_immediately");
      assert.isFalse((yield* projections.getThreadShell(threadId))?.latestRunStopRequested);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a run Stop reached cannot delegate or start a watch, even after it ends", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:stop-barrier");
    yield* createWatchingThread(threadId, 4);
    yield* send(threadId, "work", "start_immediately");
    const now = yield* DateTime.now;
    const run = { ...(yield* orchestrator.getThreadProjection(threadId)).runs[0]!, startedAt: now };
    yield* projections.apply({
      id: EventId.make("event:stop-barrier:running"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "running" },
    });
    yield* send(threadId, "queued", "queue_after_active");
    const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "queued-run.cancel",
      commandId: CommandId.make("cancel-queued"),
      threadId,
      runId: queued.id,
    });
    yield* projections.apply({
      id: EventId.make("event:stop-barrier:interrupt-request"),
      type: "turn-item.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("turn-item:stop-barrier:interrupt-request"),
        threadId,
        runId: run.id,
        nodeId: run.rootNodeId!,
        providerThreadId: run.providerThreadId!,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1_000,
        status: "completed",
        title: "Interrupt requested",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "run_interrupt_request",
        message: "Stop",
      },
    });

    assert.isTrue(Exit.isFailure(yield* Effect.exit(delegate(threadId, "late task"))));
    assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(threadId, 5))));

    yield* projections.apply({
      id: EventId.make("event:stop-barrier:interrupted"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "interrupted", completedAt: now },
    });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(threadId, 5))));
    assert.deepEqual(yield* threadState(threadId), {
      runs: ["interrupted", "cancelled"],
      watched: [4],
    });

    for (const watching of [false, true]) {
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make(`manual-watch:${watching}`),
        threadId,
        ...pullRequest(4),
        watching,
      });
    }
    assert.deepEqual((yield* threadState(threadId)).watched, [4]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("thread.stop keeps a restart continuation of the stopped run from starting", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:stop-restart");
    yield* createWatchingThread(threadId, 8);
    yield* send(threadId, "work", "start_immediately");
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    yield* projections.apply({
      id: EventId.make("event:stop-restart:cancelled"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "cancelled", startedAt: null, completedAt: now },
    });
    const at = DateTime.formatIso(now);
    yield* sql`
      INSERT INTO orchestration_v2_effect_outbox (
        effect_id, command_id, thread_id, effect_type, payload_json, status,
        attempt_count, available_at, created_at, updated_at
      ) VALUES (
        ${`effect:restart-continuation:${run.id}`}, 'command:restart', ${threadId},
        'provider-runtime.continue',
        ${encodeEffectRequest({ type: "provider-runtime.continue", sourceRunId: run.id })},
        'pending', 0, ${at}, ${at}, ${at}
      )
    `;

    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-restart"),
      threadId,
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("restart-continuation"),
      threadId,
      messageId: MessageId.make("message:restart-continuation"),
      text: "Continue.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
      restartContinuationOfRunId: run.id,
    });
    assert.deepEqual(yield* threadState(threadId), { runs: ["cancelled"], watched: [] });
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["thread.stop", "run.interrupt"] as const)(
  "a successful %s blocks a newer restart continuation when completion timestamps tie",
  (stopType) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:stop-resumed-queue");
      yield* createWatchingThread(threadId, 12);
      yield* send(threadId, "first", "start_immediately");
      yield* send(threadId, "queued", "queue_after_active");
      const now = yield* DateTime.now;
      const [first, queued] = (yield* orchestrator.getThreadProjection(threadId)).runs;
      assert.isDefined(first);
      assert.isDefined(queued);
      for (const run of [first!, queued!]) {
        yield* projections.apply({
          id: EventId.make(`event:stop-resumed-queue:hold:${run.id}`),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload:
            run.id === first!.id
              ? { ...run, status: "completed", completedAt: now }
              : { ...run, queueHeld: true },
        });
      }
      yield* send(threadId, "restart source", "start_immediately");
      const source = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
      yield* projections.apply({
        id: EventId.make("event:stop-resumed-queue:restart-cancelled"),
        type: "run.updated",
        threadId,
        runId: source.id,
        occurredAt: now,
        payload: { ...source, status: "cancelled", startedAt: now, completedAt: now },
      });
      const at = DateTime.formatIso(now);
      yield* sql`
        INSERT INTO orchestration_v2_effect_outbox (
          effect_id, command_id, thread_id, effect_type, payload_json, status,
          attempt_count, available_at, created_at, updated_at
        ) VALUES (
          ${`effect:restart-continuation:${source.id}`}, 'command:restart', ${threadId},
          'provider-runtime.continue',
          ${encodeEffectRequest({ type: "provider-runtime.continue", sourceRunId: source.id })},
          'pending', 0, ${at}, ${at}, ${at}
        )
      `;
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-older-queue"),
        threadId,
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.id === queued!.id,
        )?.status,
        "starting",
      );
      yield* orchestrator.dispatch(
        stopType === "thread.stop"
          ? { type: "thread.stop", commandId: CommandId.make("stop-resumed-queue"), threadId }
          : {
              type: "run.interrupt",
              commandId: CommandId.make("stop-resumed-queue"),
              threadId,
              runId: queued!.id,
              holdQueue: true,
            },
      );
      const stopped = yield* orchestrator.getThreadProjection(threadId);
      const interrupted = stopped.runs.find((run) => run.id === queued!.id)!;
      assert.equal(interrupted.status, "interrupted");
      assert.equal(DateTime.toEpochMillis(interrupted.completedAt!), DateTime.toEpochMillis(now));
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("restart-after-stop"),
        threadId,
        messageId: MessageId.make("message:restart-after-stop"),
        text: "Continue.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "server",
        restartContinuationOfRunId: source.id,
      });
      assert.deepEqual(yield* threadState(threadId), {
        runs: ["completed", "cancelled", "interrupted"],
        watched: [],
      });
    }).pipe(Effect.provide(layerTest.pipe(Layer.provideMerge(TestClock.layer())))),
);

it.effect.each([
  { ending: "cancelled", question: "resolved" },
  { ending: "interrupted", question: "resolved" },
  { ending: "completed", question: "pending" },
  { ending: "failed", question: "pending" },
] as const)(
  "a $ending delegated task leaves its async question $question",
  ({ ending, question }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const parentThreadId = ThreadId.make(`thread:stop-question-parent:${ending}`);
      yield* createWatchingThread(parentThreadId, 20);
      yield* send(parentThreadId, "first", "start_immediately");
      const childThreadId = yield* delegate(parentThreadId, `question task ${ending}`);
      const childRun = (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]!;
      assert.equal(
        (yield* orchestrator.getThreadProjection(childThreadId)).nodes.find(
          (node) => node.id === childRun.rootNodeId,
        )?.runId,
        childRun.id,
      );
      const now = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make("event:stop-question:request"),
        type: "runtime-request.updated",
        threadId: childThreadId,
        runId: childRun.id,
        occurredAt: now,
        payload: {
          id: RuntimeRequestId.make("request:stop-question"),
          nodeId: childRun.rootNodeId!,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: now,
          resolvedAt: null,
        },
      });
      const request = Effect.map(
        orchestrator.getThreadProjection(childThreadId),
        (projection) => projection.runtimeRequests[0],
      );

      yield* orchestrator.recoverDelegatedTask(childThreadId, { sourceRunId: childRun.id });
      assert.equal((yield* request)?.status, "pending");
      if (ending === "interrupted") {
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop-question-child"),
          threadId: childThreadId,
        });
      } else {
        yield* projections.apply({
          id: EventId.make(`event:stop-question:${ending}`),
          type: "run.updated",
          threadId: childThreadId,
          runId: childRun.id,
          occurredAt: now,
          payload: { ...childRun, status: ending, startedAt: now, completedAt: now },
        });
      }
      yield* orchestrator.recoverDelegatedTask(childThreadId, { sourceRunId: childRun.id });
      assert.equal((yield* request)?.status, question);
      assert.equal((yield* request)?.decision, question === "resolved" ? "cancel" : undefined);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a delegated task that cannot be stopped fails the walk after its siblings stop", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const parentThreadId = ThreadId.make("thread:stop-partial");
    yield* createWatchingThread(parentThreadId, 6);
    yield* send(parentThreadId, "work", "start_immediately");
    const childThreadId = yield* delegate(parentThreadId, "stoppable task");
    const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
    yield* projections.apply({
      id: EventId.make("event:stop-partial:missing-task"),
      type: "subagent.updated",
      threadId: parentThreadId,
      runId: task.runId!,
      nodeId: NodeId.make("node:stop-partial:missing"),
      providerInstanceId: instanceId,
      occurredAt: yield* DateTime.now,
      payload: {
        ...task,
        id: NodeId.make("node:stop-partial:missing"),
        childThreadId: ThreadId.make("thread:stop-partial:missing"),
        startedAt: DateTime.subtract(task.startedAt!, { hours: 1 }),
      },
    });

    const walked = yield* Effect.exit(
      threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("stop-partial"),
      }),
    );
    assert.isTrue(Exit.isFailure(walked));
    assert.deepEqual((yield* threadState(childThreadId)).runs, ["interrupted"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("thread.stop marks a turn it cannot interrupt so a late agent watch is refused", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:stop-lost-session");
    yield* createWatchingThread(threadId, 11);
    yield* send(threadId, "work", "start_immediately");
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    yield* projections.apply({
      id: EventId.make("event:stop-lost-session:running"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "running", startedAt: now },
    });
    yield* projections.apply({
      id: EventId.make("event:stop-lost-session:turn"),
      type: "provider-turn.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: ProviderTurnId.make("provider-turn:stop-lost-session"),
        providerThreadId: run.providerThreadId!,
        nodeId: run.rootNodeId!,
        runAttemptId: run.activeAttemptId!,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    });

    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-lost-session"),
      threadId,
    });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(threadId, 12))));
    assert.deepEqual(yield* threadState(threadId), { runs: ["running"], watched: [] });
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["missing session", "completed", "failed", "cancelled"] as const)(
  "a native child Stop only settles a confirmed %s outcome and preserves its owner and sibling",
  (providerState) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:native-child-stop");
      yield* createWatchingThread(threadId, 20);
      yield* send(threadId, "owner", "start_immediately");
      yield* delegate(threadId, "native-child-fixture");
      const before = yield* orchestrator.getThreadProjection(threadId);
      const run = before.runs[0]!;
      const now = yield* DateTime.now;
      const subagent = {
        ...before.subagents[0]!,
        origin: "provider_native" as const,
        driver: CLAUDE_PROVIDER,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        nativeTaskRef: {
          driver: CLAUDE_PROVIDER,
          nativeId: "claude-task",
          strength: "strong" as const,
        },
        status: "running" as const,
        startedAt: now,
      };
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:agent"),
        type: "subagent.updated",
        threadId,
        runId: run.id,
        nodeId: subagent.id,
        occurredAt: now,
        payload: subagent,
      });
      const sibling = {
        ...subagent,
        id: NodeId.make("node:native-stop-sibling"),
        childThreadId: null,
      };
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:sibling"),
        type: "subagent.updated",
        threadId,
        runId: run.id,
        nodeId: sibling.id,
        occurredAt: now,
        payload: sibling,
      });
      const item = before.turnItems.find(
        (item) => item.type === "subagent" && item.subagentId === subagent.id,
      )!;
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:item"),
        type: "turn-item.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...item, status: "running", completedAt: null },
      });
      const childRoot = {
        ...before.nodes.find((node) => node.id === run.rootNodeId)!,
        id: NodeId.make("node:native-stop-child-root"),
        threadId: subagent.childThreadId!,
        runId: null,
        parentNodeId: null,
        status: "running" as const,
        countsForRun: false,
        completedAt: null,
      };
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:child-root"),
        type: "node.updated",
        threadId: childRoot.threadId,
        nodeId: childRoot.id,
        occurredAt: now,
        payload: childRoot,
      });
      const childTurnId = ProviderTurnId.make("turn:native-stop-child");
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:child-turn"),
        type: "provider-turn.updated",
        threadId: childRoot.threadId,
        nodeId: childRoot.id,
        occurredAt: now,
        payload: {
          id: childTurnId,
          providerThreadId: ProviderThreadId.make("provider-thread:native-stop-child"),
          nodeId: childRoot.id,
          runAttemptId: null,
          nativeTurnRef: null,
          ordinal: 1,
          status: "running",
          startedAt: now,
          completedAt: null,
        },
      });
      const providerThread = before.providerThreads.find(
        (thread) => thread.id === run.providerThreadId,
      )!;
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:provider-thread"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...providerThread,
          driver: CLAUDE_PROVIDER,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          providerSessionId: ProviderSessionId.make("session:native-child-stop"),
        },
      });
      const providerTurnId = ProviderTurnId.make("turn:native-child-stop");
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:provider-turn"),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: providerTurnId,
          providerThreadId: providerThread.id,
          nodeId: run.rootNodeId!,
          runAttemptId: run.activeAttemptId!,
          nativeTurnRef: null,
          ordinal: 1,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:owner-completed"),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status: "completed", startedAt: now, completedAt: now },
      });
      yield* send(threadId, "queued", "queue_after_active");
      const stateBefore = yield* threadState(threadId);
      const eventStore = yield* EventStore.EventStoreV2;
      const afterSequence = yield* eventStore.latestSequence({ threadId });
      const confirmedStatus =
        providerState === "completed" || providerState === "failed" || providerState === "cancelled"
          ? providerState
          : null;
      const confirmedOutcome =
        confirmedStatus === null
          ? undefined
          : { status: confirmedStatus, completedAt: now, result: "Actual provider outcome" };
      const commandId = CommandId.make("stop-native-child");
      yield* orchestrator.dispatch({
        type: "subagent.stop",
        commandId,
        threadId,
        runId: run.id,
        subagentId: subagent.id,
      });
      assert.deepEqual(yield* threadState(threadId), stateBefore);
      const effects = yield* sql<{ payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_effect_outbox WHERE command_id = ${commandId}
    `;
      assert.equal(effects.length, 1);
      assert.deepEqual(JSON.parse(effects[0]!.payload_json), {
        type: "provider-turn.interrupt",
        providerSessionId: "session:native-child-stop",
        providerThreadId: providerThread.id,
        providerTurnId,
        subagent: { id: subagent.id, nativeTaskId: "claude-task" },
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).subagents[0]?.status,
        "running",
      );
      const unrelated = yield* Effect.exit(
        orchestrator.dispatch({
          type: "subagent.stop",
          commandId: CommandId.make("stop-unknown-child"),
          threadId,
          runId: run.id,
          subagentId: NodeId.make("unknown-child"),
        }),
      );
      assert.isTrue(Exit.isFailure(unrelated));
      yield* TestClock.adjust("1 second");
      yield* sql`DELETE FROM orchestration_v2_effect_outbox WHERE command_id != ${commandId}`;
      if (providerState === "missing session") {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* worker.drain();
      } else {
        yield* orchestrator.dispatch({
          type: "thread.background-work.settle",
          commandId: CommandId.make("repair-native-child"),
          threadId,
          providerThreadId: providerThread.id,
          providerTurnId,
          subagent: { id: subagent.id, stoppedAt: now, outcome: confirmedOutcome! },
        });
      }
      const settled = yield* orchestrator.getThreadProjection(threadId);
      const cancelled = settled.subagents.find((task) => task.id === subagent.id)!;
      if (confirmedOutcome === undefined) {
        const events = yield* eventStore.read({ threadId, afterSequence }).pipe(Stream.runCollect);
        assert.isFalse(
          events.some(
            ({ event }) =>
              (event.type === "subagent.updated" ||
                event.type === "node.updated" ||
                event.type === "turn-item.updated") &&
              ["completed", "failed", "cancelled", "interrupted"].includes(event.payload.status),
          ),
        );
        assert.equal(cancelled.status, "running");
        assert.equal(
          (yield* orchestrator.getThreadProjection(childRoot.threadId)).nodes.find(
            (node) => node.id === childRoot.id,
          )?.status,
          "running",
        );
        assert.deepEqual(yield* threadState(threadId), stateBefore);
        return;
      }

      const repaired = yield* eventStore.read({ threadId, afterSequence }).pipe(Stream.runCollect);
      const terminal = repaired.flatMap(({ event }) =>
        (event.type === "subagent.updated" ||
          event.type === "node.updated" ||
          event.type === "turn-item.updated") &&
        event.payload.status === confirmedStatus
          ? [event]
          : [],
      );
      assert.deepEqual(terminal.map((event) => event.type).sort(), [
        "node.updated",
        "subagent.updated",
        "turn-item.updated",
      ]);
      for (const event of terminal) {
        assert.equal(event.nodeId, subagent.id);
        assert.equal(
          DateTime.toEpochMillis(event.payload.completedAt!),
          DateTime.toEpochMillis(confirmedOutcome!.completedAt),
        );
        if (event.type === "subagent.updated" || event.type === "turn-item.updated") {
          assert.isDefined(event.payload.updatedAt);
        }
      }

      assert.equal(cancelled.status, confirmedStatus);
      assert.isNotNull(cancelled.completedAt);
      assert.equal(
        DateTime.toEpochMillis(cancelled.completedAt!),
        DateTime.toEpochMillis(confirmedOutcome!.completedAt),
      );
      assert.equal(cancelled.result, confirmedOutcome!.result);
      assert.equal(
        settled.turnItems.find((candidate) => candidate.id === item.id)?.status,
        confirmedStatus,
      );
      const child = yield* orchestrator.getThreadProjection(childRoot.threadId);
      assert.equal(child.nodes.find((node) => node.id === childRoot.id)?.status, confirmedStatus);
      assert.equal(
        child.providerTurns.find((turn) => turn.id === childTurnId)?.status,
        confirmedStatus,
      );
      assert.isNotNull(child.nodes.find((node) => node.id === childRoot.id)?.completedAt);
      assert.equal(settled.subagents.find((task) => task.id === sibling.id)?.status, "running");
      assert.deepEqual(yield* threadState(threadId), stateBefore);
      yield* TestClock.adjust("1 second");
      const resumedAt = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:resume"),
        type: "subagent.updated",
        threadId,
        runId: run.id,
        nodeId: subagent.id,
        occurredAt: resumedAt,
        payload: { ...cancelled, status: "running", startedAt: resumedAt, completedAt: null },
      });
      yield* orchestrator.dispatch({
        type: "thread.background-work.settle",
        commandId: CommandId.make("old-stop-after-resume"),
        threadId,
        providerThreadId: providerThread.id,
        providerTurnId,
        subagent: { id: subagent.id, stoppedAt: now, outcome: confirmedOutcome },
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
          (task) => task.id === subagent.id,
        )?.status,
        "running",
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("an unanswered Stop is flagged until Force stop ends the run with its own reason", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:force-stop");
    yield* createWatchingThread(threadId, 6);
    yield* send(threadId, "work", "start_immediately");
    const now = yield* DateTime.now;
    const started = yield* orchestrator.getThreadProjection(threadId);
    const run = started.runs[0]!;
    const providerThreadId = run.providerThreadId!;
    const providerTurnId = ProviderTurnId.make("provider-turn:force-stop");
    const apply = (event: Omit<OrchestrationV2DomainEvent, "id" | "threadId">) =>
      projections.apply({
        ...event,
        id: EventId.make(`event:force-stop:${event.type}`),
        threadId,
      } as OrchestrationV2DomainEvent);
    const attempt = started.attempts[0]!;
    const attemptId = attempt.id;
    yield* apply({
      type: "run.updated",
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "running", startedAt: now, activeAttemptId: attemptId },
    });
    yield* apply({
      type: "run-attempt.updated",
      occurredAt: now,
      payload: { ...attempt, status: "running", startedAt: now },
    });
    yield* apply({
      type: "provider-turn.updated",
      occurredAt: now,
      payload: {
        id: providerTurnId,
        providerThreadId,
        nodeId: run.rootNodeId!,
        runAttemptId: attemptId,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    });
    yield* apply({
      type: "turn-item.updated",
      runId: run.id,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("turn-item:force-stop:interrupt-request"),
        threadId,
        runId: run.id,
        nodeId: run.rootNodeId!,
        providerThreadId,
        providerTurnId,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1_000,
        status: "completed",
        title: "Interrupt requested",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "run_interrupt_request",
        message: "Stopped by user",
      },
    });
    const target = { threadId, providerThreadId, providerTurnId };
    const request = Effect.map(orchestrator.getThreadProjection(threadId), (projection) =>
      projection.turnItems.find((item) => item.type === "run_interrupt_request"),
    );

    yield* orchestrator.dispatch({
      ...target,
      type: "thread.interrupt.unresponsive",
      commandId: CommandId.make("force-stop:unresponsive"),
    });
    const flagged = yield* request;
    assert.isTrue(
      flagged?.type === "run_interrupt_request" && flagged.unresponsiveAt !== undefined,
    );
    assert.deepEqual((yield* threadState(threadId)).runs, ["running"]);

    yield* orchestrator.dispatch({
      ...target,
      type: "thread.background-work.settle",
      commandId: CommandId.make("force-stop:settle"),
      reason: "Force stopped by user",
    });
    const settled = yield* orchestrator.getThreadProjection(threadId);
    assert.deepEqual(
      settled.runs.map((candidate) => candidate.status),
      ["interrupted"],
    );
    const result = settled.turnItems.find((item) => item.type === "run_interrupt_result");
    assert.equal(
      result?.type === "run_interrupt_result" ? result.message : undefined,
      "Force stopped by user",
    );

    // A provider confirming late changes nothing once the run has ended.
    const late = yield* orchestrator.dispatch({
      ...target,
      type: "thread.interrupt.unresponsive",
      commandId: CommandId.make("force-stop:late-unresponsive"),
    });
    assert.lengthOf(late.storedEvents, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["Stop", "Force stop"] as const)(
  "%s ends a running run whose provider turn already completed",
  (action) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:stop-completed-turn");
      yield* createWatchingThread(threadId, 7);
      yield* send(threadId, "go", "start_immediately");
      const now = yield* DateTime.now;
      const started = yield* orchestrator.getThreadProjection(threadId);
      const run = started.runs[0]!;
      const attempt = started.attempts[0]!;
      const providerThreadId = run.providerThreadId!;
      const providerTurnId = ProviderTurnId.make("provider-turn:stop-completed-turn");
      const apply = (event: Omit<OrchestrationV2DomainEvent, "id" | "threadId">) =>
        projections.apply({
          ...event,
          id: EventId.make(`event:stop-completed-turn:${event.type}`),
          threadId,
        } as OrchestrationV2DomainEvent);
      yield* apply({
        type: "run.updated",
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status: "running", startedAt: now, activeAttemptId: attempt.id },
      });
      yield* apply({
        type: "run-attempt.updated",
        occurredAt: now,
        payload: { ...attempt, status: "completed", startedAt: now, completedAt: now },
      });
      yield* apply({
        type: "provider-turn.updated",
        occurredAt: now,
        payload: {
          id: providerTurnId,
          providerThreadId,
          nodeId: run.rootNodeId!,
          runAttemptId: attempt.id,
          nativeTurnRef: null,
          ordinal: 1,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      // The provider session was already released.
      yield* apply({
        type: "provider-thread.updated",
        occurredAt: now,
        payload: {
          ...started.providerThreads.find((thread) => thread.id === providerThreadId)!,
          providerSessionId: ProviderSessionId.make("session:gone"),
        },
      });
      yield* send(threadId, "follow", "queue_after_active");

      if (action === "Stop") {
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop-completed-turn"),
          threadId,
        });
      } else {
        const threads = yield* ThreadManagementService.ThreadManagementService;
        yield* threads.forceStopThread({ threadId });
      }
      const stopped = yield* orchestrator.getThreadProjection(threadId);
      assert.notEqual(stopped.runs[0]?.status, "running", "the stopped run is still running");
      assert.deepInclude(stopped.attempts[0], { status: "completed", completedAt: now });
      assert.isTrue(
        stopped.turnItems.some((item) => item.type === "run_interrupt_result"),
        "the stopped run has no interrupt result",
      );
    }).pipe(Effect.provide(layerTest)),
);

// A finished delegated child whose native subagent the provider never reported ending,
// with no open turn item, and a nested native subagent on that agent's own thread.
it.effect(
  "Stop settles a delegated row whose finished child still records a running native subagent",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const parentThreadId = ThreadId.make("thread:held-row");
      yield* createWatchingThread(parentThreadId, 30);
      yield* send(parentThreadId, "parent", "start_immediately");
      const childThreadId = yield* delegate(parentThreadId, "held child");
      const child = yield* orchestrator.getThreadProjection(childThreadId);
      const childRun = child.runs[0]!;
      const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
      const now = yield* DateTime.now;
      const nativeThreadId = ThreadId.make("thread:held-row-native");
      const nestedThreadId = ThreadId.make("thread:held-row-nested");
      yield* createWatchingThread(nativeThreadId, 31);
      yield* createWatchingThread(nestedThreadId, 32);
      const nativeProviderThreadId = ProviderThreadId.make("provider-thread:held-row-native");
      const runningRoot = (threadId: ThreadId, id: NodeId) => ({
        ...child.nodes.find((node) => node.id === childRun.rootNodeId)!,
        id,
        rootNodeId: id,
        threadId,
        runId: null,
        parentNodeId: null,
        status: "running" as const,
        countsForRun: false,
        completedAt: null,
      });
      const nativeRoot = runningRoot(nativeThreadId, NodeId.make("node:held-row-native-root"));
      const nestedRoot = runningRoot(nestedThreadId, NodeId.make("node:held-row-nested-root"));
      for (const root of [nativeRoot, nestedRoot]) {
        yield* projections.apply({
          id: EventId.make(`event:held-row:${root.id}`),
          type: "node.updated",
          threadId: root.threadId,
          nodeId: root.id,
          occurredAt: now,
          payload: root,
        });
      }
      yield* projections.apply({
        id: EventId.make("event:held-row:native-turn"),
        type: "provider-turn.updated",
        threadId: nativeThreadId,
        nodeId: nativeRoot.id,
        occurredAt: now,
        payload: {
          id: ProviderTurnId.make("turn:held-row-native"),
          providerThreadId: nativeProviderThreadId,
          nodeId: nativeRoot.id,
          runAttemptId: null,
          nativeTurnRef: null,
          ordinal: 1,
          status: "running",
          startedAt: now,
          completedAt: null,
        },
      });
      const native = {
        ...task,
        id: NodeId.make("node:held-row-native"),
        threadId: childThreadId,
        runId: childRun.id,
        parentNodeId: childRun.rootNodeId!,
        origin: "provider_native" as const,
        providerThreadId: nativeProviderThreadId,
        childThreadId: nativeThreadId,
        status: "running" as const,
        completionDelivery: undefined,
      };
      yield* projections.apply({
        id: EventId.make("event:held-row:native"),
        type: "subagent.updated",
        threadId: childThreadId,
        runId: childRun.id,
        occurredAt: now,
        payload: native,
      });
      yield* projections.apply({
        id: EventId.make("event:held-row:nested"),
        type: "subagent.updated",
        threadId: nativeThreadId,
        occurredAt: now,
        payload: {
          ...native,
          id: NodeId.make("node:held-row-nested"),
          threadId: nativeThreadId,
          runId: null,
          parentNodeId: nativeRoot.id,
          childThreadId: nestedThreadId,
        },
      });
      yield* projections.apply({
        id: EventId.make("event:held-row:child-completed"),
        type: "run.updated",
        threadId: childThreadId,
        runId: childRun.id,
        occurredAt: now,
        payload: { ...childRun, status: "completed", startedAt: now, completedAt: now },
      });
      yield* orchestrator.recoverDelegatedTasks;
      assert.equal(
        (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]?.status,
        "running",
      );
      const statuses = Effect.gen(function* () {
        const nativeAfter = yield* orchestrator.getThreadProjection(nativeThreadId);
        const nestedAfter = yield* orchestrator.getThreadProjection(nestedThreadId);
        return {
          row: (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]?.status,
          native: (yield* orchestrator.getThreadProjection(childThreadId)).subagents.find(
            (subagent) => subagent.id === native.id,
          )?.status,
          nativeRoot: nativeAfter.nodes.find((node) => node.id === nativeRoot.id)?.status,
          nested: nativeAfter.subagents[0]?.status,
          nestedRoot: nestedAfter.nodes.find((node) => node.id === nestedRoot.id)?.status,
        };
      });

      // The row's Stop: the parent's task, then the child thread.
      yield* orchestrator.dispatch({
        type: "subagent.stop",
        commandId: CommandId.make("held-row:stop-task"),
        threadId: parentThreadId,
        runId: task.runId!,
        subagentId: task.id,
      });
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("held-row:stop-child"),
        threadId: childThreadId,
      });
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* worker.drain();
      assert.deepEqual(yield* statuses, {
        row: "completed",
        native: "interrupted",
        nativeRoot: "interrupted",
        nested: "interrupted",
        nestedRoot: "interrupted",
      });
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { followUp: "started its turn", startedBeforeRelease: true },
  { followUp: "was promoted", startedBeforeRelease: false },
  { followUp: "switched provider instance", startedBeforeRelease: true, switchesInstance: true },
  { followUp: "has fresh context", startedBeforeRelease: true, freshContext: true },
])(
  "Force stop keeps only the session of a queued follow-up that $followUp",
  ({ startedBeforeRelease, switchesInstance = false, freshContext = false }) =>
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("thread-stop-force-stop-follow-up");
      const driver = adapter.driver;
      const otherInstanceId = ProviderInstanceId.make("codex-other");
      const eventQueues = new Map<
        ProviderSessionId,
        Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>
      >();
      const started: Array<ProviderAdapter.ProviderAdapterV2TurnInput> = [];
      const interrupted: Array<ProviderAdapter.ProviderAdapterV2InterruptInput> = [];
      let opened = 0;
      // Fresh context on a one-thread-per-session provider puts the follow-up on its own session.
      // The session itself reports shared threads so fresh-context cleanup leaves the stopped
      // run's session to Force stop, as pending background work would.
      const adapterCapabilities = freshContext
        ? {
            ...CodexProviderCapabilitiesV2,
            sessions: {
              ...CodexProviderCapabilitiesV2.sessions,
              supportsMultipleProviderThreadsPerSession: false,
            },
          }
        : CodexProviderCapabilitiesV2;
      const liveAdapter = (
        instanceId: ProviderInstanceId,
      ): ProviderAdapter.ProviderAdapterV2["Service"] => ({
        ...adapter,
        instanceId,
        getCapabilities: () => Effect.succeed(adapterCapabilities),
        openSession: (input) =>
          Effect.gen(function* () {
            opened += 1;
            const now = yield* DateTime.now;
            const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
            eventQueues.set(input.providerSessionId, events);
            return {
              instanceId,
              driver,
              providerSessionId: input.providerSessionId,
              providerSession: {
                id: input.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd,
                model: modelSelection.model,
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ensureThread: ({ threadId }) =>
                Effect.succeed({
                  id: ProviderThreadId.make(
                    `provider-thread:${input.providerSessionId}:${threadId}`,
                  ),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                }),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              startTurn: (turn) =>
                Effect.gen(function* () {
                  started.push(turn);
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                      providerThreadId: turn.providerThread.id,
                      nodeId: turn.rootNodeId,
                      runAttemptId: turn.attemptId,
                      nativeTurnRef: {
                        driver,
                        nativeId: `native:${turn.attemptId}`,
                        strength: "strong",
                      },
                      ordinal: turn.providerTurnOrdinal,
                      status: "running",
                      startedAt: now,
                      completedAt: null,
                    },
                  });
                }),
              steerTurn: () => Effect.die("unused"),
              interruptTurn: (interrupt) => Effect.sync(() => interrupted.push(interrupt)),
              respondToRuntimeRequest: () => Effect.die("unused"),
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      });
      // The settlement promotes the follow-up; optionally its turn starts before Force stop releases.
      const layerSessionsStartingFollowUpFirst = Layer.effect(
        ProviderSessionManager.ProviderSessionManagerV2,
        Effect.gen(function* () {
          const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          return ProviderSessionManager.ProviderSessionManagerV2.of({
            ...sessions,
            releaseUnlessBusy: (input) =>
              (startedBeforeRelease ? worker.drain().pipe(Effect.orDie) : Effect.void).pipe(
                Effect.andThen(sessions.releaseUnlessBusy(input)),
              ),
          });
        }),
      );
      const layerLive = ThreadManagementService.layer.pipe(
        Layer.provide(layerSessionsStartingFollowUpFirst),
        Layer.provideMerge(
          Layer.mergeAll(
            layerDatabase,
            ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
            EventStore.layer.pipe(Layer.provide(layerDatabase)),
            EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
            ProviderReplayHarness.layerWithRegistry(
              { name: "thread-stop-force-stop-follow-up" },
              ProviderAdapterRegistry.layerFromAdapters([
                liveAdapter(instanceId),
                liveAdapter(otherInstanceId),
              ]),
              { databaseLayer: layerDatabase, runEffectWorker: false },
            ),
          ),
        ),
        Layer.provideMerge(ServerSettings.layerTest()),
        Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
      );

      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const threadId = ThreadId.make("thread:force-stop-follow-up");
        const runningTurn = orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create:force-stop-follow-up"),
          threadId,
          projectId: ProjectId.make("project:thread-stop"),
          title: "Force stop follow-up",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const firstRunning = yield* runningTurn;
        yield* send(threadId, "first", "start_immediately");
        yield* worker.drain();
        yield* Fiber.join(firstRunning);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("send:force-stop-follow-up"),
          threadId,
          messageId: MessageId.make("message:force-stop-follow-up"),
          text: "follow-up",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          ...(switchesInstance
            ? { modelSelection: { ...modelSelection, instanceId: otherInstanceId } }
            : {}),
          ...(freshContext ? { freshContext } : {}),
          createdBy: "user",
          creationSource: "web",
        });

        const result = yield* threads.forceStopThread({ threadId });
        yield* worker.drain();

        assert.deepEqual(
          started.map((turn) => turn.runOrdinal),
          [1, 2],
          "the queued follow-up did not start its turn",
        );
        assert.equal(
          opened,
          switchesInstance || freshContext ? 2 : 1,
          "Force stop tore down the session the follow-up was promoted onto",
        );
        const [stopped, followUp] = [started[0]!, started[1]!];
        const providerSessionId = followUp.providerThread.providerSessionId!;
        assert.equal(
          yield* sessions.isLive(stopped.providerThread.providerSessionId!),
          !switchesInstance && !freshContext,
          "Force stop kept the stopped run's session for a follow-up on another session",
        );
        assert.isFalse(
          interrupted.some((interrupt) =>
            String(interrupt.providerTurnId).includes(followUp.attemptId),
          ),
          "Force stop of the first run interrupted the follow-up's turn",
        );
        assert.isTrue(
          yield* sessions.isLive(providerSessionId),
          "Force stop of the first run released the session the follow-up's turn is running on",
        );
        assert.deepEqual(
          result,
          { outcome: "released", sharedWithThreadIds: [] },
          "Force stop detached the thread the follow-up runs on as if its session were shared",
        );

        // The first run's provider never confirms the stop; the follow-up's turn ends normally.
        yield* Queue.offer(eventQueues.get(providerSessionId)!, {
          type: "turn.terminal",
          driver,
          providerThreadId: followUp.providerThread.id,
          providerTurnId: ProviderTurnId.make(`provider-turn:${followUp.attemptId}`),
          runOrdinal: followUp.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* worker.drain();
        yield* TestClock.adjust("31 minutes");
        assert.isFalse(
          yield* sessions.isLive(providerSessionId),
          "the stopped run's unconfirmed turn kept the session from going idle",
        );
      }).pipe(Effect.provide(layerLive));
    }),
);
