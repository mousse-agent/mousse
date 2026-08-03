# Mousse Main Service (MMS) + mousse-cli Plan

> **Status (Phase 0–6 complete):** Production Electron (`src/main/**`) is a protocol client only.
> Sole owner construction is `cli/daemonOwner.ts` used by `service run`. Normal CLI is client-only.
> See [ARCHITECTURE.md](./ARCHITECTURE.md) for the live model. Historical work-group plan below.

Goal: split Mousse's core out of the Electron app into a reusable **Mousse Main Service (MMS)**,
ship a **mousse-cli** (pi-cli style interface) that runs MMS without Electron, unify all
configuration into `~/.mousse/mousse.conf`, support launch-on-startup for MMS on
Windows/Linux/macOS, and produce a GUI performance report.

## Work-groups (implemented concurrently, one git worktree each)

| Worktree | Scope | Owns (files/dirs) |
|----------|-------|-------------------|
| `wg-mms-core` | Extract Electron-free core into `src/mms/`; unified `mousse.conf` | `src/mms/**` (new), edits under `src/main/**`, `src/shared/**`, `docs/CONFIGURATION.md` |
| `wg-cli` | `mousse-cli` binary, pi-style interface | `src/cli/**` (new), `scripts/build-cli.*`, `docs/CLI.md`, `package.json` bin entry |
| `wg-startup` | Launch-on-startup for MMS (Win/Linux/macOS) | `src/mms/startup/**` (new), `docs/STARTUP.md` |
| `wg-perf-report` | GUI smoothness + memory-management report | `docs/PERFORMANCE.md` only |

`wg-cli` and `wg-startup` code against the **MMS API contract** below; the Merge Expert
reconciles import paths after `wg-mms-core` lands.

## MMS API contract (all work-groups must follow this exactly)

New directory `src/mms/` — **must not import `electron` anywhere** (enforce by review).

```ts
// src/mms/MousseMainService.ts
export interface MmsOptions {
  homeDir?: string          // default: MOUSSE_HOME env or ~/.mousse
  repoRoot?: string         // default: process.cwd()
  headless?: boolean        // true for CLI/service; suppresses GUI-only behavior
}

export class MousseMainService {
  static async create(opts?: MmsOptions): Promise<MousseMainService>
  readonly config: MousseConfigStore        // unified mousse.conf (below)
  readonly settings: SettingsStore          // now backed by config.settings section
  readonly providerAuth: ProviderAuthService
  readonly projects: ProjectManager
  readonly threads: ThreadDataStore
  readonly orchestrator: OrchestratorService
  readonly scheduled: ScheduledJobService
  readonly channels: ChannelService
  readonly agents: AgentRegistry
  readonly tasks: TaskQueue
  readonly events: MmsEventBus              // typed EventEmitter replacing webContents broadcasts
  start(): Promise<void>                    // starts scheduled ticker + enabled channels
  stop(): Promise<void>                     // graceful shutdown (channels, mcp, locks)
}

// src/mms/events.ts — typed event bus
export type MmsEvent =
  | { channel: 'projects:updated'; data: unknown }
  | { channel: 'threads:updated'; data: unknown }
  | { channel: 'scheduled:updated'; data: unknown }
  | { channel: 'scheduled:status'; data: unknown }
  | { channel: 'channels:updated'; data: unknown }
  | { channel: 'agents:updated'; data: unknown }
  | { channel: 'tasks:updated'; data: unknown }
export class MmsEventBus { on(...), off(...), emit(...) }
```

Electron-decoupling rules for `wg-mms-core`:
- `PtyManager` / `HeadlessAgentRunner`: replace `BrowserWindow.webContents.send` with an
  injected `(channel, data) => void` sink (GUI passes webContents bridge, CLI passes event bus).
- `WorktreeManager.resolveMacrosPath()`: remove `app.isPackaged` — use env/`__dirname` probing.
- `McpOAuthProvider`: `shell.openExternal` → injected `openExternal(url)` callback (CLI prints URL).
- GUI (`src/main/index.ts`) becomes a thin shell: `MousseMainService.create()` + windows/IPC.
- Keep all existing tests green; move files with `git mv` where possible.

## Unified config: `~/.mousse/mousse.conf` (JSON)

Single source of truth read/written by GUI, CLI, and MMS. Atomic writes + file-watch reload.

```jsonc
{
  "version": 1,
  "settings":   { /* current settings.json content (appearance, profile, ...) */ },
  "providers":  { /* orchestrator LLM provider config; secrets stay in ~/.mousse/auth.json */ },
  "agents":     { /* CLI agent providers: claude-code | codex | opencode | cursor-agents-cli, default cli, permission flags */ },
  "scheduled":  { "enabled": true, "jobs": [ /* job definitions (schedule, prompt, project) */ ] },
  "channels":   { /* channel configs currently in ~/.mousse/channels/config.json */ },
  "mms":        { "autostart": false, "logLevel": "info" }
}
```

- Migration: on first load, if `mousse.conf` missing, import `settings.json`,
  `channels/config.json`, `scheduled/jobs.json` job definitions, then leave originals with a
  `.migrated` marker. Runtime state (sessions, heartbeats, locks, thread data) stays in
  existing `~/.mousse/` subdirs — only *configuration* moves.
- `SettingsStore`, `ChannelStore`, `ScheduledJobStore` become views over `MousseConfigStore`
  sections (same public APIs, storage redirected).
- Document fully in `docs/CONFIGURATION.md` (every key, defaults, migration behavior).

## mousse-cli (wg-cli)

pi-style interface (see `node_modules/@earendil-works/pi-coding-agent` docs): kebab-case flags,
`-p/--print` non-interactive, `--mode text|json`, subcommands with `--help`.

```
mousse-cli [options] [message...]          # headless orchestrator chat (default command)
mousse-cli schedule list|add|remove|run|enable|disable
mousse-cli agents spawn|list|stop          # background CLI agents in worktrees
mousse-cli channels list|add|remove|enable|disable|pair   # full channel setup from CLI
mousse-cli config get <key>|set <key> <value>|list        # dotted-path access to mousse.conf
mousse-cli config providers                # interactive-ish provider setup (prompt for keys)
mousse-cli service start|stop|status|run   # MMS daemon control ("run" = foreground)
mousse-cli service install|uninstall       # delegates to src/mms/startup (wg-startup)
Options: --print/-p, --mode <text|json>, --provider, --model, --api-key,
         --continue/-c, --session <id>, --home <dir>, --version/-v, --help/-h
```

- Entry: `src/cli/index.ts`; built by electron-vite/esbuild to `out/cli/index.js`;
  `package.json` gets `"bin": { "mousse-cli": "./out/cli/index.js" }`.
- Must start WITHOUT Electron: imports only `src/mms/**` + `src/shared/**`.
- `service start` spawns detached `mousse-cli service run` with pidfile
  `~/.mousse/mms.pid`; `status`/`stop` use the pidfile.
- Document in `docs/CLI.md`.

## Launch on startup (wg-startup)

`src/mms/startup/` — pure Node, no Electron. Public API:

```ts
// src/mms/startup/index.ts
export type StartupPlatform = 'windows' | 'linux-systemd' | 'macos'
export function detectPlatform(): StartupPlatform
export async function installStartup(opts: { cliPath: string; homeDir: string }): Promise<void>
export async function uninstallStartup(): Promise<void>
export async function startupStatus(): Promise<{ installed: boolean; detail: string }>
```

- **Windows**: `schtasks /Create /SC ONLOGON /TN "MousseMMS" /TR "\"<cliPath>\" service run"`
  (fallback: HKCU `Software\Microsoft\Windows\CurrentVersion\Run`).
- **Linux (Debian & Fedora — both systemd)**: write systemd *user* unit
  `~/.config/systemd/user/mousse-mms.service` (`ExecStart=<cliPath> service run`,
  `Restart=on-failure`, `WantedBy=default.target`), then `systemctl --user daemon-reload &&
  systemctl --user enable --now mousse-mms`. Document `loginctl enable-linger $USER` for
  boot-without-login servers.
- **macOS**: `~/Library/LaunchAgents/com.ryspa.mousse.mms.plist` + `launchctl bootstrap gui/$UID`.
- Document all three in `docs/STARTUP.md` including manual steps and troubleshooting.

## Performance report (wg-perf-report)

`docs/PERFORMANCE.md`: detailed audit of the GUI (renderer + main) for smoothness and memory:
xterm.js instance lifecycle, React re-render hotspots (zustand selectors, message list
virtualization), IPC chattiness, main-process blocking work, BrowserView/webview leaks,
node-pty buffer handling, GC/heap guidance, startup time, and a prioritized recommendation
list with estimated impact. Analysis only — no code changes.

## Merge order

1. `wg-perf-report` (docs only) → 2. `wg-mms-core` → 3. `wg-startup` → 4. `wg-cli`
(Merge Expert fixes `src/main/*` → `src/mms/*` import drift in 3/4, runs
`npm run typecheck && npm test` after each merge.)
