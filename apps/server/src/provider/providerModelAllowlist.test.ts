import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { applyProviderModelAllowlist } from "./providerModelAllowlist.ts";

const models = [
  { slug: "built-in", name: "Built in", isCustom: false, capabilities: null },
  { slug: "custom", name: "Custom", isCustom: true, capabilities: null },
  { slug: "other", name: "Other", isCustom: true, capabilities: null },
];
const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  status: "ready",
  enabled: true,
  installed: true,
  auth: { status: "authenticated" },
  checkedAt: "1970-01-01T00:00:00.000Z",
  version: "1.0.0",
  models,
  slashCommands: [],
  skills: [],
};

describe("applyProviderModelAllowlist", () => {
  it.each([undefined, []])("preserves the catalog for %s", (allowlist) => {
    expect(applyProviderModelAllowlist(provider, allowlist)).toBe(provider);
  });

  it("filters built-in and custom models by exact slug", () => {
    expect(applyProviderModelAllowlist(provider, ["built-in", "custom"]).models).toEqual(
      models.slice(0, 2),
    );
    expect(applyProviderModelAllowlist(provider, ["custom"]).models).toEqual([models[1]]);
    expect(applyProviderModelAllowlist(provider, ["BUILT-IN", "prefix/custom"]).models).toEqual([]);
    expect(provider.models).toEqual(models);
  });

  it("filters workspace and update-required catalogs too", () => {
    const filtered = applyProviderModelAllowlist(
      {
        ...provider,
        workspaceSnapshots: [
          { cwd: "/repo", checkedAt: provider.checkedAt, models, skills: [], slashCommands: [] },
        ],
        updateRequiredModels: [{ slug: "other", name: "Other", minVersion: "2.0.0" }],
      },
      ["custom"],
    );
    expect(filtered.workspaceSnapshots?.[0]?.models).toEqual([models[1]]);
    expect(filtered.updateRequiredModels).toEqual([]);
  });
});
