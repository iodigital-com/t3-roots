import { AuthOrchestrationOperateScope, DesktopSafeShutdownRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as SafeShutdownService from "./SafeShutdownService.ts";

const decodeRequest = Schema.decodeUnknownEffect(DesktopSafeShutdownRequest);

export const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const config = yield* ServerConfig.ServerConfig;
  const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
  if (Option.isNone(session)) return HttpServerResponse.empty({ status: 401 });
  if (
    config.mode !== "desktop" ||
    session.value.subject !== "desktop-bootstrap" ||
    !session.value.scopes.includes(AuthOrchestrationOperateScope)
  )
    return HttpServerResponse.empty({ status: 403 });
  const input = yield* request.json.pipe(Effect.flatMap(decodeRequest), Effect.option);
  if (Option.isNone(input)) return HttpServerResponse.empty({ status: 400 });
  if (input.value.type === "quit") return HttpServerResponse.empty({ status: 403 });
  const shutdown = yield* SafeShutdownService.SafeShutdownService;
  const command = input.value;
  const result = yield* Effect.gen(function* () {
    switch (command.type) {
      case "capabilities":
        return { type: command.type, version: 1, pid: process.pid } as const;
      case "snapshot": {
        const snapshot = yield* shutdown.snapshot.pipe(Effect.result);
        if (Result.isSuccess(snapshot)) return { type: command.type, ...snapshot.success } as const;
        if (snapshot.failure._tag === "SafeShutdownTerminalBusy")
          return { type: "terminal-busy" } as const;
        return yield* snapshot.failure;
      }
      case "acquire":
        return {
          type: command.type,
          acquired: yield* shutdown.acquire(command.leaseId, command.snapshotToken),
        } as const;
      case "stop":
        return {
          type: command.type,
          status: yield* shutdown.stop(command.leaseId, command.threadId, command.workToken),
        } as const;
      case "status":
        return { type: command.type, status: yield* shutdown.status(command.leaseId) } as const;
      case "seal":
        return { type: command.type, sealed: yield* shutdown.seal(command.leaseId) } as const;
      case "backend-exit":
        return {
          type: command.type,
          accepted: yield* shutdown.beginExit(command.leaseId),
        } as const;
      case "release":
        return { type: command.type, released: yield* shutdown.release(command.leaseId) } as const;
    }
  }).pipe(Effect.option);
  return Option.isSome(result)
    ? HttpServerResponse.jsonUnsafe(result.value, { headers: { "cache-control": "no-store" } })
    : HttpServerResponse.empty({ status: 409 });
});

export const layer = HttpRouter.add("POST", "/api/orchestration/desktop-safe-shutdown", handler);
