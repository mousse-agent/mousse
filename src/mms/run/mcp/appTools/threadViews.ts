import type { ModelOverride } from '../../../../shared/providerInstances'
import type { ThreadPullRequestLink } from '../../../../shared/pullRequests'
import { cutEnd } from './messageRows'

/**
 * The two short views of `thread_read`, between the run events and the paged transcript: `summary` (what the thread is,
 * no content) and `recent` (its last turns, trimmed). Built from message rows, so a thread here and one on another
 * computer read the same.
 */

/** `recent`: how many turns by default, and at most. */
export const RECENT_TURNS_DEFAULT = 3
export const RECENT_TURNS_MAX = 10
/** `recent`: how much of a turn's prompt and of its final answer, and of each step line before it. */
export const RECENT_PROMPT_CHARS = 1_000
export const RECENT_ANSWER_CHARS = 3_000
export const RECENT_STEP_CHARS = 160
/** `recent`: the step lines a turn keeps, the newest ones; the rest are counted. */
export const RECENT_STEPS_MAX = 8
/**
 * `recent` on another computer: the newest messages read there to find the turns in, each read only as far as a step
 * line, so they fit one page there; the prompts and answers of the turns found are then read on their own.
 */
export const RECENT_REMOTE_MESSAGES = 120
/** `recent` on another computer: how far back from the newest message a turn's prompt is looked for. */
export const RECENT_REMOTE_LOOKBACK = 600

/** A transcript row as both views read it: from the thread's messages here, or a row read on another computer. */
export interface ViewRow {
  index: number
  role: string
  text: string
  timestamp?: unknown
  /** The whole message's length, when `text` is already cut (a row read on another computer). */
  totalChars?: number
}

export interface RecentTurn {
  /** The message that opened the turn: what was asked. Absent for a thread whose first messages are not a prompt. */
  prompt?: { index: number; at?: unknown; text: string; cut?: true }
  /** One line for each message the agent wrote before its last one in the turn (its progress notes), the newest kept. */
  steps?: string[]
  /** Step lines left out (older than the ones kept). */
  stepsLeftOut?: number
  /** The agent's last message in the turn. */
  answer?: { index: number; at?: unknown; text: string; cut?: true; totalChars?: number }
}

function cut(text: string, max: number, totalChars = text.length): { text: string; cut?: true; totalChars?: number } {
  if (text.length <= max && totalChars <= text.length) return { text }
  const end = cutEnd(text, Math.min(max, text.length))
  return { text: `${text.slice(0, end)}…`, cut: true, totalChars: Math.max(totalChars, text.length) }
}

/** `text` on one line of at most `max` characters; `cutBefore` when the text was already cut where it was read. */
function oneLine(text: string, max: number, cutBefore = false): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (line.length <= max) return cutBefore ? `${line}…` : line
  return `${line.slice(0, cutEnd(line, max - 1))}…`
}

/**
 * The last `turns` turns of `rows` (in order): a turn opens at each user message and runs to the next. Each keeps its
 * prompt and final answer, cut, and one line for each message between. `firstIndex` is where the turns start, so the
 * reader can page the full messages from there.
 */
export function recentTurns(rows: readonly ViewRow[], turns: number): { turns: RecentTurn[]; firstIndex: number } {
  const starts: number[] = []
  rows.forEach((row, at) => { if (row.role === 'user') starts.push(at) })
  // A thread with no prompt in these rows (its turns started elsewhere) reads as one turn of what it has.
  const picked = starts.length ? starts.slice(-turns) : rows.length ? [0] : []
  const out: RecentTurn[] = picked.map((start, n) => {
    const end = n + 1 < picked.length ? picked[n + 1]! : rows.length
    const span = rows.slice(start, end)
    const opener = span[0]?.role === 'user' ? span[0] : undefined
    const replies = span.filter((row) => row !== opener && row.text.trim())
    const last = [...replies].reverse().find((row) => row.role === 'assistant')
    const steps = replies.filter((row) => row !== last).map((row) => `${row.role === 'assistant' ? '' : `(${row.role}) `}${oneLine(row.text, RECENT_STEP_CHARS, (row.totalChars ?? 0) > row.text.length)}`)
    const kept = steps.slice(-RECENT_STEPS_MAX)
    const turn: RecentTurn = {}
    if (opener) turn.prompt = { index: opener.index, at: opener.timestamp, ...pick(cut(opener.text, RECENT_PROMPT_CHARS, opener.totalChars), false) }
    if (kept.length) turn.steps = kept
    if (steps.length > kept.length) turn.stepsLeftOut = steps.length - kept.length
    if (last) turn.answer = { index: last.index, at: last.timestamp, ...pick(cut(last.text, RECENT_ANSWER_CHARS, last.totalChars), true) }
    return turn
  })
  return { turns: out, firstIndex: picked.length ? rows[picked[0]!]!.index : rows.length ? rows[0]!.index : 0 }
}

function pick(value: { text: string; cut?: true; totalChars?: number }, withTotal: boolean): { text: string; cut?: true; totalChars?: number } {
  return { text: value.text, ...(value.cut ? { cut: true as const } : {}), ...(value.cut && withTotal && value.totalChars ? { totalChars: value.totalChars } : {}) }
}

/** The model a thread runs on, as a reader names it; null when it follows the profile's default. */
export function modelOf(override: ModelOverride | undefined | null): { model: string; name?: string; agent?: string; effort?: string } | null {
  if (!override?.model) return null
  return {
    model: override.model,
    ...(override.name ? { name: override.name } : {}),
    ...(override.instanceId || override.llmProvider ? { agent: override.instanceId ?? override.llmProvider } : {}),
    ...(override.effort ? { effort: override.effort } : {})
  }
}

/** The pull request a thread is linked to, as a reader needs it. */
export function pullRequestOf(link: Pick<ThreadPullRequestLink, 'number' | 'url' | 'nameWithOwner' | 'headRefName'> | undefined | null): { number: number; url: string; repository?: string; branch?: string } | null {
  if (!link || typeof link.number !== 'number' || typeof link.url !== 'string') return null
  return { number: link.number, url: link.url, ...(link.nameWithOwner ? { repository: link.nameWithOwner } : {}), ...(link.headRefName ? { branch: link.headRefName } : {}) }
}

/** When the thread's last turn that finished completed, from its runs (newest first, as the run store lists them). */
export function lastCompletedAt(runs: ReadonlyArray<{ status?: unknown; completedAt?: unknown }>): string | null {
  const done = runs.find((run) => run.status === 'completed' && typeof run.completedAt === 'string')
  return done ? (done.completedAt as string) : null
}

/** What `summary` tells the reader to do next. */
export const SUMMARY_NEXT = 'Read its last turns with view "recent", and the full transcript with view "messages" (paged) only as far as you need.'
