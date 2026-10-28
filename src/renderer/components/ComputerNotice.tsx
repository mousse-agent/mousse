import { outdatedComputerName } from '../../shared/bridge/computerErrors'
import { openSettingsSection } from '../lib/settingsNavigation'

/**
 * A line above the composer that says why something did not go out. When the computer that runs the
 * thread is too old to do the action, the line offers to open Devices, where its update steps are.
 */
export function ComputerNotice({ message }: { message: string }) {
  const outdated = outdatedComputerName({ message })
  return (
    <div className="connection-failed-pill" role="alert">
      <span>{message}</span>
      {outdated && <button type="button" onClick={() => openSettingsSection('connections')}>Update {outdated}…</button>}
    </div>
  )
}
