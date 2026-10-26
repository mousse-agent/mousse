import type { RunEngine } from '../../RunEngine'
import { appletTools } from './applets'
import { browserTools } from './browser'
import { delegationTools } from './delegation'
import { devGuiTools } from './devGui'
import type { AppToolHost } from './host'
import { planTools } from './plans'
import { quickActionTools } from './quickActions'
import { ToolRegistry, type ToolRegistryOptions } from './registry'
import { skillTools } from './skills'
import { taskTools } from './tasks'
import { threadTools } from './thread'
import type { AppToolTurns } from './turns'
import { webTools } from './web'

export * from './types'
export * from './registry'
export * from './turns'
export type { AppToolHost } from './host'
export {
  delegationToolDefinitions,
  dispatchDelegationTool,
  DELEGATION_TOOL_NAMES,
  LISTED_DELEGATION_TOOL_NAMES,
  type DelegateTaskInput,
  type DelegationToolCall,
  type DelegationToolHost,
  type NamedAgentRecallRequest,
  type NamedAgentToolRequest,
  type SubagentRef
} from './delegation'

/** The tool families in the order the pi loop has always sent them, after the delegation tools. */
export const APP_TOOL_FAMILIES = ['skills', 'plans', 'tasks', 'quickActions', 'devGui', 'web', 'browser', 'applets', 'delegation', 'thread'] as const
export type AppToolFamily = (typeof APP_TOOL_FAMILIES)[number]

/**
 * One registry over every app-tool module (PR 2 §2). The Mousse MCP server's is built over the
 * thread owner with the run engine (which adds the thread tools); an in-process loop builds its
 * own over its dependencies. Both register the same definitions and handlers.
 */
export function createAppToolRegistry(input: {
  host: AppToolHost
  engine?: RunEngine
  turns?: AppToolTurns
  options?: Partial<ToolRegistryOptions>
}): { registry: ToolRegistry; families: Record<AppToolFamily, string[]> } {
  const { host, engine } = input
  const registry = new ToolRegistry({
    activeRunId: (threadId) => (engine ? engine.getActiveRun(threadId)?.runId ?? null : null),
    awaitLiveRun: host.awaitLiveRun ? (threadId) => host.awaitLiveRun!(threadId) : undefined,
    toolLedger: host.toolLedger ? (runId) => host.toolLedger!(runId) : undefined,
    readOnlyThread: host.readOnlyThread ? (threadId) => host.readOnlyThread!(threadId) : undefined,
    threadCeiling: host.threadCeiling ? (threadId) => host.threadCeiling!(threadId) : undefined,
    turns: input.turns,
    ...input.options
  })
  const families = {} as Record<AppToolFamily, string[]>
  const add = (family: AppToolFamily, tools: ReturnType<typeof planTools>): void => {
    families[family] = tools.map((tool) => tool.name)
    for (const tool of tools) registry.register(tool)
  }
  add('delegation', delegationTools(host))
  add('plans', planTools(host))
  add('tasks', taskTools(host))
  add('thread', engine ? threadTools(host, engine) : [])
  add('skills', skillTools(host))
  add('quickActions', quickActionTools(host))
  add('devGui', devGuiTools(host))
  add('web', webTools(host))
  add('browser', browserTools(host))
  add('applets', appletTools())
  return { registry, families }
}
