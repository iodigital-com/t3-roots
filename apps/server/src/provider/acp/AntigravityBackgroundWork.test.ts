import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { watchAntigravityBackgroundReply } from "./AntigravityBackgroundWork.ts";
import { makeProfile, plannerReplyStep, putStep } from "./AntigravityChildWork.testkit.ts";

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
});
