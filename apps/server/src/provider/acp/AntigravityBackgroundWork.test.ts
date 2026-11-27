import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { watchAntigravityBackgroundReply } from "./AntigravityBackgroundWork.ts";
import {
  backgroundStep,
  makeProfile,
  plannerReplyStep,
  plannerStep,
  putStep,
} from "./AntigravityChildWork.testkit.ts";

it.layer(NodeServices.layer)("Antigravity background reply evidence", (it) => {
  it.effect("distinguishes running, completed and unprovable replies", () =>
    Effect.gen(function* () {
      const { profile, databasePath } = yield* makeProfile({
        rootSessionId: "session-1",
        steps: () => [[3, 15, plannerReplyStep(3, "previous")]],
      });
      const check = yield* watchAntigravityBackgroundReply(profile, "session-1");
      expect(yield* check("Answer")).toBe("unknown");
      yield* putStep(databasePath, 5, 15, plannerReplyStep(8, "partial"));
      expect(yield* check("Answer")).toBe("running");
      yield* putStep(databasePath, 5, 15, plannerReplyStep(3, "different"));
      expect(yield* check("Answer")).toBe("unknown");
      yield* putStep(databasePath, 5, 15, plannerReplyStep(3, "Answer", true));
      expect(yield* check("Answer")).toBe("unknown");
      yield* putStep(databasePath, 5, 15, plannerReplyStep(3, "Answer"));
      expect(yield* check("Answer")).toBe("completed");
      yield* (yield* FileSystem.FileSystem).remove(databasePath);
      expect(yield* check("Answer")).toBe("unknown");
    }),
  );

  it.effect("tracks a planner already running when the watcher starts", () =>
    Effect.gen(function* () {
      const { profile, databasePath } = yield* makeProfile({
        rootSessionId: "session-1",
        steps: () => [[5, 15, plannerReplyStep(8, "partial")]],
      });
      const check = yield* watchAntigravityBackgroundReply(profile, "session-1");
      expect(yield* check("Answer")).toBe("running");
      yield* putStep(databasePath, 5, 15, plannerReplyStep(3, "different"));
      expect(yield* check("Answer")).toBe("unknown");
      yield* putStep(databasePath, 5, 15, plannerReplyStep(3, "Answer", true));
      expect(yield* check("Answer")).toBe("unknown");
      yield* putStep(databasePath, 5, 15, plannerReplyStep(3, "Answer"));
      expect(yield* check("Answer")).toBe("completed");
    }),
  );

  it.effect("does not re-open a reply already consumed by a usage update", () =>
    Effect.gen(function* () {
      const { profile, databasePath } = yield* makeProfile({
        rootSessionId: "session-1",
        steps: () => [[3, 15, plannerReplyStep(3, "previous")]],
      });
      const check = yield* watchAntigravityBackgroundReply(profile, "session-1");
      yield* putStep(databasePath, 5, 15, plannerReplyStep(3, "Done"));
      yield* check("Done", undefined, true);
      yield* putStep(databasePath, 5, 15, plannerReplyStep(8, "Done"));
      expect(yield* check("Done")).toBe("unknown");
      yield* putStep(databasePath, 7, 15, plannerReplyStep(8, "Next"));
      expect(yield* check("Next")).toBe("running");
      yield* putStep(databasePath, 7, 15, plannerReplyStep(3, "Next"));
      expect(yield* check("Next")).toBe("completed");
    }),
  );

  it.effect.each([false, true])(
    "does not reuse a prior record when the consumed reply cannot be identified (unreadable: %s)",
    (unreadable) =>
      Effect.gen(function* () {
        const { profile, databasePath } = yield* makeProfile({
          rootSessionId: "session-1",
          steps: () => [[3, 15, plannerReplyStep(3, "previous")]],
        });
        const check = yield* watchAntigravityBackgroundReply(profile, "session-1");
        yield* putStep(databasePath, 5, 15, plannerReplyStep(3, "Old answer"));
        const fs = yield* FileSystem.FileSystem;
        const held = `${databasePath}.held`;
        if (unreadable) yield* fs.rename(databasePath, held);
        yield* check("unreadable reply", undefined, true);
        if (unreadable) yield* fs.rename(held, databasePath);
        expect(yield* check("Old answer")).toBe("unknown");
        yield* putStep(databasePath, 7, 15, plannerReplyStep(3, "Old answer"));
        expect(yield* check("Old answer")).toBe("completed");
      }),
  );

  it.effect("does not infer a consumed reply across an unreadable planner", () =>
    Effect.gen(function* () {
      const { profile, databasePath } = yield* makeProfile({
        rootSessionId: "session-1",
        steps: () => [[3, 15, plannerReplyStep(3, "previous")]],
      });
      const check = yield* watchAntigravityBackgroundReply(profile, "session-1");
      yield* putStep(databasePath, 4, 15, plannerStep([]));
      yield* putStep(databasePath, 5, 15, plannerReplyStep(3, "Done"));
      yield* putStep(databasePath, 7, 15, plannerReplyStep(3, "Done"));
      yield* check("Done", undefined, true);
      expect(yield* check("Done")).toBe("unknown");
      yield* putStep(databasePath, 9, 15, plannerReplyStep(3, "Done"));
      expect(yield* check("Done")).toBe("completed");
    }),
  );

  it.effect("recovers only a running reply after the originating native task", () =>
    Effect.gen(function* () {
      const { profile, databasePath } = yield* makeProfile({
        rootSessionId: "session-1",
        steps: () => [
          [2, 132, backgroundStep("timer", "schedule", "session-1/task-2")],
          [3, 15, plannerReplyStep(3, "Answer")],
        ],
      });
      const fs = yield* FileSystem.FileSystem;
      const held = `${databasePath}.held`;
      yield* fs.rename(databasePath, held);
      const check = yield* watchAntigravityBackgroundReply(profile, "session-1");
      yield* fs.rename(held, databasePath);
      expect(yield* check("Answer", "timer")).toBe("unknown");
      yield* putStep(databasePath, 3, 15, plannerReplyStep(8, "Answer"));
      expect(yield* check("Answer", "other")).toBe("unknown");
      expect(yield* check("Answer", "timer")).toBe("running");
      yield* putStep(databasePath, 3, 15, plannerReplyStep(3, "Answer"));
      expect(yield* check("Answer", "timer")).toBe("completed");
      yield* fs.rename(databasePath, held);
      yield* makeProfile({
        profile,
        rootSessionId: "session-1",
        steps: () => [
          [2, 132, backgroundStep("timer", "schedule", "session-1/task-2")],
          [3, 15, plannerReplyStep(3, "Answer")],
        ],
      });
      expect(yield* check("Answer", "timer")).toBe("unknown");
    }),
  );
});
