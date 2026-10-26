import type { RunEngine } from '../../RunEngine'
import type { DelegationRecord, ThreadEvent } from '../../types'
import type { AppToolHost } from './host'
import {
  CLIENT_REQUEST_ID_SCHEMA,
  json,
  McpToolError,
  type McpCaller,
  type MousseTool,
  type ToolCallContext
} from './types'

const THREAD_READ_DEFAULT_LIMIT = 200
const THREAD_READ_MAX_LIMIT = 500
/** Lineage walks stop here; deeper chains are treated as unrelated. */
const LINEAGE_MAX_DEPTH = 64

/** `threadId` (when given) must be the caller's thread. Returns the caller's thread. */
export function callerThreadOnly(args: Record<string, unknown>, caller: McpCaller): string {
  const target = args.threadId
  if (target !== undefined && target !== caller.threadId)
    throw new McpToolError('mousse_scope_denied', `This credential acts for thread ${caller.threadId} only.`)
  return caller.threadId
}

/** Event types a lineage thread may read of another thread (M7): run lifecycle and lineage only. */
function lineageVisible(type: string): boolean {
  return type.startsWith('run.') || type.startsWith('attempt.') || type === 'command.ignored' || type === 'restart.note' || type === 'thread.lineage'
}

/**
 * Another thread's events as a lineage relative sees them (M7): run and attempt lifecycle,
 * ignored commands, restart notes and the lineage row; plus `delegation.status` rows whose result is shown only to
 * the delegation's own child (a sibling's result and the parent's other prompts stay private).
 * Inbox, effect (turn payloads carry prompts), tool and transfer events are left out.
 */
function lineageView(events: ThreadEvent[], callerThreadId: string): ThreadEvent[] {
  const out: ThreadEvent[] = []
  for (const event of events) {
    if (lineageVisible(event.type)) out.push(event)
    else if (event.type === 'delegation.status') {
      const delegation = event.payload as DelegationRecord
      out.push(delegation.childThreadId === callerThreadId ? event : { ...event, payload: { ...delegation, result: null } })
    }
  }
  return out
}

function isRelated(engine: RunEngine, callerThreadId: string, targetThreadId: string): boolean {
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
  return ancestors(callerThreadId).includes(targetThreadId) || ancestors(targetThreadId).includes(callerThreadId)
}

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
 * `thread_read`, the queue tools, `thread_fork` and `thread_merge_back`: the run engine's own
 * threads, offered over MCP only (the pi loop never had them).
 */
export function threadTools(host: AppToolHost, engine: RunEngine): MousseTool[] {
  return [
    {
      name: 'thread_read',
      description: 'Read run events (runs, attempts, delegations, tool calls) of your thread, or of a thread you delegated to or were delegated from. Page with afterSeq.',
      inputSchema: {
        type: 'object',
        properties: {
          threadId: { type: 'string', description: 'Defaults to your thread.' },
          afterSeq: { type: 'integer', minimum: 0, description: 'Return events after this sequence number.' },
          limit: { type: 'integer', minimum: 1, maximum: THREAD_READ_MAX_LIMIT }
        }
      },
      access: 'reads',
      class: 'read',
      offered: () => false,
      handler: (args, ctx) => {
        const threadId = args.threadId === undefined ? ctx.caller.threadId : args.threadId
        if (typeof threadId !== 'string' || !threadId) throw new Error('threadId must be a non-empty string')
        if (threadId !== ctx.caller.threadId && !isRelated(engine, ctx.caller.threadId, threadId))
          throw new McpToolError('mousse_scope_denied', `Thread ${threadId} is not this thread or one of its lineage.`)
        const afterSeq = boundedInt(args.afterSeq, 'afterSeq', 0, Number.MAX_SAFE_INTEGER, 0)
        const limit = boundedInt(args.limit, 'limit', 1, THREAD_READ_MAX_LIMIT, THREAD_READ_DEFAULT_LIMIT)
        const page = engine.listEvents(threadId, { afterSeq, limit })
        const events = threadId === ctx.caller.threadId ? page : lineageView(page, ctx.caller.threadId)
        // `nextAfterSeq` pages on even when a lineage view filtered events out of this page.
        return json({ threadId, events, maxSeq: engine.maxSeq(threadId), nextAfterSeq: page.at(-1)?.seq ?? afterSeq })
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
      access: 'writesThreads',
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
