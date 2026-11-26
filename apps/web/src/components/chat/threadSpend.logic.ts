import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentThreadShell, ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";

export interface SpendCost {
  readonly amount: number;
  readonly currency: string;
}

export interface SpendNode {
  readonly label: string;
  readonly cost: SpendCost | null;
  /** Identity of the provider's session ledger, when available. */
  readonly costIdentity?: string;
  /** False when the session snapshot cannot cover the whole thread. */
  readonly complete: boolean;
  readonly unknownChildren: boolean;
  readonly children: ReadonlyArray<{ readonly key: string; readonly native: boolean }>;
  readonly nativeSessions?: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly cost: SpendCost | null;
  }>;
}

export interface SpendRow {
  readonly key: string;
  readonly label: string;
  readonly cost: SpendCost | null;
  /** Native session costs may already be in their parent's provider ledger. */
  readonly native: boolean;
  readonly duplicate: boolean;
}

/** Count each app-owned thread once. Never add a native child to an overlapping ledger. */
export function collectThreadSpend(root: string, read: (key: string) => SpendNode | null) {
  const visited = new Map<string, { node: SpendNode | null; native: boolean }>();
  const rows: SpendRow[] = [];
  const totals = new Map<string, number>();
  const seenCosts = new Set<string>();
  let complete = true;
  const pending = [{ key: root, native: false }];
  while (pending.length) {
    const entry = pending.pop()!;
    const existing = visited.get(entry.key);
    if (existing) {
      if (entry.native && entry.key !== root) existing.native = true;
      continue;
    }
    const node = read(entry.key);
    visited.set(entry.key, { node, native: entry.native });
    if (node === null) {
      continue;
    }
    pending.push(...node.children);
  }
  for (const [key, { node, native }] of visited) {
    if (node === null) {
      complete = false;
      rows.push({ key, label: "", cost: null, native, duplicate: false });
      continue;
    }
    const cost =
      node.cost && Number.isFinite(node.cost.amount) && node.cost.amount >= 0
        ? { amount: node.cost.amount, currency: node.cost.currency.trim().toUpperCase() }
        : null;
    const validCost = cost?.currency ? cost : null;
    const duplicate =
      !native &&
      validCost !== null &&
      node.costIdentity !== undefined &&
      seenCosts.has(node.costIdentity);
    rows.push({ key, label: node.label, cost: validCost, native, duplicate });
    if (node.unknownChildren) {
      rows.push({
        key: `\0missing:${key}`,
        label: "",
        cost: null,
        native: false,
        duplicate: false,
      });
    }
    for (const session of node.nativeSessions ?? []) {
      const reported = session.cost;
      const sessionCost =
        reported &&
        Number.isFinite(reported.amount) &&
        reported.amount >= 0 &&
        reported.currency.trim()
          ? { amount: reported.amount, currency: reported.currency.trim().toUpperCase() }
          : null;
      rows.push({
        key: `\0native:${key}:${session.key}`,
        label: session.label,
        cost: sessionCost,
        native: true,
        duplicate: false,
      });
      complete = false;
    }
    if (native || !node.complete || node.unknownChildren || validCost === null) {
      complete = false;
    }
    if (!native && validCost !== null) {
      if (duplicate) {
        // Two snapshots of one ledger are not two charges; their coverage may differ.
        complete = false;
      } else {
        if (node.costIdentity !== undefined) seenCosts.add(node.costIdentity);
        totals.set(validCost.currency, (totals.get(validCost.currency) ?? 0) + validCost.amount);
      }
    }
  }
  if (totals.size !== 1) complete = false;
  return {
    rows,
    totals: [...totals].map(([currency, amount]) => ({ currency, amount })),
    complete,
  };
}

export function threadSpendNode(
  ref: ScopedThreadRef,
  projection: ThreadStructure,
  shells: ReadonlyArray<EnvironmentThreadShell>,
): SpendNode {
  const providerThreads = projection.providerThreads.filter(
    (thread) =>
      thread.appThreadId === ref.threadId || thread.id === projection.thread.activeProviderThreadId,
  );
  const active = providerThreads.find(
    (thread) => thread.id === projection.thread.activeProviderThreadId,
  );
  const children = new Map<string, boolean>();
  const nativeSessions = new Map<string, { key: string; label: string; cost: SpendCost | null }>();
  let unknownChildren = false;
  for (const agent of projection.subagents) {
    const child = agent.remoteChild
      ? scopeThreadRef(agent.remoteChild.environmentId, agent.remoteChild.threadId)
      : agent.childThreadId
        ? scopeThreadRef(ref.environmentId, agent.childThreadId)
        : null;
    if (child === null) {
      const session =
        agent.origin === "provider_native" && agent.providerThreadId !== null
          ? projection.providerThreads.find((thread) => thread.id === agent.providerThreadId)
          : undefined;
      if (session) {
        nativeSessions.set(session.id, {
          key: session.id,
          label: agent.title ?? "",
          cost: session.contextUsage?.cost ?? null,
        });
        continue;
      }
      unknownChildren = true;
      continue;
    }
    const key = threadKey(child);
    children.set(key, children.get(key) === true || agent.origin === "provider_native");
  }
  // Shells can contain children whose original subagent record is no longer in this projection.
  for (const shell of shells) {
    const localChild =
      shell.environmentId === ref.environmentId &&
      shell.lineage.relationshipToParent === "subagent" &&
      shell.lineage.parentThreadId === ref.threadId;
    const remoteChild =
      shell.delegatedFrom?.environmentId === ref.environmentId &&
      shell.delegatedFrom.threadId === ref.threadId;
    if (!localChild && !remoteChild) continue;
    const key = threadKey(scopeThreadRef(shell.environmentId, shell.id));
    children.set(key, children.get(key) === true || shell.source.creationSource === "provider");
  }
  return {
    label: projection.thread.title,
    // A native fork can inherit someone else's ledger, so it is not a known cost of this thread.
    cost: active?.forkedFrom === null ? (active.contextUsage?.cost ?? null) : null,
    ...(active === undefined
      ? {}
      : {
          costIdentity:
            active.nativeThreadRef?.strength === "strong" && active.nativeThreadRef.nativeId
              ? JSON.stringify([active.driver, active.nativeThreadRef.nativeId])
              : JSON.stringify([ref.environmentId, active.id]),
        }),
    // A fork can carry a predecessor's ledger; multiple sessions can overlap or be missing.
    complete:
      providerThreads.length === 1 &&
      active?.forkedFrom === null &&
      !projection.providerTurns.some(
        (turn) => turn.turnTokenUsage?.hasSubagents || turn.turnTokenUsage?.otherUsage,
      ),
    unknownChildren,
    children: [...children].map(([key, native]) => ({ key, native })),
    nativeSessions: [...nativeSessions.values()],
  };
}
