import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  ThreadId,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { Atom, AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { useRightPanelStore } from "../../rightPanelStore";
import { makeThreadFixture } from "../../test-fixtures";
import { SortableThreadRow } from "./SidebarThreadRow";
import { ThreadRowLeadingStatus } from "../ThreadStatusIndicators";

const state = vi.hoisted(() => ({
  branch: null as unknown,
  status: null as unknown,
  navigate: vi.fn(),
}));
const branchAtom = Atom.make(AsyncResult.initial());
const statusAtom = Atom.make(AsyncResult.initial());
const environmentId = EnvironmentId.make("local");
const project = {
  id: ProjectId.make("project"),
  environmentId,
  title: "Project",
  workspaceRoot: "/repo",
  repositoryIdentity: {
    provider: SourceControlProviderKind.make("github"),
    canonicalKey: "github.com/example/repo",
    displayName: "example/repo",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/example/repo.git",
    },
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
} as const;

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: () => state.navigate,
}));
vi.mock(import("../../state/vcs"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    vcsEnvironment: {
      ...actual.vcsEnvironment,
      branch: () => branchAtom,
      status: () => statusAtom,
    },
  };
});
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) => ({
    data: atom === branchAtom ? state.branch : atom === statusAtom ? state.status : null,
  })) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useThreadShell: () => null,
  readProjects: () => [project],
  useProjects: () => [project],
  useServerConfigs: (() =>
    new Map([
      [environmentId, { environment: { capabilities: { threadPullRequests: true } } }],
    ])) as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await original()),
    environmentServerConfigsAtom: Atom.make(new Map([["local", {}]])) as never,
  };
});
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => environmentId,
}));
vi.mock(import("../../state/pullRequests"), async (original) => ({
  ...(await original()),
  useSharedPullRequestSummary: ((_env: unknown, reference: { number: number } | null) =>
    reference
      ? {
          provider: "github",
          projectId: project.id,
          repository: "example/repo",
          number: reference.number,
          title: "Old request",
          url: "https://github.com/example/repo/pull/1",
          state: "open",
          headBranch: "a",
          baseBranch: "main",
          updatedAt: null,
        }
      : null) as never,
}));
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../../browser/useOpenLink", () => ({ useOpenLink: () => vi.fn() }));

const pr = (number: number, headRef: string) => ({
  number,
  title: `Request ${number}`,
  url: `https://github.com/example/repo/pull/${number}`,
  baseRef: "main",
  headRef,
  state: "open" as const,
});
const gitStatus = (refName: string, request: VcsStatusResult["pr"]): VcsStatusResult => ({
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: request,
});
const thread = makeThreadFixture({
  id: ThreadId.make("thread"),
  projectId: project.id,
  environmentId,
  branch: "a",
  worktreePath: null,
  linkedPullRequest: null,
  branchPullRequest: {
    projectId: project.id,
    repository: "example/repo",
    number: 1,
    url: pr(1, "a").url,
  },
  pullRequests: [],
});
function setup() {
  state.branch = { isRepo: true, refName: "a" };
  state.status = gitStatus("a", pr(1, "a"));
  state.navigate.mockReset();
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, pullRequestLinksOpenInApp: true });
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
}
function row(onThreadActivate = vi.fn(), rowThread = thread) {
  return (
    <AppAtomRegistryProvider>
      <SortableThreadRow
        thread={rowThread}
        variant="card"
        variantAction="settle"
        settlementSupported={false}
        snoozeSupported={false}
        pinningSupported={false}
        isPinned={false}
        dropVerb={null}
        dragOverPinned={false}
        sweepAction={null}
        snoozeWakeLabelText={null}
        wokeAt={null}
        isActive
        isRouteThread={false}
        readOpensPullRequestsInRightPanel={() => false}
        jumpLabel={null}
        currentEnvironmentId={environmentId}
        environmentLabel={null}
        environmentMachine="server"
        scratchMachineLabel={null}
        project={project}
        projectDisplayName="Project"
        providerEntryByInstanceId={new Map()}
        timestampFormat="locale"
        onThreadClick={() => {}}
        onThreadActivate={onThreadActivate}
        onStartRename={() => {}}
        onRenameTitleChange={() => {}}
        onCommitRename={() => {}}
        onCancelRename={() => {}}
        isRenaming={false}
        renamingTitle=""
        onContextMenu={() => {}}
        onSettle={() => {}}
        onActionSweepStart={() => {}}
        onUnsettle={() => {}}
        onSnooze={() => {}}
        onUnsnooze={() => {}}
        onUnpin={() => {}}
        onAcknowledgeWoke={() => {}}
        sortableId="thread"
        sortableDisabled
        contextDrag={false}
      />
    </AppAtomRegistryProvider>
  );
}

it("follows checkout changes and keeps explicit links", async () => {
  setup();
  await using screen = await render(row());
  await expect.element(screen.getByRole("link", { name: /PR #1/ })).toBeVisible();
  state.branch = { isRepo: true, refName: "b" };
  await screen.rerender(row());
  await expect.element(screen.getByRole("link", { name: /PR #1/ })).not.toBeInTheDocument();
  state.status = gitStatus("b", pr(2, "b"));
  await screen.rerender(row());
  await expect.element(screen.getByRole("link", { name: /PR #2/ })).toBeVisible();
  const linked = {
    host: "github.com",
    repository: "example/repo",
    number: 3,
    url: pr(3, "c").url,
    source: "manual" as const,
    linkedAt: "2026-01-01T00:00:00Z",
    stack: {
      kind: "native" as const,
      id: "stack",
      number: 3,
      url: pr(3, "c").url,
      base: "main",
      layers: [
        { number: 3, headBranch: "c", state: "open" as const },
        { number: 4, headBranch: "d", state: "open" as const },
      ],
    },
    snapshot: {
      state: "open" as const,
      title: "Linked request",
      headBranch: "c",
      baseBranch: "main",
      isDraft: false,
      updatedAt: null,
      syncedAt: "2026-01-01T00:00:00Z",
    },
  };
  const linkedThread = {
    ...thread,
    pullRequests: [
      linked,
      {
        ...linked,
        number: 4,
        url: pr(4, "d").url,
        snapshot: { ...linked.snapshot, headBranch: "d", baseBranch: "c" },
      },
    ],
  };
  await screen.rerender(row(vi.fn(), linkedThread));
  await expect.element(screen.getByRole("link", { name: /PR #2/ })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /stack/i })).toBeVisible();
  state.branch = { isRepo: true, refName: "a" };
  state.status = gitStatus("a", pr(1, "a"));
  await screen.rerender(row(vi.fn(), linkedThread));
  await expect.element(screen.getByRole("link", { name: /PR #1/ })).toBeVisible();
  state.branch = { isRepo: true, refName: "b" };
  await screen.rerender(row(vi.fn(), linkedThread));
  await expect.element(screen.getByRole("link", { name: /PR #1/ })).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: /stack/i })).toBeVisible();
  state.status = gitStatus("b", null);
  await screen.rerender(row());
  await expect.element(screen.getByRole("link", { name: /PR #2/ })).not.toBeInTheDocument();
  await screen.rerender(row(vi.fn(), linkedThread));
  await expect.element(screen.getByRole("button", { name: /stack/i })).toBeVisible();
});

it("opens a single sidebar PR on the pull requests page when no thread is open", async () => {
  setup();
  const activate = vi.fn();
  await using screen = await render(row(activate));
  await userEvent.click(screen.getByRole("link", { name: /PR #1/ }));
  expect(state.navigate).toHaveBeenCalledWith(expect.objectContaining({ to: "/pull-requests" }));
  expect(activate).not.toHaveBeenCalled();
  expect(useRightPanelStore.getState().byThreadKey).toEqual({});
});

it("palette clears the old request while the new branch's full status is delayed", async () => {
  setup();
  const palette = () => (
    <AppAtomRegistryProvider>
      <ThreadRowLeadingStatus thread={{ ...thread, worktreePath: project.workspaceRoot }} />
    </AppAtomRegistryProvider>
  );
  await using screen = await render(palette());
  await expect.element(screen.getByLabelText(/PR #1/)).toBeVisible();
  state.branch = { isRepo: true, refName: "b" };
  await screen.rerender(palette());
  await expect.element(screen.getByLabelText(/PR #1/)).not.toBeInTheDocument();
  state.status = gitStatus("b", pr(2, "b"));
  await screen.rerender(palette());
  await expect.element(screen.getByLabelText(/PR #2/)).toBeVisible();
  state.status = gitStatus("b", null);
  await screen.rerender(palette());
  await expect.element(screen.getByLabelText(/PR #2/)).not.toBeInTheDocument();
});
