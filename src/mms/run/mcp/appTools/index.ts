import type { RunEngine } from '../../RunEngine'
import { appearanceTools } from './appearance'
import { appletTools } from './applets'
import { askUserTools } from './askUser'
import { botMemoryTools, type BotMemoryToolHost } from './botMemory'
import { botItemTools } from './botItems'
import { botCatalogueTools } from './botCatalogue'
import { botTools, type BotAppToolDeps } from './bots'
import { browserTools } from './browser'
import { computerTools } from './computer'
import { bugReportTools } from './bugReports'
import { delegationTools } from './delegation'
import { familyRelation, threadFamily } from './family'
import { goalTools } from './goal'
import { devGuiTools } from './devGui'
import type { AppToolHost } from './host'
import { monitorTools } from './monitors'
import { profilerTools } from './profiler'
import { projectGitTools } from './projectGit'
import { quickActionTools, runningTools } from './quickActions'
import { REQUEST_ANSWER_KINDS, requestAnswerTool } from './requestAnswer'
import { ToolRegistry, type ToolAccessPolicy, type ToolRegistryOptions } from './registry'
import { scheduleTools } from './schedules'
import { secretTools } from './secrets'
import { automationTools } from './automations'
import { skillTools } from './skills'
import { taskTools } from './tasks'
import { terminalTools } from './terminals'
import { botThreadReach, lineageRelation, threadTools } from './thread'
import { shareWakeTools, threadWakeTools } from './threadWakes'
import type { AppToolTurns } from './turns'
import { webTools } from './web'

/** The models a turn may name, a bot's or a thread's (`shareWakeTools`). */
const MODEL_LIST_TOOL = 'model_list'
/** Asking the person and taking a question back, a bot's (its owner) or a thread's (the user) (`shareWakeTools`). */
const QUESTION_TOOLS: readonly string[] = ['question_ask', 'question_withdraw']
/** The tools that answer each kind of request: `request_answer`'s variants, never listed or called by their own names. */
const ANSWER_TOOLS: readonly string[] = Object.values(REQUEST_ANSWER_KINDS).map((kind) => kind.tool)

export * from './types'
export * from './refusal'
export * from './registry'
export { compileTool, heldBeforeArguments, holdsPerson, parentHolds, plannedFromAbove, toolNeeds, unattendedRefusal, type CompiledTool, type RunProvenance, type ToolEffect, type ToolNeeds } from './authority'
export * from './turns'
export type { AgentAccessResult, AgentActionDetails, AgentApprovalResult, AgentArchiveResult, AgentArchiveOwnResult, AgentCreatedThread, AgentRemoteThreadRequest, AgentRemoteThreadResult, RemoteProjectCandidate, AgentQueueCommand, AgentQueueResult, AgentScheduleHost, AgentRunCommandResult, AgentSendResult, AgentThreadRequest, ApprovalRequestInfo, AppToolHost, QueueSnapshot, RemoteThreadsHost, ThreadSearchHit } from './host'
export { AGENT_MESSAGE_END, AGENT_MESSAGE_PREFIX, agentMessage, agentMessageText, cleanRemoteSenderTitle, BOT_MESSAGE_END, BOT_MESSAGE_PREFIX, botMessage, botMessageText, isPersonMessage, personTurnRequest } from './agentMessage'
export type { BotAppToolDeps } from './bots'
export { AUTOMATION_TOOL_NAMES, type AutomationToolHost } from './automations'
export { THEME_READ_TOOL, THEME_SET_TOOL, type AppearanceToolHost } from './appearance'
export type { BotMemoryToolHost } from './botMemory'
export { TERMINAL_READ_TOOL } from './terminals'
export { MONITOR_PERMISSION_KEY, MONITOR_TOOL_NAMES } from './monitors'
export { projectGitToolDefinitions, runProjectGitTool } from './projectGit'
export type { ProfilerToolHost } from './profiler'
export type { ComputerUseToolHost } from './computer'
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

/** The tool families in the order runtimes are sent them, after the delegation tools. */
export const APP_TOOL_FAMILIES = ['skills', 'questions', 'tasks', 'quickActions', 'devGui', 'web', 'browser', 'computer', 'applets', 'delegation', 'thread', 'schedules', 'bots', 'projectGit', 'profiler', 'appearance', 'terminals'] as const
export type AppToolFamily = (typeof APP_TOOL_FAMILIES)[number]

/** What the central check of `readsOthers` and `managesOthers` tools reads (SPEC §15.1), all of it at call time. */
function agentAccessPolicy(host: AppToolHost, engine: RunEngine): ToolAccessPolicy {
  return {
    threadExists: (threadId) => host.threadMeta?.(threadId) !== undefined,
    localOnly: (threadId) => host.threadMeta?.(threadId)?.localOnly === true,
    relation: (caller, threadId) => {
      if (host.threadMeta?.(threadId)?.createdByThreadId === caller.threadId) return 'launched'
      const lineage = lineageRelation(engine, caller.threadId, threadId)
      return lineage === 'descendant' ? 'descendant' : lineage ? 'ancestor_or_sibling' : null
    },
    family: (caller, threadId) => familyRelation(threadFamily(host, engine), caller.threadId, threadId),
    // A personal bot: its own rule for threads; it reaches every project.
    botReach: (caller, target, options) => {
      // The bot's own running work, its child in the thread tree: a Stop or a message goes to the bots through the port.
      if (options?.botWork && target.threadId && engine.runningBotWork(target.threadId)?.parentThreadId === caller.threadId) return { scope: 'manage' }
      if (target.threadId !== undefined) return botThreadReach(host, engine, caller.threadId, target.threadId, options)
      return { scope: 'manage' }
    }
  }
}

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
  /** The personal bots' engine side, read at call time (Bot Phase 1 §5.5, §5.6); absent: their own tools refuse. */
  bots?: () => BotAppToolDeps | undefined
  /** The bots' memory tools (WP6), read at call time (the memory store opens with `bots.db`, later); absent: not registered. */
  botMemory?: BotMemoryToolHost | (() => BotMemoryToolHost | undefined)
}): { registry: ToolRegistry; families: Record<AppToolFamily, string[]> } {
  const { host, engine } = input
  const botMemory = typeof input.botMemory === 'function' ? input.botMemory : () => input.botMemory as BotMemoryToolHost | undefined
  const registry = new ToolRegistry({
    activeRunId: (threadId) => (engine ? engine.getActiveRun(threadId)?.runId ?? null : null),
    awaitLiveRun: host.awaitLiveRun ? (threadId) => host.awaitLiveRun!(threadId) : undefined,
    toolLedger: host.toolLedger ? (runId) => host.toolLedger!(runId) : undefined,
    readOnlyThread: host.readOnlyThread ? (threadId) => host.readOnlyThread!(threadId) : undefined,
    threadCeiling: host.threadCeiling ? (threadId) => host.threadCeiling!(threadId) : undefined,
    liveCeiling: host.liveCeiling ? (threadId) => host.liveCeiling!(threadId) : undefined,
    subagentThread: host.subagentThread ? (threadId) => host.subagentThread!(threadId) : undefined,
    personHeld: host.personHeld ? (caller) => host.personHeld!(caller) : undefined,
    parentThread: host.parentThread ? (threadId) => host.parentThread!(threadId) : undefined,
    reportLacks: host.reportLacks ? (report) => host.reportLacks!(report) : undefined,
    botRole: host.botRole ? (threadId) => host.botRole!(threadId) : undefined,
    permissionModeFor: host.permissionModeFor ? (runId) => host.permissionModeFor!(runId) : undefined,
    askApproval: host.askApproval ? (threadId, questions, options) => host.askApproval!(threadId, questions, options) : undefined,
    turns: input.turns,
    access: engine ? agentAccessPolicy(host, engine) : undefined,
    botTimeZone: () => botMemory()?.memory?.zone(),
    ...input.options
  })
  const families = {} as Record<AppToolFamily, string[]>
  const add = (family: AppToolFamily, tools: ReturnType<typeof askUserTools>): void => {
    families[family] = tools.map((tool) => tool.name)
    for (const tool of tools) registry.register(tool)
  }
  // `model_list` serves a bot's turn (the models its work runs on) and any thread's (the picker's), one tool by one name.
  const allBots = botTools(input.bots)
  const allDelegation = delegationTools(host)
  const allThreads = engine ? threadTools(host, engine, input.bots) : []
  // `request_answer` answers a subagent's request, another thread's approval or, for a bot, its owner's answer to its
  // work, each by the tool that answered it before.
  const answers = requestAnswerTool({
    subagent: allDelegation.find((tool) => tool.name === REQUEST_ANSWER_KINDS.subagent.tool),
    approval: allThreads.find((tool) => tool.name === REQUEST_ANSWER_KINDS.approval.tool),
    relay: allBots.find((tool) => tool.name === REQUEST_ANSWER_KINDS.relay.tool)
  }, {
    request: (requestId) => host.approvalRequest?.(requestId),
    parentThread: (threadId) => host.parentThread?.(threadId),
    answered: (threadId, keys) => host.answeredRequest?.(threadId, keys),
    botQuestion: (threadId, requestId) => {
      const deps = input.bots?.()
      const activation = deps?.host.activationOf(threadId)
      return Boolean(activation && deps?.host.questions?.asked?.(activation.botId, requestId))
    }
  })
  const [bots, delegation, threads] = [allBots, allDelegation, allThreads].map((tools) => tools.filter((tool) => !ANSWER_TOOLS.includes(tool.name)))
  const models = shareWakeTools(bots.filter((tool) => tool.name === MODEL_LIST_TOOL), delegation.filter((tool) => tool.name === MODEL_LIST_TOOL))
  add('delegation', delegation.flatMap((tool) => (tool.name === MODEL_LIST_TOOL ? models : [tool])))
  add('questions', [...shareWakeTools(bots.filter((tool) => QUESTION_TOOLS.includes(tool.name)), askUserTools(host)), answers, ...secretTools(host), ...bugReportTools(host)])
  add('tasks', [...taskTools(host), ...goalTools(host)])
  add('thread', threads)
  add('schedules', [...(engine ? scheduleTools(host, engine) : []), ...automationTools(host)])
  add('skills', skillTools(host))
  add('quickActions', [...quickActionTools(host), ...runningTools(host), ...monitorTools(host)])
  add('devGui', devGuiTools(host))
  add('web', webTools(host))
  add('browser', browserTools(host))
  add('computer', computerTools(host))
  add('applets', appletTools())
  // `wake`, `reminder_list` and `reminder_cancel` serve a bot's turn and any thread's (`shareWakeTools`).
  add('bots', [...shareWakeTools(bots.filter((tool) => tool.name !== MODEL_LIST_TOOL && !QUESTION_TOOLS.includes(tool.name)), threadWakeTools(host)), ...botCatalogueTools(() => registry), ...(input.botMemory ? [...botMemoryTools(input.botMemory), ...botItemTools(input.botMemory)] : [])])
  add('projectGit', projectGitTools(host))
  add('profiler', profilerTools(host, engine))
  add('appearance', appearanceTools(host))
  add('terminals', terminalTools(host))
  return { registry, families }
}
