// The Runs list worked out from the daemon's runs: which group each run sits in, the rows the keyboard moves through,
// and the words a row says. Pure functions; the page and the tests share them.
import type { AutomationItem } from '../../../../shared/automations'
import {
  isLiveRunState,
  openForBot,
  openForPerson,
  resolvedRun,
  RUN_LEVEL_LABELS,
  type InboxCounts,
  type InboxRun,
  type RunModelUsage
} from '../../../../shared/automationInbox'
import type { InboxFilter } from './inboxStore'

export type GroupKey = 'live' | 'needs_you' | 'look' | 'fyi' | 'quiet'

/** A row the keyboard can stop on: a run, or one of the two folds. */
export type ListRow =
  | { kind: 'run'; run: InboxRun; group: GroupKey; resolved?: boolean }
  | { kind: 'fold'; fold: 'bots' | 'quiet'; group: GroupKey; count: number }

export interface InboxGroup {
  key: GroupKey
  label: string
  rows: ListRow[]
  /** Runs the group's header counts (the person's, in Needs you). */
  count: number
}

export const GROUP_LABELS: Record<GroupKey, string> = {
  live: 'Running',
  needs_you: 'Needs you',
  look: 'Worth a look',
  fyi: 'FYI',
  quiet: 'Quiet'
}

/** The keys 1–4 jump to. */
export const LEVEL_KEYS: Record<string, GroupKey> = { 1: 'needs_you', 2: 'look', 3: 'fyi', 4: 'quiet' }

/**
 * Where a run sits. A live run (queued, running, paused for usage) has no report yet and stays on top. A run with an
 * open item is in Needs you (the person's) or under Assigned to bots. A resolved run settles in FYI. No report is never
 * quiet: it asks for a look.
 */
export function groupOf(run: InboxRun): GroupKey {
  if (isLiveRunState(run.state)) return 'live'
  if (openForPerson(run) || openForBot(run)) return 'needs_you'
  if (resolvedRun(run)) return 'fyi'
  if (!run.level || run.level === 'look' || run.level === 'needs_you') return 'look'
  return run.level
}

/** Its automation, from the list the page read. */
export type AutomationsById = ReadonlyMap<string, AutomationItem>

export function automationsById(items: readonly AutomationItem[] | undefined): Map<string, AutomationItem> {
  return new Map((items ?? []).filter((item) => item.kind === 'job').map((item) => [item.id, item]))
}

/** The name a run shows: its automation's name now, else the name it had. */
export function runName(run: InboxRun, automations: AutomationsById): string {
  return automations.get(run.jobId)?.name ?? run.jobName
}

export function matchesFilter(run: InboxRun, filter: InboxFilter, automations: AutomationsById): boolean {
  if (filter.automationId && run.jobId !== filter.automationId) return false
  if (filter.project) {
    const projectId = run.projectId ?? automations.get(run.jobId)?.where?.projectId
    if (!projectId || !filter.project.projectIds.includes(projectId)) return false
  }
  const text = filter.text?.trim().toLowerCase()
  if (text && !`${runName(run, automations)} ${run.summary ?? ''} ${run.error ?? ''}`.toLowerCase().includes(text)) return false
  return true
}

/** The groups in order, with the folds open or closed. */
export function inboxGroups(runs: readonly InboxRun[], filter: InboxFilter, automations: AutomationsById, folds: { bots: boolean; quiet: boolean }): InboxGroup[] {
  const shown = runs.filter((run) => matchesFilter(run, filter, automations))
  const of = (key: GroupKey) => shown.filter((run) => groupOf(run) === key)
  const groups: InboxGroup[] = []
  const live = of('live')
  if (live.length) groups.push({ key: 'live', label: GROUP_LABELS.live, count: live.length, rows: live.map((run) => ({ kind: 'run', run, group: 'live' })) })
  const needs = of('needs_you')
  const mine = needs.filter(openForPerson)
  const bots = needs.filter((run) => !openForPerson(run))
  const needRows: ListRow[] = mine.map((run) => ({ kind: 'run', run, group: 'needs_you' }))
  if (bots.length) {
    needRows.push({ kind: 'fold', fold: 'bots', group: 'needs_you', count: bots.length })
    if (folds.bots) needRows.push(...bots.map((run): ListRow => ({ kind: 'run', run, group: 'needs_you' })))
  }
  if (needRows.length) groups.push({ key: 'needs_you', label: GROUP_LABELS.needs_you, count: mine.length, rows: needRows })
  const look = of('look')
  if (look.length) groups.push({ key: 'look', label: GROUP_LABELS.look, count: look.length, rows: look.map((run) => ({ kind: 'run', run, group: 'look' })) })
  const fyi = of('fyi')
  if (fyi.length) groups.push({ key: 'fyi', label: GROUP_LABELS.fyi, count: fyi.length, rows: fyi.map((run) => ({ kind: 'run', run, group: 'fyi', ...(resolvedRun(run) ? { resolved: true } : {}) })) })
  const quiet = of('quiet')
  if (quiet.length) {
    const rows: ListRow[] = [{ kind: 'fold', fold: 'quiet', group: 'quiet', count: quiet.length }]
    if (folds.quiet) rows.push(...quiet.map((run): ListRow => ({ kind: 'run', run, group: 'quiet' })))
    groups.push({ key: 'quiet', label: GROUP_LABELS.quiet, count: quiet.length, rows })
  }
  return groups
}

export const rowKey = (row: ListRow) => (row.kind === 'run' ? row.run.id : `fold:${row.fold}`)

/** The row after (`delta` 1) or before (-1) the cursor, staying at the ends. No cursor: the first or the last row. */
export function moveCursor(rows: readonly ListRow[], cursor: string | null, delta: 1 | -1): ListRow | undefined {
  if (!rows.length) return undefined
  const index = rows.findIndex((row) => rowKey(row) === cursor)
  const from = index < 0 ? (delta > 0 ? -1 : rows.length) : index
  return rows[Math.max(0, Math.min(rows.length - 1, from + delta))]
}

/** The run `e` resolves: the row under the cursor, else the open run; only one with an open item of the person's. */
export function resolvable(rows: readonly ListRow[], cursor: string | null, openRun: InboxRun | undefined): InboxRun | undefined {
  const row = rows.find((entry) => rowKey(entry) === cursor)
  const run = row?.kind === 'run' ? row.run : openRun
  return run && openForPerson(run) ? run : undefined
}

/** The project dot of a project group: runs that need the person in its projects on this computer. */
export function projectDotCount(counts: InboxCounts | null | undefined, projectIds: readonly string[]): number {
  if (!counts) return 0
  return projectIds.reduce((sum, id) => sum + (counts.byProject[id] ?? 0), 0)
}

export function dotLabel(count: number): string {
  return `${count} run${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} you`
}

/** A run's time in the list: now, a clock time today, Yesterday, a weekday this week, else a date. */
export function runTime(at: string, now: Date, live = false): string {
  if (live) return 'now'
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  const day = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const days = Math.round((day(now) - day(date)) / 86_400_000)
  if (days <= 0) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (days === 1) return 'Yesterday'
  if (days < 7) return date.toLocaleDateString([], { weekday: 'short' })
  return date.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

/** The line under a run's name: what it is doing, its report, or why it failed. */
export function runLine(run: InboxRun, now: Date): string {
  if (run.state === 'queued') return 'Waiting to start'
  if (run.state === 'running') return run.summary ?? 'Running'
  if (run.state === 'waiting_computer') return 'Waiting for its computer'
  if (run.state === 'paused_usage') return run.until ? `Paused for usage · resumes ${runTime(run.until, now)}` : 'Paused for usage'
  if (run.state === 'failed') return `Failed: ${run.error ?? 'it stopped'}`
  return run.summary ?? (run.level ? RUN_LEVEL_LABELS[run.level] : 'No report')
}

/** A run with no report says so, never as quiet. */
export const noReport = (run: InboxRun) => run.state === 'done' && !run.level

/** Tokens in a short form: 950, 12.3k, 1.2M. */
export function tokensText(tokens: number): string {
  if (tokens < 1_000) return String(tokens)
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

export function costText(usd: number): string {
  return usd >= 0.995 || usd === 0 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(usd < 0.1 ? 3 : 2)}`
}

/**
 * A run's usage in one line: tokens per model, and the cost when it is known (API keys). A subscription's run shows
 * tokens only.
 */
export function usageText(usage: readonly RunModelUsage[]): string | undefined {
  if (!usage.length) return undefined
  const parts = usage.map((line) => `${line.model} ${tokensText(line.input + line.output)}`)
  const known = usage.filter((line) => line.costUsd !== undefined)
  const cost = known.reduce((sum, line) => sum + (line.costUsd ?? 0), 0)
  return known.length ? `${parts.join(' · ')} · ${costText(cost)}` : parts.join(' · ')
}
