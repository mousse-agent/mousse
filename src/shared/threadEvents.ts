import { THREAD_EVENT_KINDS, type ThreadEventKind } from './types'

/**
 * Thread-event automations in words, and the occurrence key their runs carry. Shared by the daemon (the run record and
 * the list) and the page (the create row, the row and the detail).
 */

/** At most one run per this long per automation, from pull request events. */
export const THREAD_EVENT_MIN_GAP_MS = 10 * 60_000

const PREFIX = 'event:'

/** The occurrence key of a run pull request events started: when they came and what they were. */
export function threadEventOccurrenceKey(firstAt: string, kinds: readonly ThreadEventKind[]): string {
  return `${PREFIX}${firstAt}=${kinds.join('+')}`
}

/** The events an occurrence key names, or undefined for a run something else started. */
export function threadEventsOfOccurrence(occurrenceKey: string | undefined): ThreadEventKind[] | undefined {
  if (!occurrenceKey?.startsWith(PREFIX)) return undefined
  const kinds = occurrenceKey.slice(occurrenceKey.indexOf('=') + 1).split('+')
  return THREAD_EVENT_KINDS.filter((kind) => kinds.includes(kind))
}

const PHRASE: Record<ThreadEventKind, string> = {
  checks_failed: 'checks fail',
  checks_passed: 'checks pass',
  review: 'gets a review',
  comment: 'gets a comment'
}

const NOUN: Record<ThreadEventKind, string> = {
  checks_failed: 'checks failed',
  checks_passed: 'checks passed',
  review: 'review',
  comment: 'comment'
}

/** The events in a short line: "checks failed, review". */
export function eventNouns(kinds: readonly ThreadEventKind[]): string {
  return THREAD_EVENT_KINDS.filter((kind) => kinds.includes(kind)).map((kind) => NOUN[kind]).join(', ')
}

/** "#712 gets a review", "#712 checks fail", "#712 gets activity" (all four), "#712: review, comment". */
export function threadEventText(number: number, kinds: readonly ThreadEventKind[]): string {
  const chosen = THREAD_EVENT_KINDS.filter((kind) => kinds.includes(kind))
  if (chosen.length === THREAD_EVENT_KINDS.length) return `#${number} gets activity`
  if (chosen.length === 1) return `#${number} ${PHRASE[chosen[0]!]}`
  return `#${number}: ${eventNouns(chosen)}`
}

/** The choices the page offers for what wakes it, with the events each stands for. */
export const THREAD_EVENT_CHOICES: ReadonlyArray<{ value: string; label: string; events: ThreadEventKind[] }> = [
  { value: 'review', label: 'Gets a review', events: ['review'] },
  { value: 'comment', label: 'Gets a comment', events: ['comment'] },
  { value: 'checks_failed', label: 'Checks fail', events: ['checks_failed'] },
  { value: 'checks_passed', label: 'Checks pass', events: ['checks_passed'] },
  { value: 'any', label: 'Any of these', events: [...THREAD_EVENT_KINDS] }
]

/** The choice that stands for a set of events ('' when none does). */
export function threadEventChoice(kinds: readonly ThreadEventKind[]): string {
  const key = [...kinds].sort().join(',')
  return THREAD_EVENT_CHOICES.find((choice) => [...choice.events].sort().join(',') === key)?.value ?? ''
}
