import { APPROVALS_REFUSED_MESSAGE, QUESTIONS_REFUSED_MESSAGE } from '../../../../shared/harness/types'
import { permissionModeAllows, type PermissionMode } from '../../../../shared/permissionMode'
import { botAppToolRefusal, botBrowserNotAllowed, botBrowserWithheld, botTurnOffers } from '../../../../shared/bots/personal/walls'
import { botMayBeOffered, isBotThreadTool, isBotTurnHeldTool } from '../../../../shared/bots/personal/manifest'
import { botCoreTool } from '../../../../shared/bots/personal/catalogue'
import type { McpToolDescriptor } from '../../../../shared/integrations'
import { startedByPerson } from '../../approvalRights'
import type { ModeCeiling } from '../../types'
import { familyMessageScope } from './family'
import { refused } from './refusal'
import { callerThreadOnly } from './thread'
import { McpToolError, type AppToolTurn, type FamilyRelation, type McpCaller, type MousseTool, type ThreadRelation, type ToolAccess, type ToolListing, type ToolOutcome, type ToolScope } from './types'

/**
 * The authority compiler (docs/plans/tool-api.md §1.3, PR 2a): the one place that decides what a thread lists and what
 * a run holds of each Mousse tool. The thread's list (`tools/list`), Pi's per-turn list, the turn preamble's "usable
 * now" line and every call's dispatch read what it compiles, from five inputs:
 * 1. provenance: who started the run (`holdsPerson`, from the run's source and its binding's origin); unknown
 *    provenance grants no person authority, and a subagent never holds `person` (`MousseTool.needsPerson`);
 * 2. lineage: whether the thread is a read-only child, whether it is a subagent (`AppToolTurn.subagent`, from the
 *    thread's lineage: the owner's own preferences never pass down to one), and its role when it is a personal bot's;
 * 3. the stored ceiling the thread's delegations gave it (`ToolRegistryOptions.threadCeiling`);
 * 4. narrowing: the ceiling of the turn's credential, the turn's mode, and an ancestor's running Plan turn, read again
 *    at every call (`ToolRegistryOptions.liveCeiling`), which also makes the turn's mode facts a Plan turn's
 *    (`plannedFromAbove`); what that takes from a turn that held it is `revoked`;
 * 5. the run's request policy (`approvals`, its permission mode) and its request channel (a bot's grant or owner).
 *
 * Each tool's declaration is read here and nowhere else (`toolNeeds`). What a call holds is `held`, `ask_first` (it
 * asks the person before it runs) or `lacks`: a listed tool the turn does not hold a capability of is refused with
 * `lacks_capability`, naming it; a subagent's first such refusal for each capability is reported up its tree (§2.4,
 * `parentHolds`, `ToolRegistryOptions.reportLacks`). The turn's "usable now" line and dispatch read the same checks
 * (`heldBeforeArguments`); a tool held only for some arguments (a bot grant's variants) is usable, and the call's
 * own arguments decide.
 */

/**
 * The tools that change nothing: they read, list, search or wait. Every other tool declares `clientRequestId`
 * (docs/plans/tool-api.md §1.2 "Retry"), and its effect is never `none`.
 */
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'task_status', 'list_subagents', 'computer_list', 'model_list', 'task_list',
  'thread_read', 'thread_list', 'thread_search', 'thread_wait', 'queue_list', 'schedule_list', 'terminal_read', 'read_applet',
  'automation_list', 'skill_list', 'skill_load', 'tool_catalogue', 'mcp_servers', 'theme_read',
  'git_status', 'git_diff',
  'web_search', 'web_fetch', 'browser_observe', 'browser_find', 'browser_wait', 'browser_extract', 'browser_screenshot',
  'mousse_gui_screenshot', 'mousse_gui_console', 'mousse_gui_status',
  'bot_list', 'bot_schedule_list', 'model_list', 'work_list', 'watch_list', 'reminder_list', 'subagent_wait', 'subagent_result',
  'memory_search', 'memory_read', 'memory_list', 'item_list',
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
  /** It starts an independent thread or a fork (`threads.start`), which a Plan ceiling and a read-only child lack. */
  starts: boolean
  /** The capability a read-only child lacks for it, when it may not call it. */
  readOnlyLacks?: string
  /** It sends messages (`messageIntent`): a read-only child holds it for a note to its family, whatever `readOnlyLacks` says. */
  messages: boolean
  /** The owner's own preference it changes: it never passes down to a subagent (§1.3 "Subagents"). */
  owner?: 'themes' | 'quick_actions'
  /** A plan ceiling refuses it, and why. */
  planRefuses?: 'starts threads' | 'changes settings'
  /** The variants that need `person` (§1.3 "Provenance"); `personAlways`: every call does. */
  person?(args: Record<string, unknown>): boolean
  personAlways: boolean
  /** What a call waits for: the person's approval or their answer to a question. */
  waitsFor?: 'approval' | 'question'
  /** Who answers it on a personal bot's turn: its grant, or its owner in the bot's own chat. */
  botAnswers?: 'grant' | 'owner'
  /** It asks the person first unless the run's permission mode allows what this variant of the call needs. */
  asksFirst?(args: Record<string, unknown>): 'edit' | 'full'
  /** A `managesOthers` tool that keeps the `launched` scope for a thread the caller launched. */
  launchedScope: boolean
  /** The browser right a call needs (§2.6 "Rights"): a Plan ceiling and a read-only child lack `browser.act`. */
  browser?(args: Record<string, unknown>): 'browser.read' | 'browser.act'
}

/** The capability (§1.3) a tool of each access needs that a read-only child does not hold. */
const WRITE_CAPABILITY: Readonly<Record<ToolAccess, string>> = {
  reads: 'read',
  readsOthers: 'threads.read',
  actsAsCaller: 'edit',
  writesThreads: 'threads.write',
  startsThreads: 'threads.start',
  editsWorkspace: 'edit',
  managesOthers: 'threads.manage',
  changesSettings: 'settings'
}

/** What a turn that lacks a capability is told would give it (`fix`). */
const READ_ONLY_FIX = 'This thread is a read-only subagent: its parent can do this, or start a subagent that is not read-only.'
const PLAN_FIX = 'A Plan turn, and a subagent of one, does not hold this; an Agent turn does.'
const OWNER_FIX = 'Only the thread\'s own agent changes the owner\'s preferences: tell your parent what you need.'
const PERSON_FIX = 'Only a turn the person started holds this: the person asks for it in their own turn of a thread that is not a subagent.'

/** A tool's needs, read from its declaration: the only reader of its access flags. */
export function toolNeeds(tool: MousseTool): ToolNeeds {
  const reads = tool.access === 'reads' || tool.access === 'readsOthers'
  const edits = tool.access === 'editsWorkspace' || tool.access === 'changesSettings'
  // `threads.start`: `thread_create` and `thread_fork` alike (§6, finding 9), whatever their `access`.
  const starts = tool.access === 'startsThreads' || tool.capabilities?.includes('threads.start') === true
  const readOnlyChild = reads || tool.readOnlySafe === true
  const owner = tool.capabilities?.find((capability): capability is 'themes' | 'quick_actions' => capability === 'themes' || capability === 'quick_actions')
  return {
    access: tool.access,
    effect: tool.class === 'delegation' ? 'delegates' : tool.class === 'mutation' ? 'changes' : READ_ONLY_TOOL_NAMES.has(tool.name) ? 'none' : 'own',
    readOnlyChild,
    callable: tool.callable !== 'in_process',
    starts,
    ...(readOnlyChild ? {} : { readOnlyLacks: starts ? 'threads.start' : tool.browserRight?.({}) ?? WRITE_CAPABILITY[tool.access] }),
    ...(tool.browserRight ? { browser: tool.browserRight } : {}),
    messages: tool.messageIntent !== undefined,
    ...(owner ? { owner } : {}),
    ...(starts ? { planRefuses: 'starts threads' as const } : tool.access === 'changesSettings' ? { planRefuses: 'changes settings' as const } : {}),
    ...(tool.needsPerson ? { person: tool.needsPerson === true ? () => true : tool.needsPerson } : {}),
    personAlways: tool.needsPerson === true,
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
  /** How `threadId` sits in the caller's family (`familyRelation`), or null; absent: no thread is family. */
  family?(caller: McpCaller, threadId: string): FamilyRelation | null
  threadExists(threadId: string): boolean
  /** The thread is private (`Thread.localOnly`); absent: no thread is. */
  localOnly?(threadId: string): boolean
  /**
   * Where a personal bot's thread tool ("use your threads") may reach: the scope for a thread (`botThreadReach`, the
   * rule its list and search follow too) or a project, or the refusal's words. Absent: a bot reaches nothing.
   * `botWork`: a Stop or a message, which reaches the bot's own running work too (its handler forwards it to the bots).
   */
  botReach?(caller: McpCaller, target: { threadId?: string; projectId?: string }, options?: { read?: boolean; botWork?: boolean }): { scope: ToolScope } | { refused: string }
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
  if (listing.readOnly && !needs.readOnlyChild && !needs.messages) return false
  if (listing.modeCeiling === 'plan' && needs.planRefuses) return false
  // A subagent's thread never holds the owner's own preferences, nor `person`, so it never lists them (a bot's thread
  // is held to its grant instead).
  if (listing.subagent && needs.owner) return false
  if (listing.subagent && needs.personAlways && listing.botRole === undefined) return false
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
  /** 1. Provenance: the turn holds `person` (a person started it and it is not a subagent's); read only when a call needs it. */
  person(): boolean
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
  /** The refusal of a variant that needs `person` in a turn that does not hold it, or undefined. A bot's grant answers instead. */
  personRefusal(args: Record<string, unknown>): ToolOutcome | undefined
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
    personRefusal: (args) => {
      if (turn.bot || !needs.person?.(args) || inputs.person()) return undefined
      return refused('lacks_capability', personLacks(tool.name), { lacks: 'person', fix: PERSON_FIX, data: { reason: 'mousse_scope_denied' } })
    },
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

/**
 * What the turn lacks for a tool whatever the call's arguments: the owner's preferences in a subagent, the bot's
 * browser, availability, the request policy.
 */
function turnLacks(tool: MousseTool, needs: ToolNeeds, turn: AppToolTurn): ToolOutcome | undefined {
  if (turn.subagent && needs.owner)
    return refused('lacks_capability', `${tool.name} changes the owner's own preferences; a subagent does not hold that.`, { lacks: needs.owner, fix: OWNER_FIX })
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
  // A message to the caller's family follows the family rules (a note from anyone in it, work from the direct parent);
  // one outside the family is checked as before.
  const intent = tool.messageIntent?.(args)
  const family = intent ? familyMessageScope(tool, intent, args, caller, targets?.family ? (actor, threadId) => targets.family!(actor, threadId) : undefined) : undefined
  if (family) return family
  if (needs.readOnlyLacks && inputs.readOnly)
    throw new McpToolError('mousse_read_only', `${tool.name} can change threads or the workspace; a read-only subagent cannot call it.`, { lacks: needs.browser?.(args) ?? needs.readOnlyLacks, fix: READ_ONLY_FIX })
  // Scope before any approval: a call refused for naming another thread must not prompt the user first.
  if (needs.access === 'writesThreads' || needs.access === 'editsWorkspace') callerThreadOnly(args, caller)
  if (needs.planRefuses && inputs.ceiling === 'plan')
    throw new McpToolError('mousse_ceiling_exceeded', `${tool.name} ${needs.planRefuses}; a plan ceiling cannot.`, { lacks: needs.starts ? 'threads.start' : 'settings', fix: PLAN_FIX })
  if (needs.browser?.(args) === 'browser.act' && readsPagesOnly(inputs.turn, inputs.ceiling))
    throw new McpToolError('mousse_ceiling_exceeded', `${tool.name} acts in the browser; a Plan turn only reads pages.`, { lacks: 'browser.act', fix: PLAN_FIX })
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
    reach = policy.botReach(caller, target, { read: needs.effect === 'none' || needs.effect === 'own', botWork: tool.name === 'thread_send' || tool.name === 'thread_interrupt' })
  } catch {
    reach = { refused: target.threadId ? `Thread ${target.threadId} is not available to you.` : `${tool.name} is not available for this project.` }
  }
  if ('refused' in reach) throw new McpToolError('mousse_scope_denied', reach.refused)
  return reach.scope
}

/**
 * Whether the turn holds the tool before any argument, as dispatch checks it: not a read-only child's or a Plan
 * ceiling's refusal, nothing the turn lacks (`turnLacks`), and for a bot a grant that allows some variant of it. The
 * turn's "usable now" line is the thread's list less what this refuses; a call is then checked in full, its arguments
 * included (a bot grant's variants, the thread it names), and a tool that asks first is usable.
 */
export function heldBeforeArguments(tool: MousseTool, turn: AppToolTurn, inputs: { readOnly: boolean; ceiling: ModeCeiling; person?(): boolean }): boolean {
  const needs = toolNeeds(tool)
  if (needs.readOnlyLacks && inputs.readOnly && !needs.messages) return false
  if (needs.planRefuses && inputs.ceiling === 'plan') return false
  if (needs.browser?.({}) === 'browser.act' && readsPagesOnly(turn, inputs.ceiling)) return false
  if (turnLacks(tool, needs, turn)) return false
  // A tool every call of which needs `person`; one only some variants need stays usable.
  if (needs.personAlways && !turn.bot && inputs.person?.() !== true) return false
  return botTurnOffers(turn.bot, tool.name)
}

/**
 * A turn that holds `browser.read` but not `browser.act` (§2.6 "Rights"): under a Plan ceiling or in a read-only mode,
 * which includes a turn narrowed from above (`plannedFromAbove`) at its next call.
 */
function readsPagesOnly(turn: AppToolTurn, ceiling: ModeCeiling): boolean {
  return ceiling === 'plan' || turn.modeFacts.readOnly
}

/** What a turn that lacks `person` is told for `tool`. */
function personLacks(tool: string): string {
  return `${tool} is only for a turn a person started. This run was started by a job, an agent's message, a wake, a continuation or a remote send, is a subagent's, or its origin cannot be read.`
}

/**
 * The turn as a thread above it narrows it now (§1.3 "Subagents"): a Plan turn, read-only in its mode facts, so what a
 * Plan turn lacks is refused at the next call, whatever the mode the turn started in.
 */
export function plannedFromAbove(turn: AppToolTurn): AppToolTurn {
  return { ...turn, mode: 'plan', modeCeiling: 'plan', modeFacts: { readOnly: true, agent: false, build: false } }
}

/** What a thread holds now, as far as a capability its child lacks is concerned (`parentHolds`). */
export interface HolderState {
  /** A read-only (`shared`) subagent. */
  readOnly: boolean
  /** Its ceiling now, narrowed from above. */
  ceiling: ModeCeiling
  subagent: boolean
  /** Its turn holds `person`. */
  person: boolean
}

/**
 * Whether a thread in `state` holds the capability `lacks` that its subagent was refused (§2.4): its parent is then told,
 * and otherwise the root names what would give it.
 */
export function parentHolds(lacks: string, state: HolderState): boolean {
  switch (lacks) {
    case 'person':
      return state.person && !state.subagent
    case 'themes':
    case 'quick_actions':
      return !state.subagent
    case 'threads.start':
    case 'settings':
    case 'edit':
      return !state.readOnly && state.ceiling !== 'plan'
    default:
      return !state.readOnly
  }
}

/**
 * Whether a definition's turn on a runtime that takes its tools per turn (Pi) is sent the tool: the per-turn filter
 * the tool declares (`offered`: a browser tool outside the binding, a screenshot a model without vision cannot see).
 */
export function offeredThisTurn(tool: MousseTool, turn: AppToolTurn): boolean {
  return !tool.offered || tool.offered(turn)
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
