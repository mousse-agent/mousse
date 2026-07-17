# mousse-cli

Headless command-line interface for [Mousse Main Service (MMS)](MMS_PLAN.md). The CLI runs without Electron and shares configuration with the GUI via `~/.mousse/mousse.conf`.

## Install

### Packaged desktop app (Windows installer / downloaded build)

The installer ships a `mousse-cli.cmd` next to `Mousse.exe` and appends the install directory to your **user PATH**.

After installing (open a **new** terminal so PATH refreshes):

```bash
mousse-cli --version
mousse-cli service status
```

Under the hood this runs the GUI binary in headless dual-mode:

```text
Mousse.exe --cli …
```

You can also invoke that form directly, or run `mousse-cli.cmd` from the install folder if PATH was not updated (portable / unpacked builds).

> Do **not** rely on `ELECTRON_RUN_AS_NODE` for the packaged CLI — that path hits Node/Electron undici incompatibilities. Always use `--cli` / `mousse-cli.cmd`.

### Development checkout

After `npm run build`:

```bash
npm link
mousse-cli --version
```

The `mousse-cli` binary is declared in `package.json` and points at `out/cli/index.js`. Packaged Electron builds also include the CLI entry and dual-mode `Mousse.exe --cli` support.

Set a custom data directory:

```bash
export MOUSSE_HOME=/var/lib/mousse   # Linux server
mousse-cli --home /var/lib/mousse service run
```

## Quick start (VPS / headless)

```bash
# Configure orchestrator provider (secrets -> ~/.mousse/auth.json)
mousse-cli config providers --provider anthropic --api-key "$ANTHROPIC_API_KEY"

# One-shot orchestrator chat
mousse-cli -p "Review the repo and suggest improvements"

# Run MMS in the foreground (channels + scheduler)
mousse-cli service run

# Run as a background daemon
mousse-cli service start
mousse-cli service status
mousse-cli service stop
```

For boot-time autostart, see [STARTUP.md](STARTUP.md) (installed via `mousse-cli service install`).

## Global options

| Flag | Description |
|------|-------------|
| `-p`, `--print` | Non-interactive: print the response and exit |
| `--mode text\|json` | Output format (default: `text`) |
| `--provider <id>` | Override orchestrator LLM provider for this run |
| `--model <id>` | Override orchestrator model |
| `--api-key <key>` | API key for this run only (never written to `mousse.conf`) |
| `-c`, `--continue` | Continue the most recent thread session |
| `--session <id>` | Use a specific thread/session id |
| `--home <dir>` | Set `MOUSSE_HOME` (default: `~/.mousse`) |
| `-v`, `--version` | Print version |
| `-h`, `--help` | Show help |

Pi-style conventions: kebab-case flags, clean text by default, JSON lines with `--mode json`.

## Default command: orchestrator chat

```bash
mousse-cli [options] [message...]
```

Examples:

```bash
mousse-cli "List open tasks for this project"
mousse-cli -p "Summarize recent git changes"
cat README.md | mousse-cli -p "Summarize this document"
mousse-cli --mode json -p "What agents are running?"
mousse-cli -c -p "Continue where we left off"
mousse-cli --session abc123 -p "Follow up on the plan"
```

## schedule

Manage scheduled orchestrator jobs (stored in `mousse.conf` → `scheduled.jobs`).

```bash
mousse-cli schedule list
mousse-cli schedule add --name "Daily standup" --prompt "Summarize overnight activity" --every 1440
mousse-cli schedule add --name "Cron job" --prompt "Check CI" --cron "0 9 * * 1-5"
mousse-cli schedule add --name "Once" --prompt "Run audit" --at "2026-07-03T09:00:00Z"
mousse-cli schedule run <job-id>
mousse-cli schedule enable <job-id>
mousse-cli schedule disable <job-id>
mousse-cli schedule remove <job-id>
```

## agents

Background CLI agents in git worktrees.

```bash
mousse-cli agents list
mousse-cli agents spawn --cli claude-code --task "Implement feature X"
mousse-cli agents spawn --cli codex --task "Fix failing tests"
mousse-cli agents stop <agent-id>
mousse-cli agents stop <agent-id> --merge
```

Supported `--cli` values: `mousse`, `claude-code`, `codex`, `opencode`, `cursor-agents-cli`.

## channels

Configure Telegram, Discord, and Webhook adapters from the CLI.

```bash
mousse-cli channels list
mousse-cli channels add telegram --token "$TELEGRAM_BOT_TOKEN" --user-id 123456789
mousse-cli channels add discord --token "$DISCORD_BOT_TOKEN"
mousse-cli channels add webhook --webhook-port 8787 --webhook-secret "$SECRET"
mousse-cli channels enable telegram
mousse-cli channels disable discord
mousse-cli channels remove webhook
mousse-cli channels pair list
mousse-cli channels pair approve <code>
mousse-cli channels pair reject <code>
```

Channel secrets are stored in `mousse.conf` (redacted in list output). Pairing codes approve DMs when `unauthorizedDmBehavior` is `pair`.

## config

Dotted-path access to unified config at `~/.mousse/mousse.conf`.

```bash
mousse-cli config list
mousse-cli config list settings.appearance
mousse-cli config get settings.provider.model
mousse-cli config set mms.logLevel "\"debug\""
mousse-cli config set scheduled.enabled true
```

### config providers

Set up orchestrator LLM credentials interactively or via flags:

```bash
mousse-cli config providers
mousse-cli config providers --provider anthropic --api-key "$ANTHROPIC_API_KEY" --model claude-sonnet-4-20250514
```

- Provider and model preferences are stored in `mousse.conf` (`settings.provider`).
- API keys and OAuth tokens are stored in `~/.mousse/auth.json` via `ProviderAuthService`, never in `mousse.conf`.

## service

Control the MMS daemon and OS startup integration.

| Command | Description |
|---------|-------------|
| `service run` | Foreground MMS (`MousseMainService.create({ headless: true })` then `start()`) |
| `service start` | Detached `service run`; pidfile at `~/.mousse/mms.pid` |
| `service stop` | Stop via pidfile |
| `service status` | Running state, pid, startup install status |
| `service install` | Register launch-on-startup (platform-specific) |
| `service uninstall` | Remove launch-on-startup entry |

```bash
mousse-cli service run
mousse-cli service start
mousse-cli service status --mode json
mousse-cli service install
```

## Relationship to the GUI app

| Concern | GUI (Electron) | mousse-cli |
|---------|----------------|------------|
| Core runtime | `MousseMainService` in main process | Same MMS, headless |
| Config | `~/.mousse/mousse.conf` | Same file |
| Secrets | `~/.mousse/auth.json` | Same file |
| Orchestrator chat | Renderer UI | `-p` / default command |
| Channels / scheduler | Settings panels | `channels`, `schedule` subcommands |
| Agents | Agents panel + terminals | `agents` subcommands |
| Startup | Optional MMS autostart | `service install` |

Run both on the same machine by pointing them at the same `MOUSSE_HOME`. Avoid running two MMS daemons (`service run`) against one home directory.

## Server deployment notes

1. Install Node.js 20+ and build or install Mousse.
2. Set `MOUSSE_HOME` to a persistent path (e.g. `/var/lib/mousse`).
3. Configure provider: `mousse-cli config providers ...`
4. Start MMS: `mousse-cli service start` or use systemd via `service install` on Linux.
5. On headless Linux servers, enable user lingering if MMS should run without login: `loginctl enable-linger $USER` (see [STARTUP.md](STARTUP.md)).

The CLI never loads Electron; it imports only `src/mms/**` and `src/shared/**`.
