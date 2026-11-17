import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceConfig, ProviderInstanceEnvironmentVariable } from "./providerInstance.ts";

const decodeEnvironmentVariable = Schema.decodeUnknownSync(ProviderInstanceEnvironmentVariable);
const decodeInstance = Schema.decodeSync(ProviderInstanceConfig);
const encodeInstance = Schema.encodeSync(ProviderInstanceConfig);

it("round-trips a trimmed model allowlist and rejects blank slugs", () => {
  const instance = decodeInstance({
    driver: "codex",
    modelAllowlist: [" custom "],
  });
  expect(instance.modelAllowlist).toEqual(["custom"]);
  expect(encodeInstance({ ...instance, displayName: "Work" }).modelAllowlist).toEqual(["custom"]);
  expect(() => decodeInstance({ driver: "codex", modelAllowlist: [" "] })).toThrow();
});

describe("ProviderInstanceEnvironmentVariable", () => {
  it("treats a stored reference as sensitive even when the flag is missing or false", () => {
    const secret = { provider: "onepassword", reference: "op://Private/item/field" };
    expect(decodeEnvironmentVariable({ name: "API_KEY", secret })).toMatchObject({
      value: secret,
      sensitive: true,
    });
    expect(decodeEnvironmentVariable({ name: "API_KEY", sensitive: false, secret }).sensitive).toBe(
      true,
    );
  });
});
