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

const readLatestStep = (
  profileDirectory: string,
  sessionId: string,
  toolCallId?: string,
  consumed?: { readonly text: string; readonly from: number },
) =>
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
        let originIndex: number | undefined;
        if (toolCallId !== undefined && toolCallId.length > 0 && toolCallId.length <= 512) {
          const candidates = db
            .prepare(
              "SELECT idx, step_payload FROM steps WHERE step_type = 132 AND step_format = 0 AND length(step_payload) <= ? AND instr(step_payload, ?) > 0 ORDER BY idx DESC LIMIT 16",
            )
            .all(MAX_STEP_BYTES, new TextEncoder().encode(toolCallId));
          for (const candidate of candidates) {
            if (
              typeof candidate.idx !== "number" ||
              !Number.isSafeInteger(candidate.idx) ||
              !(candidate.step_payload instanceof Uint8Array)
            )
              continue;
            try {
              const call = field(field(candidate.step_payload, 5), 4);
              if (
                text(call, 1) === toolCallId &&
                (text(call, 2) === "schedule" || text(call, 2) === "run_command") &&
                text(field(candidate.step_payload, 148), 1) === `${sessionId}/task-${candidate.idx}`
              ) {
                originIndex = candidate.idx;
                break;
              }
            } catch {
              // A malformed step does not prove an origin.
            }
          }
        }
        let consumedReplyIndex: number | undefined;
        if (consumed !== undefined && (toolCallId === undefined || originIndex !== undefined)) {
          const from = Math.max(consumed.from, originIndex === undefined ? 0 : originIndex + 1);
          const candidates = db
            .prepare(
              "SELECT idx, step_format, CASE WHEN length(step_payload) <= ? THEN step_payload END AS step_payload FROM steps WHERE idx >= ? AND idx <= ? AND step_type = 15 ORDER BY idx ASC LIMIT 64",
            )
            .iterate(MAX_STEP_BYTES, from, row.idx);
          for (const candidate of candidates) {
            if (
              typeof candidate.idx !== "number" ||
              candidate.step_format !== 0 ||
              !(candidate.step_payload instanceof Uint8Array)
            )
              break;
            try {
              const payload = candidate.step_payload;
              const candidatePlanner = field(payload, 20);
              if (candidatePlanner === undefined) break;
              // An unfinished or unrecognized planner cannot safely be skipped.
              if (varintField(payload, 4) !== 3) break;
              if (
                !protoFields(candidatePlanner).some(([number]) => number === 7) &&
                text(candidatePlanner, 1)?.trim() === consumed.text
              ) {
                consumedReplyIndex = candidate.idx;
                break;
              }
            } catch {
              // Do not identify a later reply across an unreadable planner.
              break;
            }
          }
        }
        return {
          index: row.idx,
          type: row.step_type,
          status: varintField(row.step_payload, 4),
          reply: text(planner, 1),
          hasToolCalls:
            planner === undefined || protoFields(planner).some(([number]) => number === 7),
          dev: file.info.dev,
          ino: file.info.ino,
          originIndex,
          consumedReplyIndex,
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
    let identity = before === undefined ? undefined : { dev: before.dev, ino: before.ino };
    let runningIndex = before?.type === 15 && before.status === 8 ? before.index : undefined;
    let floor = before?.index;
    let consumedIndex: number | undefined;
    let recoveredOrigin: string | undefined;
    let awaitingFloor = false;
    let generation = 0;
    return (reply: string, toolCallId?: string, consumed = false) =>
      Effect.suspend(() => {
        if (consumed) {
          generation += 1;
          awaitingFloor = true;
          recoveredOrigin = undefined;
        }
        const currentGeneration = generation;
        const trimmed = reply.trim();
        const from =
          floor === undefined
            ? undefined
            : Math.max(
                floor + (runningIndex === floor && consumedIndex !== floor ? 0 : 1),
                (consumedIndex ?? -1) + 1,
                runningIndex ?? 0,
              );
        return readLatestStep(
          profileDirectory,
          sessionId,
          before === undefined ? toolCallId : undefined,
          consumed && trimmed && from !== undefined ? { text: trimmed, from } : undefined,
        ).pipe(
          Effect.map((step): AcpBackgroundReplyState => {
            if (currentGeneration !== generation) return "unknown";
            if (step === undefined) return "unknown";
            if (identity === undefined) identity = { dev: step.dev, ino: step.ino };
            if (step.dev !== identity.dev || step.ino !== identity.ino) return "unknown";
            if (before === undefined) {
              if (
                toolCallId === undefined ||
                step.originIndex === undefined ||
                step.index < step.originIndex ||
                (recoveredOrigin !== undefined && recoveredOrigin !== toolCallId)
              )
                return "unknown";
              recoveredOrigin = toolCallId;
            }
            if (consumed) {
              const match = step.consumedReplyIndex;
              const index =
                match !== undefined &&
                floor !== undefined &&
                (match > floor || (match === floor && runningIndex === floor)) &&
                (consumedIndex === undefined || match > consumedIndex) &&
                (runningIndex === undefined || match >= runningIndex)
                  ? match
                  : step.index;
              if (
                (floor === undefined || index >= floor) &&
                (runningIndex === undefined || index >= runningIndex) &&
                (consumedIndex === undefined || index >= consumedIndex)
              ) {
                floor = index;
                consumedIndex = index;
                runningIndex = undefined;
                awaitingFloor = false;
              }
              recoveredOrigin = undefined;
              return "unknown";
            }
            if (awaitingFloor) {
              if (
                (floor === undefined || step.index >= floor) &&
                (runningIndex === undefined || step.index >= runningIndex) &&
                (consumedIndex === undefined || step.index >= consumedIndex)
              ) {
                floor = step.index;
                consumedIndex = step.index;
                runningIndex = undefined;
                awaitingFloor = false;
              }
              return "unknown";
            }
            if (before === undefined) {
              if (floor === undefined) {
                // A completed planner can be an older reply even when it follows the task.
                // Record it as a floor; a matching running planner can be followed immediately.
                floor = step.index;
                const streamed = reply.trim();
                const nativeText = step.reply?.trim();
                if (
                  step.type !== 15 ||
                  step.status !== 8 ||
                  step.originIndex === undefined ||
                  step.index <= step.originIndex ||
                  !streamed ||
                  !nativeText ||
                  !(nativeText.startsWith(streamed) || streamed.startsWith(nativeText))
                )
                  return "unknown";
                runningIndex = step.index;
                return "running";
              }
            }
            if (
              floor === undefined ||
              step.index < floor ||
              (consumedIndex !== undefined && step.index <= consumedIndex) ||
              (runningIndex !== undefined && step.index < runningIndex) ||
              step.type !== 15
            )
              return "unknown";
            if (step.status === 8) {
              if (step.index === floor && runningIndex !== step.index) {
                const streamed = reply.trim();
                const nativeText = step.reply?.trim();
                if (
                  !streamed ||
                  !nativeText ||
                  !(nativeText.startsWith(streamed) || streamed.startsWith(nativeText))
                )
                  return "unknown";
              }
              runningIndex = step.index;
              return "running";
            }
            if (step.index === floor && runningIndex !== step.index) return "unknown";
            return step.status === 3 &&
              !step.hasToolCalls &&
              reply.trim().length > 0 &&
              step.reply?.trim() === reply.trim()
              ? "completed"
              : "unknown";
          }),
        );
      });
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
