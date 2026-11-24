import { useState } from 'react'
import {
  ACCESS_PRESETS,
  accessPreset,
  accessPresetOf,
  type AccessPresetFields,
  type AccessPresetId
} from '../../../shared/net/accessPresets'
import type { NetEngineApproval } from '../../../shared/netEngine/local'
import { Switch } from '../settings/SettingsRow'

/** The single switches Customize opens, each one field of a preset. */
const SWITCHES: ReadonlyArray<{
  label: string
  detail: string
  on: (fields: AccessPresetFields) => boolean
  set: (fields: AccessPresetFields, on: boolean) => AccessPresetFields
}> = [
  {
    label: 'Work on threads',
    detail: 'Start, send to, steer and stop threads here.',
    on: (fields) => fields.work,
    set: (fields, on) => ({ ...fields, work: on })
  },
  {
    label: 'Terminals',
    detail: 'Open terminals here: shell access as you.',
    on: (fields) => fields.terminal,
    set: (fields, on) => ({ ...fields, terminal: on })
  },
  {
    label: 'Editor connections',
    detail: 'Open this computer’s folders in its editor.',
    on: (fields) => fields.editor,
    set: (fields, on) => ({ ...fields, editor: on })
  },
  {
    label: 'Full access mode',
    detail: 'Threads it starts may run in Full access. Off: up to Auto-accept edits.',
    on: (fields) => fields.maxPermissionMode === 'full',
    set: (fields, on) => ({ ...fields, maxPermissionMode: on ? 'full' : 'accept_edits' })
  },
  {
    label: 'Agents change all threads',
    detail: 'Its agents may change every thread here. Off: only the threads they started.',
    on: (fields) => fields.agentReach === 'all',
    set: (fields, on) => ({ ...fields, agentReach: on ? 'all' : 'launched' })
  }
]

/**
 * "Let <name> use this computer?" on the computer that showed the code: what it may do here (the three presets,
 * Work on threads first picked; Customize opens the single switches), then Not now or Allow. The level is saved
 * before the device is let in.
 */
export function AllowPrompt({
  approval,
  busy,
  onAnswer
}: {
  approval: NetEngineApproval
  busy: boolean
  onAnswer: (yes: boolean, access?: AccessPresetFields) => void
}) {
  const [fields, setFields] = useState<AccessPresetFields>(() => ({ ...accessPreset('work').fields }))
  const [customize, setCustomize] = useState(false)
  const picked = accessPresetOf(fields)
  const name = approval.name || 'This device'
  const pick = (id: AccessPresetId) => setFields({ ...accessPreset(id).fields })
  return (
    <div className="engine-allow" role="group" aria-label="Pairing request">
      <p className="engine-allow-title">Let {name} use this computer?</p>
      {approval.device && (
        <p className="settings-muted" title="The start of its device id. Check it matches the other computer.">
          {approval.device}
        </p>
      )}
      <div className="engine-choices" role="radiogroup" aria-label="Access">
        {ACCESS_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            role="radio"
            aria-checked={picked === preset.id}
            className={`engine-choice-row${picked === preset.id ? ' selected' : ''}`}
            title={preset.detail}
            disabled={busy}
            onClick={() => pick(preset.id)}
          >
            <span className="engine-choice-label">{preset.label}</span>
            <span className="engine-choice-hint">{preset.line}</span>
          </button>
        ))}
        {picked === 'custom' && (
          <p className="settings-muted engine-allow-custom" role="status">
            Custom
          </p>
        )}
      </div>
      {customize ? (
        <div className="engine-allow-switches" role="group" aria-label="Customize">
          {SWITCHES.map((item) => (
            <label key={item.label} className="engine-allow-switch" title={item.detail}>
              <span>{item.label}</span>
              <Switch
                checked={item.on(fields)}
                label={item.label}
                disabled={busy}
                onChange={(on) => setFields(item.set(fields, on))}
              />
            </label>
          ))}
        </div>
      ) : (
        <button type="button" className="engine-text-btn" onClick={() => setCustomize(true)}>
          Customize
        </button>
      )}
      <div className="devices-dialog-actions">
        <button type="button" className="settings-btn" disabled={busy} onClick={() => onAnswer(false)}>
          Not now
        </button>
        <button
          type="button"
          className="settings-btn primary"
          disabled={busy}
          title="You can change this later on its row."
          onClick={() => onAnswer(true, fields)}
        >
          Allow
        </button>
      </div>
    </div>
  )
}
