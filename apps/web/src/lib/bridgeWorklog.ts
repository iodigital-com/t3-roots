import type { OrchestrationV2ThreadTranscript, ThreadIssueLink } from "@t3tools/contracts";

const BRIDGE_ADD_URL = "https://bridge.hosted-tools.com/worklogs/calendar/add";
const JIRA_ORIGIN = "https://jira.hosted-tools.com";
const KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

export interface BridgeIssue {
  readonly key: string;
  readonly url: string;
}

function issueFromUrl(raw: string): BridgeIssue | null {
  try {
    const url = new URL(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`);
    if (url.origin !== JIRA_ORIGIN || url.username || url.password) return null;
    const key =
      /\/browse\/([A-Z][A-Z0-9_]*-\d+)\/?$/.exec(url.pathname)?.[1] ??
      url.searchParams.get("selectedIssue");
    return key && KEY.test(key) ? { key, url: url.href } : null;
  } catch {
    return null;
  }
}

/** Only conversation messages, not tool results, are evidence of a ticket reference. */
export function bridgeIssues(
  links: ReadonlyArray<ThreadIssueLink> | undefined,
  transcript: Pick<OrchestrationV2ThreadTranscript, "items">,
): BridgeIssue[] {
  const explicit = new Map<string, BridgeIssue>();
  const plainKeys = new Set<string>();
  const add = (issue: BridgeIssue) => {
    const identity = `${new URL(issue.url).origin.toLowerCase()}|${issue.key}`;
    if (!explicit.has(identity)) explicit.set(identity, issue);
  };
  for (const link of links ?? []) {
    if (link.tracker !== "jira" || !KEY.test(link.key)) continue;
    try {
      const url = new URL(link.url);
      if (url.origin === JIRA_ORIGIN && !url.username && !url.password) {
        add({ key: link.key, url: url.href });
      }
    } catch {
      /* An unparseable link cannot identify the hosted Jira instance. */
    }
  }
  for (const { item } of transcript.items) {
    if (item.type !== "user_message" && item.type !== "assistant_message") continue;
    // Remove all URLs before scanning for bare keys, including unrelated URLs.
    const text = item.text.replace(
      /(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|(?:[^\s<>"'/]+@)?(?:(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+|[A-Za-z0-9-]+:[^\s/?#<>"']+)(?::[^\s/?#<>"']+)?[/?#])[^\s<>"']+/gi,
      (raw) => {
        const cleaned = raw.replace(/[)\],.;!?]+$/, "");
        const issue = issueFromUrl(cleaned);
        if (issue) add(issue);
        return " ";
      },
    );
    for (const match of text.matchAll(
      /(?<![A-Za-z0-9_/=?&#])[A-Z][A-Z0-9_]*-\d+(?![A-Za-z0-9_])/g,
    )) {
      plainKeys.add(match[0]);
    }
  }
  const found = [...explicit.values()];
  for (const key of plainKeys) {
    if (!found.some((issue) => issue.key === key)) {
      found.push({ key, url: `${JIRA_ORIGIN}/browse/${key}` });
    }
  }
  return found;
}

export function bridgeWorklogUrl(input: {
  issue: BridgeIssue | null;
  title: string;
  now: Date;
}): string {
  const url = new URL(BRIDGE_ADD_URL);
  if (input.issue) {
    url.searchParams.set("key", input.issue.key);
    url.searchParams.set("returnUrl", input.issue.url);
  }
  const date = input.now;
  url.searchParams.set(
    "dates",
    [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-"),
  );
  const description = input.title.trim().replace(/\s+/g, " ").slice(0, 200);
  if (description) url.searchParams.set("description", description);
  // Thread and agent elapsed times are not a record of human work.
  return url.href;
}

export interface BridgeDestination {
  open: (url: string) => Promise<void>;
  close: () => void;
}

/** Call synchronously from the menu selection, before loading the transcript. */
export function reserveBridgeDestination(
  browser: Window,
  openExternal: (url: string) => Promise<void>,
): BridgeDestination {
  if (browser.desktopBridge) return { open: openExternal, close: () => {} };
  // noopener makes window.open return null even on success. Reserve a handle, then sever the opener.
  const tab = browser.open("about:blank", "_blank");
  if (!tab) throw new Error("The browser blocked the Bridge tab.");
  try {
    tab.opener = null;
    const referrer = tab.document.createElement("meta");
    referrer.name = "referrer";
    referrer.content = "no-referrer";
    tab.document.head.appendChild(referrer);
    browser.focus();
  } catch (error) {
    tab.close();
    throw error;
  }
  return {
    open: async (url) => {
      if (tab.closed) throw new Error("The Bridge tab was closed.");
      const link = tab.document.createElement("a");
      link.href = url;
      link.rel = "noreferrer";
      link.target = "_self";
      tab.document.body.appendChild(link);
      link.click();
      tab.focus();
    },
    close: () => tab.close(),
  };
}

export async function openBridgeWorklog(input: {
  reserve: () => BridgeDestination;
  load: () => Promise<Pick<OrchestrationV2ThreadTranscript, "items">>;
  choose: (issues: ReadonlyArray<BridgeIssue>) => Promise<BridgeIssue | null>;
  canProceed: () => boolean;
  links: ReadonlyArray<ThreadIssueLink> | undefined;
  title: string;
  now: () => Date;
}): Promise<boolean> {
  const destination = input.reserve();
  let opened = false;
  try {
    const issues = bridgeIssues(input.links, await input.load());
    const issue = issues.length > 1 ? await input.choose(issues) : (issues[0] ?? null);
    if (issues.length > 1 && issue === null) return false;
    if (!input.canProceed()) throw new Error("This connection cannot change threads.");
    await destination.open(bridgeWorklogUrl({ issue, title: input.title, now: input.now() }));
    opened = true;
    return true;
  } finally {
    if (!opened) destination.close();
  }
}
