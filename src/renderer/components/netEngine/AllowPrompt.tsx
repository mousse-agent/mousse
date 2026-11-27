import { useState } from 'react'
import {
  ACCESS_PRESETS,
  accessPreset,
  shownPresetOf,
  type AccessPresetFields
} from '../../../shared/net/accessPresets'
import type { NetEngineApproval } from '../../../shared/netEngine/local'
import { Switch } from '../settings/SettingsRow'
import { ChoiceRow } from './pairingParts'

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
 * What a device may do here: the three presets (Work on threads first picked), each its name over what it does, and
 * Customize, which opens the single switches. Used where a device is let in (Allow) and where a Send link is made.
 */
export function LevelPicker({
  fields,
  onChange,
  busy
}: {
  fields: AccessPresetFields
  onChange: (fields: AccessPresetFields) => void
  busy: boolean
}) {
  const [customize, setCustomize] = useState(false)
  const picked = shownPresetOf(fields)
  return (
    <>
      <div className="engine-choice-list" role="radiogroup" aria-label="Access">
        {ACCESS_PRESETS.map((preset) => (
          <ChoiceRow
            key={preset.id}
            selected={picked === preset.id}
            disabled={busy}
            label={preset.label}
            detail={preset.line}
            title={preset.detail}
            onPick={() => onChange({ ...accessPreset(preset.id).fields })}
          />
        ))}
      </div>
      {picked === 'custom' && (
        <p className="settings-muted engine-allow-custom" role="status">
          Custom
        </p>
      )}
      {customize ? (
        <div className="engine-allow-switches" role="group" aria-label="Customize">
          {SWITCHES.map((item) => (
            <label key={item.label} className="engine-allow-switch" title={item.detail}>
              <span>{item.label}</span>
              <Switch
                checked={item.on(fields)}
                label={item.label}
                disabled={busy}
                onChange={(on) => onChange(item.set(fields, on))}
              />
            </label>
          ))}
        </div>
      ) : (
        <p className="engine-hint">
          <button type="button" className="engine-text-btn" onClick={() => setCustomize(true)}>
            Customize
          </button>{' '}
          · You can change or remove it later.
        </p>
      )}
    </>
  )
}

/** A preset's fields, to start a level from. */
export const defaultLevel = (): AccessPresetFields => ({ ...accessPreset('work').fields })

/**
 * "Let <name> use this computer?" on the computer that showed the code: what it may do here, then Not now or Allow.
 * The level is saved before the device is let in.
 */
export function AllowPrompt({
  approval,
  busy,
  onAnswer,
  line
}: {
  approval: Pick<NetEngineApproval, 'name'>
  busy: boolean
  onAnswer: (yes: boolean, access?: AccessPresetFields) => void
  /** One line under the question (a paired computer: how it connects). */
  line?: string
}) {
  const [fields, setFields] = useState<AccessPresetFields>(defaultLevel)
  const name = approval.name || 'This device'
  return (
    <div className="engine-allow" role="group" aria-label="Pairing request" data-mousse-decision="">
      <p className="engine-allow-title">Let {name} use this computer?</p>
      {line && <p className="settings-muted">{line}</p>}
      <LevelPicker fields={fields} onChange={setFields} busy={busy} />
      <div className="devices-dialog-actions">
        <button type="button" className="settings-btn" disabled={busy} onClick={() => onAnswer(false)}>
          Not now
        </button>
        <button
          type="button"
          className="settings-btn ui-btn-primary"
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
