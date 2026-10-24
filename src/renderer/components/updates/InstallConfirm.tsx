import { isTurnActivePhase } from '../../../shared/types'
import type { UpdateState } from '../../../shared/updates'
import { useAppStore } from '../../stores/appStore'
import { updateActions } from '../../stores/updateStore'
import { Modal } from '../ui/Modal'
import '../../styles/updates.css'

/** Confirms the restart that installs a downloaded update. Used by the downloads popover and Settings, General. */
export function InstallConfirm({ open, version, onClose }: { open: boolean; version: string; onClose: () => void }) {
  const running = useAppStore((s) => Object.values(s.turnStates).filter((turn) => isTurnActivePhase(turn.phase)).length)
  return (
    <Modal open={open} title={`Restart to install ${version}?`} onClose={onClose} footer={<>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-primary" onClick={() => { onClose(); void updateActions.install() }}>Restart and update</button>
    </>}>
      <p>Mousse will close, stop its background service, install the update and open again.</p>
      <p>{running > 0
        ? `${running} agent turn${running === 1 ? ' is' : 's are'} running. ${running === 1 ? 'It' : 'They'} will be stopped and marked interrupted; you can continue after the update.`
        : 'Any running agent turns will be stopped and marked interrupted.'}</p>
    </Modal>
  )
}

/** What the offered update brings, newest release first. */
export function ReleaseNotes({ state }: { state: Pick<UpdateState, 'releaseNotes' | 'omittedReleaseCount'> }) {
  const groups = state.releaseNotes.filter((group) => group.items.length > 0)
  if (groups.length === 0) return null
  return (
    <section className="update-notes" aria-label="What's changed">
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
