import type { ServerProvider } from "@t3tools/contracts";

export function applyProviderModelAllowlist(
  provider: ServerProvider,
  allowlist: ReadonlyArray<string> | undefined,
): ServerProvider {
  if (allowlist === undefined || allowlist.length === 0) return provider;
  const allowed = new Set(allowlist);
  return {
    ...provider,
    modelAllowlist: allowlist,
    models: provider.models.filter((model) => allowed.has(model.slug)),
    ...(provider.workspaceSnapshots === undefined
      ? {}
      : {
          workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
            ...snapshot,
            ...(snapshot.models === undefined
              ? {}
              : { models: snapshot.models.filter((model) => allowed.has(model.slug)) }),
          })),
        }),
    ...(provider.updateRequiredModels === undefined
      ? {}
      : {
          updateRequiredModels: provider.updateRequiredModels.filter((model) =>
            allowed.has(model.slug),
          ),
        }),
  };
}
