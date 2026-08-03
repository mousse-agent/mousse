# Mousse Architecture

Mousse is a **local multi-agent orchestrator**: a daemon-owned MMS (Mousse Main Service) executes agents, queues, scheduler, and channels; GUI and CLI are thin local clients over a framed duplex protocol. Scope is **local-only** (Unix domain socket / Windows named pipe) — no HTTP, remote, or cloud control plane.

## High-Level Overview

```
┌──────────────────────────┐     ┌──────────────────────────┐
│  Electron GUI (client)   │     │  mousse-cli (client)     │
│  Presentation + IPC      │     │  readline / one-shot    │
│  LocalMmsClient          │     │  LocalMmsClient          │
└────────────┬─────────────┘     └────────────┬─────────────┘
             │ framed protocol                 │
             │ (owner-token auth)              │
             └──────────────┬──────────────────┘
                            ▼
             ┌──────────────────────────────────┐
             │  MMS daemon (`service run`)      │
             │  Sole owner of MousseMainService │
             │  Scheduler · Channels · PTY      │
             │  Orchestrator · ThreadRuntime    │
             │  Settings · ProviderAuth · MCP   │
             └──────────────────────────────────┘
```

### Ownership rule

| Surface | Constructs `MousseMainService`? | Role |
|---------|----------------------------------|------|
| `mousse-cli service run` | **Yes** (only production path) | Exclusive owner lease + protocol server |
| Electron `src/main/**` | **Never** | Client + window/presentation |
| Normal CLI commands | **Never** | Client; may autostart daemon |
| Tests | May create service with `ownerKind: 'test'` | Isolated fixtures |

Production `src/main/**` never constructs or owns MMS. GUI quit disconnects the client only; the daemon keeps scheduler/channels running.

## Process lifecycle

1. **Daemon start:** `mousse-cli service run` (or GUI/CLI autostart) acquires owner lease, starts MMS, binds local endpoint, publishes runtime readiness.
2. **Clients connect:** Hello with owner token → allowlisted methods → `events.subscribe` for sequenced events.
3. **GUI quit / CLI exit:** Client disconnect; no stop of daemon.
4. **Daemon stop:** `service stop` prefers `daemon.shutdown` (authenticated), falls back to owner-token stop file. Order: stop protocol intake → close server → stop scheduler/channels/MCP → remove runtime record → release owner lease.

## Protocol

- **Transport:** framed duplex on local socket/pipe (`src/mms/protocol/`).
- **Auth:** owner token from lease file; never exposed to renderer or protocol events/health payloads.
- **Methods:** allowlisted in `PROTOCOL_METHODS`; every nested mutable payload is runtime-validated (schedules, channel config, settings partials, PTY env/dims, MCP/skills scope). Unknown keys, prototype pollution, and oversized values are rejected.
- **Events:** single sequenced ring; clients resubscribe after gaps; `requiresResnapshot` forces authoritative thread snapshots.

## GUI architecture (`src/main/`)

| Module | Responsibility |
|--------|----------------|
| `index.ts` | Window/tray lifecycle; bootstrap `GuiMmsController` |
| `mms/GuiMmsController.ts` | Discover/start daemon; reconnect; never own MMS |
| `mms/PresentationState.ts` | Selected thread / presentation only |
| `mms/protocolEventBridge.ts` | One typed map: protocol event → preload IPC channels |
| `ipc/registerGuiIpc.ts` | Renderer IPC → protocol methods; Electron-local files/git/browser/window |
| `agentsTasksWindow.ts` | Secondary window; same sandboxed preload (`contextIsolation`, no `nodeIntegration`) |

### Settings split

- **Daemon-owned:** full `MousseSettings`, provider credentials/auth, integrations that affect execution.
- **Electron chrome mirror:** `SettingsStore` in main is a presentation cache (accent, acrylic, window state) synchronized from `settings.get` / `settings.changed`. Writes always go to the daemon; all windows receive the same event.

## Persistence and recovery

| Data | Mechanism | Guarantees |
|------|-----------|------------|
| Messages / agents / tasks / llm / mousse sessions | `ThreadDataStore.mutateThreadData` under per-thread mutation lock | Atomic RMW; partial updaters cannot clobber each other |
| Message queue | `queue.json` + queue mutation lock only | Never written by `saveThreadData` / `mutateThreadData` |
| Pending user questions | Process memory | **Do not survive daemon restart**; marked interrupted, not answerable |
| Non-reattachable agents/PTYs | Startup restore | Marked `interrupted` |
| Scheduled jobs / channels | Daemon services | Continue with zero clients |

## CLI

- **Client commands:** `chat`, `config`, `schedule`, `channels`, `agents` → `openMms()` → `LocalMmsClient`.
- **Interactive chat:** protocol-only readline loop (`/stop`, `/steer`, `/threads`, `/exit`, event stream).
- **Owner:** only `cli/daemonOwner.ts` used by `service run`.

## Extension boundaries

- New execution features: daemon service + protocol method + validator + GUI bridge if needed.
- New UI-only chrome: Electron-local IPC (window, browser, clipboard).
- Do not add a second SettingsStore/ProviderAuth for execution in Electron.
- Do not construct `MousseMainService` from `src/main` or normal CLI paths.

## Related docs

- [CLI.md](./CLI.md) — commands and service lifecycle
- [CONFIGURATION.md](./CONFIGURATION.md) — home dir and config files
- [STARTUP.md](./STARTUP.md) — autostart install
- [MMS_PLAN.md](./MMS_PLAN.md) — isolation plan status
