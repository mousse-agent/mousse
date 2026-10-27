import { PERMISSION_KEYS } from '../../../../shared/permissionKeys'
import { visibleThreads } from '../../../../shared/threadLineage'
import type { RunEngine } from '../../RunEngine'
import type { DelegationRecord, ThreadEvent } from '../../types'
import type { AppToolHost } from './host'
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
 * other prompts stay private). A caller that reaches the thread only through its access level
 * (`read`) gets no `run.result` either (a subagent's final text).
 * Inbox, effect (turn payloads carry prompts), tool and transfer events are left out.
 */
function lineageView(events: ThreadEvent[], callerThreadId: string, scope: ToolScope): ThreadEvent[] {
  const out: ThreadEvent[] = []
  for (const event of events) {
    if (event.type === 'run.result' && scope === 'read') continue
    if (lineageVisible(event.type)) out.push(event)
    else if (event.type === 'delegation.status') {
      const delegation = event.payload as DelegationRecord
      out.push(delegation.childThreadId === callerThreadId ? event : { ...event, payload: { ...delegation, result: null } })
    }
  }
  return out
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

/**
 * `thread_read`, `thread_list`, `thread_search`, the queue tools, `thread_fork` and
 * `thread_merge_back`: the run engine's own threads, offered over MCP only (the pi loop never had them).
 */
export function threadTools(host: AppToolHost, engine: RunEngine): MousseTool[] {
  const allowedProjectIds = (): string[] => host.agentAccess?.().projectIds ?? []
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
        const results = host.searchThreads(args.query, THREAD_SEARCH_MAX_LIMIT)
          .filter((hit) => manage || hit.matchType !== 'message')
          .filter((hit) => inProjects(projectIds, hit.projectId) || host.threadMeta?.(hit.threadId)?.createdByThreadId === ctx.caller.threadId)
          .slice(0, limit)
          .map(({ snippet, ...hit }) => (manage && snippet !== undefined ? { ...hit, snippet } : hit))
        return json({ results })
      }
    },
    {
      name: 'queue_list',
      description: 'List the messages queued on your thread (they run after the current turn).',
      inputSchema: { type: 'object', properties: { threadId: { type: 'string', description: 'Your thread only.' } } },
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
        return json({ item: host.enqueue(threadId, { content: args.content, mode }) })
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
