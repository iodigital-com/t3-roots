import type { ThreadId } from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";

export class StartAdmissionBlocked extends Schema.TaggedError<StartAdmissionBlocked>()(
  "StartAdmissionBlocked",
  {},
) {}

export class StartBarrierMissing extends Schema.TaggedError<StartBarrierMissing>()(
  "StartBarrierMissing",
  {},
) {}

export class ThreadCommandExecutor extends Context.Service<
  ThreadCommandExecutor,
  KeyedLock.KeyedLock<ThreadId> & {
    /**
     * One thread deletion plans and commits at a time: each decides what its deleted fork
     * sources keep for the forks still alive. Take it before any thread lock.
     */
    readonly withDeletionLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    readonly withStartAdmission: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | StartAdmissionBlocked, R>;
    readonly awaitStartAdmission: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly acquireStartBarrier: <E, R>(
      leaseId: string,
      verify: Effect.Effect<boolean, E, R>,
      snapshotToken?: string,
      maxIdleMs?: number,
    ) => Effect.Effect<boolean, E, R>;
    readonly withStartBarrier: <A, E, R>(
      leaseId: string,
      use: (snapshotToken: string) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | StartBarrierMissing, R>;
    readonly sealStartBarrier: <E, R>(
      leaseId: string,
      verify: Effect.Effect<boolean, E, R>,
    ) => Effect.Effect<boolean, E, R>;
    readonly exitWithStartBarrier: <E, R>(
      leaseId: string,
      verify: Effect.Effect<boolean, E, R>,
      requestExit: Effect.Effect<void>,
    ) => Effect.Effect<boolean, E, R>;
    readonly releaseStartBarrier: (leaseId: string) => Effect.Effect<boolean>;
  }
>()("t3/orchestration-v2/ThreadCommandExecutor") {}

export const make = Effect.gen(function* () {
  const scope = yield* Scope.Scope;
  const deletion = yield* Semaphore.make(1);
  // A scheduled launch can enter admission again when it dispatches its message.
  const admissionPermits = 1_000_000;
  const admission = yield* Semaphore.make(admissionPermits);
  // A release can overtake a timed-out acquire request. Retain its id until this
  // server exits so a delayed request can never reopen that transaction.
  const releasedLeases = new Set<string>();
  const barrier = yield* Ref.make<{
    readonly leaseId: string;
    readonly snapshotToken: string;
    readonly released: Deferred.Deferred<void>;
    readonly maxIdleMs: number | undefined;
    readonly expiresAt: number | undefined;
    readonly sealed: boolean;
    readonly exiting: boolean;
  } | null>(null);
  const renewLease = (leaseId: string) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        Ref.update(barrier, (current) =>
          current?.leaseId === leaseId && current.maxIdleMs !== undefined
            ? { ...current, expiresAt: now + current.maxIdleMs }
            : current,
        ),
      ),
    );
  const expireLease = Effect.fn("ThreadCommandExecutor.expireLease")(function* (leaseId: string) {
    while (true) {
      const current = yield* Ref.get(barrier);
      if (current?.leaseId !== leaseId || current.expiresAt === undefined) return;
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.sleep(Duration.millis(Math.max(0, current.expiresAt - now)));
      const done = yield* admission.withPermits(admissionPermits)(
        Effect.gen(function* () {
          const latest = yield* Ref.get(barrier);
          if (latest?.leaseId !== leaseId || latest.expiresAt === undefined) return true;
          if ((yield* Clock.currentTimeMillis) < latest.expiresAt) return false;
          releasedLeases.add(leaseId);
          yield* Ref.set(barrier, null);
          yield* Deferred.succeed(latest.released, undefined);
          return true;
        }),
      );
      if (done) return;
    }
  });
  const awaitStartAdmission: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> =
    Effect.fn("ThreadCommandExecutor.awaitStartAdmission")(function* <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.fn.Return<A, E, R> {
      const attempt = yield* admission.withPermit(
        Effect.gen(function* () {
          const current = yield* Ref.get(barrier);
          if (current !== null) return { _tag: "Waiting" as const, released: current.released };
          return { _tag: "Started" as const, value: yield* effect };
        }),
      );
      if (attempt._tag === "Started") return attempt.value;
      yield* Deferred.await(attempt.released);
      return yield* Effect.suspend(() => awaitStartAdmission(effect));
    });
  return ThreadCommandExecutor.of({
    ...(yield* KeyedLock.make<ThreadId>()),
    withDeletionLock: Effect.fn("ThreadCommandExecutor.withDeletionLock")(function* <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) {
      return yield* deletion.withPermit(effect);
    }),
    withStartAdmission: Effect.fn("ThreadCommandExecutor.withStartAdmission")(function* <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) {
      return yield* admission.withPermit(
        Effect.gen(function* () {
          if ((yield* Ref.get(barrier)) !== null) return yield* new StartAdmissionBlocked();
          return yield* effect;
        }),
      );
    }),
    awaitStartAdmission,
    acquireStartBarrier: Effect.fn("ThreadCommandExecutor.acquireStartBarrier")(function* <E, R>(
      leaseId: string,
      verify: Effect.Effect<boolean, E, R>,
      snapshotToken = "",
      maxIdleMs?: number,
    ) {
      return yield* admission.withPermits(admissionPermits)(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            if (releasedLeases.has(leaseId)) return false;
            const current = yield* Ref.get(barrier);
            if (current !== null) {
              if (current.leaseId !== leaseId || current.snapshotToken !== snapshotToken)
                return false;
              yield* renewLease(leaseId);
              return true;
            }
            if (!(yield* restore(verify))) return false;
            const now = yield* Clock.currentTimeMillis;
            yield* Ref.set(barrier, {
              leaseId,
              snapshotToken,
              released: yield* Deferred.make<void>(),
              maxIdleMs,
              expiresAt: maxIdleMs === undefined ? undefined : now + maxIdleMs,
              sealed: false,
              exiting: false,
            });
            if (maxIdleMs !== undefined)
              yield* Effect.forkIn(expireLease(leaseId), scope, { startImmediately: true });
            return true;
          }),
        ),
      );
    }),
    withStartBarrier: Effect.fn("ThreadCommandExecutor.withStartBarrier")(function* <A, E, R>(
      leaseId: string,
      use: (snapshotToken: string) => Effect.Effect<A, E, R>,
    ) {
      return yield* admission.withPermit(
        Effect.gen(function* () {
          const current = yield* Ref.get(barrier);
          if (current === null || current.leaseId !== leaseId)
            return yield* new StartBarrierMissing();
          yield* renewLease(leaseId);
          return yield* use(current.snapshotToken).pipe(Effect.ensuring(renewLease(leaseId)));
        }),
      );
    }),
    sealStartBarrier: Effect.fn("ThreadCommandExecutor.sealStartBarrier")(function* <E, R>(
      leaseId: string,
      verify: Effect.Effect<boolean, E, R>,
    ) {
      return yield* admission.withPermits(admissionPermits)(
        Effect.gen(function* () {
          const current = yield* Ref.get(barrier);
          if (current === null || current.leaseId !== leaseId) return false;
          if (current.sealed) return true;
          if (!(yield* verify)) return false;
          const now = yield* Clock.currentTimeMillis;
          yield* Ref.set(barrier, {
            ...current,
            sealed: true,
            expiresAt: current.maxIdleMs === undefined ? undefined : now + current.maxIdleMs,
          });
          return true;
        }),
      );
    }),
    exitWithStartBarrier: Effect.fn("ThreadCommandExecutor.exitWithStartBarrier")(function* <E, R>(
      leaseId: string,
      verify: Effect.Effect<boolean, E, R>,
      requestExit: Effect.Effect<void>,
    ) {
      return yield* admission.withPermits(admissionPermits)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const current = yield* Ref.get(barrier);
            if (current === null || current.leaseId !== leaseId || !current.sealed) return false;
            if (current.exiting) return true;
            if (!(yield* verify)) return false;
            yield* Ref.set(barrier, {
              ...current,
              maxIdleMs: undefined,
              expiresAt: undefined,
              exiting: true,
            });
            yield* requestExit;
            return true;
          }),
        ),
      );
    }),
    releaseStartBarrier: Effect.fn("ThreadCommandExecutor.releaseStartBarrier")(
      function* (leaseId) {
        return yield* admission.withPermits(admissionPermits)(
          Effect.gen(function* () {
            const current = yield* Ref.get(barrier);
            if (current?.leaseId === leaseId && current.exiting) return false;
            releasedLeases.add(leaseId);
            if (current === null || current.leaseId !== leaseId) return true;
            yield* Ref.set(barrier, null);
            yield* Deferred.succeed(current.released, undefined);
            return true;
          }),
        );
      },
    ),
  });
});

export const layer = Layer.effect(ThreadCommandExecutor, make);
