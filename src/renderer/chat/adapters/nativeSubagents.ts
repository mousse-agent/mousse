import type { UIMessage } from 'ai'
import { BACKGROUND_SUMMARY } from '../../../shared/agentActivity'
import type { BackgroundTaskNoticeItem, SubagentState } from '../../../shared/subagents'
import type { ChatMessage } from '../../../shared/types'
import type { SubagentCardModel } from './subagentCards'

/**
 * Subagents a runtime started with its own tool (Claude Code's `Agent`/`Task`), not with Mousse's
 * `delegate_task`. They have no thread of their own: their card stands where the call was made and
 * holds the calls the subagent made. A background agent's row is closed when its turn settles ("in the
 * background") and gets its outcome when the agent reports its end; until then it is working while the
 * thread still has background work.
 */

/** What a native subagent card knows beyond a Mousse card's fields. */
export interface NativeSubagentInfo {
  /** The kind of agent the runtime ran ("Explore", "general-purpose"), when it said. */
  agentType: string | null
  /** The runtime's task id, which a continuation's notice names. */
  taskId: string | null
  /** What the agent reported when it ended, clipped by the daemon. */
  result: string | null
}

type Part = { type?: unknown; toolCallId?: unknown; state?: unknown; input?: unknown; output?: unknown }

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim() : null
}

function timeOf(value: unknown): number | null {
  if (!value) return null
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value))
  return Number.isFinite(ms) ? ms : null
}

/** A runtime's own subagent call: `tool-Agent` or `tool-Task` at the top of the transcript, not one a subagent made. */
export function isNativeSubagentPart(part: unknown): part is Part & { toolCallId: string } {
  const value = part as Part | undefined
  return (
    (value?.type === 'tool-Agent' || value?.type === 'tool-Task') &&
    typeof value.toolCallId === 'string' &&
    // Work a subagent started is nested under its root as `<root>:<call>`.
    !value.toolCallId.includes(':')
  )
}

/**
 * The state of a native subagent from its row. `backgroundLive`: the thread still has background work (or
 * a turn running), so a row its turn closed as running in the background is still going.
 */
export function nativeSubagentState(part: Pick<Part, 'state' | 'output'>, backgroundLive: boolean): SubagentState {
  if (part.state === 'output-error') return 'failed'
  if (part.state !== 'output-available') return 'working'
  const output = record(part.output)
  if (output?.interrupted === true) return output.summary === 'Stopped' ? 'stopped' : 'interrupted'
  if (output?.summary === BACKGROUND_SUMMARY) return backgroundLive ? 'working' : 'done'
  return 'done'
}

/** The card of a native subagent call. */
export function nativeSubagentModel(part: Part & { toolCallId: string }, createdAt: unknown, backgroundLive: boolean): SubagentCardModel {
  const input = record(part.input) ?? {}
  const output = record(part.output)
  const state = nativeSubagentState(part, backgroundLive)
  const agentType = text(input.subagent_type)
  const startedAt = timeOf(output?.startedAt) ?? timeOf(createdAt)
  const duration = typeof output?.totalDurationMs === 'number' && Number.isFinite(output.totalDurationMs) ? output.totalDurationMs : null
  // A background row's end is when its turn settled, not when the agent finished: only its reported duration counts.
  const background = input.run_in_background === true
  const ended = duration !== null && startedAt !== null ? startedAt + duration : background ? null : timeOf(output?.endedAt)
  const summary = text(output?.summary)
  const reported = summary && summary !== BACKGROUND_SUMMARY ? summary : null
  return {
    toolCallId: part.toolCallId,
    pending: false,
    childThreadId: null,
    delegationId: null,
    title: text(input.description) ?? agentType ?? 'Subagent',
    state,
    provider: null,
    model: null,
    continued: false,
    latest: true,
    waitingOn: [],
    exact: true,
    createdAt: startedAt,
    completedAt: state === 'working' ? null : ended,
    ...(state === 'failed' && reported ? { error: reported } : {}),
    native: { agentType, taskId: text(input.task_id), result: state === 'done' ? reported : null }
  }
}

/** The native subagent cards of a transcript, by the call that started each. */
export function collectNativeSubagentCards(messages: readonly UIMessage[], backgroundLive: boolean): Map<string, SubagentCardModel> {
  const cards = new Map<string, SubagentCardModel>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const part of message.parts ?? []) {
      if (!isNativeSubagentPart(part)) continue
      cards.set(part.toolCallId, nativeSubagentModel(part, (message as { createdAt?: unknown }).createdAt, backgroundLive))
    }
  }
  return cards
}

/**
 * The background tasks a message reports, read from the structured payload the daemon put on the message
 * that opens a turn the provider started itself. The text, which the model reads, is never parsed.
 */
export function readBackgroundNotice(message: Pick<UIMessage, 'metadata'> | undefined): BackgroundTaskNoticeItem[] | null {
  const raw = (message?.metadata as { backgroundNotice?: unknown } | undefined)?.backgroundNotice
  if (!Array.isArray(raw)) return null
  const items = raw.filter((item): item is BackgroundTaskNoticeItem => Boolean(item) && typeof (item as { taskId?: unknown }).taskId === 'string')
  return items.length > 0 ? items : null
}

/** One line for a background task the notice reports: its name, or what it was. */
export function backgroundNoticeName(item: BackgroundTaskNoticeItem): string {
  return item.description?.replace(/\s+/g, ' ').trim() || 'Background task'
}

type SavedMessage = Pick<ChatMessage, 'id' | 'role' | 'hidden' | 'timestamp' | 'activity'>

/**
 * The native subagents a thread's saved messages started, in order, as card models (the call's message id
 * is the card's). Only calls at the top of the conversation: a subagent's own subagent stays under it.
 */
export function nativeSubagentsOfMessages(messages: readonly SavedMessage[], backgroundLive: boolean): SubagentCardModel[] {
  const out: SubagentCardModel[] = []
  for (const message of messages) {
    const activity = message.activity
    if (message.hidden || activity?.kind !== 'subagent' || activity.parentId) continue
    const part = {
      toolCallId: message.id,
      state: activity.status === 'failed' ? 'output-error' : activity.status === 'running' ? 'input-available' : 'output-available',
      input: {
        subagent_type: activity.agentType,
        description: activity.description,
        run_in_background: activity.background === true,
        task_id: activity.nativeId
      },
      output:
        activity.status === 'running'
          ? undefined
          : {
              interrupted: activity.status === 'interrupted',
              summary: activity.summary,
              totalDurationMs: activity.durationMs,
              startedAt: activity.startedAt,
              endedAt: activity.endedAt
            }
    }
    out.push(nativeSubagentModel(part, message.timestamp, backgroundLive))
  }
  return out
}
