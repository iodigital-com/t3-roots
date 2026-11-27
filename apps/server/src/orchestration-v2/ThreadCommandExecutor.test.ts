import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

it.effect("a shutdown barrier waits for an admitted start and rejects later starts", () =>
  Effect.gen(function* () {
    const executor = yield* ThreadCommandExecutor.make;
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const order = yield* Ref.make<ReadonlyArray<string>>([]);
    const start = yield* executor
      .withStartAdmission(
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(finish)),
          Effect.andThen(Ref.update(order, (items) => [...items, "finished"])),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const acquired = yield* executor
      .acquireStartBarrier(
        "lease",
        Ref.update(order, (items) => [...items, "verified"]).pipe(Effect.as(true)),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(start);
    assert.isTrue(yield* Fiber.join(acquired));
    assert.deepEqual(yield* Ref.get(order), ["finished", "verified"]);
    const refused = yield* executor.withStartAdmission(Effect.void).pipe(Effect.flip);
    assert.equal(refused._tag, "StartAdmissionBlocked");
    assert.isTrue(yield* executor.releaseStartBarrier("other"));
    assert.isTrue(yield* executor.releaseStartBarrier("lease"));
    yield* executor.withStartAdmission(Effect.void);
  }),
);

it.effect("a release before a delayed acquire prevents that lease from starting", () =>
  Effect.gen(function* () {
    const executor = yield* ThreadCommandExecutor.make;
    assert.isTrue(yield* executor.releaseStartBarrier("lost-reply"));
    assert.isTrue(yield* executor.releaseStartBarrier("lost-reply"));
    assert.isFalse(yield* executor.acquireStartBarrier("lost-reply", Effect.succeed(true)));
    yield* executor.withStartAdmission(Effect.void);
  }),
);

it.effect("a failed snapshot comparison does not leave admission blocked", () =>
  Effect.gen(function* () {
    const executor = yield* ThreadCommandExecutor.make;
    assert.isFalse(yield* executor.acquireStartBarrier("lease", Effect.succeed(false)));
    yield* executor.withStartAdmission(Effect.void);
  }),
);

it.effect("independent starts can be admitted concurrently", () =>
  Effect.gen(function* () {
    const executor = yield* ThreadCommandExecutor.make;
    const first = yield* Deferred.make<void>();
    const second = yield* Deferred.make<void>();
    yield* Effect.all(
      [
        executor.withStartAdmission(
          Deferred.succeed(first, undefined).pipe(Effect.andThen(Deferred.await(second))),
        ),
        executor.withStartAdmission(
          Deferred.succeed(second, undefined).pipe(Effect.andThen(Deferred.await(first))),
        ),
      ],
      { concurrency: "unbounded" },
    );
  }),
);

it.effect("automatic work waits for release and then rechecks its state", () =>
  Effect.gen(function* () {
    const executor = yield* ThreadCommandExecutor.make;
    const started = yield* Deferred.make<void>();
    const shouldStart = yield* Ref.make(true);
    assert.isTrue(yield* executor.acquireStartBarrier("lease", Effect.succeed(true)));
    const pending = yield* executor
      .awaitStartAdmission(
        Ref.get(shouldStart).pipe(
          Effect.flatMap((allowed) =>
            allowed ? Deferred.succeed(started, undefined).pipe(Effect.asVoid) : Effect.void,
          ),
        ),
      )
      .pipe(Effect.forkChild({ startImmediately: true }));
    assert.isFalse(yield* Deferred.isDone(started));
    yield* Ref.set(shouldStart, false);
    assert.isTrue(yield* executor.releaseStartBarrier("lease"));
    yield* Fiber.join(pending);
    assert.isFalse(yield* Deferred.isDone(started));
  }),
);

it.effect("an abandoned shutdown lease expires, while activity extends it", () =>
  Effect.gen(function* () {
    const executor = yield* ThreadCommandExecutor.make;
    assert.isTrue(
      yield* executor.acquireStartBarrier("lease", Effect.succeed(true), "snapshot", 30_000),
    );
    yield* TestClock.adjust("20 seconds");
    yield* executor.withStartBarrier("lease", () => Effect.void);
    yield* TestClock.adjust("15 seconds");
    assert.equal(
      (yield* Effect.flip(executor.withStartAdmission(Effect.void)))._tag,
      "StartAdmissionBlocked",
    );
    yield* TestClock.adjust("16 seconds");
    yield* executor.withStartAdmission(Effect.void);
    assert.isFalse(yield* executor.acquireStartBarrier("lease", Effect.succeed(true)));
  }),
);

it.effect("an in-flight stop keeps its lease until it finishes", () =>
  Effect.gen(function* () {
    const executor = yield* ThreadCommandExecutor.make;
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    assert.isTrue(
      yield* executor.acquireStartBarrier("lease", Effect.succeed(true), "snapshot", 30_000),
    );
    const stop = yield* executor
      .withStartBarrier("lease", () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
      )
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    yield* TestClock.adjust("31 seconds");
    assert.equal(
      (yield* Effect.flip(executor.withStartAdmission(Effect.void)))._tag,
      "StartAdmissionBlocked",
    );
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(stop);
    assert.equal(
      (yield* Effect.flip(executor.withStartAdmission(Effect.void)))._tag,
      "StartAdmissionBlocked",
    );
    yield* TestClock.adjust("31 seconds");
    yield* executor.withStartAdmission(Effect.void);
  }),
);

it.effect("an expired timer cannot release a later shutdown lease", () =>
  Effect.gen(function* () {
    const executor = yield* ThreadCommandExecutor.make;
    assert.isTrue(
      yield* executor.acquireStartBarrier("old", Effect.succeed(true), "snapshot", 30_000),
    );
    assert.isTrue(yield* executor.releaseStartBarrier("old"));
    assert.isTrue(yield* executor.acquireStartBarrier("new", Effect.succeed(true)));
    yield* TestClock.adjust("31 seconds");
    assert.equal(
      (yield* Effect.flip(executor.withStartAdmission(Effect.void)))._tag,
      "StartAdmissionBlocked",
    );
    assert.isTrue(yield* executor.releaseStartBarrier("new"));
  }),
);

it.effect(
  "a sealed lease remains held while the desktop renews it, and expires if it disappears",
  () =>
    Effect.gen(function* () {
      const executor = yield* ThreadCommandExecutor.make;
      assert.isTrue(
        yield* executor.acquireStartBarrier("lease", Effect.succeed(true), "snapshot", 30_000),
      );
      assert.isFalse(yield* executor.sealStartBarrier("lease", Effect.succeed(false)));
      assert.isTrue(yield* executor.sealStartBarrier("lease", Effect.succeed(true)));
      yield* TestClock.adjust("20 seconds");
      yield* executor.withStartBarrier("lease", () => Effect.void);
      yield* TestClock.adjust("15 seconds");
      assert.equal(
        (yield* Effect.flip(executor.withStartAdmission(Effect.void)))._tag,
        "StartAdmissionBlocked",
      );
      yield* TestClock.adjust("16 seconds");
      yield* executor.withStartAdmission(Effect.void);
    }),
);

it.effect("starting backend exit retains admission until exit even if the client disappears", () =>
  Effect.gen(function* () {
    const executor = yield* ThreadCommandExecutor.make;
    const exits = yield* Ref.make(0);
    assert.isTrue(
      yield* executor.acquireStartBarrier("lease", Effect.succeed(true), "snapshot", 30_000),
    );
    assert.isFalse(
      yield* executor.exitWithStartBarrier(
        "lease",
        Effect.succeed(true),
        Ref.update(exits, (n) => n + 1),
      ),
    );
    assert.isTrue(yield* executor.sealStartBarrier("lease", Effect.succeed(true)));
    assert.isTrue(
      yield* executor.exitWithStartBarrier(
        "lease",
        Effect.succeed(true),
        Ref.update(exits, (n) => n + 1),
      ),
    );
    assert.isTrue(
      yield* executor.exitWithStartBarrier(
        "lease",
        Effect.succeed(true),
        Ref.update(exits, (n) => n + 1),
      ),
    );
    yield* TestClock.adjust("60 seconds");
    assert.equal(yield* Ref.get(exits), 1);
    assert.isFalse(yield* executor.releaseStartBarrier("lease"));
    assert.equal(
      (yield* Effect.flip(executor.withStartAdmission(Effect.void)))._tag,
      "StartAdmissionBlocked",
    );
  }),
);
