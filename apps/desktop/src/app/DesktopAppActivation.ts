// @effect-diagnostics nodeBuiltinImport:off -- Local socket ownership checks need lstat, an atomic rename, and a directory watch at the Node adapter boundary.
import { pipe } from "effect/Function";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
  DesktopAppActivationRequest,
  type DesktopAppActivationResponse,
  DesktopSafeShutdownControlRequest,
  type DesktopSafeShutdownControlResponse,
} from "@t3tools/contracts";
import { resolveDesktopAppControlAddress } from "@t3tools/shared/desktopAppControl";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import type * as Electron from "electron";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import { DESKTOP_APP_ACTIVATION_REQUEST_CHANNEL } from "../ipc/channels.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import { DesktopAppActivationBroker } from "./DesktopAppActivationBroker.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopSafeShutdown from "./DesktopSafeShutdown.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

const MAX_REQUEST_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const isDesktopAppActivationRequest = Schema.is(DesktopAppActivationRequest);
const isSafeShutdownRequest = Schema.is(DesktopSafeShutdownControlRequest);

const windowsPrivateDirectoryScript = `
$ErrorActionPreference = 'Stop'
$p = $env:T3_SAFE_SHUTDOWN_DIRECTORY
if ([IO.Directory]::Exists($p) -or [IO.File]::Exists($p)) { throw 'Directory already exists' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($sid)
$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
[IO.Directory]::CreateDirectory($p, $acl) | Out-Null
$actual = Get-Acl -LiteralPath $p
$rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]) -ne $sid -or $rules.Count -ne 1 -or $rules[0].IdentityReference -ne $sid -or $rules[0].AccessControlType -ne 'Allow' -or -not $rules[0].FileSystemRights.HasFlag([Security.AccessControl.FileSystemRights]::FullControl) -or -not $rules[0].InheritanceFlags.HasFlag([Security.AccessControl.InheritanceFlags]::ObjectInherit)) { throw 'Directory access is not private' }
`;

export async function createDesktopControlSecret(stateDir: string, platform: NodeJS.Platform) {
  const name = `desktop-safe-shutdown-${NodeCrypto.randomBytes(16).toString("hex")}`;
  const directory = NodePath.join(stateDir, name);
  const keyPath = NodePath.join(directory, "key");
  const reference = NodePath.join(stateDir, "desktop-safe-shutdown.ref");
  const temporary = `${reference}.${NodeCrypto.randomBytes(8).toString("hex")}.tmp`;
  const secret = NodeCrypto.randomBytes(32).toString("hex");
  await NodeFSP.mkdir(stateDir, { recursive: true, mode: 0o700 });
  if (platform === "win32") {
    const powershell = NodePath.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    await new Promise<void>((resolve, reject) =>
      NodeChildProcess.execFile(
        powershell,
        ["-NoProfile", "-NonInteractive", "-Command", windowsPrivateDirectoryScript],
        { env: { ...process.env, T3_SAFE_SHUTDOWN_DIRECTORY: directory }, windowsHide: true },
        (error) => (error ? reject(error) : resolve()),
      ),
    );
  } else {
    await NodeFSP.mkdir(directory, { mode: 0o700 });
  }
  try {
    const stat = await NodeFSP.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Invalid desktop control directory");
    await NodeFSP.writeFile(keyPath, secret, { flag: "wx", mode: 0o600 });
  } catch (error) {
    await NodeFSP.unlink(temporary).catch(() => undefined);
    await NodeFSP.unlink(keyPath).catch(() => undefined);
    await NodeFSP.rmdir(directory).catch(() => undefined);
    throw error;
  }
  return {
    secret,
    publish: async () => {
      try {
        await NodeFSP.writeFile(temporary, name, { flag: "wx", mode: 0o600 });
        await NodeFSP.rename(temporary, reference);
      } catch (error) {
        await NodeFSP.unlink(temporary).catch(() => undefined);
        throw error;
      }
    },
    close: async () => {
      if ((await NodeFSP.readFile(reference, "utf8").catch(() => "")) === name)
        await NodeFSP.unlink(reference).catch(() => undefined);
      await NodeFSP.unlink(keyPath).catch(() => undefined);
      await NodeFSP.rmdir(directory).catch(() => undefined);
    },
  };
}

export class DesktopAppActivationStartError extends Schema.TaggedError<DesktopAppActivationStartError>()(
  "DesktopAppActivationStartError",
  {
    address: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not start the desktop app control socket at ${this.address}.`;
  }
}

interface RunningControlServer {
  readonly reclaim: () => Promise<void>;
  readonly close: () => Promise<void>;
}

function invalidResponse(requestId: string, message: string): DesktopAppActivationResponse {
  return {
    version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
    requestId,
    ok: false,
    code: "invalid-request",
    message,
  };
}

function requestIdFromUnknown(value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "requestId" in value &&
    typeof value.requestId === "string" &&
    value.requestId.trim().length > 0
  ) {
    return value.requestId;
  }
  return "invalid-request";
}

export async function handleSafeShutdownControl(
  secret: string,
  request: DesktopSafeShutdownControlRequest,
  execute: (command: DesktopSafeShutdownControlRequest["command"]) => Promise<unknown>,
): Promise<DesktopSafeShutdownControlResponse> {
  const expected = Buffer.from(secret, "utf8");
  const received = Buffer.from(request.secret, "utf8");
  if (expected.length !== received.length || !NodeCrypto.timingSafeEqual(expected, received))
    return { version: 1, type: "safe-shutdown", requestId: request.requestId, ok: false };
  const result = await execute(request.command);
  return { version: 1, type: "safe-shutdown", requestId: request.requestId, ok: true, result };
}

async function prepareUnixDirectory(input: {
  readonly directory: string;
  readonly userId: number | undefined;
}): Promise<boolean> {
  const created = await NodeFSP.mkdir(input.directory, { recursive: true, mode: 0o700 });
  const stat = await NodeFSP.lstat(input.directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${input.directory} is not a directory.`);
  }
  if (input.userId !== undefined && stat.uid !== input.userId) {
    throw new Error(`${input.directory} is owned by another user.`);
  }
  await NodeFSP.chmod(input.directory, 0o700);
  return created !== undefined;
}

async function inodeAt(path: string): Promise<number | null> {
  return NodeFSP.lstat(path).then(
    (stat) => stat.ino,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
}

function closeServer(server: NodeNet.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function startDesktopAppControlServer(input: {
  readonly address: string;
  readonly directory: string | null;
  readonly userId: number | undefined;
  readonly handle: (request: DesktopAppActivationRequest) => Promise<DesktopAppActivationResponse>;
  readonly handleShutdown?: (
    request: DesktopSafeShutdownControlRequest,
  ) => Promise<DesktopSafeShutdownControlResponse>;
  readonly afterShutdownResponse?: () => void;
  readonly cancel: (requestId: string) => void;
  readonly onReclaimError: (error: unknown) => void;
}): Promise<RunningControlServer> {
  const sockets = new Set<NodeNet.Socket>();
  const handleConnection = (socket: NodeNet.Socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let handled = false;
    let responseSent = false;
    let activeRequestId: string | null = null;
    let shutdownRequest = false;

    socket.setTimeout(5_000, () => socket.destroy());

    const finish = (
      response: DesktopAppActivationResponse | DesktopSafeShutdownControlResponse,
      after?: () => void,
    ) => {
      responseSent = true;
      let completed = false;
      const complete = () => {
        if (completed) return;
        completed = true;
        after?.();
      };
      if (socket.destroyed) return complete();
      if (after !== undefined) socket.once("close", complete);
      socket.end(`${JSON.stringify(response)}\n`, complete);
    };

    socket.on("data", (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
        handled = true;
        finish(invalidResponse("invalid-request", "The desktop app request is too large."));
        return;
      }

      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      handled = true;
      socket.setTimeout(0);
      const line = buffer.slice(0, newline);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        finish(invalidResponse("invalid-request", "The desktop app request is not valid JSON."));
        return;
      }

      if (isSafeShutdownRequest(parsed) && input.handleShutdown !== undefined) {
        activeRequestId = parsed.requestId;
        shutdownRequest = true;
        void input.handleShutdown(parsed).then(
          (response) => {
            const result = response.ok ? response.result : null;
            const accepted =
              parsed.command.type === "quit" &&
              typeof result === "object" &&
              result !== null &&
              "type" in result &&
              result.type === "quit" &&
              "accepted" in result &&
              result.accepted === true;
            finish(response, accepted ? input.afterShutdownResponse : undefined);
          },
          () =>
            finish({
              version: 1,
              type: "safe-shutdown",
              requestId: parsed.requestId,
              ok: false,
            }),
        );
        return;
      }
      if (!isDesktopAppActivationRequest(parsed)) {
        pipe(
          requestIdFromUnknown(parsed),
          (requestId) => invalidResponse(requestId, "The desktop app request is invalid."),
          finish,
        );
        return;
      }
      activeRequestId = parsed.requestId;
      void input.handle(parsed).then(finish, () => {
        finish(
          invalidResponse(parsed.requestId, "T3 Code could not process the desktop app request."),
        );
      });
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      sockets.delete(socket);
      if (!responseSent && activeRequestId !== null && !shutdownRequest)
        input.cancel(activeRequestId);
    });
  };

  const listen = (address: string) =>
    new Promise<NodeNet.Server>((resolve, reject) => {
      const server = NodeNet.createServer(handleConnection);
      const onError = (error: Error) => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve(server);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(address);
    });

  // Closing unlinks the original bind path, even if another app replaced it. Bind a staging path first.

  const bindUnix = async (directory: string, mode: "take-over" | "claim-free") => {
    const staging = NodePath.join(directory, `${NodeCrypto.randomBytes(6).toString("hex")}.tmp`);
    const server = await listen(staging);
    try {
      await NodeFSP.chmod(staging, 0o600);
      const inode = await inodeAt(staging);
      if (mode === "take-over") {
        await NodeFSP.rename(staging, input.address);
      } else {
        await NodeFSP.link(staging, input.address);
        await NodeFSP.unlink(staging);
      }
      return { server, inode };
    } catch (error) {
      await closeServer(server);
      throw error;
    }
  };

  let server: NodeNet.Server;
  let inode: number | null = null;
  if (input.directory === null) {
    server = await listen(input.address);
  } else {
    await prepareUnixDirectory({ directory: input.directory, userId: input.userId });
    ({ server, inode } = await bindUnix(input.directory, "take-over"));
  }

  let closed = false;
  const reclaimOnce = async () => {
    // Replacing an existing socket would let two apps trade the path indefinitely.
    if (closed || input.directory === null || (await inodeAt(input.address)) !== null) return;
    if (await prepareUnixDirectory({ directory: input.directory, userId: input.userId })) {
      // Directory watches follow inodes, so recreate the watch after directory replacement.
      watchDirectory(input.directory);
    }
    const next = await bindUnix(input.directory, "claim-free").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") return null;
        throw error;
      },
    );
    if (next === null) return;
    const previous = server;
    ({ server, inode } = next);
    previous.close();
  };
  let pendingReclaim = Promise.resolve();
  const reclaim = () => {
    const run = pendingReclaim.then(reclaimOnce);
    pendingReclaim = run.catch(() => undefined);
    return run;
  };
  let watcher: NodeFS.FSWatcher | null = null;
  const watchDirectory = (directory: string) => {
    watcher?.close();
    watcher = null;
    try {
      watcher = NodeFS.watch(directory, { persistent: false }, () => {
        reclaim().catch(input.onReclaimError);
      });
      watcher.on("error", input.onReclaimError);
    } catch (error) {
      input.onReclaimError(error);
    }
  };
  if (input.directory !== null) {
    watchDirectory(input.directory);
    // Catch a removal that happened before the watcher started.
    reclaim().catch(input.onReclaimError);
  }

  return {
    reclaim,
    close: async () => {
      if (closed) return;
      closed = true;
      // Reclaim can replace the watcher; close it afterward.
      await pendingReclaim;
      watcher?.close();
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      server.removeAllListeners();
      if (inode !== null && (await inodeAt(input.address)) === inode) {
        await NodeFSP.unlink(input.address).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    },
  };
}

export class DesktopAppActivation extends Context.Service<
  DesktopAppActivation,
  {
    readonly start: Effect.Effect<
      void,
      DesktopAppActivationStartError,
      Scope.Scope | DesktopSafeShutdown.DesktopSafeShutdown
    >;
    readonly setRendererReady: (ready: boolean) => Effect.Effect<void>;
    readonly complete: (response: DesktopAppActivationResponse) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopAppActivation") {}

const { logWarning } = makeComponentLogger("desktop-app-activation");

/** @public */
export const make = Effect.gen(function* () {
  const desktopEnvironment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const electronApp = yield* ElectronApp.ElectronApp;
  const path = yield* Path.Path;
  const userId = yield* HostProcess.UserId;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const address = resolveDesktopAppControlAddress({
    stateDir: path.resolve(desktopEnvironment.stateDir),
    platform: desktopEnvironment.platform,
    tempDir: NodeOS.tmpdir(),
    userId,
    joinPath: path.join,
  });
  let registeredWebContents: Electron.WebContents | null = null;
  let detachRendererListeners: (() => void) | null = null;

  const broker = new DesktopAppActivationBroker({
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    activate: () => {
      void runPromise(
        desktopWindow.activate.pipe(
          Effect.catchCause((cause) => logWarning("failed to focus the desktop window", { cause })),
        ),
      );
    },
  });

  const clearRegisteredRenderer = () => {
    detachRendererListeners?.();
    detachRendererListeners = null;
    registeredWebContents = null;
    broker.clearRenderer();
  };

  return DesktopAppActivation.of({
    start: Effect.gen(function* () {
      const shutdown = yield* DesktopSafeShutdown.DesktopSafeShutdown;
      const control = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            createDesktopControlSecret(desktopEnvironment.stateDir, desktopEnvironment.platform),
          catch: (cause) => new DesktopAppActivationStartError({ address: address.address, cause }),
        }).pipe(
          Effect.tapError((error) => logWarning("safe shutdown control is unavailable", { error })),
          Effect.option,
        ),
        (control) => (Option.isSome(control) ? Effect.promise(control.value.close) : Effect.void),
      );
      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            startDesktopAppControlServer({
              ...address,
              userId,
              handle: (request) => broker.request(request),
              ...(Option.isSome(control)
                ? {
                    handleShutdown: (request: DesktopSafeShutdownControlRequest) =>
                      handleSafeShutdownControl(control.value.secret, request, (command) =>
                        runPromise(shutdown.execute(command)),
                      ),
                    afterShutdownResponse: () => void runPromise(electronApp.quit),
                  }
                : {}),
              cancel: (requestId) => broker.cancel(requestId),
              onReclaimError: (cause) =>
                void runPromise(
                  logWarning("failed to restore the desktop app control socket", { cause }),
                ),
            }),
          catch: (cause) => new DesktopAppActivationStartError({ address: address.address, cause }),
        }),
        (server) =>
          Effect.promise(() => server.close()).pipe(
            Effect.catchCause((cause) =>
              logWarning("failed to close the desktop app control socket", { cause }),
            ),
            Effect.ensuring(Effect.sync(() => broker.close())),
          ),
      );
      if (Option.isSome(control)) {
        yield* Effect.tryPromise({
          try: control.value.publish,
          catch: (cause) => new DesktopAppActivationStartError({ address: address.address, cause }),
        }).pipe(
          Effect.tapError((error) => logWarning("safe shutdown control is unavailable", { error })),
          Effect.ignore,
        );
      }
    }),
    setRendererReady: Effect.fn("DesktopAppActivation.setRendererReady")(function* (ready) {
      if (!ready) {
        clearRegisteredRenderer();
        return;
      }
      const main = yield* electronWindow.main;
      if (Option.isNone(main)) return;
      const webContents = main.value.webContents;
      if (webContents.isDestroyed()) return;

      if (registeredWebContents !== webContents) {
        clearRegisteredRenderer();
        registeredWebContents = webContents;
        const onUnavailable = () => clearRegisteredRenderer();
        const onNavigation = (
          event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
        ) => {
          if (event.isMainFrame && !event.isSameDocument) clearRegisteredRenderer();
        };
        webContents.on("did-start-navigation", onNavigation);
        webContents.once("destroyed", onUnavailable);
        detachRendererListeners = () => {
          webContents.removeListener("did-start-navigation", onNavigation);
          webContents.removeListener("destroyed", onUnavailable);
        };
      }

      broker.registerRenderer((request) => {
        webContents.send(DESKTOP_APP_ACTIVATION_REQUEST_CHANNEL, request);
      });
    }),
    // The IPC handler owns the activation-completion span.
    complete: Effect.fnUntraced(function* (response) {
      return yield* Effect.sync(() => broker.complete(response));
    }),
  });
});

export const layer = Layer.effect(DesktopAppActivation, make);
