// @effect-diagnostics-next-line nodeBuiltinImport:off - Tokens bind a consent snapshot without exposing its work identities.
import * as NodeCrypto from "node:crypto";
import { CommandId, isLiveSubagentShell, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Orchestrator from "./Orchestrator.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as TerminalManager from "../terminal/Manager.ts";

const UNSEALED_LEASE_IDLE_MS = 30_000;

export class SafeShutdownTerminalBusy extends Schema.TaggedError<SafeShutdownTerminalBusy>()(
  "SafeShutdownTerminalBusy",
  {},
) {}

export interface SafeShutdownThread {
  readonly id: ThreadId;
  readonly project: string;
  readonly title: string;
  readonly status: string;
  readonly workToken: string;
}

export interface SafeShutdownSnapshot {
  readonly snapshotToken: string;
  readonly threads: ReadonlyArray<SafeShutdownThread>;
}

type SafeShutdownError =
  | Orchestrator.OrchestratorV2Error
  | ProjectStore.ProjectStoreV2Error
  | ProjectionStore.ProjectionStoreV2Error
  | EffectOutbox.EffectOutboxError
  | SafeShutdownTerminalBusy
  | ThreadCommandExecutor.StartBarrierMissing;

const sameToken = (left: string, right: string) => {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && NodeCrypto.timingSafeEqual(a, b);
};

export class SafeShutdownService extends Context.Service<
  SafeShutdownService,
  {
    readonly snapshot: Effect.Effect<SafeShutdownSnapshot, SafeShutdownError>;
    readonly acquire: (
      leaseId: string,
      snapshotToken: string,
    ) => Effect.Effect<boolean, SafeShutdownError>;
    readonly stop: (
      leaseId: string,
      threadId: ThreadId,
      workToken: string,
    ) => Effect.Effect<"stopped" | "changed", SafeShutdownError>;
    readonly status: (leaseId: string) => Effect.Effect<"quiescing" | "ready", SafeShutdownError>;
    readonly seal: (leaseId: string) => Effect.Effect<boolean, SafeShutdownError>;
    readonly beginExit: (leaseId: string) => Effect.Effect<boolean, SafeShutdownError>;
    readonly release: (leaseId: string) => Effect.Effect<boolean>;
  }
>()("t3/orchestration-v2/SafeShutdownService") {}

export const layerWithExit = (requestExit: Effect.Effect<void>) =>
  Layer.effect(
    SafeShutdownService,
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projects = yield* ProjectStore.ProjectStoreV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const terminals = yield* TerminalManager.TerminalManager;
      const secret = NodeCrypto.randomBytes(32);
      const digest = (value: unknown) =>
        NodeCrypto.createHmac("sha256", secret).update(JSON.stringify(value)).digest("base64url");
      const boundWork = (snapshotToken: string, threadId: ThreadId, token: string) =>
        digest([snapshotToken, threadId, token]);

      const snapshot = Effect.gen(function* () {
        if (yield* terminals.hasTerminalProcesses) return yield* new SafeShutdownTerminalBusy();
        const shell = yield* orchestrator.getShellSnapshot();
        const projectRows = yield* projects.listShells();
        const liveRunThreads = new Set(yield* projections.getRecoveryThreadIds("safe-shutdown"));
        const projectNames = new Map(projectRows.map((project) => [project.id, project.title]));
        const active = [...shell.threads, ...shell.archivedThreads]
          .filter(
            (thread) =>
              isLiveSubagentShell(thread) ||
              liveRunThreads.has(thread.id) ||
              (thread.pullRequests ?? []).some((link) => link.watch !== undefined) ||
              thread.limitRecovery?.autoResume === true,
          )
          .toSorted((a, b) => a.id.localeCompare(b.id));
        const raw = yield* Effect.forEach(
          active,
          (thread) =>
            orchestrator.stopWorkToken(thread.id).pipe(
              Effect.map((workToken) => ({
                id: thread.id,
                project: projectNames.get(thread.projectId) ?? thread.projectId,
                title: thread.title,
                status: thread.status,
                workToken,
              })),
            ),
          { concurrency: 8 },
        );
        const snapshotToken = digest(raw);
        return {
          snapshotToken,
          threads: raw.map((thread) => ({
            ...thread,
            workToken: boundWork(snapshotToken, thread.id, thread.workToken),
          })),
        };
      });
      const ready = Effect.fn("SafeShutdownService.ready")(function* (leaseId: string) {
        const current = yield* snapshot;
        return current.threads.length === 0 && (yield* outbox.shutdownStopsSettled(leaseId));
      });

      return SafeShutdownService.of({
        snapshot,
        acquire: Effect.fn("SafeShutdownService.acquire")((leaseId, snapshotToken) =>
          executor.acquireStartBarrier(
            leaseId,
            snapshot.pipe(Effect.map((current) => sameToken(current.snapshotToken, snapshotToken))),
            snapshotToken,
            UNSEALED_LEASE_IDLE_MS,
          ),
        ),
        stop: Effect.fn("SafeShutdownService.stop")((leaseId, threadId, workToken) =>
          executor.withStartBarrier(leaseId, (snapshotToken) =>
            Effect.gen(function* () {
              const token = yield* orchestrator.stopWorkToken(threadId);
              if (!sameToken(boundWork(snapshotToken, threadId, token), workToken))
                return "changed" as const;
              return yield* orchestrator.stopIfWorkUnchanged({
                threadId,
                commandId: CommandId.make(`command:safe-shutdown:${leaseId}:${threadId}`),
                workToken: token,
              });
            }),
          ),
        ),
        status: Effect.fn("SafeShutdownService.status")((leaseId) =>
          executor.withStartBarrier(leaseId, () =>
            ready(leaseId).pipe(
              Effect.map((isReady) => (isReady ? ("ready" as const) : ("quiescing" as const))),
            ),
          ),
        ),
        seal: Effect.fn("SafeShutdownService.seal")((leaseId) =>
          executor.sealStartBarrier(leaseId, ready(leaseId)),
        ),
        beginExit: Effect.fn("SafeShutdownService.beginExit")((leaseId) =>
          executor.exitWithStartBarrier(leaseId, ready(leaseId), requestExit),
        ),
        release: executor.releaseStartBarrier,
      });
    }),
  ).pipe(Layer.provide(ThreadCommandExecutor.layer));

export const layer = layerWithExit(
  Effect.sync(() => {
    setImmediate(() => void process.emit("SIGTERM"));
  }),
);
