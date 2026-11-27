import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const Lease = { leaseId: TrimmedNonEmptyString };

export const DesktopSafeShutdownRequest = Schema.Union([
  Schema.Struct({ type: Schema.Literal("capabilities") }),
  Schema.Struct({ type: Schema.Literal("snapshot") }),
  Schema.Struct({
    type: Schema.Literal("acquire"),
    ...Lease,
    snapshotToken: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("stop"),
    ...Lease,
    threadId: ThreadId,
    workToken: TrimmedNonEmptyString,
  }),
  Schema.Struct({ type: Schema.Literal("status"), ...Lease }),
  Schema.Struct({ type: Schema.Literal("seal"), ...Lease }),
  Schema.Struct({ type: Schema.Literal("quit"), ...Lease }),
  Schema.Struct({ type: Schema.Literal("backend-exit"), ...Lease }),
  Schema.Struct({ type: Schema.Literal("release"), ...Lease }),
]);
export type DesktopSafeShutdownRequest = typeof DesktopSafeShutdownRequest.Type;

export const DesktopSafeShutdownResponse = Schema.Union([
  Schema.Struct({ type: Schema.Literal("terminal-busy") }),
  Schema.Struct({
    type: Schema.Literal("capabilities"),
    version: Schema.Literal(1),
    pid: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  }),
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    snapshotToken: TrimmedNonEmptyString,
    threads: Schema.Array(
      Schema.Struct({
        id: ThreadId,
        project: Schema.String,
        title: Schema.String,
        status: Schema.String,
        workToken: TrimmedNonEmptyString,
      }),
    ),
  }),
  Schema.Struct({ type: Schema.Literal("acquire"), acquired: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("stop"), status: Schema.Literals(["stopped", "changed"]) }),
  Schema.Struct({
    type: Schema.Literal("status"),
    status: Schema.Literals(["quiescing", "ready"]),
  }),
  Schema.Struct({ type: Schema.Literal("seal"), sealed: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("quit"), accepted: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("backend-exit"), accepted: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("release"), released: Schema.Boolean }),
]);
export type DesktopSafeShutdownResponse = typeof DesktopSafeShutdownResponse.Type;

export const DesktopSafeShutdownControlRequest = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("safe-shutdown"),
  requestId: TrimmedNonEmptyString,
  secret: TrimmedNonEmptyString,
  command: DesktopSafeShutdownRequest,
});
export type DesktopSafeShutdownControlRequest = typeof DesktopSafeShutdownControlRequest.Type;

export const DesktopSafeShutdownControlResponse = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("safe-shutdown"),
    requestId: TrimmedNonEmptyString,
    ok: Schema.Literal(true),
    result: Schema.Unknown,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("safe-shutdown"),
    requestId: TrimmedNonEmptyString,
    ok: Schema.Literal(false),
  }),
]);
export type DesktopSafeShutdownControlResponse = typeof DesktopSafeShutdownControlResponse.Type;
