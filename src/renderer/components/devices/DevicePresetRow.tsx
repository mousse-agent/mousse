import { Segmented, SettingsRow } from '../settings/SettingsRow'
import { useDaemonCall } from './useDaemonCall'
import { ACCESS_PRESETS, accessPreset, shownPresetOf, type AccessPresetId } from '../../../shared/net/accessPresets'
import type { Device } from '../../lib/netDevices'

const CUSTOM_DETAIL = 'These switches and the bot level match none of the three. Change them one by one, or pick one of the three.'

/**
 * What another computer may do here, as one of three presets (`shared/net/accessPresets.ts`) above its single switches.
 * Fields that match none show as Custom, with no preset picked. A service that does not report every field shows none.
 */
export function DevicePresetRow({ device, onChanged }: { device: Device; onChanged: () => void }) {
  const { busy, error, call } = useDaemonCall()
  const policy = device.policy
  const current = policy && shownPresetOf(policy)
  if (!current) return null
  const pick = async (id: AccessPresetId) => {
    if (await call('bridge.policy', { node: device.node, ...accessPreset(id).fields })) onChanged()
  }
  const shown = current === 'custom' ? undefined : accessPreset(current)
  return <>
    <SettingsRow
      indent
      title="Access from this device"
      titleId={`device-preset-${device.node}`}
      description={shown
        ? <span title={shown.detail}>{shown.line}</span>
        : <span title={CUSTOM_DETAIL}>Custom</span>}
      control={<Segmented<AccessPresetId | 'custom'>
        value={current}
        ariaLabelledBy={`device-preset-${device.node}`}
        disabled={busy}
        options={ACCESS_PRESETS.map((preset) => ({ value: preset.id, label: preset.label, title: preset.detail }))}
        onChange={(id) => { if (id !== 'custom') void pick(id) }}
      />}
    />
    {error && <p role="alert" className="chat-error devices-error">{error}</p>}
  </>
}
