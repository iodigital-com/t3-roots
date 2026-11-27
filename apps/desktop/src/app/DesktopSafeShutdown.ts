import * as NodeBuffer from "node:buffer";
import {
  DesktopSafeShutdownResponse,
  type DesktopSafeShutdownRequest,
  type DesktopSafeShutdownResponse as BackendResponse,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";

const IDLE_MS = 30_000;
const decodeBackendResponse = Schema.decodeUnknownEffect(DesktopSafeShutdownResponse);
const compositeId = (backendId: string, threadId: string) =>
  NodeBuffer.Buffer.from(JSON.stringify([backendId, threadId])).toString("base64url");

export class DesktopSafeShutdownError extends Schema.TaggedError<DesktopSafeShutdownError>()(
  "DesktopSafeShutdownError",
  {},
) {
  override get message() {
    return "Could not coordinate a safe desktop shutdown.";
  }
}

type BackendSnapshot = Extract<BackendResponse, { readonly type: "snapshot" }>;
type Backend = {
  readonly id: DesktopBackendPool.BackendInstanceId;
  readonly instance: DesktopBackendPool.DesktopBackendInstance;
  readonly url: string;
  readonly pid: number;
  readonly distro: string | null;
  readonly restart: boolean;
  readonly snapshot: BackendSnapshot;
};
type Inspection = {
  readonly snapshotToken: string;
  readonly state: string;
  readonly backends: ReadonlyArray<Backend>;
};
type Lease = {
  readonly id: string;
  readonly inspection: Inspection;
  readonly expiresAt: number;
  readonly sealed: boolean;
  readonly committed: boolean;
  readonly readyToQuit: boolean;
  readonly recoverable: boolean;
};

export class DesktopSafeShutdown extends Context.Service<
  DesktopSafeShutdown,
  {
    readonly execute: (
      command: DesktopSafeShutdownRequest,
    ) => Effect.Effect<unknown, DesktopSafeShutdownError>;
    readonly commitOnQuit: Effect.Effect<boolean>;
    readonly admit: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("@t3tools/desktop/app/DesktopSafeShutdown") {}

const hostProcessExited = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  });

export const make = Effect.fn("DesktopSafeShutdown.make")(function* (
  processExited: (pid: number) => Effect.Effect<boolean> = hostProcessExited,
) {
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
  const ssh = yield* DesktopSshEnvironment.DesktopSshEnvironment;
  const wsl = yield* DesktopWslEnvironment.DesktopWslEnvironment;
  const http = yield* HttpClient.HttpClient;
  const random = yield* SecureRandom.SecureRandom;
  const scope = yield* Scope.Scope;
  const mutex = yield* Semaphore.make(1);
  const inspectionRef = yield* Ref.make<Inspection | null>(null);
  const leaseRef = yield* Ref.make<Lease | null>(null);
  const released = new Set<string>();

  const call = Effect.fn("desktop.safeShutdown.backend")(function* (
    backend: Pick<Backend, "url" | "id">,
    command: DesktopSafeShutdownRequest,
  ) {
    const token = yield* auth.getBearerTokenFor(backend.id).pipe(
      Effect.timeout(Duration.seconds(10)),
      Effect.mapError(() => new DesktopSafeShutdownError()),
    );
    const request = HttpClientRequest.post(
      new URL("/api/orchestration/desktop-safe-shutdown", backend.url).href,
    ).pipe(HttpClientRequest.bearerToken(token), HttpClientRequest.bodyJsonUnsafe(command));
    const response = yield* http.execute(request).pipe(
      Effect.timeout(Duration.seconds(10)),
      Effect.mapError(() => new DesktopSafeShutdownError()),
    );
    if (response.status !== 200) return yield* new DesktopSafeShutdownError();
    return yield* response.json.pipe(
      Effect.flatMap(decodeBackendResponse),
      Effect.mapError(() => new DesktopSafeShutdownError()),
    );
  });

  const readPool = Effect.fn("desktop.safeShutdown.readPool")(function* () {
    const instances = yield* pool.list;
    const entries = yield* Effect.forEach(instances, (instance) =>
      Effect.gen(function* () {
        const snapshot = yield* instance.snapshot;
        const config = yield* instance.currentConfig;
        if (
          (snapshot.desiredRunning || Option.isSome(snapshot.activePid)) &&
          (!snapshot.ready || Option.isNone(config))
        )
          return yield* new DesktopSafeShutdownError();
        if (
          snapshot.ready &&
          (Option.isNone(snapshot.activePid) || snapshot.activeRunId === undefined)
        )
          return yield* new DesktopSafeShutdownError();
        return { instance, snapshot, config };
      }),
    );
    // @effect-diagnostics-next-line globalJsonInEffect:off - The identity contains only local scalar values.
    const state = JSON.stringify(
      entries
        .map(({ instance, snapshot, config }) => ({
          id: instance.id,
          desiredRunning: snapshot.desiredRunning,
          ready: snapshot.ready,
          pid: Option.getOrNull(snapshot.activePid),
          run: snapshot.activeRunId ?? null,
          url: Option.isSome(config) ? config.value.httpBaseUrl.href : null,
        }))
        .toSorted((a, b) => a.id.localeCompare(b.id)),
    );
    return { entries, state };
  });

  const releaseBackend = Effect.fn("desktop.safeShutdown.releaseBackend")(function* (
    backend: Backend,
    leaseId: string,
  ) {
    const response = yield* call(backend, { type: "release", leaseId }).pipe(Effect.option);
    if (Option.isSome(response) && response.value.type === "release" && response.value.released)
      return true;
    return yield* backend.distro === null
      ? processExited(backend.pid)
      : wsl.processExited(backend.distro, backend.pid);
  });

  const cleanup = Effect.fn("desktop.safeShutdown.cleanup")(function* (lease: Lease) {
    const safe = yield* Effect.forEach(
      lease.inspection.backends,
      (backend) => releaseBackend(backend, lease.id),
      { concurrency: "unbounded" },
    );
    if (!safe.every(Boolean)) return false;
    yield* ssh.releaseTaggedQuit(lease.id).pipe(Effect.ignore);
    yield* pool.quitAdmission.release(lease.id).pipe(Effect.ignore);
    yield* Ref.set(leaseRef, null);
    return true;
  });

  const recover = Effect.fn("desktop.safeShutdown.recover")(function* (lease: Lease) {
    const safe = yield* Effect.forEach(
      lease.inspection.backends,
      (backend) => releaseBackend(backend, lease.id),
      { concurrency: "unbounded" },
    );
    if (!safe.every(Boolean)) return false;
    if (!(yield* ssh.recoverTaggedQuit(lease.id))) return false;
    if (!(yield* pool.quitAdmission.recover(lease.id))) return false;
    released.add(lease.id);
    yield* Ref.set(leaseRef, null);
    yield* Effect.forEach(
      lease.inspection.backends.filter((backend) => backend.restart),
      (backend) => backend.instance.start,
      { concurrency: "unbounded", discard: true },
    );
    return true;
  });

  const watchdog = Effect.fn("desktop.safeShutdown.watchdog")(function* (leaseId: string) {
    while (true) {
      yield* Effect.sleep(Duration.seconds(5));
      const finished = yield* mutex.withPermit(
        Effect.gen(function* () {
          const lease = yield* Ref.get(leaseRef);
          if (lease === null || lease.id !== leaseId) return true;
          if (lease.readyToQuit) return true;
          if (lease.committed && lease.recoverable) return yield* recover(lease);
          if (
            !lease.committed &&
            (released.has(lease.id) || (yield* Clock.currentTimeMillis) >= lease.expiresAt)
          ) {
            released.add(lease.id);
            return yield* cleanup(lease);
          }
          yield* Effect.forEach(
            lease.inspection.backends,
            (backend) => call(backend, { type: "status", leaseId }).pipe(Effect.ignore),
            { concurrency: "unbounded", discard: true },
          );
          return false;
        }),
      );
      if (finished) return;
    }
  });

  const refresh = (lease: Lease) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) => ({ ...lease, expiresAt: now + IDLE_MS })),
      Effect.tap((next) => Ref.set(leaseRef, next)),
    );

  const execute = Effect.fn("desktop.safeShutdown.execute")(function* (
    command: DesktopSafeShutdownRequest,
  ) {
    return yield* mutex.withPermit(
      Effect.gen(function* () {
        if (command.type === "capabilities")
          return {
            type: "capabilities",
            version: 1,
            atomicSnapshot: true,
            conditionalStop: true,
            blocksStartsThroughShutdown: true,
            coordinatedRelease: true,
            releaseKeepsStopped: true,
            recoverableAcquire: true,
            recoverableAfterClientCrash: true,
            coordinatesDesktopBackends: true,
            preservesTerminalProcesses: true,
          } as const;
        if (command.type === "backend-exit") return yield* new DesktopSafeShutdownError();
        if (command.type === "snapshot") {
          if ((yield* Ref.get(leaseRef)) !== null) return yield* new DesktopSafeShutdownError();
          yield* Ref.set(inspectionRef, null);
          const current = yield* readPool();
          const backends = yield* Effect.forEach(
            current.entries.filter(({ snapshot }) => snapshot.ready),
            ({ instance, config, snapshot: instanceSnapshot }) =>
              Effect.gen(function* () {
                if (Option.isNone(config)) return yield* new DesktopSafeShutdownError();
                const backend = {
                  id: instance.id,
                  url: config.value.httpBaseUrl.href,
                };
                const capability = yield* call(backend, { type: "capabilities" });
                if (
                  capability.type !== "capabilities" ||
                  capability.version !== 1 ||
                  capability.pid === undefined
                )
                  return yield* new DesktopSafeShutdownError();
                const isWsl = instance.id.startsWith("wsl:");
                if (
                  (isWsl && !config.value.runningDistro) ||
                  (!isWsl &&
                    (Option.isNone(instanceSnapshot.activePid) ||
                      instanceSnapshot.activePid.value !== capability.pid))
                )
                  return yield* new DesktopSafeShutdownError();
                const snapshot = yield* call(backend, { type: "snapshot" });
                if (snapshot.type === "terminal-busy") return { terminalBusy: true } as const;
                if (snapshot.type !== "snapshot") return yield* new DesktopSafeShutdownError();
                return {
                  ...backend,
                  instance,
                  pid: capability.pid,
                  distro: isWsl ? config.value.runningDistro! : null,
                  restart: instanceSnapshot.desiredRunning,
                  snapshot,
                };
              }),
          );
          if (backends.some((backend) => "terminalBusy" in backend))
            return { type: "terminal-busy" as const };
          const available = backends.filter(
            (backend): backend is Backend => !("terminalBusy" in backend),
          );
          const token = yield* random
            .uuidV4()
            .pipe(Effect.mapError(() => new DesktopSafeShutdownError()));
          const inspection = { snapshotToken: token, state: current.state, backends: available };
          yield* Ref.set(inspectionRef, inspection);
          return {
            type: "snapshot" as const,
            snapshotToken: token,
            threads: available.flatMap((backend) =>
              backend.snapshot.threads.map((thread) => ({
                ...thread,
                id: compositeId(backend.id, thread.id),
              })),
            ),
          };
        }
        if (command.type === "acquire") {
          const existing = yield* Ref.get(leaseRef);
          if (existing !== null)
            return {
              type: "acquire" as const,
              acquired:
                !released.has(command.leaseId) &&
                existing.id === command.leaseId &&
                existing.inspection.snapshotToken === command.snapshotToken,
            };
          const inspection = yield* Ref.get(inspectionRef);
          if (
            released.has(command.leaseId) ||
            inspection === null ||
            inspection.snapshotToken !== command.snapshotToken
          )
            return { type: "acquire" as const, acquired: false };
          yield* Ref.set(inspectionRef, null);
          const lease: Lease = {
            id: command.leaseId,
            inspection,
            expiresAt: (yield* Clock.currentTimeMillis) + IDLE_MS,
            sealed: false,
            committed: false,
            readyToQuit: false,
            recoverable: false,
          };
          const rollback = Effect.gen(function* () {
            released.add(lease.id);
            yield* cleanup(lease);
          });
          yield* Ref.set(leaseRef, lease);
          yield* Effect.forkIn(watchdog(lease.id), scope, { startImmediately: true });
          return yield* Effect.gen(function* () {
            const acquired = yield* pool.quitAdmission.prepare(
              lease.id,
              Effect.gen(function* () {
                if ((yield* readPool()).state !== inspection.state) return false;
                if (!(yield* ssh.prepareTaggedQuit(lease.id))) return false;
                const responses = yield* Effect.forEach(
                  inspection.backends,
                  (backend) =>
                    call(backend, {
                      type: "acquire",
                      leaseId: lease.id,
                      snapshotToken: backend.snapshot.snapshotToken,
                    }),
                  { concurrency: "unbounded" },
                );
                if (
                  !responses.every((response) => response.type === "acquire" && response.acquired)
                )
                  return false;
                const held = yield* Effect.forEach(
                  inspection.backends,
                  (backend) => call(backend, { type: "status", leaseId: lease.id }),
                  { concurrency: "unbounded" },
                );
                return held.every((response) => response.type === "status");
              }),
            );
            if (!acquired) {
              yield* rollback;
              return { type: "acquire" as const, acquired: false };
            }
            yield* refresh(lease);
            return { type: "acquire" as const, acquired: true };
          }).pipe(Effect.onError(() => rollback));
        }
        if (command.type === "release") {
          released.add(command.leaseId);
          const lease = yield* Ref.get(leaseRef);
          const confirmed =
            lease === null || lease.id !== command.leaseId
              ? true
              : !lease.committed && (yield* cleanup(lease));
          return {
            type: "release" as const,
            released: confirmed,
          };
        }
        const current = yield* Ref.get(leaseRef);
        if (
          current === null ||
          current.id !== command.leaseId ||
          current.committed ||
          released.has(command.leaseId)
        )
          return yield* new DesktopSafeShutdownError();
        const lease = yield* refresh(current);
        if (command.type === "quit") {
          if (!lease.sealed) return { type: "quit" as const, accepted: false };
          const committed = yield* Effect.gen(function* () {
            const accepted = yield* pool.quitAdmission.commit(
              lease.id,
              Effect.gen(function* () {
                const results = yield* Effect.forEach(
                  lease.inspection.backends,
                  (backend) => call(backend, { type: "seal", leaseId: lease.id }),
                  { concurrency: "unbounded" },
                );
                if (!results.every((response) => response.type === "seal" && response.sealed))
                  return false;
                return yield* ssh.commitTaggedQuit(lease.id);
              }).pipe(Effect.orElseSucceed(() => false)),
            );
            if (accepted) yield* Ref.set(leaseRef, { ...lease, committed: true });
            return accepted;
          }).pipe(Effect.uninterruptible);
          if (!committed) {
            released.add(lease.id);
            yield* cleanup(lease);
            return { type: "quit" as const, accepted: false };
          }
          const exiting = yield* Effect.forEach(
            lease.inspection.backends,
            (backend) =>
              call(backend, { type: "backend-exit", leaseId: lease.id }).pipe(Effect.option),
            { concurrency: "unbounded" },
          );
          if (
            !exiting.every(
              (response) =>
                Option.isSome(response) &&
                response.value.type === "backend-exit" &&
                response.value.accepted,
            )
          ) {
            yield* Ref.set(leaseRef, { ...lease, committed: true, recoverable: true });
            return { type: "quit" as const, accepted: false };
          }
          yield* Effect.forEach(lease.inspection.backends, (backend) => backend.instance.stop(), {
            concurrency: "unbounded",
            discard: true,
          });
          const gone = yield* Effect.forEach(
            lease.inspection.backends,
            (backend) =>
              backend.distro === null
                ? processExited(backend.pid)
                : wsl.processExited(backend.distro, backend.pid),
            { concurrency: "unbounded" },
          );
          if (!gone.every(Boolean)) {
            yield* Ref.set(leaseRef, { ...lease, committed: true, recoverable: true });
            return { type: "quit" as const, accepted: false };
          }
          yield* Ref.set(leaseRef, { ...lease, committed: true, readyToQuit: true });
          return { type: "quit" as const, accepted: true };
        }
        if (command.type === "stop") {
          for (const backend of lease.inspection.backends) {
            for (const thread of backend.snapshot.threads) {
              const id = compositeId(backend.id, thread.id);
              if (id !== command.threadId || thread.workToken !== command.workToken) continue;
              return yield* call(backend, { ...command, threadId: thread.id });
            }
          }
          return { type: "stop" as const, status: "changed" as const };
        }
        const statuses = yield* Effect.forEach(lease.inspection.backends, (backend) =>
          call(backend, { type: "status", leaseId: lease.id }),
        );
        const ready = statuses.every(
          (result) => result.type === "status" && result.status === "ready",
        );
        if (command.type === "status")
          return {
            type: "status" as const,
            status: ready ? ("ready" as const) : ("quiescing" as const),
          };
        if (!ready) return { type: "seal" as const, sealed: false };
        yield* Ref.set(leaseRef, { ...lease, sealed: true });
        return { type: "seal" as const, sealed: true };
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            if (!("leaseId" in command) || command.type === "release") return;
            const current = yield* Ref.get(leaseRef);
            if (current !== null && current.id === command.leaseId && !current.committed)
              yield* refresh(current);
          }),
        ),
      ),
    );
  });

  const commitOnQuit = mutex.withPermit(
    Effect.gen(function* () {
      const lease = yield* Ref.get(leaseRef);
      return lease === null || lease.readyToQuit;
    }),
  );

  return DesktopSafeShutdown.of({ execute, commitOnQuit, admit: pool.quitAdmission.run });
});

export const layer = Layer.effect(DesktopSafeShutdown, make());
