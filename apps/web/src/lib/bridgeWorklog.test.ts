import {
  IssueTrackerKind,
  ProjectId,
  type OrchestrationV2ThreadTranscript,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  bridgeIssues,
  bridgeWorklogUrl,
  openBridgeWorklog,
  reserveBridgeDestination,
} from "./bridgeWorklog";

// The transcript is the response of the native threadTranscript read command.
function transcript(...items: Array<{ type: string; text?: string; output?: string }>) {
  return { items: items.map((item) => ({ item })) } as unknown as OrchestrationV2ThreadTranscript;
}
function linked(key: string, tracker = "jira"): ThreadIssueLink {
  return {
    tracker: IssueTrackerKind.make(tracker),
    host: "jira.hosted-tools.com",
    scope: "EXAMPLE",
    key,
    projectId: ProjectId.make("project"),
    url: `https://jira.hosted-tools.com/browse/${key}`,
    source: "manual",
    linkedAt: "2026-11-26T12:00:00Z",
    displayKey: key,
    title: "Issue",
  };
}

describe("Bridge ticket discovery", () => {
  it("reads user and assistant messages, combines linked issues, and ignores tool output and unrelated URLs", () => {
    const history = transcript(
      {
        type: "user_message",
        text: "Fix EXAMPLE_ONE-123: https://jira.hosted-tools.com/browse/EXAMPLE_ONE-123 and https://github.com/org/repo/issues/IGNORE-900",
      },
      {
        type: "assistant_message",
        text: "See [board](https://jira.hosted-tools.com/secure/RapidBoard.jspa?rapidView=1&selectedIssue=OTHER-42). Also EXAMPLE_ONE-123.",
      },
      { type: "command_execution", output: "TOOL-999", text: "TOOL-999" },
    );
    expect(bridgeIssues([linked("EXAMPLE_ONE-123"), linked("LIN-4", "linear")], history)).toEqual([
      { key: "EXAMPLE_ONE-123", url: "https://jira.hosted-tools.com/browse/EXAMPLE_ONE-123" },
      {
        key: "OTHER-42",
        url: "https://jira.hosted-tools.com/secure/RapidBoard.jspa?rapidView=1&selectedIssue=OTHER-42",
      },
    ]);
    expect(
      bridgeIssues(undefined, transcript({ type: "user_message", text: "Work on EXAMPLE_2-7" })),
    ).toEqual([{ key: "EXAMPLE_2-7", url: "https://jira.hosted-tools.com/browse/EXAMPLE_2-7" }]);
  });

  it("does not treat other sites, lookalike hosts, or insecure URLs as hosted Jira", () => {
    const history = transcript({
      type: "user_message",
      text: "https://example.org/browse/OTHER-10 https://jira.hosted-tools.com.evil.test/browse/OTHER-11 http://jira.hosted-tools.com/browse/OTHER-12 https://example.org/board?selectedIssue=OTHER-13 example.org/board?selectedIssue=OTHER-15 example.org?selectedIssue=OTHER-16 example.org:8080/board?selectedIssue=OTHER-17 user@jira.hosted-tools.com/browse/OTHER-18 https://user@jira.hosted-tools.com/browse/OTHER-19 ftp://jira.hosted-tools.com/browse/OTHER-20 example.org:invalid/board?selectedIssue=OTHER-21 localhost:3000/issues?ticket=OTHER-22 local-machine:9000/issues?ticket=OTHER-23",
    });
    const external = { ...linked("OTHER-14"), url: "https://example.org/browse/OTHER-14" };
    expect(bridgeIssues([external], history)).toEqual([]);
    expect(
      bridgeIssues(
        undefined,
        transcript({ type: "user_message", text: "jira.hosted-tools.com/browse/EXAMPLE-123" }),
      ),
    ).toEqual([{ key: "EXAMPLE-123", url: "https://jira.hosted-tools.com/browse/EXAMPLE-123" }]);
  });

  it("encodes the selected ticket and title without inventing contract or human time", () => {
    const ticket = {
      key: "EXAMPLE-123",
      url: "https://jira.example.com/browse/EXAMPLE-123?a=one&b=two",
    };
    const url = new URL(
      bridgeWorklogUrl({
        issue: ticket,
        title: "Fix & test / café\nnext",
        now: new Date(2026, 10, 26, 23, 30),
      }),
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      key: ticket.key,
      returnUrl: ticket.url,
      dates: "2026-11-26",
      description: "Fix & test / café next",
    });
    const blank = new URL(
      bridgeWorklogUrl({ issue: null, title: " ", now: new Date(2026, 10, 26) }),
    );
    expect(Object.fromEntries(blank.searchParams)).toEqual({ dates: "2026-11-26" });
  });
});

describe("opening Bridge", () => {
  const setup = (history: OrchestrationV2ThreadTranscript) => {
    const events: string[] = [];
    const open = vi.fn(async (_url: string) => {
      events.push("open");
    });
    const close = vi.fn(() => {
      events.push("close");
    });
    const load = vi.fn(async () => {
      events.push("load");
      return history;
    });
    const choose = vi.fn(
      async (issues: Readonly<ReturnType<typeof bridgeIssues>>) => issues[1] ?? null,
    );
    const run = () =>
      openBridgeWorklog({
        reserve: () => {
          events.push("reserve");
          return { open, close };
        },
        load,
        choose,
        canProceed: () => true,
        links: undefined,
        title: "Work",
        now: () => new Date(2026, 10, 26),
      });
    return { events, open, close, load, choose, run };
  };

  it("reserves before reading, chooses only among multiple tickets, and opens the chosen ticket", async () => {
    const state = setup(transcript({ type: "user_message", text: "EXAMPLE-1 and EXAMPLE-2" }));
    expect(await state.run()).toBe(true);
    expect(state.events).toEqual(["reserve", "load", "open"]);
    expect(state.choose).toHaveBeenCalledOnce();
    expect(new URL(state.open.mock.calls[0]![0]).searchParams.get("key")).toBe("EXAMPLE-2");
    expect(state.close).not.toHaveBeenCalled();
    const single = setup(transcript({ type: "user_message", text: "EXAMPLE-1" }));
    expect(await single.run()).toBe(true);
    expect(single.choose).not.toHaveBeenCalled();
    expect(new URL(single.open.mock.calls[0]![0]).searchParams.get("key")).toBe("EXAMPLE-1");
  });

  it("closes the reserved tab on cancellation or an inaccessible transcript", async () => {
    const cancelled = setup(transcript({ type: "user_message", text: "EXAMPLE-1 EXAMPLE-2" }));
    cancelled.choose.mockResolvedValueOnce(null);
    expect(await cancelled.run()).toBe(false);
    expect(cancelled.events).toEqual(["reserve", "load", "close"]);
    const denied = setup(transcript());
    denied.load.mockRejectedValueOnce(new Error("no access"));
    await expect(denied.run()).rejects.toThrow("no access");
    expect(denied.events).toEqual(["reserve", "close"]);
  });

  it("detects blocked tabs before reading and propagates desktop open failures", async () => {
    const load = vi.fn(async () => transcript());
    const blocked = { open: () => null } as unknown as Window;
    await expect(
      openBridgeWorklog({
        reserve: () => reserveBridgeDestination(blocked, async () => {}),
        load,
        choose: async () => null,
        canProceed: () => true,
        links: undefined,
        title: "Work",
        now: () => new Date(2026, 10, 26),
      }),
    ).rejects.toThrow("blocked");
    expect(load).not.toHaveBeenCalled();
    const desktop = { desktopBridge: {} } as unknown as Window;
    await expect(
      openBridgeWorklog({
        reserve: () =>
          reserveBridgeDestination(desktop, async () => {
            throw new Error("desktop failed");
          }),
        load,
        choose: async () => null,
        canProceed: () => true,
        links: undefined,
        title: "Work",
        now: () => new Date(2026, 10, 26),
      }),
    ).rejects.toThrow("desktop failed");
  });

  it("severs the opener, suppresses referrers, and navigates the checked tab", async () => {
    const meta = { name: "", content: "" };
    const appendChild = vi.fn();
    const link = { href: "", rel: "", target: "", click: vi.fn() };
    const tab = {
      opener: {},
      closed: false,
      close: vi.fn(),
      focus: vi.fn(),
      document: {
        createElement: (name: string) => (name === "meta" ? meta : link),
        head: { appendChild },
        body: { appendChild },
      },
    };
    const browser = { open: vi.fn(() => tab), focus: vi.fn() } as unknown as Window;
    const destination = reserveBridgeDestination(browser, async () => {});
    expect(tab.opener).toBeNull();
    expect(meta).toEqual({ name: "referrer", content: "no-referrer" });
    expect(appendChild).toHaveBeenCalledWith(meta);
    await destination.open("https://bridge.hosted-tools.com/worklogs/calendar/add");
    expect(link).toMatchObject({
      href: "https://bridge.hosted-tools.com/worklogs/calendar/add",
      rel: "noreferrer",
      target: "_self",
    });
    expect(link.click).toHaveBeenCalledOnce();
  });
});
