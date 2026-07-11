# Mousse Architecture

Mousse is an Electron desktop orchestrator for "vibe coding" — it coordinates multiple CLI coding agents in isolated git worktrees, each running in its own terminal pane, with automated mouse/keyboard macros to drive agent UIs.

## High-Level Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Renderer (React)                          │
│  ┌──────────────────┐  ┌──────────────────────────────────────┐ │
│  │ Orchestrator Chat │  │     Terminal Multiplexer (xterm.js)  │ │
│  │    (sidebar)      │  │  [Agent 1] [Agent 2] [Agent 3] ...   │ │
│  └────────┬─────────┘  └──────────────────┬───────────────────┘ │
│           │ IPC                            │ IPC (pty I/O)       │
└───────────┼────────────────────────────────┼─────────────────────┘
            ▼                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Main Process                             │
│  ┌─────────────┐ ┌──────────────┐ ┌──────────┐ ┌──────────────┐ │
│  │ Orchestrator│ │ WorktreeMgr  │ │ PtyMgr   │ │ MacroEngine  │ │
│  │   (LLM)     │ │ (simple-git) │ │(node-pty)│ │ (providers)  │ │
│  └─────────────┘ └──────────────┘ └──────────┘ └──────────────┘ │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ MCP Registry/Manager + Skills Registry + Agent Adapters      │ │
│  └─────────────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │              AgentRegistry + TaskQueue                       │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Core Modules

### 1. Main Process (`src/main/`)

| Module | Responsibility |
|--------|----------------|
| `index.ts` | App lifecycle, window creation, IPC registration |
| `orchestrator/OrchestratorService.ts` | LLM chat, system prompt, parse spawn/complete actions |
| `worktree/WorktreeManager.ts` | `git worktree add/remove`, merge on completion |
| `terminals/PtyManager.ts` | Spawn PTY per agent, route I/O to renderer |
| `macros/MacroEngine.ts` | Load configs, dispatch to provider implementations |
| `integrations/mcp/*` | Discover MCP config, redact renderer payloads, manage main-process MCP clients |
| `integrations/skills/*` | Discover and load `SKILL.md` descriptors and content |
| `integrations/agents/*` | Render selected integrations to each spawned CLI's standard config shape |
| `agents/AgentRegistry.ts` | Track agents (id, cliType, worktree, ptyId, status) |
| `tasks/TaskQueue.ts` | Pending / in_progress / completed tasks |

### 2. Macro System (`src/main/macros/`)

Modular provider pattern:

```
MacroProvider (interface)
├── ClaudeCodeMacroProvider
├── CodexMacroProvider
└── OpenCodeMacroProvider
```

Each provider reads JSON config from `macros/<agent>.json`:

```json
{
  "name": "claude-code",
  "windowTitlePattern": "claude",
  "steps": [
    { "type": "click", "x": 120, "y": 680 },
    { "type": "delay", "ms": 300 },
    { "type": "paste", "usePrompt": true },
    { "type": "key", "key": "Enter" }
  ]
}
```

**MVP execution path (Windows):**
- Primary: PowerShell `Add-Type` Win32 APIs for `SetCursorPos`, `mouse_event`, `SendKeys`
- Config coordinates are relative to terminal window rect (resolved via `user32` window enumeration)
- Steps run sequentially with configurable delays

### 3. Git Worktrees (`src/main/worktree/`)

Flow per agent spawn:

1. `git worktree add ../mousse-worktrees/agent-<uuid> -b mousse/agent-<uuid>`
2. Agent record stores `worktreePath`, branch name
3. PTY `cwd` set to worktree path
4. Selected MCP/Skills integrations are prepared for the target CLI if no user-owned standard config conflicts
5. CLI launched (`claude`, `codex`, `opencode`, `cursor-agent` — configurable command in macro config)

On orchestrator `complete_task`:

1. For each agent worktree: `git merge mousse/agent-<id>` into current branch (or cherry-pick strategy)
2. `git worktree remove` + branch cleanup
3. Close PTY sessions
4. Mark tasks completed

### 4. Terminal Multiplexing

- **Backend:** `node-pty` spawns shell (PowerShell on Windows) with agent CLI
- **Frontend:** `@xterm/xterm` + `FitAddon` per pane in a CSS grid
- **IPC:** `pty:create`, `pty:write`, `pty:resize`, `pty:data` (main → renderer)
- Tabbed or grid layout; MVP uses tab bar + single active xterm with switcher

### 5. Orchestrator (Pi Agent)

- Configurable provider via in-app Settings (API key or OAuth); credentials stored in `~/.mousse/auth.json`
- System prompt encodes available actions as JSON blocks in assistant replies
- Parsed actions:
  - `spawn_agents`: `[{ cliType, task }]`
  - `complete_task`: `{ merge: true }`
  - `message`: plain text to user
- MCP tools are discovered lazily from selected servers and exposed to pi-ai as `mcp__<server>__<tool>` provider-safe tool names.
- Skills are summarized in the dynamic system prompt; the model can call `list_skills` and `load_skill`, while `/skill-name` user input loads that skill explicitly.

```
OrchestratorService
  → chat(messages) → LLM
  → MCP/Skill tool loop when stopReason === "toolUse"
  → parseActions(response) → Action[]
  → executeActions() → AgentRegistry, WorktreeManager, MacroEngine
```

### 6. MCP And Skills Integration

MCP runtime is main-process only. `McpRegistry` reads standard config locations and returns source-scoped diagnostics. `McpManager` starts SDK clients lazily, caches connections, lists tools with timeouts, executes tool calls, and closes transports on app quit or restart. Renderer-facing payloads are redacted; env/header secrets are never sent unless they are environment-variable references.

Standard MCP sources:

- Cursor: `~/.cursor/mcp.json`, `<project>/.cursor/mcp.json`
- Claude Code: `<project>/.mcp.json`
- Codex: `<project>/.codex/config.toml`
- OpenCode: `<project>/opencode.json`, `<project>/.opencode/opencode.json`

Skills are discovered from `.cursor/skills`, `.agents/skills`, `.claude/skills`, `.codex/skills`, `.opencode/skills`, and supported global equivalents. `SkillsRegistry` parses YAML frontmatter, marks duplicate names by precedence, records scripts/assets/references metadata, and reads `SKILL.md` content only through explicit main-process APIs.

Spawned CLI agents do not use the MCP runtime directly. `AgentConfigManager` converts normalized MCP servers and selected Skills back into each CLI's standard files:

- Claude Code: `.mcp.json`, `.claude/skills`, `.agents/skills`
- Codex: `.codex/config.toml`, `.codex/skills`, `.agents/skills`
- OpenCode: `opencode.json`, `.opencode/skills`
- Cursor Agents CLI: `.cursor/mcp.json`, `.cursor/skills`, `.agents/skills`

Generated files are written only when the worktree does not already contain the user-owned standard file. They are tracked for cleanup before task completion/merge.

### 7. Renderer (`src/renderer/`)

| Component | Role |
|-----------|------|
| `App.tsx` | Split layout (resizable sidebar ~30%) |
| `OrchestratorChat.tsx` | Message list + input, streams orchestrator replies |
| `TerminalPanel.tsx` | Tab bar + xterm instances bound to pty IDs |
| `AgentsTasksModal.tsx` | Dropdown modal: running agents + task statuses |
| `stores/appStore.ts` | Zustand: agents, tasks, messages, active terminal |

### 8. IPC Contract

| Channel | Direction | Payload |
|---------|-----------|---------|
| `orchestrator:send` | R→M | `{ content }` |
| `orchestrator:response` | M→R | `{ message, actions? }` |
| `agents:list` | R→M / M→R | Agent[] |
| `tasks:list` | R→M / M→R | Task[] |
| `pty:create` | R→M | `{ agentId, cwd, shell }` → `{ ptyId }` |
| `pty:write` | R→M | `{ ptyId, data }` |
| `pty:resize` | R→M | `{ ptyId, cols, rows }` |
| `pty:data` | M→R | `{ ptyId, data }` |
| `macro:run` | M (internal) | `{ agentId, prompt, hwnd? }` |
| `mcp:listServers` | R→M | redacted `McpServerConfig[]` |
| `mcp:listTools` | R→M | redacted MCP tool descriptors |
| `mcp:testServer` / `mcp:restartServer` | R→M | main-process runtime operations |
| `mcp:writeCursorConfig` | R→M | controlled Cursor-compatible config write |
| `skills:list` / `skills:read` | R→M | descriptor listing and safe `SKILL.md` read |

### 9. Security

- `contextIsolation: true`, `nodeIntegration: false`
- Preload exposes typed `window.mousse` API only
- API keys managed in main process via `ProviderAuthService` (never exposed to renderer)
- MCP subprocesses, HTTP headers, tool calls, and Skill file reads stay in the main process; renderer APIs receive redacted summaries.

## Data Models

```typescript
type CliType = 'claude-code' | 'codex' | 'opencode' | 'cursor-agents-cli'
type AgentStatus = 'starting' | 'running' | 'merging' | 'completed' | 'failed'
type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

interface Agent {
  id: string
  cliType: CliType
  worktreePath: string
  branch: string
  ptyId: string
  status: AgentStatus
  task: string
}

interface Task {
  id: string
  agentId?: string
  description: string
  status: TaskStatus
}
```

## Directory Layout

```
mousse/
├── docs/
├── macros/                    # JSON macro configs per CLI
├── src/
│   ├── main/
│   │   ├── index.ts
│   │   ├── orchestrator/
│   │   ├── worktree/
│   │   ├── terminals/
│   │   ├── macros/
│   │   ├── agents/
│   │   └── tasks/
│   ├── preload/
│   └── renderer/
├── electron.vite.config.ts
├── package.json
└── README.md
```

## Extension Points

- **New CLI agent:** Add `macros/<name>.json` + `*MacroProvider.ts` implementing `MacroProvider`
- **New LLM:** Implement `LlmClient` interface in orchestrator
- **Linux/macOS macros:** Swap `Win32MacroExecutor` for platform-specific executor implementing `MacroExecutor`
- **New integration adapter:** Extend `AgentConfigManager` rendering/materialization for the target CLI's standard config files
