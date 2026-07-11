# Mousse GUI Performance & Memory Report

Analysis of the Mousse Electron app (`src/main/**`, `src/preload/**`, `src/renderer/**`) with actionable recommendations for smooth rendering, responsive IPC, and stable memory use. Findings are grounded in the current codebase as of this audit.

---

## Executive summary

The largest wins are in the **renderer chat path** (virtualization, memoization, throttled context metering), **PTY IPC batching**, **KeepMounted scope reduction**, and **deferring non-critical main-process startup work** before first paint. Memory risks concentrate in **unbounded scrollback buffers**, **xterm instances that outlive agents**, and **always-mounted heavy panels** (browser webview, terminals).

---

## 1. Renderer smoothness

### 1.1 Message list re-renders entire chat on every streaming token

| | |
|---|---|
| **Symptom** | Assistant streaming stutters; typing in composer feels laggy during long responses; CPU stays elevated for the whole stream. |
| **Root cause** | Each LLM delta calls `updateStreamingAssistantMessage` → `emit('message-updated')` → Zustand `updateMessage`, which replaces the `messages` array (`src/renderer/stores/appStore.ts:107–110`). `OrchestratorChat` subscribes to `messages` (`src/renderer/components/OrchestratorChat.tsx:89`) and maps **all** messages on every update (`728–784`) with no `React.memo` on row components. |
| **Fix** | (a) Memoize `ChatMessageContent` with a custom comparator on `id`, `content`, `streaming`, `kind`, `toolCall`, `thinking`. (b) Store streaming text in a ref or separate `streamingContentById` slice so non-streaming rows do not invalidate. (c) Add windowed virtualization (`@tanstack/react-virtual` or `react-window`) for lists > ~50 messages. |
| **Impact** | High |
| **Effort** | Medium |

### 1.2 Markdown + syntax highlighting re-parsed on unrelated re-renders

| | |
|---|---|
| **Symptom** | Scrolling or expanding tool calls causes visible jank; long threads with code blocks feel sluggish. |
| **Root cause** | `ChatMessageContent` runs full `ReactMarkdown` + `rehypeHighlight` for every completed assistant message (`src/renderer/components/ChatMessageContent.tsx:87–99`). Plugin arrays and inline `components` are recreated every render (`88–96`). No `useMemo` on parsed output. `rehype-highlight` typically registers many highlight.js languages. Tool responses use highlight.js separately (`src/renderer/utils/highlightToolCallResponse.ts:1–21`). Global CSS imports the full atom-one-dark theme (`src/renderer/styles/chat-markdown.css:1`). |
| **Fix** | Memoize `ChatMessageContent`. Hoist `remarkPlugins` / `rehypePlugins` to module scope. Restrict rehype-highlight to a small language subset (or pre-highlight code blocks once and cache by content hash). Consider `marked` + incremental DOM for streaming, markdown only after `streaming: false`. |
| **Impact** | High |
| **Effort** | Medium |

### 1.3 Smooth-scroll on every message change fights user scroll position

| | |
|---|---|
| **Symptom** | Chat “fights” the user while reading history during streaming; unnecessary layout work. |
| **Root cause** | `useEffect` scrolls to bottom whenever `messages` changes (`src/renderer/components/OrchestratorChat.tsx:251–263`), using `behavior: 'smooth'`, which schedules animation frames for the full list. |
| **Fix** | Only auto-scroll when the user is already near the bottom (threshold ~100px). Use `behavior: 'instant'` during streaming deltas; reserve smooth scroll for new user sends. |
| **Impact** | Medium |
| **Effort** | Low |

### 1.4 Context-usage IPC on every keystroke

| | |
|---|---|
| **Symptom** | Composer typing latency; main-process CPU during idle drafting. |
| **Root cause** | `useEffect` calls `window.mousse.orchestrator.getContextUsage` whenever `input`, `attachedFiles`, `voiceMessages`, or `messages` change (`src/renderer/components/OrchestratorChat.tsx:564–610`). Each invoke runs `computeContextUsage` in main (`src/main/orchestrator/contextUsage.ts:37–110`) and clones settings indirectly. |
| **Fix** | Debounce 300–500ms; skip re-fetch when only `input` changes by estimating draft tokens client-side. Share one in-flight request (abort previous). |
| **Impact** | Medium |
| **Effort** | Low |

### 1.5 No component memoization anywhere in renderer

| | |
|---|---|
| **Symptom** | Widespread subtree re-renders when any Zustand slice updates. |
| **Root cause** | Grep shows zero `React.memo` / `memo(` usage under `src/renderer/`. Heavy children (`ThreadsSidebar`, `AgentsPanel`, `ComposerFooter`) re-render on unrelated store updates. |
| **Fix** | Add `memo` to leaf presentation components (`ChatMessageContent`, `ToolCallResponse`, `FileTree` nodes, tab bars). Split Zustand into slices (`messagesStore`, `layoutStore`, `threadsStore`) or use shallow compare selectors. |
| **Impact** | Medium |
| **Effort** | Medium |

### 1.6 KeepMounted keeps six heavy panels alive

| | |
|---|---|
| **Symptom** | High baseline memory; switching tabs does not reduce CPU (git status refresh, webview process, terminals still live). |
| **Root cause** | `MainViewPanel` wraps Agents, Browser, Terminal, Files, Git, Documents in `KeepMounted` (`src/renderer/components/MainViewPanel.tsx:14–33`). `KeepMounted` only sets `hidden` (`src/renderer/components/KeepMounted.tsx:10–15`) — React trees stay mounted, effects keep running. `BrowserPanel` hosts a persistent `<webview partition="persist:mousse-browser">` (`src/renderer/components/BrowserPanel.tsx:184–190`). |
| **Fix** | Mount on first visit; unmount after idle timeout (e.g. 5 min) or when switching away from heavy views. Keep KeepMounted only for fast-toggle views (Agents ↔ Terminal). Lazy-load `BrowserPanel` / `GitPanel` / `FilesPanel` via `React.lazy`. |
| **Impact** | High |
| **Effort** | Medium |

### 1.7 xterm.js: agent terminals never disposed

| | |
|---|---|
| **Symptom** | Memory grows after agents complete; hidden terminal wrappers accumulate. |
| **Root cause** | `AgentsPanel` mounts terminals in `mountTerminal` (`src/renderer/components/AgentsPanel.tsx:66–100`) but has **no** cleanup when agents leave `visibleAgents` (completed/failed filtered at `17–23`). Terminals stay in `instancesRef` and DOM with `display: none` (`165–168`). Contrast `ProjectTerminalPanel.unmountTerminal` which calls `terminal.dispose()` (`src/renderer/components/ProjectTerminalPanel.tsx:42–51`). |
| **Fix** | On agent removal/completion: `terminal.dispose()`, remove wrapper DOM, delete from `instancesRef`, `pty.kill` if still active. Mirror project-terminal lifecycle. |
| **Impact** | High |
| **Effort** | Low |

### 1.8 xterm: no scrollback cap; all project tabs stay mounted

| | |
|---|---|
| **Symptom** | Long-running shells increase renderer memory; many tabs multiply cost. |
| **Root cause** | `new Terminal({...})` omits `scrollback` (defaults 1000 lines × N terminals) in `useXtermTerminal.ts:52–57`, `ProjectTerminalPanel.tsx:82–87`, `AgentsPanel.tsx:71–76`. All tab PTYs mount xterm wrappers hidden via `display: none` (`ProjectTerminalPanel.tsx:231–256`). |
| **Fix** | Set explicit `scrollback: 500` (or lower for agent panes). Unmount non-active tab terminals after delay; restore from main scrollback on focus if needed. |
| **Impact** | Medium |
| **Effort** | Low |

### 1.9 Resize / layout thrash during pane drag

| | |
|---|---|
| **Symptom** | Janky column resize; terminals flicker while dragging dividers. |
| **Root cause** | `App.tsx` updates `sidebarWidth` / `threadsSidebarWidth` on every `mousemove` (`src/renderer/App.tsx:174–191`) causing full layout recalc. Each xterm pane listens to `window.resize` and calls `fit()` + `pty.resize` IPC (`AgentsPanel.tsx:180–187`, `ProjectTerminalPanel.tsx:263–269`, `useXtermTerminal.ts:111–116`). TitleBar drag sends IPC per pointer move (`src/renderer/components/TitleBar.tsx:35–44` → `src/main/windowState.ts:154–160`). |
| **Fix** | Throttle sidebar width updates with `requestAnimationFrame`. Batch terminal `fit()` until `mouseup`. Coalesce window drag updates in main (max 60/s). |
| **Impact** | Medium |
| **Effort** | Low |

### 1.10 Sticky user header scans DOM on scroll

| | |
|---|---|
| **Symptom** | Scroll jank in long chats. |
| **Root cause** | `updateStickyUser` runs `querySelectorAll('[data-message-role="user"]')` on debounced scroll (`src/renderer/components/OrchestratorChat.tsx:165–193`). |
| **Fix** | Track user message offsets in a ref updated only when messages change; binary search scroll position instead of DOM walk. |
| **Impact** | Low |
| **Effort** | Low |

---

## 2. IPC & data flow

### 2.1 PTY output: one IPC message per `onData` chunk

| | |
|---|---|
| **Symptom** | UI stutter during `npm install`, `tail -f`, build output; elevated main/renderer CPU. |
| **Root cause** | `PtyManager` forwards each `node-pty` `onData` chunk immediately via `webContents.send('pty:data', ...)` (`src/main/terminals/PtyManager.ts:66–72`). No batching or throttle. Renderer writes directly to xterm (`AgentsPanel.tsx:103–106`). |
| **Fix** | Batch in main: accumulate per `ptyId` in a 16ms `setImmediate`/`setTimeout(0)` flush (cap ~8–16 KB per frame). Optionally use `Buffer` + transferable semantics. Filter: only send to focused pty + active tab. |
| **Impact** | High |
| **Effort** | Medium |

### 2.2 Broadcast fan-out to every `BrowserWindow`

| | |
|---|---|
| **Symptom** | Secondary window (Agents & Tasks) does unnecessary work; duplicated state updates. |
| **Root cause** | `broadcast` loops `BrowserWindow.getAllWindows()` (`src/main/ipc/registerIpc.ts:160–166`, `src/main/index.ts:333–345`) for `agents:updated`, `tasks:updated`, `orchestrator:message*`, `threads:updated`, etc. |
| **Fix** | Channel subscriptions per window (only main gets thread/chat events; agents window gets agents/tasks). Or use a single shared worker store in main and let windows pull. |
| **Impact** | Medium |
| **Effort** | Medium |

### 2.3 Full thread list re-scanned and broadcast frequently

| | |
|---|---|
| **Symptom** | Pause when renaming threads, switching threads, opening projects; growing cost with project count. |
| **Root cause** | `threadStore.listAllThreads()` walks every project's `.mousse/.data` synchronously (`src/main/data/ThreadDataStore.ts:73–78`, `292–307`). Called on thread switch (`src/main/data/ThreadContext.ts:83`), pin (`registerIpc.ts:632`), project open (`579`), rename (`ThreadContext.ts:172`). Full array broadcast to renderer replaces `threads` in Zustand. |
| **Fix** | Maintain in-memory thread index updated incrementally. Broadcast deltas (`{ type: 'upsert', thread }`) instead of full list. Debounce sidebar refresh. |
| **Impact** | High |
| **Effort** | Medium |

### 2.4 Thread switch pushes full message/agent/task snapshots

| | |
|---|---|
| **Symptom** | Noticeable delay switching threads with long history. |
| **Root cause** | `switchThread` loads disk → `broadcast('orchestrator:messages', getMessages())` plus agents and tasks (`src/main/data/ThreadContext.ts:68–84`). `getMessages()` clones array (`OrchestratorService.ts:180–182`). |
| **Fix** | Renderer pulls via `getMessages` invoke on select; main sends only `{ threadId }` selected event. Consider incremental message paging for threads > 200 messages. |
| **Impact** | Medium |
| **Effort** | Medium |

### 2.5 Streaming assistant updates: high-frequency `message-updated` IPC

| | |
|---|---|
| **Symptom** | Main and renderer event-loop pressure during LLM streaming. |
| **Root cause** | Each delta emits `orchestrator:message-updated` (`src/main/orchestrator/OrchestratorService.ts:318–329`, `registerIpc.ts:183`). Preload forwards to renderer (`src/preload/index.ts:86–89`). |
| **Fix** | Batch stream deltas in main (50–100ms window) or send lightweight `{ id, delta }` events; renderer appends locally. Full message sync only on complete. |
| **Impact** | High |
| **Effort** | Medium |

### 2.6 Large `settings:get` clones on every read

| | |
|---|---|
| **Symptom** | IPC overhead on settings-heavy UI paths. |
| **Root cause** | `SettingsStore.get()` uses `structuredClone` (`src/main/settings/SettingsStore.ts:51–53`); exposed via `settings:get` (`registerIpc.ts:402`). `OrchestratorChat.refreshSelection` calls `settings.get()` + `getOptions()` on mount and every change (`OrchestratorChat.tsx:300–307`). |
| **Fix** | Return frozen snapshot without clone for read-only handlers; clone only in `set`. Cache `getOptions` output with invalidation on provider change. |
| **Impact** | Low |
| **Effort** | Low |

### 2.7 Preload surface area

| | |
|---|---|
| **Symptom** | Not a direct runtime issue today; constrains future optimization. |
| **Root cause** | Large monolithic `api` in `src/preload/index.ts` (~500 lines) exposes every channel to all renderer entry points. |
| **Fix** | Split preload APIs per window (`main` vs `agentsTasks`) to reduce attack surface and accidental listeners. Document which windows may subscribe to high-frequency channels. |
| **Impact** | Low |
| **Effort** | Medium |

---

## 3. Main-process responsiveness

### 3.1 Synchronous filesystem on hot paths

| | |
|---|---|
| **Symptom** | Main thread stalls; delayed IPC replies; micro-freezes during thread ops. |
| **Root cause** | Widespread `readFileSync` / `writeFileSync`: `ThreadDataStore` (`src/main/data/ThreadDataStore.ts`), `SettingsStore.persist` (`src/main/settings/SettingsStore.ts:86–91`), `ProjectManager`, `ChannelStore`, `ScheduledJobStore`. `saveCurrent` writes full messages JSON on persist (`ThreadContext.ts:122–132`). |
| **Fix** | Move persistence to async `fs/promises` with a serial write queue per thread. Keep in-memory authoritative state; fs is backup. Debounce saves during streaming (already 500ms in `OrchestratorService.persist` at `153–167` — extend to tool/thinking deltas). |
| **Impact** | High |
| **Effort** | Medium |

### 3.2 `listAllThreads` / `searchThreads` block event loop

| | |
|---|---|
| **Symptom** | Search dialog and startup slow with many threads/projects. |
| **Root cause** | `listAllThreads` sync directory walk (`ThreadDataStore.ts:73–78`). `searchThreads` reads every `messages.json` (`383–414`). |
| **Fix** | Background index (SQLite or JSON index file) built incrementally. Search via ripgrep child process or pre-tokenized index. |
| **Impact** | Medium |
| **Effort** | High |

### 3.3 Git operations on IPC thread

| | |
|---|---|
| **Symptom** | Git panel refresh blocks other IPC while `git status` runs on large repos. |
| **Root cause** | `GitService.getStatus` runs `simple-git` status + `rev-list` (`src/main/git/GitService.ts:57–83`). `GitPanel` calls on mount (`src/renderer/components/GitPanel.tsx:80–82`). |
| **Fix** | Cache status snapshot with 2–5s TTL; invalidate on file-watcher events. Run git in worker thread pool. |
| **Impact** | Medium |
| **Effort** | Medium |

### 3.4 MCP client startup cost

| | |
|---|---|
| **Symptom** | First orchestrator message slow when MCP enabled; spawn timeouts. |
| **Root cause** | `McpManager.connect` spawns stdio/HTTP transports with 12s start timeout (`src/main/integrations/mcp/McpManager.ts:16–17`, `215+`). `getEnabledTools` connects all enabled servers (`69–93`). |
| **Fix** | Prewarm connections after first paint (idle). Parallel connect with circuit breaker. Lazy-connect on first tool invocation only; show UI indicator. |
| **Impact** | Medium |
| **Effort** | Medium |

### 3.5 Scheduled job ticker wakeups

| | |
|---|---|
| **Symptom** | Periodic main-process wake every 60s even when idle. |
| **Root cause** | `TICKER_INTERVAL_MS = 60_000` (`src/main/scheduled/ScheduledJobStore.ts:32`); `start()` runs `tick` + `setInterval` + watchdog (`ScheduledJobService.ts:39–46`). |
| **Fix** | Compute next wake from nearest `nextRunAt` (single `setTimeout`). Pause ticker when no enabled jobs. Coalesce heartbeat file writes. |
| **Impact** | Low |
| **Effort** | Low |

### 3.6 Channel adapters start at bootstrap

| | |
|---|---|
| **Symptom** | Slower cold start when Discord/Telegram enabled; network activity at launch. |
| **Root cause** | `void channelService.startEnabled()` during `bootstrap()` (`src/main/index.ts:328–329`) connects all enabled platforms (`ChannelService.ts:169–180`). |
| **Fix** | Defer `startEnabled` until after `ready-to-show` or user opens Channels UI. |
| **Impact** | Medium |
| **Effort** | Low |

---

## 4. Memory management

### 4.1 Unbounded PTY / headless scrollback strings

| | |
|---|---|
| **Symptom** | RSS grows during long builds; thread switch loads huge scrollback files. |
| **Root cause** | `PtyManager` appends every chunk to `scrollbacks` Map with no cap (`src/main/terminals/PtyManager.ts:67–68`). Same for `HeadlessAgentRunner` (`50–51`). Persisted to `terminals/*.txt` on save (`ThreadDataStore.ts:186–187`). |
| **Fix** | Ring buffer per pty (e.g. 256 KB max). Trim on save. xterm scrollback + main buffer should not duplicate indefinitely. |
| **Impact** | High |
| **Effort** | Low |

### 4.2 Orchestrator holds full message history in RAM

| | |
|---|---|
| **Symptom** | Memory scales with thread length; old tool outputs retained. |
| **Root cause** | `OrchestratorService.messages` array holds all chat + tool timeline entries; loaded entirely on thread switch (`OrchestratorService.ts:170–178`, `ThreadContext.ts:68–71`). |
| **Fix** | Paginate: keep last N messages hot, archive older to disk. Summarize/prune tool outputs for display. |
| **Impact** | Medium |
| **Effort** | High |

### 4.3 Document tabs store full markdown in Zustand

| | |
|---|---|
| **Symptom** | Opening many plan/docs increases renderer heap. |
| **Root cause** | `openDocument` stores `{ title, markdown }` per tab (`src/renderer/stores/appStore.ts:164–171`). All tabs stay in state when Documents panel hidden via KeepMounted. |
| **Fix** | Store path/reference; load content on activate. Evict inactive tab bodies. |
| **Impact** | Low |
| **Effort** | Low |

### 4.4 Browser webview + unused BrowserViewManager

| | |
|---|---|
| **Symptom** | Extra Chromium subprocess; duplicate browser abstractions. |
| **Root cause** | Renderer uses `<webview>` (`BrowserPanel.tsx:184–190`). Main also maintains `BrowserViewManager` with `WebContentsView` (`src/main/browser/BrowserViewManager.ts`) initialized in IPC (`registerIpc.ts:158`) but not used by current renderer. |
| **Fix** | Pick one embedding strategy. If keeping webview, destroy on panel unmount. If migrating to WebContentsView, remove webview tag to avoid two browser stacks. |
| **Impact** | Medium |
| **Effort** | Medium |

### 4.5 Event listener hygiene

| | |
|---|---|
| **Symptom** | Potential leaks on window reload; hard-to-debug ghost handlers. |
| **Root cause** | Most renderer `on*` preload APIs return unsubscribe (good). Main attaches permanent `win.on` handlers (`windowState.ts:216–272`, `windowMaterial.ts:48–49`) without removal on destroy — acceptable for window lifetime. `AgentsPanel` re-subscribes `agents.onActivated` when `agents` changes (`AgentsPanel.tsx:110–130`) — can stack duplicate handlers if effect deps churn. |
| **Fix** | Stabilize effect deps (use refs for `agents` lookup in activated handler). Audit `attachWindowStateListeners` to detach on `closed`. |
| **Impact** | Low |
| **Effort** | Low |

### 4.6 Registry growth: agents, MCP, tasks

| | |
|---|---|
| **Symptom** | Slow agent list UI over long sessions. |
| **Root cause** | `AgentRegistry` retains all agents until `remove` (`src/main/agents/AgentRegistry.ts:5–74`). `McpManager.connections` until `shutdown` (`McpManager.ts:28`). Completed agents may remain in thread JSON. |
| **Fix** | Prune completed agents from memory after retention period; compact on thread save. Disconnect idle MCP servers after TTL. |
| **Impact** | Low |
| **Effort** | Low |

---

## 5. Startup time

### 5.1 Window creation blocked on bootstrap chain

| | |
|---|---|
| **Symptom** | Long white/blank period before UI; slow cold start. |
| **Root cause** | `createWindow()` runs only after `await providerAuth.init()`, `worktrees.init()`, `registerIpc`, and `await threadContext.initialize()` (`src/main/index.ts:251–425`). `initialize` loads thread data from disk synchronously (`ThreadContext.ts:32–50`). |
| **Fix** | Create window immediately after `app.whenReady`; show splash shell. Defer `threadContext.initialize` to after first paint (show loading state). Parallelize `providerAuth.init` + `worktrees.init`. |
| **Impact** | High |
| **Effort** | Medium |

### 5.2 Initial broadcast storm

| | |
|---|---|
| **Symptom** | Renderer hydration jank right after load. |
| **Root cause** | Post-window `broadcast` sends projects, threads, scheduled jobs, channels (`src/main/index.ts:438–446`) while renderer also invokes lists in `App.tsx:93–111`. Duplicate full-state fetches. |
| **Fix** | Single `app:hydrate` snapshot or rely on broadcasts only (remove duplicate invokes). |
| **Impact** | Medium |
| **Effort** | Low |

### 5.3 No renderer code-splitting

| | |
|---|---|
| **Symptom** | Large initial JS bundle; slow parse on low-end machines. |
| **Root cause** | `main.tsx` eagerly imports `SettingsPage`, `ScheduledPage`, `ChannelsPage` (`src/renderer/main.tsx:4–7`). `electron.vite.config.ts` defines two inputs but no dynamic chunks (`electron.vite.config.ts:37–48`). Dependencies include `highlight.js`, `react-markdown`, `@xterm/xterm`, `lucide-react` (full icon imports per file). |
| **Fix** | `React.lazy` for modal pages and main-view panels. Vite `manualChunks` for xterm, markdown, settings. Use `lucide-react` direct icon imports (already partially done). |
| **Impact** | Medium |
| **Effort** | Medium |

### 5.4 Heavy main-process dependencies loaded at boot

| | |
|---|---|
| **Symptom** | Slow main bundle load; high baseline memory. |
| **Root cause** | `discord.js`, `@modelcontextprotocol/sdk`, `simple-git`, `pi-cursor-sdk` imported from main entry graph. `MacroEngine` reads macro JSON via `readFileSync` at construction (`src/main/macros/MacroEngine.ts`). |
| **Fix** | Dynamic `import()` for channel adapters and MCP. Defer macro provider loading until first agent spawn. |
| **Impact** | Medium |
| **Effort** | Medium |

---

## 6. Electron platform

### 6.1 Windows acrylic / Mica material cost

| | |
|---|---|
| **Symptom** | GPU compositor load; frame drops on resize; focus flicker on Windows 11. |
| **Root cause** | Main window sets `backgroundMaterial: 'acrylic'` when theme uses acrylic (`src/main/index.ts:177–182`). `applyWindowMaterial` re-applies on every focus/blur (`src/main/windowMaterial.ts:39–50`). |
| **Fix** | Default to `backgroundMaterial: 'none'` with CSS backdrop-filter in renderer for acrylic themes (cheaper on many GPUs). Cache material state; skip re-apply if unchanged. |
| **Impact** | Medium |
| **Effort** | Low |

### 6.2 No explicit GPU / V8 tuning

| | |
|---|---|
| **Symptom** | OOM on huge threads; no diagnostics configured. |
| **Root cause** | No `app.commandLine.appendSwitch` for GPU sandbox, `disable-renderer-backgrounding`, or `js-flags` in codebase. Electron defaults apply. |
| **Fix** | Document optional flags for dev (`--enable-logging=stderr`). For production, consider `--max-old-space-size=4096` on main only if heap OOM observed. Enable `app.getGPUFeatureStatus()` telemetry in debug builds. Do **not** blanket-disable hardware acceleration. |
| **Impact** | Low |
| **Effort** | Low |

### 6.3 Multiple windows & tray

| | |
|---|---|
| **Symptom** | Extra renderer process + memory when Agents & Tasks open. |
| **Root cause** | `openAgentsTasksWindow` creates second `BrowserWindow` with full preload (`src/main/agentsTasksWindow.ts:89–116`). System tray always created (`src/main/index.ts:426`). |
| **Fix** | Agents/tasks overlay as main-window panel (popper) instead of second window — removes duplicate hydration. Tray is low cost; keep. |
| **Impact** | Medium |
| **Effort** | High |

### 6.4 `sandbox: false` on main window

| | |
|---|---|
| **Symptom** | Security surface (indirect performance via process model). |
| **Root cause** | `webPreferences.sandbox: false` (`src/main/index.ts:199`). Required by some native integrations but increases blast radius. |
| **Fix** | Re-evaluate enabling sandbox with compatible preload; unrelated to FPS but affects process isolation. |
| **Impact** | Low |
| **Effort** | High |

---

## 7. Zustand store notes (`appStore.ts`)

The store is a **single flat slice** (`src/renderer/stores/appStore.ts:16–192`). Consumers generally use selectors (`useAppStore((s) => s.messages)`), which is correct. Remaining issues:

1. **`updateMessage` immutably maps the full array** — any message change invalidates all `messages` subscribers.
2. **No middleware** for structural sharing or devtools action batching during streams.
3. **Layout fields** (`sidebarWidth`, `threadsSidebarWidth`) share the store with chat data — high-frequency resizes trigger selector re-evaluation in `App` (subscribes to width).

**Recommendation:** Split stores or use `zustand/shallow` for multi-field picks; batch streaming updates.

---

## 8. Top 10 prioritized actions

| Rank | Action | Impact | Effort | Primary location |
|------|--------|--------|--------|------------------|
| 1 | Virtualize orchestrator message list + memoize `ChatMessageContent` | High | Medium | `OrchestratorChat.tsx`, `ChatMessageContent.tsx` |
| 2 | Batch `pty:data` IPC (16ms window) + optional focused-pty filter | High | Medium | `PtyManager.ts` |
| 3 | Batch LLM streaming IPC (`delta` events or 50ms coalesce) | High | Medium | `OrchestratorService.ts`, `registerIpc.ts` |
| 4 | Dispose agent xterm instances when agents complete | High | Low | `AgentsPanel.tsx` |
| 5 | Cap PTY/headless scrollback buffers (256 KB) | High | Low | `PtyManager.ts`, `HeadlessAgentRunner.ts` |
| 6 | Show window before `threadContext.initialize`; hydrate async | High | Medium | `src/main/index.ts` |
| 7 | Reduce KeepMounted scope; lazy-load Browser/Git/Files | High | Medium | `MainViewPanel.tsx`, `main.tsx` |
| 8 | Incremental thread index + delta broadcasts (stop full `listAllThreads` scans) | High | Medium | `ThreadDataStore.ts`, `ThreadContext.ts` |
| 9 | Async debounced thread persistence (avoid sync `writeFileSync` on hot path) | High | Medium | `ThreadDataStore.ts`, `ThreadContext.ts` |
| 10 | Debounce context-usage IPC; near-bottom-only autoscroll | Medium | Low | `OrchestratorChat.tsx` |

---

## 9. Measurement methodology

### 9.1 Renderer frame time & React render cost

1. Open DevTools → **Performance** panel → record during orchestrator streaming and thread switch.
2. Enable **React Profiler** (DevTools Components tab) — look for `OrchestratorChat`, `ChatMessageContent`, `ThreadsSidebar` render counts per stream token.
3. Target: < 16ms per frame p95 during streaming; < 5ms per keystroke in composer.

### 9.2 IPC volume

1. Main process: wrap `webContents.send` in debug build counter (channel, bytes/frame).
2. Electron **chrome://tracing** or `--enable-logging` for IPC timing.
3. Metric: `pty:data` messages/sec during `yes` command — aim to reduce >10× via batching.

### 9.3 Memory

```js
// Main process (DevTools console or temporary handler)
const mem = await process.getProcessMemoryInfo()
// private, residentSet, shared
```

Renderer: **Memory** tab → heap snapshot before/after spawning 5 agents and switching threads 10×. Watch **Detached DOM tree** (xterm wrappers) and **JSArrayBuffer** (webview).

Process Explorer: track `Mousse.exe` + `Mousse Helper (Renderer)` RSS over 30 min active coding session.

### 9.4 Startup

Measure with `console.time('first-paint')` in renderer `main.tsx` and `ready-to-show` in main. Log delta between `app.whenReady`, `createWindow`, `did-finish-load`.

Target: < 2s to interactive UI on mid-range hardware (deferrable work excluded).

### 9.5 PerfMonitor ideas (future in-app)

- Overlay showing FPS (requestAnimationFrame loop), last IPC burst size, xterm instance count, Zustand store version.
- `window.__MOUSSE_PERF__` debug flag enabling stream batch stats without production overhead.
- Main-process badge in tray when scheduler + channels + MCP connections are active (explains background CPU).

### 9.6 Regression harness

- Scripted Playwright/Electron test: load thread with 500 synthetic messages, measure scroll FPS.
- Benchmark `listAllThreads()` with 50 projects × 20 threads — track wall time on CI.
- Golden-path: cold start → first message send → spawn agent → PTY flood — capture trace artifacts in CI.

---

## 10. Related files quick reference

| Area | Key files |
|------|-----------|
| Zustand | `src/renderer/stores/appStore.ts` |
| Chat UI | `src/renderer/components/OrchestratorChat.tsx`, `ChatMessageContent.tsx` |
| xterm | `src/renderer/hooks/useXtermTerminal.ts`, `AgentsPanel.tsx`, `ProjectTerminalPanel.tsx` |
| Panel lifecycle | `src/renderer/components/MainViewPanel.tsx`, `KeepMounted.tsx` |
| IPC bridge | `src/preload/index.ts`, `src/main/ipc/registerIpc.ts` |
| PTY | `src/main/terminals/PtyManager.ts` |
| Thread I/O | `src/main/data/ThreadDataStore.ts`, `ThreadContext.ts` |
| Bootstrap | `src/main/index.ts` |
| Build | `electron.vite.config.ts`, `package.json` |
| Windows chrome | `src/main/index.ts`, `windowMaterial.ts`, `agentsTasksWindow.ts` |

---

*This document is analysis-only; no code changes were made in the `wg-perf-report` work-group.*
