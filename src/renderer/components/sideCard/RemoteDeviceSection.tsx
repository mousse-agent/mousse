import { remoteUnsupported, type RemoteThreadEntry } from '../../lib/remoteThreadStore'
import { SideCardSection } from './SideCardSection'
import './deviceSection.css'

/**
 * The side card of a thread that runs on another computer: that computer's name, and a line
 * saying the local tools (Git, actions, editor) do not reach it.
 */
export function RemoteDeviceSection({ entry }: { entry: RemoteThreadEntry }) {
  const name = entry.deviceName ?? 'Another computer'
  return (
    <SideCardSection title="Device" threadId={entry.ref.entityId}>
      <p className="side-card-device-name" title={name}>{name}</p>
      <p className="side-card-device-note">{remoteUnsupported('panel', name).title}</p>
    </SideCardSection>
  )
}
