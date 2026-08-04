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
        if (!task.trim()) exitWithError('agents spawn requires --task.', globals.mode)
        if ((globals.provider === undefined) !== (globals.model === undefined)) {
          exitWithError('agents spawn requires --provider and --model together.', globals.mode)
        }
        const threadId = await resolveThreadId(client, globals.sessionId)
        const effort = flagString(flags, 'effort')
        const res = await client.request<{ logs: string[] }>('agents.spawn', {
          threadId,
          cliType,
          task,
          ...(globals.provider ? { provider: globals.provider } : {}),
          ...(globals.model ? { model: globals.model } : {}),
          ...(effort ? { effort } : {})
        })
        writeOutput(globals.mode, res, (data) => (data as { logs: string[] }).logs.join('\n'))
        break
      }
      case 'stop': {
        const agentId = positional[0]
        if (!agentId) exitWithError('agents stop requires an agent id.', globals.mode)
        const threadId = await resolveThreadId(client, globals.sessionId)
        const res = await client.request<{ logs: string[] }>('agents.stop', {
          threadId,
          agentId,
          merge: flagBool(flags, 'merge')
        })
        writeOutput(globals.mode, res, (data) => (data as { logs: string[] }).logs.join('\n'))
        break
      }
      default:
        exitWithError(`Unknown agents subcommand: ${subcommand}`, globals.mode)
    }
  } finally {
    await closeMmsContext(ctx)
  }
}

async function resolveThreadId(
  client: { request<T>(method: string, params?: unknown): Promise<T> },
  requestedThreadId?: string
): Promise<string> {
  if (requestedThreadId) return requestedThreadId
  const res = await client.request<{ threads: { id: string; settledAt?: string }[] }>('threads.list')
  const threadId = res.threads.find((thread) => !thread.settledAt)?.id
  if (!threadId) throw new Error('No open thread. Start or select a chat session first.')
  return threadId
}
