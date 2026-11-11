// Manage: every automation as one quiet row, read as a sentence: its name, then when it runs (and who, and where).
// State shows only when it needs a look (running, failed, offline) or when it is paused; the rest is in the row's
// menu: Run now, Pause or Resume, Edit details, Tuning and Delete. Tuning opens under the row: the dated notes
// calibration left; Remove takes a note out of the next run's first message.
import { Fragment } from 'react'
import type { AutomationInbox } from '../../../../shared/automationInbox'
import type { AutomationItem } from '../../../../shared/automations'
import { describeSchedule } from '../../../../shared/scheduleLabel'
import { CircleX, Loader2, Monitor, X } from '../../../lib/icons'
import { RowMenu, type RowMenuItem } from '../../integrations/RowMenu'
import { ownedWhenText } from '../automationTime'
import { whenWords } from '../DraftCard'
import { closePane, removeTuning, setInboxFilter, toggleTuning } from './inboxStore'

/** The When column: the schedule in words, or the trigger. */
export function whenColumn(item: AutomationItem, now: Date): string {
  return whenWords(item) ?? (item.schedule ? describeSchedule(item.schedule, now) : '')
}

/** A row's second line: when it runs, then who does it when that is a bot, then where. */
export function rowSentence(item: AutomationItem, now: Date): string {
  const parts = [whenColumn(item, now)]
  if (item.who.kind === 'bot') parts.push(`by ${item.who.name}`)
  if (item.where) parts.push(`in ${item.where.name}`)
  return parts.filter(Boolean).join(', ')
}

/** What needs a look about an automation now; nothing when it is fine (or only paused, which the row says itself). */
export function automationState(item: AutomationItem, runs: AutomationInbox['runs'] | undefined): { tone: 'running' | 'failed' | 'offline'; title: string } | undefined {
  if (item.computer.offline) return { tone: 'offline', title: `${item.computer.name} is offline` }
  const newest = runs?.find((run) => run.jobId === item.id)
  if (newest?.state === 'running' || newest?.state === 'queued') return { tone: 'running', title: 'Running now' }
  if (!item.paused && newest?.state === 'failed') return { tone: 'failed', title: `Last run failed${newest.error ? `: ${newest.error}` : ''}` }
  return undefined
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
        <ul className="inbox-manage-list">
          {automations.map((item) => {
            const open = expanded === item.id
            const notes = tuning.filter((note) => note.jobId === item.id)
            const pending = toggling[item.id]
            const paused = pending === undefined ? item.paused : !pending
            const offline = Boolean(item.computer.offline)
            const state = automationState(item, inbox?.runs)
            const blocked = offline ? `${item.computer.name} is offline` : undefined
            const menu: RowMenuItem[] = [
              { label: 'Run now', testId: 'inbox-manage-run', disabled: offline, ...(blocked ? { title: blocked } : {}), onSelect: () => onRunNow(item) },
              { label: paused ? 'Resume' : 'Pause', testId: 'inbox-manage-toggle', disabled: offline || pending !== undefined, ...(blocked ? { title: blocked } : {}), onSelect: () => onToggle(item, paused) },
              { label: 'Edit details', testId: 'inbox-manage-edit', disabled: offline, ...(blocked ? { title: blocked } : {}), onSelect: () => onEdit(item) },
              { label: notes.length ? `Tuning notes (${notes.length})` : 'Tuning notes', testId: 'inbox-tuning-toggle', onSelect: () => toggleTuning(item.id) },
              { label: 'Delete', testId: 'inbox-manage-delete', danger: true, disabled: offline, ...(blocked ? { title: blocked } : {}), onSelect: () => onDelete(item) }
            ]
            return (
              <Fragment key={item.key}>
                <li className="inbox-manage-row" data-open={open || undefined} data-paused={paused || undefined} data-state={state?.tone} data-testid="inbox-manage-row" data-automation={item.id}>
                  <button type="button" className="inbox-manage-main" title={`${item.name}'s runs${!paused && item.next ? ` · next ${ownedWhenText(item.next.at, now, item.computer, viewerZone)}` : ''}`} onClick={() => setInboxFilter({ automationId: item.id })}>
                    <span className="inbox-manage-name">{item.name}</span>
                    <span className="inbox-manage-when">{rowSentence(item, now)}</span>
                  </button>
                  <span className="inbox-manage-state" data-testid="inbox-manage-state">
                    {pending !== undefined ? <span className="is-pending" role="status">{pending ? 'Resuming…' : 'Pausing…'}</span>
                      : state?.tone === 'running' ? <span className="is-running" title={state.title}><Loader2 size={12} strokeWidth={2} className="inbox-spin" aria-hidden="true" />Running</span>
                        : state?.tone === 'failed' ? <span className="is-failed" title={state.title}><CircleX size={12} strokeWidth={2} aria-hidden="true" />Failed</span>
                          : state?.tone === 'offline' ? <span className="is-offline" title={`${state.title}: it runs when that computer is back`}><Monitor size={12} strokeWidth={1.9} aria-hidden="true" />Offline</span>
                            : paused ? <button type="button" className="is-paused" data-testid="inbox-manage-resume" title="Resume" aria-label={`Resume ${item.name}`} onClick={() => onToggle(item, true)}><span>Paused</span><span>Resume</span></button> : null}
                  </span>
                  <RowMenu label={`More actions for ${item.name}`} buttonClassName="inbox-icon-btn small inbox-manage-more" items={menu} />
                </li>
                {open && (
                  <li className="inbox-tuning" data-testid="inbox-tuning">
                    {notes.length === 0 && <span className="inbox-tuning-none">No notes yet. Too noisy and Should have told me on a run add one.</span>}
                    {notes.map((note) => (
                      <div key={note.id} className="inbox-tuning-note" data-testid="inbox-tuning-note">
                        <span className="inbox-tuning-text" title={note.text}>{note.text}</span>
                        <span className="inbox-tuning-meta">{new Date(note.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}{note.runNumber ? ` · run ${note.runNumber}` : ''}</span>
                        <button type="button" className="inbox-icon-btn small" data-testid="inbox-tuning-remove" title="Remove · the next run forgets it" aria-label={`Remove “${note.text}”`} onClick={() => void removeTuning(note.id)}><X size={12} strokeWidth={1.8} /></button>
                      </div>
                    ))}
                  </li>
                )}
              </Fragment>
            )
          })}
        </ul>
      )}
    </div>
  )
}
