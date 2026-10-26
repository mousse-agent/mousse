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
