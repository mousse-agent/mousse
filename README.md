<p align="center">
  <img src="mousse_logo_icon.svg" alt="Mousse" width="96" height="96" />
</p>

<h1 align="center">Mousse</h1>

<p align="center">
  <strong>Desktop orchestrator for multi-agent vibe coding.</strong><br />
  Run several CLI coding agents in parallel — each in its own git worktree and terminal — from a single orchestrator chat.
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#contributing">Contributing</a> ·
  <a href="#license">License</a>
</p>

---

## What is Mousse?

Mousse is an **Electron desktop app** that coordinates multiple terminal-based coding agents (Claude Code, Codex, OpenCode, Cursor Agents CLI, and more). You describe work in natural language; the orchestrator LLM plans tasks, spawns agents into isolated [git worktrees](https://git-scm.com/docs/git-worktree), and merges results when work completes.

Think of it as a **control plane** for agentic development: one chat on the left, a multiplexer of live terminals on the right, and automation that wires prompts, permissions, MCP tools, and skills into each agent session.

## Features

| Capability | Description |
|------------|-------------|
| **Orchestrator chat** | Pi-style LLM plans and dispatches `spawn_agents`, `complete_task`, and tool calls |
| **Terminal multiplexer** | Tabbed [xterm.js](https://xtermjs.org/) panes backed by [node-pty](https://github.com/microsoft/node-pty) |
| **Git worktrees** | One isolated worktree per agent; merge on task completion |
| **Macro engine** | JSON-driven UI automation to deliver prompts to each CLI |
| **MCP integration** | Discovers standard MCP configs; exposes selected tools to the orchestrator |
| **Agent Skills** | Loads `SKILL.md` folders from Cursor, Claude, Codex, and OpenCode conventions |
| **Provider auth** | API key and OAuth login via Settings — credentials stored locally in `~/.mousse/` |
| **Mock mode** | Run without API keys for local development and demos |

## Quick Start

### Prerequisites

- **Node.js** 18 or later
- **npm** 9+
- **Git** (for worktree support)
- **Windows 10+** (primary target; macros use Win32 APIs)

Optional CLI tools on `PATH`: `claude`, `codex`, `opencode`, `cursor-agent`

### Install and run

```bash
git clone https://github.com/bvsr365/mousse.git
cd mousse
npm install
npm run dev
```

### Configure LLM providers

Open **Settings → Providers** in the app to add an API key or sign in with OAuth. No `.env` file is required. Credentials are stored in `~/.mousse/auth.json` on your machine and never sent to the renderer process.

For development without external APIs, use **Mock** mode in Settings.

## Usage

1. Open Mousse inside a git repository (or point it at one from Settings).
2. In the orchestrator chat, try prompts like:
   - `spawn agents for claude-code and codex`
   - `start agents to implement the login page`
   - `complete task and merge`
3. Watch agent terminals appear in the right panel.
4. Open the **Agents** view to monitor status.
5. When a task completes, worktrees merge and terminals close.

### Macro tuning

Edit `macros/*.json` to adjust click coordinates for your display, DPI, and terminal layout:

```json
{ "type": "click", "x": 200, "y": 720 }
```

Coordinates are relative to the terminal window's top-left corner.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Renderer (React + Zustand)                                 │
│  Orchestrator chat · Terminal tabs · Settings · File tree   │
└──────────────────────────┬──────────────────────────────────┘
                           │ IPC (contextIsolation)
┌──────────────────────────▼──────────────────────────────────┐
│  Main process (Electron)                                    │
│  OrchestratorService · PtyManager · WorktreeManager         │
│  MacroEngine · McpManager · SkillsRegistry · ProviderAuth   │
└──────────────────────────┬──────────────────────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
   Git worktrees     CLI terminals      MCP / Skills
   (per agent)       (node-pty)         (main process)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design document.

The Electron GUI and the headless `mousse-cli` are both thin shells over the **Mousse Main Service (MMS)** in `src/mms/` — an Electron-free core hosting the orchestrator, scheduled jobs, channels, providers, and integrations. Everything is configured through a single `~/.mousse/mousse.conf`.

Further documentation:

- [docs/CLI.md](docs/CLI.md) — `mousse-cli` usage and headless server/VPS deployment
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) — the unified `~/.mousse/mousse.conf` reference
- [docs/STARTUP.md](docs/STARTUP.md) — launch-on-startup for MMS on Windows, Linux (systemd), and macOS
- [docs/PERFORMANCE.md](docs/PERFORMANCE.md) — GUI smoothness and memory-management audit

## Project structure

```
mousse/
├── docs/                  # Architecture and implementation notes
├── macros/                # Per-CLI macro JSON configs
├── resources/             # App icons
├── src/
│   ├── main/              # Electron main process (thin shell over MMS)
│   ├── mms/               # Mousse Main Service — Electron-free core
│   ├── cli/               # mousse-cli (headless, pi-style interface)
│   ├── preload/           # Typed IPC bridge
│   ├── renderer/          # React UI
│   └── shared/            # Shared types and settings
├── tests/                 # Vitest unit tests
└── package.json
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Electron in development mode |
| `npm run build` | Production build |
| `npm run preview` | Preview production build |
| `npm run typecheck` | TypeScript check (main + renderer) |
| `npm test` | Run Vitest tests |

## Contributing

Contributions are welcome. Please open an issue to discuss significant changes before submitting a pull request.

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Commit with [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, …)
4. Run `npm run typecheck` and `npm test`
5. Open a pull request

## Security

- Renderer runs with `contextIsolation: true` and `nodeIntegration: false`
- API keys and OAuth tokens stay in the main process
- MCP configs are redacted before reaching the renderer; prefer `${env:VAR}` references in project configs

Report security issues privately via GitHub Security Advisories rather than public issues.

## License

[MIT](LICENSE)
