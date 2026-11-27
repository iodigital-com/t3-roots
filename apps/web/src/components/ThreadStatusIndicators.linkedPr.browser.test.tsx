import { EnvironmentId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { makeThreadFixture } from "../test-fixtures";
import { ThreadPullRequestBadgeControl, ThreadRowLeadingStatus } from "./ThreadStatusIndicators";
import { ComposerControl } from "./chat/ComposerControl";

const environmentId = EnvironmentId.make("environment-test");

vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useProject: () => null,
  useServerConfigs: (() =>
    new Map([
      [environmentId, { environment: { capabilities: { threadPullRequests: true } } }],
    ])) as never,
}));

it("updates palette PR status from linked snapshots without a legacy link or branch PR", async () => {
  const link: ThreadPullRequestLink = {
    host: "github.com",
    repository: "example/repo",
    number: 7,
    url: "https://github.com/example/repo/pull/7",
    source: "manual",
    linkedAt: "2026-01-01T00:00:00Z",
    stack: null,
    snapshot: {
      state: "merged",
      title: "Linked change",
      headBranch: "deleted-branch",
      baseBranch: "main",
      isDraft: false,
      updatedAt: null,
      syncedAt: "2026-01-03T00:00:00Z",
    },
  };
  const row = (pullRequest: ThreadPullRequestLink) => (
    <AppAtomRegistryProvider>
      <ThreadRowLeadingStatus
        thread={makeThreadFixture({
          environmentId,
          linkedPullRequest: null,
          branchPullRequest: null,
          pullRequests: [pullRequest],
        })}
      />
    </AppAtomRegistryProvider>
  );
  await using screen = await render(row(link));
  await expect.element(screen.getByLabelText("PR #7 - Merged: Linked change")).toBeVisible();
  await expect.element(screen.getByLabelText("PR #7, status pending")).not.toBeInTheDocument();

  await screen.rerender(row({ ...link, snapshot: null }));
  await expect.element(screen.getByLabelText("PR #7, status pending")).toBeVisible();
  await expect
    .element(screen.getByLabelText("PR #7 - Merged: Linked change"))
    .not.toBeInTheDocument();

  await screen.rerender(
    row({ ...link, snapshot: { ...link.snapshot!, state: "open", isDraft: true } }),
  );
  await expect.element(screen.getByLabelText("PR #7 - Draft: Linked change")).toBeVisible();
  await expect.element(screen.getByLabelText("PR #7, status pending")).not.toBeInTheDocument();
});

it("opens an unlinked branch request while retaining the linked-request list", async () => {
  const links: ThreadPullRequestLink[] = [1, 2].map((number) => ({
    host: "github.com",
    repository: "example/repo",
    number,
    url: `https://github.com/example/repo/pull/${number}`,
    source: "manual",
    linkedAt: "2026-01-01T00:00:00Z",
    snapshot: null,
    stack: null,
  }));
  const opened: string[] = [];
  let lists = 0;
  await using screen = await render(
    <AppAtomRegistryProvider>
      <ThreadPullRequestBadgeControl
        render={<ComposerControl size="xs" />}
        badge={{ kind: "pull-request", others: 1, state: "open" }}
        pullRequests={links}
        number={3}
        url="https://github.com/example/repo/pull/3"
        status={null}
        onOpenList={() => {
          lists += 1;
        }}
        onOpenPullRequest={(event, url) => {
          event.preventDefault();
          opened.push(url ?? "");
        }}
      />
    </AppAtomRegistryProvider>,
  );
  await userEvent.click(screen.getByRole("link", { name: "PR #3, status pending" }));
  expect(opened).toEqual(["https://github.com/example/repo/pull/3"]);
  expect(lists).toBe(0);
  await userEvent.click(screen.getByRole("button", { name: /PR #.*more linked/ }));
  expect(lists).toBe(1);
  expect(links.map((link) => link.number)).toEqual([1, 2]);
});
