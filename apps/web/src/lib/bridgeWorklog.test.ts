import { IssueTrackerKind, ProjectId, type ThreadIssueLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  type ThreadActionMenuState,
} from "../components/threadActionMenu.logic";
import { bridgeIssueForAction, bridgeWorklogUrl } from "./bridgeWorklog";

const issue = (key: string, tracker = "jira"): ThreadIssueLink => ({
  tracker: IssueTrackerKind.make(tracker),
  host: "jira.example.com",
  scope: "EXAMPLE",
  key,
  projectId: ProjectId.make("project"),
  url: `https://jira.example.com/browse/${key}?a=one&b=two`,
  source: "manual",
  linkedAt: "2026-11-26T12:00:00Z",
  displayKey: key,
  title: `Title ${key}`,
});

describe("Bridge worklog", () => {
  it("uses no ticket or the sole Jira ticket, and asks for a choice for several", () => {
    const first = issue("EXAMPLE-123");
    const second = issue("EXAMPLE-456");
    const links = [issue("OTHER-1", "linear"), first, second];
    expect(bridgeIssueForAction([], "settle-bridge")).toBeNull();
    expect(bridgeIssueForAction([first], "settle-bridge")).toBe(first);
    expect(bridgeIssueForAction(links, "settle-bridge")).toBeUndefined();
    expect(bridgeIssueForAction(links, "settle-bridge:1")).toBe(second);
    expect(bridgeIssueForAction(links, "settle-bridge:2")).toBeUndefined();
    const state = {
      canOperate: true,
      isSettled: false,
      issues: links,
      isPinned: false,
      branch: null,
      projectFilter: null,
      autoSettleEnabled: true,
      isSnoozed: false,
      canSnoozeNow: true,
      isRegeneratingTitle: false,
      isRunning: false,
      supports: {
        settlement: true,
        autoSettleOptOut: false,
        snooze: false,
        pinning: false,
        titleRegeneration: false,
      },
      snoozePresets: [],
    } satisfies ThreadActionMenuState;
    const action = buildThreadActionMenuItems(state).find((item) => item.id === "settle-bridge");
    expect(action?.children?.map((item) => [item.id, item.label])).toEqual([
      ["settle-bridge:0", "EXAMPLE-123"],
      ["settle-bridge:1", "EXAMPLE-456"],
    ]);
    expect(
      buildThreadActionMenuItems({ ...state, issues: [first] }).find(
        (item) => item.id === "settle-bridge",
      )?.children,
    ).toBeUndefined();
    expect(
      buildThreadActionMenuItems({ ...state, isSettled: true }).some(
        (item) => item.id === "settle-bridge",
      ),
    ).toBe(false);
  });

  it("encodes the Jira return URL and description without guessing a contract or work time", () => {
    const ticket = issue("EXAMPLE-123");
    const url = new URL(
      bridgeWorklogUrl({
        issue: ticket,
        title: "Fix & test / café\nnext",
        now: new Date(2026, 10, 26, 23, 30),
      }),
    );
    expect(url.origin + url.pathname).toBe("https://bridge.hosted-tools.com/worklogs/calendar/add");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      key: "EXAMPLE-123",
      returnUrl: ticket.url,
      dates: "2026-11-26",
      description: "Fix & test / café next",
    });
    const blank = new URL(
      bridgeWorklogUrl({ issue: null, title: " ", now: new Date(2026, 10, 26) }),
    );
    expect(Object.fromEntries(blank.searchParams)).toEqual({ dates: "2026-11-26" });
    const unsafe = new URL(
      bridgeWorklogUrl({
        issue: { ...ticket, url: "javascript:alert(1)" },
        title: "Task",
        now: new Date(2026, 10, 26),
      }),
    );
    expect(unsafe.searchParams.has("returnUrl")).toBe(false);
  });
});
