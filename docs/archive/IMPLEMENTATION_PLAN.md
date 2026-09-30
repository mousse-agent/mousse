# Mousse Implementation Plan

## Phase 1: Project Scaffold ✅

- [x] Initialize `package.json` with electron-vite, React, TypeScript
- [x] Configure `electron.vite.config.ts` (main, preload, renderer)
- [x] Create `README.md` with setup/run instructions

## Phase 2: Main Process Core

### 2.1 App Shell
- Electron window with min size, preload script
- Register all IPC handlers on `app.whenReady`

### 2.2 Agent Registry & Task Queue
- In-memory stores with event emitters for push updates to renderer
- CRUD: create agent, update status, list agents/tasks

### 2.3 Worktree Manager
- Detect git repo root (walk up from cwd or env `MOUSSE_REPO_ROOT`)
- `createWorktree(agentId)` → path + branch
- `mergeWorktrees(agentIds)` → merge branches, remove worktrees
- Graceful fallback when not in a git repo (temp dirs for demo)

### 2.4 PTY Manager
- `node-pty` with PowerShell on Windows
- Map `ptyId` → PTY instance + onData forward to renderer
- Launch agent CLI command from macro config after shell ready

### 2.5 Macro System
- `MacroProvider` interface + `MacroEngine` registry
- JSON configs in `macros/`
- Three providers: Claude Code, Codex, OpenCode
- `Win32MacroExecutor`: PowerShell script for click/paste/key
- `runMacro(agentId, prompt)` called after terminal focused

### 2.6 Orchestrator Service
- `LlmClient` with OpenAI + Anthropic adapters
- System prompt describing JSON action format
- `parseActions()` extracts fenced JSON blocks
- `executeSpawnAgents`, `executeCompleteTask` wired to other services

## Phase 3: Preload & IPC

- Typed `MousseAPI` on `window.mousse`
- Subscribe pattern for `agents:updated`, `tasks:updated`, `pty:data`, `orchestrator:response`

## Phase 4: Renderer UI

### 4.1 Layout
- CSS grid/flex: sidebar 30% (resizable drag handle), terminal area 70%
- Dark theme consistent with dev tools aesthetic

### 4.2 Orchestrator Chat
- Message bubbles (user / assistant / system)
- Input + send button
- Loading state during LLM call

### 4.3 Terminal Panel
- Tab per agent (label = cliType + short id)
- xterm.js instance per tab, fit on resize
- Forward keystrokes via `pty:write`

### 4.4 Agents/Tasks Modal
- Header button opens dropdown modal
- Two sections: Running Agents table, Tasks list with status badges
- Auto-refresh via IPC events

## Phase 5: Integration & Wiring

1. User sends orchestrator message
2. LLM responds with `spawn_agents` JSON
3. For each agent:
   - Create task (pending → in_progress)
   - Create worktree
   - Spawn PTY in worktree, run CLI
   - Run macro with task prompt
   - Update agent status → running
4. User/orchestrator sends `complete_task`
5. Merge worktrees, close PTYs, mark completed

## Phase 6: Verification

- `npm install`
- `npm run dev` — app launches without errors
- Manual test: send "spawn 2 agents for claude-code and codex" (mock LLM if no API key)
- Verify worktree creation in `.mousse-worktrees/`
- Verify terminal tabs appear

## MVP Limitations (documented)

| Area | Limitation |
|------|------------|
| Macros | Coordinates are config placeholders; user must tune per display/DPI |
| LLM | Requires API key; fallback mock orchestrator when absent |
| Merge | Simple `git merge` — conflicts surfaced as errors |
| CLI binaries | Assumes `claude`, `codex`, `opencode` on PATH |
| Multiplexer | Tabbed UI, not true tmux-style splits |

## File Checklist

```
package.json
electron.vite.config.ts
tsconfig.json
tsconfig.node.json
README.md
macros/claude-code.json
macros/codex.json
macros/opencode.json
src/main/index.ts
src/main/orchestrator/OrchestratorService.ts
src/main/orchestrator/LlmClient.ts
src/main/orchestrator/systemPrompt.ts
src/main/worktree/WorktreeManager.ts
src/main/terminals/PtyManager.ts
src/main/macros/types.ts
src/main/macros/MacroEngine.ts
src/main/macros/providers/*.ts
src/main/macros/Win32MacroExecutor.ts
src/main/agents/AgentRegistry.ts
src/main/tasks/TaskQueue.ts
src/main/ipc/registerIpc.ts
src/preload/index.ts
src/preload/api.d.ts
src/renderer/index.html
src/renderer/main.tsx
src/renderer/App.tsx
src/renderer/components/*.tsx
src/renderer/styles/*.css
src/shared/types.ts
```

## Estimated Dependency Versions

- electron ^33
- electron-vite ^2
- react ^18
- node-pty ^1
- @xterm/xterm ^5
- simple-git ^3
- openai ^4, @anthropic-ai/sdk ^0.32
- uuid ^11
- zustand ^5
