// Manage: every automation as one row of a calm table: its name and project, when it runs, who runs it, its next run,
// how its last run went, and its switch. State shows as words where it carries meaning (Running, Failed, Paused,
// Offline). The row's menu holds Run now, Edit details, Tuning notes and Delete. Tuning opens under the row: the
// dated notes calibration left; Remove takes a note out of the next run's first message.
import { Fragment } from 'react'
import type { AutomationInbox } from '../../../../shared/automationInbox'
import type { AutomationItem } from '../../../../shared/automations'
import { describeSchedule } from '../../../../shared/scheduleLabel'
import { CircleX, Loader2, X } from '../../../lib/icons'
import { RowMenu, type RowMenuItem } from '../../integrations/RowMenu'
import { Switch } from '../../settings/SettingsRow'
import { ownedWhenText } from '../automationTime'
import { whenWords } from '../DraftCard'
import { runTime } from './inboxModel'
import { closePane, removeTuning, setInboxFilter, toggleTuning } from './inboxStore'

/** The When column: the schedule in words, or the trigger. */
export function whenColumn(item: AutomationItem, now: Date): string {
  return whenWords(item) ?? (item.schedule ? describeSchedule(item.schedule, now) : '')
}

/** One line of what an automation is: when it runs, who runs it when that is a bot, and where (a filtered list's head). */
export function rowSentence(item: AutomationItem, now: Date): string {
  const parts = [whenColumn(item, now)]
  if (item.who.kind === 'bot') parts.push(`by ${item.who.name}`)
  if (item.where) parts.push(`in ${item.where.name}`)
  return parts.filter(Boolean).join(', ')
}

/** How the last run went: running now, failed (with its error), or when it last ran; nothing when it never ran. */
export function lastRunCell(item: AutomationItem, runs: AutomationInbox['runs'] | undefined, now: Date): { tone: 'running' | 'failed' | 'done' | 'none'; text: string; title?: string } {
  const newest = runs?.find((run) => run.jobId === item.id)
  if (newest) {
    if (newest.state === 'running' || newest.state === 'queued') return { tone: 'running', text: 'Running' }
    if (newest.state === 'failed') return { tone: 'failed', text: 'Failed', title: newest.error ?? 'It stopped' }
    if (newest.state === 'paused_usage') return { tone: 'none', text: 'Paused for usage' }
    return { tone: 'done', text: runTime(newest.startedAt, now), ...(newest.summary ? { title: newest.summary } : {}) }
  }
  const last = item.last
  if (!last) return { tone: 'none', text: '—', title: 'No runs yet' }
  if (last.state === 'running' || last.state === 'queued') return { tone: 'running', text: 'Running' }
  if (last.state === 'failed' || last.state === 'incomplete') return { tone: 'failed', text: last.state === 'failed' ? 'Failed' : 'Incomplete', ...(last.detail ? { title: last.detail } : {}) }
  return { tone: 'done', text: runTime(last.at, now), ...(last.detail ? { title: last.detail } : {}) }
}

/** The next run, in full in its tooltip when the column cuts it short. */
function NextRun({ text }: { text: string }) {
  return <span className="inbox-cell" title={text === '—' ? 'Runs on its trigger' : text}>{text}</span>
}

export function ManageTable({ automations, inbox, expanded, toggling = {}, onToggle, onRunNow, onEdit, onDelete, now, viewerZone }: {
  automations: AutomationItem[]
  inbox: AutomationInbox | null
  expanded: string | null
  now: Date
  viewerZone: string
  /** Pauses and resumes on their way, with the state each was asked for. */
  toggling?: Record<string, boolean>
  /** On: resume; off: pause until the person resumes it. */
  onToggle: (item: AutomationItem, on: boolean) => void
  onRunNow: (item: AutomationItem) => void
  onEdit: (item: AutomationItem) => void
  onDelete: (item: AutomationItem) => void
}) {
  const tuning = inbox?.tuning ?? []
  return (
    <div className="inbox-manage" data-testid="inbox-manage">
      <div className="inbox-manage-head">
        <span className="inbox-manage-title">Automations</span>
        <span className="inbox-strip-spacer" />
        <button type="button" className="inbox-icon-btn small" title="Close · Esc" aria-label="Close" onClick={closePane}><X size={14} strokeWidth={1.8} /></button>
      </div>
      {automations.length === 0 ? <p className="inbox-manage-none">No automations yet.</p> : (
        <table className="inbox-table">
          <colgroup>
            <col className="c-name" /><col className="c-when" /><col className="c-who" /><col className="c-next" /><col className="c-last" /><col className="c-on" /><col className="c-menu" />
          </colgroup>
          <thead>
            <tr>
              <th>Name</th>
              <th>When</th>
              <th>Who</th>
              <th>Next run</th>
              <th>Last run</th>
              <th className="c-on-head">On</th>
              <th aria-label="More" />
            </tr>
          </thead>
          <tbody>
            {automations.map((item) => {
              const open = expanded === item.id
              const notes = tuning.filter((note) => note.jobId === item.id)
              const pending = toggling[item.id]
              const on = pending ?? !item.paused
              const offline = Boolean(item.computer.offline)
              const when = whenColumn(item, now)
              const last = lastRunCell(item, inbox?.runs, now)
              const blocked = offline ? `${item.computer.name} is offline` : undefined
              const menu: RowMenuItem[] = [
                { label: 'Run now', testId: 'inbox-manage-run', disabled: offline, ...(blocked ? { title: blocked } : {}), onSelect: () => onRunNow(item) },
                { label: 'Edit details', testId: 'inbox-manage-edit', disabled: offline, ...(blocked ? { title: blocked } : {}), onSelect: () => onEdit(item) },
                { label: notes.length ? `Tuning notes (${notes.length})` : 'Tuning notes', testId: 'inbox-tuning-toggle', onSelect: () => toggleTuning(item.id) },
                { label: 'Delete', testId: 'inbox-manage-delete', danger: true, disabled: offline, ...(blocked ? { title: blocked } : {}), onSelect: () => onDelete(item) }
              ]
              return (
                <Fragment key={item.key}>
                  <tr className="inbox-table-row" data-open={open || undefined} data-off={!on || undefined} data-testid="inbox-manage-row" data-automation={item.id}>
                    <td>
                      <button type="button" className="inbox-table-name" title={`${item.name}'s runs`} onClick={() => setInboxFilter({ automationId: item.id })}>{item.name}</button>
                      {item.where ? <span className="inbox-table-project">{item.where.name}</span> : null}
                    </td>
                    <td><span className="inbox-cell" title={when}>{when}</span></td>
                    <td><span className="inbox-cell" title={item.who.name}>{item.who.kind === 'bot' ? item.who.name : 'Default'}</span></td>
                    <td data-testid="inbox-manage-next">
                      {pending !== undefined ? <span className="inbox-cell is-pending" role="status">{pending ? 'Resuming…' : 'Pausing…'}</span>
                        : offline ? <span className="inbox-cell" title={`${item.computer.name} is offline: it runs when that computer is back`}>Offline</span>
                          : !on ? <span className="inbox-cell">Paused</span>
                            : <NextRun text={item.next ? ownedWhenText(item.next.at, now, item.computer, viewerZone) : '—'} />}
                    </td>
                    <td data-testid="inbox-manage-last">
                      <span className="inbox-cell" data-tone={last.tone} title={last.title ?? last.text}>
                        {last.tone === 'running' ? <Loader2 size={12} strokeWidth={2} className="inbox-spin" aria-hidden="true" /> : last.tone === 'failed' ? <CircleX size={12} strokeWidth={2} aria-hidden="true" /> : null}
                        {last.text}
                      </span>
                    </td>
                    <td>
                      <span className="inbox-switch" data-pending={pending !== undefined || undefined} title={offline ? `Can't change: ${item.computer.name} is offline` : pending !== undefined ? (pending ? 'Resuming…' : 'Pausing…') : on ? 'On · click to pause' : 'Paused · click to resume'}>
                        <Switch checked={on} disabled={offline || pending !== undefined} label={on ? `Pause ${item.name}` : `Resume ${item.name}`} onChange={(next) => onToggle(item, next)} />
                      </span>
                    </td>
                    <td><RowMenu label={`More actions for ${item.name}`} buttonClassName="inbox-icon-btn small inbox-manage-more" items={menu} /></td>
                  </tr>
                  {open && (
                    <tr className="inbox-tuning-row">
                      <td colSpan={7}>
                        <div className="inbox-tuning" data-testid="inbox-tuning">
                          {notes.length === 0 && <span className="inbox-tuning-none">No notes yet. Too noisy and Should have told me on a run add one.</span>}
                          {notes.map((note) => (
                            <div key={note.id} className="inbox-tuning-note" data-testid="inbox-tuning-note">
                              <span className="inbox-tuning-text" title={note.text}>{note.text}</span>
                              <span className="inbox-tuning-meta">{new Date(note.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}{note.runNumber ? ` · run ${note.runNumber}` : ''}</span>
                              <button type="button" className="inbox-icon-btn small" data-testid="inbox-tuning-remove" title="Remove · the next run forgets it" aria-label={`Remove “${note.text}”`} onClick={() => void removeTuning(note.id)}><X size={12} strokeWidth={1.8} /></button>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
