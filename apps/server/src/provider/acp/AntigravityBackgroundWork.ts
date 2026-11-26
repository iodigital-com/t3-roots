// @effect-diagnostics nodeBuiltinImport:off -- read the native session database without writing it.
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { AcpBackgroundReplyState } from "@t3tools/provider-acp/server/adapter";
import { protoFields } from "./AntigravityChildWork.ts";
import { antigravityManagedPath, antigravityProfileRoot } from "./AntigravityProfilePaths.ts";

const MAX_STEP_BYTES = 1024 * 1024;
const NATIVE_ID = /^[A-Za-z0-9-]{1,64}$/;
const decoder = new TextDecoder("utf-8", { fatal: true });
class AntigravityBackgroundReadError extends Schema.TaggedError<AntigravityBackgroundReadError>()(
  "AntigravityBackgroundReadError",
  { cause: Schema.Defect() },
) {}
const field = (bytes: Uint8Array | undefined, number: number) =>
  bytes === undefined ? undefined : protoFields(bytes).find(([key]) => key === number)?.[1];
const text = (bytes: Uint8Array | undefined, number: number) => {
  const value = field(bytes, number);
  return value === undefined ? undefined : decoder.decode(value);
};

// Top-level protobuf varint field, used for the native step status.
function varintField(bytes: Uint8Array, wanted: number): number | undefined {
  let offset = 0;
  const read = () => {
    let result = 0;
    for (let shift = 0; shift < 53; shift += 7) {
      const byte = bytes[offset++];
      if (byte === undefined) throw new Error("Truncated varint");
      result += (byte & 127) * 2 ** shift;
      if (byte < 128) return result;
    }
    throw new Error("Overlong varint");
  };
  while (offset < bytes.length) {
    const key = read();
    const wire = key % 8;
    if (wire === 0) {
      const value = read();
      if (Math.floor(key / 8) === wanted) return value;
    } else if (wire === 2) {
      const length = read();
      offset += length;
    } else if (wire === 1) offset += 8;
    else if (wire === 5) offset += 4;
    else throw new Error("Invalid wire type");
    if (offset > bytes.length) throw new Error("Truncated field");
  }
  return undefined;
}

const readLatestStep = (profileDirectory: string, sessionId: string) =>
  Effect.tryPromise({
    try: async () => {
      if (!NATIVE_ID.test(sessionId)) return undefined;
      const root = await antigravityProfileRoot(profileDirectory);
      if (root === undefined) return undefined;
      const file = await antigravityManagedPath(
        root,
        ["antigravity-acp", "conversations", `${sessionId}.db`],
        "file",
      );
      if (file === undefined) return undefined;
      const db = new NodeSqlite.DatabaseSync(file.path, { readOnly: true });
      try {
        db.exec("PRAGMA busy_timeout = 100");
        const row = db
          .prepare(
            "SELECT idx, step_type, step_format, CASE WHEN length(step_payload) <= ? THEN step_payload END AS step_payload FROM steps ORDER BY idx DESC LIMIT 1",
          )
          .get(MAX_STEP_BYTES);
        if (
          typeof row?.idx !== "number" ||
          typeof row.step_type !== "number" ||
          row.step_format !== 0 ||
          !(row.step_payload instanceof Uint8Array)
        )
          return undefined;
        const planner = row.step_type === 15 ? field(row.step_payload, 20) : undefined;
        return {
          index: row.idx,
          type: row.step_type,
          status: varintField(row.step_payload, 4),
          reply: text(planner, 1),
          hasToolCalls:
            planner === undefined || protoFields(planner).some(([number]) => number === 7),
          dev: file.info.dev,
          ino: file.info.ino,
        };
      } finally {
        db.close();
      }
    },
    catch: (cause) => new AntigravityBackgroundReadError({ cause }),
  }).pipe(Effect.orElseSucceed(() => undefined));

/** A completed planner step with matching text proves that the background reply has finished. */
export const watchAntigravityBackgroundReply = Effect.fn("watchAntigravityBackgroundReply")(
  function* (profileDirectory: string, sessionId: string) {
    const before = yield* readLatestStep(profileDirectory, sessionId);
    return (reply: string) =>
      before === undefined
        ? Effect.succeed("unknown" as const)
        : readLatestStep(profileDirectory, sessionId).pipe(
            Effect.map((step): AcpBackgroundReplyState => {
              if (
                step === undefined ||
                step.dev !== before.dev ||
                step.ino !== before.ino ||
                step.index < before.index ||
                (step.index === before.index && !(before.type === 15 && before.status === 8)) ||
                step.type !== 15
              )
                return "unknown";
              if (step.status === 8) return "running";
              return step.status === 3 &&
                !step.hasToolCalls &&
                reply.trim().length > 0 &&
                step.reply?.trim() === reply.trim()
                ? "completed"
                : "unknown";
            }),
          );
  },
);

/** agy 1.5 stores the task id and originating ACP call on its own generic tool step. */
export const matchAntigravityBackgroundTasks = Effect.fn("matchAntigravityBackgroundTasks")(
  function* (profileDirectory: string, sessionId: string, taskIds: ReadonlyArray<string>) {
    if (!NATIVE_ID.test(sessionId)) return [];
    return yield* Effect.tryPromise({
      try: async () => {
        const root = await antigravityProfileRoot(profileDirectory);
        if (root === undefined) return [];
        const file = await antigravityManagedPath(
          root,
          ["antigravity-acp", "conversations", `${sessionId}.db`],
          "file",
        );
        if (file === undefined) return [];
        const db = new NodeSqlite.DatabaseSync(file.path, { readOnly: true });
        try {
          db.exec("PRAGMA busy_timeout = 100");
          const query = db.prepare(
            "SELECT step_payload FROM steps WHERE idx = ? AND step_type = 132 AND step_format = 0 AND length(step_payload) <= ?",
          );
          const matches: Array<{ taskId: string; toolCallId: string }> = [];
          for (const taskId of new Set(taskIds)) {
            const prefix = `${sessionId}/task-`;
            if (!taskId.startsWith(prefix)) continue;
            const number = taskId.slice(prefix.length);
            if (!/^(0|[1-9]\d*)$/.test(number) || !Number.isSafeInteger(Number(number))) continue;
            const payload = query.get(Number(number), MAX_STEP_BYTES)?.step_payload;
            if (!(payload instanceof Uint8Array)) continue;
            try {
              const call = field(field(payload, 5), 4);
              const name = text(call, 2);
              const toolCallId = text(call, 1);
              if (
                (name === "schedule" || name === "run_command") &&
                toolCallId &&
                text(field(payload, 148), 1) === taskId
              ) {
                matches.push({ taskId, toolCallId });
              }
            } catch {
              // An unreadable step proves no task identity.
            }
          }
          return matches;
        } finally {
          db.close();
        }
      },
      catch: (cause) => new AntigravityBackgroundReadError({ cause }),
    }).pipe(Effect.orElseSucceed(() => []));
  },
);
