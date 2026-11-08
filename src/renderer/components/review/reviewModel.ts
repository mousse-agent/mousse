// Pure helpers for the Changes tab's turns and placeholders. No React imports, so tests can load it.
import { extractChatReferences } from '../../../shared/chatReferences'
import type { ReviewFileSide, ReviewFileStatus } from '../../../shared/review'
import type { ChatMessage } from '../../../shared/types'
import type { ThreadAction } from '../../../shared/threadActions'

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/**
 * What to show instead of an editor for one side of a file, or null when the side has text to show.
 * A missing side is explained by the file's status: only an added file lacks an original side and only
 * a deleted one lacks a modified side.
 */
export function placeholderFor(side: ReviewFileSide, status: ReviewFileStatus): string | null {
  if (side === null) {
    if (status === 'deleted') return 'File deleted'
    if (status === 'added' || status === 'untracked') return 'File added'
    return 'Not available'
  }
  if ('binary' in side) return 'Binary file'
  if ('tooLarge' in side) {
    return side.reason === 'lines' && side.lines !== undefined
      ? `Too large to show (${side.lines.toLocaleString('en-US')} lines)`
      : `Too large to show (${formatBytes(side.size)})`
  }
  return null
}

export function isPlaceholderSide(side: ReviewFileSide): boolean {
  return side !== null && ('binary' in side || 'tooLarge' in side)
}

export interface TurnChoice {
  turnId: string
  label: string
  /** The user's prompt words alone, for the header ("Last turn · add login errors"). */
  prompt: string
  /** 1-based position among the thread's turns that changed files, for "Turn 13 finished". */
  number: number
  /** When the turn ended (ms); null while it runs or when not recorded. */
  endedAt: number | null
  /** Files the turn changed, for "Last turn: 3 files". */
  files: number
  /** The turn was undone (or is being undone); its changes may no longer be in the working tree. */
  undone: boolean
  running: boolean
}

const UNDONE_STATES: ReadonlySet<ThreadAction['state']> = new Set(['undone', 'undoing', 'undo_conflict'])
const RUNNING_STATES: ReadonlySet<ThreadAction['state']> = new Set(['planned', 'running', 'checkpointing'])

function firstWords(text: string, maxWords = 6, maxChars = 40): string {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ''
  let out = words.slice(0, maxWords).join(' ')
  const cut = words.length > maxWords
  if (out.length > maxChars) return `${out.slice(0, maxChars).trimEnd()}…`
  if (cut) out += '…'
  return out
}

function timeLabel(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/**
 * The turns the picker offers, newest first. Conversation-only actions never touched files. A running
 * action still has empty `changedPaths` and `commits` until its checkpoint, so it is listed regardless.
 */
export function turnChoices(
  actions: readonly ThreadAction[],
  messages: ReadonlyArray<Pick<ChatMessage, 'role' | 'turnId' | 'content'>>
): TurnChoice[] {
  const prompts = new Map<string, string>()
  for (const message of messages) {
    if (message.role === 'user' && message.turnId && !prompts.has(message.turnId)) prompts.set(message.turnId, message.content)
  }
  const kept = actions.filter(
    (action) =>
      action.scope !== 'conversation' &&
      (RUNNING_STATES.has(action.state) || action.changedPaths.length > 0 || action.commits.length > 0)
  )
  const choices = kept.map((action, index) => {
    const running = RUNNING_STATES.has(action.state)
    const undone = UNDONE_STATES.has(action.state)
    const prompt = firstWords(extractChatReferences(prompts.get(action.turnId) ?? '').text) || `Turn ${index + 1}`
    const time = timeLabel(action.createdAt)
    const suffix = running ? ' (in progress)' : undone ? ' (undone)' : ''
    const endedAt = running || !action.completedAt ? null : Date.parse(action.completedAt) || null
    return { turnId: action.turnId, label: `${prompt}${time ? ` · ${time}` : ''}${suffix}`, prompt, number: index + 1, endedAt, files: action.changedPaths.length, undone, running, at: Date.parse(action.createdAt) || 0, index }
  })
  // Newest first; the original order breaks ties so equal timestamps keep their sequence.
  choices.sort((a, b) => b.at - a.at || b.index - a.index)
  return choices.map(({ turnId, label, prompt, number, endedAt, files, undone, running }) => ({ turnId, label, prompt, number, endedAt, files, undone, running }))
}
