import { PERMISSION_KEYS } from '../../../../shared/permissionKeys'
import { visibleThreads } from '../../../../shared/threadLineage'
import { readRunResultText } from '../../delegation/hold'
import type { RunEngine } from '../../RunEngine'
import { TERMINAL_RUN_STATUSES, type AgentActor, type DelegationRecord, type RunRecord, type ThreadEvent } from '../../types'
import type { AgentCreatedThread, AgentRunCommandResult, AgentThreadRequest, AppToolHost } from './host'
import {
  CLIENT_REQUEST_ID_SCHEMA,
  json,
  McpToolError,
  type McpCaller,
  type MousseTool,
  type ToolCallContext,
  type ToolOutcome,
  type ToolScope
} from './types'

const THREAD_READ_DEFAULT_LIMIT = 200
const THREAD_READ_MAX_LIMIT = 500
const THREAD_MESSAGES_DEFAULT_LIMIT = 50
const THREAD_MESSAGES_MAX_LIMIT = 200
/** Each message of `thread_read` view `messages` is cut to this many characters. */
const THREAD_MESSAGE_MAX_CHARS = 4096
const THREAD_LIST_DEFAULT_LIMIT = 100
const THREAD_LIST_MAX_LIMIT = 500
const THREAD_SEARCH_DEFAULT_LIMIT = 50
const THREAD_SEARCH_MAX_LIMIT = 200
const THREAD_SEARCH_MAX_QUERY_CHARS = 512
/** An agent run may send this many messages to other threads; the next is refused. */
export const THREAD_SEND_MAX_PER_RUN = 20
/** The counts of `thread_send` are kept for this many runs, the oldest dropped first. */
const THREAD_SEND_TRACKED_RUNS = 1000
/** An agent run may create this many threads; the next is refused. */
export const THREAD_CREATE_MAX_PER_RUN = 5
/** A new thread's title is cut to this many characters. */
const THREAD_TITLE_MAX_CHARS = 200
/** The first message of a new thread is held to the size of a message a person could send in one go. */
const THREAD_FIRST_MESSAGE_MAX_CHARS = 100_000
/** `thread_wait` waits this long unless told otherwise (MCP clients give up on a call after about a minute) and never longer than the cap. */
export const THREAD_WAIT_DEFAULT_MS = 45_000
export const THREAD_WAIT_MAX_MS = 300_000
/** A run's error text is cut to this many characters in `thread_wait`. */
const THREAD_WAIT_ERROR_MAX_CHARS = 1_000
/** A `manage` search reads the transcripts of this many threads at most (the most recently updated). */
const THREAD_SEARCH_MESSAGE_THREADS = 100
/** Lineage walks stop here; deeper chains are treated as unrelated. */
const LINEAGE_MAX_DEPTH = 64

/** `threadId` (when given) must be the caller's thread. Returns the caller's thread. */
export function callerThreadOnly(args: Record<string, unknown>, caller: McpCaller): string {
  const target = args.threadId
  if (target !== undefined && target !== caller.threadId)
    throw new McpToolError('mousse_scope_denied', `This credential acts for thread ${caller.threadId} only.`)
  return caller.threadId
}

/** Event types a lineage thread may read of another thread (M7): run lifecycle and lineage only, and what agents changed (ids and counts, no content). */
function lineageVisible(type: string): boolean {
  return type.startsWith('run.') || type.startsWith('attempt.') || type === 'command.ignored' || type === 'restart.note' || type === 'thread.lineage' || type === 'agent.action'
}

/**
 * Another thread's events as a lineage relative sees them (M7): run and attempt lifecycle,
 * ignored commands, restart notes, the lineage row and `agent.action` rows; plus `delegation.status`
 * rows whose result is shown only to the delegation's own child (a sibling's result and the parent's
 * other prompts stay private). The final text of a run (`run.result`, kept for every conversational run)
 * is the caller's to read only for a thread below it or one it launched; an ancestor, a sibling and a
 * caller that reaches the thread only through its access level (`read`) get none.
 * Inbox, effect (turn payloads carry prompts), tool and transfer events are left out.
 */
function lineageView(events: ThreadEvent[], callerThreadId: string, scope: ToolScope): ThreadEvent[] {
  const out: ThreadEvent[] = []
  for (const event of events) {
    if (event.type === 'run.result' && !resultTextVisible(scope)) continue
    // Through the `read` level alone (any thread of the allowed projects), only a trimmed copy.
    if (scope === 'read') {
      if (lineageVisible(event.type) || event.type === 'delegation.status') out.push(readProjection(event))
      continue
    }
    if (lineageVisible(event.type)) out.push(event)
    else if (event.type === 'delegation.status') {
      const delegation = event.payload as DelegationRecord
      out.push(delegation.childThreadId === callerThreadId ? event : { ...event, payload: { ...delegation, result: null } })
    }
  }
  return out
}

/** Who may read the final text of a run: the caller itself, a manager, and the owner of a descendant or launched thread. */
function resultTextVisible(scope: ToolScope): boolean {
  return scope === 'own' || scope === 'manage' || scope === 'descendant' || scope === 'launched'
}

/**
 * What the `read` level sees of an event: ids, status and times. Never an error text, a request id, a
 * prompt digest, a provider session or the home and account a run was bound to; an event type this does
 * not know keeps no payload.
 */
function readProjection(event: ThreadEvent): ThreadEvent {
  const payload = (event.payload && typeof event.payload === 'object' ? event.payload : {}) as Record<string, unknown>
  const pick = (...keys: string[]): Record<string, unknown> =>
    Object.fromEntries(keys.filter((key) => payload[key] !== undefined).map((key) => [key, payload[key]]))
  switch (event.type) {
    case 'run.created':
    case 'run.status': {
      const outcome = payload.outcome as { interruptedBy?: unknown } | null | undefined
      return {
        ...event,
        payload: {
          ...pick('runId', 'threadId', 'ordinal', 'status', 'source', 'requestedAt', 'startedAt', 'completedAt'),
          ...(outcome?.interruptedBy ? { outcome: { interruptedBy: outcome.interruptedBy } } : {})
        }
      }
    }
    case 'attempt.created':
    case 'attempt.status':
      return { ...event, payload: pick('attemptId', 'runId', 'ordinal', 'reason', 'status', 'startedAt', 'completedAt') }
    case 'delegation.status':
      return { ...event, payload: pick('delegationId', 'parentThreadId', 'childThreadId', 'status', 'createdAt', 'completedAt') }
    case 'thread.lineage':
      return { ...event, payload: pick('threadId', 'parentThreadId', 'rootThreadId', 'relationship') }
    case 'agent.action':
      return { ...event, payload: pick('action', 'actorThreadId', 'actorRunId') }
    default:
      return { ...event, payload: null }
  }
}

/** How `targetThreadId` sits in the caller's delegation tree: below it, above it, or neither. */
export function lineageRelation(engine: RunEngine, callerThreadId: string, targetThreadId: string): 'descendant' | 'ancestor' | null {
  const ancestors = (threadId: string): string[] => {
    const out: string[] = []
    let current = threadId
    for (let depth = 0; depth < LINEAGE_MAX_DEPTH; depth += 1) {
      const lineage = engine.delegations.getLineage(current)
      if (!lineage || out.includes(lineage.parentThreadId)) break
      out.push(lineage.parentThreadId)
      current = lineage.parentThreadId
    }
    return out
  }
  if (ancestors(targetThreadId).includes(callerThreadId)) return 'descendant'
  return ancestors(callerThreadId).includes(targetThreadId) ? 'ancestor' : null
}

function isRelated(engine: RunEngine, callerThreadId: string, targetThreadId: string): boolean {
  return lineageRelation(engine, callerThreadId, targetThreadId) !== null
}

/** A non-empty project list allows only its projects; a thread without a project is allowed only by an empty list. */
function inProjects(projectIds: readonly string[], projectId: string | undefined): boolean {
  return projectIds.length === 0 || (projectId !== undefined && projectIds.includes(projectId))
}

const notAvailable = (tool: string): ToolOutcome => ({ text: `${tool} is not available in this host.`, isError: true })

function boundedInt(value: unknown, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}`)
  return value
}

/** The caller's `clientRequestId` when given (a retry), else this call's id. */
function toolRequestId(args: Record<string, unknown>, ctx: ToolCallContext): string {
  if (args.clientRequestId === undefined) return ctx.toolCallId
  if (typeof args.clientRequestId !== 'string' || !args.clientRequestId) throw new Error('clientRequestId must be a non-empty string')
  return args.clientRequestId
}

/** The agent behind a change to another thread: the caller's thread and run, and this call. */
function actorOf(ctx: ToolCallContext): AgentActor {
  return { kind: 'agent', threadId: ctx.caller.threadId, runId: ctx.caller.runId, toolCallId: ctx.toolCallId }
}

function requiredId(args: Record<string, unknown>, name: string): string {
  const value = args[name]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`)
  return value
}

/** Why the engine refused an agent's message because of the state the thread is in, in words for the agent. */
const SEND_CONFLICTS: Readonly<Record<string, string>> = {
  thread_paused:
    "The thread's run is paused by a usage limit and resumes by itself; a message from an agent would end that pause. Stop the paused run with thread_interrupt first, or send again later.",
  questions_pending:
    'The thread is waiting for the user to answer a question or an approval; a message from an agent never answers or skips it. Try again after the user has answered.',
  agent_hops_exceeded:
    'Too many agent messages in a row without a person in between: this message would be past the limit. Stop here and let a person reply before agents go on.',
  agent_queue_full:
    'The thread already has several messages from agents waiting in its queue. Wait for them to run (thread_wait), or try again later.'
}

/** An engine refusal that means the thread is not in a state to take the message now, as a `mousse_conflict`. */
function sendConflict(error: unknown): McpToolError | undefined {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code !== 'string') return undefined
  if (SEND_CONFLICTS[code]) return new McpToolError('mousse_conflict', SEND_CONFLICTS[code], { conflict: code })
  if (code === 'merge_back_pending') return new McpToolError('mousse_conflict', error instanceof Error ? error.message : 'A merge-back waits for the thread.', { conflict: code })
  return undefined
}

/**
 * A change to another thread is refused while that thread is archived: it takes no new work until it is
 * restored. A trashed thread never gets here (the central check refuses it as unknown).
 */
function assertTakesWork(host: AppToolHost, threadId: string): void {
  if (host.threadMeta?.(threadId)?.settledAt)
    throw new McpToolError('mousse_conflict', `Thread ${threadId} is archived; it takes no new work until it is restored.`, { conflict: 'thread_archived', threadId })
}

/**
 * A steer or Stop reaches a subagent only from its own parent's lineage: a steer into another agent's task would
 * shape the result that task hands its parent, and a Stop would cancel a task its owner never gave up. A thread that
 * is no subagent, and a subagent below the caller, are fine.
 */
function assertOwnSubagentsOnly(engine: RunEngine, caller: McpCaller, threadId: string, tool: string): void {
  if (engine.delegations.getLineage(threadId)?.relationship !== 'subagent') return
  if (lineageRelation(engine, caller.threadId, threadId) === 'descendant') return
  throw new McpToolError('mousse_scope_denied', `Thread ${threadId} is a subagent of another thread; ${tool} reaches only the subagents below your own thread. Its parent manages it.`)
}

/**
 * A personal bot's thread is driven by its owner and its bot engine: its walls, consent and escalation decide what it
 * does, and its runs end by the engine's own rules. No agent sends to it, steers it or stops it from another thread.
 */
function assertNotBotThread(host: AppToolHost, threadId: string, tool: string): void {
  let role: string | undefined
  try {
    role = host.botRole?.(threadId)
  } catch {
    role = undefined
  }
  if (role) throw new McpToolError('mousse_scope_denied', `Thread ${threadId} belongs to a bot; ${tool} cannot reach it. Its owner continues it from the Bots tab.`)
}

/** What an accepted Stop or steer returns; every other result is a refusal the caller can act on. */
function acceptedRunCommand(result: AgentRunCommandResult, expectedRunId: string): { runId: string; sequence: number; replayed: boolean } {
  switch (result.status) {
    case 'accepted':
      return { runId: result.runId, sequence: result.sequence, replayed: result.replayed }
    case 'ceiling_exceeded':
      throw new McpToolError(
        'mousse_conflict',
        `Run ${expectedRunId} is running under a looser permission mode (${result.targetMode}) than yours (${result.callerMode}); a running turn cannot be narrowed, so your steer would run with more authority than you have. Send a message instead: it runs under your mode.`,
        { conflict: 'ceiling_exceeded', callerMode: result.callerMode, targetMode: result.targetMode }
      )
    case 'rejected':
      if (result.reason === 'steer_target_not_ready')
        throw new McpToolError('mousse_conflict', `Run ${expectedRunId} has not started its turn yet, so there is nothing to steer. Steer it once it is running, or send a message instead.`, { conflict: result.reason, expectedRunId })
      if (SEND_CONFLICTS[result.reason])
        throw new McpToolError('mousse_conflict', SEND_CONFLICTS[result.reason], { conflict: result.reason, expectedRunId })
      throw new McpToolError('mousse_conflict', `The command was refused: ${result.reason}.`, { conflict: result.reason, expectedRunId })
    case 'ignored':
      if (result.reason === 'run_not_found')
        throw new McpToolError('mousse_conflict', `Run ${expectedRunId} is not a run of this thread.`, { conflict: 'run_not_found', expectedRunId })
      if (result.runStatus === 'paused')
        throw new McpToolError(
          'mousse_conflict',
          `Run ${expectedRunId} is paused by a usage limit and has no live turn; end it with thread_interrupt, or wait for it to resume.`,
          { conflict: 'run_paused', expectedRunId, activeRunId: result.activeRunId }
        )
      throw new McpToolError(
        'mousse_conflict',
        `Run ${expectedRunId} is not the thread's active run${result.activeRunId ? ` (${result.activeRunId} is)` : ' (it has none)'}; nothing was changed. Read the thread again.`,
        { conflict: 'run_not_active', expectedRunId, activeRunId: result.activeRunId, ...(result.runStatus ? { runStatus: result.runStatus } : {}) }
      )
  }
}

/** The transcript row of a change the call made; the `agent.action` event is the record, so a row that fails to write is not an error. */
function showAction(host: AppToolHost, threadId: string, actor: AgentActor, summary: string): void {
  try {
    host.showAgentAction?.({ threadId }, actor, summary)
  } catch (error) {
    console.warn('the transcript row of an agent action could not be written', { threadId, error: error instanceof Error ? error.message : String(error) })
  }
}

/** How a `thread_wait` ended before its result was read. */
type WaitEnd = { kind: 'finished' } | { kind: 'timeout' } | { kind: 'caller_ended' }

/**
 * `thread_read`, `thread_list`, `thread_search`, the queue tools, `thread_fork`, `thread_merge_back` and the
 * tools that act on other threads (`thread_send`, `thread_wait`, `thread_interrupt`, `thread_steer`): the
 * run engine's own threads, offered over MCP only (the pi loop never had them).
 */
export function threadTools(host: AppToolHost, engine: RunEngine): MousseTool[] {
  const allowedProjectIds = (): string[] => host.agentAccess?.().projectIds ?? []
  /** Messages each run has sent to other threads, in memory: a restart gives every run a fresh count. */
  const sends = new Map<string, number>()
  const reserveSend = (runId: string): void => {
    const used = sends.get(runId) ?? 0
    if (used >= THREAD_SEND_MAX_PER_RUN)
      throw new Error(`thread_send is limited to ${THREAD_SEND_MAX_PER_RUN} messages per run; end your turn and let the other threads work.`)
    sends.delete(runId)
    sends.set(runId, used + 1)
    // The oldest runs fall out first, so the map stays small on a long-lived daemon.
    while (sends.size > THREAD_SEND_TRACKED_RUNS) sends.delete(sends.keys().next().value as string)
  }
  const releaseSend = (runId: string): void => {
    const used = sends.get(runId) ?? 0
    if (used <= 1) sends.delete(runId)
    else sends.set(runId, used - 1)
  }
  /** Threads each run has created, kept like the send counts. */
  const creations = new Map<string, number>()
  const reserveCreation = (runId: string): void => {
    const used = creations.get(runId) ?? 0
    if (used >= THREAD_CREATE_MAX_PER_RUN)
      throw new Error(`thread_create is limited to ${THREAD_CREATE_MAX_PER_RUN} threads per run; finish the work in the threads you made, or end your turn.`)
    creations.delete(runId)
    creations.set(runId, used + 1)
    while (creations.size > THREAD_SEND_TRACKED_RUNS) creations.delete(creations.keys().next().value as string)
  }
  const releaseCreation = (runId: string): void => {
    const used = creations.get(runId) ?? 0
    if (used <= 1) creations.delete(runId)
    else creations.set(runId, used - 1)
  }
  return [
    {
      name: 'thread_read',
      description: 'Read a thread. view "events" (default): run events (runs, attempts, delegations, tool calls) of your thread, or of a thread you delegated to or were delegated from; with the profile\'s read or manage agent access level, the run lifecycle of any thread, and with manage everything. Page with afterSeq. view "messages": the transcript of your thread, or of any thread with manage access; page with afterIndex.',
      inputSchema: {
        type: 'object',
        properties: {
          threadId: { type: 'string', description: 'Defaults to your thread.' },
          view: { type: 'string', enum: ['events', 'messages'], description: 'Defaults to events.' },
          afterSeq: { type: 'integer', minimum: 0, description: 'events: return events after this sequence number.' },
          afterIndex: { type: 'integer', minimum: 0, description: 'messages: return the messages after this many (nextAfterIndex of the previous page).' },
          limit: { type: 'integer', minimum: 1, maximum: THREAD_READ_MAX_LIMIT, description: `events: up to ${THREAD_READ_MAX_LIMIT} (default ${THREAD_READ_DEFAULT_LIMIT}); messages: up to ${THREAD_MESSAGES_MAX_LIMIT} (default ${THREAD_MESSAGES_DEFAULT_LIMIT}).` }
        }
      },
      access: 'readsOthers',
      class: 'read',
      offered: () => false,
      handler: (args, ctx) => {
        const threadId = args.threadId === undefined ? ctx.caller.threadId : args.threadId
        if (typeof threadId !== 'string' || !threadId) throw new Error('threadId must be a non-empty string')
        const scope = ctx.scope ?? 'own'
        const view = args.view === undefined ? 'events' : args.view
        if (view !== 'events' && view !== 'messages') throw new Error("view must be 'events' or 'messages'")
        // The whole record is the caller's own, or a manager's; every other reach is the filtered lineage view.
        const full = scope === 'own' || scope === 'manage'
        if (view === 'messages') {
          if (!full) throw new McpToolError('mousse_scope_denied', `Reading the messages of thread ${threadId} needs the "manage" agent access level.`)
          if (!host.threadMessages) return notAvailable('thread_read messages')
          const afterIndex = boundedInt(args.afterIndex, 'afterIndex', 0, Number.MAX_SAFE_INTEGER, 0)
          const limit = boundedInt(args.limit, 'limit', 1, THREAD_MESSAGES_MAX_LIMIT, THREAD_MESSAGES_DEFAULT_LIMIT)
          const all = host.threadMessages(threadId)
          const messages = all.slice(afterIndex, afterIndex + limit).map((message, offset) => {
            const text = typeof message.content === 'string' ? message.content : ''
            const truncated = text.length > THREAD_MESSAGE_MAX_CHARS
            return {
              index: afterIndex + offset,
              id: message.id,
              role: message.role,
              timestamp: message.timestamp,
              text: truncated ? text.slice(0, THREAD_MESSAGE_MAX_CHARS) : text,
              ...(truncated ? { truncated: true } : {})
            }
          })
          return json({ threadId, view, scope, messages, total: all.length, nextAfterIndex: afterIndex + messages.length })
        }
        const afterSeq = boundedInt(args.afterSeq, 'afterSeq', 0, Number.MAX_SAFE_INTEGER, 0)
        const limit = boundedInt(args.limit, 'limit', 1, THREAD_READ_MAX_LIMIT, THREAD_READ_DEFAULT_LIMIT)
        const page = engine.listEvents(threadId, { afterSeq, limit })
        const events = full ? page : lineageView(page, ctx.caller.threadId, scope)
        // `nextAfterSeq` pages on even when a lineage view filtered events out of this page.
        return json({ threadId, view, scope, events, maxSeq: engine.maxSeq(threadId), nextAfterSeq: page.at(-1)?.seq ?? afterSeq })
      }
    },
    {
      name: 'thread_list',
      description: 'List the profile\'s threads with their project, activity and what is waiting on them (needs the read or manage agent access level; limited to the projects the profile allows). Subagent threads are folded under their parents unless includeSubagents (manage only). Threads you launched are always listed.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Only this project.' },
          status: { type: 'string', enum: ['active', 'idle', 'awaiting_input'], description: 'active: a run is going; awaiting_input: a question waits for an answer; idle: neither.' },
          includeUnstarted: { type: 'boolean', description: 'Include empty drafts (default false).' },
          includeSettled: { type: 'boolean', description: 'Include archived threads (default false).' },
          includeSubagents: { type: 'boolean', description: 'Include subagent threads (manage only; default false).' },
          limit: { type: 'integer', minimum: 1, maximum: THREAD_LIST_MAX_LIMIT, description: `Most recently updated first; default ${THREAD_LIST_DEFAULT_LIMIT}.` }
        }
      },
      access: 'readsOthers',
      class: 'read',
      minLevel: 'read',
      offered: () => false,
      target: (args) => ({ projectId: typeof args.projectId === 'string' && args.projectId ? args.projectId : undefined }),
      handler: (args, ctx) => {
        if (!host.listThreads || !host.listProjects) return notAvailable('thread_list')
        if (args.projectId !== undefined && (typeof args.projectId !== 'string' || !args.projectId)) throw new Error('projectId must be a non-empty string')
        if (args.status !== undefined && args.status !== 'active' && args.status !== 'idle' && args.status !== 'awaiting_input')
          throw new Error('status must be active, idle or awaiting_input')
        for (const key of ['includeUnstarted', 'includeSettled', 'includeSubagents'] as const)
          if (args[key] !== undefined && typeof args[key] !== 'boolean') throw new Error(`${key} must be a boolean`)
        const limit = boundedInt(args.limit, 'limit', 1, THREAD_LIST_MAX_LIMIT, THREAD_LIST_DEFAULT_LIMIT)
        const manage = ctx.scope === 'manage'
        if (args.includeSubagents === true && !manage)
          throw new McpToolError('mousse_scope_denied', 'includeSubagents needs the "manage" agent access level.')
        const all = host.listThreads()
        const projectIds = allowedProjectIds()
        const candidates = (args.includeSubagents === true ? all : visibleThreads(all)).filter((thread) => {
          const launched = thread.createdByThreadId === ctx.caller.threadId
          if (!launched && !inProjects(projectIds, thread.projectId)) return false
          if (args.projectId !== undefined && thread.projectId !== args.projectId) return false
          if (!launched && args.includeUnstarted !== true && !thread.startedAt) return false
          return launched || args.includeSettled === true || !thread.settledAt
        }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        const projectNames = new Map(host.listProjects().map((project) => [project.id, project.name]))
        const rows = []
        for (const thread of candidates) {
          const activeRunId = engine.getActiveRun(thread.id)?.runId ?? null
          const activity = host.threadActivity?.(thread.id) ?? { queuedCount: 0, pendingQuestions: [] }
          const status = activity.pendingQuestions.length ? 'awaiting_input' : activeRunId ? 'active' : 'idle'
          if (args.status !== undefined && args.status !== status) continue
          rows.push({
            id: thread.id,
            name: thread.name,
            projectId: thread.projectId ?? null,
            projectName: (thread.projectId && projectNames.get(thread.projectId)) || null,
            startedAt: thread.startedAt ?? null,
            updatedAt: thread.updatedAt,
            settledAt: thread.settledAt ?? null,
            modelOverride: thread.modelOverride ?? null,
            status,
            activeRunId,
            queuedCount: activity.queuedCount,
            pendingQuestionCount: activity.pendingQuestions.length,
            // The questions themselves (request ids, prompts, options) are for a manager.
            ...(manage && activity.pendingQuestions.length ? { pendingQuestions: activity.pendingQuestions } : {}),
            createdByThreadId: thread.createdByThreadId ?? null,
            ...(thread.lineage ? { lineage: { parentThreadId: thread.lineage.parentThreadId } } : {})
          })
          if (rows.length >= limit) break
        }
        const projects = [...projectNames].filter(([id]) => inProjects(projectIds, id)).map(([id, name]) => ({ id, name }))
        return json({ threads: rows, projects })
      }
    },
    {
      name: 'thread_search',
      description: 'Search thread titles and project names (needs the read or manage agent access level; limited to the projects the profile allows). With manage, message text is searched too and results carry a snippet. Subagent threads are not searched.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: THREAD_SEARCH_MAX_LIMIT, description: `Default ${THREAD_SEARCH_DEFAULT_LIMIT}.` }
        },
        required: ['query']
      },
      access: 'readsOthers',
      class: 'read',
      minLevel: 'read',
      offered: () => false,
      target: () => ({}),
      handler: (args, ctx) => {
        if (!host.searchThreads) return notAvailable('thread_search')
        if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('query must be a non-empty string')
        if (args.query.length > THREAD_SEARCH_MAX_QUERY_CHARS) throw new Error(`query must be at most ${THREAD_SEARCH_MAX_QUERY_CHARS} characters`)
        const limit = boundedInt(args.limit, 'limit', 1, THREAD_SEARCH_MAX_LIMIT, THREAD_SEARCH_DEFAULT_LIMIT)
        const manage = ctx.scope === 'manage'
        const projectIds = allowedProjectIds()
        // Message matches (and so their existence) are transcript content: a manager's.
        // Who may be seen, and titles only below manage, are decided by the host before it applies the limit
        // or reads any transcript; transcripts are scanned for the most recent threads only.
        const results = host.searchThreads(args.query, limit, {
          allow: (found) => inProjects(projectIds, found.projectId) || found.createdByThreadId === ctx.caller.threadId,
          titlesOnly: !manage,
          maxMessageThreads: THREAD_SEARCH_MESSAGE_THREADS
        })
          .filter((hit) => manage || hit.matchType !== 'message')
          .filter((hit) => inProjects(projectIds, hit.projectId) || host.threadMeta?.(hit.threadId)?.createdByThreadId === ctx.caller.threadId)
          .slice(0, limit)
          .map(({ snippet, ...hit }) => (manage && snippet !== undefined ? { ...hit, snippet } : hit))
        return json({ results })
      }
    },
    {
      name: 'thread_send',
      description: `Send a message to another thread (needs the manage agent access level and a project the profile allows). The thread's model receives it labelled as a message from an agent in your thread, not from the user, and runs it under your permission mode when that is stricter than the thread's own; it never gets more than the thread itself allows. It starts a turn when the thread is idle and queues behind the running turn otherwise (it never steers the running turn). A thread kept in Plan takes it as a plan turn. Refused while the thread waits for the user to answer a question or approval, is paused by a usage limit, or is archived, when it already has several messages from agents waiting, and when it would be more than a few agent messages in a row without a person in between. You may send ${THREAD_SEND_MAX_PER_RUN} messages per run. Returns the run it created: use thread_wait with it to wait for the answer, only when you need it this turn. Subagents are reached with continue_subagent.`,
      inputSchema: {
        type: 'object',
        properties: {
          threadId: { type: 'string', description: 'The thread to send to; not your own (use queue_enqueue for that).' },
          content: { type: 'string' },
          mode: { type: 'string', enum: ['agent', 'plan'], description: 'Defaults to agent.' },
          clientRequestId: CLIENT_REQUEST_ID_SCHEMA
        },
        required: ['threadId', 'content']
      },
      access: 'managesOthers',
      class: 'mutation',
      minLevel: 'manage',
      offered: () => false,
      handler: async (args, ctx) => {
        const threadId = requiredId(args, 'threadId')
        if (typeof args.content !== 'string' || !args.content.trim()) throw new Error('thread_send requires content')
        if (args.mode !== undefined && args.mode !== 'agent' && args.mode !== 'plan') throw new Error('mode must be agent or plan')
        const mode = (args.mode as 'agent' | 'plan' | undefined) ?? 'agent'
        if (!host.sendToThread) return notAvailable('thread_send')
        if (threadId === ctx.caller.threadId) throw new Error('thread_send is for other threads; use queue_enqueue to queue a message on your own thread.')
        // Defence in depth: a plan ceiling is held to `read` and never gets here.
        if (mode === 'agent' && ctx.caller.modeCeiling === 'plan') throw new McpToolError('mousse_ceiling_exceeded', 'A plan-ceiling caller can only send plan turns.')
        // A subagent is reached through its parent: a message sent to it directly would run untracked.
        if (engine.delegations.getLineage(threadId)?.relationship === 'subagent')
          throw new McpToolError('mousse_scope_denied', `Thread ${threadId} is a subagent; its parent reaches it with continue_subagent, and a message from here would run without its parent hearing the result.`)
        assertNotBotThread(host, threadId, 'thread_send')
        assertTakesWork(host, threadId)
        const actor = actorOf(ctx)
        const requestKey = `thread_send:${ctx.caller.threadId}:${toolRequestId(args, ctx)}`
        try {
          reserveSend(actor.runId)
        } catch (limit) {
          // A retry of a send this run already made is answered with its first result, however many it has made.
          const earlier = host.earlierSend?.(threadId, requestKey)
          if (earlier) return json({ threadId, ...earlier })
          throw limit
        }
        let sent
        try {
          sent = await host.sendToThread(threadId, { content: args.content, mode }, { clientRequestId: requestKey, actor })
        } catch (error) {
          releaseSend(actor.runId)
          throw sendConflict(error) ?? error
        }
        // A retry returns the first result and changes nothing, so it is not another send.
        if (sent.replayed) releaseSend(actor.runId)
        else showAction(host, threadId, actor, `sent a message (run ${sent.runId})`)
        return json({ threadId, ...sent })
      }
    },
    {
      name: 'thread_wait',
      description: `Wait for a run of another thread to finish (needs the read agent access level; a thread you launched with thread_create or one below you needs none), for at most timeoutMs (default ${THREAD_WAIT_DEFAULT_MS}, up to ${THREAD_WAIT_MAX_MS}). Pass the runId thread_send returned; without one, the run that is active now. Returns status finished (with the run's outcome, and its final text where you may read it), timeout (the run is still going: call again; the wait never interrupts it), paused (a usage limit paused the run and it was still paused when the wait ran out: it resumes by itself, and the result says when to ask again; a wait that is running when it resumes follows it into the run that continues it), idle (no run to wait for) or caller_ended (your own run ended). Wait only when you need the answer this turn; otherwise end your turn and read the thread later.`,
      inputSchema: {
        type: 'object',
        properties: {
          threadId: { type: 'string', description: 'The thread to wait on; not your own.' },
          runId: { type: 'string', description: 'The run to wait for; the active run when omitted.' },
          timeoutMs: { type: 'integer', minimum: 1, maximum: THREAD_WAIT_MAX_MS, description: `Default ${THREAD_WAIT_DEFAULT_MS}.` }
        },
        required: ['threadId']
      },
      access: 'readsOthers',
      class: 'read',
      // No `minLevel`: the central check lets a caller wait on a thread it launched or one below it at any
      // level, so the tool is listed at every level (as `thread_interrupt` is); another thread needs `read`.
      offered: () => false,
      handler: async (args, ctx) => {
        const threadId = requiredId(args, 'threadId')
        if (args.runId !== undefined && (typeof args.runId !== 'string' || !args.runId)) throw new Error('runId must be a non-empty string')
        const timeoutMs = boundedInt(args.timeoutMs, 'timeoutMs', 1, THREAD_WAIT_MAX_MS, THREAD_WAIT_DEFAULT_MS)
        if (threadId === ctx.caller.threadId) throw new Error('thread_wait is for other threads: your own run ends only when your turn does.')
        const scope = ctx.scope ?? 'read'
        let target = args.runId as string | undefined
        let settle!: (end: WaitEnd) => void
        const ended = new Promise<WaitEnd>((resolve) => { settle = resolve })
        // Terminal runs seen before the run to wait for is known (no runId given).
        const seenTerminal = new Set<string>()
        // The run a usage-limit pause handed over to: its answer is the one the waiter wants, so the wait
        // follows the pause into the run that continues it.
        let continuedFrom: string | undefined
        const answered = (run: RunRecord): boolean => {
          if (!TERMINAL_RUN_STATUSES.has(run.status)) return false
          const endedBy = run.outcome?.pause?.endedBy
          if (endedBy === 'resume' || endedBy === 'resume_now') {
            const next = engine.listRuns(threadId, { limit: 20 }).find((entry) => entry.outcome?.continuationOf === run.runId)
            if (next) {
              continuedFrom ??= run.runId
              target = next.runId
              return answered(next)
            }
          }
          return true
        }
        // Subscribed before the run is read: a run that ends in between is seen here, never missed.
        const unsubscribe = engine.store.onEvent((event) => {
          if (event.threadId !== threadId || event.type !== 'run.status') return
          const run = event.payload as RunRecord
          if (!TERMINAL_RUN_STATUSES.has(run.status)) return
          seenTerminal.add(run.runId)
          if (run.runId === target && answered(run)) settle({ kind: 'finished' })
        })
        const timer = setTimeout(() => settle({ kind: 'timeout' }), timeoutMs)
        const onAbort = (): void => settle({ kind: 'caller_ended' })
        ctx.signal.addEventListener('abort', onAbort, { once: true })
        try {
          if (ctx.signal.aborted) return json({ status: 'caller_ended', threadId })
          let run: RunRecord | null
          if (target) {
            run = engine.getRun(target)
            if (!run || run.threadId !== threadId) throw new McpToolError('mousse_conflict', `Run ${target} is not a run of thread ${threadId}.`, { conflict: 'run_not_found', expectedRunId: target })
          } else {
            run = engine.getActiveRun(threadId) ?? engine.store.getPausedRun(threadId)
            if (!run) return json({ status: 'idle', threadId })
            target = run.runId
          }
          // A paused run is waited on like a running one: the pause ends by itself (the run resumes, and the wait
          // follows it), or the wait times out and says when to ask again. It is never answered at once.
          if (answered(run) || (seenTerminal.has(run.runId) && answered(engine.getRun(run.runId) ?? run))) settle({ kind: 'finished' })
          const end = await ended
          if (end.kind === 'caller_ended') return json({ status: 'caller_ended', threadId })
          const now = engine.getRun(target) ?? run
          const fullView = resultTextVisible(scope)
          const outcome = now.outcome
          const reported = {
            runId: now.runId,
            status: now.status,
            ...(continuedFrom ? { continuedFrom } : {}),
            ...(fullView && outcome?.error ? { error: outcome.error.slice(0, THREAD_WAIT_ERROR_MAX_CHARS) } : {}),
            ...(outcome?.interruptedBy ? { interruptedBy: outcome.interruptedBy } : {})
          }
          if (end.kind === 'timeout' && now.status === 'paused') {
            const pause = now.outcome?.pause
            const retryAfterMs = pause ? Math.min(THREAD_WAIT_MAX_MS, Math.max(1_000, Date.parse(pause.until) - Date.now())) : THREAD_WAIT_DEFAULT_MS
            return json({
              status: 'paused',
              threadId,
              run: reported,
              ...(pause ? { pause: { reason: pause.reason, until: pause.until, estimated: pause.estimated } } : {}),
              retryAfterMs,
              hint: `A usage limit paused the run; it resumes by itself. Ask again after ${Math.ceil(retryAfterMs / 1000)} s (not sooner), or end it with thread_interrupt.`
            })
          }
          if (end.kind === 'timeout') return json({ status: 'timeout', threadId, run: reported, hint: 'The run is still going; call thread_wait again.' })
          // The text of this run only, never the latest message of the thread.
          const resultText = fullView ? readRunResultText(engine.store, threadId, now.runId) : undefined
          return json({ status: 'finished', threadId, run: reported, ...(resultText !== undefined ? { resultText } : {}) })
        } finally {
          clearTimeout(timer)
          unsubscribe()
          ctx.signal.removeEventListener('abort', onAbort)
        }
      }
    },
    {
      name: 'thread_interrupt',
      description: 'Stop a run of another thread: the run you name, which must still be the thread\'s active (or paused) run, and the subagents below it, as a Stop in the app does (needs the manage agent access level and a project the profile allows; a thread you launched needs no level). Queued messages a person sent stay. Name the run you read; if it has ended or another run started, nothing is stopped and you are told which run is active. A paused run is ended too.',
      inputSchema: {
        type: 'object',
        properties: {
          threadId: { type: 'string' },
          runId: { type: 'string', description: 'The run to stop, as you last read it.' },
          clientRequestId: CLIENT_REQUEST_ID_SCHEMA
        },
        required: ['threadId', 'runId']
      },
      access: 'managesOthers',
      class: 'mutation',
      launchedOk: true,
      offered: () => false,
      handler: async (args, ctx) => {
        const threadId = requiredId(args, 'threadId')
        const runId = requiredId(args, 'runId')
        if (!host.stopRun) return notAvailable('thread_interrupt')
        if (threadId === ctx.caller.threadId) throw new Error('thread_interrupt is for other threads; stop your own work by ending your turn.')
        // A Stop removes work, so an archived thread (which can still have a live or paused run) may be stopped.
        assertNotBotThread(host, threadId, 'thread_interrupt')
        assertOwnSubagentsOnly(engine, ctx.caller, threadId, 'thread_interrupt')
        const actor = actorOf(ctx)
        const result = acceptedRunCommand(await host.stopRun(threadId, runId, { clientRequestId: `thread_interrupt:${ctx.caller.threadId}:${toolRequestId(args, ctx)}`, actor }), runId)
        if (!result.replayed) showAction(host, threadId, actor, `stopped run ${runId}`)
        return json({ threadId, ...result })
      }
    },
    {
      name: 'thread_steer',
      description: 'Add guidance to the turn another thread is running now (needs the manage agent access level and a project the profile allows). Name the run you read; if it is not the thread\'s active run, or is paused, nothing is sent and you are told why. The thread\'s model receives the text labelled as a message from an agent, not from the user. Refused when the run is running under a looser permission mode than yours (a running turn cannot be narrowed): send a message instead.',
      inputSchema: {
        type: 'object',
        properties: {
          threadId: { type: 'string' },
          runId: { type: 'string', description: 'The run to steer, as you last read it.' },
          text: { type: 'string' },
          clientRequestId: CLIENT_REQUEST_ID_SCHEMA
        },
        required: ['threadId', 'runId', 'text']
      },
      access: 'managesOthers',
      class: 'mutation',
      minLevel: 'manage',
      offered: () => false,
      handler: async (args, ctx) => {
        const threadId = requiredId(args, 'threadId')
        const runId = requiredId(args, 'runId')
        if (typeof args.text !== 'string' || !args.text.trim()) throw new Error('thread_steer requires text')
        if (!host.steerRun) return notAvailable('thread_steer')
        if (threadId === ctx.caller.threadId) throw new Error('thread_steer is for other threads.')
        assertNotBotThread(host, threadId, 'thread_steer')
        assertOwnSubagentsOnly(engine, ctx.caller, threadId, 'thread_steer')
        assertTakesWork(host, threadId)
        const actor = actorOf(ctx)
        const result = acceptedRunCommand(await host.steerRun(threadId, runId, args.text, { clientRequestId: `thread_steer:${ctx.caller.threadId}:${toolRequestId(args, ctx)}`, actor }), runId)
        if (!result.replayed) showAction(host, threadId, actor, `steered run ${runId}`)
        return json({ threadId, ...result })
      }
    },
    {
      name: 'thread_create',
      description: `Start a new thread in a project (needs the manage agent access level and a project the profile allows). workspace "project" (default) works in the project's own folder; "new_worktree" gives the thread a worktree of its own, made when it first runs ("existing_worktree" is not supported). instanceId and model name the thread's model together (both must be ones the profile allows); without them the thread uses your own model. The thread runs in a permission mode no wider than yours and is recorded as launched by your thread: you can read it, wait on it and interrupt it afterwards at any level, and it is not nested under yours. firstMessage (with mode agent or plan) is sent to it as a message from you, so it starts at once; it counts toward the limit on agent messages in a row without a person in between. You may create ${THREAD_CREATE_MAX_PER_RUN} threads per run. Pass a clientRequestId and reuse it to retry: the same thread comes back, never a second one. Returns the thread's id, the model and mode it got, and what became of the first message; use thread_wait with its run id to wait for the answer, only when you need it this turn.`,
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'The project to create the thread in (thread_list returns the ones you may use).' },
          title: { type: 'string', description: `The thread's title (up to ${THREAD_TITLE_MAX_CHARS} characters); without one the thread is named "New Thread" and gets a title from its first message.` },
          workspace: { type: 'string', enum: ['project', 'new_worktree', 'existing_worktree'], description: 'Defaults to project. existing_worktree is refused.' },
          instanceId: { type: 'string', description: 'The provider instance; needs model.' },
          model: { type: 'string', description: 'The model id; with instanceId, or on the instance of your own model.' },
          firstMessage: { type: 'string', description: 'Sent to the new thread as your message, so it starts working.' },
          mode: { type: 'string', enum: ['agent', 'plan'], description: 'The mode of firstMessage; defaults to agent.' },
          clientRequestId: CLIENT_REQUEST_ID_SCHEMA
        },
        required: ['projectId']
      },
      access: 'managesOthers',
      class: 'mutation',
      minLevel: 'manage',
      offered: () => false,
      // A new thread has no id yet: the project is what the central check holds the caller to.
      target: (args) => ({ projectId: typeof args.projectId === 'string' && args.projectId ? args.projectId : undefined }),
      handler: async (args, ctx) => {
        if (!host.createThread) return notAvailable('thread_create')
        const projectId = requiredId(args, 'projectId')
        // A bot's thread acts for a person outside Mousse; its owner continues it from the Bots tab, and it starts no threads.
        let botRole: string | undefined
        try {
          botRole = host.botRole?.(ctx.caller.threadId)
        } catch {
          botRole = undefined
        }
        if (botRole || ctx.turn.bot) throw new McpToolError('mousse_scope_denied', 'A thread that belongs to a bot cannot create threads.')
        // Defence in depth: a plan ceiling is held to `read` and never gets here.
        if (ctx.caller.modeCeiling === 'plan') throw new McpToolError('mousse_ceiling_exceeded', 'A plan-ceiling caller cannot start threads.')
        if (args.title !== undefined && typeof args.title !== 'string') throw new Error('title must be a string')
        const title = typeof args.title === 'string' ? args.title.trim() : ''
        if (title.length > THREAD_TITLE_MAX_CHARS) throw new Error(`title must be at most ${THREAD_TITLE_MAX_CHARS} characters`)
        if (args.workspace !== undefined && args.workspace !== 'project' && args.workspace !== 'new_worktree' && args.workspace !== 'existing_worktree')
          throw new Error("workspace must be 'project', 'new_worktree' or 'existing_worktree'")
        if (args.workspace === 'existing_worktree')
          throw new Error('workspace "existing_worktree" is not supported: a thread cannot take over a worktree it did not make. Use "new_worktree" for a worktree of its own, or "project" for the project\'s folder. No thread was created.')
        const workspace: 'project' | 'new_worktree' = args.workspace === 'new_worktree' ? 'new_worktree' : 'project'
        for (const key of ['instanceId', 'model'] as const)
          if (args[key] !== undefined && (typeof args[key] !== 'string' || !(args[key] as string).trim())) throw new Error(`${key} must be a non-empty string`)
        const instanceId = typeof args.instanceId === 'string' ? args.instanceId.trim() : undefined
        const model = typeof args.model === 'string' ? args.model.trim() : undefined
        if (instanceId && !model) throw new Error('instanceId needs model: name the model on that instance.')
        if (args.firstMessage !== undefined && (typeof args.firstMessage !== 'string' || !args.firstMessage.trim())) throw new Error('firstMessage must be a non-empty string')
        if (typeof args.firstMessage === 'string' && args.firstMessage.length > THREAD_FIRST_MESSAGE_MAX_CHARS)
          throw new Error(`firstMessage must be at most ${THREAD_FIRST_MESSAGE_MAX_CHARS} characters`)
        if (args.mode !== undefined && args.mode !== 'agent' && args.mode !== 'plan') throw new Error('mode must be agent or plan')
        if (args.mode !== undefined && args.firstMessage === undefined) throw new Error('mode is the mode of firstMessage: give a firstMessage, or leave mode out.')
        const request: AgentThreadRequest = {
          projectId,
          ...(title ? { title } : {}),
          workspace,
          ...(instanceId ? { instanceId } : {}),
          ...(model ? { model } : {}),
          ...(typeof args.firstMessage === 'string' ? { firstMessage: args.firstMessage, mode: (args.mode as 'agent' | 'plan' | undefined) ?? 'agent' } : {})
        }
        const actor = actorOf(ctx)
        const requestKey = `thread_create:${ctx.caller.threadId}:${toolRequestId(args, ctx)}`
        try {
          reserveCreation(actor.runId)
        } catch (limit) {
          // A retry of a creation this run already made is answered with that thread, however many it has made.
          const earlier = host.earlierCreation?.(requestKey)
          if (earlier) return json({ ...earlier, replayed: true })
          throw limit
        }
        let created: AgentCreatedThread
        try {
          created = await host.createThread(request, { clientRequestId: requestKey, actor, accessLevel: ctx.caller.accessLevel })
        } catch (error) {
          releaseCreation(actor.runId)
          throw sendConflict(error) ?? error
        }
        // A retry returns the one thread and changes nothing, so it is not another creation.
        if (created.replayed) releaseCreation(actor.runId)
        else showAction(host, created.threadId, actor, 'created this thread')
        return json(created)
      }
    },
    {
      name: 'queue_list',
      description: 'List the messages queued on your thread (they run after the current turn).',
      inputSchema: { type: 'object', properties: { threadId: { type: 'string', description: 'Your thread only.' } } },
      threadArgChecked: 'the handler accepts the caller\'s own thread only',
      access: 'reads',
      class: 'read',
      offered: () => false,
      handler: (args, ctx) => json({ items: host.listQueue?.(callerThreadOnly(args, ctx.caller)) ?? [] })
    },
    {
      name: 'queue_enqueue',
      description: 'Queue a message on your thread; it runs as a new turn after the current one.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          mode: { type: 'string', enum: ['agent', 'plan'], description: 'Defaults to plan under a plan ceiling, else agent.' },
          threadId: { type: 'string', description: 'Your thread only.' }
        },
        required: ['content']
      },
      access: 'writesThreads',
      class: 'mutation',
      offered: () => false,
      handler: (args, ctx) => {
        const threadId = callerThreadOnly(args, ctx.caller)
        if (typeof args.content !== 'string' || !args.content.trim()) throw new Error('queue_enqueue requires content')
        if (args.mode !== undefined && args.mode !== 'agent' && args.mode !== 'plan') throw new Error('mode must be agent or plan')
        if (args.mode === 'agent' && ctx.caller.modeCeiling === 'plan')
          throw new McpToolError('mousse_ceiling_exceeded', 'A plan-ceiling caller can only queue plan turns.')
        const mode = (args.mode as 'agent' | 'plan' | undefined) ?? (ctx.caller.modeCeiling === 'plan' ? 'plan' : 'agent')
        if (!host.enqueue) throw new Error('This Mousse cannot queue messages.')
        // The queued turn never runs looser than the turn that queued it: a turn another thread's agent
        // narrowed cannot widen itself by queueing a message on its own thread.
        const permissionMode = host.permissionModeFor?.(ctx.caller.runId)
        return json({ item: host.enqueue(threadId, { content: args.content, mode }, { permissionMode: permissionMode ?? 'ask' }) })
      }
    },
    {
      name: 'thread_fork',
      description: 'Fork a thread into a new thread that starts after one of its finished runs (default: the latest completed, failed, interrupted or cancelled run). The fork gets the conversation up to that run and its own worktree seeded from that run\'s code checkpoint when its first message arrives.',
      inputSchema: {
        type: 'object',
        properties: {
          sourceThreadId: { type: 'string', description: 'Defaults to your thread; otherwise a thread of your lineage.' },
          atRunOrdinal: { type: 'integer', minimum: 1, description: 'The source run to fork after; the latest finished run when omitted.' },
          title: { type: 'string' },
          seedFrom: { type: 'string', enum: ['checkpoint', 'current_head'], description: 'When the fork point has no code checkpoint the fork is refused (fork_point_unavailable) unless this is current_head: start from the source\'s current code.' },
          clientRequestId: CLIENT_REQUEST_ID_SCHEMA
        }
      },
      access: 'startsThreads',
      threadArgChecked: 'the handler accepts the caller\'s own thread or its lineage as the source',
      class: 'mutation',
      offered: () => false,
      handler: async (args, ctx) => {
        const sourceThreadId = args.sourceThreadId === undefined ? ctx.caller.threadId : args.sourceThreadId
        if (typeof sourceThreadId !== 'string' || !sourceThreadId) throw new Error('sourceThreadId must be a non-empty string')
        if (sourceThreadId !== ctx.caller.threadId && !isRelated(engine, ctx.caller.threadId, sourceThreadId))
          throw new McpToolError('mousse_scope_denied', `Thread ${sourceThreadId} is not this thread or one of its lineage.`)
        const atRunOrdinal = args.atRunOrdinal === undefined ? 'latest_stable' : boundedInt(args.atRunOrdinal, 'atRunOrdinal', 1, Number.MAX_SAFE_INTEGER, 1)
        if (args.title !== undefined && typeof args.title !== 'string') throw new Error('title must be a string')
        if (args.seedFrom !== undefined && args.seedFrom !== 'checkpoint' && args.seedFrom !== 'current_head')
          throw new Error("seedFrom must be 'checkpoint' or 'current_head'")
        const forked = await engine.forkThread({
          sourceThreadId,
          // The fork keeps the limits of the agent that makes it (SPEC §15.1).
          accessLevel: ctx.caller.accessLevel,
          atRunOrdinal,
          title: args.title as string | undefined,
          seedFrom: args.seedFrom as 'checkpoint' | 'current_head' | undefined,
          clientRequestId: `thread_fork:${ctx.caller.runId}:${toolRequestId(args, ctx)}`
        })
        return json({ threadId: forked.threadId, transferId: forked.transferId })
      }
    },
    {
      name: 'thread_merge_back',
      description: 'From a fork, hand what it did since the fork point to the thread it was forked from. The parent receives a summary on its next turn; code is not merged (integrate it explicitly). Only when the fork\'s latest run completed.',
      inputSchema: {
        type: 'object',
        properties: {
          forkThreadId: { type: 'string', description: 'Your thread only (the fork).' },
          threadId: { type: 'string', description: 'Your thread only.' },
          clientRequestId: CLIENT_REQUEST_ID_SCHEMA
        }
      },
      // Hands work over to another thread; still the caller's own fork only (`callerThreadOnly`), and
      // it asks unless the run's permission mode allows edits.
      access: 'editsWorkspace',
      permissionKey: PERMISSION_KEYS.mousseMergeBack,
      threadArgChecked: "the handler accepts the caller's own fork only",
      class: 'mutation',
      offered: () => false,
      handler: async (args, ctx) => {
        const forkThreadId = callerThreadOnly({ threadId: args.forkThreadId ?? args.threadId }, ctx.caller)
        const merged = await engine.mergeBack({
          forkThreadId,
          clientRequestId: `thread_merge_back:${ctx.caller.runId}:${toolRequestId(args, ctx)}`
        })
        return json({ transferId: merged.transferId, parentThreadId: merged.parentThreadId })
      }
    }
  ]
}
