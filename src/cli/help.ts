export const CLI_NAME = 'mousse-cli'

export const ROOT_HELP = `${CLI_NAME} — headless Mousse orchestrator CLI

Usage:
  mousse-cli [options] [message...]          Interactive orchestrator chat (TTY) or one-shot
  mousse-cli schedule <subcommand>           Manage scheduled jobs
  mousse-cli agents <subcommand>             Spawn/list/stop background CLI agents
  mousse-cli channels <subcommand>           Channel setup (Telegram, Discord, Webhook)
  mousse-cli config <subcommand>             Read/write ~/.mousse/mousse.conf
  mousse-cli service <subcommand>            MMS daemon control and startup install
  mousse-cli connections <subcommand>        Approve or revoke remote client access
  mousse-cli workspace --session <id>        Show authoritative thread workspace status
  mousse-cli publish --session <id> --target <branch>
  mousse-cli undo|redo --session <id>         Compensate the latest thread action
  mousse-cli revert-code --session <id> --action <id>
  mousse-cli fork --session <id> --action <id>
  mousse-cli operation abort <id> --session <id>

Global options:
  -p, --print                 Print response and exit (non-interactive / automation)
  --mode <text|json>          Output format (default: text)
  --provider <id>             Override orchestrator LLM provider
  --model <id>                Override orchestrator model
  --api-key <key>             API key for this run (not stored in mousse.conf)
  -c, --continue              Continue the most recent thread session
  --session <id>              Use a specific thread/session id
  --home <dir>                MOUSSE_HOME directory (default: ~/.mousse)
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

One-shot (-p / piped / non-TTY):
  /stop                       Abort if a turn is in-flight in this process
  /steer <prompt>             Steers only when a turn is active (no silent fallback)

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

export const CONNECTIONS_HELP = `Usage:
  mousse-cli connections list
  mousse-cli connections approve <request-id>
  mousse-cli connections revoke <client-id>
`

export function commandHelp(command: string): string | null {
  switch (command) {
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
    case 'connections':
      return CONNECTIONS_HELP
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
