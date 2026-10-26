# Agent setup matrix

Which agent setups Mousse has been tested with. Each agent PR marks its own cells. A cell not marked
"tested" is untested, with the reason.

Axes:

- **OS:** Windows x64, Windows arm64, macOS arm64, Linux x64, Linux arm64.
- **Source:** on PATH, installed by Mousse (managed), Custom command.
- **Sign-in:** account in a terminal (PTY), account in a browser (ACP `agent` method), API key (`env_var`).

## Generic ACP agent (Custom command)

| OS | Source | Sign-in | State |
|---|---|---|---|
| Windows x64 | Custom command | none needed, or the agent's own sign-in done beforehand | tested with fakes and replays; manual smoke pending |
| Windows x64 | Custom command | API key (`env_var`) | tested with fakes |
| Windows x64 | Custom command | terminal (PTY) | tested with a fake PTY |
| Windows arm64 | Custom command | terminal (PTY) | untested: `node-pty` has no prebuild, so terminal methods are not offered |
| macOS arm64, Linux x64, Linux arm64 | Custom command | any | untested: no machine in this PR's runs |
| any | managed | any | not available yet (PR B adds managed installs) |

## Notes

- A Custom command runs without a shell. A name without a path is looked up on PATH; a `.cmd`
  shim counts only once it resolves to the program it runs.
- A generic agent approves tools itself, so it runs only chats a person drives (no delegation,
  workflows, definitions or titles), and the first turn of each chat says so.
- Mousse neither enables nor disables an agent's own telemetry; see each agent's documentation.
