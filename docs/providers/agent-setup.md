# Agent setup

How each agent setup works in Mousse. Which setups were tested on which operating system, and why the
others are not, is in [the setup matrix](setup-matrix.md), generated from `setup-matrix.json`.

## Generic ACP agent (Custom command)

Added from Add provider → **Custom command**: any program that speaks ACP. How Mousse runs it is in
[Notes](#notes) below.

## Registry agents (installed by Mousse)

Added from Add provider → **More ACP agents…**. Mousse installs the version the ACP registry lists
now, into the installation (shared by every profile), and runs it from its install record only.

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
- **Updates.** An entry with its own home runs every process with `GROK_DISABLE_AUTOUPDATER=1` and
  `GROK_OAUTH2_REFERRER=mousse`. An entry on the user's own home runs Grok as the user set it up.
  A copy from the official installer offers `grok update`.
- **Managed copies.** The npm platform package holds only the compressed `grok`; its helpers
  (`grove`, `grove-credential`, `grove-fsmonitor`) are not in it, so Grok fetches them into its
  home. Mousse therefore installs its own Grok only for an entry with its own home, and only that
  entry runs it; every other entry runs its own `grok`. The download is checked against the npm
  registry's sha512 and recorded like a registry agent, and every launch (chats, checks, sign-in,
  sign-out) checks its files first.
- **Sign-out** forgets the key Mousse keeps and a private home's sign-in. It never signs the user's
  own `~/.grok` out.
- **Permissions.** Grok's "always" answers last for the whole project, so only "Allow edits for this
  session" is offered; every other "always allow" and "always deny" is hidden.
- A model API entry `pi:xai` keeps working on the Mousse agent until the user moves it to a Grok
  entry (Move…, optionally with the same API key). An xAI account sign-in is not carried over: sign
  in to Grok on its entry.

## Claude Code, a second account

- An added Claude Code entry with its own home runs every process (status, chats, sign-in, sign-out)
  with `CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR` set to that home (the secure-storage
  variable picks the credential file and the Keychain or Credential Manager item, and wins over the
  config dir) and `ANTHROPIC_CONFIG_DIR` set to a folder inside it, so the user's shared Anthropic
  profile is never read. `HOME` is not changed. Nothing in the `ANTHROPIC_*`, `CLAUDE_*`, `AWS_*`,
  `GOOGLE_*`, `GCLOUD_*`, `CLOUDSDK_*` or `AZURE_*` families is inherited from Mousse's environment
  (no key, token, profile or cloud route of the user's), except `CLAUDE_CODE_GIT_BASH_PATH`.
  Variables set on the entry apply on top, except those that choose where the sign-in lives or which
  credential or route is used: Settings refuses them, a stored one is dropped at launch, and the
  entry says which ones are not used. The variable names were checked against the Claude Code
  2.1.291 binary's text.
- **Sign in** runs `claude auth login` there, starting in the home folder, shows the link (only an
  OAuth authorize address counts), and offers a field for the code Claude may ask for, again after a
  code Claude refuses. It counts only once `claude auth status` in that home says signed in; a
  sign-in that is not finished in ten minutes is ended. A cancel after Claude printed its success
  lets it finish writing its files, then takes the account up. Nothing the terminal prints is
  logged or stored. The command to copy stays beside the button.
- **Sign out** runs `claude auth logout` in that home, and counts only when `claude auth status` there
  then says signed out. A command that cannot start, fails or changes nothing is an error. The user's
  own Claude entry keeps the terminal sign-in and is never signed out by Mousse.
- Sign-in and sign-out refuse a home that is, or sits under, a link or junction: they would act on
  another account's folder.
- **Keychain naming.** Verified for Claude Code 2.1.291: the item name includes a hash of the
  secure-storage folder, so each home has its own. Not verified for the lowest tested version
  (2.0.0); check a second sign-in on macOS does not replace the user's own before relying on it.
- Two entries signed in to the same account say so ("Same account as …").

## Codex, a second account

- Add provider → ChatGPT subscription → Use my Codex CLI, once the user's own Codex is added, adds
  another account on the same `codex` with a home of its own. (A managed entry, which downloads its
  own Codex and signs in with ChatGPT inside Mousse, is a separate setup and is unchanged.) An
  added entry may also be put on the user's own home; it then runs as the built-in does, with the
  terminal sign-in.
- An added entry with its own home runs every process (status, chats, sign-in, sign-out) with
  `CODEX_HOME` and `CODEX_SQLITE_HOME` set to that home. `HOME` is not changed. Nothing in the
  `CODEX_*` (except `CODEX_CA_CERTIFICATE`), `OPENAI_*`, `CHATGPT_*`, `AZURE_*` or `AWS_*` families,
  and no bare `ACCESS_TOKEN`, is inherited from Mousse's environment (no key, token, route, login
  server or cloud credential of the user's). Variables set on the entry apply on top, except those
  families: Settings refuses them, a stored one is dropped at launch, and the entry says which ones
  are not used. The variable names were checked against the text of Codex 0.162's program file,
  which was not run.
- Launch arguments are applied as given, except `-c` / `--config` overrides of `openai_base_url`,
  `chatgpt_base_url`, `sqlite_home`, `log_dir`, `cli_auth_credentials_store`, `model_provider` and
  `model_providers`: they win over the home's `config.toml` and would move the sign-in or the state,
  send the account's token to another address, or route a chat elsewhere. Settings refuses them, a
  stored one is dropped at launch, and the entry says which ones are not used. The sign-in and
  sign-out commands run without the entry's arguments.
- Every message of a private entry about its sign-in names Settings → Providers, never plain
  `codex login`, which would sign in the user's own `~/.codex`. The command to copy sets `CODEX_HOME`
  and `CODEX_SQLITE_HOME`; a terminal's own variables are not cleaned (the in-app sign-in is the one
  that runs on a closed environment). On Windows a profile path with `%` or `"` cannot be quoted for
  `cmd`, so no command is shown and the entry says what to set.
- **Versions.** `--device-auth`, the home's state variable and the per-home credential store were
  checked only against Codex 0.162.1; the lowest tested version is 0.100.0. If Codex is older, the
  sign-in fails with the terminal's exit code or the credential-store message.
- **Not verified.** MCP servers that sign in with OAuth keep their tokens in the operating system's
  credential store under the server's name and address, not per home: an MCP server with the same
  name and address in two homes may share a token on macOS and Windows, and `codex mcp logout` in
  one removes it for the other. Set `mcp_oauth_credentials_store = "file"` in the config.toml of the
  private home to keep them per home. Check on macOS and Windows before relying on separate MCP sign-ins.
- **Sign in** runs `codex login --device-auth` there, starting in the home folder, and shows the link
  and one-time code Codex prints (only the lines under its own sign-in steps, once complete). Every
  Codex process of the home is ended first, because a running one keeps the account it started with
  and would write it back over the new sign-in. It counts only once a new Codex process in that home
  says it is signed in; a sign-in that is not finished in sixteen minutes (the code expires after
  fifteen) is ended. If Codex says it signed in but the home does not hold it, Mousse says Codex may
  be keeping it in the operating system's credential store and how to switch to a file. The link and
  code are shown to the user and never logged or stored.
- **Sign out** ends the home's Codex processes, runs `codex logout` there, and counts only when a new
  Codex process in that home then says signed out. A command that cannot start, fails or changes
  nothing is an error. The user's own Codex entry keeps the terminal sign-in and is never signed
  out by Mousse.
- Starting Codex, signing in and signing out all refuse a home that is, or sits under, a link or
  junction: they would act on another account's folder.
- The home starts empty: the user's own `~/.codex` (its `config.toml`, MCP servers, instructions and
  sessions) is not shared with it, and the entry keeps its own settings and saved chats in its own
  folder. A chat saved under one entry never resumes on another.
- **What stays after removal.** Codex writes its state database, logs, sessions and history into the
  home as soon as it starts there, and `codex logout` removes only the sign-in. So a removed entry
  that ever ran leaves `<profile>/harness/<id>/home` with its chat records on disk (not just the
  sign-in); delete the folder by hand to remove them. Removal waits for the entry's app-server to
  exit (up to ten seconds) before it deletes the rest.
- Two entries signed in with the same email show "Same account as …" even when they are different
  workspaces of that email: Codex reports the email and plan, not the workspace.
- Two entries signed in to the same account say so ("Same account as …").

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
- How a prompt ends. An agent that ends a prompt with `refusal`, `max_tokens` or
  `max_turn_requests` fails the turn with a message naming the agent (what it wrote stays as an
  incomplete reply); one that ends it with `cancelled` when Mousse did not ask for a cancel
  interrupts the turn like Stop. A cancel Mousse asked for (Stop, a steer, or a permission request
  you dismissed or that policy refused) leaves a finished turn with the agent's message. Any other
  ending, including one Mousse does not know, is a finished turn. This holds for Grok's
  `prompt_complete` too.
- An agent that gives no reply and no update for 15 minutes fails the turn with a timeout, and its
  process is ended; the next message starts a new session with the chat history. Time the agent
  spends waiting for you does not count: a permission or file request on the connection, or a
  question from Mousse's own tools (`ask_user`, plans, approvals) on the thread. The bound covers
  the prompt only; an agent that hangs while starting or opening a session is not bounded by it.
- Slash commands. A message that starts with `/` and a command name (`/review src`, not a path
  such as `/tmp/x`) is sent, trimmed, as the first text block, with the chat history as a second
  block; the session instructions are left out of that message and go with the next one. When the
  agent advertised its commands (`available_commands_update`), only an advertised name counts, so
  "/tmp is full" stays text; an agent that advertised none is matched by the shape alone. An agent
  that joins all the blocks before it parses them may still read the command literally. A steer is
  never treated as a command.
- An agent that ignores `session/cancel` (some drop one sent right after the prompt) is ended after
  the cancel deadline, and the next message starts a new session. Agent-specific cancel timing
  belongs in that agent's preset quirks (`harness/acp/quirks.ts`), not in the shared session code.
- **MCP servers set up in Mousse.** Every agent except the Mousse agent reaches them through the
  MCP relay: a second MCP server Mousse attaches, named `mousse-relay`, whose tools are named
  `<server>__<tool>`. Nothing needs to be copied into the agent's own config. A server that is also
  in the agent's own config (or, for Claude Code, one Mousse adds to it directly) shows up twice,
  once under its own name and once under `mousse-relay`. To turn the relay off for an agent, open
  Settings, Skills & MCP, Advanced, and switch that agent off under "Share with other agents".
  Codex and Cursor relayed tools ask in the thread before they run unless the thread is in Full
  access; Claude Code and ACP agents use their own approvals.
- **Agent telemetry.** Each provider has a Telemetry setting, Off or Agent's own setting. Off starts the
  agent with its documented switch (Claude Code, Codex and the Mousse agent have one); the agent's files
  are never edited. See [Privacy and agent telemetry](../CONFIGURATION.md#privacy-and-agent-telemetry).

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
