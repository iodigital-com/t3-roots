import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";

import * as DesktopQuitAdmission from "./DesktopQuitAdmission.ts";

it.effect("drains admitted work and releases blocked work when a quit is cancelled", () =>
  Effect.gen(function* () {
    const admission = yield* DesktopQuitAdmission.make;
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const laterStarted = yield* Deferred.make<void>();
    const running = yield* admission
      .run(Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))))
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const prepare = yield* admission.prepare("lease", Effect.succeed(true)).pipe(Effect.forkChild);
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(running);
    assert.isTrue(yield* Fiber.join(prepare));

    const later = yield* admission
      .run(Deferred.succeed(laterStarted, undefined))
      .pipe(Effect.forkChild);
    assert.isTrue(Option.isNone(yield* Deferred.poll(laterStarted)));
    assert.isFalse(yield* admission.release("other"));
    assert.isTrue(yield* admission.release("lease"));
    yield* Fiber.join(later);
    assert.isTrue(Option.isSome(yield* Deferred.poll(laterStarted)));
  }),
);

it.effect("commits only a verified lease and requires explicit recovery after commit", () =>
  Effect.gen(function* () {
    const admission = yield* DesktopQuitAdmission.make;
    assert.isFalse(yield* admission.prepare("lease", Effect.succeed(false)));
    assert.isTrue(yield* admission.prepare("lease", Effect.succeed(true)));
    assert.isFalse(yield* admission.commit("lease", Effect.succeed(false)));
    assert.isTrue(yield* admission.commit("lease", Effect.succeed(true)));
    assert.isFalse(yield* admission.release("lease"));
    assert.isFalse(yield* admission.recover("other"));
    assert.isTrue(yield* admission.recover("lease"));
    yield* admission.run(Effect.void);
  }),
);

it.effect("drains nested admitted operations without blocking them behind a waiting quit", () =>
  Effect.gen(function* () {
    const admission = yield* DesktopQuitAdmission.make;
    const entered = yield* Deferred.make<void>();
    const continueParent = yield* Deferred.make<void>();
    const nested = yield* Deferred.make<void>();
    const operation = yield* admission
      .run(
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(continueParent)),
          Effect.andThen(admission.run(Deferred.succeed(nested, undefined))),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const prepare = yield* admission.prepare("lease", Effect.succeed(true)).pipe(Effect.forkChild);
    yield* Deferred.succeed(continueParent, undefined);
    yield* Deferred.await(nested);
    yield* Fiber.join(operation);
    assert.isTrue(yield* Fiber.join(prepare));
    assert.isTrue(yield* admission.release("lease"));
  }),
);
