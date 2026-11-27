// @effect-diagnostics nodeBuiltinImport:off -- This adapter test binds a real local socket or Windows named pipe and verifies its cleanup.
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ProjectId,
  ThreadId,
  type DesktopAppActivationRequest,
  type DesktopAppActivationResponse,
  type DesktopSafeShutdownControlRequest,
  type DesktopSafeShutdownControlResponse,
} from "@t3tools/contracts";
import { resolveDesktopAppControlAddress } from "@t3tools/shared/desktopAppControl";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect } from "vite-plus/test";

import {
  createDesktopControlSecret,
  handleSafeShutdownControl,
  startDesktopAppControlServer,
} from "./DesktopAppActivation.ts";

const openServers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

function makeTarget(stateDir: string, platform: NodeJS.Platform, userId: number | undefined) {
  return resolveDesktopAppControlAddress({
    stateDir,
    platform,
    tempDir: NodeOS.tmpdir(),
    userId,
    joinPath: NodePath.join,
  });
}

function request(requestId: string, platform: NodeJS.Platform): DesktopAppActivationRequest {
  return {
    version: 1,
    requestId,
    type: "open-workspace",
    workspaceRoot: NodePath.join(NodeOS.tmpdir(), "project"),
    platform: platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux",
  };
}

function startOkServer(target: ReturnType<typeof makeTarget>, userId: number | undefined) {
  return startDesktopAppControlServer({
    ...target,
    userId,
    handle: async (input) => ({
      version: 1,
      requestId: input.requestId,
      ok: true,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
    }),
    cancel: () => undefined,
    onReclaimError: () => undefined,
  }).then((server) => {
    openServers.push(server);
    return server;
  });
}

function exchange(address: string, payload: DesktopAppActivationRequest) {
  return new Promise<DesktopAppActivationResponse>((resolve, reject) => {
    const socket = NodeNet.createConnection(address);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)) as DesktopAppActivationResponse);
    });
  });
}

function exchangeShutdown(address: string, payload: DesktopSafeShutdownControlRequest) {
  return new Promise<DesktopSafeShutdownControlResponse>((resolve, reject) => {
    const socket = NodeNet.createConnection(address);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)) as DesktopSafeShutdownControlResponse);
    });
  });
}

describe("desktop app control server", () => {
  it.effect("a second Windows server cannot impersonate the active control pipe", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const userId = yield* HostProcess.UserId;
      if (platform !== "win32") return;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-pipe-test-"));
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        const firstControl = await createDesktopControlSecret(root, platform);
        const first = await startOkServer(target, userId);
        await firstControl.publish();
        const reference = await NodeFSP.readFile(
          NodePath.join(root, "desktop-safe-shutdown.ref"),
          "utf8",
        );
        const secondControl = await createDesktopControlSecret(root, platform);
        await expect(startOkServer(target, userId)).rejects.toMatchObject({ code: "EADDRINUSE" });
        await secondControl.close();
        expect(
          await NodeFSP.readFile(NodePath.join(root, "desktop-safe-shutdown.ref"), "utf8"),
        ).toBe(reference);
        await first.close();
        await firstControl.close();
        openServers.splice(openServers.indexOf(first), 1);
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );
  it.effect("keeps the per-run control secret private and removes its own files", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const env = yield* HostProcess.Environment;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-secret-test-"));
        const control = await createDesktopControlSecret(root, platform);
        await control.publish();
        const name = await NodeFSP.readFile(
          NodePath.join(root, "desktop-safe-shutdown.ref"),
          "utf8",
        );
        expect(name).toMatch(/^desktop-safe-shutdown-[a-f0-9]{32}$/);
        const directory = NodePath.join(root, name);
        expect(await NodeFSP.readFile(NodePath.join(directory, "key"), "utf8")).toBe(
          control.secret,
        );
        if (platform === "win32") {
          const powershell = NodePath.join(
            env.SystemRoot ?? "C:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
          );
          const script =
            "$a=Get-Acl -LiteralPath $env:T3_TEST_DIRECTORY; $k=Get-Acl -LiteralPath (Join-Path $env:T3_TEST_DIRECTORY 'key'); $s=[Security.Principal.WindowsIdentity]::GetCurrent().User; $r=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); $kr=@($k.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); [string]($a.AreAccessRulesProtected -and $a.GetOwner([Security.Principal.SecurityIdentifier]) -eq $s -and $r.Count -eq 1 -and $r[0].IdentityReference -eq $s -and $r[0].AccessControlType -eq 'Allow' -and $kr.Count -eq 1 -and $kr[0].IdentityReference -eq $s -and $kr[0].AccessControlType -eq 'Allow')";
          expect(
            NodeChildProcess.execFileSync(
              powershell,
              ["-NoProfile", "-NonInteractive", "-Command", script],
              {
                env: { ...env, T3_TEST_DIRECTORY: directory },
                encoding: "utf8",
                windowsHide: true,
              },
            ).trim(),
          ).toBe("True");
        } else {
          expect((await NodeFSP.stat(directory)).mode & 0o077).toBe(0);
          expect((await NodeFSP.stat(NodePath.join(directory, "key"))).mode & 0o077).toBe(0);
        }
        await control.close();
        await expect(NodeFSP.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          NodeFSP.stat(NodePath.join(root, "desktop-safe-shutdown.ref")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );
  it.effect("authenticates shutdown requests before dispatching them", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const userId = yield* HostProcess.UserId;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-safe-control-"));
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        let dispatched = 0;
        const server = await startDesktopAppControlServer({
          ...target,
          userId,
          handle: async () => {
            throw new Error("unexpected activation");
          },
          handleShutdown: (input) =>
            handleSafeShutdownControl("secret", input, async () => {
              dispatched++;
              return { type: "capabilities", version: 1 };
            }),
          cancel: () => undefined,
          onReclaimError: () => undefined,
        });
        openServers.push(server);
        const base = {
          version: 1 as const,
          type: "safe-shutdown" as const,
          requestId: "request",
          command: { type: "capabilities" as const },
        };
        expect(await exchangeShutdown(target.address, { ...base, secret: "wrong" })).toMatchObject({
          ok: false,
        });
        expect(dispatched).toBe(0);
        expect(await exchangeShutdown(target.address, { ...base, secret: "secret" })).toMatchObject(
          { ok: true, result: { version: 1 } },
        );
        expect(dispatched).toBe(1);
        await server.close();
        openServers.splice(openServers.indexOf(server), 1);
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );
  it.effect("cancels a queued request when the client disconnects", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const userId = yield* HostProcess.UserId;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-cancel-test-"));
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        let resolveCanceled: (requestId: string) => void = () => undefined;
        const canceled = new Promise<string>((resolve) => {
          resolveCanceled = resolve;
        });
        const server = await startDesktopAppControlServer({
          ...target,
          userId,
          handle: () => new Promise(() => undefined),
          cancel: resolveCanceled,
          onReclaimError: () => undefined,
        });
        openServers.push(server);
        const socket = NodeNet.createConnection(target.address);
        await new Promise<void>((resolve, reject) => {
          socket.once("error", reject);
          socket.once("connect", () => {
            socket.write(`${JSON.stringify(request("request-canceled", platform))}\n`, () => {
              socket.destroy();
              resolve();
            });
          });
        });

        await expect(canceled).resolves.toBe("request-canceled");
        await server.close();
        openServers.splice(openServers.indexOf(server), 1);
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );

  it.effect("a committed quit still runs if its client disconnects before the reply", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const userId = yield* HostProcess.UserId;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-quit-test-"));
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        let received: () => void = () => undefined;
        let complete: () => void = () => undefined;
        let release: () => void = () => undefined;
        const requestReceived = new Promise<void>((resolve) => {
          received = resolve;
        });
        const replyAllowed = new Promise<void>((resolve) => {
          release = resolve;
        });
        const quit = new Promise<void>((resolve) => {
          complete = resolve;
        });
        let quits = 0;
        const server = await startDesktopAppControlServer({
          ...target,
          userId,
          handle: async () => {
            throw new Error("unexpected activation");
          },
          handleShutdown: (request) =>
            handleSafeShutdownControl("secret", request, async () => {
              received();
              await replyAllowed;
              return { type: "quit", accepted: true };
            }),
          afterShutdownResponse: () => {
            quits++;
            complete();
          },
          cancel: () => undefined,
          onReclaimError: () => undefined,
        });
        openServers.push(server);
        const socket = NodeNet.createConnection(target.address);
        socket.once("error", () => undefined);
        await new Promise<void>((resolve) => socket.once("connect", resolve));
        socket.write(
          `${JSON.stringify({ version: 1, type: "safe-shutdown", requestId: "quit", secret: "secret", command: { type: "quit", leaseId: "lease" } })}\n`,
        );
        await requestReceived;
        socket.destroy();
        release();
        await quit;
        expect(quits).toBe(1);
        await server.close();
        openServers.splice(openServers.indexOf(server), 1);
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );

  it.effect("keeps a newer app's socket when an older app on the same state dir quits", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const userId = yield* HostProcess.UserId;
      if (platform === "win32") return;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-takeover-test-"));
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        const older = await startOkServer(target, userId);
        await startOkServer(target, userId);

        await older.close();

        await expect(
          exchange(target.address, request("after-quit", platform)),
        ).resolves.toMatchObject({ ok: true, requestId: "after-quit" });
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );

  it.effect("binds its address again after the socket file is removed", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const userId = yield* HostProcess.UserId;
      if (platform === "win32") return;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-reclaim-test-"));
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        const server = await startOkServer(target, userId);

        await NodeFSP.unlink(target.address);
        await server.reclaim();

        await expect(
          exchange(target.address, request("reclaimed", platform)),
        ).resolves.toMatchObject({
          ok: true,
          requestId: "reclaimed",
        });
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );
});
