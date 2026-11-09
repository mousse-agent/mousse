/**
 * The Automations inbox: every run of every automation, with the report its agent gave (`run_report`), what the run
 * is doing apart from that report, the Needs you queue of unresolved items, Tuning notes and per-run usage. The daemon
 * keeps it (`AutomationRuns`); the page reads it with `automations.inbox.list`.
 */

/** How much a run's report asks of the person, lowest first. A run that ended without one has no level ("No report"). */
export type RunLevel = 'quiet' | 'fyi' | 'look' | 'needs_you'
export const RUN_LEVELS: readonly RunLevel[] = ['quiet', 'fyi', 'look', 'needs_you']

export function isRunLevel(value: unknown): value is RunLevel {
  return typeof value === 'string' && (RUN_LEVELS as readonly string[]).includes(value)
}

export const RUN_LEVEL_LABELS: Record<RunLevel, string> = {
  quiet: 'Quiet',
  fyi: 'FYI',
  look: 'Worth a look',
  needs_you: 'Needs you'
}

/**
 * What a run is doing, apart from its report: waiting to start (behind a busy thread), working, held by a usage limit
 * that resets, failed, or done. `waiting_computer` is a run held for another of the person's computers.
 */
export type InboxRunState = 'queued' | 'running' | 'waiting_computer' | 'paused_usage' | 'failed' | 'done'
export const LIVE_RUN_STATES: readonly InboxRunState[] = ['queued', 'running', 'waiting_computer', 'paused_usage']

export function isLiveRunState(state: InboxRunState): boolean {
  return (LIVE_RUN_STATES as readonly string[]).includes(state)
}

/** The tokens one model used in a run, and its price when the runtime knows it (API keys). */
export interface RunModelUsage {
  model: string
  provider?: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Known only for API-key runtimes; a subscription's runs have tokens only. */
  costUsd?: number
}

/** Who resolves a Needs you item: the person, or the automation's bot when its Who is a bot. */
export type InboxAssignee = { kind: 'person' } | { kind: 'bot'; botId: string }

/** Why an item is in Needs you: the report said so, the run failed, or the run waits on an approval or a question. */
export type InboxItemKind = 'needs_you' | 'failed' | 'approval' | 'ask'

export interface InboxItem {
  id: string
  runId: string
  kind: InboxItemKind
  assignee: InboxAssignee
  createdAt: string
  /** Absent while it is open. Only Resolve, or answering its approval or question, sets it; opening the run never does. */
  resolvedAt?: string
  resolvedBy?: 'person' | 'answered'
}

/** One run of an automation, newest first in the list. */
export interface InboxRun {
  id: string
  jobId: string
  /** The automation's name when the run started. */
  jobName: string
  /** The run's number in its automation (Tuning notes cite it). */
  number: number
  projectId?: string
  threadId?: string
  /** The automation's Who was this bot. */
  botId?: string
  startedAt: string
  endedAt?: string
  state: InboxRunState
  /** With `paused_usage`: when the usage limit resets. */
  until?: string
  /** The report's level; absent: no report (a live run, or one that ended without `run_report`). Never read as quiet. */
  level?: RunLevel
  /** The report's one line, or why the run failed. */
  summary?: string
  error?: string
  usage: RunModelUsage[]
  /** The run thread's linked pull request. */
  pr?: { number: number; url: string }
  /** The run's Needs you items, open and resolved. */
  items: InboxItem[]
}

/** A dated note calibration left on an automation; the newest five reach each run's first message. */
export interface TuningNote {
  id: string
  jobId: string
  kind: 'noisy' | 'missed'
  runId?: string
  runNumber?: number
  text: string
  createdAt: string
}

/** What the inbox knows about an automation besides its job: where it was made, and what "this" meant there. */
export interface InboxAutomationMeta {
  jobId: string
  /** The ordinary chat it was made from; its runs never post there. */
  originThreadId?: string
  /** What "this" meant in that chat; every run's first message carries it. */
  context?: string
}

/** This month's usage of one automation. `costUsd` covers only runs whose price is known (API keys). */
export interface InboxMonthUsage {
  tokens: number
  costUsd: number
}

export interface AutomationInbox {
  runs: InboxRun[]
  tuning: TuningNote[]
  meta: InboxAutomationMeta[]
  month: {
    /** `2026-11`, in this computer's clock. */
    key: string
    /** What the cost covers, e.g. "API keys · Nov". */
    label: string
    byJob: Record<string, InboxMonthUsage>
  }
  /** The last Resolve the person made, for Undo (`u`). */
  undo?: { runId: string; jobName: string }
  generatedAt: string
}

/** The project dot: unresolved Needs you items assigned to the person, by project id. */
export interface InboxCounts {
  byProject: Record<string, number>
  total: number
}

/** A run is in Needs you while it has an open item assigned to the person. */
export function openForPerson(run: Pick<InboxRun, 'items'>): boolean {
  return run.items.some((item) => !item.resolvedAt && item.assignee.kind === 'person')
}

/** Its open items are all a bot's ("Assigned to bots"). */
export function openForBot(run: Pick<InboxRun, 'items'>): boolean {
  const open = run.items.filter((item) => !item.resolvedAt)
  return open.length > 0 && open.every((item) => item.assignee.kind === 'bot')
}

/** It had items and every one is resolved. */
export function resolvedRun(run: Pick<InboxRun, 'items'>): boolean {
  return run.items.length > 0 && run.items.every((item) => item.resolvedAt)
}

// ── Notifications: the per-automation level filter (the old Tell me) ─────────────────────────────

/**
 * When an automation tells the person about a run, as the lowest report level that notifies. Failures always notify,
 * and a run with no report notifies from `look` down. The default is `look`.
 */
export type NotifyLevel = 'needs_you' | 'look' | 'fyi' | 'every'
export const NOTIFY_LEVELS: readonly NotifyLevel[] = ['needs_you', 'look', 'fyi', 'every']
export const DEFAULT_NOTIFY_LEVEL: NotifyLevel = 'look'

export const NOTIFY_LEVEL_LABELS: Record<NotifyLevel, string> = {
  needs_you: 'Needs you',
  look: 'Worth a look',
  fyi: 'FYI too',
  every: 'Every run'
}

/** Whether a finished run notifies under `filter`. */
export function levelNotifies(filter: NotifyLevel, run: { failed: boolean; level?: RunLevel }): boolean {
  if (run.failed || filter === 'every') return true
  // No report is never quiet: it counts as worth a look.
  const level = run.level ?? 'look'
  const rank = RUN_LEVELS.indexOf(level)
  const floor = filter === 'needs_you' ? RUN_LEVELS.indexOf('needs_you') : filter === 'look' ? RUN_LEVELS.indexOf('look') : RUN_LEVELS.indexOf('fyi')
  return rank >= floor
}

// ── The run's first message ──────────────────────────────────────────────────────────────────────

/** How many Tuning notes reach a run's first message: the newest. */
export const TUNING_IN_PROMPT = 5

function noteDate(at: string): string {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? at : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/**
 * The hidden first message of every automation run: what `run_report` is for, the four levels with short examples,
 * what "this" meant in the chat it was made from, and the automation's newest Tuning notes.
 */
export function runReportNotice(input: { name?: string; context?: string; tuning?: readonly Pick<TuningNote, 'kind' | 'text' | 'createdAt' | 'runNumber'>[] }): string {
  const lines = [
    `[Mousse] The next message comes from an automation${input.name ? ` ("${input.name}")` : ''} that runs on its own; nobody is watching this run.`,
    'When you are done, call run_report once with how much this run needs the person and one short line saying why. A second call replaces the first.',
    '- quiet: nothing worth saying. "CI on main is green; nothing changed."',
    '- fyi: done, worth a line in the log. "Merged 3 patch updates; checks pass."',
    '- look: the person should look when they can. "checkout.spec failed 3 of 20 reruns."',
    '- needs_you: the person must decide or act. "lodash 5 breaks 2 tests: pin it or patch the calls?"',
    'If you cannot call run_report and there is nothing new, reply with exactly [SILENT].'
  ]
  if (input.context?.trim()) lines.push('', `What this automation is about, from the chat it was made in: ${input.context.trim()}`)
  const notes = [...(input.tuning ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, TUNING_IN_PROMPT)
  if (notes.length) {
    lines.push('', 'The person tuned this automation (newest first); report like it:')
    for (const note of notes) lines.push(`- ${noteDate(note.createdAt)}${note.runNumber ? ` · run ${note.runNumber}` : ''}: ${note.text}`)
  }
  return lines.join('\n')
}

/** The Tuning note a calibration writes, from the run it was given on. */
export function tuningText(kind: TuningNote['kind'], run: Pick<InboxRun, 'level' | 'summary'>): string {
  const was = run.level ? RUN_LEVEL_LABELS[run.level] : 'No report'
  const what = run.summary?.trim() ? `“${run.summary.trim().slice(0, 140)}”` : 'This run'
  return kind === 'noisy'
    ? `Too noisy: ${what} was reported as ${was}; report runs like it lower.`
    : `Should have told me: ${what} was reported as ${was}; report runs like it higher.`
}
