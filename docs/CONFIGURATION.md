# Mousse configuration (`mousse.conf`)

Mousse stores **configuration** in a single JSON file at `~/.mousse/mousse.conf`. The GUI, MMS (Mousse Main Service), and `mousse-cli` all read and write this file. Runtime state (threads, sessions, OAuth tokens, job run history, etc.) stays in other files under `~/.mousse/`.

## Location and environment

| Variable | Default | Effect |
|----------|---------|--------|
| `MOUSSE_HOME` | `~/.mousse` | Root directory for all Mousse data and `mousse.conf` |
| `MOUSSE_REPO_ROOT` | `process.cwd()` (CLI/MMS) or homedir when packaged (GUI) | Default git repo for worktrees |
| `MOUSSE_MACROS_PATH` | *(auto-detected)* | Override path to macro JSON files |
| `MOUSSE_TELEGRAM_BOT_TOKEN` | — | Overrides Telegram token; enables Telegram channel |
| `MOUSSE_DISCORD_BOT_TOKEN` | — | Overrides Discord token; enables Discord channel |
| `MOUSSE_CHANNELS_WEBHOOK_PORT` | — | Overrides webhook listen port |

**Config file path:** `$MOUSSE_HOME/mousse.conf`

**Precedence:** Environment overrides apply at runtime for channels (tokens/ports) after reading `mousse.conf`. All other settings come from `mousse.conf` unless a store merges live edits in memory.

## File format

```jsonc
{
  "version": 1,
  "settings": { /* profile, appearance, integrations */ },
  "providers": { /* orchestrator LLM selection */ },
  "agents": { /* CLI agent defaults */ },
  "scheduled": { "enabled": true, "jobs": [ /* definitions */ ] },
  "channels": { /* messaging platform config */ },
  "mms": { "autostart": false, "logLevel": "info" }
}
```

Writes are **atomic**: data is written to a temp file in the system temp directory, then renamed over `mousse.conf`. MMS may watch the file for external changes and reload sections.

---

## `version`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `version` | `number` | `1` | Schema version for forward-compatible migrations |

---

## `settings`

User-facing preferences that are not provider/agent scheduling. `SettingsStore.get()` merges `settings` + `providers` + `agents` into the legacy `MousseSettings` shape used by the GUI.

### `settings.profile`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `profile.username` | `string` | Random generated name | Display name in the app |

### `settings.appearance`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `appearance.theme` | `ThemeId` | `"system"` | Color theme only. One of: `system`, `dark`, `light`, `cursor-dark`, `dark-modern`, `one-dark`, `monokai`, `solarized-dark`, `github-dark`, `high-contrast` |
| `appearance.accentColor` | `string` (hex) | `"#a785c7"` | UI accent color (buttons, highlights; also tints Dark/Light/System surfaces) |
| `appearance.acrylic` | `boolean` | `true` | Translucent acrylic glass overlay that works with **any** theme (Windows material + CSS glass) |
| `appearance.acrylicIntensity` | `number` (0–100) | `55` | Dial for glass strength: higher = more translucent + stronger blur |

Legacy theme ids `dark-acrylic`, `light-acrylic`, and `system-acrylic` are migrated automatically to the matching color theme with `acrylic: true`.

### `settings.integrations`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `integrations.mcp.enabled` | `boolean` | `true` | Master switch for MCP tools |
| `integrations.mcp.enabledServers` | `string[]` | `[]` | MCP server IDs/names enabled for orchestrator/agents |
| `integrations.mcp.enableForMainAgent` | `boolean` | `true` | Expose MCP tools to the orchestrator |
| `integrations.mcp.enableForAgents` | `Record<AgentTypeId, boolean>` | all `true` | Per CLI agent type |
| `integrations.skills.enabled` | `boolean` | `true` | Master switch for skills |
| `integrations.skills.enabledSkills` | `string[]` | `[]` | Skill IDs to materialize |
| `integrations.skills.enableForMainAgent` | `boolean` | `true` | Skills in orchestrator prompt |
| `integrations.skills.enableForAgents` | `Record<AgentTypeId, boolean>` | all `true` | Per CLI agent type |
| `integrations.skills.model` | `Record<string, SkillModelSettings>` | `{}` | Per-skill LLM override (`llmProvider`, `model`) |

**Agent type IDs:** `mousse`, `claude-code`, `codex`, `opencode`, `cursor-agents-cli`

---

## `providers`

Orchestrator LLM provider selection. **Secrets (API keys, OAuth tokens) are not stored here** — they live in `$MOUSSE_HOME/auth.json`.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `providers.llmProvider` | `string` | `""` | Active pi-ai provider ID (e.g. `anthropic`, `openai`, `cursor`) |
| `providers.model` | `string` | `""` | Model ID within that provider |

---

## `agents`

CLI coding agent defaults (Claude Code, Codex, OpenCode, Cursor Agents CLI).

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `agents.enabled` | `Record<AgentTypeId, boolean>` | see below | Which agent types appear in the UI/spawn list |
| `agents.model` | `Record<AgentTypeId, string>` | all `""` | Default `--model` / `-m` per agent |
| `agents.headless` | `Record<AgentTypeId, boolean>` | see below | Prefer headless runner vs PTY |
| `agents.defaultCli` | `AgentTypeId` | *(optional)* | Default agent when spawning without explicit type |
| `agents.permissionFlags` | `Partial<Record<AgentTypeId, boolean>>` | *(optional)* | Per-agent permission bypass toggles |

**Default `agents.enabled`:** all `true` except `cursor-agents-cli: false`

**Default `agents.headless`:** `mousse: false`; all other CLI agents: `true`

Permission bypass flags correspond to `--dangerously-skip-permissions`, Codex sandbox bypass, Cursor `--trust`/`--force`, etc. (see `src/mms/macros/agentPermissionFlags.ts`).

---

## `scheduled`

Job **definitions** only. Runtime fields (`state`, `nextRunAt`, `runHistory`, …) are stored in `$MOUSSE_HOME/scheduled/jobs-runtime.json`.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `scheduled.enabled` | `boolean` | `true` | When false, MMS/GUI does not start the scheduled ticker |
| `scheduled.jobs` | `ScheduledJobDefinition[]` | `[]` | Job definitions (see below) |

### Job definition object

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `id` | `string` (UUID) | yes | Stable job ID |
| `name` | `string` | yes | Display name |
| `prompt` | `string` | yes | Prompt sent to isolated orchestrator run |
| `schedule` | `JobSchedule` | yes | `once`, `interval`, or cron-style schedule |
| `enabled` | `boolean` | yes | Whether job is eligible to run |
| `threadId` | `string` | no | Target thread |
| `projectId` | `string` | no | Target project |
| `createThread` | `boolean` | no | Create a new thread per run |
| `repeat.times` | `number` | no | Stop after N successful runs |
| `createdAt` / `updatedAt` | ISO string | yes | Metadata |

**Runtime-only (not in `mousse.conf`):** `state`, `nextRunAt`, `lastRunAt`, `lastStatus`, `lastError`, `pausedAt`, `pausedReason`, `runHistory`, `repeat.completed`

Other scheduled files (unchanged):

- `$MOUSSE_HOME/scheduled/ticker_heartbeat` — ticker liveness
- `$MOUSSE_HOME/scheduled/ticker_last_success` — last successful tick
- `$MOUSSE_HOME/scheduled/.tick.lock`, `.jobs.lock` — file locks

---

## `channels`

Same shape as the former `$MOUSSE_HOME/channels/config.json`.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `filterSilenceNarration` | `boolean` | `true` | Drop `*(silent)*` narration from outbound messages |
| `unauthorizedDmBehavior` | `"pair"` \| … | `"pair"` | How to handle unknown DM senders |

### `channels.platforms.telegram`

| Key | Type | Default |
|-----|------|---------|
| `enabled` | `boolean` | `false` |
| `token` | `string` | *(optional)* |
| `allowedUserIds` | `string[]` | `[]` |
| `allowAllUsers` | `boolean` | `false` |

### `channels.platforms.discord`

Same fields as Telegram defaults.

### `channels.platforms.webhook`

| Key | Type | Default |
|-----|------|---------|
| `enabled` | `boolean` | `false` |
| `allowedUserIds` | `string[]` | `[]` |
| `allowAllUsers` | `boolean` | `true` |
| `webhookPort` | `number` | `18789` |
| `webhookSecret` | `string` | `""` |

**Runtime channel state** (not in `mousse.conf`):

- `$MOUSSE_HOME/channels/sessions.json` — active chat sessions
- `$MOUSSE_HOME/channels/directory.json` — discovered chats
- `$MOUSSE_HOME/channels/pairing/` — pairing codes

---

## `mms`

Mousse Main Service / daemon options (used by CLI and launch-on-startup work-group).

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `mms.autostart` | `boolean` | `false` | Whether MMS should register for OS login startup |
| `mms.logLevel` | `"debug"` \| `"info"` \| `"warn"` \| `"error"` | `"info"` | MMS log verbosity |

---

## Migration from legacy files

On **first load** when `mousse.conf` is missing, MMS imports configuration and leaves markers next to the originals:

| Legacy file | Imported into | Marker file |
|-------------|---------------|-------------|
| `$MOUSSE_HOME/settings.json` | `settings`, `providers`, `agents` | `settings.json.migrated` |
| `$MOUSSE_HOME/channels/config.json` | `channels` | `config.json.migrated` |
| `$MOUSSE_HOME/scheduled/jobs.json` | `scheduled.jobs` (definitions) | `jobs.json.migrated` |

Original files are **not deleted**. Runtime from `jobs.json` is copied to `scheduled/jobs-runtime.json` on first access if needed.

After migration, edit **`mousse.conf`** (or use `mousse-cli config`) as the source of truth for configuration. Legacy paths are no longer written by `SettingsStore`, `ChannelStore`, or `ScheduledJobStore`.

---

## Related paths (not in `mousse.conf`)

| Path | Purpose |
|------|---------|
| `$MOUSSE_HOME/auth.json` | LLM provider credentials (pi-ai `FileCredentialStore`) |
| `$MOUSSE_HOME/projects.json` | Project index |
| `$MOUSSE_HOME/threads-index.json` | Thread metadata index |
| `$MOUSSE_HOME/active-thread.json` | Last active thread |
| `$MOUSSE_HOME/.data/` | Standalone thread message/agent data |
| `$MOUSSE_HOME/mcp-oauth/` | MCP OAuth session files |
| `$MOUSSE_HOME/agent-configs/` | Generated ephemeral agent configs |
| `$MOUSSE_HOME/mms.pid` | MMS daemon PID (CLI) |

---

## Programmatic access

```ts
import { MousseConfigStore } from './mms/config/MousseConfigStore'

const config = MousseConfigStore.load(/* optional homeDir */)
const settings = config.assembleSettings() // full MousseSettings
config.updateMmsSection({ logLevel: 'debug' })
config.getPath() // ~/.mousse/mousse.conf
```

`MousseMainService.create({ homeDir })` loads config once and wires `SettingsStore`, `ChannelStore`, and `ScheduledJobStore` as views over the unified file.

## Thread workspace rollout flags

`mousse.conf.features` contains gated flags in dependency order: `subagentLifecycleV2`, `repositoryCoordination`, `externalThreadStorage`, `transactionalThreadStore`, `threadWorkspaces`, `turnCheckpoints`, `publish`, `latestTurnUndo`, `conversationBranches`, `codeRevertRedo`, and `threadTrashGc`. Configuration loading rejects a flag whose predecessor is disabled.

Repository-backed runtime data is stored beneath `$MOUSSE_HOME/thread-data/repositories/<repositoryId>/`; standalone data is beneath `$MOUSSE_HOME/thread-data/standalone/`. Legacy project `.mousse/.data` directories migrate lazily through copy/hash verification and recoverable migration trash.

Undo covers non-ignored files committed to the thread workspace. Ignored files, outside-workspace writes, MCP/network/database effects, and long-lived external processes are reported as non-reversible effects.
