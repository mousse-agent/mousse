import type { PermissionMode } from '../permissionMode'
import type { AgentReach, BotLevel, BridgeNodePolicy } from './local'

/**
 * Three ways to set what another computer may do here at once, each a whole set of its per-device fields
 * (`bridge.policy`). Settings, Devices shows them as one control on each computer's row; fields that match none show
 * as Custom, and the single switches and Limits stay as they are. Blocked is left out: it keeps its own control.
 */
export type AccessPresetId = 'view' | 'work' | 'full'

/** The fields that decide Full control here: updating this computer (`checkNodePolicy`) and the engine grant role. */
export interface ControlFields {
  work: boolean
  terminal: boolean
  editor: boolean
  maxPermissionMode: PermissionMode
  agentReach: AgentReach
}

/**
 * Every field a preset sets: the control fields, and the bot level, which a preset sets too but which never decides
 * Full control (lowering a Full control device's bot level changes nothing about its threads, updates or connection).
 */
export interface AccessPresetFields extends ControlFields {
  bots: BotLevel
}

export interface AccessPreset {
  id: AccessPresetId
  label: string
  /** One short phrase for the row. */
  line: string
  /** What the device may then do here, for a tooltip. */
  detail: string
  fields: AccessPresetFields
}

export const ACCESS_PRESETS: readonly AccessPreset[] = [
  {
    id: 'view',
    label: 'View and chat',
    line: 'Reads threads · uses bots',
    detail:
      "Reads threads here and uses this computer's bots, within each bot's own permissions. It can't start, send to, steer or stop threads, see files or Git, open terminals or editors, or set bots up.",
    fields: {
      work: false,
      terminal: false,
      editor: false,
      maxPermissionMode: 'accept_edits',
      agentReach: 'launched',
      bots: 'use'
    }
  },
  {
    id: 'work',
    label: 'Work on threads',
    line: 'Works on threads · no shell',
    detail:
      "Starts and works on threads here up to Auto-accept edits; its agents change only the threads they started. Uses this computer's bots without setting them up. No terminals or editor connections.",
    fields: {
      work: true,
      terminal: false,
      editor: false,
      maxPermissionMode: 'accept_edits',
      agentReach: 'launched',
      bots: 'use'
    }
  },
  {
    id: 'full',
    label: 'Full control',
    line: 'Full access · terminals · editor',
    detail:
      "Works on every thread here in Full access, and its agents may change all threads. Opens terminals and editor connections: shell access as you. Sets up this computer's bots and makes new ones.",
    fields: {
      work: true,
      terminal: true,
      editor: true,
      maxPermissionMode: 'full',
      agentReach: 'all',
      bots: 'full'
    }
  }
]

const CONTROL_KEYS: ReadonlyArray<keyof ControlFields> = ['work', 'terminal', 'editor', 'maxPermissionMode', 'agentReach']

/**
 * The preset `policy`'s control fields match, `custom` when they match none, or undefined for a service that does not
 * report every field a preset sets (one from before the switches). This is what decides Full control (updates, the
 * engine grant role): the bot level is not read, so it never does.
 */
export function accessPresetOf(
  policy: Pick<BridgeNodePolicy, 'terminal' | 'editor' | 'maxPermissionMode' | 'agentReach' | 'work'>
): AccessPresetId | 'custom' | undefined {
  if (policy.work === undefined || policy.agentReach === undefined) return undefined
  const found = ACCESS_PRESETS.find(({ fields }) => CONTROL_KEYS.every((key) => policy[key] === fields[key]))
  return found?.id ?? 'custom'
}

/**
 * The preset a device's row shows: its control fields and its bot level both match one, else `custom` (a Full control
 * device whose bot level was changed on its own shows Custom, and stays Full control for updates and its role). A
 * service that reports no bot level matches on the control fields alone; undefined as `accessPresetOf`.
 */
export function shownPresetOf(
  policy: Pick<BridgeNodePolicy, 'terminal' | 'editor' | 'maxPermissionMode' | 'agentReach' | 'work' | 'bots'>
): AccessPresetId | 'custom' | undefined {
  const control = accessPresetOf(policy)
  if (!control || control === 'custom' || policy.bots === undefined) return control
  return accessPreset(control).fields.bots === policy.bots ? control : 'custom'
}

export const accessPreset = (id: AccessPresetId): AccessPreset =>
  ACCESS_PRESETS.find((preset) => preset.id === id)!
