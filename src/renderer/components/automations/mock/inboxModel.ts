// The Runs list of the inbox mock-up, worked out from the static data: which group each run sits in, and the rows
// the keyboard moves through. Pure functions, so the real selectors can replace them one for one.
import { MOCK_AUTOMATIONS, MOCK_QUIET, MOCK_RUNS, type MockAutomation, type MockRun } from './data'
import type { InboxFilter } from './store'

export type GroupKey = 'live' | 'needs_you' | 'look' | 'fyi' | 'quiet'

/** A row the keyboard can stop on: a run, or one of the two folds. */
export type ListRow =
  | { kind: 'run'; run: MockRun; group: GroupKey; resolved?: boolean }
  | { kind: 'fold'; fold: 'bots' | 'quiet'; group: GroupKey; count: number }
  | { kind: 'quiet'; id: string; automationId: string; time: string; group: 'quiet' }

export interface InboxGroup {
  key: GroupKey
  label: string
  rows: ListRow[]
  /** Runs the group's header counts. */
  count: number
}

export const GROUP_LABELS: Record<GroupKey, string> = {
  live: 'Running',
  needs_you: 'Needs you',
  look: 'Worth a look',
  fyi: 'FYI',
  quiet: 'Quiet'
}

export const automationOf = (id: string, automations: MockAutomation[] = MOCK_AUTOMATIONS) => automations.find((entry) => entry.id === id)

/** Where a run sits. Running, waiting and paused runs have no report yet: they stay at the top, apart from the levels. */
export function groupOf(run: MockRun, resolved: readonly string[]): GroupKey {
  if (run.state === 'running' || run.state === 'waiting_computer' || run.state === 'paused_usage') return 'live'
  if (resolved.includes(run.id)) return 'fyi'
  if (run.level === 'needs_you' || run.state === 'failed') return 'needs_you'
  // No report is never quiet: it asks for a look.
  if (run.level === 'look' || run.level === 'none') return 'look'
  return run.level === 'fyi' ? 'fyi' : 'quiet'
}

function matches(run: { automationId: string; summary?: string }, filter: InboxFilter): boolean {
  const automation = automationOf(run.automationId)
  if (filter.automationId && run.automationId !== filter.automationId) return false
  if (filter.project && automation?.project !== filter.project) return false
  const text = filter.text?.trim().toLowerCase()
  if (text && !`${automation?.name ?? ''} ${run.summary ?? ''}`.toLowerCase().includes(text)) return false
  return true
}

/** The groups in order, with the folds open or closed. */
export function inboxGroups(filter: InboxFilter, resolved: readonly string[], open: { bots: boolean; quiet: boolean }): InboxGroup[] {
  const runs = MOCK_RUNS.filter((run) => matches(run, filter))
  const byGroup = (key: GroupKey) => runs.filter((run) => groupOf(run, resolved) === key)
  const groups: InboxGroup[] = []
  const live = byGroup('live')
  if (live.length) groups.push({ key: 'live', label: GROUP_LABELS.live, count: live.length, rows: live.map((run) => ({ kind: 'run', run, group: 'live' })) })
  const needs = byGroup('needs_you')
  const mine = needs.filter((run) => !run.assignee)
  const bots = needs.filter((run) => run.assignee)
  const needRows: ListRow[] = mine.map((run) => ({ kind: 'run', run, group: 'needs_you' }))
  if (bots.length) {
    needRows.push({ kind: 'fold', fold: 'bots', group: 'needs_you', count: bots.length })
    if (open.bots) needRows.push(...bots.map((run): ListRow => ({ kind: 'run', run, group: 'needs_you' })))
  }
  if (needRows.length) groups.push({ key: 'needs_you', label: GROUP_LABELS.needs_you, count: mine.length, rows: needRows })
  const look = byGroup('look')
  if (look.length) groups.push({ key: 'look', label: GROUP_LABELS.look, count: look.length, rows: look.map((run) => ({ kind: 'run', run, group: 'look' })) })
  const fyi = byGroup('fyi')
  if (fyi.length) groups.push({ key: 'fyi', label: GROUP_LABELS.fyi, count: fyi.length, rows: fyi.map((run) => ({ kind: 'run', run, group: 'fyi', resolved: resolved.includes(run.id) })) })
  const quiet = MOCK_QUIET.map(([automationId, time], index) => ({ automationId, time, id: `q${index}` })).filter((entry) => matches(entry, filter))
  if (quiet.length) {
    const rows: ListRow[] = [{ kind: 'fold', fold: 'quiet', group: 'quiet', count: quiet.length }]
    if (open.quiet) rows.push(...quiet.map((entry): ListRow => ({ kind: 'quiet', group: 'quiet', ...entry })))
    groups.push({ key: 'quiet', label: GROUP_LABELS.quiet, count: quiet.length, rows })
  }
  return groups
}

export const rowKey = (row: ListRow) => (row.kind === 'run' ? row.run.id : row.kind === 'fold' ? `fold:${row.fold}` : row.id)

/** Unresolved Needs you runs of a project that are the person's, for the Chats sidebar's dot. */
export function needsYouCount(project: string, resolved: readonly string[]): number {
  return MOCK_RUNS.filter((run) => !run.assignee && groupOf(run, resolved) === 'needs_you' && automationOf(run.automationId)?.project === project).length
}
