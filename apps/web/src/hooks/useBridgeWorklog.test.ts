import {
  EnvironmentId,
  EnvironmentAuthInvalidError,
  EnvironmentRequestInvalidError,
  IssueTrackerKind,
  ProjectId,
  ThreadId,
  type LocalApi,
  type OrchestrationV2ThreadTranscript,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../state/orchestration", () => ({
  orchestrationEnvironment: { threadTranscript: "transcript" },
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => state.load }));
vi.mock("../state/session", () => ({ readEnvironmentScope: () => true }));

import { useBridgeWorklog } from "./useBridgeWorklog";

const linked = (key: string): ThreadIssueLink => ({
  tracker: IssueTrackerKind.make("jira"),
  host: "jira.hosted-tools.com",
  scope: "EXAMPLE",
  key,
  projectId: ProjectId.make("project"),
  url: `https://jira.hosted-tools.com/browse/${key}`,
  source: "manual",
  linkedAt: "2026-11-26T12:00:00Z",
  displayKey: key,
  title: "Issue",
});

it("reads the selected thread through the scoped transcript command before opening Bridge", async () => {
  const history = {
    items: [
      {
        item: {
          type: "user_message",
          text: "Please fix https://jira.hosted-tools.com/browse/EXAMPLE-123",
        },
      },
    ],
  } as unknown as OrchestrationV2ThreadTranscript;
  state.load.mockReset().mockResolvedValue(AsyncResult.success(history));
  const openExternal = vi.fn(async (_url: string) => {});
  vi.stubGlobal("window", { desktopBridge: {} });
  try {
    const threadRef = {
      environmentId: EnvironmentId.make("remote"),
      threadId: ThreadId.make("unloaded-thread"),
    };
    const api = { shell: { openExternal }, contextMenu: { show: vi.fn() } } as unknown as LocalApi;
    const open = useBridgeWorklog();
    expect(
      await open({ api, threadRef, title: "Fix", links: undefined, position: { x: 5, y: 5 } }),
    ).toBe(true);
    expect(state.load).toHaveBeenCalledExactlyOnceWith({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    expect(new URL(openExternal.mock.calls[0]![0]).searchParams.get("key")).toBe("EXAMPLE-123");
    expect(api.contextMenu.show).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("uses linked tickets when the transcript is too large and still asks when several are linked", async () => {
  const oversized = new EnvironmentRequestInvalidError({
    code: "invalid_request",
    reason: "thread_transcript_too_large",
    traceId: "trace",
  });
  state.load.mockReset().mockResolvedValue(AsyncResult.failure(Cause.fail(oversized)));
  const openExternal = vi.fn(async (_url: string) => {});
  const show = vi.fn(async () => "1");
  vi.stubGlobal("window", { desktopBridge: {} });
  try {
    const threadRef = {
      environmentId: EnvironmentId.make("remote"),
      threadId: ThreadId.make("thread"),
    };
    const api = { shell: { openExternal }, contextMenu: { show } } as unknown as LocalApi;
    const open = useBridgeWorklog();
    expect(
      await open({
        api,
        threadRef,
        title: "Fix",
        links: [linked("EXAMPLE-1"), linked("EXAMPLE-2")],
        position: { x: 5, y: 5 },
      }),
    ).toBe(true);
    expect(show).toHaveBeenCalledOnce();
    expect(new URL(openExternal.mock.calls[0]![0]).searchParams.get("key")).toBe("EXAMPLE-2");
    show.mockClear();
    openExternal.mockClear();
    expect(
      await open({
        api,
        threadRef,
        title: "Fix",
        links: [linked("EXAMPLE-1")],
        position: { x: 5, y: 5 },
      }),
    ).toBe(true);
    expect(show).not.toHaveBeenCalled();
    expect(new URL(openExternal.mock.calls[0]![0]).searchParams.get("key")).toBe("EXAMPLE-1");
    openExternal.mockClear();
    expect(
      await open({ api, threadRef, title: "Fix", links: undefined, position: { x: 5, y: 5 } }),
    ).toBe(true);
    expect(new URL(openExternal.mock.calls[0]![0]).searchParams.has("key")).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("propagates authentication and unrelated request errors rather than opening Bridge", async () => {
  const errors = [
    new EnvironmentAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_credential",
      traceId: "trace",
    }),
    new EnvironmentRequestInvalidError({
      code: "invalid_request",
      reason: "scope_not_granted",
      traceId: "trace",
    }),
    new Error("unexpected"),
  ];
  const openExternal = vi.fn(async (_url: string) => {});
  vi.stubGlobal("window", { desktopBridge: {} });
  try {
    const threadRef = {
      environmentId: EnvironmentId.make("remote"),
      threadId: ThreadId.make("thread"),
    };
    const api = { shell: { openExternal }, contextMenu: { show: vi.fn() } } as unknown as LocalApi;
    const open = useBridgeWorklog();
    for (const error of errors) {
      state.load.mockReset().mockResolvedValue(AsyncResult.failure(Cause.fail(error)));
      await expect(
        open({
          api,
          threadRef,
          title: "Fix",
          links: [linked("EXAMPLE-1")],
          position: { x: 5, y: 5 },
        }),
      ).rejects.toBe(error);
    }
    expect(openExternal).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
