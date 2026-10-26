# Agent setup matrix

Which agent setups Mousse has been tested with. Each agent PR marks its own cells. A cell not marked
"tested" is untested, with the reason.

Axes:

- **OS:** Windows x64, Windows arm64, macOS arm64, Linux x64, Linux arm64.
- **Source:** on PATH, installed by Mousse (managed), Custom command.
- **Sign-in:** the ACP 1.5 methods an agent advertises: `terminal` (the agent's own command, run in
  a pseudo-terminal) and `agent` (the agent signs in itself; its link arrives as a URL elicitation
  or on stderr).

## Generic ACP agent (Custom command)

| OS | Source | Sign-in | State |
|---|---|---|---|
| Windows x64 | Custom command | none needed, or the agent's own sign-in done beforehand | tested with fakes and replays; manual smoke pending |
| Windows x64 | Custom command | `agent` | tested with fakes |
| Windows x64 | Custom command | `terminal` (PTY) | tested with a fake PTY |
| Windows arm64 | Custom command | `terminal` | untested: `node-pty` has no prebuild, so Mousse advertises `auth.terminal: false` and agents do not offer terminal methods |
| macOS arm64, Linux x64, Linux arm64 | Custom command | any | untested: no machine in this PR's runs |
| any | managed | any | see "Registry agents" below |

## Registry agents (installed by Mousse)

Added from Add provider → **More ACP agents…**. Mousse installs the version the ACP registry lists
now, into the installation (shared by every profile), and runs it from its install record only.

| OS | Distribution | Sign-in | State |
|---|---|---|---|
| Windows x64 | binary with a registry checksum | none (start-up check only) | tested live: `amp-acp` 0.10.0 installed, started (`initialize`) and deleted |
| Windows x64 | npm package (`npx`) | none (start-up check only) | tested live: `pi-acp` 0.0.34 installed with the user's npm, started and deleted |
| Windows x64 | binary without a registry checksum | any | tested with a local server and fakes (consent, receipt, changed files) |
| Windows x64 | any | `agent`, `terminal` | untested live: signing in to a real account was out of scope; the sign-in code is the Custom command's |
| Windows arm64 | binary | any | untested: no machine; Mousse picks the `windows-aarch64` build, else `windows-x86_64` |
| macOS arm64, Linux x64, Linux arm64 | any | any | untested: no machine in this PR's runs; archive modes and the executable check are covered by tests |
| any | Python (`uvx`) | any | not supported yet: listed, with "Add it as a Custom command running uvx …" |
| any | tar.bz2 or a raw executable | any | not supported: listed with the reason |

- **What a launch checks.** Before each agent process starts, Mousse rehashes every file of the
  install against its receipt (binary agents: the unpacked download; npm agents: everything npm
  installed under the prefix) and checks that the receipt is the one the entry was installed with.
  Any added, changed or missing file refuses the launch; the card shows "Installed files changed
  since install" and offers Reinstall. A link in the install counts only when it is relative and
  resolves inside it (its target is then checked like any other file). A launch within a few seconds
  of a full check reuses it; Recheck always checks every file.
- **Agents that write into their own install folder** (a cache, a module built on first run) fail
  this check on their next start, by design. Reinstall clears it; such an agent is better added as
  a Custom command.
- **Downloads** are checked against the registry's SHA-256 when it has one, capped at 1 GiB, and may
  redirect only on their own host or from github.com to GitHub's asset hosts. A download without a
  registry checksum needs an explicit yes for that version and URL; an update asks again.
- **npm agents** need Node.js and npm on your PATH. Mousse downloads the package from
  registry.npmjs.org itself and checks it against the sha512 the npm registry publishes for that
  version (recorded in the receipt). npm then installs that file with `--ignore-scripts`, its
  dependencies from the same registry only, and none of your npm setup: empty user and global
  config, its own cache and home, no `npm_config_*` variables and no credentials. The package's
  command runs with Node.
- **Shared files.** Each profile records which versions its entries use. "Delete downloaded files"
  lists the other profiles still using them and offers "Delete anyway". After an update the old
  version is deleted once nothing runs from it; one Windows still locks is retried at the next start.

## Cursor

Cursor runs through `@cursor/sdk`, bundled with Mousse and hosted in a process of its own per
Cursor entry. There is nothing to install or find on PATH.

| OS | Sign-in | State |
|---|---|---|
| Windows x64 | Cursor account (browser link shown in Mousse) | tested with a fake SDK and host replays; manual smoke pending (needs a Cursor account) |
| Windows x64 | API key | tested with a fake SDK and host replays; manual smoke pending |
| Windows x64 | packaged build (`app.asar.unpacked` helpers) | `scripts/check-packaged-helpers.mjs`; see the PR for the run |
| Windows arm64 | any | untested: the SDK publishes no `win32-arm64` platform package, so `rg` and the sandbox helper are missing |
| macOS arm64, Linux x64, Linux arm64 | any | untested: no machine in this PR's runs |

- Each Cursor entry keeps its own key in Mousse's vault and its agents in its own store. Mousse
  never reads `~/.cursor/sdk/auth.json` or an ambient `CURSOR_API_KEY`.
- Cursor approves its tools itself (Auto-review on), so it runs only chats a person drives.
- Signing out forgets the key in Mousse. A key minted by an account sign-in stays valid on Cursor's
  side until it expires (90 days) unless revoked at cursor.com/dashboard.
- A model API entry `pi:cursor` keeps working on the Mousse agent until the user moves it to a
  Cursor entry (Move…, optionally with the same API key).

## Grok

Grok runs xAI's `grok` CLI over ACP. Every process (version check, start-up check, model refresh,
sign-in check, chat) runs `grok --permission-mode default agent --no-leader stdio`, so a home
`config.toml` that sets always-approve still asks Mousse before each tool.

| OS | Source | Sign-in | State |
|---|---|---|---|
| Windows x64 | PATH (`~/.grok/bin`, official installer) | Grok account (`grok login --device-auth` in a Mousse terminal) | tested with fakes; manual smoke pending |
| Windows x64 | PATH | API key | tested with fakes; manual smoke pending |
| Windows x64 | managed (`@xai-official/grok-win32-x64` from npm, private home only) | Grok account | install tested against a local registry; manual smoke pending |
| Windows arm64 | any | Grok account | untested: no `node-pty` prebuild, so sign-in falls back to Grok's browser sign-in over ACP |
| macOS arm64, Linux x64, Linux arm64 | any | any | untested: no machine in this PR's runs |

- **Status without a process.** Mousse reads the credential Grok would use: an `XAI_API_KEY` (the
  entry's own key wins over an inherited one), else the home's `auth.json`. Any of `GROK_AUTH*`,
  `GROK_OAUTH2_*`, `GROK_OIDC_*`, `GROK_CONFIG`, `GROK_CONFIG_PATH`, `GROK_LOCAL_AUTH`,
  `GROK_CLI_CHAT_PROXY_BASE_URL`, `GROK_MODELS_BASE_URL`, or an `[auth]`, `[grok_com_config]` or
  `[endpoints]` table in the home's or the system's (`/etc/grok`, `%ProgramData%\grok`)
  `config.toml`, `managed_config.toml` or `requirements.toml` makes the account unknown: chats then
  hand their history over instead of resuming Grok's own session.
- **Private homes** never inherit those variables or an ambient `XAI_API_KEY`. A device sign-in runs
  in a staging home; its `auth.json` is copied in only when `grok login` succeeds and was not
  cancelled.
- **Updates.** Mousse sets `GROK_DISABLE_AUTOUPDATER=1` on every check and sign-in, and on chats of a
  managed copy. A copy from the official installer offers `grok update`.
- **Managed copies.** The npm platform package holds only the compressed `grok`; its helpers
  (`grove`, `grove-credential`, `grove-fsmonitor`) are not in it, so Grok fetches them into its
  home. Mousse therefore installs its own Grok only for an entry with its own home. The download is
  checked against the npm registry's sha512 and recorded like a registry agent.
- **Permissions.** Grok's "always allow" options last for the whole project, so only "Allow edits for
  this session" is offered; the others are hidden.
- A model API entry `pi:xai` keeps working on the Mousse agent until the user moves it to a Grok
  entry (Move…, optionally with the same API key). An xAI account sign-in is not carried over: sign
  in to Grok on its entry.

## Notes

- A Custom command runs without a shell. A name without a path is looked up on PATH; a `.cmd`
  shim counts only once it resolves to the program it runs.
- In `initialize`, Mousse advertises `auth.terminal` (only where `node-pty` loads) and
  `elicitation.url`. URL elicitations are answered only during a sign-in; during a turn they are
  declined. Auth method types that are not part of ACP (such as `env_var` drafts) are ignored, and
  Mousse stores no agent secrets of its own.
- Mousse cannot read which account an arbitrary agent runs as, so it never resumes a native session
  across turns: every turn after the first starts a new session and hands the chat history over.
- A generic agent approves tools itself, so it runs only chats a person drives (no delegation,
  workflows, definitions or titles), and the first turn of each chat says so.
- Mousse neither enables nor disables an agent's own telemetry; see each agent's documentation.

## Kept sign-ins

- Removing a provider, or turning it off on this device, stops the chats running on it and tells
  each one why. Turning it off deletes nothing.
- A removed provider with a private home leaves `<profile>/harness/<id>/home`, and the sign-in in it,
  on disk; Mousse's own settings and saved sessions for it are deleted. Adding the same name again
  creates a new id with a fresh home, because an id whose directory is still on disk is never reused.
- A key Mousse stores itself for a bundled agent (Cursor) is not in a private home and is deleted
  with the provider.
- To remove a kept sign-in, sign out before removing the provider, or delete the directory by hand
  afterwards. A home with no files in it, or none at all, is deleted with the provider; a home Mousse
  cannot read is left in place.
