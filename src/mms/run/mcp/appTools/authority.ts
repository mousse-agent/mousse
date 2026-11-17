import { APPROVALS_REFUSED_MESSAGE, QUESTIONS_REFUSED_MESSAGE } from '../../../../shared/harness/types'
import { permissionModeAllows, type PermissionMode } from '../../../../shared/permissionMode'
import { botAppToolRefusal, botBrowserNotAllowed, botBrowserWithheld, botTurnOffers } from '../../../../shared/bots/personal/walls'
import { botMayBeOffered, isBotThreadTool, isBotTurnHeldTool } from '../../../../shared/bots/personal/manifest'
import { botCoreTool } from '../../../../shared/bots/personal/catalogue'
import type { McpToolDescriptor } from '../../../../shared/integrations'
import { startedByPerson } from '../../approvalRights'
import type { ModeCeiling } from '../../types'
import { refused } from './refusal'
import { callerThreadOnly } from './thread'
import { McpToolError, type AppToolTurn, type McpCaller, type MousseTool, type ThreadRelation, type ToolAccess, type ToolListing, type ToolOutcome, type ToolScope } from './types'

/**
 * The authority compiler (docs/plans/tool-api.md §1.3, PR 2a): the one place that decides what a thread lists and what
 * a run holds of each Mousse tool. The thread's list (`tools/list`), Pi's per-turn list, the turn preamble's "usable
 * now" line and every call's dispatch read what it compiles, from five inputs:
 * 1. provenance: who started the run (`holdsPerson`, from the run's source and its binding's origin); unknown
 *    provenance grants no person authority;
 * 2. lineage: whether the thread is a read-only child, and its role when it is a personal bot's. The tool modules'
 *    own exclusions for subagents and discovery turns (`AppToolTurn.subagent`, `discovery`) are not lineage yet:
 *    every turn the orchestrator registers passes false for both, so they hold for no turn (§6, finding 8);
 * 3. the stored ceiling the thread's delegations gave it (`ToolRegistryOptions.threadCeiling`);
 * 4. narrowing: the ceiling of the turn's credential and the turn's mode;
 * 5. the run's request policy (`approvals`, its permission mode) and its request channel (a bot's grant or owner).
 *
 * Each tool's declaration is read here and nowhere else (`toolNeeds`). What a call holds is `held`, `ask_first` (it
 * asks the person before it runs) or `lacks` (refused). This PR keeps every answer as it was (the parity table in
 * tests/run/toolAuthorityParity.test.ts); where the list, the "usable now" line and dispatch still answer differently,
 * that difference is written down here, in one place.
 */

/**
 * The tools that change nothing: they read, list, search or wait. Every other tool declares `clientRequestId`
 * (docs/plans/tool-api.md §1.2 "Retry"), and its effect is never `none`.
 */
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'task_status', 'list_subagents', 'list_computers', 'list_models', 'list_tasks',
  'thread_read', 'thread_list', 'thread_search', 'thread_wait', 'queue_list', 'schedule_list', 'terminal_read',
  'automation_list', 'list_skills', 'load_skill', 'tool_catalogue', 'mcp_servers', 'theme_read',
  'web_search', 'web_fetch', 'browser_observe', 'browser_find', 'browser_wait', 'browser_extract', 'browser_screenshot',
  'mousse_gui_screenshot', 'mousse_gui_console', 'mousse_gui_status',
  'bot_list', 'bot_schedule_list', 'work_models', 'work_list', 'watch_list', 'reminder_list', 'subagent_wait', 'subagent_result',
  'memory_search', 'memory_read', 'memory_list',
  'profiler_overview', 'profiler_service_breakdown', 'profiler_window_breakdown', 'profiler_gpu_hints', 'profiler_children',
  'profiler_sample_now', 'profiler_watch', 'profiler_heap_summary'
])

/**
 * What a call changes (§6, finding 6: `class: 'read'` covered both reads and writes to the caller's own state):
 * - `none`: nothing (`READ_ONLY_TOOL_NAMES`);
 * - `own`: only the caller's own conversation and state (a question, its task list, its memory);
 * - `changes`: state other runs see;
 * - `delegates`: starts or steers a child.
 */
export type ToolEffect = 'none' | 'own' | 'changes' | 'delegates'

/** What a tool's declaration says about who may call it, as the compiler reads it. */
export interface ToolNeeds {
  access: ToolAccess
  effect: ToolEffect
  /** A read-only (`shared`) child may call it: it reads, or changes nothing but the caller's own conversation. */
  readOnlyChild: boolean
  /** Callable over MCP (§6, finding 7: `hidden` meant both unlisted and uncallable; `listed` now says the first). */
  callable: boolean
  /** A plan ceiling refuses it, and why. */
  planRefuses?: 'starts threads' | 'changes settings'
  /** What a call waits for: the person's approval or their answer to a question. */
  waitsFor?: 'approval' | 'question'
  /** Who answers it on a personal bot's turn: its grant, or its owner in the bot's own chat. */
  botAnswers?: 'grant' | 'owner'
  /** It asks the person first unless the run's permission mode allows what this variant of the call needs. */
  asksFirst?(args: Record<string, unknown>): 'edit' | 'full'
  /** A `managesOthers` tool that keeps the `launched` scope for a thread the caller launched. */
  launchedScope: boolean
}

/** A tool's needs, read from its declaration: the only reader of its access flags. */
export function toolNeeds(tool: MousseTool): ToolNeeds {
  const reads = tool.access === 'reads' || tool.access === 'readsOthers'
  const edits = tool.access === 'editsWorkspace' || tool.access === 'changesSettings'
  return {
    access: tool.access,
    effect: tool.class === 'delegation' ? 'delegates' : tool.class === 'mutation' ? 'changes' : READ_ONLY_TOOL_NAMES.has(tool.name) ? 'none' : 'own',
    readOnlyChild: reads || tool.readOnlySafe === true,
    callable: tool.callable !== 'in_process',
    ...(tool.access === 'startsThreads' ? { planRefuses: 'starts threads' as const } : tool.access === 'changesSettings' ? { planRefuses: 'changes settings' as const } : {}),
    ...(tool.asksUser ? { waitsFor: tool.asksUser } : {}),
    ...(tool.botGrantAnswers ? { botAnswers: 'grant' as const } : tool.botAsksOwner ? { botAnswers: 'owner' as const } : {}),
    ...(edits ? { asksFirst: (args: Record<string, unknown>) => tool.runsWithoutAsking?.(args) ?? 'edit' } : {}),
    launchedScope: tool.launchedOk === true
  }
}

/**
 * What the target checks read of the thread owner (SPEC §15.1), at call time: the targets a call's arguments name,
 * resolved.
 */
export interface ToolAccessPolicy {
  /** How `threadId` is related to the caller, or null. */
  relation(caller: McpCaller, threadId: string): ThreadRelation | null
  threadExists(threadId: string): boolean
  /** The thread is private (`Thread.localOnly`); absent: no thread is. */
  localOnly?(threadId: string): boolean
  /**
   * Where a personal bot's thread tool ("use your threads") may reach: the scope for a thread (`botThreadReach`, the
   * rule its list and search follow too) or a project, or the refusal's words. Absent: a bot reaches nothing.
   */
  botReach?(caller: McpCaller, target: { threadId?: string; projectId?: string }, options?: { read?: boolean }): { scope: ToolScope } | { refused: string }
}

/**
 * Why a run that nobody answers (`approvals: 'never'`) refuses a tool that waits for the person; undefined when it may
 * run. A personal bot's turn (always `never`) may still call a tool its grant answers, or one whose ask reaches its
 * owner in the bot's own chat: that is its request channel.
 */
export function unattendedRefusal(needs: Pick<ToolNeeds, 'waitsFor' | 'botAnswers'>, turn: Pick<AppToolTurn, 'approvals'> & { bot?: unknown }): string | undefined {
  if (turn.approvals !== 'never' || !needs.waitsFor) return undefined
  if (turn.bot && needs.botAnswers) return undefined
  return needs.waitsFor === 'question' ? QUESTIONS_REFUSED_MESSAGE : APPROVALS_REFUSED_MESSAGE
}

/**
 * Whether a thread lists the tool (`tools/list`): the thread-stable list a native MCP client caches, from its lineage
 * and stored ceiling, never the current turn's mode (a Plan turn's narrower ceiling is enforced at call time).
 */
export function listsTool(tool: MousseTool, listing: ToolListing): boolean {
  const needs = toolNeeds(tool)
  if (listing.readOnly && !needs.readOnlyChild) return false
  if (listing.modeCeiling === 'plan' && needs.planRefuses) return false
  // A bot's main thread lists the thread tools its grant allows: "use your threads" is what lets it use them. Only
  // those its turn holds now are listed (none without the permission, with the switch off, or in a turn that only
  // reads), and every call is held to it again. A consult never has them. The profiler's tools likewise follow "use
  // the profiler": listed only when the turn holds them (and, as for anyone, while Labs lets agents read it). So do
  // the theme tools, under "change how Mousse looks", scheduled jobs, secrets, quick actions and the task list. A
  // subagent holds only what a thread's subagent may use (`compileBotThread`), and a consult none of them.
  const botHeldTool = listing.botRole !== undefined && isBotTurnHeldTool(tool.name)
  if (botHeldTool && (listing.botRole === 'context' || !listing.botTurnTools?.has(tool.name))) return false
  // A bot's thread lists only what a bot can hold: the model is never shown delegation, queues or tools it can't use.
  if (listing.botRole && !botMayBeOffered(tool.name)) return false
  // A catalogue turn on Codex or Pi (docs/plans/bot-context.md §15) lists the core set only: the rest is looked up with
  // `tool_catalogue` and called through `use_tool`, so the list never changes with what the bot looks up.
  if (listing.botCatalogue === 'use_tool' && !botCoreTool(tool.name)) return false
  return tool.listed?.(listing) ?? true
}

/** The inputs of one call's or one turn's authority (see the file comment). */
export interface AuthorityInputs {
  turn: AppToolTurn
  /** 2. Lineage: the thread is a read-only (`shared`) delegated child. */
  readOnly: boolean
  /** 4. Narrowing: the ceiling the call's credential carries (the turn's own when there is no call). */
  ceiling: ModeCeiling
  /** 5. The permission mode the run enforces, read only when a call would ask; unknown is Ask (it fails closed). */
  permissionMode(): PermissionMode | undefined
}

/** What a call that asks first asks for: the mode that would let it run unasked, and whether nobody can answer. */
export interface AskFirst {
  needs: 'edit' | 'full'
  /** The run nobody answers (`approvals: 'never'`): refused at once instead of asking. */
  unattended: boolean
}

/** One tool's authority in one turn: what each step of its dispatch checks, in the order dispatch checks it. */
export interface CompiledTool {
  tool: MousseTool
  needs: ToolNeeds
  /**
   * A personal bot's thread tool ("use your threads"): its grant is checked first, against the call's arguments, and
   * where it reaches is decided by the bot's rules, not the central check.
   */
  botThreads: boolean
  /**
   * The targets the call's arguments name, before anything asks (§1.2 `authorize`): a read-only child, the plan
   * ceiling, the caller's own thread for a tool that writes it, and how the caller reaches another thread. Returns the
   * scope, or throws the refusal.
   */
  authorize(actor: McpCaller, args: Record<string, unknown>, targets: ToolAccessPolicy | undefined): ToolScope | undefined
  /** What the turn lacks for it whatever the arguments, after the targets: an error result, or undefined. */
  lacks(): ToolOutcome | undefined
  /**
   * A personal bot's grant's refusal of this variant of the call, or undefined (and always for a turn that is not a
   * bot's). Nobody is asked: a list cached before a narrower revision cannot reach a removed tool. Dispatch checks it
   * first for the bot's thread tools and after `lacks` for the others.
   */
  grantRefusal(args: Record<string, unknown>): ToolOutcome | undefined
  /** Whether a definition run's grants, policy and approvals decide the call. */
  definition: boolean
  /** The ask before it runs (`ask_first`), or undefined when it is held without asking. */
  askFirst(args: Record<string, unknown>): AskFirst | undefined
}

/** Compiles one tool's authority in a turn. Each check runs only when dispatch reaches it, as before. */
export function compileTool(tool: MousseTool, inputs: AuthorityInputs): CompiledTool {
  const { turn } = inputs
  const needs = toolNeeds(tool)
  const botThreads = turn.bot !== undefined && isBotThreadTool(tool.name)
  let lacks: { outcome: ToolOutcome | undefined } | undefined
  return {
    tool,
    needs,
    botThreads,
    authorize: (actor, args, targets) => {
      const scope = botThreads ? botThreadScope(tool, needs, args, actor, targets) : centralScope(tool, needs, args, actor, inputs, targets)
      return tool.authorize?.(actor, args, targets) ?? scope
    },
    lacks: () => (lacks ??= { outcome: turnLacks(tool, needs, turn) }).outcome,
    grantRefusal: (args) => {
      if (!turn.bot) return undefined
      const refusal = botAppToolRefusal(turn.bot, tool.name, args)
      return refusal ? refused('not_granted', refusal) : undefined
    },
    definition: turn.definition !== undefined,
    askFirst: (args) => {
      // A definition run is held to its own grants; a bot's call of a tool its grant answers asks nobody: the grant is its
      // owner's answer.
      if (!needs.asksFirst || turn.definition || (turn.bot && needs.botAnswers === 'grant')) return undefined
      const mode = inputs.permissionMode() ?? 'ask'
      const asks = needs.asksFirst(args)
      if (asks === 'full' ? mode === 'full' : permissionModeAllows(mode, 'edit')) return undefined
      return { needs: asks, unattended: turn.approvals === 'never' }
    }
  }
}

/** What the turn lacks for a tool whatever the call's arguments: the bot's browser, availability, the request policy. */
function turnLacks(tool: MousseTool, needs: ToolNeeds, turn: AppToolTurn): ToolOutcome | undefined {
  // A bot's thread lists the browser tools whatever it holds: one its owner has not allowed says so, and how to ask,
  // not that no browser is bound to the turn. One the owner allowed after the turn started is answered as held: the
  // bot is not sent to ask again, and its turn continues with the browser once it ends.
  if (turn.bot && botBrowserWithheld(turn.bot, tool.name)) return refused('not_granted', turn.bot.held?.({ tool: tool.name }) ?? botBrowserNotAllowed(turn.bot))
  const availability = tool.available?.(turn) ?? true
  if (availability !== true) return refused('unavailable', availability)
  const unattended = unattendedRefusal(needs, turn)
  return unattended ? refused('needs_person', unattended) : undefined
}

/** Read-only children, the caller's own thread, the plan ceiling, then how the caller reaches another thread. */
function centralScope(tool: MousseTool, needs: ToolNeeds, args: Record<string, unknown>, caller: McpCaller, inputs: AuthorityInputs, targets: ToolAccessPolicy | undefined): ToolScope | undefined {
  if (!needs.readOnlyChild && inputs.readOnly)
    throw new McpToolError('mousse_read_only', `${tool.name} can change threads or the workspace; a read-only subagent cannot call it.`)
  // Scope before any approval: a call refused for naming another thread must not prompt the user first.
  if (needs.access === 'writesThreads' || needs.access === 'editsWorkspace') callerThreadOnly(args, caller)
  if (needs.planRefuses && inputs.ceiling === 'plan')
    throw new McpToolError('mousse_ceiling_exceeded', `${tool.name} ${needs.planRefuses}; a plan ceiling cannot.`)
  return needs.access === 'readsOthers' || needs.access === 'managesOthers' ? othersScope(tool, needs, args, caller, targets) : undefined
}

/**
 * The central check of `readsOthers` and `managesOthers` tools (SPEC §15.1): how the caller reaches the target, or
 * `mousse_scope_denied`. Every agent may read and manage every thread; what stays out of reach is a thread that does
 * not exist and, across the private line, a private thread. A thread the caller may not reach is refused the same way
 * whether it exists or not.
 */
function othersScope(tool: MousseTool, needs: ToolNeeds, args: Record<string, unknown>, caller: McpCaller, policy: ToolAccessPolicy | undefined): ToolScope {
  const target = tool.target ? tool.target(args, caller) : { threadId: args.threadId as string | undefined }
  if (!target) return 'own'
  if (target.threadId !== undefined && (typeof target.threadId !== 'string' || !target.threadId))
    throw new McpToolError('mousse_scope_denied', 'threadId must be a non-empty string.')
  if (target.threadId === undefined && !tool.target) return 'own'
  if (target.threadId === caller.threadId) return 'own'
  const manages = needs.access === 'managesOthers'
  // A private thread's content stays out of shared threads (their content reaches the user's other devices):
  // a shared thread's agent never sees a private thread, and a private thread's agent never sends to or changes a shared one.
  if (target.threadId !== undefined && policy?.localOnly) {
    const callerPrivate = policy.localOnly(caller.threadId)
    const targetPrivate = policy.localOnly(target.threadId)
    if (targetPrivate && !callerPrivate)
      throw new McpToolError('mousse_scope_denied', `Thread ${target.threadId} is not available to this credential.`)
    if (callerPrivate && !targetPrivate && manages)
      throw new McpToolError('mousse_scope_denied', 'This is a private thread: its agents cannot send to or change a thread that is shared with the user\'s other devices.')
  }
  if (target.threadId === undefined) {
    // A listing; the handler filters what it returns.
    if (!policy) throw new McpToolError('mousse_scope_denied', `${tool.name} is not available here.`)
    return 'manage'
  }
  let relation: ThreadRelation | null = null
  try {
    relation = policy?.relation(caller, target.threadId) ?? null
  } catch {
    relation = null
  }
  // A thread the caller launched keeps that scope for the tools that treat it apart.
  if (manages && relation === 'launched' && needs.launchedScope) return 'launched'
  let exists = false
  try {
    exists = Boolean(policy?.threadExists(target.threadId))
  } catch {
    exists = false
  }
  if (exists) return 'manage'
  if (!manages && relation) return relation
  throw new McpToolError('mousse_scope_denied', `Thread ${target.threadId} is not available to this credential.`)
}

/**
 * Where a bot's thread tool may reach (`"use your threads"`, already held by the turn), by the one rule its list,
 * search and handlers follow too (`ToolAccessPolicy.botReach`, `botThreadReach`): the owner's ordinary threads of its
 * projects, and the threads it started. Never its own chat or any bot's thread, the Automation manager's, a private
 * thread or a subagent; a thread that does not exist is refused in the same words. Its scope is `manage` (the bot reads
 * transcripts, bounded by the handler) or `launched` for one it started that is out of its projects.
 */
function botThreadScope(tool: MousseTool, needs: ToolNeeds, args: Record<string, unknown>, caller: McpCaller, policy: ToolAccessPolicy | undefined): ToolScope {
  const target = tool.target ? tool.target(args, caller) : { threadId: args.threadId as string | undefined }
  if (!policy?.botReach) throw new McpToolError('mousse_scope_denied', `${tool.name} is not available here.`)
  if (!target || (target.threadId === undefined && target.projectId === undefined)) return 'manage'
  if (target.threadId !== undefined && (typeof target.threadId !== 'string' || !target.threadId))
    throw new McpToolError('mousse_scope_denied', 'threadId must be a non-empty string.')
  let reach: { scope: ToolScope } | { refused: string }
  try {
    // A tool that changes nothing outside the caller's own state reaches the subagents below the owner's threads too (#1365).
    reach = policy.botReach(caller, target, { read: needs.effect === 'none' || needs.effect === 'own' })
  } catch {
    reach = { refused: target.threadId ? `Thread ${target.threadId} is not available to you.` : `${tool.name} is not available for this project.` }
  }
  if ('refused' in reach) throw new McpToolError('mousse_scope_denied', reach.refused)
  return reach.scope
}

/**
 * Whether a turn's preamble names the tool as usable now: one the thread lists that the turn holds before any
 * argument. It reads the turn's own ceiling and, for a bot, whether its grant offers the tool at all; a call is
 * checked again in full when it is made (a read-only child's and a plan ceiling's refusals are already left out of
 * the thread's list, and a tool that asks first is usable).
 */
export function usableNow(tool: MousseTool, turn: AppToolTurn): boolean {
  const needs = toolNeeds(tool)
  // A Plan turn cannot start threads; everything else listed is usable when available now (a tool that changes
  // settings says it is unavailable under Plan itself).
  if (turn.modeCeiling === 'plan' && needs.planRefuses === 'starts threads') return false
  if ((tool.available?.(turn) ?? true) !== true) return false
  // A bot turn may use only its granted app tools; every other one is refused if called.
  if (!botTurnOffers(turn.bot, tool.name)) return false
  // A run nobody answers does not offer the tools that wait for the person (they are refused if called).
  if (unattendedRefusal(needs, turn)) return false
  // A screenshot is refused when it cannot reach the model; the preamble does not offer it.
  return !(tool.name === 'browser_screenshot' && turn.browser && !turn.browser.vision)
}

/**
 * Whether a runtime that is sent the turn's own tools (an in-process loop, a definition's turn on Pi) is sent the tool:
 * `offered` where the tool says (a browser tool outside the binding, a screenshot a model without vision cannot see),
 * else whether it is available now; never one the run's request policy refuses.
 */
export function offeredThisTurn(tool: MousseTool, turn: AppToolTurn, options: { requestPolicy: boolean }): boolean {
  if ((tool.offered ? tool.offered(turn) : tool.available?.(turn) ?? true) !== true) return false
  return !options.requestPolicy || !unattendedRefusal(toolNeeds(tool), turn)
}

/**
 * Where the user's own MCP tools a turn is offered (`userMcp: 'proxy'` runtimes) come from: a bot's granted ones (none
 * without the bot's MCP dispatcher), a definition's granted ones, none for the main agent in a build mode (its tools are
 * the mode's), else the turn's actor's enabled tools. A read-only child keeps only those its workspace capability allows.
 */
export function userMcpSource(turn: AppToolTurn, botMcp: boolean): 'bot' | 'definition' | 'actor' | 'none' {
  if (turn.bot) return botMcp ? 'bot' : 'none'
  if (turn.definition) return 'definition'
  if (turn.modeFacts.build && !turn.subagent) return 'none'
  return 'actor'
}

/** The user MCP tools of `userMcpSource` a read-only child may still be offered. */
export function userMcpForReader(tools: readonly McpToolDescriptor[], turn: AppToolTurn, readOnly: boolean): McpToolDescriptor[] {
  return tools.filter((tool) => !readOnly || turn.toolAccess?.allows(tool.providerName) === true)
}

/**
 * Who started the run (§1.3 "Provenance"): its origin and source, as `startedByPerson` reads them. Absent: unknown,
 * which grants no person authority.
 */
export interface RunProvenance {
  origin: string
  source: string | null | undefined
}

/** Whether the run holds `person`: only a run a person started (`gui`, `cli`, `resume_now`) does. */
export function holdsPerson(provenance: RunProvenance | undefined): boolean {
  return provenance !== undefined && startedByPerson(provenance)
}
