// Manage: every automation as one table row; a row opens to its Tuning, the dated notes calibration left. Mock only.
import { Fragment } from 'react'
import { Bell, Bot, ChevronRight, Clock, Coins, Repeat, User, VolumeHigh, X } from '../../../lib/icons'
import { RowMenu } from '../../integrations/RowMenu'
import { Switch } from '../../settings/SettingsRow'
import { MOCK_COST_LABEL, type MockAutomation } from './data'
import { closeManage, removeTuning, setAutomationOn, setInboxFilter, toggleTuning } from './store'

const noop = () => undefined

export function ManageTable({ automations, expanded }: { automations: MockAutomation[]; expanded: string | null }) {
  return (
    <div className="inbox-manage" data-testid="inbox-manage">
      <div className="inbox-manage-head">
        <span className="inbox-manage-title">Automations</span>
        <span className="inbox-group-count">{automations.length}</span>
        <span className="inbox-strip-spacer" />
        <button type="button" className="inbox-icon-btn small" title="Close · Esc" aria-label="Close" onClick={closeManage}><X size={14} strokeWidth={1.8} /></button>
      </div>
      <table className="inbox-table">
        <colgroup>
          <col className="c-expand" /><col className="c-name" /><col className="c-when" /><col className="c-who" /><col className="c-next" /><col className="c-cost" /><col className="c-on" /><col className="c-menu" />
        </colgroup>
        <thead>
          <tr>
            <th aria-label="Tuning" />
            <th aria-label="Name" />
            <th title="When"><Repeat size={13} strokeWidth={1.8} aria-label="When" /></th>
            <th title="Who"><User size={13} strokeWidth={1.8} aria-label="Who" /></th>
            <th title="Next run"><Clock size={13} strokeWidth={1.8} aria-label="Next run" /></th>
            <th title={`Cost this month · ${MOCK_COST_LABEL}`} className="num"><Coins size={13} strokeWidth={1.8} aria-label="Cost this month" /></th>
            <th aria-label="On" />
            <th aria-label="More" />
          </tr>
        </thead>
        <tbody>
          {automations.map((automation) => {
            const open = expanded === automation.id
            const notes = automation.tuning.length
            return (
              <Fragment key={automation.id}>
                <tr className="inbox-table-row" data-open={open || undefined} data-off={!automation.on || undefined} data-testid="inbox-manage-row" data-automation={automation.id}>
                  <td>
                    <button type="button" className="inbox-tuning-toggle" aria-expanded={open} title={notes ? `Tuning · ${notes} note${notes === 1 ? '' : 's'}` : 'Tuning'} aria-label={`Tuning for ${automation.name}`} onClick={() => toggleTuning(automation.id)}>
                      <ChevronRight size={12} strokeWidth={2} aria-hidden="true" />
                      {notes > 0 && <span className="inbox-tuning-count">{notes}</span>}
                    </button>
                  </td>
                  <td>
                    <button type="button" className="inbox-table-name" title={`Only ${automation.name}'s runs`} onClick={() => setInboxFilter({ automationId: automation.id })}>{automation.name}</button>
                    <span className="inbox-table-project">{automation.project}</span>
                  </td>
                  <td><span className="inbox-cell" title={automation.trigger.text}>{automation.trigger.text}</span></td>
                  <td><span className="inbox-cell" title={automation.who.name}>{automation.who.kind === 'bot' ? <Bot size={12} strokeWidth={1.8} aria-hidden="true" /> : null}{automation.who.kind === 'bot' ? automation.who.name : 'Default'}</span></td>
                  <td><span className="inbox-cell muted">{automation.on ? automation.next : '—'}</span></td>
                  <td className="num"><span className="inbox-cell">{automation.costMonth}</span></td>
                  <td><Switch checked={automation.on} label={automation.on ? `Turn off ${automation.name}` : `Turn on ${automation.name}`} onChange={(on) => setAutomationOn(automation.id, on)} /></td>
                  <td>
                    <RowMenu
                      label={`More actions for ${automation.name}`}
                      buttonClassName="inbox-icon-btn small"
                      items={[{ label: 'Edit', onSelect: noop }, { label: 'Delete', danger: true, onSelect: noop }]}
                    />
                  </td>
                </tr>
                {open && (
                  <tr className="inbox-tuning-row">
                    <td />
                    <td colSpan={7}>
                      <div className="inbox-tuning" data-testid="inbox-tuning">
                        <span className="inbox-tuning-label">Tuning</span>
                        {automation.tuning.length === 0 && <span className="inbox-tuning-none">No notes</span>}
                        {automation.tuning.map((note) => (
                          <div key={note.id} className="inbox-tuning-note">
                            <span className="inbox-tuning-kind" title={note.kind === 'noisy' ? 'Too noisy' : 'Should have told me'}>
                              {note.kind === 'noisy' ? <VolumeHigh size={12} strokeWidth={1.8} aria-hidden="true" /> : <Bell size={12} strokeWidth={1.8} aria-hidden="true" />}
                            </span>
                            <span className="inbox-tuning-text">{note.text}</span>
                            <span className="inbox-tuning-meta">{note.date} · run {note.run}</span>
                            <button type="button" className="inbox-icon-btn small" title="Remove · the next run forgets it" aria-label={`Remove “${note.text}”`} onClick={() => removeTuning(automation.id, note.id)}><X size={12} strokeWidth={1.8} /></button>
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
    </div>
  )
}
