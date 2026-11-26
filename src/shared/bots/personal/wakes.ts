import { notice, quoted, type NoticePart } from '../../mousseContext'

/**
 * A bot's wakes: follow-ups it sets for itself in its own chat ("at 14:30", "in 20 minutes", "when that thread finishes",
 * "when PR #12 merges"). A wake is the third kind of bot reminder (`bot_reminders`, v9): where a reminder says a line or
 * starts work, a wake starts a chat turn of the bot's own, which no person started. One that waits on an event ends by a
 * time: if the event never comes (the pull request is closed, the thread is archived or deleted, the time passes), the
 * bot still wakes, once, and is told why. Browser-safe.
 */

/**
 * What a wake waits for, besides a time: a thread's run finishing, a pull request merging, or a background command the
 * bot started (`watch_start`) ending, printing a line that matches, or reaching its time limit.
 */
export type BotWakeEvent =
  /** `runId`: the run that worked when the wake was set, whose end it waits for (absent on older wakes: any run's end). */
  | { kind: 'thread'; threadId: string; title?: string; runId?: string }
  | { kind: 'pr'; repo: string; number: number; on?: 'merged' | 'checks' | 'review'; reviewAfter?: { at: string | null; ids: string[] } }
  | { kind: 'watcher'; title: string; command: string; match?: string; minutes: number }

/** What happened: the event, with its fixed fields, or why it ended without it. */
export type BotWakeFired =
  | { kind: 'thread'; threadId: string; status: string; title?: string }
  | { kind: 'pr'; repo: string; number: number; state: 'merged'; title?: string }
  | { kind: 'pr'; repo: string; number: number; state: 'checks'; passed: number; failed: number; failedNames: string[]; waiting?: number; waitingNames?: string[]; headSha?: string; title?: string }
  | { kind: 'pr'; repo: string; number: number; state: 'review'; reviewState: 'approved' | 'changes_requested' | 'commented'; reviewer: string; title?: string }
  /** A watcher: it exited (with its code), printed a matching line, or reached its time limit; the end of its output. */
  | { kind: 'watcher'; title: string; how: 'exit' | 'match' | 'time_limit' | 'failed'; exitCode?: number | null; line?: string; message?: string; tail: string }
  | { kind: 'ended'; reason: BotWakeEndReason }

/** Why a wake that waited on an event woke without it. */
export type BotWakeEndReason = 'expired' | 'expired_unread' | 'pr_closed' | 'pr_merged' | 'thread_archived' | 'thread_deleted' | 'unreachable' | 'restart'

/**
 * Loop detection, the only limit on how often a bot wakes itself: since its owner last wrote, a bot sets the same wake
 * (the same brief, waiting on the same thing) at most this many times. One more is a loop with no progress and is
 * refused. There is no count of wakes in a row or in a day.
 */
export const MAX_SAME_WAKES = 3
/** How long a wake on an event waits for it unless the bot says otherwise, and the most it may wait. */
export const DEFAULT_EVENT_WAKE_HOURS = 24
export const MAX_EVENT_WAKE_HOURS = 7 * 24
/** Most characters of the brief a bot writes for its wake. */
export const MAX_WAKE_BRIEF_CHARS = 2_000

/**
 * The id of the quiet line older versions posted in the chat for a wake-up or a thread's notice (`bm_wake_<wakeId>`,
 * `bm_wake_job_…`). Only a thread's message still writes one, for its flood guard; the chat shows none of them
 * (`BotStore`'s `SHOWN_MESSAGE`).
 */
export const WAKE_LINE_PREFIX = 'bm_wake_'

/** How a watcher ended, in words: "exited with code 0", "printed a line that matched", "reached its time limit". */
export function watcherHow(fired: Extract<BotWakeFired, { kind: 'watcher' }>): string {
  if (fired.how === 'match') return 'printed a line that matched'
  if (fired.how === 'time_limit') return 'reached its time limit and was stopped'
  if (fired.how === 'failed') return `could not run${fired.message ? `: ${fired.message}` : ''}`
  return fired.exitCode === null || fired.exitCode === undefined ? 'ended' : `exited with code ${fired.exitCode}`
}

/**
 * What makes two wakes the same for loop detection: the brief, ignoring case, spacing and punctuation, and what it
 * waits for (a time alone, or the same thread, pull request or command).
 */
export function wakeLoopKey(brief: string, event: BotWakeEvent | null): string {
  const words = brief.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const on = !event ? 'time' : event.kind === 'thread' ? `thread:${event.threadId}` : event.kind === 'pr' ? `pr:${event.repo}#${event.number}` : `watcher:${event.command}`
  return `${on}\n${words}`
}

/** "owner/repo", as a pull request's repository is named. */
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/**
 * A pull request as a bot names it: "owner/repo#12", a GitHub pull request URL, or `{ repo, number }`. Undefined when it
 * is none of these.
 */
export function pullRequestOf(given: unknown): { repo: string; number: number } | undefined {
  if (given && typeof given === 'object' && !Array.isArray(given)) {
    const { repo, number } = given as { repo?: unknown; number?: unknown }
    if (typeof repo === 'string' && REPO.test(repo.trim()) && typeof number === 'number' && Number.isInteger(number) && number > 0) return { repo: repo.trim(), number }
    if (typeof repo === 'string' && number === undefined) return pullRequestOf(repo)
    return undefined
  }
  if (typeof given !== 'string') return undefined
  const text = given.trim()
  const url = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(text)
  if (url) return { repo: url[1]!, number: Number(url[2]) }
  const short = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(text)
  if (short) return { repo: short[1]!, number: Number(short[2]) }
  return undefined
}

/** "when PR #12 merges", "when Fix login finishes": what a wake waits for, for its row in About → Runs and its list. */
export function wakeEventLabel(event: BotWakeEvent): string {
  if (event.kind === 'pr') return event.on === 'checks' ? `when ${event.repo}#${event.number}'s checks finish` : event.on === 'review' ? `when ${event.repo}#${event.number} is reviewed` : `when ${event.repo}#${event.number} merges`
  if (event.kind === 'watcher') return `when "${event.title}" ends`
  return `when ${event.title ? `"${event.title}"` : `thread ${event.threadId}`} finishes`
}

const END_WORDS: Record<BotWakeEndReason, string> = {
  expired: 'it didn\'t happen in time',
  expired_unread: 'its time ran out, and the pull request couldn\'t be read then to check whether it happened',
  pr_merged: 'the pull request was merged',
  pr_closed: 'the pull request was closed without merging',
  thread_archived: 'the thread was archived',
  thread_deleted: 'the thread was deleted',
  unreachable: 'you can no longer see that thread',
  restart: 'Mousse restarted, which stopped your background command'
}

/** Why a wake ended without its event, in a few words. */
export function wakeEndWords(reason: BotWakeEndReason): string {
  return END_WORDS[reason] ?? 'it ended'
}

/** Bound outside names both when storing a completion and when reading older stored completions. */
export function wakeCheckNames(names: string[]): string[] {
  return names.slice(0, 20).map((name) => name.slice(0, 120))
}

/** What happened, in a few words for the quiet line above the bot's reply: "PR #12 merged", "Ended: …". */
export function wakeFiredLabel(fired: BotWakeFired | null): string {
  if (!fired) return 'Following up'
  if (fired.kind === 'pr') {
    const pr = `${fired.repo}#${fired.number}`
    if (fired.state === 'checks') {
      const outcomes = []
      if (fired.failed) outcomes.push(`${fired.failed} ${fired.failed === 1 ? 'check' : 'checks'} failed`)
      if (fired.waiting) outcomes.push(`${fired.waiting} ${fired.waiting === 1 ? 'check waits' : 'checks wait'} for approval`)
      return `Following up · ${pr} · ${outcomes.length ? outcomes.join(' · ') : 'checks passed'}`
    }
    if (fired.state === 'review') return `Following up · ${pr} · review: ${fired.reviewState.replace('_', ' ')}`
    return `Following up · ${pr} merged`
  }
  if (fired.kind === 'thread') return `Following up · ${fired.title ? `"${fired.title}"` : 'thread'} ${fired.status === 'completed' ? 'finished' : fired.status}`
  if (fired.kind === 'watcher') return `Following up · "${fired.title}" ${watcherHow(fired)}`
  return `Following up · ${wakeEndWords(fired.reason)}`
}

/** What a turn nobody started replies with when it has nothing for its owner: nothing is posted (`isSilentOutput`). */
export const SILENT_REPLY = '[SILENT]'

/**
 * The text a wake's chat turn starts with: a `bot_wake` notice of what happened (its fixed fields), with outside text
 * (titles, check names, command output) quoted, then what the bot wrote for itself. Mousse's words, never the owner's;
 * it may end with no reply (`reply="if-needed"`, `SILENT_REPLY`), as the standing instructions say. `work`: a work
 * wait, which carries on its work instead. `late`: the time it was for, when it is said later (Mousse was off).
 */
export function wakeInput(input: { brief: string; setAt: string; event: BotWakeEvent | null; fired: BotWakeFired | null; late?: string; chain: number; clock: (iso: string) => string; work?: boolean; wakeId?: string; thread?: boolean }): string {
  const owner = input.thread ? 'the person' : 'your owner'
  const parts: NoticePart[] = []
  const set = input.clock(input.setAt)
  const fired = input.fired
  const what = input.work ? 'A work wait' : 'A wake-up'
  if (!input.event) parts.push(`${what} you set at ${set} is due${input.late ? ` (it was for ${input.late})` : ''}.${input.work ? '' : ` ${input.thread ? 'The person' : 'Your owner'} did not write: you carry on by yourself.`}`)
  else if (fired?.kind === 'pr' && fired.state === 'checks') {
    parts.push(`${what} you set at ${set}: pull request ${fired.repo}#${fired.number}'s checks have settled. Passed: ${fired.passed}. Failed: ${fired.failed}. Waiting for approval: ${fired.waiting ?? 0}.`)
    if (fired.title) parts.push(quoted('pull request title', fired.title))
    if (fired.headSha) parts.push(quoted('head commit', fired.headSha.slice(0, 7)))
    const failedNames = wakeCheckNames(fired.failedNames), waitingNames = wakeCheckNames(fired.waitingNames ?? [])
    if (failedNames.length) parts.push(quoted('failed check names', failedNames.join('\n')))
    if (fired.failed > failedNames.length) parts.push(`Failed check names: and ${fired.failed - failedNames.length} more.`)
    if (waitingNames.length) parts.push(quoted('checks waiting for approval', waitingNames.join('\n')))
    if ((fired.waiting ?? 0) > waitingNames.length) parts.push(`Checks waiting for approval: and ${fired.waiting! - waitingNames.length} more.`)
  } else if (fired?.kind === 'pr' && fired.state === 'review') {
    parts.push(`${what} you set at ${set}: pull request ${fired.repo}#${fired.number} has a new review. State: ${fired.reviewState.replace('_', ' ')}.`)
    if (fired.title) parts.push(quoted('pull request title', fired.title))
    parts.push(quoted('reviewer login', fired.reviewer))
  } else if (fired?.kind === 'pr') {
    parts.push(`${what} you set at ${set}: pull request ${fired.repo}#${fired.number} merged.`)
    if (fired.title) parts.push(quoted('pull request title', fired.title))
  } else if (fired?.kind === 'thread') {
    parts.push(`${what} you set at ${set}: thread ${fired.threadId} finished its turn (status: ${fired.status}).`)
    if (fired.title) parts.push(quoted('thread title', fired.title))
  } else if (fired?.kind === 'watcher') {
    const command = input.event.kind === 'watcher' ? `\nCommand: ${input.event.command}` : ''
    parts.push(`Your background command "${fired.title}", started at ${set}, ${watcherHow({ ...fired, message: undefined })}.${command}`)
    if (fired.how === 'failed' && fired.message) parts.push(quoted('event reason', fired.message))
    if (fired.line !== undefined) parts.push(quoted('the line that matched', fired.line))
    const tail = fired.tail.trimEnd()
    parts.push(tail ? quoted('the end of its output', tail) : 'It printed nothing.')
    // The wake carries only the end; the rest stays readable for a while.
    if (tail && input.wakeId) parts.push(`To read more of its output, call watch_list with watcherId "${input.wakeId}".`)
  } else {
    const reason = fired?.kind === 'ended' ? fired.reason : 'expired'
    const event = input.event.kind === 'thread' ? { ...input.event, title: undefined } : input.event
    parts.push(`${what} you set at ${set} ${wakeEventLabel(event)} ended without it: ${wakeEndWords(reason)}.`)
    if (input.event.kind === 'thread' && input.event.title) parts.push(quoted('thread title', input.event.title))
  }
  parts.push(`What you wrote for yourself: ${input.brief}`)
  if (input.work) return notice({ kind: 'work_wait' }, [...parts, 'Carry on with this work in this thread, then report as usual.'])
  parts.push(`This is wake-up ${input.chain} in a row without ${owner}. You can act in this turn yourself; the same wake-up again with no progress is refused.`)
  // A thread's wake carries the thread on (`ThreadWakes`): a turn of its own, with no reply rule of a bot's chat.
  if (input.thread) return notice({ kind: 'thread_wake', ...(input.wakeId ? { ref: input.wakeId } : {}) }, parts)
  return notice({ kind: 'bot_wake', reply: 'if-needed', ...(input.wakeId ? { ref: input.wakeId } : {}) }, parts)
}
