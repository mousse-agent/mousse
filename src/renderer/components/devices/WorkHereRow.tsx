import { SettingsRow, Switch } from '../settings/SettingsRow'

/**
 * "Let my other devices work here", this computer's own switch for "Work on threads": v1's Devices group shows it
 * while v1 networking is on, the new networking's group while v1 is off. One setting either way; off is the kill
 * switch, so it ends what is open, not only the next call.
 */
export function WorkHereRow({
  on,
  busy,
  onChange,
  indent
}: {
  on: boolean
  busy: boolean
  onChange: (next: boolean) => void
  indent?: boolean
}) {
  return (
    // Its own switch, apart from Networking: the short title is for scanning, the switch keeps the permission's full name.
    <SettingsRow
      indent={indent}
      title="Let my other devices work here"
      description={
        on
          ? 'On · devices with Works on threads can open and change this device’s threads, within the limits set for each device'
          : 'Off · no other device can open or change this device’s threads'
      }
      control={
        <Switch checked={on} label="Let my other devices work on this device's threads" disabled={busy} onChange={onChange} />
      }
    />
  )
}
