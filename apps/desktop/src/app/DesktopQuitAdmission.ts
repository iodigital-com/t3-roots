import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

interface AdmissionRoot {
  pending: number;
  readonly finished: Deferred.Deferred<void>;
}

interface AdmissionFrame {
  readonly gate: object;
  readonly root: AdmissionRoot;
  active: boolean;
}

// A child inherits its immediate frame, not a blanket exemption from the gate.
const CurrentFrame = Context.Reference<AdmissionFrame | null>("desktop/QuitAdmissionFrame", {
  defaultValue: () => null,
});

/** A prepared quit holds new work until its owner cancels or the process exits. */
export const make = Effect.gen(function* () {
  const permits = 1_000_000;
  const admission = yield* Semaphore.make(permits);
  const gate = {};
  const state = yield* Ref.make<{
    readonly leaseId: string;
    readonly committed: boolean;
    readonly released: Deferred.Deferred<void>;
  } | null>(null);

  const run: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> = Effect.fn(
    "desktop.quitAdmission.run",
  )(function* <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.fn.Return<A, E, R> {
    const parent = yield* CurrentFrame;
    if (parent?.gate === gate && parent.active) {
      parent.root.pending++;
      const frame: AdmissionFrame = { gate, root: parent.root, active: true };
      return yield* effect.pipe(
        Effect.provideService(CurrentFrame, frame),
        Effect.ensuring(
          Effect.gen(function* () {
            frame.active = false;
            if (--frame.root.pending === 0) yield* Deferred.succeed(frame.root.finished, undefined);
          }),
        ),
      );
    }
    const result = yield* admission.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (current !== null) return { _tag: "Wait" as const, released: current.released };
        const root: AdmissionRoot = { pending: 1, finished: yield* Deferred.make<void>() };
        const frame: AdmissionFrame = { gate, root, active: true };
        const value = yield* effect.pipe(
          Effect.provideService(CurrentFrame, frame),
          Effect.ensuring(
            Effect.gen(function* () {
              frame.active = false;
              if (--root.pending === 0) yield* Deferred.succeed(root.finished, undefined);
              yield* Deferred.await(root.finished);
            }),
          ),
        );
        return { _tag: "Done" as const, value };
      }),
    );
    if (result._tag === "Done") return result.value;
    yield* Deferred.await(result.released);
    return yield* Effect.suspend(() => run(effect));
  });

  const prepare = <E, R>(leaseId: string, verify: Effect.Effect<boolean, E, R>) =>
    admission.withPermits(permits)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (current !== null) return current.leaseId === leaseId && !current.committed;
        if (!(yield* verify)) return false;
        yield* Ref.set(state, {
          leaseId,
          committed: false,
          released: yield* Deferred.make<void>(),
        });
        return true;
      }),
    );

  const release = (leaseId: string, allowCommitted = false) =>
    admission.withPermits(permits)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (
          current === null ||
          current.leaseId !== leaseId ||
          (current.committed && !allowCommitted)
        )
          return false;
        yield* Ref.set(state, null);
        yield* Deferred.succeed(current.released, undefined);
        return true;
      }),
    );

  const commit = <E, R>(leaseId: string, verify: Effect.Effect<boolean, E, R>) =>
    admission.withPermits(permits)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (current === null || current.leaseId !== leaseId) return false;
        if (current.committed) return true;
        if (!(yield* verify)) return false;
        yield* Ref.set(state, { ...current, committed: true });
        return true;
      }),
    );

  const runShutdown = Effect.fn("desktop.quitAdmission.runShutdown")(function* <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.fn.Return<A, E, R> {
    const current = yield* Ref.get(state);
    return yield* current?.committed === true ? effect : run(effect);
  });

  return {
    run,
    runShutdown,
    prepare,
    release: (leaseId: string) => release(leaseId),
    recover: (leaseId: string) => release(leaseId, true),
    commit,
  };
});

export type DesktopQuitAdmission = Effect.Success<typeof make>;
