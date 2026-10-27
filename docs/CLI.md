# mousse-cli

To display a QR for the configured HTTPS mobile endpoint:

```bash
mousse-cli connections qr
```

Headless command-line interface for [Mousse Main Service (MMS)](ARCHITECTURE.md). Normal commands are **protocol clients** to the local daemon (autostart when absent). Only `service run` constructs the exclusive MMS owner. Shares configuration with the GUI via `~/.mousse/mousse.conf`.

## Profiles, workflows, and browser setup

Use `--profile <id|slug>` to bind personal commands. Provider credentials and model availability remain shared. Published workflows can be invoked from main-agent chat with `/<slug> ...` or `/workflow <slug> ...`; the explicit form resolves Skill name collisions.

```text
mousse-cli --profile <id-or-slug> workflow list
mousse-cli workflow run <slug-or-id> --input '{"argument":"value"}'
mousse-cli workflow show <run-id>
mousse-cli workflow watch <run-id>
mousse-cli workflow cancel <run-id>
mousse-cli browser status
mousse-cli browser install
mousse-cli browser cancel <operation-id>
```

Structured workflow runs wait by default; `--no-wait` returns after durable admission. A busy one-shot chat invocation may instead return queued acceptance. Monitoring cancellation does not implicitly cancel a durable workflow or browser installation. `workflow --help` describes approvals, inputs, revision pins, and recovery. GUI automation uses the existing in-app tab; CLI/background automation requires the explicitly installed managed browser. See [usage and support boundaries](implementation/agent-platform/usage-and-support.md).

## Install

`npm run dist` produces two distributions (`dist:win` is the desktop installer only; `dist:win:cli` is the portable CLI):

- `release/` — the desktop application, whose executable also supports `--cli` (`mousse-cli` / `mousse-cli.exe` on PATH)
- `release/cli/` — a dedicated GUI-free `mousse-cli` artifact for SSH/headless hosts

On Windows the CLI artifact is a portable executable; Linux uses AppImage and macOS uses a zip archive.

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

# One-shot orchestrator chat (starts daemon if needed)
mousse-cli -p "Review the repo and suggest improvements"

# Interactive chat over protocol (/stop, /steer, /threads, /exit)
mousse-cli

# Run MMS in the foreground (sole owner process)
mousse-cli service run

# Run as a background daemon
mousse-cli service start
mousse-cli service status
mousse-cli service stop
```

For boot-time autostart, see [STARTUP.md](STARTUP.md) (installed via `mousse-cli service install`).

Or add the machine from the app: **Settings → Devices → Add device → Remote machine over SSH** installs `mousse-cli`, installs the service and joins the machine to your devices over SSH, with a plan shown first and an undo afterwards. See [net/ssh-setup.md](net/ssh-setup.md).

### Reachable only over SSH

A machine that other devices can only reach with `ssh` (no open port, no Tailscale) can advertise an SSH route. Put the settings in a private file and enable the `ssh` add-on on that machine:

```bash
# endpoint is what other devices type after `ssh`; port is a free loopback port for the daemon
echo '{"endpoint":"me@box.example.com","port":47821}' > ssh.json && chmod 600 ssh.json
mousse-cli net transport configure ssh --settings-file ssh.json
```

SSH is dial-side only on the devices that connect: each one approves the endpoint for that machine before Mousse will run `ssh` against it. See [net/ssh-setup.md](net/ssh-setup.md).

The app uses three CLI pieces that you can also run by hand:

```bash
mousse-cli net routes                       # this node's signed routes, which the computer that set it up adopts
mousse-cli bridge join --via ws://127.0.0.1:<port>/mousse-net   # reach the inviter through a reverse SSH tunnel first (invite on stdin)
mousse-cli service install --headless       # Linux: add ELECTRON_DISABLE_SANDBOX=1 to the unit (no windows, no setuid sandbox helper)
```

`--via` accepts only a loopback `ws://127.0.0.1:<port>/mousse-net` address; the inviter's pinned key is still checked. `mousse-cli net transports` also lists the saved add-on settings (`saved`).

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

### Interactive mode (default on a TTY)

Without `-p`/`--print`, on an interactive terminal, `mousse-cli` opens a **pi-style** session:

- Pi's interactive terminal UI and multi-line editor, powered directly by `@earendil-works/pi-tui` 0.80.7 (with a readline fallback if the TUI cannot load)
- Slash commands shared with Telegram/Discord (`/threads`, `/models`, `/steer`, `/stop`, …)
- Ordinary messages submitted while a turn is busy **stack FIFO** and run next
- `/steer <text>` targets the **active turn** only (never rewritten as a normal message)
- Ctrl+C once stops the in-flight turn; twice (or `/exit`) leaves the session

```bash
mousse-cli                              # interactive
mousse-cli "Continue the plan"          # interactive, seed first user message
mousse-cli -c                           # continue last thread interactively
mousse-cli --session <id>               # bind a specific thread
```

Interactive commands:

| Command | Description |
|---------|-------------|
| `/threads [id\|index\|name]` | List threads (`*` = current) or select by exact id, short id, 1-based index, or unambiguous name. Rebinds the session **without wiping history**. |
| `/thread …` | Singular alias of `/threads` |
| `/models [name] [--session\|--thread\|--global]` | List configured models (`*` = current) or switch; default switch is session/thread-scoped |
| `/model …` | Same as `/models` |
| `/steer <prompt>` | Mid-turn guidance for the active turn only |
| `/stop` | Abort the in-flight turn |
| `/help` | Command help |
| `/exit` | Leave interactive mode |

### Non-interactive / automation

`-p`/`--print`, piped stdin, or non-TTY still run **one-shot** and exit. JSON automation via `--mode json` is unchanged.

```bash
mousse-cli -p "Summarize recent git changes"
cat README.md | mousse-cli -p "Summarize this document"
mousse-cli --mode json -p "What agents are running?"
mousse-cli -c -p "Continue where we left off"
mousse-cli --session abc123 -p "Follow up on the plan"
```

Channel surfaces (Telegram/Discord) expose the same `/threads`, `/models`, `/steer`, and FIFO stacking semantics via the shared registry in `src/shared/channelCommands.ts`.
## schedule

Manage scheduled orchestrator jobs (stored in `mousse.conf` → `scheduled.jobs`).

```bash
mousse-cli schedule list
mousse-cli schedule add --name "Daily standup" --prompt "Summarize overnight activity" --every 1440
mousse-cli schedule add --name "Cron job" --prompt "Check CI" --cron "0 9 * * 1-5"
mousse-cli schedule add --name "Once" --prompt "Run audit" --at "2026-07-03T09:00:00Z"
mousse-cli schedule add --name "Check CI" --prompt "Check CI in repo X" --manual \
  --project <project-id> --instance <instance-id> --model <model> --mode agent --workspace new-worktree
mousse-cli schedule run <job-id>
mousse-cli schedule enable <job-id>
mousse-cli schedule disable <job-id>
mousse-cli schedule remove <job-id>
```

A job runs as a turn on a thread. `--instance` and `--model` choose the provider instance and model, `--mode agent|plan` the mode, and `--workspace project|new-worktree|<path>` where it works (`project`, the default, is the project's own checkout: an agent-mode job there edits the folder you work in, unattended, with no checkpoints or undo. For a Git project, prefer `new-worktree`). `--thread <id>` runs the job on an existing thread with its history and its own workspace. `--manual` makes a job with no clock that runs only with `schedule run`. `schedule list` shows the job's model, and `queued` while a run waits behind a busy thread.

### Webhook trigger

A job can also be started by a signed HTTP request, for example from a CI system or a script on this machine.

```bash
mousse-cli schedule webhook enable <job-id> [--port 18790]   # prints the URL and the secret, once; on a job that has one, --port moves the listener
mousse-cli schedule webhook rotate <job-id>                  # new secret; the old one stops working at once
mousse-cli schedule webhook disable <job-id>
mousse-cli schedule webhook deliveries <job-id>              # recent requests and what became of each
```

Sending a request (the signature covers the timestamp and the exact body bytes):

```bash
BODY='{"event":"deploy","ref":"main"}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
curl -sS -X POST "http://127.0.0.1:18790/hooks/<job-id>" \
  -H "X-Mousse-Timestamp: $TS" -H "X-Mousse-Signature: sha256=$SIG" \
  --data-binary "$BODY"
```

| Status | Meaning |
|--------|---------|
| `202` | Accepted: the delivery and its replay record are saved, and the job starts within seconds. |
| `401` | Not authenticated: wrong or missing signature, a timestamp more than 5 minutes from this machine's clock, a job without a webhook, or an unknown job. All look the same on purpose. |
| `403` | Not a plain local request (a browser `Origin`, or a `Host` other than `127.0.0.1`, `localhost` or `[::1]` with the port). |
| `404` | Not `POST /hooks/<job-id>`. |
| `503` | Not accepted, and nothing was used up: the scheduler is off, the job's replay record is unreadable (rotate the secret to repair it), or the daemon is busy or shutting down. |
| `409` | `replay` (this exact request was already received), `running` (the job is running or its run is waiting in a queue), `pending` (another delivery is waiting to start) or `paused`. |
| `413` | Body over 1 MiB. |
| `429` | More than 60 signed requests for this job in a minute. |

Things to know:

- **A request that is answered `409` or `429` is used up.** Its signature is remembered until its timestamp can no longer pass the 5-minute check (up to 6 minutes after it arrived), so it can never be delivered later. To retry, sign again with a fresh timestamp (two requests with the same body in the same second share a signature). If a job's record fills with requests that could still be replayed, it refuses every request for a few minutes (`429`) instead of forgetting any.
- **One delivery at a time per job.** While a run is going or waiting, further requests get `409`; none is queued.
- **The body does not reach the job's prompt.** It is stored until the run ends and then deleted, in a folder only your account can read (owner-only permissions on macOS and Linux; on Windows the folder's access list is reduced to your account and SYSTEM, and a webhook cannot be enabled if that fails). Placeholders for body fields come later.
- **Local only.** The listener binds `127.0.0.1` and refuses browser requests; it is not meant to be exposed. It runs only while some job has a webhook, and a port that a net transport of this profile uses (for example one Tailscale Serve forwards to) is refused. A tunnel makes the unauthenticated surface remote: anyone who can reach the tunnel can send requests (every one that is not correctly signed gets `401`). An HTTP tunnel must rewrite `Host` to `127.0.0.1:<port>`, or every request gets `403`.
- **The secret** is stored in the profile's secret file and is never logged or returned again after `enable` or `rotate`. The daemon's own protocol belongs to processes running as you (they hold its owner token), and any of them can rotate a job's secret or read the secret file; the signature keeps other senders out, not the rest of your own account.
- A one-time job cannot have a webhook (it would finish after one run); use a `--manual` job. Jobs created by an agent cannot have one either.
- A webhook-started run is an ordinary scheduled run: same model, mode, workspace and access cap, and it does not move an interval or cron job's timer.

## agents

Agents in git worktrees kept from earlier versions. New work is delegated from a turn with `delegate_task`.

```bash
mousse-cli agents list
mousse-cli agents stop <agent-id>
mousse-cli agents stop <agent-id> --merge
```

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
mousse-cli config providers --provider xai --api-key "$XAI_API_KEY" --model grok-4.5
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
| Orchestrator chat | Renderer UI | Interactive TUI (TTY) or `-p` one-shot |
| Channels / scheduler | Settings panels | `channels`, `schedule` subcommands |
| Agents | Try Agent in Automations, terminals | `agents` subcommands |
| Startup | Optional MMS autostart | `service install` |

Run both on the same machine by pointing them at the same `MOUSSE_HOME`. Avoid running two MMS daemons (`service run`) against one home directory.

## Server deployment notes

1. Install Node.js 20+ and build or install Mousse.
2. Set `MOUSSE_HOME` to a persistent path (e.g. `/var/lib/mousse`).
3. Configure provider: `mousse-cli config providers ...`
4. Start MMS: `mousse-cli service start` or use systemd via `service install` on Linux.
5. On headless Linux servers, enable user lingering if MMS should run without login: `loginctl enable-linger $USER` (see [STARTUP.md](STARTUP.md)).

The standalone Node CLI remains a protocol client. The bundled CLI also supports running under Electron: it selects the installation vault before readiness, then owns the headless daemon. A Node daemon may use a fresh plaintext store, but safely refuses an existing Electron-encrypted store; use the Electron daemon for that installation.

## Thread workspace and history commands

```bash
mousse-cli workspace --session <thread>
mousse-cli publish --session <thread> --target <branch>
mousse-cli undo --session <thread>
mousse-cli redo --session <thread>
mousse-cli fork --session <thread> --action <action> [--name <name>]
mousse-cli operation abort <operation> --session <thread>
```

Mutating commands are daemon-backed and include the observed journal generation. A stale client is rejected instead of executing against obsolete state. `--session` is mandatory whenever more than one open thread exists.
