import { useEffect } from 'react'
import type { UpdateChannel, UpdateState } from '../../../shared/updates'
import { subscribeToUpdates, updateActions, useUpdateStore } from '../../stores/updateStore'
import '../../styles/updates.css'

const CHANNELS: Array<{ id: UpdateChannel; label: string; description: string }> = [
  {
    id: 'stable',
    label: 'Stable',
    description: 'Releases cut by hand. Moving here from a nightly build waits for the next stable release newer than it.'
  },
  {
    id: 'nightly',
    label: 'Nightly',
    description: 'The latest changes, built each night they pass every check. Not tested by hand.'
  }
]

function statusText(state: UpdateState): string {
  switch (state.phase) {
    case 'disabled': return state.disabledReason ?? 'Updates are not available in this build.'
    case 'checking': return 'Checking for updates…'
    case 'up-to-date': return `Mousse ${state.currentVersion} is up to date.`
    case 'available': return `Mousse ${state.availableVersion} is available.`
    case 'downloading': return `Downloading ${state.availableVersion}… ${state.downloadPercent ?? 0}%`
    case 'downloaded': return `${state.availableVersion} is ready. Install it from the update button in the sidebar.`
    case 'installing': return `Installing ${state.availableVersion}…`
    case 'error': return state.error?.message ?? 'The last update check failed.'
    default: return `Mousse ${state.currentVersion}`
  }
}

/** Settings → Updates: channel choice, status and a manual check. */
export function UpdateSettings() {
  useEffect(() => subscribeToUpdates(), [])
  const state = useUpdateStore()
  const disabled = state.phase === 'disabled'
  const busy = state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'installing'
  return (
    <section id="updates" className="settings-section">
      <p className="settings-section-desc">Mousse checks GitHub for new builds shortly after it opens and every half hour, and downloads only when you ask.</p>
      <fieldset className="update-settings-channel" disabled={disabled || busy}>
        <legend className="sr-only">Update channel</legend>
        {CHANNELS.map((channel) => (
          <label key={channel.id}>
            <input type="radio" name="update-channel" value={channel.id} checked={state.channel === channel.id}
              onChange={() => void updateActions.setChannel(channel.id)} />
            <strong>{channel.label}</strong>
            <span>{channel.description}</span>
          </label>
        ))}
      </fieldset>
      <div className="update-settings-status">
        <p role="status">{statusText(state)}</p>
        {state.phase === 'available'
          ? <button type="button" className="settings-inline-btn" onClick={() => void updateActions.download()}>Download</button>
          : <button type="button" className="settings-inline-btn" disabled={disabled || busy || state.phase === 'downloaded'}
              onClick={() => void updateActions.check()}>Check now</button>}
      </div>
    </section>
  )
}
