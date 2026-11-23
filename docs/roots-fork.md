# T3-Roots Fork Reference

This document maps the human-facing capabilities of **T3-Roots** (`iodigital-com/t3-roots`) to the underlying patch commits maintained on top of upstream [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code), and describes how fork releases are built and updated.

---

## Design principles

1. **Generic capabilities only:** T3-Roots never hardcodes gateway URLs, organization domains, model names, or project names. [Roots CLI](https://github.com/iodigital-com/roots-cli) writes configuration into `~/.t3/userdata/settings.json`; T3-Roots enforces the generic secret, allowlist, helper, and MCP contracts.
2. **Small diff against upstream:** `main` is the T3-Roots release line: upstream `pingdotgg/t3code` plus the patches below, kept as separate commits. Upstream changes are pulled in regularly, and a patch is dropped as soon as upstream ships an equivalent feature.
3. **Draft-first releases:** Pushing a `vX.Y.Z-roots.N` tag builds Windows x64 and macOS (`arm64` + `x64`) artifacts into a **draft** GitHub Release (`make_latest: false`), verified by checksums and smoke tests before manual publication.

---

## Maintained patch groups

Base tag on current branch (`roots/nightly-20261116`): `v0.1.10-nightly.20261116.4774`.

### 1. 1Password Environments & Secret Resolution (`packages/secret-provider-onepassword`)

| Capability                                                                                                                                           | Commit(s)    | Key files                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------- |
| Native `op-env://<environment-id>/<VAR>` secret references alongside `op://` items                                                                   | `5b2f6986f2` | `packages/secret-provider-onepassword/src/shared/definition.ts`, `src/server/driver.ts` |
| Single-prompt batching across multiple non-overlapping Environments and `op://` items in one `op run` call                                           | `3098c2d178` | `packages/secret-provider-onepassword/src/server/driver.ts`                             |
| Windows desktop native-Node relay (`withWindowsBridge`) so 1Password displays approval prompts when spawned from Electron (`ELECTRON_RUN_AS_NODE=1`) | `d905338bf9` | `packages/secret-provider-onepassword/src/server/driver.ts`                             |

### 2. Model Governance, Helper Cost Isolation & Delegation (`apps/server`, `packages/contracts`, `packages/shared`)

| Capability                                                                                                                                                                | Commit(s)    | Key files                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `textGenerationFallbackPolicy: "selected-only"` globally and per project so commit messages, titles, PR text, and review guides never fall back to another provider's key | `c513915625` | `packages/contracts/src/settings.ts`, `packages/shared/src/{projectSettings,serverSettings}.ts`, `apps/server/src/textGeneration/{TextGeneration,TextGenerators}.ts` |
| Per-provider `modelAllowlist` filtering advertised models, snapshots, update hints, and MCP `delegate_task` validation                                                    | `831a948b0a` | `apps/server/src/provider/{providerModelAllowlist,ProviderRegistry,ProviderInstanceRegistry}.ts`, `apps/server/src/mcp/OrchestratorMcpService.ts`                    |
| Accurate `orchestrator_capabilities` tool guidance for `canRunChildTask` instances and policy enforcement                                                                 | `182924757d` | `apps/server/src/mcp/toolkits/orchestrator/tools.ts`                                                                                                                 |

### 3. Antigravity (`agy`) Private MCP & Custom Models (`apps/server/src/provider`)

| Capability                                                                                                                                                                                                                                                                                                                                    | Commit(s)                  | Key files                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Validate `<profile>/config/mcp_config.json` (no symlinks/hardlinks or inline secrets), retain native Antigravity lazy MCP dispatch (`call_mcp_tool`), enable HTTP deferred T3 tool listing (`tool_search`), forward `input.processEnvironment` (`T3_ACP_MCP_*`), and restart on thread switches/forks (`processMcpEnvironmentIsThreadScoped`) | `5433444dd4`, `25b0184356` | `apps/server/src/provider/{antigravityMcpSupport.ts,Drivers/AntigravityDriver.ts}`, `apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts`, `packages/provider-acp/src/server/adapter.ts` |
| Show only configured `customModels` on Antigravity instances when `customModels` is non-empty                                                                                                                                                                                                                                                 | `1308cfaf8f`               | `apps/server/src/provider/AntigravityProvider.ts`                                                                                                                                                      |

### 4. GitLab (`glab`) Token Caching & Error Reporting (`packages/source-control-gitlab`)

| Capability                                                                                                    | Commit(s)    | Key files                                                                       |
| ------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------- |
| Secret-backed GitLab Access Token setting cached per server session and passed as `GITLAB_TOKEN` to `glab`    | `45433b6aca` | `packages/source-control-gitlab/src/{shared/definition.ts,server/GitLabCli.ts}` |
| Clear `GitLabAccessTokenReadError` message when 1Password is locked instead of running `glab` unauthenticated | `2330b599a2` | `packages/source-control-gitlab/src/server/GitLabCli.ts`                        |

### 5. Packaging, macOS Ad-Hoc Signing & Release Pipeline (`scripts/`, `apps/desktop`, `.github/workflows/`)

| Capability                                                                                                                                                                                                                                   | Commit(s)                                                           | Key files                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Account for startup V8 bytecode cache files in `WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT` (`80 -> 102`)                                                                                                                                           | `b2f804e69e`                                                        | `scripts/build-desktop-artifact.ts`, `docs/operations/release.md`                                                          |
| Ad-hoc sign (`identity: "-"`, `hardenedRuntime: false`) unsigned macOS builds after `afterPack` so Apple Silicon (`arm64`) and 1Password CLI accept the `.app` bundle                                                                        | _(macOS support patch)_                                             | `scripts/build-desktop-artifact.ts`, `scripts/build-desktop-artifact.test.ts`                                              |
| Write `Contents/Resources/desktop-signing` at package time and disable broken `Squirrel.Mac` auto-updates on ad-hoc macOS builds while keeping signed macOS and Windows NSIS updates enabled                                                 | _(macOS support patch)_                                             | `scripts/build-desktop-artifact.ts`, `apps/desktop/src/app/DesktopConfig.ts`, `apps/desktop/src/updates/DesktopUpdates.ts` |
| Tag-driven `release-roots.yml` building Linux x64 WSL CLI, Windows x64 `.exe`, and macOS `arm64` + `x64` `.dmg`/`.zip` (verified with `codesign --verify --deep --strict` and `smoke-desktop-app.ts`) into a draft release with `SHA256SUMS` | `a30d369714`, `318846631f`, `fbf4b4baf0`, _(macOS workflow update)_ | `.github/workflows/release-roots.yml`                                                                                      |

---

## Releasing a new fork build

1. Ensure formatting, linting, typechecks, and tests pass, and verify compatibility with Roots CLI's T3 settings tests (`roots/test/t3.test.mjs`).
2. Commit and push the branch to `iodigital-com/t3-roots`, then push a signed version tag matching `vX.Y.Z-roots.N` (for example `v0.1.10-roots.8`).
3. GitHub Actions (`release-roots.yml`) builds all platforms, runs `codesign` and launch smoke checks on macOS plus CLI smoke checks on Linux, validates `SHA256SUMS`, and creates a **draft** GitHub Release.
4. Review the draft release assets and `SHA256SUMS`, copy the three installer/archive SHA-256 digests (`T3-Roots-<ver>-arm64.zip`, `T3-Roots-<ver>-x64.zip`, `T3-Roots-<ver>-x64.exe`) into `t3Fork.sha256` in `roots` (`src/defaults.mjs`) alongside bumping `t3Fork.tag`, and — only when ready — publish the GitHub Release by hand with **"Set as the latest release"** ticked so the Windows NSIS in-app updater (which queries GitHub's latest release for `latest.yml`) discovers the new version.

From `v0.1.10-roots.8`, the desktop product is **T3 Roots** and fork assets use `T3-Roots-`. Keep the package name, app ID, protocol schemes and NSIS install identity unchanged. Windows update metadata stays `latest.yml` with the renamed `.exe` and `.blockmap` paths; the existing updater reads those paths from the manifest. Unsigned macOS builds still update through Roots or manual installation.
