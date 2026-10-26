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
| any | managed | any | not available yet (PR B adds managed installs) |

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
  each one why. Neither deletes a sign-in.
- A removed provider with a private home leaves `<profile>/harness/<id>/home` on disk; Mousse's own
  settings and saved sessions for it are deleted. Adding the same name again creates a new id with a
  fresh home, because an id whose directory is still on disk is never reused.
- To remove a kept sign-in, sign out before removing the provider, or delete the directory by hand
  afterwards. A home with no files in it is deleted with the provider.
