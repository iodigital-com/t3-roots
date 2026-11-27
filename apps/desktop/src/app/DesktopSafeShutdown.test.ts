import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ThreadId, type DesktopSafeShutdownRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopSafeShutdown from "./DesktopSafeShutdown.ts";

it.effect.each([
  { wslExited: true, loseReply: false },
  { wslExited: false, loseReply: false },
  { wslExited: false, loseReply: true },
])(
  "only accepts quit after the WSL exit is confirmed: $wslExited, lost reply: $loseReply",
  ({ wslExited, loseReply }) =>
    Effect.gen(function* () {
      const states = new Map([
        ["windows", true],
        ["wsl", true],
      ]);
      const calls: string[] = [];
      let sshCommitted = false;
      let sshRecovered = false;
      let wslGone = wslExited;
      const exiting = new Set<string>();
      const restarted: string[] = [];
      const instance = (id: string, pid: number) =>
        ({
          id: DesktopBackendPool.BackendInstanceId(id),
          snapshot: Effect.succeed({
            desiredRunning: true,
            ready: true,
            activePid: Option.some(pid),
            activeRunId: 1,
          }),
          currentConfig: Effect.succeedSome({
            httpBaseUrl: new URL(`http://${id.startsWith("wsl:") ? "wsl" : id}.example`),
            ...(id.startsWith("wsl:") ? { runningDistro: "Ubuntu" } : {}),
          }),
          stop: () => Effect.void,
          start: Effect.sync(() => {
            restarted.push(id);
          }),
        }) as unknown as DesktopBackendPool.DesktopBackendInstance;
      const layerPool = DesktopBackendPool.layerTest([
        instance("windows", 1),
        instance("wsl:Ubuntu", 2),
      ]);
      const layerAuth = Layer.mock(DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth)({
        getBearerTokenFor: () => Effect.succeed("desktop-token"),
      });
      const layerSsh = Layer.mock(DesktopSshEnvironment.DesktopSshEnvironment)({
        prepareTaggedQuit: () => Effect.succeed(true),
        releaseTaggedQuit: () => Effect.succeed(true),
        commitTaggedQuit: () =>
          Effect.sync(() => {
            sshCommitted = true;
            return true;
          }),
        recoverTaggedQuit: () =>
          Effect.sync(() => {
            sshRecovered = true;
            return true;
          }),
      });
      const layerHttp = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            const id = new URL(request.url).hostname.split(".")[0]!;
            const body =
              request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
            const command = JSON.parse(body) as DesktopSafeShutdownRequest;
            calls.push(`${id}:${command.type}`);
            let value: unknown;
            switch (command.type) {
              case "capabilities":
                value = { type: command.type, version: 1, pid: id === "windows" ? 1 : 2 };
                break;
              case "snapshot":
                value = {
                  type: command.type,
                  snapshotToken: `snapshot-${id}`,
                  threads: [
                    {
                      id: "thread:same",
                      project: id,
                      title: id,
                      status: "running",
                      workToken: `work-${id}`,
                    },
                  ],
                };
                break;
              case "acquire":
                value = { type: command.type, acquired: true };
                break;
              case "stop":
                states.set(id, false);
                value = { type: command.type, status: "stopped" };
                break;
              case "status":
                value = { type: command.type, status: states.get(id) ? "quiescing" : "ready" };
                break;
              case "seal":
                value = { type: command.type, sealed: !states.get(id) };
                break;
              case "backend-exit":
                exiting.add(id);
                value = { type: command.type, accepted: true };
                break;
              case "release":
                value = { type: command.type, released: !exiting.has(id) };
                break;
            }
            return HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify(value), {
                status: command.type === "backend-exit" && id === "wsl" && loseReply ? 503 : 200,
                headers: { "content-type": "application/json" },
              }),
            );
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* DesktopSafeShutdown.make(() => Effect.succeed(true));
        assert.deepEqual(yield* service.execute({ type: "capabilities" }), {
          type: "capabilities",
          version: 1,
          atomicSnapshot: true,
          conditionalStop: true,
          blocksStartsThroughShutdown: true,
          coordinatedRelease: true,
          releaseKeepsStopped: true,
          recoverableAcquire: true,
          recoverableAfterClientCrash: true,
          coordinatesDesktopBackends: true,
          preservesTerminalProcesses: true,
        });
        const snapshot = (yield* service.execute({ type: "snapshot" })) as {
          snapshotToken: string;
          threads: Array<{ id: string; workToken: string }>;
        };
        assert.lengthOf(snapshot.threads, 2);
        assert.notEqual(snapshot.threads[0]!.id, snapshot.threads[1]!.id);
        assert.deepEqual(
          yield* service.execute({
            type: "acquire",
            leaseId: "lease",
            snapshotToken: snapshot.snapshotToken,
          }),
          { type: "acquire", acquired: true },
        );
        for (const thread of snapshot.threads) {
          assert.deepEqual(
            yield* service.execute({
              type: "stop",
              leaseId: "lease",
              threadId: ThreadId.make(thread.id),
              workToken: thread.workToken,
            }),
            { type: "stop", status: "stopped" },
          );
        }
        assert.deepEqual(yield* service.execute({ type: "status", leaseId: "lease" }), {
          type: "status",
          status: "ready",
        });
        assert.deepEqual(yield* service.execute({ type: "seal", leaseId: "lease" }), {
          type: "seal",
          sealed: true,
        });
        assert.isFalse(yield* service.commitOnQuit);
        assert.deepEqual(yield* service.execute({ type: "quit", leaseId: "lease" }), {
          type: "quit",
          accepted: wslExited,
        });
        assert.equal(yield* service.commitOnQuit, wslExited);
        assert.isTrue(sshCommitted);
        assert.includeMembers(calls, [
          "windows:acquire",
          "wsl:acquire",
          "windows:seal",
          "wsl:seal",
        ]);
        assert.includeMembers(calls, ["windows:backend-exit", "wsl:backend-exit"]);
        if (!wslExited) {
          yield* TestClock.adjust("5 seconds");
          assert.isFalse(sshRecovered);
          assert.isEmpty(restarted);
          wslGone = true;
          yield* TestClock.adjust("5 seconds");
          assert.isTrue(sshRecovered);
          assert.includeMembers(restarted, ["windows", "wsl:Ubuntu"]);
          assert.isTrue(yield* service.commitOnQuit);
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerPool,
            layerAuth,
            layerSsh,
            layerHttp,
            NodeCrypto.layer,
            DesktopWslEnvironment.layerTest({
              processExited: (distro, pid) => distro === "Ubuntu" && pid === 2 && wslGone,
            }),
          ),
        ),
      );
    }),
);

it.effect("an abandoned desktop lease unblocks local and SSH admission", () =>
  Effect.gen(function* () {
    let released = false;
    const layerPool = DesktopBackendPool.layerTest([
      {
        id: DesktopBackendPool.BackendInstanceId("inactive"),
        snapshot: Effect.succeed({ desiredRunning: false, ready: false, activePid: Option.none() }),
        currentConfig: Effect.succeedNone,
      } as unknown as DesktopBackendPool.DesktopBackendInstance,
    ]);
    const layerAuth = Layer.mock(DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth)({});
    const layerSsh = Layer.mock(DesktopSshEnvironment.DesktopSshEnvironment)({
      prepareTaggedQuit: () => Effect.succeed(true),
      releaseTaggedQuit: () =>
        Effect.sync(() => {
          released = true;
          return true;
        }),
    });
    const layerHttp = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("No active backend")),
    );
    yield* Effect.gen(function* () {
      const service = yield* DesktopSafeShutdown.make(() => Effect.succeed(true));
      const snapshot = (yield* service.execute({ type: "snapshot" })) as { snapshotToken: string };
      yield* service.execute({
        type: "acquire",
        leaseId: "lost",
        snapshotToken: snapshot.snapshotToken,
      });
      yield* TestClock.adjust("35 seconds");
      assert.isTrue(released);
      assert.equal(
        yield* service
          .execute({ type: "quit", leaseId: "lost" })
          .pipe(Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "unexpected" })),
        "DesktopSafeShutdownError",
      );
      assert.isTrue(yield* service.commitOnQuit);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerPool,
          layerAuth,
          layerSsh,
          layerHttp,
          NodeCrypto.layer,
          DesktopWslEnvironment.layerTest(),
        ),
      ),
    );
  }),
);

it.effect.each([
  { backendId: "local", distro: null, processExit: false },
  { backendId: "local", distro: null, processExit: true },
  { backendId: "wsl:Ubuntu", distro: "Ubuntu", processExit: false },
  { backendId: "wsl:Ubuntu", distro: "Ubuntu", processExit: true },
])(
  "release recovery waits for acknowledgment or confirmed exit: $backendId, exit $processExit",
  ({ backendId, distro, processExit }) =>
    Effect.gen(function* () {
      let backendAvailable = true;
      let backendExited = false;
      let sshReleased = false;
      const instance = {
        id: DesktopBackendPool.BackendInstanceId(backendId),
        snapshot: Effect.succeed({
          desiredRunning: true,
          ready: true,
          activePid: Option.some(1),
          activeRunId: 1,
        }),
        currentConfig: Effect.succeedSome({
          httpBaseUrl: new URL("http://local.example"),
          ...(distro === null ? {} : { runningDistro: distro }),
        }),
      } as unknown as DesktopBackendPool.DesktopBackendInstance;
      const layerHttp = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            const body =
              request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
            const command = JSON.parse(body) as DesktopSafeShutdownRequest;
            const result =
              command.type === "capabilities"
                ? { type: command.type, version: 1, pid: 1 }
                : command.type === "snapshot"
                  ? { type: command.type, snapshotToken: "snapshot", threads: [] }
                  : command.type === "acquire"
                    ? { type: command.type, acquired: true }
                    : command.type === "status"
                      ? { type: command.type, status: "ready" }
                      : { type: "release", released: true };
            return HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify(result), {
                status: command.type === "release" && !backendAvailable ? 503 : 200,
                headers: { "content-type": "application/json" },
              }),
            );
          }),
        ),
      );
      const layerSsh = Layer.mock(DesktopSshEnvironment.DesktopSshEnvironment)({
        prepareTaggedQuit: () => Effect.succeed(true),
        releaseTaggedQuit: () =>
          Effect.sync(() => {
            sshReleased = true;
            return true;
          }),
      });
      yield* Effect.gen(function* () {
        const service = yield* DesktopSafeShutdown.make(() => Effect.succeed(backendExited));
        const snapshot = (yield* service.execute({ type: "snapshot" })) as {
          snapshotToken: string;
        };
        yield* service.execute({
          type: "acquire",
          leaseId: "lease",
          snapshotToken: snapshot.snapshotToken,
        });
        backendAvailable = false;
        assert.deepEqual(yield* service.execute({ type: "release", leaseId: "lease" }), {
          type: "release",
          released: false,
        });
        assert.isFalse(sshReleased);
        assert.isFalse(yield* service.commitOnQuit);
        assert.deepEqual(
          yield* service.execute({
            type: "acquire",
            leaseId: "lease",
            snapshotToken: snapshot.snapshotToken,
          }),
          { type: "acquire", acquired: false },
        );
        backendAvailable = !processExit;
        backendExited = processExit;
        yield* TestClock.adjust("5 seconds");
        assert.isTrue(yield* service.commitOnQuit);
        assert.deepEqual(yield* service.execute({ type: "release", leaseId: "lease" }), {
          type: "release",
          released: true,
        });
        assert.isTrue(sshReleased);
        assert.deepEqual(
          yield* service.execute({
            type: "acquire",
            leaseId: "new",
            snapshotToken: snapshot.snapshotToken,
          }),
          {
            type: "acquire",
            acquired: false,
          },
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            DesktopBackendPool.layerTest([instance]),
            Layer.mock(DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth)({
              getBearerTokenFor: () => Effect.succeed("desktop-token"),
            }),
            layerSsh,
            layerHttp,
            NodeCrypto.layer,
            DesktopWslEnvironment.layerTest({
              processExited: (checkedDistro, pid) =>
                checkedDistro === distro && pid === 1 && backendExited,
            }),
          ),
        ),
      );
    }),
);
