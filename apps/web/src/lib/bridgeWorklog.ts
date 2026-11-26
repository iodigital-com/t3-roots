import type { ThreadIssueLink } from "@t3tools/contracts";

const BRIDGE_ADD_URL = "https://bridge.hosted-tools.com/worklogs/calendar/add";

export function jiraIssues(issues: ReadonlyArray<ThreadIssueLink> | undefined) {
  return (issues ?? []).filter((issue) => issue.tracker === "jira");
}

// The index belongs to the menu snapshot, so a selection never silently changes tickets.
export function bridgeIssueForAction(
  issues: ReadonlyArray<ThreadIssueLink> | undefined,
  action: string,
): ThreadIssueLink | null | undefined {
  const candidates = jiraIssues(issues);
  if (action === "settle-bridge") {
    return candidates.length === 0 ? null : candidates.length === 1 ? candidates[0] : undefined;
  }
  const match = /^settle-bridge:(\d+)$/.exec(action);
  return match ? candidates[Number(match[1])] : undefined;
}

export function bridgeWorklogUrl(input: {
  issue: ThreadIssueLink | null;
  title: string;
  now: Date;
}): string {
  const url = new URL(BRIDGE_ADD_URL);
  if (input.issue) {
    url.searchParams.set("key", input.issue.key);
    try {
      const returnUrl = new URL(input.issue.url);
      if (returnUrl.protocol === "https:" || returnUrl.protocol === "http:") {
        url.searchParams.set("returnUrl", returnUrl.href);
      }
    } catch {
      // The Jira key is still useful if the linked URL cannot be opened.
    }
  }
  const date = input.now;
  const localDate = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  url.searchParams.set("dates", localDate);
  const description = input.title.trim().replace(/\s+/g, " ").slice(0, 200);
  if (description) url.searchParams.set("description", description);
  // Thread and agent elapsed times are not a record of human work.
  return url.href;
}
