<p align="center">
  <img src="./assets/prod/t3-black-web-icon-192x192.png" width="80" height="80" alt="T3 Roots logo" />
</p>

<h1 align="center">T3-Roots</h1>

<p align="center">
  A focused fork of <a href="https://github.com/pingdotgg/t3code">T3 Code</a> built to pair with <a href="https://github.com/vincentvermeire/roots-cli">Roots</a> for 1Password-backed, multi-project gateway workflows on <strong>macOS</strong> and <strong>Windows 11</strong>.
</p>

<p align="center">
  <a href="https://github.com/vincentvermeire/t3code/releases"><strong>Releases</strong></a> ·
  <a href="https://github.com/vincentvermeire/roots-cli"><strong>Roots CLI</strong></a> ·
  <a href="./docs/roots-fork.md"><strong>Fork Architecture & Patch Reference</strong></a> ·
  <a href="./docs/README.md"><strong>Upstream T3 Code Docs</strong></a>
</p>

---

## What problem T3-Roots solves

[T3 Code](https://github.com/pingdotgg/t3code) is a fast, local desktop control plane that drives Claude Code, Codex, OpenCode, Antigravity (`agy`), and other coding agents in one interface.

Out of the box, upstream T3 Code assumes developers sign in to personal agent subscriptions or configure one global API key per provider. Teams routing coding agents through an enterprise model gateway with **separate API keys per project** and **strict zero-plaintext-secret policies in 1Password** run into several gaps:

1. **1Password Environments & approval fatigue:** Upstream T3 Code only reads individual `op://` vault items, cannot read **1Password Environments** (`op-env://`), prompts separately per Environment, and hits 1Password's Electron approval-dialog block on Windows desktop builds.
2. **Cross-project billing leaks & model sprawl:** Provider API keys in T3 Code are machine-wide, background helper tasks (commit messages, thread titles, PR descriptions) can fall back to another enabled provider's key if the primary fails, and provider catalogs list upstream models that your gateway may not serve.
3. **Antigravity (`agy`) custom gateways & private MCP tools:** Injecting large MCP tool catalogs over ACP hits Antigravity CLI's customization token budget and drops tools, while default model lists include unserved upstream models.
4. **GitLab CLI (`glab`) token prompts:** Background merge-request checks need a cached secret-backed `GITLAB_TOKEN` rather than prompting 1Password every minute or failing silently when locked.

**T3-Roots** closes those gaps with a small, maintainable set of generic patches on top of upstream T3 Code — while [**Roots CLI**](https://github.com/vincentvermeire/roots-cli) (`roots setup`, `roots sync`, `roots run`) manages your shared instructions, skills, MCP servers, and per-project T3 provider settings from one place.

---

## What T3-Roots adds on top of T3 Code

Instead of adding gateway-specific logic to T3 Code, T3-Roots adds five clean, general capabilities:

### 1. 1Password Environments & Single-Prompt Unlocking

- **Native `op-env://` references:** Resolves 1Password Environment variables (`op-env://<environment-id>/<VAR>`) natively alongside standard `op://` item references, without falling back to ambient environment variables when a secret is missing.
- **Batched single-unlock reads:** Groups non-overlapping 1Password Environments and `op://` item references into a single `op run` invocation so startup unlocks everything with **one** Touch ID or Windows Hello prompt.
- **Windows desktop native-Node prompt bridge:** On Windows 11 desktop builds (where 1Password's desktop app refuses to show approval dialogs to an Electron-as-Node parent), T3-Roots transparently relays `op` calls through native `node` when available on `PATH`.

### 2. Per-Project Model Governance & Strict Cost Isolation

- **Per-provider model allowlists (`modelAllowlist`):** Optional allowlist on each provider instance (populated automatically by `roots sync` from your gateway's `/v1/models`) filters both the chat model picker and subagent delegation (`delegate_task` / `orchestrator_capabilities`) to models your gateway actually serves.
- **`selected-only` helper policy:** Enforces `textGenerationFallbackPolicy: "selected-only"` globally and per project so automatic commit messages, PR descriptions, branch names, and thread titles strictly use that project's configured helper generator and **never** silently fall back to another project's API key.
- **Clear delegation guidance:** Updates `orchestrator_capabilities` tool documentation so coordinating agents select eligible child-task models cleanly and respect allowlist policies.

### 3. Antigravity (`agy`) Gateway & Private MCP Support

- **Native private stdio MCP without tool truncation:** Validates per-instance `<profile>/config/mcp_config.json` (blocking symlinks and inline secrets) while letting Antigravity CLI load private stdio MCP servers natively so its lazy MCP tool dispatcher (`call_mcp_tool`) retains full access to large toolsets (such as Jira/Confluence), alongside T3's deferred HTTP MCP tools (`tool_search`).
- **Thread-scoped credentials across switch & fork:** Passes session fallback variables (`T3_ACP_MCP_*`) into the spawned process environment and restarts Antigravity cleanly when switching or forking threads so shell and MCP calls always carry the active thread's credentials.
- **Gateway-only custom model picker:** When `customModels` is configured on an Antigravity provider instance, hides unlisted default models so only your gateway-served Gemini models appear.

### 4. Secret-Backed GitLab (`glab`) Integration

- **Cached `GITLAB_TOKEN` injection:** Adds a secret-reference-backed Access Token setting under **Settings → Source Control → GitLab**, resolves it once into server memory per session, and passes `GITLAB_TOKEN` to `glab` so background MR polling never re-triggers 1Password prompts.
- **Actionable locked-vault errors:** Surfaces a clear recovery message when the GitLab token cannot be read from 1Password instead of invoking `glab` unauthenticated.

### 5. Standalone Cross-Platform Releases (macOS & Windows 11)

- **Automated draft release workflow (`release-roots.yml`):** Tagging `vX.Y.Z-roots.N` builds:
  - **macOS Apple Silicon (`arm64`)** and **macOS Intel (`x64`)** `.dmg` and `.zip` bundles (ad-hoc signed after bytecode cache generation and launch-tested in CI, with Squirrel auto-update cleanly disabled on unsigned macOS builds).
  - **Windows 11 (`x64`)** NSIS `.exe` installer (with packaged startup bytecode cache budget accounted for and embedded Linux x64 WSL runtime).
  - **`SHA256SUMS`** covering all installers and archives.

For commit-by-commit technical details and upstream rebase instructions, see [**docs/roots-fork.md**](./docs/roots-fork.md).

---

## Installation & First Run (macOS & Windows 11)

### Recommended: Install with Roots CLI (`roots setup`)

[Roots CLI](https://github.com/vincentvermeire/roots-cli) downloads and SHA-256-verifies T3-Roots, installs your four coding harnesses (`claude`, `codex`, `opencode`, `agy`), configures per-project providers in T3-Roots, and syncs live gateway model allowlists:

```sh
npm install -g --allow-git=root git+https://github.com/vincentvermeire/roots-cli.git
roots setup
```

> **Using GitLab?** Also install the [GitLab CLI (`glab`)](https://gitlab.com/gitlab-org/cli#installation) on your login shell `PATH` (`brew install glab` on macOS or `winget install --id GitLab.Glab -e` on Windows 11) so T3-Roots' merge-request sidebar can query GitLab with your cached token.

### Manual installation from GitHub Releases

Download the asset for your platform from [**Releases**](https://github.com/vincentvermeire/t3code/releases):

| Platform                  | Asset                                    | Installation steps                                                                                    |
| ------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **macOS (Apple Silicon)** | `T3-Roots-<ver>-arm64.dmg` _(or `.zip`)_ | Open the `.dmg`, drag **T3 Roots.app** to `/Applications`, then clear browser quarantine (see below). |
| **macOS (Intel)**         | `T3-Roots-<ver>-x64.dmg` _(or `.zip`)_   | Open the `.dmg`, drag **T3 Roots.app** to `/Applications`, then clear browser quarantine (see below). |
| **Windows 11 (`x64`)**    | `T3-Roots-<ver>-x64.exe`                 | Run the installer. If Windows SmartScreen appears, click **More info → Run anyway**.                  |

> **App name and upgrades:** From `v0.1.10-roots.8`, the desktop app displays as **T3 Roots**. Its bundle ID (`com.t3tools.t3code`), protocols, Windows install identity (`%LOCALAPPDATA%\Programs\t3code`), and `~/.t3/userdata` stay the same. `roots setup` migrates the old macOS bundle to `T3 Roots.app` in the same Applications folder. For manual installation, quit the old app and replace its bundle with `T3 Roots.app`; keep only one T3 bundle in Applications.
>
> **Mac upgrades:** You may need to re-enter saved remote connections and their secrets after the rename because macOS encrypted storage follows the app name. Re-add T3 Roots to the Dock and Login Items if you used the old app there.

---

## Platform notes

### macOS

1. **Gatekeeper on manual browser downloads:**
   T3-Roots builds are ad-hoc signed rather than signed with an Apple Developer ID certificate. If you install via `roots setup`, macOS does not add a quarantine flag. If you download `.dmg` or `.zip` through a browser, run once after copying to `/Applications`:

   ```sh
   xattr -dr com.apple.quarantine "/Applications/T3 Roots.app"
   ```

   _(Or attempt to open the app once, then approve it in **System Settings → Privacy & Security → Open Anyway**.)_

2. **Quitting T3 before `roots sync` (`Cmd+Q`):**
   On macOS, clicking the red window close button closes the window while leaving **T3 Roots** running in the Dock. Always quit with **`Cmd+Q`** before running `roots sync` so T3 does not overwrite `settings.json`.

3. **1Password CLI & Touch ID:**
   In **1Password 8 → Settings → Developer**, enable **Integrate with 1Password CLI** and install `op` (`brew install --cask 1password-cli`). Ensure `/opt/homebrew/bin` (or `/usr/local/bin`) and `~/.local/bin` are in your login shell `PATH` (`~/.zprofile` / `~/.zshrc`).

4. **Updating on macOS & ad-hoc signature re-prompts:**
   Apple's `Squirrel.Mac` auto-updater requires an Apple Developer ID certificate, so automatic in-app updates are disabled on macOS fork builds. To update, upgrade Roots first (`npm install -g --allow-git=root git+https://github.com/vincentvermeire/roots-cli.git`) and run `roots setup`, or download the newest `.dmg`/`.zip` from Releases. Because each ad-hoc build has a new code signature hash, macOS Keychain (_Always Allow_), 1Password CLI approval, and macOS privacy permissions may prompt once after an upgrade.

### Windows 11

1. **1Password CLI & Node.js on `PATH`:**
   Install **Node.js 26 LTS** (`winget install OpenJS.NodeJS.LTS`) and **1Password CLI** (`winget install AgileBits.1Password.CLI`), and enable **Integrate with 1Password CLI** in the 1Password desktop app. Having `node` on `PATH` enables T3-Roots' Windows prompt bridge so Windows Hello approvals appear reliably.

2. **Windows SmartScreen:**
   Because the `.exe` installer is unsigned, Windows SmartScreen displays an _Unrecognized app_ banner on manual downloads — click **More info → Run anyway**.

### Both platforms: First-time Antigravity (`agy`) connection

After running `roots sync`, the first time you select a project's `<project> agy` provider in T3-Roots, open **Settings → Providers → `<project> agy`** and click **Connect** once so T3 loads the custom Gemini model catalog.

### Switching back to official T3 Code

Because T3 Roots preserves the app identity (`com.t3tools.t3code`) and `~/.t3/userdata`, you can switch back to official upstream T3 Code without losing your threads or workspace state:

- **macOS:** Quit **T3 Roots** with **`Cmd+Q`**, move `T3 Roots.app` out of Applications (keep `~/.t3/userdata`), then reinstall the official build with Homebrew (`brew install --cask --force t3-code`) or download the official `.dmg` from [t3.codes/download](https://t3.codes/download) or [upstream Releases](https://github.com/pingdotgg/t3code/releases) and replace `/Applications/T3 Code (Beta).app`.
- **Windows 11:** Quit **T3 Roots**, uninstall T3-Roots from **Settings → Apps → Installed apps** (which removes `%LOCALAPPDATA%\Programs\t3code` while leaving `~/.t3/userdata` intact), and reinstall official T3 Code with `winget install T3Tools.T3Code` or from [t3.codes/download](https://t3.codes/download) / [upstream Releases](https://github.com/pingdotgg/t3code/releases).

If you use Roots, replace each project's `op-env://` key with an `op://` item reference and run `roots setup`, choosing **Official T3 Code**. Re-run setup with **T3-Roots fork** to return to the fork.

---

## Documentation

- [**T3-Roots Fork Architecture & Patch Register**](./docs/roots-fork.md)
- [**Roots CLI Repository & Documentation**](https://github.com/vincentvermeire/roots-cli)
- [**Upstream T3 Code Documentation**](./docs/README.md) ([Install](./docs/user/install.md) · [Permission Modes](./docs/user/permission-modes.md) · [Source Control](./docs/user/source-control.md) · [Development Runbook](./docs/operations/development.md))

## License

[MIT](./LICENSE) — forked from [pingdotgg/t3code](https://github.com/pingdotgg/t3code).
