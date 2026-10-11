import { RELAY_HELP } from './commands/relay'
import { NET_HELP, BRIDGE_HELP } from './commands/net'
import { BRIDGE_HUB_HELP } from './commands/bridge'
import { SPACES_HELP } from './commands/spaces'
import { BOTS_HELP } from './commands/bots'
import { BROWSER_HELP } from './commands/browser'

export const CLI_NAME = 'mousse-cli'

export const ROOT_HELP = `${CLI_NAME} — headless Mousse orchestrator CLI

Usage:
  mousse-cli [options] [message...]          Interactive orchestrator chat (TTY) or one-shot
  mousse-cli chat "/<workflow> --arg value"   Invoke a published workflow from chat
  mousse-cli schedule <subcommand>           Manage scheduled jobs
  mousse-cli workflow <subcommand>           Run and inspect durable workflows
  mousse-cli browser <status|install|cancel> Manage browser automation setup
  mousse-cli agents <subcommand>             Spawn/list/stop background CLI agents
  mousse-cli channels <subcommand>           Channel setup (Telegram, Discord, Webhook)
  mousse-cli config <subcommand>             Read/write ~/.mousse/mousse.conf
  mousse-cli service <subcommand>            MMS daemon control and startup install
  mousse-cli relay serve                    Run a self-hosted relay in the foreground
  mousse-cli net <subcommand>               Network identity, transports and recovery
  mousse-cli bridge <subcommand>            Link and control my devices
  mousse-cli spaces <subcommand>            Shared channels, membership and durable posts
  mousse-cli bots <subcommand>              Owner-local bot configuration and controls
  mousse-cli control <subcommand>            Retired Control Protocol 2.0 command
  mousse-cli connections <subcommand>        Retired mobile pairing command
  mousse-cli login                           Retired Control Protocol 2.0 login
  mousse-cli logout                          Retired Plus sign-out command
  mousse-cli workspace --session <id>        Show authoritative thread workspace status
  mousse-cli publish --session <id> --target <branch>
  mousse-cli undo|redo --session <id>         Compensate the latest thread action
  mousse-cli revert-code --session <id> --action <id>
  mousse-cli fork --session <id> --action <id>
  mousse-cli operation abort <id> --session <id>

Global options:
  -p, --print                 Print response and exit (non-interactive / automation)
  --mode <text|json>          Output format (default: text)
  --json                     JSON output (workflow progress uses one event per line)
  --provider <id>             Override orchestrator LLM provider
  --model <id>                Override orchestrator model
  --api-key <key>             API key for this run (not stored in mousse.conf)
  -c, --continue              Continue the most recent thread session
  --session <id>              Use a specific thread/session id
  --home <dir>                MOUSSE_HOME directory (default: ~/.mousse)
  --profile <id|slug>         Bind this invocation to a profile (providers stay shared)
  -v, --version               Show version
  -h, --help                  Show help

Interactive chat (default on a TTY without -p):
  Ongoing transcript + input (pi-style TUI when pi-tui is available).
  Messages while busy stack FIFO. Ctrl+C stops a turn; twice or /exit quits.

  /threads [id|index|name]    List or select a thread (history preserved)
  /thread …                   Alias of /threads
  /models [name]              List or switch models (* marks current)
  /model [name]               Same as /models
  /steer <prompt>             Mid-turn guidance for the active turn only
  /stop                       Abort the in-flight turn
  /help                       Interactive command help
  /exit                       Leave interactive mode
  /<workflow> [arguments]     Run a published workflow in the current profile
  /workflow <name> [...]     Resolve a workflow/skill name collision explicitly
  /skill <name> [...]        Select a Skill explicitly
  //text                      Send literal text beginning with a slash

One-shot (-p / piped / non-TTY):
  /stop                       Abort if a turn is in-flight in this process
  /steer <prompt>             Steers only when a turn is active (no silent fallback)
  /<workflow> [arguments]     Run via the same resolver used by the app
  --request-id <uuid>         Reuse with identical slash input after a lost reply
  --no-wait                  Return after workflow admission (otherwise wait)

Quote a complete slash invocation so the shell passes its named arguments as text.
For a busy thread, chat reports queued acceptance; inspect workflow history to follow it.
Interactive chat returns after admission. Durable runs continue in the daemon.
Slash invocations do not accept provider, model or API-key overrides.

Examples:
  mousse-cli                              # interactive
  mousse-cli "Continue the plan"          # interactive, seed first message
  mousse-cli -p "Summarize this repo"     # print and exit
  cat README.md | mousse-cli -p "Summarize this text"
  mousse-cli --mode json schedule list
  mousse-cli service run
`

export const SCHEDULE_HELP = `Usage:
  mousse-cli schedule list
  mousse-cli schedule add --name <name> --prompt <text> --every <minutes>
  mousse-cli schedule add --name <name> --prompt <text> --cron <expr>
  mousse-cli schedule add --name <name> --prompt <text> --at <iso-datetime>
  mousse-cli schedule remove <id>
  mousse-cli schedule run <id>
  mousse-cli schedule enable <id>
  mousse-cli schedule disable <id>
`

export const WORKFLOW_HELP = `Usage:
  mousse-cli [--profile <id|slug>] workflow list
  mousse-cli workflow info <slug|id>
  mousse-cli workflow run <slug|id> [--input <json> | --input-file <path>]
    [--revision <hash> | --draft --expected-draft <hash>]
    [--session <thread-id>] [--project <project-id>] [--request-id <uuid>]
    [--wait | --no-wait] [--json]
  mousse-cli workflow history [--definition <id>] [--session <thread-id>]
    [--limit <1..100>] [--before <cursor>]
  mousse-cli workflow show|watch|pause|resume|cancel <run-id>
  mousse-cli workflow trace <run-id> [--after <sequence>] [--limit <1..100>]
  mousse-cli workflow approve <run-id> --approval-id <id> (--yes | --deny)
  mousse-cli workflow answer <run-id> --node <id> --instance <key>
    (--input <json> | --input-file <path>)
  mousse-cli workflow reconcile <run-id> --node <id> --instance <key>
    --attempt <number> --decision fail

Run waits by default. --no-wait returns after durable admission. The daemon pins
the published revision atomically; --revision selects an exact published version.
Draft execution requires the exact saved draft hash. Inputs are JSON, never shell code.
Keep the printed request ID and identical arguments when retrying a lost acknowledgement.
The workflows command is an alias of workflow. Provider overrides are not accepted.

Wait exit codes: 0 succeeded; 1 execution failed; 2 invalid request/dependency or
connection failure; 3 human input/approval required; 4 cancelled; 5 recovery required.
Waiting for human input leaves the durable run pending. Inspect it with show and
use approve/answer explicitly, then watch. Trace/history return bounded pages.
Ctrl+C during run --wait requests cancellation of that foreground run. Ctrl+C
during watch only stops monitoring (exit 130); disconnect alone does not cancel.
`

export const AGENTS_HELP = `Usage:
  mousse-cli agents list
  mousse-cli agents spawn --cli <type> --task <description> [--provider <id> --model <id>] [--effort <level>]
  mousse-cli agents stop <id> [--merge]

Mousse subagent overrides:
  --provider <id> --model <id>  Use a specific connected provider and model (supply both)
  --effort <level>              Reasoning effort: off, minimal, low, medium, high, xhigh, or max
`

export const THREAD_ACTION_HELP = `Usage:
  mousse-cli workspace --session <thread>
  mousse-cli publish --session <thread> --target <branch>
  mousse-cli undo --session <thread>
  mousse-cli redo --session <thread>
  mousse-cli revert-code --session <thread> --action <action>
  mousse-cli fork --session <thread> --action <action> [--name <name>]
  mousse-cli operation abort <operation> --session <thread>
`

export const CHANNELS_HELP = `Usage:
  mousse-cli channels list
  mousse-cli channels add <telegram|discord|webhook> [options]
  mousse-cli channels remove <platform>
  mousse-cli channels enable <platform>
  mousse-cli channels disable <platform>
  mousse-cli channels pair list
  mousse-cli channels pair approve <code>
  mousse-cli channels pair reject <code>

Platform flags:
  --token <token>             Bot token (Telegram/Discord)
  --webhook-port <port>       Webhook listener port
  --webhook-secret <secret>   Webhook HMAC secret
  --allow-all                 Allow all users (not recommended)
  --user-id <id>              Allowed user/chat id (repeatable)
`

export const CONFIG_HELP = `Usage:
  mousse-cli config list [prefix]
  mousse-cli config get <dotted.path>
  mousse-cli config set <dotted.path> <json-value>
  mousse-cli config providers [--provider <id>] [--model <id>] [--api-key <key>]
`

export const SERVICE_HELP = `Usage:
  mousse-cli service run              Run MMS in the foreground (headless)
  mousse-cli service start            Spawn detached service run (pidfile)
  mousse-cli service stop             Stop daemon via pidfile
  mousse-cli service status           Show daemon status
  mousse-cli service install          Install launch-on-startup entry
  mousse-cli service uninstall        Remove launch-on-startup entry
`

export const CONTROL_HELP = `Retired Control Protocol 2.0 command. Use net init and bridge invite/join. Legacy credentials and pairings are preserved migration data, not Net enrollment.
`

export const CONNECTIONS_HELP = `Retired Control Protocol 2.0 command. Use net init and bridge invite/join. Legacy credentials and pairings are preserved migration data, not Net enrollment.
`

export const LOGIN_HELP = `Retired Control Protocol 2.0 command. Use net init and bridge invite/join. Legacy credentials and pairings are preserved migration data, not Net enrollment.
`

export const LOGOUT_HELP = `Retired Control Protocol 2.0 command. Use net init and bridge invite/join. Legacy credentials and pairings are preserved migration data, not Net enrollment.
`

export function commandHelp(command: string): string | null {
  switch (command) {
    case 'browser':
      return BROWSER_HELP
    case 'workflow':
    case 'workflows':
      return WORKFLOW_HELP
    case 'schedule':
      return SCHEDULE_HELP
    case 'agents':
      return AGENTS_HELP
    case 'channels':
      return CHANNELS_HELP
    case 'config':
      return CONFIG_HELP
    case 'service':
      return SERVICE_HELP
    case 'relay':
      return RELAY_HELP
    case 'net':
      return NET_HELP
    case 'bridge':
      return BRIDGE_HELP + '\n' + BRIDGE_HUB_HELP
    case 'spaces':
      return SPACES_HELP
    case 'bots':
      return BOTS_HELP
    case 'control':
      return CONTROL_HELP
    case 'connections':
      return CONNECTIONS_HELP
    case 'login':
      return LOGIN_HELP
    case 'logout':
      return LOGOUT_HELP
    case 'workspace':
    case 'publish':
    case 'undo':
    case 'revert-code':
    case 'redo':
    case 'fork':
    case 'operation':
      return THREAD_ACTION_HELP
    default:
      return null
  }
}
