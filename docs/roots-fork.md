# T3-Roots Fork Reference

This document maps the human-facing capabilities of **T3-Roots** (`iodigital-com/t3-roots`) to the underlying patch commits maintained on top of upstream [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code), and describes how fork releases are built and updated.

---

## Design principles

1. **Generic capabilities only:** T3-Roots never hardcodes gateway URLs, organization domains, model names, or project names. [Roots CLI](https://github.com/iodigital-com/roots-cli) writes configuration into `~/.t3/userdata/settings.json`; T3-Roots enforces the generic secret, allowlist, helper, and MCP contracts.
2. **Small diff against upstream:** `main` is the T3-Roots release line: upstream `pingdotgg/t3code` plus the patches below, kept as separate commits. Upstream changes are pulled in regularly, and a patch is dropped as soon as upstream ships an equivalent feature.
3. **Draft-first releases:** Dispatching a batched release for an existing `vX.Y.Z-roots.N` tag builds Windows x64 and macOS (`arm64` + `x64`) artifacts into a **draft** GitHub Release (`make_latest: false`), verified by checksums and smoke tests before manual publication.

---

## Maintained patch groups

Base tag on the current fork release branch (`main`): stable `v0.1.11` (`59651c1761`). The previous base was `v0.1.10-nightly.20261116.4774`; the update preserves the fork commits through an upstream merge.

### Upstream integration: v0.1.11

All maintained capability groups below remain necessary. Upstream now forwards Antigravity thread variables through `AntigravityAdapterV2RuntimeInput` and `AntigravityDriver.prepareSpawn`, so the fork's duplicate `processEnvironment` field on `AntigravityAcpRuntimeInput` and its old inline environment merge are removed. Upstream's environment-forwarding tests and the fork's new/resume/fork credential test cover this path. Private MCP validation, deferred tools and restart-on-thread-switch remain fork behavior.

The merged driver also keeps upstream's compatibility check and mode-state-aware session mode mapping. Upstream now installs only the native Antigravity CLI and removes the external harness, so the old `harnessPath === null` private-MCP guard is removed; every conversation runtime validates native private MCP. GitLab keeps saved secret token resolution and readable failures alongside upstream's protection against sending the default host's token to a different caller-named host. macOS permission copy keeps the fork app name and upstream localisation.

`customModels` retains upstream's string-or-descriptor setting format for Codex, Claude and Antigravity. Roots can continue supplying gateway model slugs or descriptors; `modelAllowlist` independently restricts picker snapshots and delegation. This update does not change Roots configuration or installed T3 data.

Selected-only helpers reject models that cannot generate text before upstream's fallback can choose another instance. macOS permission translations use the configured app name in every locale.

### 1. 1Password Environments & Secret Resolution (`packages/secret-provider-onepassword`)

| Capability                                                                                                                                           | Commit(s)    | Key files                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------- |
| Native `op-env://<environment-id>/<VAR>` secret references alongside `op://` items                                                                   | `5b2f6986f2` | `packages/secret-provider-onepassword/src/shared/definition.ts`, `src/server/driver.ts` |
| Single-prompt batching across multiple non-overlapping Environments and `op://` items in one `op run` call                                           | `3098c2d178` | `packages/secret-provider-onepassword/src/server/driver.ts`                             |
| Windows desktop native-Node relay (`withWindowsBridge`) so 1Password displays approval prompts when spawned from Electron (`ELECTRON_RUN_AS_NODE=1`) | `d905338bf9` | `packages/secret-provider-onepassword/src/server/driver.ts`                             |
| Recover provider keys that were unreadable at startup (for example while 1Password was locked) without a manual Settings refresh                     | `d52498e854` | `apps/mobile/src/features/threads/provider-catalog-refresh.ts`                          |

### 2. Model Governance, Helper Cost Isolation & Delegation (`apps/server`, `packages/contracts`, `packages/shared`)

| Capability                                                                                                                                                                | Commit(s)    | Key files                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `textGenerationFallbackPolicy: "selected-only"` globally and per project so commit messages, titles, PR text, and review guides never fall back to another provider's key | `c513915625` | `packages/contracts/src/settings.ts`, `packages/shared/src/{projectSettings,serverSettings}.ts`, `apps/server/src/textGeneration/{TextGeneration,TextGenerators}.ts` |
| Per-provider `modelAllowlist` filtering advertised models, snapshots, update hints, and MCP `delegate_task` validation                                                    | `831a948b0a` | `apps/server/src/provider/{providerModelAllowlist,ProviderRegistry,ProviderInstanceRegistry}.ts`, `apps/server/src/mcp/OrchestratorMcpService.ts`                    |
| Accurate `orchestrator_capabilities` tool guidance for `canRunChildTask` instances and policy enforcement                                                                 | `182924757d` | `apps/server/src/mcp/toolkits/orchestrator/tools.ts`                                                                                                                 |

### 3. Antigravity (`agy`) Private MCP & Custom Models (`apps/server/src/provider`)

| Capability                                                                                                                                                                                                                                                                                                                                    | Commit(s)                                              | Key files                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Validate `<profile>/config/mcp_config.json` (no symlinks/hardlinks or inline secrets), retain native Antigravity lazy MCP dispatch (`call_mcp_tool`), enable HTTP deferred T3 tool listing (`tool_search`), forward `input.processEnvironment` (`T3_ACP_MCP_*`), and restart on thread switches/forks (`processMcpEnvironmentIsThreadScoped`) | `5433444dd4`, `25b0184356`                             | `apps/server/src/provider/{antigravityMcpSupport.ts,Drivers/AntigravityDriver.ts}`, `apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts`, `packages/provider-acp/src/server/adapter.ts` |
| Show only configured `customModels` on Antigravity instances when `customModels` is non-empty                                                                                                                                                                                                                                                 | `1308cfaf8f`                                           | `apps/server/src/provider/AntigravityProvider.ts`                                                                                                                                                      |
| Antigravity background timer waits, child and reply lifecycles, and wake-ups stay active and tracked until the native reply is delivered                                                                                                                                                                                                      | `d14c752002`, `bffb985fb5`, `ee814f2bde`, `868bed1e76` | `apps/server/src/provider/acp/AntigravityBackgroundWork.ts`, `apps/server/src/provider/acp/AntigravityProtocol.ts`, `packages/provider-acp/src/server/adapter.ts`                                      |
| Native `ask_question` prompts render as forms: the question is the card body, `<id>_other` fields take write-in answers, and custom-only answers are accepted                                                                                                                                                                                 | `59752718fb`, `941fed3b52`                             | `apps/server/src/provider/acp/AntigravityProtocol.ts`, `apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts`                                                                             |
| Readable runtime response guidance (both commits carry the same title; check for a duplicate)                                                                                                                                                                                                                                                 | `326b1754ec`, `b465407b45`                             | `runtimeInstructions.ts`                                                                                                                                                                               |

### 4. GitLab (`glab`) Token Caching & Error Reporting (`packages/source-control-gitlab`)

| Capability                                                                                                            | Commit(s)    | Key files                                                                       |
| --------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------- |
| Secret-backed GitLab Access Token setting cached per server session and passed as `GITLAB_TOKEN` to `glab`            | `45433b6aca` | `packages/source-control-gitlab/src/{shared/definition.ts,server/GitLabCli.ts}` |
| Clear `GitLabAccessTokenReadError` message when 1Password is locked instead of running `glab` unauthenticated         | `2330b599a2` | `packages/source-control-gitlab/src/server/GitLabCli.ts`                        |
| Issue requests use only the credentials for the host they target, so the default host's token is never sent elsewhere | `0eb26fedd5` | `packages/source-control-gitlab/src/server/GitLabIssueTracker.ts`               |

### 5. Packaging, macOS Ad-Hoc Signing & Release Pipeline (`scripts/`, `apps/desktop`, `.github/workflows/`)

| Capability                                                                                                                                                                                                                                            | Commit(s)                                                           | Key files                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Account for startup V8 bytecode cache files in `WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT` (`80 -> 102`)                                                                                                                                                    | `b2f804e69e`                                                        | `scripts/build-desktop-artifact.ts`, `docs/operations/release.md`                                                          |
| Ad-hoc sign (`identity: "-"`, `hardenedRuntime: false`) unsigned macOS builds after `afterPack` so Apple Silicon (`arm64`) and 1Password CLI accept the `.app` bundle                                                                                 | _(macOS support patch)_                                             | `scripts/build-desktop-artifact.ts`, `scripts/build-desktop-artifact.test.ts`                                              |
| Write `Contents/Resources/desktop-signing` at package time and disable broken `Squirrel.Mac` auto-updates on ad-hoc macOS builds while keeping signed macOS and Windows NSIS updates enabled                                                          | _(macOS support patch)_                                             | `scripts/build-desktop-artifact.ts`, `apps/desktop/src/app/DesktopConfig.ts`, `apps/desktop/src/updates/DesktopUpdates.ts` |
| Manually dispatched `release-roots.yml` building Linux x64 WSL CLI, Windows x64 `.exe`, and macOS `arm64` + `x64` `.dmg`/`.zip` (verified with `codesign --verify --deep --strict` and `smoke-desktop-app.ts`) into a draft release with `SHA256SUMS` | `a30d369714`, `318846631f`, `fbf4b4baf0`, _(macOS workflow update)_ | `.github/workflows/release-roots.yml`                                                                                      |

### 6. Roots Product Features (`apps/web`, `apps/desktop`, `apps/server/src/vcs`)

| Capability                                                                                                                      | Commit(s)                                              | Key files                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bridge: "Settle and book hours" thread action fills the Jira worklog link; Jira references are found before Bridge opens        | `8dcb980fda`, `553d4f25e6`                             | `apps/web/src/hooks/useBridgeWorklog.ts`, `apps/web/src/components/threadActionMenu.logic.ts`, `apps/web/src/components/Sidebar.tsx`                  |
| Thread spend bar near the composer; incomplete or rolled-back child totals show as unknown instead of a wrong sum               | `cf0ca1bd24`, `0cfb7592f3`, `6601cba86e`               | `apps/web/src/components/chat/ThreadSpendBar.tsx`, `apps/web/src/components/chat/threadSpend.logic.ts`                                                |
| Coordinated, safe desktop shutdown when `roots sync` restarts T3                                                                | `3d1dedca8f`                                           | `apps/desktop/src/app/DesktopLifecycle.ts`, `apps/desktop/src/app/DesktopAppActivation.ts`                                                            |
| Pull request and branch requests refresh when the checked-out branch changes; sidebar, composer and palette follow the checkout | `05a9e9a0cc`, `924dd26fd9`, `6f33f6180e`, `7124392805` | `apps/server/src/vcs/VcsStatusBroadcaster.ts`, `apps/web/src/components/BranchToolbar.logic.ts`, `apps/web/src/components/ThreadStatusIndicators.tsx` |

### 7. CI Cost Controls (`.github/workflows`)

| Capability                                                                                                                  | Commit(s)                                              | Key files                  |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------- |
| Remove upstream workflows and slim the fork CI                                                                              | `23612e416f`, `60e69997da`                             | `.github/workflows/`       |
| Run fork checks on GitHub-hosted runners, with timeouts and web test shards sized for them; restore cached tools on Windows | `77e1a0b07a`, `0107cd5841`, `13d9e2f651`, `cec0dea3fc` | `.github/workflows/ci.yml` |
| Reduce pull request runner costs                                                                                            | `5588d7bbe0`                                           | `.github/workflows/`       |

---

## Upstream sync checklist

Checked against upstream stable `v0.1.13` on 2026-11-27. The verdicts come from file and commit overlap, not from running tests. Before removing anything, run the affected tests on a branch from the new tag.

- **Keep:** no equivalent found upstream. Keep through the sync.
- **Check:** upstream changed the same area. Decide by running that group's tests on the new tag.
- **Likely drop:** upstream has an equivalent. Verify with the tests, then remove the commits and record the drop in this section.

| Group                    | Keep                                                                                                                                                     | Check                                                                              | Likely drop                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------- |
| 1. 1Password             | `5b2f6986f2`, `3098c2d178`, `d905338bf9`                                                                                                                 | `d52498e854`                                                                       |                            |
| 2. Models and helpers    | `c513915625`, `831a948b0a`, `182924757d`, `118770625f`                                                                                                   |                                                                                    |                            |
| 3. Antigravity           | `1308cfaf8f`, `5433444dd4`, `25b0184356`                                                                                                                 | `d14c752002`, `bffb985fb5`, `ee814f2bde`, `868bed1e76`, `326b1754ec`, `b465407b45` | `59752718fb`, `941fed3b52` |
| 4. GitLab                | `45433b6aca`, `2330b599a2`                                                                                                                               | `0eb26fedd5`                                                                       |                            |
| 5. Packaging and release | `b2f804e69e`, `0d34489eca`, `3279e1fb79`, `224ecdc712`, `29554eacec`, `fabaf3eb36`, `aa891d9a40`, `7ee7052084`, `a30d369714`, `318846631f`, `fbf4b4baf0` |                                                                                    |                            |
| 6. Roots features        | `8dcb980fda`, `553d4f25e6`, `cf0ca1bd24`, `0cfb7592f3`, `6601cba86e`, `3d1dedca8f`                                                                       | `05a9e9a0cc`, `924dd26fd9`, `6f33f6180e`, `7124392805`                             |                            |
| 7. CI cost controls      | `23612e416f`, `60e69997da`, `77e1a0b07a`, `0107cd5841`, `13d9e2f651`, `cec0dea3fc`, `5588d7bbe0`                                                         |                                                                                    |                            |

Upstream v0.1.13 has no equivalent for the 1Password, model-governance, Roots feature or CI groups. Upstream's Antigravity elicitation tests cover the same case as `59752718fb` and `941fed3b52`; confirm before dropping. The two readability commits share a title; check whether one duplicates the other.

---

## Releasing a new fork build

1. Ensure formatting, linting, typechecks, and tests pass, and verify compatibility with Roots CLI's T3 settings tests (`roots/test/t3.test.mjs`).
2. Commit and push the branch to `iodigital-com/t3-roots`, then push a signed version tag on the current `main` commit matching `vX.Y.Z-roots.N` (for example `v0.1.11-roots.6`).
3. Dispatch `Roots release` on `main` in `iodigital-com/t3-roots` with the tag and a concise changelog. GitHub Actions builds all platforms, runs `codesign` and launch smoke checks on macOS plus CLI smoke checks on Linux, validates `SHA256SUMS`, and creates a **draft** GitHub Release.
4. Review the draft release assets and `SHA256SUMS`, copy the three installer/archive SHA-256 digests (`T3-Roots-<ver>-arm64.zip`, `T3-Roots-<ver>-x64.zip`, `T3-Roots-<ver>-x64.exe`) into `t3Fork.sha256` in `roots` (`src/defaults.mjs`) alongside bumping `t3Fork.tag`, and — only when ready — publish the GitHub Release by hand with **"Set as the latest release"** ticked so the Windows NSIS in-app updater (which queries GitHub's latest release for `latest.yml`) discovers the new version.

From `v0.1.10-roots.8`, the desktop product is **T3 Roots** and fork assets use `T3-Roots-`. Keep the package name, app ID, protocol schemes and NSIS install identity unchanged. Windows update metadata stays `latest.yml` with the renamed `.exe` and `.blockmap` paths; the existing updater reads those paths from the manifest. Unsigned macOS builds still update through Roots or manual installation.
