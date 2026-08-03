import type { Agent, CliType } from '../../shared/types'
import type { ParsedArgs } from '../parseArgs'
import { flagBool, flagString } from '../parseArgs'
import { exitWithError, formatTable, writeOutput } from '../output'
import { closeMmsContext, openMms } from '../mmsContext'
import { AGENTS_HELP } from '../help'

const CLI_TYPES = new Set<CliType>([
  'mousse',
  'claude-code',
  'codex',
  'opencode',
  'cursor-agents-cli'
])

export async function runAgents(args: ParsedArgs): Promise<void> {
  const { globals, subcommand, positional, flags } = args

  if (!subcommand || subcommand === 'help' || globals.help) {
    process.stdout.write(AGENTS_HELP)
    return
  }

  const ctx = await openMms(globals)
  const client = ctx.client

  try {
    switch (subcommand) {
      case 'list': {
        const threads = await client.request<{ threads: { id: string; settledAt?: string }[] }>(
          'threads.list'
        )
        const threadId =
          globals.sessionId ??
          threads.threads.find((t) => !t.settledAt)?.id
        if (!threadId) {
          writeOutput(globals.mode, [], () => 'No agents (no open thread).')
          break
        }
        const res = await client.request<{ agents: Agent[] }>('agents.list', { threadId })
        writeOutput(globals.mode, res.agents, (data) => {
          const rows = data as Agent[]
          if (rows.length === 0) return 'No agents.'
          return formatTable([
            ['ID', 'CLI', 'STATUS', 'TASK'],
            ...rows.map((agent: Agent) => [
              agent.id.slice(0, 8),
              agent.cliType,
              agent.status,
              agent.task.slice(0, 40)
            ])
          ])
        })
        break
      }
      case 'spawn': {
        const cliType = flagString(flags, 'cli') as CliType | undefined
        const task = flagString(flags, 'task') ?? positional.join(' ')
        if (!cliType || !CLI_TYPES.has(cliType)) {
          exitWithError(
            'agents spawn requires --cli <mousse|claude-code|codex|opencode|cursor-agents-cli> and --task.',
            globals.mode
          )
        }
        if (!task.trim()) {
          exitWithError('agents spawn requires --task.', globals.mode)
        }
        exitWithError(
          'agents spawn is not a standalone protocol method; spawn subagents via orchestrator chat (GUI or CLI).',
          globals.mode
        )
        break
      }
      case 'stop': {
        exitWithError(
          'agents stop is not a standalone protocol method; stop from GUI or abort the turn with /stop.',
          globals.mode
        )
        break
      }
      default:
        exitWithError(`Unknown agents subcommand: ${subcommand}`, globals.mode)
    }
  } finally {
    await closeMmsContext(ctx)
  }
}
