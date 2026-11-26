import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentThreadShell, ThreadStructure } from "@t3tools/client-runtime/state/shell";
import { collectThreadSpend, threadSpendNode, type SpendNode } from "./threadSpend.logic";

const node = (
  amount: number | null,
  children: SpendNode["children"] = [],
  extra: Partial<SpendNode> = {},
): SpendNode => ({
  label: "agent",
  cost: amount === null ? null : { amount, currency: "USD" },
  complete: true,
  unknownChildren: false,
  children,
  ...extra,
});

describe("thread spend", () => {
  it("discovers recorded remote children and native child shells but excludes forks", () => {
    const env = EnvironmentId.make("local");
    const remoteEnv = EnvironmentId.make("remote");
    const root = ThreadId.make("root");
    const child = ThreadId.make("native");
    const remote = ThreadId.make("remote-child");
    const projection = {
      thread: { id: root, title: "Root", activeProviderThreadId: "session" },
      providerThreads: [
        {
          id: "session",
          appThreadId: root,
          forkedFrom: null,
          contextUsage: { cost: { amount: 1, currency: "USD" } },
        },
      ],
      providerTurns: [],
      subagents: [
        { remoteChild: { environmentId: remoteEnv, threadId: remote }, origin: "app_owned" },
      ],
    } as unknown as ThreadStructure;
    const shells = [
      {
        environmentId: env,
        id: child,
        lineage: { relationshipToParent: "subagent", parentThreadId: root },
        source: { creationSource: "provider" },
      },
      {
        environmentId: env,
        id: ThreadId.make("fork"),
        lineage: { relationshipToParent: "fork", parentThreadId: root },
        source: { creationSource: "user" },
      },
    ] as unknown as EnvironmentThreadShell[];
    const result = threadSpendNode({ environmentId: env, threadId: root }, projection, shells);
    expect(result.children).toEqual([
      { key: threadKey({ environmentId: remoteEnv, threadId: remote }), native: false },
      { key: threadKey({ environmentId: env, threadId: child }), native: true },
    ]);
    expect(result.cost).toEqual({ amount: 1, currency: "USD" });
    const forked = {
      ...projection,
      providerThreads: [
        { ...projection.providerThreads[0]!, forkedFrom: { providerThreadId: "earlier" } },
      ],
    } as unknown as ThreadStructure;
    expect(threadSpendNode({ environmentId: env, threadId: root }, forked, shells)).toMatchObject({
      cost: null,
      complete: false,
    });
  });

  it("counts an app-owned hierarchy once, including a remote child, and ignores independent threads", () => {
    const nodes: Record<string, SpendNode> = {
      root: node(1, [
        { key: "local", native: false },
        { key: "remote", native: false },
      ]),
      local: node(2, [
        { key: "remote", native: false },
        { key: "root", native: false },
      ]),
      remote: node(3),
      independent: node(100),
    };
    expect(collectThreadSpend("root", (key) => nodes[key] ?? null)).toMatchObject({
      totals: [{ currency: "USD", amount: 6 }],
      complete: true,
    });
  });

  it("shows a native session without a child thread without adding an overlapping cost", () => {
    const ref = { environmentId: EnvironmentId.make("local"), threadId: ThreadId.make("root") };
    const projection = {
      thread: { id: ref.threadId, title: "Root", activeProviderThreadId: "main" },
      providerThreads: [
        {
          id: "main",
          appThreadId: ref.threadId,
          forkedFrom: null,
          contextUsage: { cost: { amount: 2, currency: "USD" } },
        },
        { id: "native", appThreadId: null, contextUsage: { cost: { amount: 1, currency: "USD" } } },
      ],
      providerTurns: [],
      subagents: [
        {
          id: "agent",
          origin: "provider_native",
          childThreadId: null,
          providerThreadId: "native",
          title: "Review",
        },
      ],
    } as unknown as ThreadStructure;
    const result = collectThreadSpend("root", () => threadSpendNode(ref, projection, []));
    expect(result.totals).toEqual([{ currency: "USD", amount: 2 }]);
    expect(result.rows[1]).toMatchObject({
      label: "Review",
      cost: { amount: 1, currency: "USD" },
      native: true,
    });
    expect(result.complete).toBe(false);
  });

  it("keeps the known main cost when a child is missing or has no cost", () => {
    for (const child of [null, node(null)]) {
      const result = collectThreadSpend("root", (key) =>
        key === "root" ? node(1, [{ key: "child", native: false }]) : child,
      );
      expect(result.totals).toEqual([{ currency: "USD", amount: 1 }]);
      expect(result.complete).toBe(false);
    }
  });

  it("does not add native child snapshots that may already be in the parent ledger", () => {
    const nodes: Record<string, SpendNode> = {
      root: node(3, [
        { key: "child", native: true },
        { key: "other", native: false },
      ]),
      other: node(1, [{ key: "child", native: false }]),
      child: node(2),
    };
    const result = collectThreadSpend("root", (key) => nodes[key] ?? null);
    expect(result.totals).toEqual([{ currency: "USD", amount: 4 }]);
    expect(result.rows.find((row) => row.key === "child")?.native).toBe(true);
    expect(result.complete).toBe(false);
  });

  it("counts the same provider ledger only once even when linked through two threads", () => {
    const nodes: Record<string, SpendNode> = {
      root: node(3, [{ key: "child", native: false }], { costIdentity: "same-session" }),
      child: node(3, [], { costIdentity: "same-session" }),
    };
    const result = collectThreadSpend("root", (key) => nodes[key] ?? null);
    expect(result.totals).toEqual([{ currency: "USD", amount: 3 }]);
    expect(result.rows.find((row) => row.key === "child")?.duplicate).toBe(true);
    expect(result.complete).toBe(false);
  });

  it("does not combine currencies or claim completeness for uncertain session scope", () => {
    const nodes: Record<string, SpendNode> = {
      root: node(1, [{ key: "child", native: false }], { complete: false }),
      child: node(2, [], { cost: { amount: 2, currency: "EUR" } }),
    };
    const result = collectThreadSpend("root", (key) => nodes[key] ?? null);
    expect(result.totals).toEqual([
      { currency: "USD", amount: 1 },
      { currency: "EUR", amount: 2 },
    ]);
    expect(result.complete).toBe(false);
  });

  it("accepts only an explicitly recorded zero and marks untracked children unknown", () => {
    expect(collectThreadSpend("root", () => node(0)).complete).toBe(true);
    expect(collectThreadSpend("root", () => node(null)).totals).toEqual([]);
    const missing = collectThreadSpend("root", () => node(0, [], { unknownChildren: true }));
    expect(missing.complete).toBe(false);
    expect(missing.rows).toHaveLength(2);
    expect(missing.rows[1]?.cost).toBeNull();
  });
});
