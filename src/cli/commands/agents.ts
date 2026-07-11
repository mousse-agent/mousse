import type { Agent, CliType } from '../../shared/types'
import type { ParsedArgs } from '../parseArgs'
import { flagBool, flagString } from '../parseArgs'
import { exitWithError, formatTable, writeOutput } from '../output'
import { openMms } from '../mmsContext'
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

  const { mms } = await openMms(globals)

  try {
    switch (subcommand) {
      case 'list': {
        const agents = mms.agents.list()
        writeOutput(globals.mode, agents, (data) => {
          const rows = data as ReturnType<typeof mms.agents.list>
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
        const logs = await mms.orchestrator.spawnAgents([{ cliType, task: task.trim() }])
        writeOutput(globals.mode, { logs, agents: mms.agents.list() }, (data) => {
          const payload = data as { logs: string[] }
          return payload.logs.join('\n')
        })
        break
      }
      case 'stop': {
        const id = positional[0]
        if (!id) exitWithError('agents stop requires an agent id.', globals.mode)
        const agent = mms.agents.get(id) ?? mms.agents.list().find((a: Agent) => a.id.startsWith(id))
        if (!agent) exitWithError(`Agent not found: ${id}`, globals.mode)
        const merge = flagBool(flags, 'merge')
        const logs = await mms.orchestrator.stopAgent(agent.id, merge)
        writeOutput(globals.mode, { logs }, (data) => {
          const payload = data as { logs: string[] }
          return payload.logs.join('\n')
        })
        break
      }
      default:
        exitWithError(`Unknown agents subcommand: ${subcommand}`, globals.mode)
    }
  } finally {
    await mms.stop()
  }
}
