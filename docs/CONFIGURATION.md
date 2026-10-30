# Mousse configuration (`mousse.conf`)

Mousse stores installation configuration at `$MOUSSE_HOME/mousse.conf` and personal configuration at `$MOUSSE_HOME/profiles/<profile-id>/mousse.conf`. MMS owns writes; GUI and CLI use the authenticated daemon protocol. The installation file owns `version`, `mms`, and rollout `features`. Profile files own `settings`, `providers` (personal selection), `agents`, and `scheduled`.

Provider credentials in installation `auth.json` and the provider/model catalog are shared. Mousse ID/control accounts, integration secrets, threads, projects, Agent/workflow definitions, runs, browser state, and preferences are personal. `installation.json` and each `profiles/<id>/profile.json` identify the installation and profiles. Do not copy shared provider credentials into profile roots.

Electron encrypts provider credentials with its OS-backed vault. GUI and headless Electron use the same user-data directory for an installation, including an explicit `MOUSSE_ELECTRON_USER_DATA` override. An incompatible runtime, unavailable vault, invalid file or stale writer reports an error and preserves the original file. It never quarantines credentials on startup or silently replaces them with an empty/plaintext store. A fresh standalone Node installation may use plaintext credentials; it cannot open an Electron-encrypted store. Normal CLI clients can connect to the owning Electron daemon. See [credential recovery](PROVIDER_CREDENTIALS.md).

Legacy personal data migrates to Default using the durable `migration/journal.json`, staging, and snapshot directories. Preserve these recovery records and back up the whole installation home before an upgrade; do not manually re-run old global writes over migrated profile data. The schema examples below describe the configuration sections, whose ownership is now split as above. See [profile usage and recovery](implementation/agent-platform/usage-and-support.md).

## Location and environment

| Variable | Default | Effect |
|----------|---------|--------|
| `MOUSSE_HOME` | `~/.mousse` | Root directory for all Mousse data and `mousse.conf` |
| `MOUSSE_REPO_ROOT` | `process.cwd()` (CLI/MMS) or homedir when packaged (GUI) | Default git repo for worktrees |

**Config paths:** installation `$MOUSSE_HOME/mousse.conf`; personal `$MOUSSE_HOME/profiles/<profile-id>/mousse.conf`.

**Precedence:** Settings come from `mousse.conf` unless a store merges live edits in memory.

## Claude Subscription provider

In **Settings → Providers → Add provider → Subscription**, choose **Claude Subscription**. Connect uses the official Claude Code executable and its own Claude account login. Install Claude Code first if it is unavailable. The existing Anthropic API-key provider remains a separate option.

Every profile uses the sign-in from your terminal: the same `claude` configuration (`~/.claude`, or an inherited `CLAUDE_CONFIG_DIR`) you use outside Mousse. Sign in with `claude auth login` in a terminal; Mousse never runs it for you. Any sign-in `claude auth status` reports counts, whatever its method (a Claude account, an OAuth token or proxy set in Claude Code's own `settings.json`, an API key). Claude Code owns credential storage and renewal; Mousse does not copy tokens into `auth.json`. Profiles that had a separate sign-in from an older version switch to the terminal sign-in; their old `providers/claude-subscription/claude-config` directory is left on disk untouched.

Mousse runs your Claude Code exactly as you set it up. Every launch (the sign-in check, model discovery, the usage check and turns) gets the environment Mousse was started with and loads your user, project and local Claude Code settings, as `claude` in a terminal would: the `env` block in `settings.json`, MCP servers, hooks, plugins, skills, permission rules, CLAUDE.md, and AGENTS.md when Claude Code's own settings load it. Turns use Claude Code's own system prompt. Mousse adds only its own pieces on top: its MCP server and orchestration guidance, the MCP servers and skills enabled in Mousse (skills already in `~/.claude/skills` or the project's `.claude/skills` are not added twice), and the permission mode for each turn. The launch arguments and environment variables set in Settings → Providers apply too; text from `--append-system-prompt` and `--append-system-prompt-file` is added after Mousse's guidance.

After connecting, select Claude Subscription and a Claude model in the composer. Agent turns run under the thread's [permission mode](#permission-modes). Full access is the former behavior: Claude Code's tools with permission checks bypassed (the equivalent of `--dangerously-skip-permissions`), so tool calls run without approval prompts; only calls Claude Code refuses to auto-approve even in that mode, and its own questions, are shown in the thread. Plan turns stay limited to read-only tools. Plan mode, streamed replies, cancellation and conversation continuity are supported. Claude Code owns its context window; Mousse does not display a fabricated context percentage. Native tool edits follow Claude Code's execution path, as with Antigravity, rather than Mousse's parsed action blocks.

Account eligibility, usage limits and billing are managed by Claude. Consult [Claude's current subscription/SDK policy](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) for changes. Disconnect turns Claude Code off in this profile and cancels its running provider work; the sign-in in your terminal is unchanged.

## Permission modes

Every thread has a permission mode: **Ask before acting** (commands and file edits ask), **Auto-accept edits** (edits go ahead, commands ask), **Auto** (edits go ahead, and the agent's own auto mode runs the commands it judges safe and asks about the rest) or **Full access** (nothing asks). Only an agent with an auto mode of its own runs in Auto; on any other agent a thread set to Auto runs exactly as Auto-accept edits would there, never with more access, and the composer's menu says so for that thread. The mode in effect is worked out again for every turn, so moving a thread to another agent applies this again. New threads start in the mode set in **Settings → General → Permissions** (default: Auto-accept edits). The composer shows and changes the thread's mode; a change applies from the next turn, the agent is told, and a running turn or a pending approval is not touched. A subagent never exceeds the narrowest mode of the threads it belongs to, and a fork starts in its source's mode.

Each agent enforces the mode with its own controls:

- **Claude Code:** Ask runs Claude Code's `default` mode, Auto-accept edits `acceptEdits`, Auto `auto`, Full access `bypassPermissions`. Under Ask and Auto-accept edits Mousse also asks before every command (`Bash` and `PowerShell`), and before every edit under Ask, whatever allow rules your own Claude Code settings hold. Under Auto, Claude Code's auto mode classifier decides commands, and whatever it does not allow on its own is asked in Mousse. Auto needs Claude Code 2.1.111 or later (the first version that starts in auto mode without `--enable-auto-mode`); with an older or unknown version, or when your Claude Code settings set `disableAutoMode` to `"disable"`, Auto runs as Auto-accept edits. If your Claude Code settings set `permissions.disableBypassPermissionsMode` to `"disable"` (user, managed, or the project's `.claude/settings.json` and `settings.local.json`; a settings file passed with `--settings` is not read), Full access runs as the nearest mode Claude Code allows (Auto when it has it, else Auto-accept edits) and the composer says so. Mousse never edits your Claude configuration.
- **Codex:** Ask runs `untrusted` approvals in the read-only sandbox, so every command that is not known to be safe and every patch asks. Full access is Codex's own full-access profile (`never` ask, sandbox off). Auto-accept edits is not offered yet: a thread set to it, or to Auto, runs as Ask on Codex, and the composer says so. A rule in your Codex exec policy that prompts is rejected, not asked, under Full access (Codex behavior).
- **Pi (both the Pi agent and the older Mousse loop):** commands (`bash`) ask under Ask and Auto-accept edits, edits (`edit`, `write`) ask under Ask; integrating a subagent's work asks unless the mode allows edits.
- **Antigravity and other ACP agents:** the agent's own once-only permission options are asked or answered by the mode; its "always" and "session" options are not offered. An agent that approves tools itself (a generic ACP agent) runs only in Full access; a turn in another mode is refused with the fix named.

An approval request is saved. It waits as long as you take while you are in the chat, and survives closing the window and restarting Mousse: after a restart, answering it continues the thread, and an approval you give then covers that same action once. Any client can answer: the app, `mousse-cli approvals` (or `/approve` and `/deny` in the CLI chat), or a linked device that may chat; if another client answered first you are told who. Sending a message while an approval waits denies it, with your message as the reason. Runs nobody watches (workflows, bots, scheduled jobs, agent definitions) keep the ten-minute limit: an approval nobody answers then counts as a refusal.

**Always for this thread.** An approval card can offer "Always for this thread" (in the CLI: `/approve always`, or `mousse-cli approvals answer <id> allow_always`). It allows the request and lets the same request through later in this thread without asking. "Same" is exact: the same command in the same folder, or the same edit of the same file. Another command, argument, folder or tool still asks. A rule approves the text of the request, not what it does: `npm test` or `./build.sh` run whatever the project holds that time, and Claude's shell keeps its folder between calls, so the same command can run from a subfolder. It is not offered when the agent gives no stable description of the call (an ACP agent with no details, a Codex command with no text), when Codex gives a reason for asking (such as a retry outside the sandbox), for an integration of a subagent's work, or for Claude Code's own safety checks and anything it says must not be remembered, in any mode. A rule belongs to its thread: a fork or a subagent starts with none. It answers only turns you started from the app or the CLI: scheduled and webhook jobs, subagents, bots, workflows and messages another agent sends to the thread still ask. It remembers the permission mode you were asked under and is ignored while the thread asks about more than that, which applies again when you loosen the mode. That is not a kill switch: a rule made under Ask holds in every mode (this covers every Codex, pi and ACP command rule), so only revoking it stops it. Rules are listed and revoked with the CLI (`mousse-cli approvals rules <thread>`, `approvals reset <thread> [ruleId]`), and the thread shows a line each time one answers. Only you can make one, in the app or the CLI: a linked device or an agent answering for its subagent can allow a request once, never "always".

## File format

```jsonc
{
  "version": 1,
  "settings": { /* profile, appearance, permissions, integrations */ },
  "providers": { /* orchestrator LLM selection */ },
  "agents": { /* CLI agent defaults */ },
  "scheduled": { "enabled": true, "jobs": [ /* definitions */ ] },
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
| `appearance.acrylic` | `boolean` | `true` | Translucent acrylic glass overlay that works with **any** theme: CSS glass over the native material (Windows acrylic, macOS vibrancy, KDE Plasma blur behind; other Linux desktops get transparency only) |
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
| `integrations.mcp.relay.runtimes` | `Partial<Record<'claude' \| 'codex' \| 'cursor' \| 'acp' \| 'antigravity' \| 'grok', boolean>>` | `{}` (on for all) | Which runtimes reach the MCP servers through the MCP relay (`mousse-relay`). A runtime is on unless set to `false`; MCP must be on. Settings, Skills & MCP, Advanced, "Share with other agents" |
| `integrations.skills.enabled` | `boolean` | `true` | Master switch for skills |
| `integrations.skills.enabledSkills` | `string[]` | `[]` | Skill IDs to materialize |
| `integrations.skills.enableForMainAgent` | `boolean` | `true` | Skills in orchestrator prompt |
| `integrations.skills.enableForAgents` | `Record<AgentTypeId, boolean>` | all `true` | Per CLI agent type |
| `integrations.skills.model` | `Record<string, SkillModelSettings>` | `{}` | Per-skill LLM override (`llmProvider`, `model`) |

**Agent type IDs:** `mousse`, `claude-code`, `codex`, `opencode`, `cursor-agents-cli`

---

---

## `providers`

The providers this profile can pick, and its default selection. **Secrets (API keys, OAuth tokens) are not stored here**: see [provider sign-ins and keys](PROVIDER_CREDENTIALS.md).

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `providers.llmProvider` | `string` | `""` | Provider of the default selection (kept for older readers) |
| `providers.model` | `string` | `""` | Model of the default selection |
| `providers.instanceId` | `string` | — | Provider instance of the default selection; wins over `llmProvider` when set |
| `providers.instances` | `Record<string, ProviderInstanceConfig>` | the built-in entries | The provider instances of this profile, by instance id (below) |
| `providers.instancesSeedVersion` | `number` | — | Which set of built-in entries the profile was last given |
| `providers.removedInstances` | `string[]` | `[]` | Instance ids removed from this profile (below) |
| `providers.modelPrefs` | `Record<string, object>` | `{}` | Per instance: hidden and favourite models, their order, and custom models |

**Instances.** A provider instance is one provider a profile can pick, with a stable id: `claude`, `codex`, `pi:openai`, or `claude:work` for a second account. Each entry is `{ driver, enabled, config }`: `driver` is the kind of agent (`claude`, `codex`, `antigravity`, `grok`, `cursor`, `acp`, `pi`), `enabled` turns it on or off on this device, and `config` holds its settings: `displayName`, `home` (`default` for your own setup, `private` for a home of its own), the launch settings `binaryPath`, `args` and `env`, `signedOutInMousse`, and `telemetry` (`off` or `agent_setting`; absent means the default, see [Privacy and agent telemetry](#privacy-and-agent-telemetry)). Mousse also keeps `vendorMirror` (the launch settings it last copied to the agent's own settings file) and `knownProblemConsent` (a version you allowed to run despite a known problem) there; leave them as they are.

**Scopes.** `enabled` is the device setting. A project can turn an instance off for itself, or on again when the device has it on, and pick its own default; those choices live in `<profile>/harness/scopes.json`.

**Removed instances.** A removed provider stays removed until you add it again, even if an older version of Mousse re-creates its entry. Its id is listed in `removedInstances`, which wins over `instances`; only Add in Settings → Providers takes an id off the list.

**Launch settings live in the instance.** The executable, launch arguments and variables of every entry, and whether it is signed out in Mousse, are kept in its `config`. Earlier versions kept them for the built-in Claude Code, Codex and Antigravity entries in their own `settings.json` under the profile. Until the next release, Mousse still writes a copy there, so an older version you go back to reads the same settings. For good, Mousse also takes over a change an older version made in that file the next time it starts, and says so on the card; when both changed, it keeps its own and offers "Use the older settings".

---

## Privacy and agent telemetry

Mousse itself collects no usage data about you or your chats. Your chats go only to the providers you set up. Settings → General → Privacy lists every service Mousse itself contacts, when, and what it sends (the list is `src/shared/privacy/outbound.ts`).

The agents you connect may send their own usage and error reports (telemetry) to the company that makes them. Each provider in Settings → Providers has a **Telemetry** setting:

- **Off:** Mousse adds the agent's own documented switch to the processes it starts for that provider, after the provider's own launch variables and arguments (the table says which).
- **Agent's own setting:** Mousse sets nothing. The agent does what its own settings say.

| Agent | What Off sets |
|-------|---------------|
| Claude Code | `DISABLE_TELEMETRY=1` and `DISABLE_ERROR_REPORTING=1`, on every Claude Code process Mousse starts for it |
| Codex | `-c analytics.enabled=false` on every Codex process Mousse starts for it (chats, sign-in checks, sign-in and sign-out); only the version check (`codex --version`) runs without it |
| Model APIs (the Mousse agent, Pi) | `PI_TELEMETRY=0`, on every Pi process |
| Grok, Cursor, Antigravity, other ACP agents | Nothing: they document no switch, and their row shows "No switch" |

**Defaults.** Off for the agents Mousse sets up: an entry with a home of its own, an agent Mousse installed (such as Codex set up by Mousse), and the Mousse agent. Agent's own setting for your own CLIs on their usual home (`~/.claude`, `~/.codex`), so nothing changes for them until you choose Off.

**What Mousse never does.** It never edits an agent's settings files or home for this: the switch exists only in the processes Mousse starts. The same agent started from a terminal follows its own settings. Off covers only what the agent's switch covers (Claude Code's usage telemetry and error reports, Codex's analytics, Pi's install and update reports and the attribution headers it adds for some providers). It does not change what the agent sends to its model provider to do the work.

**Details.** A variable of the same name set on the provider is ignored while Telemetry is Off, and the editor marks it. A change applies from the agent's next start; a chat that is running keeps its process until its turn ends.

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
| `scheduled.agentJobs` | `boolean` | `false` | "Agents may create jobs" (Scheduled page): lets agents create, change, pause and run their own jobs through the `schedule_*` Mousse tools, from a turn a person started. It also needs the `manage` agent access level (`settings.agentAccess`). Off, the tools are not listed, every call is refused, and the jobs agents already made are paused with a reason (turning it on again does not resume them; a person does) |
| `scheduled.agentJobMaxActive` | `integer` (1 to 100) | `10` | "Max active jobs" (Scheduled page): active jobs agents may have in the profile at once. Only a person sets it (the Scheduled page or `scheduled.settings.set`); no tool an agent holds can. Read at every use, so a change needs no restart. Lowering it never pauses or deletes an existing job: it refuses the next `schedule_create` until there is room |
| `scheduled.agentJobMinIntervalMinutes` | `integer` (1 to 1440) | `15` | "Min interval (minutes)": the fewest minutes between runs of a job an agent creates or changes. Same rules as above. It is checked when an agent creates a job or changes its schedule; jobs that already exist keep their schedule |
| `scheduled.agentJobLifetimeDays` | `integer` (1 to 365) | `7` | "Lifetime (days)": how long a job an agent creates lasts unless a person extends it; also what "Extend" and `schedule extend` give when no number of days is named. It applies to jobs created or extended afterwards; the stored `expiresAt` of an existing job is not rewritten. A saved value that is not a whole number in range reads as the default |
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
| `permissionMode` | `ask` \| `accept_edits` \| `auto` \| `full` | no | How much a run may do without asking. Never above `permissionCeiling`. Absent: the run follows its thread's mode, up to the job's ceiling. Not allowed on a workflow job (a prompt starting with `/`) |
| `permissionCeiling` | `ask` \| `accept_edits` \| `auto` \| `full` | set by the daemon | The widest mode a run may have: the mode the job's creator held when they created or last edited it. Every job has one, whoever created it. No request can set it (the protocol refuses the key). A mode with no ceiling in a stored job gets `ask` |
| `createdBy` | `{ threadId, runId?, requestId? }` | no | The agent that created the job (and the creating call's key, so a retry finds the job it made); absent for jobs people create. Shown as "Created by an agent", and every run record of the job is labelled the same way. Set by Mousse; no request can set it |
| `accessCap` | `lineage` \| `read` \| `manage` | no | The most agent access a run of the job is granted: the level of whoever created it. Absent reads as `lineage`. Set by Mousse |
| `expiresAt` | ISO string | no | When the job ends. Set on jobs agents create (`scheduled.agentJobLifetimeDays`, 7 by default, after creation); the scheduler ends the job at that time (`completed`) and only a person extends it (the Scheduled page, `mousse-cli schedule extend`). Absent: no end |
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
- **Jobs agents create.** Agents get five tools (`schedule_list`, `schedule_create`, `schedule_update`, `schedule_pause`, `schedule_run`; see `docs/run-engine/SPEC.md` §15.1) when `scheduled.agentJobs` is on and the profile gives them the `manage` access level.
  - **Only a person's turn creates or starts jobs.** `schedule_create`, `schedule_run` and a `schedule_update` of anything but the name are refused unless a person started the run from the app or the CLI. A scheduled or webhook run, a message another agent sent, a subagent, a wake, a continuation, a bot, a remote send, a run with no recorded binding and one that cannot be read are all refused, so a job can never create or start jobs and no chain of jobs can form.
  - **Creator scope.** An agent lists, changes, pauses and runs only the jobs its own thread created through these tools. A person's job, and a job another thread made, are refused like jobs that do not exist. Every change an agent makes is an `agent.action` event on its thread with a row in its transcript, and the job and its run records are labelled "Created by an agent".
  - **Bounds.** A person sets them (`scheduled.agentJobMaxActive`, `agentJobMinIntervalMinutes`, `agentJobLifetimeDays`; defaults 10, 15 and 7), and the tools read them at every call. At most that many active agent-made jobs in the profile at once (counted from the saved jobs, so a restart does not reset it; paused and ended jobs do not count). A job runs no more often than every that many minutes (a cron expression has exactly five fields and a fixed list of minutes that far apart; above 60 minutes the hours it names must keep its runs that far apart too). A job ends that many days after it is made unless a person extends it. An agent can only shorten a job's number of runs. A lower limit does not delete or pause jobs that exist: it only refuses new creates or changes. A changed lifetime applies to jobs created or extended afterwards, and the `expiresAt` already stored is not rewritten. No `schedule_*` tool and no tool argument can change these settings.
  - **No more than the creator.** The job records the access level and permission mode of the turn that made it, and its runs get at most those; a change by an agent can only narrow them. A job cannot have a webhook, run a workflow (a prompt starting with `/`; agents do not create, change or start those), use an existing worktree, or be enabled again by an agent: a person resumes a paused job. `schedule_run` is refused in the same cases as Run now (running, claimed, a run in progress or waiting in a queue), for a paused job and for one that has ended.
  - **The setting is enforced.** While `scheduled.agentJobs` is off the scheduler does not run agent-made jobs: turning it off pauses them with a reason, and turning it on again does not resume them.
  - **Threads that are gone.** A job bound to a deleted or archived thread, or made from a thread that was deleted, pauses with a reason instead of failing on every tick.
- **`manual` jobs.** They have no next run and never complete; "Run now" starts them.
- **Webhook trigger.** A job with a `trigger` is started by `POST /hooks/<job id>` on the webhook listener (see `docs/CLI.md`). A request carries `X-Mousse-Timestamp` (within 5 minutes of the daemon's clock) and `X-Mousse-Signature: sha256=<hex>`, the HMAC-SHA256 of `<timestamp>.<raw body bytes>` under the job's secret, checked in constant time. A signature-valid request leaves a receipt in `scheduled/triggers/<job id>/receipts.json` (synced to disk before the request is answered, and kept until the request's timestamp can no longer pass the 5-minute check, so a captured request cannot be replayed, restarts included; a receipts file that cannot be read makes the job answer `503` until the secret is rotated, and a file full of still-valid receipts makes it answer `429` for a few minutes) and, when accepted, its body in `scheduled/triggers/<job id>/<delivery id>.json` (owner-only: mode `0600`, and on Windows the `triggers` folder is limited to your account and SYSTEM; deleted when the run ends or after a day if nothing references it). A delivery waits for the next scheduler tick, which is woken at once; a job runs one delivery at a time (`409` while one is running, waiting in a queue or pending). A delivery does not move an interval or cron job's own timer. `scheduled/triggers/<job id>/deliveries.json` logs the last 50 accepted deliveries (`accepted`, `queued`, `completed`, `failed`, `dispatch_failed`, `uncertain`) the last 20 refusals of signed requests (`running`, `pending`, `paused`, `replay`, `rate_limited`) and the last 20 requests that failed verification (`rejected_signature`, `too_large`), kept apart so unsigned traffic never pushes the others out. Every write to `scheduled/jobs-runtime.json` is synced to disk. A run started by a delivery fills the prompt's `{{body.path}}` placeholders from the stored body: single values only, each framed in a random `<webhook-data-ID>` tag, flattened to one line, with look-alike characters swapped in where a harness could read a `/skill`, `@file` or `$skill` mention, and capped (4 KiB each, 64 KiB in all), and kept in the run's thread history and records, not deleted with the stored body, with a note at the end that the tagged text is untrusted data; placeholders with no usable value are listed in the run record's `missingPlaceholders`. Headers and the secret are never available to a prompt (see `docs/CLI.md`).

Other scheduled files (unchanged):

- `$MOUSSE_HOME/scheduled/ticker_heartbeat` — ticker liveness
- `$MOUSSE_HOME/scheduled/ticker_last_success` — last successful tick
- `$MOUSSE_HOME/scheduled/.tick.lock`, `.jobs.lock` — file locks

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
| `$MOUSSE_HOME/scheduled/jobs.json` | `scheduled.jobs` (definitions) | `jobs.json.migrated` |

Original files are **not deleted**. Runtime from `jobs.json` is copied to `scheduled/jobs-runtime.json` on first access if needed.

After migration, edit **`mousse.conf`** (or use `mousse-cli config`) as the source of truth for configuration. Legacy paths are no longer written by `SettingsStore` or `ScheduledJobStore`.

A `channels` section and a `channels/` folder left by builds that had Channels (Telegram, Discord and webhook chats) are not read. The section stays in `mousse.conf` and is written back unchanged; nothing deletes the folder.

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

`MousseMainService.create({ homeDir })` loads config once and wires `SettingsStore` and `ScheduledJobStore` as views over the unified file.

## Thread workspace rollout flags

`mousse.conf.features` contains gated flags in dependency order: `subagentLifecycleV2`, `repositoryCoordination`, `externalThreadStorage`, `transactionalThreadStore`, `threadWorkspaces`, `turnCheckpoints`, `publish`, `latestTurnUndo`, `conversationBranches`, `codeRevertRedo`, and `threadTrashGc`. Configuration loading rejects a flag whose predecessor is disabled.

Repository-backed runtime data is stored beneath `$MOUSSE_HOME/thread-data/repositories/<repositoryId>/`; standalone data is beneath `$MOUSSE_HOME/thread-data/standalone/`. Legacy project `.mousse/.data` directories migrate lazily through copy/hash verification and recoverable migration trash.

Undo covers non-ignored files committed to the thread workspace. Ignored files, outside-workspace writes, MCP/network/database effects, and long-lived external processes are reported as non-reversible effects.
