# Agent setup matrix

<!-- Generated from setup-matrix.json by scripts/gen-setup-matrix.mjs. Edit the JSON, then run the script. -->

Which agent setups Mousse has been tested with, for each operating system, where the agent comes from
and how it signs in. "Tested" names the pull request whose description records the run; every other
cell says why it is untested or not supported. See [agent-setup.md](agent-setup.md) for how each setup
works and [compatibility.md](compatibility.md) for the agent versions.

- **Source:** On PATH, Installed by Mousse, Custom command or executable, Ships with Mousse.
- **Sign-in:** Account in the agent's home, Sign-in in Mousse, API key, Cloud credentials from the environment.

## Claude Code

| Source | Sign-in | OS | State |
|---|---|---|---|
| On PATH | Account in the agent's home | Windows x64 | Tested (#86, #139) |
| On PATH | Account in the agent's home | Windows arm64 | Untested: No Windows arm64 machine in the runs. The node-pty prebuild is not packaged there, so an entry with its own home shows the sign-in command to copy instead of a terminal. |
| On PATH | Account in the agent's home | macOS arm64, Linux x64, Linux arm64 | Untested: No macOS or Linux machine in the runs. A second account in its own home was tested with a fake CLI and a fake terminal (#285). |
| Custom command or executable | Account in the agent's home | Windows x64, Windows arm64, macOS arm64, Linux x64, Linux arm64 | Untested: An executable set in Settings starts like the one on PATH; it was not run separately. |
| On PATH | API key | Windows x64, Windows arm64, macOS arm64, Linux x64, Linux arm64 | Untested: Tested with a fake CLI only; no run with a real key. |

## Codex

| Source | Sign-in | OS | State |
|---|---|---|---|
| On PATH | Account in the agent's home | Windows x64 | Tested (#86) |
| On PATH | Account in the agent's home | Windows arm64 | Untested: No Windows arm64 machine in the runs. The node-pty prebuild is not packaged there, so an entry with its own home shows the sign-in command to copy instead of a terminal. |
| On PATH | Account in the agent's home | macOS arm64, Linux x64, Linux arm64 | Untested: No macOS or Linux machine in the runs. A second account in its own home was tested with a fake CLI, terminal and app-server (#331). |
| Custom command or executable | Account in the agent's home | Windows x64, Windows arm64, macOS arm64, Linux x64, Linux arm64 | Untested: An executable set in Settings starts like the one on PATH; it was not run separately. |
| Installed by Mousse | Sign-in in Mousse | Windows x64, Windows arm64, macOS arm64, Linux x64, Linux arm64 | Untested: Sign in with ChatGPT was tested against a local fake ChatGPT server (#227); no real sign-in was made. |

## Antigravity

| Source | Sign-in | OS | State |
|---|---|---|---|
| Installed by Mousse | Sign-in in Mousse | Windows x64, Windows arm64, macOS arm64, Linux x64, Linux arm64 | Untested: Install and Google sign-in were tested with fakes and replays (#157); no live install or sign-in. |
| Custom command or executable | Sign-in in Mousse | Windows x64, Windows arm64, macOS arm64, Linux x64, Linux arm64 | Untested: An executable set in Settings (with its helper beside it) was not run separately. |

## Grok

| Source | Sign-in | OS | State |
|---|---|---|---|
| On PATH | Account in the agent's home | Windows x64, macOS arm64, Linux x64, Linux arm64 | Untested: Device sign-in in a Mousse terminal was tested with a fake grok (#226); no real sign-in. |
| On PATH | Account in the agent's home | Windows arm64 | Untested: The node-pty prebuild is not packaged, so sign-in falls back to Grok's browser sign-in over ACP; not run. |
| On PATH | API key | Windows x64, Windows arm64, macOS arm64, Linux x64, Linux arm64 | Untested: Tested with a fake grok (#226); no run with a real key. |
| Installed by Mousse | Account in the agent's home | Windows x64, Windows arm64, macOS arm64, Linux x64, Linux arm64 | Untested: Install from npm was tested against a local registry (#226); only for an entry with its own home. No real sign-in. |
| Installed by Mousse | API key | Windows x64, Windows arm64, macOS arm64, Linux x64, Linux arm64 | Untested: Install from npm was tested against a local registry (#226); no run with a real key. |
| Custom command or executable | Account in the agent's home | Windows x64, Windows arm64, macOS arm64, Linux x64, Linux arm64 | Untested: An executable set in Settings starts like the one on PATH; it was not run separately. |

## Cursor

| Source | Sign-in | OS | State |
|---|---|---|---|
| Ships with Mousse | Sign-in in Mousse | Windows x64 | Untested: Tested with a fake SDK and host replays (#210); a live sign-in needs a Cursor account. |
| Ships with Mousse | API key | Windows x64 | Untested: Tested with a fake SDK and host replays (#210); no run with a real key. |
| Ships with Mousse | Sign-in in Mousse | Windows arm64 | Not supported: The Cursor SDK publishes no win32-arm64 package, so its rg and sandbox helpers are missing. |
| Ships with Mousse | API key | Windows arm64 | Not supported: The Cursor SDK publishes no win32-arm64 package, so its rg and sandbox helpers are missing. |
| Ships with Mousse | Sign-in in Mousse | macOS arm64, Linux x64, Linux arm64 | Untested: No macOS or Linux machine in the runs. |
| Ships with Mousse | API key | macOS arm64, Linux x64, Linux arm64 | Untested: No macOS or Linux machine in the runs. |

## Model APIs (Mousse agent, Pi)

| Source | Sign-in | OS | State |
|---|---|---|---|
| Ships with Mousse | API key | Windows x64, macOS arm64, Linux x64 | Tested (#369) |
| Ships with Mousse | API key | Windows arm64, Linux arm64 | Untested: No arm64 Windows or Linux machine in the runs. |
| Ships with Mousse | Sign-in in Mousse | Windows x64, Windows arm64, macOS arm64, Linux x64, Linux arm64 | Untested: Provider sign-ins (Copilot, Kimi, Meta) run in Mousse and Pi gets only the access token; tested with fakes, not with a real account. |
| Ships with Mousse | Cloud credentials from the environment | Windows x64, Windows arm64, macOS arm64, Linux x64, Linux arm64 | Untested: Amazon Bedrock and Google Vertex credentials from the environment were tested with fakes only. |

## ACP agent (Custom command)

| Source | Sign-in | OS | State |
|---|---|---|---|
| Custom command or executable | Account in the agent's home | Windows x64 | Untested: Tested with fakes, a fake terminal and replays (#199); a run with a real agent is pending. |
| Custom command or executable | Account in the agent's home | Windows arm64 | Untested: The node-pty prebuild is not packaged, so Mousse tells agents it has no terminal and they offer no terminal sign-in. |
| Custom command or executable | Account in the agent's home | macOS arm64, Linux x64, Linux arm64 | Untested: No macOS or Linux machine in the runs. |

## ACP agents from the registry

| Source | Sign-in | OS | State |
|---|---|---|---|
| Installed by Mousse | Account in the agent's home | Windows x64 | Untested: Installed, started and deleted live without a sign-in (#206: amp-acp 0.10.0, pi-acp 0.0.34); chatting needs each agent's own account. |
| Installed by Mousse | Account in the agent's home | Windows arm64 | Untested: No Windows arm64 machine. Mousse picks the windows-aarch64 build, else windows-x86_64. |
| Installed by Mousse | Account in the agent's home | macOS arm64, Linux x64, Linux arm64 | Untested: No macOS or Linux machine in the runs; archive modes and the executable check are covered by tests. |
