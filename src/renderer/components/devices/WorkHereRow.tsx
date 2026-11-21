import { SettingsRow, Switch } from '../settings/SettingsRow'

/**
 * "Let my other devices work here", this computer's own switch for "Work on threads": Settings → Devices → This
 * computer shows it, saved by the new networking while v1 is off and by v1 while it is on. One setting either way; off is the kill
 * switch, so it ends what is open, not only the next call.
 */
export function WorkHereRow({
  on,
  busy,
  onChange,
  indent,
  anchor
}: {
  on: boolean
  busy: boolean
  onChange: (next: boolean) => void
  indent?: boolean
  /** Where settings search lands on it. */
  anchor?: string
}) {
  return (
    // Its own switch, apart from Networking: the short title is for scanning, the switch keeps the permission's full name.
    <SettingsRow
      indent={indent}
      anchor={anchor}
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
