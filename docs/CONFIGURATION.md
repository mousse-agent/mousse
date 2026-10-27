# Mousse configuration (`mousse.conf`)

Mousse stores installation configuration at `$MOUSSE_HOME/mousse.conf` and personal configuration at `$MOUSSE_HOME/profiles/<profile-id>/mousse.conf`. MMS owns writes; GUI and CLI use the authenticated daemon protocol. The installation file owns `version`, `mms`, and rollout `features`. Profile files own `settings`, `providers` (personal selection), `agents`, `scheduled`, and `channels`.

Provider credentials in installation `auth.json` and the provider/model catalog are shared. Mousse ID/control accounts, integration secrets, threads, projects, Agent/workflow definitions, runs, browser state, and preferences are personal. `installation.json` and each `profiles/<id>/profile.json` identify the installation and profiles. Do not copy shared provider credentials into profile roots.

Electron encrypts provider credentials with its OS-backed vault. GUI and headless Electron use the same user-data directory for an installation, including an explicit `MOUSSE_ELECTRON_USER_DATA` override. An incompatible runtime, unavailable vault, invalid file or stale writer reports an error and preserves the original file. It never quarantines credentials on startup or silently replaces them with an empty/plaintext store. A fresh standalone Node installation may use plaintext credentials; it cannot open an Electron-encrypted store. Normal CLI clients can connect to the owning Electron daemon. See [credential recovery](PROVIDER_CREDENTIALS.md).

Legacy personal data migrates to Default using the durable `migration/journal.json`, staging, and snapshot directories. Preserve these recovery records and back up the whole installation home before an upgrade; do not manually re-run old global writes over migrated profile data. The schema examples below describe the configuration sections, whose ownership is now split as above. See [profile usage and recovery](implementation/agent-platform/usage-and-support.md).

## Location and environment

| Variable | Default | Effect |
|----------|---------|--------|
| `MOUSSE_HOME` | `~/.mousse` | Root directory for all Mousse data and `mousse.conf` |
| `MOUSSE_REPO_ROOT` | `process.cwd()` (CLI/MMS) or homedir when packaged (GUI) | Default git repo for worktrees |
| `MOUSSE_TELEGRAM_BOT_TOKEN` | — | Overrides Telegram token; enables Telegram channel |
| `MOUSSE_DISCORD_BOT_TOKEN` | — | Overrides Discord token; enables Discord channel |
| `MOUSSE_CHANNELS_WEBHOOK_PORT` | — | Overrides webhook listen port |

**Config paths:** installation `$MOUSSE_HOME/mousse.conf`; personal `$MOUSSE_HOME/profiles/<profile-id>/mousse.conf`.

**Precedence:** Environment overrides apply at runtime for channels (tokens/ports) after reading `mousse.conf`. All other settings come from `mousse.conf` unless a store merges live edits in memory.

## Claude Subscription provider

In **Settings → Providers → Add provider → Subscription**, choose **Claude Subscription**. Connect uses the official Claude Code executable and its own Claude account login. Install Claude Code first if it is unavailable. The existing Anthropic API-key provider remains a separate option.

Every profile uses the sign-in from your terminal: the same `claude` configuration (`~/.claude`, or an inherited `CLAUDE_CONFIG_DIR`) you use outside Mousse. Sign in with `claude auth login` in a terminal; Mousse never runs it for you. Any sign-in `claude auth status` reports counts, whatever its method (a Claude account, an OAuth token or proxy set in Claude Code's own `settings.json`, an API key). Claude Code owns credential storage and renewal; Mousse does not copy tokens into `auth.json`. Profiles that had a separate sign-in from an older version switch to the terminal sign-in; their old `providers/claude-subscription/claude-config` directory is left on disk untouched.

Mousse runs your Claude Code exactly as you set it up. Every launch (the sign-in check, model discovery, the usage check and turns) gets the environment Mousse was started with and loads your user, project and local Claude Code settings, as `claude` in a terminal would: the `env` block in `settings.json`, MCP servers, hooks, plugins, skills, permission rules, CLAUDE.md, and AGENTS.md when Claude Code's own settings load it. Turns use Claude Code's own system prompt. Mousse adds only its own pieces on top: its MCP server and orchestration guidance, the MCP servers and skills enabled in Mousse (skills already in `~/.claude/skills` or the project's `.claude/skills` are not added twice), and the permission mode for each turn. The launch arguments and environment variables set in Settings → Providers apply too; text from `--append-system-prompt` and `--append-system-prompt-file` is added after Mousse's guidance.

After connecting, select Claude Subscription and a Claude model in the composer. Agent turns run under the thread's [permission mode](#permission-modes). Full access is the former behavior: Claude Code's tools with permission checks bypassed (the equivalent of `--dangerously-skip-permissions`), so tool calls run without approval prompts; only calls Claude Code refuses to auto-approve even in that mode, and its own questions, are shown in the thread. Plan turns stay limited to read-only tools. Plan mode, streamed replies, cancellation and conversation continuity are supported. Claude Code owns its context window; Mousse does not display a fabricated context percentage. Native tool edits follow Claude Code's execution path, as with Antigravity, rather than Mousse's parsed action blocks.

Account eligibility, usage limits and billing are managed by Claude. Consult [Claude's current subscription/SDK policy](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) for changes. Disconnect turns Claude Code off in this profile and cancels its running provider work; the sign-in in your terminal is unchanged.

## Permission modes

Every thread has a permission mode: **Ask before acting** (commands and file edits ask), **Auto-accept edits** (edits go ahead, commands ask) or **Full access** (nothing asks). New threads start in the mode set in **Settings → General → Permissions** (default: Auto-accept edits). The composer shows and changes the thread's mode; a change applies from the next turn, the agent is told, and a running turn or a pending approval is not touched. A subagent never exceeds the narrowest mode of the threads it belongs to, and a fork starts in its source's mode.

Each agent enforces the mode with its own controls:

- **Claude Code:** Ask runs Claude Code's `default` mode, Auto-accept edits `acceptEdits`, Full access `bypassPermissions`. Under Ask and Auto-accept edits Mousse also asks before every command (`Bash` and `PowerShell`), and before every edit under Ask, whatever allow rules your own Claude Code settings hold. If your Claude Code settings set `permissions.disableBypassPermissionsMode` to `"disable"` (user, managed, or the project's `.claude/settings.json` and `settings.local.json`; a settings file passed with `--settings` is not read), Full access runs as Auto-accept edits and the composer says so. Mousse never edits your Claude configuration.
- **Codex:** Ask runs `untrusted` approvals in the read-only sandbox, so every command that is not known to be safe and every patch asks. Full access is Codex's own full-access profile (`never` ask, sandbox off). Auto-accept edits is not offered yet: a thread set to it runs as Ask on Codex, and the composer says so. A rule in your Codex exec policy that prompts is rejected, not asked, under Full access (Codex behavior).
- **Pi (both the Pi agent and the older Mousse loop):** commands (`bash`) ask under Ask and Auto-accept edits, edits (`edit`, `write`) ask under Ask; integrating a subagent's work asks unless the mode allows edits.
- **Antigravity and other ACP agents:** the agent's own once-only permission options are asked or answered by the mode; its "always" and "session" options are not offered. An agent that approves tools itself (a generic ACP agent) runs only in Full access; a turn in another mode is refused with the fix named.

An approval request is saved. It waits as long as you take while you are in the chat, and survives closing the window and restarting Mousse: after a restart, answering it continues the thread, and an approval you give then covers that same action once. Any client can answer: the app, `mousse-cli approvals` (or `/approve` and `/deny` in the CLI chat), or a linked device that may chat; if another client answered first you are told who. Sending a message while an approval waits denies it, with your message as the reason. Runs nobody watches (workflows, bots, scheduled jobs, agent definitions) keep the ten-minute limit: an approval nobody answers then counts as a refusal.

**Always for this thread.** An approval card can offer "Always for this thread" (in the CLI: `/approve always`, or `mousse-cli approvals answer <id> allow_always`). It allows the request and lets the same request through later in this thread without asking. "Same" is exact: the same command in the same folder, or the same edit of the same file. Another command, argument, folder or tool still asks. A rule approves the text of the request, not what it does: `npm test` or `./build.sh` run whatever the project holds that time, and Claude's shell keeps its folder between calls, so the same command can run from a subfolder. It is not offered when the agent gives no stable description of the call (an ACP agent with no details, a Codex command with no text), when Codex gives a reason for asking (such as a retry outside the sandbox), for an integration of a subagent's work, or for Claude Code's own safety checks and anything it says must not be remembered, in any mode. A rule belongs to its thread: a fork or a subagent starts with none. It answers only turns you started from the app or the CLI: scheduled and webhook jobs, subagents, bots, workflows and messages another agent sends to the thread still ask. It remembers the permission mode you were asked under and is ignored while the thread asks about more than that, which applies again when you loosen the mode. That is not a kill switch: a rule made under Ask holds in every mode (this covers every Codex, pi and ACP command rule), so only Revoke stops it. Rules are listed in the thread side card, where you can revoke one or reset them all (`mousse-cli approvals rules <thread>` and `approvals reset <thread>` do the same), and the thread shows a line each time one answers. Only you can make one, in the app or the CLI: a linked device or an agent answering for its subagent can allow a request once, never "always".

## File format

```jsonc
{
  "version": 1,
  "settings": { /* profile, appearance, permissions, integrations */ },
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
| `appearance.theme` | `ThemeId` | `"blacksphere-plus"` | Color theme only. `blacksphere-plus` is displayed as **mousse dark**. One of: `system`, `blacksphere-plus`, `dark`, `light`, `dark-modern`, `one-dark`, `monokai`, `solarized-dark`, `github-dark`, `high-contrast` |
| `appearance.accentColor` | `string` (hex) | `"#a785c7"` | UI accent color (buttons, highlights; also tints Dark/Light/System surfaces) |
| `appearance.acrylic` | `boolean` | `true` | Translucent acrylic glass overlay that works with **any** theme (Windows material + CSS glass) |
| `appearance.acrylicIntensity` | `number` (0–100) | `55` | Dial for glass strength: higher = more translucent + stronger blur |

Legacy theme ids `dark-acrylic`, `light-acrylic`, and `system-acrylic` are migrated automatically to the matching color theme with `acrylic: true`.

### `settings.integrations`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `integrations.tools.enabled` | `boolean` | `true` | Master switch for built-in tools |
| `integrations.tools.enabledTools` | `string[]` | all built-in | Individual tool IDs: project (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `git_status`, `git_diff`), interaction (`ask_user`, `present_plan`, `show_document`), tasks (`list_tasks`, `create_task`, `update_task`), actions (`create_quick_action`), skills (`list_skills`, `load_skill`) |
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
| `providers.llmProvider` | `string` | `""` | Active chat provider ID (e.g. `anthropic`, `openai`, `antigravity`) |
| `providers.model` | `string` | `""` | Model ID within that provider |

---

## `agents`

Settings of the retired CLI-agent launcher (Claude Code, Codex, OpenCode, Cursor Agents CLI). Mousse no longer reads them; they stay in the file so older versions can still read it.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `agents.enabled` | `Record<AgentTypeId, boolean>` | see below | Which agent types appear in the UI/spawn list |
| `agents.model` | `Record<AgentTypeId, string>` | all `""` | Default `--model` / `-m` per agent |
| `agents.headless` | `Record<AgentTypeId, boolean>` | see below | Prefer headless runner vs PTY |
| `agents.defaultCli` | `AgentTypeId` | *(optional)* | Default agent when spawning without explicit type |
| `agents.permissionFlags` | `Partial<Record<AgentTypeId, boolean>>` | *(optional)* | Per-agent permission bypass toggles |

**Default `agents.enabled`:** all `true` except `cursor-agents-cli: false`

**Default `agents.headless`:** `mousse: false`; all other CLI agents: `true`

Permission bypass flags corresponded to `--dangerously-skip-permissions`, Codex sandbox bypass and Cursor `--trust`/`--force`.

---

## `scheduled`

Job **definitions** only. Runtime fields (`state`, `nextRunAt`, `runHistory`, …) are stored in `$MOUSSE_HOME/scheduled/jobs-runtime.json`.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `scheduled.enabled` | `boolean` | `true` | When false, MMS/GUI does not start the scheduled ticker |
| `scheduled.jobs` | `ScheduledJobDefinition[]` | `[]` | Job definitions (see below) |
| `scheduled.webhooks` | `{ enabled: boolean, port: number }` | off, `18790` | The loopback listener (`127.0.0.1` only) that receives job webhooks. `schedule webhook enable` turns it on; a port given there moves it. It runs only while some job has a webhook (removing the last one stops it and turns it off). If the port is taken, or is one a net transport of the profile uses, the listener does not start and the scheduler status says so; a taken port is retried every 30 seconds |

### Job definition object

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `id` | `string` (UUID) | yes | Stable job ID |
| `name` | `string` | yes | Display name |
| `prompt` | `string` | yes | Prompt each run sends as a turn; a prompt starting with `/` runs a workflow |
| `schedule` | `JobSchedule` | yes | `once`, `interval`, cron-style, or `manual` (no clock: runs only when started) |
| `enabled` | `boolean` | yes | Whether job is eligible to run |
| `threadId` | `string` | no | Run as a turn on this thread, with its history and its own workspace |
| `projectId` | `string` | no | Project the run works in |
| `createThread` | `boolean` | no | Kept for older jobs; every run already gets its own thread when no `threadId` is set |
| `selection` | `{ instanceId, llmProvider, model }` | no | Provider instance and model of every run. Absent: the thread's own model (bound job) or the profile default (per-run thread) |
| `mode` | `agent` \| `plan` | no | Mode of every run; default `agent` |
| `workspace` | `{ kind: 'project' }` \| `{ kind: 'newWorktree' }` \| `{ kind: 'worktree', path }` | no | Per-run threads only. `project` (default) works on the project's own checkout and provisions nothing (see the warning below); `newWorktree` gives each run's thread its own worktree (needs a Git project, not `plan` mode); `worktree` runs on the thread that owns that worktree. A job bound to a thread uses that thread's workspace |
| `permissionMode` | `ask` \| `accept_edits` \| `full` | no | How much a run may do without asking. Never above `permissionCeiling`. Absent: the run follows its thread's mode, up to the job's ceiling. Not allowed on a workflow job (a prompt starting with `/`) |
| `permissionCeiling` | `ask` \| `accept_edits` \| `full` | set by the daemon | The widest mode a run may have: the mode the job's creator held when they created or last edited it. Every job has one, whoever created it. No request can set it (the protocol refuses the key). A mode with no ceiling in a stored job gets `ask` |
| `createdBy` | `{ threadId, runId? }` | no | The agent that created the job; absent for jobs people create |
| `trigger` | `{ webhook: { scheme: 'mousse', secretRef, createdAt, rotatedAt? } }` | no | Set by `schedule webhook enable`. `secretRef` names the signing secret in `secrets/refs.json` (mode `0600`; on Windows the `secrets` folder is limited to your account and SYSTEM); the secret itself is never in this file |
| `repeat.times` | `number` | no | Stop after N successful runs |
| `createdAt` / `updatedAt` | ISO string | yes | Metadata |

**Runtime-only (not in `mousse.conf`):** `state`, `nextRunAt`, `lastRunAt`, `lastStatus`, `lastError`, `pausedAt`, `pausedReason`, `runHistory`, `repeat.completed`, `pendingOccurrence`, `pendingTrigger`

### How a run executes

A plain-prompt run is a turn on a thread, admitted by the Run Engine like any message: the run is recorded first, then it starts at once when the thread is idle, or waits as one queue item when it is busy (a running turn, a peer process holding the thread, or a question waiting for an answer, which a scheduled run never answers). The run uses the job's model and mode whatever the thread's own selection is, and never changes the thread's saved model. The run record shows the model the run used, its thread and its run.

- **Permission mode and ceiling.** A plain-prompt run's permission mode is the strictest of the job's `permissionMode`, its `permissionCeiling` and its thread's own mode (a subagent thread's lineage included), whether a timer, "Run now" or a webhook started it, and whether the run starts at once, waits in the queue or is recovered after a restart. The ceiling is the mode the creator held when creating the job: the mode of the thread the job is bound to, otherwise the mode new threads start in. Every job has one: jobs a person creates, jobs created later by agents, and jobs saved before ceilings existed (at the next start they get their thread's mode, otherwise the mode new threads start in, otherwise `ask`). A ceiling is a limit, not a grant: a wide ceiling still follows the thread, so a thread or default loosened later never widens a run, while a thread tightened later narrows it. The label "Default" on a job's permissions means the thread's mode up to the job's limit.
  - **Editing.** An edit never raises the ceiling above what the editor holds. An edit of what the job does (prompt, model, mode, workspace, thread, project) lowers the ceiling, and the job's mode with it, to the editor's mode when that is stricter; a rename, schedule change or pause leaves both alone. A person who chooses a permission mode on purpose sets the ceiling to the mode they hold (this can raise it, never above their own mode); an agent editing a job can only lower the ceiling and is refused a mode above it. Clearing a job's mode keeps its ceiling. A job cannot be created or edited with a mode above its ceiling. The Scheduled page offers only the modes the person holds and says when saving will lower a mode.
  - **Queued runs.** An occurrence waiting in the queue, or recovered after a restart, that has not started takes the narrower of the mode it was admitted with and the mode its job has now, so tightening a job reaches a run that is already waiting; widening a job does not widen it.
  - **Workflow jobs.** A job whose prompt starts with `/` runs a workflow, and workflows do not run under a permission mode, so such a job takes none: creating or editing it with one is refused, and the Scheduled page hides the choice. The job still has a ceiling for the record, but it limits nothing a workflow does.
  - The run record shows the mode the run enforced. This limits the daemon's own scheduling; a program that can reach the local protocol is bounded by the protocol's own trust, not by a job's ceiling.
- **One run at a time per job.** An occurrence stays outstanding until its run ends, so a job whose run is queued or still working is skipped by later ticks. Different jobs run concurrently.
- **Run history states.** `queued` while the occurrence waits or runs elsewhere; then `ok`, `error`, `interrupted`, or `uncertain` (the run was cut off while a tool that cannot be repeated was working, so its effects may have happened).
- **Restart.** The Run Engine owns recovery. A run the daemon had admitted but not started is started once by the engine's own recovery; a run that had started ends `interrupted` (or `uncertain`) and is never run again; an admission that can never start (the daemon stopped between recording the run and queueing it) ends `interrupted: never started`.
- **Missed runs.** Occurrences missed while the daemon was down run once on the next tick.
- **Per-run threads.** Each run without a `threadId` gets its own thread. A run on the project's checkout settles its thread when it succeeds (its reply is in the run history, and the thread stays reachable from there), and so does a `[SILENT]` run. A job with `workspace: newWorktree` keeps each run's thread open, because it holds that run's worktree, up to 10 open threads; settle or delete some, or bind the job to a thread.
- **Bound threads.** A job with a `threadId` adds its prompt and the reply to that thread's history on every run, so a frequent job makes the thread's context grow and compact sooner. The prompt is marked as the job's (`scheduled` on the message), not as typed by a person.
- **"Run now".** It starts the job at once. While the job's run is in progress or waiting in a queue, it is refused with a message instead of being dropped.
- **Catch-up.** After the daemon was down, overdue jobs start a few at a time (3 per tick, then the next tick follows within seconds), not all in one second.
- **Questions and approvals.** A scheduled turn asks for tool approval and questions like any turn. Nobody is likely watching a per-run thread, so a question or approval waits for its timeout (10 minutes; up to an hour for `ask_user`) and is then denied; a person's message on a bound thread dismisses it and stops the run. The job's occurrence and the thread stay held for that time. A scheduled turn has no time limit of its own yet.

> **Warning: `workspace: project` lets an unattended agent edit your own checkout.** The run works in the same folder you work in, with no worktree, no checkpoints and no undo, and two jobs on one project can edit it at the same time. For an agent-mode job in a Git project, use `newWorktree` (`--workspace new-worktree`), or `mode: plan` if the job should not change files.
- **`manual` jobs.** They have no next run and never complete; "Run now" starts them.
- **Webhook trigger.** A job with a `trigger` is started by `POST /hooks/<job id>` on the webhook listener (see `docs/CLI.md`). A request carries `X-Mousse-Timestamp` (within 5 minutes of the daemon's clock) and `X-Mousse-Signature: sha256=<hex>`, the HMAC-SHA256 of `<timestamp>.<raw body bytes>` under the job's secret, checked in constant time. A signature-valid request leaves a receipt in `scheduled/triggers/<job id>/receipts.json` (synced to disk before the request is answered, and kept until the request's timestamp can no longer pass the 5-minute check, so a captured request cannot be replayed, restarts included; a receipts file that cannot be read makes the job answer `503` until the secret is rotated, and a file full of still-valid receipts makes it answer `429` for a few minutes) and, when accepted, its body in `scheduled/triggers/<job id>/<delivery id>.json` (owner-only: mode `0600`, and on Windows the `triggers` folder is limited to your account and SYSTEM; deleted when the run ends or after a day if nothing references it). A delivery waits for the next scheduler tick, which is woken at once; a job runs one delivery at a time (`409` while one is running, waiting in a queue or pending). A delivery does not move an interval or cron job's own timer. `scheduled/triggers/<job id>/deliveries.json` logs the last 50 accepted deliveries (`accepted`, `queued`, `completed`, `failed`, `dispatch_failed`, `uncertain`) the last 20 refusals of signed requests (`running`, `pending`, `paused`, `replay`, `rate_limited`) and the last 20 requests that failed verification (`rejected_signature`, `too_large`), kept apart so unsigned traffic never pushes the others out. Every write to `scheduled/jobs-runtime.json` is synced to disk. A run started by a delivery fills the prompt's `{{body.path}}` placeholders from the stored body: single values only, each framed in a random `<webhook-data-ID>` tag, flattened to one line, with look-alike characters swapped in where a harness could read a `/skill`, `@file` or `$skill` mention, and capped (4 KiB each, 64 KiB in all), and kept in the run's thread history and records, not deleted with the stored body, with a note at the end that the tagged text is untrusted data; placeholders with no usable value are listed in the run record's `missingPlaceholders`. Headers and the secret are never available to a prompt (see `docs/CLI.md`).

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
| `webhookSecret` | `string` | `""` (required: the webhook refuses to connect while empty) |

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
