import type { ReactNode } from 'react'
import { connectedHere, isComputer, worksOnThreads, type Device } from '../../lib/netDevices'
import { pendingEditorAsk, useEditorAskStore } from '../../stores/editorAskStore'
import { DeviceAccessRows } from '../devices/DeviceAccessRows'
import { DeviceActivityRows } from '../devices/DeviceActivityRows'
import { DeviceBotsRow } from '../devices/DeviceBotsRow'
import { DevicePresetRow } from '../devices/DevicePresetRow'
import { SettingsRow } from '../settings/SettingsRow'

/** The panel shows the device's access level itself (its preset row): only a connected computer that works on threads. */
export const showsLevel = (device: Device | undefined): boolean =>
  !!device && connectedHere(device) && !!device.policy && isComputer(device) && worksOnThreads(device) && !device.policy.blocked

/**
 * One device's access, in its detail: how it is connected, what it can see and do here, then Block and
 * Remove. The same panel serves engine pairings and pairings from the old networking: both are served by
 * `bridge.policy`. `device` is its `bridge.nodes` row; without one (an older service) only Remove shows.
 */
export function AccessPanel({
  name,
  device,
  how,
  busy,
  grant,
  onChanged,
  onLimits,
  onBlock,
  onRemove
}: {
  name: string
  device?: Device
  /** How it is connected now, in plain words ("same network", "via Tailscale"); undefined while it isn't. */
  how?: string
  busy: boolean
  /** The old networking's signed "Works on threads" grant, where this computer can give it. */
  grant?: ReactNode
  onChanged: () => void
  onLimits: () => void
  onBlock: (blocked: boolean) => void
  onRemove?: () => void
}) {
  const asks = useEditorAskStore((s) => s.asks)
  const policy = device?.policy
  const blocked = !!policy?.blocked
  const connected = !!device && connectedHere(device)
  const computer = !!device && isComputer(device)
  const works = showsLevel(device)
  return (
    <>
      <SettingsRow
        indent
        title="Connected"
        description={
          !device || !connected
            ? `Not connected to this computer`
            : how
              ? `To this computer, ${how}`
              : 'To this computer'
        }
      />
      {grant}
      {works && device && <DevicePresetRow device={device} onChanged={onChanged} />}
      {connected && policy && !blocked && computer && (
        <SettingsRow
          indent
          title="Threads"
          description={
            <span title="Private threads stay on this computer. Choosing projects per device isn't available yet.">
              All projects, except private threads
            </span>
          }
        />
      )}
      {connected && policy && !blocked && device && (
        <DeviceBotsRow device={device} onChanged={onChanged} />
      )}
      {works && device && (
        <DeviceAccessRows
          device={device}
          ask={pendingEditorAsk({ asks }, device.node)}
          onChanged={onChanged}
        />
      )}
      {policy && computer && device && <DeviceActivityRows device={device} />}
      {policy && (
        <SettingsRow
          indent
          title={blocked ? 'Blocked on this computer' : 'Block'}
          description={
            blocked
              ? `Everything from ${name} is refused here`
              : `Refuse everything from ${name} here, at once`
          }
          control={
            <>
              {computer && (
                <button type="button" className="settings-btn" disabled={busy} onClick={onLimits}>
                  Limits…
                </button>
              )}
              <button
                type="button"
                className={blocked ? 'settings-btn' : 'settings-btn devices-block-btn'}
                disabled={busy}
                onClick={() => onBlock(!blocked)}
              >
                {blocked ? 'Unblock' : 'Block'}
              </button>
            </>
          }
        />
      )}
      {onRemove && (
        <SettingsRow
          indent
          title="Remove"
          description={`${name} can no longer use this computer`}
          control={
            <button type="button" className="settings-btn danger" disabled={busy} onClick={onRemove}>
              Remove…
            </button>
          }
        />
      )}
    </>
  )
}
