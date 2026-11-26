import { useEffect, useRef } from 'react'
import { isTurnActivePhase } from '../../../shared/types'
import { computersCount, rolloutTargets, type RolloutRow } from '../../../shared/updateRollout'
import { rolloutActions, rowName, rowStatus, rowTone, useRolloutStore } from '../../lib/updateRollout'
import { formatVersion } from '../providers/providerView'
import type { UpdateState } from '../../../shared/updates'
import { useAppStore } from '../../stores/appStore'
import { updateActions } from '../../stores/updateStore'
import { FixedReports } from '../bugReports/FiledReports'
import { Modal } from '../ui/Modal'
import '../../styles/updates.css'

/** What else the install stops, besides this app's own service: everything that runs from the install folder. */
const OTHER_PROCESSES_DETAIL =
  'The installer cannot replace files that are in use. Services of other Mousse homes stop, and their running turns are interrupted. MCP hosts, bridges and mousse-cli commands using this install stop as well.'

/** Confirms the restart that installs a downloaded update. Used by the downloads popover and Settings, General. */
export function InstallConfirm({ open, version, onClose }: { open: boolean; version: string; onClose: () => void }) {
  const running = useAppStore((s) => Object.values(s.turnStates).filter((turn) => isTurnActivePhase(turn.phase)).length)
  return (
    <Modal open={open} title={`Restart to install ${version}?`} onClose={onClose} footer={<>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-primary" onClick={() => { onClose(); void updateActions.install() }}>Restart and update</button>
    </>}>
      {open && <FixedReports />}
      <p>Mousse will close, stop its background service, install the update and open again.</p>
      <p>{running > 0
        ? `${running} agent turn${running === 1 ? ' is' : 's are'} running. ${running === 1 ? 'It' : 'They'} will be stopped and marked interrupted; you can continue after the update.`
        : 'Any running agent turns will be stopped and marked interrupted.'}</p>
      <p title={OTHER_PROCESSES_DETAIL}>Other Mousse services and commands from this install stop too.</p>
    </Modal>
  )
}

/**
 * Update everywhere's confirmation. Opening it starts every computer downloading `version`; nothing installs until
 * Install. Cancel (or closing it) drops the downloads. One row per computer: its name, version and state, the reason in
 * its tooltip.
 */
export function RolloutConfirm({ open, version, onClose }: { open: boolean; version: string; onClose: () => void }) {
  const rollout = useRolloutStore((s) => (s.rollout?.version === version && s.rollout.step === 'preparing' && !s.rollout.confirmedAt ? s.rollout : null))
  const plan = useRolloutStore((s) => (s.planFor === version ? s.plan : undefined))
  const error = useRolloutStore((s) => s.error)
  // Closed before the start answered: the rollout it started is dropped once it has.
  const closed = useRef(false)
  useEffect(() => {
    if (!open) return
    closed.current = false
    useRolloutStore.setState({ error: undefined })
    void rolloutActions.start(version).then((started) => {
      if (started && closed.current) void rolloutActions.cancel()
    })
    return () => {
      closed.current = true
    }
  }, [open, version])
  const rows: readonly RolloutRow[] = rollout?.rows ?? plan ?? []
  const count = rolloutTargets(rows).length
  const turns = rolloutTargets(rows).reduce((sum, row) => sum + (row.runningTurns ?? 0), 0)
  const cancel = (): void => {
    closed.current = true
    if (rollout) void rolloutActions.cancel()
    onClose()
  }
  const install = (): void => {
    if (!rollout) return
    closed.current = false
    void rolloutActions.confirm(rollout)
    onClose()
  }
  return (
    <Modal open={open} title={`Update ${computersCount(count)} to ${formatVersion(version) ?? version}?`} onClose={cancel} footer={<>
      <button type="button" className="btn btn-ghost" onClick={cancel}>Cancel</button>
      <button type="button" className="btn btn-primary" disabled={!rollout || count === 0} onClick={install}>Install</button>
    </>}>
      <ul className="rollout-rows" aria-label="Computers">
        {rows.map((row) => (
          <li key={row.node} className="rollout-row" data-tone={rowTone(row)} title={row.error}>
            <span className="rollout-row-name">{rowName(row)}</span>
            <span className="rollout-row-version">{formatVersion(row.from) ?? ''}</span>
            <span className="rollout-row-status">{rowStatus(row)}</span>
          </li>
        ))}
      </ul>
      {error && <p className="rollout-error" role="alert">{error}</p>}
      <p>{turns > 0
        ? `${turns} running agent turn${turns === 1 ? '' : 's'} will be stopped and marked interrupted.`
        : 'Running agent turns will be stopped and marked interrupted.'}</p>
      <p title={OTHER_PROCESSES_DETAIL}>Other Mousse services and commands from each install stop too.</p>
    </Modal>
  )
}

/** What the offered update brings, newest release first. */
export function ReleaseNotes({ state }: { state: Pick<UpdateState, 'releaseNotes' | 'omittedReleaseCount'> }) {
  const groups = state.releaseNotes.filter((group) => group.items.length > 0)
  if (groups.length === 0) return null
  return (
    <section className="update-notes" aria-label="What's changed">
      <FixedReports />
      {groups.map((group) => {
        const more = group.totalItems - group.items.length
        return (
          <div key={group.version} className="update-notes-group">
            {groups.length > 1 && <h4>{group.version}</h4>}
            <ul>{group.items.map((item, index) => <li key={index}>{item}</li>)}</ul>
            <a href={group.url} target="_blank" rel="noopener noreferrer">
              {more > 0 ? `${more} more change${more === 1 ? '' : 's'} on GitHub` : 'View release on GitHub'}
            </a>
          </div>
        )
      })}
      {state.omittedReleaseCount > 0 &&
        <p className="update-notes-more">{state.omittedReleaseCount} earlier release{state.omittedReleaseCount === 1 ? '' : 's'} not shown</p>}
    </section>
  )
}
