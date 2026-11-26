import { makeThreadPullRequests } from "@t3tools/source-control-core/shared/threadPullRequests";

import { sourceControlClients } from "./sourceControlClients.ts";
import type { ThreadPullRequestLink } from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";

export {
  threadPullRequestSearchTerms,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
export {
  pullRequestListLines,
  type PullRequestListLine,
  type ThreadCurrentPullRequest,
  type ThreadPullRequestBadge,
  type ThreadPullRequestChain,
} from "@t3tools/source-control-core/shared/threadPullRequests";

export const {
  normalizeThreadPullRequestKey,
  legacyThreadPullRequestKey,
  threadPullRequestKeysEqual,
  threadPullRequestKeyOf,
  resolveThreadCurrentPullRequest,
  resolveThreadCurrentPullRequestLink,
  resolveThreadPullRequestChains,
  resolveThreadPullRequestBadge,
  threadPullRequestsOf,
  applyThreadPullRequestLinkUpdate,
} = makeThreadPullRequests(sourceControlClients);

export function resolveThreadCurrentPullRequestLinkForBranch(
  links: ReadonlyArray<ThreadPullRequestLink>,
  url: string | null,
): ThreadPullRequestLink | null {
  if (url === null) return resolveThreadCurrentPullRequestLink(links);
  const branch = sourceControlClients.parseChangeRequestUrl(url)?.link;
  if (branch === undefined) return null;
  return (
    visibleThreadPullRequests(links).find((link) => threadPullRequestKeysEqual(link, branch)) ??
    null
  );
}
