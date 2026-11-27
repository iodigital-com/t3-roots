import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { AuthSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import * as EnvironmentAuth from "../src/auth/EnvironmentAuth.ts";
import * as ServerConfig from "../src/config.ts";
import * as SafeShutdownHttp from "../src/orchestration-v2/SafeShutdownHttp.ts";
import * as SafeShutdownService from "../src/orchestration-v2/SafeShutdownService.ts";
import * as ThreadCommandExecutor from "../src/orchestration-v2/ThreadCommandExecutor.ts";
import * as DesktopBackendPool from "../../desktop/src/backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../../desktop/src/backend/DesktopLocalEnvironmentAuth.ts";
import * as DesktopSshEnvironment from "../../desktop/src/ssh/DesktopSshEnvironment.ts";
import * as DesktopWslEnvironment from "../../desktop/src/wsl/DesktopWslEnvironment.ts";
import * as DesktopSafeShutdown from "../../desktop/src/app/DesktopSafeShutdown.ts";

it.effect(
  "coordinates the desktop through the authenticated backend route and real admission barrier",
  () =>
    Effect.gen(function* () {
      const executor = yield* ThreadCommandExecutor.make;
      const threadId = ThreadId.make("thread:protocol");
      let running = true;
      let terminalBusy = true;
      let exitRequested = false;
      let backendExited = false;
      let sshCommitted = false;
      const backend = SafeShutdownService.SafeShutdownService.of({
        snapshot: Effect.suspend(() =>
          terminalBusy
            ? Effect.fail(new SafeShutdownService.SafeShutdownTerminalBusy())
            : Effect.sync(() => ({
                snapshotToken: "snapshot",
                threads: running
                  ? [
                      {
                        id: threadId,
                        project: "Project",
                        title: "Work",
                        status: "running",
                        workToken: "work",
                      },
                    ]
                  : [],
              })),
        ),
        acquire: (leaseId, token) =>
          executor.acquireStartBarrier(
            leaseId,
            Effect.succeed(token === "snapshot"),
            token,
            30_000,
          ),
        stop: (leaseId, id, token) =>
          executor.withStartBarrier(leaseId, () =>
            Effect.sync(() => {
              if (id !== threadId || token !== "work" || !running) return "changed";
              running = false;
              return "stopped";
            }),
          ),
        status: (leaseId) =>
          executor.withStartBarrier(leaseId, () => Effect.succeed(running ? "quiescing" : "ready")),
        seal: (leaseId) =>
          executor.sealStartBarrier(
            leaseId,
            Effect.sync(() => !running),
          ),
        beginExit: (leaseId) =>
          executor.exitWithStartBarrier(
            leaseId,
            Effect.sync(() => !running),
            Effect.sync(() => {
              exitRequested = true;
            }),
          ),
        release: executor.releaseStartBarrier,
      });
      const session = {
        sessionId: AuthSessionId.make("session:desktop"),
        subject: "desktop-bootstrap",
        method: "bearer-access-token",
        scopes: ["orchestration:operate"],
      };
      const auth = {
        authenticateHttpRequest: () => Effect.succeed(session),
      };
      const config = { mode: "desktop" };
      const layerHttp = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          const body =
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
          const serverRequest = HttpServerRequest.fromWeb(
            new Request(request.url, {
              method: "POST",
              body,
              headers: { "content-type": "application/json" },
            }),
          );
          return SafeShutdownHttp.handler.pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, serverRequest),
            Effect.provideService(SafeShutdownService.SafeShutdownService, backend),
            Effect.provideService(EnvironmentAuth.EnvironmentAuth, auth),
            Effect.provideService(ServerConfig.ServerConfig, config),
            Effect.map((response) =>
              HttpClientResponse.fromWeb(request, HttpServerResponse.toWeb(response)),
            ),
          );
        }),
      );
      const instance = {
        id: DesktopBackendPool.BackendInstanceId("windows"),
        snapshot: Effect.succeed({
          desiredRunning: true,
          ready: true,
          activePid: Option.some(process.pid),
          activeRunId: 1,
        }),
        currentConfig: Effect.succeedSome({ httpBaseUrl: new URL("http://127.0.0.1:3773") }),
        stop: () =>
          Effect.sync(() => {
            backendExited = true;
          }),
        start: Effect.void,
      };
      yield* Effect.gen(function* () {
        const desktop = yield* DesktopSafeShutdown.make(() => Effect.sync(() => backendExited));
        assert.deepEqual(yield* desktop.execute({ type: "snapshot" }), { type: "terminal-busy" });
        assert.isTrue(running);
        terminalBusy = false;
        const snapshot = yield* desktop.execute({ type: "snapshot" });
        assert.lengthOf(snapshot.threads, 1);
        assert.deepEqual(
          yield* desktop.execute({
            type: "acquire",
            leaseId: "lease",
            snapshotToken: snapshot.snapshotToken,
          }),
          { type: "acquire", acquired: true },
        );
        assert.equal(
          (yield* Effect.flip(executor.withStartAdmission(Effect.void)))._tag,
          "StartAdmissionBlocked",
        );
        assert.deepEqual(
          yield* desktop.execute({
            type: "stop",
            leaseId: "lease",
            threadId: ThreadId.make(snapshot.threads[0].id),
            workToken: snapshot.threads[0].workToken,
          }),
          { type: "stop", status: "stopped" },
        );
        assert.deepEqual(yield* desktop.execute({ type: "seal", leaseId: "lease" }), {
          type: "seal",
          sealed: true,
        });
        assert.deepEqual(yield* desktop.execute({ type: "quit", leaseId: "lease" }), {
          type: "quit",
          accepted: true,
        });
        assert.isTrue(exitRequested);
        assert.isTrue(sshCommitted);
        yield* TestClock.adjust("60 seconds");
        assert.equal(
          (yield* Effect.flip(executor.withStartAdmission(Effect.void)))._tag,
          "StartAdmissionBlocked",
        );
        assert.isFalse(yield* executor.releaseStartBarrier("lease"));
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            DesktopBackendPool.layerTest([instance]),
            Layer.mock(DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth)({
              getBearerTokenFor: () => Effect.succeed("token"),
            }),
            Layer.mock(DesktopSshEnvironment.DesktopSshEnvironment)({
              prepareTaggedQuit: () => Effect.succeed(true),
              commitTaggedQuit: () =>
                Effect.sync(() => {
                  sshCommitted = true;
                  return true;
                }),
            }),
            DesktopWslEnvironment.layerTest(),
            layerHttp,
            NodeCrypto.layer,
          ),
        ),
      );
    }),
);
