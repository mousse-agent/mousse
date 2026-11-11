// Manage: every automation as one row (When, Who, next run, this month's cost, on/off, Edit and Delete). A row opens
// to its Tuning, the dated notes calibration left; Remove takes a note out of the next run's first message.
import { Fragment } from 'react'
import type { AutomationInbox } from '../../../../shared/automationInbox'
import type { AutomationItem } from '../../../../shared/automations'
import { describeSchedule } from '../../../../shared/scheduleLabel'
import { Bell, Bot, ChevronRight, CircleX, Loader2, Monitor, Pause, VolumeHigh, X } from '../../../lib/icons'
import { RowMenu } from '../../integrations/RowMenu'
import { Switch } from '../../settings/SettingsRow'
import { ownedWhenText } from '../automationTime'
import { whenWords } from '../DraftCard'
import { costText, tokensText } from './inboxModel'
import { closePane, openEdit, removeTuning, setInboxFilter, toggleTuning } from './inboxStore'

/** The When column: the schedule in words, or the trigger. */
export function whenColumn(item: AutomationItem, now: Date): string {
  return whenWords(item) ?? (item.schedule ? describeSchedule(item.schedule, now) : '')
}

/** This month's cost of an automation, or its tokens when no price is known (a subscription). */
export function monthColumn(month: AutomationInbox['month'] | undefined, jobId: string): { text: string; title: string } {
  const usage = month?.byJob[jobId]
  if (!usage || (!usage.tokens && !usage.costUsd)) return { text: '—', title: `Nothing used this month · ${month?.label ?? ''}` }
  if (usage.costUsd > 0) return { text: costText(usage.costUsd), title: `Known cost this month · ${month!.label}. Subscription runs count tokens only (${tokensText(usage.tokens)} in all).` }
  return { text: tokensText(usage.tokens), title: `Tokens this month; no cost is known for them (a subscription) · ${month!.label}` }
}

/** What an automation is doing now, for the glyph before its name: its newest run, or paused, or its computer offline. */
export function automationState(item: AutomationItem, runs: AutomationInbox['runs'] | undefined): { tone: 'running' | 'failed' | 'paused' | 'offline' | 'idle'; title: string } {
  if (item.computer.offline) return { tone: 'offline', title: `${item.computer.name} is offline` }
  const newest = runs?.find((run) => run.jobId === item.id)
  if (newest?.state === 'running' || newest?.state === 'queued') return { tone: 'running', title: 'Running now' }
  if (item.paused) return { tone: 'paused', title: 'Paused' }
  if (newest?.state === 'failed') return { tone: 'failed', title: `Last run failed${newest.error ? `: ${newest.error}` : ''}` }
  return { tone: 'idle', title: newest ? 'Last run done' : 'No runs yet' }
}

function StateGlyph({ tone, title }: ReturnType<typeof automationState>) {
  return (
    <span className="inbox-state" data-tone={tone} title={title} role="img" aria-label={title}>
      {tone === 'running' ? <Loader2 size={13} strokeWidth={2} className="inbox-spin" />
        : tone === 'failed' ? <CircleX size={13} strokeWidth={1.9} />
          : tone === 'paused' ? <Pause size={13} strokeWidth={1.9} />
            : tone === 'offline' ? <Monitor size={13} strokeWidth={1.9} />
              : <span className="inbox-state-dot" />}
    </span>
  )
}

export function ManageTable({ automations, inbox, expanded, now, viewerZone, toggling = {}, onToggle, onDelete }: {
  automations: AutomationItem[]
  inbox: AutomationInbox | null
  expanded: string | null
  now: Date
  viewerZone: string
  /** Switches whose change is on its way, with the state they were asked for. */
  toggling?: Record<string, boolean>
  /** On: resume; off: pause until the person resumes it. */
  onToggle: (item: AutomationItem, on: boolean) => void
  onDelete: (item: AutomationItem) => void
}) {
  const tuning = inbox?.tuning ?? []
  const pausedCount = automations.filter((item) => item.paused).length
  return (
    <div className="inbox-manage" data-testid="inbox-manage">
      <div className="inbox-manage-head">
        <span className="inbox-manage-title">Automations</span>
        <span className="inbox-manage-sub">{automations.length - pausedCount} on{pausedCount ? ` · ${pausedCount} paused` : ''}</span>
        <span className="inbox-strip-spacer" />
        <button type="button" className="inbox-icon-btn small" title="Close · Esc" aria-label="Close" onClick={closePane}><X size={14} strokeWidth={1.8} /></button>
      </div>
      {automations.length === 0 ? <p className="inbox-manage-none">No automations yet.</p> : (
        <table className="inbox-table">
          <colgroup>
            <col className="c-expand" /><col className="c-name" /><col className="c-when" /><col className="c-who" /><col className="c-next" /><col className="c-cost" /><col className="c-on" /><col className="c-menu" />
          </colgroup>
          <thead>
            <tr>
              <th aria-label="Tuning" />
              <th>Name</th>
              <th>When</th>
              <th>Who</th>
              <th>Next run</th>
              <th title={`This month · ${inbox?.month.label ?? ''}`} className="num">Month</th>
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
              const when = whenColumn(item, now)
              const month = monthColumn(inbox?.month, item.id)
              const offline = Boolean(item.computer.offline)
              const state = automationState(item, inbox?.runs)
              return (
                <Fragment key={item.key}>
                  <tr className="inbox-table-row" data-open={open || undefined} data-off={!on || undefined} data-state={state.tone} data-testid="inbox-manage-row" data-automation={item.id}>
                    <td>
                      <button type="button" className="inbox-tuning-toggle" data-testid="inbox-tuning-toggle" aria-expanded={open} title={notes.length ? `Tuning · ${notes.length} note${notes.length === 1 ? '' : 's'}` : 'Tuning'} aria-label={`Tuning for ${item.name}`} onClick={() => toggleTuning(item.id)}>
                        <ChevronRight size={12} strokeWidth={2} aria-hidden="true" />
                        {notes.length > 0 && <span className="inbox-tuning-count">{notes.length}</span>}
                      </button>
                    </td>
                    <td>
                      <span className="inbox-table-namecell">
                        <StateGlyph {...state} />
                        <button type="button" className="inbox-table-name" title={`Only ${item.name}'s runs`} onClick={() => setInboxFilter({ automationId: item.id })}>{item.name}</button>
                        {item.where ? <span className="inbox-table-project">{item.where.name}</span> : null}
                      </span>
                    </td>
                    <td><span className="inbox-cell" title={when}>{when}</span></td>
                    <td><span className="inbox-cell" title={item.who.name}>{item.who.kind === 'bot' ? <Bot size={12} strokeWidth={1.8} aria-hidden="true" /> : null}{item.who.kind === 'bot' ? item.who.name : 'Default'}</span></td>
                    <td>
                      {pending !== undefined ? <span className="inbox-cell is-pending" role="status">{pending ? 'Resuming…' : 'Pausing…'}</span>
                        : offline ? <span className="inbox-cell is-offline" title={`${item.computer.name} is offline: it runs when that computer is back`}>Offline</span>
                        : !on ? <span className="inbox-cell is-paused">Paused</span>
                          : <span className="inbox-cell">{item.next ? ownedWhenText(item.next.at, now, item.computer, viewerZone) : '—'}</span>}
                    </td>
                    <td className="num"><span className="inbox-cell" title={month.title}>{month.text}</span></td>
                    <td>
                      <span className="inbox-switch" data-pending={pending !== undefined || undefined} title={offline ? `Can't change: ${item.computer.name} is offline` : pending !== undefined ? (pending ? 'Resuming…' : 'Pausing…') : on ? 'On · click to pause' : 'Paused · click to resume'}>
                        <Switch checked={on} disabled={offline || pending !== undefined} label={on ? `Pause ${item.name}` : `Resume ${item.name}`} onChange={(next) => onToggle(item, next)} />
                      </span>
                    </td>
                    <td>
                      <RowMenu
                        label={`More actions for ${item.name}`}
                        buttonClassName="inbox-icon-btn small"
                        items={[
                          { label: 'Edit details', testId: 'inbox-manage-edit', disabled: offline, onSelect: () => openEdit(item.id) },
                          { label: 'Delete', testId: 'inbox-manage-delete', danger: true, disabled: offline, onSelect: () => onDelete(item) }
                        ]}
                      />
                    </td>
                  </tr>
                  {open && (
                    <tr className="inbox-tuning-row">
                      <td />
                      <td colSpan={7}>
                        <div className="inbox-tuning" data-testid="inbox-tuning">
                          <span className="inbox-tuning-label">Tuning</span>
                          {notes.length === 0 && <span className="inbox-tuning-none">No notes. Too noisy and Should have told me on a run add one.</span>}
                          {notes.map((note) => (
                            <div key={note.id} className="inbox-tuning-note" data-testid="inbox-tuning-note">
                              <span className="inbox-tuning-kind" title={note.kind === 'noisy' ? 'Too noisy' : 'Should have told me'}>
                                {note.kind === 'noisy' ? <VolumeHigh size={12} strokeWidth={1.8} aria-hidden="true" /> : <Bell size={12} strokeWidth={1.8} aria-hidden="true" />}
                              </span>
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
