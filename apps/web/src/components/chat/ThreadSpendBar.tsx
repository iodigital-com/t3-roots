import { useAtomValue } from "@effect/atom-react";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useGT, useLocale } from "gt-react";

import { formatContextWindowTokens } from "../../lib/contextWindow";
import { useClientSettings } from "../../hooks/useSettings";
import { environmentThreadDetails, environmentThreadShells } from "../../state/threads";
import { collectThreadSpend, threadSpendNode, type SpendCost } from "./threadSpend.logic";
import { resolveThreadDetailsVisibility } from "./threadDetailsItems";

function formatCost(cost: SpendCost, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: cost.currency,
      maximumSignificantDigits: 4,
    }).format(cost.amount);
  } catch {
    return `${cost.amount} ${cost.currency}`;
  }
}

export function ThreadSpendBarSetting(props: {
  readonly threadRef: ScopedThreadRef;
  readonly context: ContextWindowSnapshot | null;
}) {
  const enabled = useClientSettings(
    (settings) => resolveThreadDetailsVisibility(settings).spendBar,
  );
  return enabled ? <ThreadSpendBar {...props} /> : null;
}

function ThreadSpendBar({
  threadRef,
  context,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly context: ContextWindowSnapshot | null;
}) {
  const gt = useGT();
  const locale = useLocale();
  const { environmentId, threadId } = threadRef;
  const spendAtom = Atom.make((get) => {
    const shells = get(environmentThreadShells.quietThreadShellsAtom);
    return collectThreadSpend(threadKey({ environmentId, threadId }), (key) => {
      const ref = parseThreadKey(key);
      // A cached child can have continued spending while its environment was disconnected.
      if (get(environmentThreadDetails.statusAtom(ref)) !== "live") return null;
      const projection = get(environmentThreadDetails.quietThreadAtom(ref))?.projection;
      if (!projection) return null;
      return threadSpendNode(
        ref,
        projection,
        shells,
        get(environmentThreadDetails.historyAtom(ref)),
      );
    });
  });
  const spend = useAtomValue(spendAtom);
  const known = spend.totals.map((cost) => formatCost(cost, locale)).join(" + ");
  const spendLabel = spend.complete
    ? gt("Spend: {amount}", { amount: known })
    : known
      ? gt("Known spend: {amount} · total unknown", { amount: known })
      : gt("Spend: unknown");
  const contextLabel =
    context === null
      ? gt("Context: unknown")
      : context.usedPercentage === null
        ? gt("Context: {used} tokens", { used: formatContextWindowTokens(context.usedTokens) })
        : gt("Context: {percent}% used", { percent: Math.round(context.usedPercentage) });
  const cacheLabel =
    context?.cachedInputTokens == null
      ? gt("Cache: unknown")
      : gt("Cached input: {tokens} tokens", {
          tokens: formatContextWindowTokens(context.cachedInputTokens),
        });

  return (
    <details className="relative px-3 pb-1 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none rounded py-1 focus-visible:outline-2 focus-visible:outline-ring">
        {spendLabel} · {contextLabel} · {cacheLabel}
      </summary>
      <div className="space-y-1 pb-1" aria-label={gt("Spend breakdown")}>
        {spend.rows.map((row) => (
          <div key={row.key}>
            {row.label || gt("Child thread")}:{" "}
            {row.cost ? formatCost(row.cost, locale) : gt("unknown")}
            {row.native ? ` · ${gt("Native subagent; may overlap parent cost")}` : null}
            {row.duplicate ? ` · ${gt("Duplicate")}` : null}
          </div>
        ))}
        <div>
          {gt(
            "Provider-reported session costs. Missing costs and overlapping native subagents make the total unknown.",
          )}
        </div>
      </div>
    </details>
  );
}
