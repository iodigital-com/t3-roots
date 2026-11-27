import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as SafeShutdownHttp from "./SafeShutdownHttp.ts";
import * as SafeShutdownService from "./SafeShutdownService.ts";

const config = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const base = yield* ServerConfig.ServerConfig;
    return { ...base, mode: "desktop" as const };
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-shutdown-http-" })));
const auth = EnvironmentAuth.layer.pipe(
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(config),
);

it.effect("only an authenticated desktop bootstrap session can coordinate shutdown", () =>
  Effect.gen(function* () {
    const sessions = yield* SessionStore.SessionStore;
    const desktop = yield* sessions.issue({
      subject: "desktop-bootstrap",
      method: "bearer-access-token",
      scopes: ["orchestration:operate"],
    });
    const remote = yield* sessions.issue({
      subject: "paired-client",
      method: "bearer-access-token",
      scopes: ["orchestration:operate"],
    });
    const readonly = yield* sessions.issue({
      subject: "desktop-bootstrap",
      method: "bearer-access-token",
      scopes: ["orchestration:read"],
    });
    const request = (token: string | null, command: unknown = { type: "capabilities" }) =>
      HttpServerRequest.fromWeb(
        new Request("http://127.0.0.1/api/orchestration/desktop-safe-shutdown", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(command),
        }),
      );
    const call = (token: string | null, command?: unknown) =>
      SafeShutdownHttp.handler.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request(token, command)),
      );
    assert.equal((yield* call(null)).status, 401);
    assert.equal((yield* call(remote.token)).status, 403);
    assert.equal(
      (yield* call(remote.token, { type: "backend-exit", leaseId: "lease" })).status,
      403,
    );
    assert.equal((yield* call(readonly.token)).status, 403);
    const response = HttpServerResponse.toWeb(yield* call(desktop.token));
    assert.equal(response.status, 200);
    assert.deepEqual(yield* Effect.promise(() => response.json()), {
      type: "capabilities",
      version: 1,
      pid: process.pid,
    });
    const terminal = HttpServerResponse.toWeb(yield* call(desktop.token, { type: "snapshot" }));
    assert.deepEqual(yield* Effect.promise(() => terminal.json()), { type: "terminal-busy" });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(SafeShutdownService.SafeShutdownService)({
          snapshot: Effect.fail(new SafeShutdownService.SafeShutdownTerminalBusy()),
        }),
        auth,
        config,
      ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    ),
  ),
);
