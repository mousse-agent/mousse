import {
  ACTIVITY_DESCRIPTION_CHARS,
  ACTIVITY_DIFF_CAP_BYTES,
  INTERRUPTED_SUMMARY,
  byteLength,
  capHead,
  capRecord,
  diffLineCounts,
  hasHunkHeader,
  type ActivityFileChange,
  type ActivityInterruptedBy,
  type ActivityPatch,
  type ProviderToolEvent
} from '../../../../shared/agentActivity'
import { recordSubagentCall, toolResultText } from '../../../../shared/subagentTools'
import type { ThreadItem } from './protocol'

/**
 * What Codex's thread items say about the work, as typed activity fields. `codexToolEvent` reads one
 * item (the same item arrives on `item/started` and `item/completed`, so the kind never depends on
 * what an earlier event said); `helperNote` reads what an item says about a native helper's life.
 * Every reader is optional: a field this Codex version does not send leaves the call a plain row.
 */

const TITLE_CHARS = 200
/** Files of one patch a row lists; the rest are counted in the row's summary. */
const MAX_FILES = 200
/** Diff text one patch keeps in all, across its files (each file is also held to `ACTIVITY_DIFF_CAP_BYTES`). */
const MAX_PATCH_BYTES = 4 * ACTIVITY_DIFF_CAP_BYTES
const MAX_PLAN_STEPS = 50
const STEP_CHARS = 300
const MAX_SEARCH_RESULTS = 10

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function clip(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, chars - 1)}…` : text
}

/** Lines of a text, not counting the empty one after a final newline. */
function textLines(text: string): number {
  if (!text) return 0
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.length
}

/** What the provider said about how the call ended. Its exit code is shown but never decides this. */
function outcome(status: unknown, failed = false): Pick<ActivityPatch, 'status' | 'summary'> {
  if (status === 'declined') return { status: 'failed', summary: 'Declined' }
  return { status: failed || status === 'failed' ? 'failed' : 'done' }
}

// ---------------------------------------------------------------------------------------------
// Patches
// ---------------------------------------------------------------------------------------------

/**
 * Lines a change added and removed. An added or deleted file's diff is its text as it is (no hunks),
 * every other diff is a unified one.
 */
function changeCounts(kind: string | undefined, diff: string): { added: number; removed: number } {
  if (kind === 'add' && !hasHunkHeader(diff)) return { added: textLines(diff), removed: 0 }
  if (kind === 'delete' && !hasHunkHeader(diff)) return { added: 0, removed: textLines(diff) }
  return diffLineCounts(diff)
}

function patchChanges(item: Record<string, unknown>): Array<{ path: string; kind: string | undefined; movePath: string | undefined; diff: string }> {
  if (!Array.isArray(item.changes)) return []
  return item.changes.flatMap((entry) => {
    const change = record(entry)
    if (!change) return []
    const kind = record(change.kind)
    return [
      {
        path: str(change.path) ?? '(unknown file)',
        kind: str(kind?.type),
        movePath: str(kind?.move_path),
        diff: typeof change.diff === 'string' ? change.diff : ''
      }
    ]
  })
}

/** Lines a completed patch added or removed, over every file it changed. */
export function editedLines(item: ThreadItem): number {
  let lines = 0
  for (const change of patchChanges(item as unknown as Record<string, unknown>)) {
    const counts = changeCounts(change.kind, change.diff)
    lines += counts.added + counts.removed
  }
  return lines
}

/** One entry per file with its own diff and counts; the diff text is bounded per file and per patch. */
function fileChanges(item: Record<string, unknown>): { changes: ActivityFileChange[]; omitted: number } {
  const all = patchChanges(item)
  let budget = MAX_PATCH_BYTES
  const changes = all.slice(0, MAX_FILES).map((change): ActivityFileChange => {
    const counts = changeCounts(change.kind, change.diff)
    const kind: ActivityFileChange['change'] =
      change.kind === 'add' ? 'add' : change.kind === 'delete' ? 'delete' : change.movePath ? 'move' : 'update'
    const shown = change.diff ? capHead(change.diff, Math.max(0, Math.min(ACTIVITY_DIFF_CAP_BYTES, budget))) : undefined
    if (shown) budget -= byteLength(shown.text)
    return {
      path: change.path,
      change: kind,
      ...(change.movePath ? { movePath: change.movePath } : {}),
      ...(shown?.text ? { diff: shown.text } : {}),
      ...(shown && (shown.truncated || (!shown.text && change.diff)) ? { diffTruncated: true } : {}),
      added: counts.added,
      removed: counts.removed
    }
  })
  return { changes, omitted: Math.max(0, all.length - changes.length) }
}

/** `Edit a.ts, b.ts and 7 more`: a few paths and a count, never every file of a large patch. */
function patchTitle(paths: string[]): string {
  if (!paths.length) return 'Edit files'
  const shown = paths.slice(0, 3).join(', ')
  return clip(`Edit ${shown}${paths.length > 3 ? ` and ${paths.length - 3} more` : ''}`, TITLE_CHARS)
}

// ---------------------------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------------------------

function searchQuery(item: Record<string, unknown>): string {
  const action = record(item.action)
  const queries = Array.isArray(action?.queries) ? action.queries.filter((query): query is string => typeof query === 'string' && query.length > 0) : []
  return str(item.query) ?? str(action?.query) ?? (queries.length ? queries.join(' ') : undefined) ?? str(action?.url) ?? ''
}

function searchResults(item: Record<string, unknown>): Array<{ title: string; url: string }> {
  if (!Array.isArray(item.results)) return []
  return item.results.slice(0, MAX_SEARCH_RESULTS).flatMap((entry) => {
    const result = record(entry)
    const url = str(result?.url)
    return url ? [{ title: clip(str(result?.title) ?? url, 200), url: clip(url, 500) }] : []
  })
}

/** The text of a dynamic tool's `inputText` content items. */
function contentText(items: unknown): string | undefined {
  if (!Array.isArray(items)) return undefined
  const text = items
    .map((entry) => {
      const part = record(entry)
      return part?.type === 'inputText' && typeof part.text === 'string' ? part.text : ''
    })
    .join('')
  return text || undefined
}

/**
 * The tool event of a thread item, or undefined for an item that is not a tool call (messages,
 * reasoning, a helper's own bookkeeping). `start` carries what the call is; `complete` what came of
 * it, so a call's kind never depends on arguments that were cut to fit.
 */
export function codexToolEvent(item: ThreadItem, phase: 'start' | 'complete'): ProviderToolEvent | undefined {
  const raw = item as unknown as Record<string, unknown>
  const callId = item.id
  switch (item.type) {
    case 'commandExecution': {
      const command = str(raw.command) ?? 'command'
      const cwd = str(raw.cwd)
      const processId = str(raw.processId)
      const output = str(raw.aggregatedOutput)
      const activity: ActivityPatch =
        phase === 'start'
          ? { kind: 'command', command, ...(cwd ? { cwd } : {}), ...(processId ? { nativeId: processId } : {}) }
          : ({
              kind: 'command',
              ...(cwd ? { cwd } : {}),
              ...(processId ? { nativeId: processId } : {}),
              // The whole output replaces what was streamed, so nothing is counted twice.
              ...(output ? { output } : {}),
              ...(typeof raw.exitCode === 'number' || raw.exitCode === null ? { exitCode: raw.exitCode } : {}),
              ...(typeof raw.durationMs === 'number' ? { durationMs: raw.durationMs } : {}),
              ...outcome(raw.status)
            } as ActivityPatch)
      return { phase, callId, title: clip(command, TITLE_CHARS), toolName: 'shell', activity }
    }
    case 'fileChange': {
      const { changes, omitted } = fileChanges(raw)
      const paths = patchChanges(raw).map((change) => change.path)
      return {
        phase,
        callId,
        title: patchTitle(paths),
        toolName: 'apply_patch',
        activity: {
          kind: 'file_change',
          changes,
          ...(omitted ? { summary: `${omitted} more file${omitted === 1 ? '' : 's'} not listed` } : {}),
          ...(phase === 'complete' ? outcome(raw.status) : {})
        } as ActivityPatch
      }
    }
    case 'mcpToolCall': {
      const server = str(raw.server) ?? 'mcp'
      const tool = str(raw.tool) ?? 'tool'
      const toolName = `mcp__${server}__${tool}`
      const result = record(raw.result)
      const error = record(raw.error)
      const failed = raw.status === 'failed' || Boolean(error)
      const resultText = toolResultText(result?.content) ?? (result?.structuredContent ? JSON.stringify(result.structuredContent) : undefined)
      // Mousse's subagent tools keep a bounded record of the call, so the app can tell which task a row is.
      const kept = recordSubagentCall(toolName, raw.arguments, phase === 'start' ? {} : { text: resultText, isError: failed })
      const title = `${server}.${tool}`
      if (kept) return { phase, callId, title, toolName, record: kept }
      const input = capRecord(record(raw.arguments))
      const activity: ActivityPatch =
        phase === 'start'
          ? { kind: 'generic', server, ...(input ? { input } : {}) }
          : ({ kind: 'generic', server, ...((resultText ?? str(error?.message)) ? { output: resultText ?? str(error?.message) } : {}), ...outcome(raw.status, failed) } as ActivityPatch)
      return { phase, callId, title, toolName, activity }
    }
    case 'dynamicToolCall': {
      const tool = str(raw.tool) ?? 'tool'
      const input = capRecord(record(raw.arguments))
      const output = contentText(raw.contentItems)
      return {
        phase,
        callId,
        title: tool,
        toolName: tool,
        activity:
          phase === 'start'
            ? { kind: 'generic', ...(input ? { input } : {}) }
            : ({ kind: 'generic', ...(output ? { output } : {}), ...outcome(raw.status, raw.success === false) } as ActivityPatch)
      }
    }
    case 'webSearch': {
      const query = searchQuery(raw)
      const results = searchResults(raw)
      return {
        phase,
        callId,
        title: 'Web search',
        toolName: 'web_search',
        activity: {
          kind: 'web_search',
          query: clip(query, 500),
          ...(results.length ? { results } : {}),
          ...(phase === 'complete' ? outcome(raw.status) : {})
        } as ActivityPatch
      }
    }
    case 'imageView': {
      const path = str(raw.path)
      return {
        phase,
        callId,
        title: 'View image',
        toolName: 'view_image',
        activity: phase === 'start' ? { kind: 'generic', ...(path ? { input: { path } } : {}) } : { kind: 'generic', ...outcome(raw.status) }
      }
    }
    case 'plan': {
      const text = str(raw.text)
      return {
        phase,
        callId,
        title: 'Plan',
        toolName: 'plan',
        activity: { kind: 'plan', ...(text ? { text } : {}), ...(phase === 'complete' ? { status: 'done' } : {}) } as ActivityPatch
      }
    }
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------------------------
// The turn's plan
// ---------------------------------------------------------------------------------------------

/** The steps of a `turn/plan/updated`, bounded. */
export function planSteps(plan: unknown): Array<{ step: string; status: string }> {
  if (!Array.isArray(plan)) return []
  return plan.slice(0, MAX_PLAN_STEPS).flatMap((entry) => {
    const step = record(entry)
    const text = str(step?.step)
    return text ? [{ step: clip(text, STEP_CHARS), status: str(step?.status) ?? 'pending' }] : []
  })
}

export function planStart(callId: string, steps: Array<{ step: string; status: string }>): ProviderToolEvent {
  return { phase: 'start', callId, title: 'Plan', toolName: 'update_plan', activity: { kind: 'plan', steps } }
}

export function planUpdate(callId: string, steps: Array<{ step: string; status: string }>): ProviderToolEvent {
  return { phase: 'update', callId, title: 'Plan', toolName: 'update_plan', activity: { kind: 'plan', steps } }
}

// ---------------------------------------------------------------------------------------------
// Native helpers
// ---------------------------------------------------------------------------------------------

export type HelperEnd = 'done' | 'failed' | 'interrupted'

/** What a parent-thread item says about its native helpers. */
export interface HelperNote {
  /** Threads the item says were started, or sent more work. */
  launched: Array<{ threadId: string; description?: string; agentType?: string; /** More work for a helper, not a new one. */ reuse?: boolean }>
  /** Threads the item says ended, and how. */
  ended: Array<{ threadId: string; outcome: HelperEnd }>
}

/** What a helper's `agentsStates` entry says once it is no longer running. */
function endOfState(status: unknown): HelperEnd | undefined {
  switch (status) {
    case 'completed':
    case 'shutdown':
      return 'done'
    case 'errored':
    case 'notFound':
      return 'failed'
    case 'interrupted':
      return 'interrupted'
    default:
      return undefined
  }
}

/**
 * The helpers an item names. A spawn (`collabAgentToolCall` `spawnAgent`, `subAgentActivity` `started`)
 * only says a helper was launched: it ends on its own report (`subAgentActivity` `completed` or
 * `interrupted`, or a terminal `agentsStates` entry), never with the item that launched it.
 */
export function helperNote(item: ThreadItem): HelperNote | undefined {
  const raw = item as unknown as Record<string, unknown>
  if (item.type === 'subAgentActivity') {
    const threadId = str(raw.agentThreadId)
    if (!threadId) return undefined
    if (raw.kind === 'completed') return { launched: [], ended: [{ threadId, outcome: 'done' }] }
    if (raw.kind === 'interrupted') return { launched: [], ended: [{ threadId, outcome: 'interrupted' }] }
    const agentType = str(raw.model)
    return { launched: [{ threadId, ...(agentType ? { agentType } : {}), ...(raw.kind === 'interacted' ? { reuse: true } : {}) }], ended: [] }
  }
  if (item.type !== 'collabAgentToolCall') return undefined
  const launched: HelperNote['launched'] = []
  if (raw.tool === 'spawnAgent' && Array.isArray(raw.receiverThreadIds)) {
    const prompt = str(raw.prompt)
    const description = prompt ? clip(prompt.replace(/\s+/g, ' ').trim(), ACTIVITY_DESCRIPTION_CHARS) : undefined
    const agentType = str(raw.model)
    for (const threadId of raw.receiverThreadIds)
      if (typeof threadId === 'string' && threadId) launched.push({ threadId, ...(description ? { description } : {}), ...(agentType ? { agentType } : {}) })
  }
  const ended: HelperNote['ended'] = []
  for (const [threadId, state] of Object.entries(record(raw.agentsStates) ?? {})) {
    const end = endOfState(record(state)?.status)
    if (end) ended.push({ threadId, outcome: end })
  }
  return launched.length || ended.length ? { launched, ended } : undefined
}

/** A helper's row opens: one `subagent` item per helper thread (and per episode of work it is sent). */
export function helperStart(callId: string, threadId: string, details: { description?: string; agentType?: string; summary?: string }): ProviderToolEvent {
  return {
    phase: 'start',
    callId,
    title: 'Subagent',
    toolName: 'Agent',
    activity: {
      kind: 'subagent',
      nativeId: threadId,
      ...(details.description ? { description: details.description } : {}),
      ...(details.agentType ? { agentType: details.agentType } : {}),
      ...(details.summary ? { summary: details.summary } : {})
    }
  }
}

/** The completion that ends a helper's row. */
export function helperEnd(callId: string, how: HelperEnd): ProviderToolEvent {
  return { phase: 'complete', callId, title: 'Subagent', toolName: 'Agent', activity: closing(how === 'interrupted' ? 'stop' : how) }
}

// ---------------------------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------------------------

/** How a call ends when Codex never reported its result: never as done, unless it has nothing to report. */
function closing(how: ActivityInterruptedBy | 'done' | 'failed'): ActivityPatch {
  if (how === 'done' || how === 'failed') return { status: how }
  return { status: 'interrupted', interruptedBy: how, summary: INTERRUPTED_SUMMARY[how] }
}

/** The completion for a call still open when the turn ended. */
export function closeEvent(call: { callId: string; title: string; toolName?: string }, how: ActivityInterruptedBy | 'done'): ProviderToolEvent {
  return {
    phase: 'complete',
    callId: call.callId,
    title: call.title,
    ...(call.toolName ? { toolName: call.toolName } : {}),
    activity: closing(how)
  }
}
