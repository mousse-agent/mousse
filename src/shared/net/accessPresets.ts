import type { PermissionMode } from '../permissionMode'
import type { AgentReach, BridgeNodePolicy } from './local'

/**
 * Three ways to set what another computer may do here at once, each a whole set of its per-device fields
 * (`bridge.policy`). Settings, Devices shows them as one control on each computer's row; fields that match none show
 * as Custom, and the single switches and Limits stay as they are. Blocked and Bots on this computer are left out:
 * they keep their own controls.
 */
export type AccessPresetId = 'view' | 'work' | 'full'

export interface AccessPresetFields {
  work: boolean
  terminal: boolean
  editor: boolean
  maxPermissionMode: PermissionMode
  agentReach: AgentReach
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
    line: 'Reads threads · chats with bots',
    detail:
      "Reads threads here and chats with this computer's bots, within each bot's own permissions. It can't start, send to, steer or stop threads, see files or Git, open terminals or editors, or make or change bots.",
    fields: {
      work: false,
      terminal: false,
      editor: false,
      maxPermissionMode: 'accept_edits',
      agentReach: 'launched'
    }
  },
  {
    id: 'work',
    label: 'Work on threads',
    line: 'Works on threads · no shell',
    detail:
      'Starts and works on threads here up to Auto-accept edits; its agents change only the threads they started. No terminals or editor connections.',
    fields: {
      work: true,
      terminal: false,
      editor: false,
      maxPermissionMode: 'accept_edits',
      agentReach: 'launched'
    }
  },
  {
    id: 'full',
    label: 'Full control',
    line: 'Full access · terminals · editor',
    detail:
      'Works on every thread here in Full access, and its agents may change all threads. Opens terminals and editor connections: shell access as you.',
    fields: {
      work: true,
      terminal: true,
      editor: true,
      maxPermissionMode: 'full',
      agentReach: 'all'
    }
  }
]

/**
 * The preset `policy` matches, `custom` when it matches none, or undefined for a service that does not report every
 * field a preset sets (one from before the switches), which shows no preset.
 */
export function accessPresetOf(
  policy: Pick<BridgeNodePolicy, 'terminal' | 'editor' | 'maxPermissionMode' | 'agentReach' | 'work'>
): AccessPresetId | 'custom' | undefined {
  if (policy.work === undefined || policy.agentReach === undefined) return undefined
  const found = ACCESS_PRESETS.find(({ fields }) =>
    (Object.keys(fields) as Array<keyof AccessPresetFields>).every(
      (key) => policy[key] === fields[key]
    )
  )
  return found?.id ?? 'custom'
}

export const accessPreset = (id: AccessPresetId): AccessPreset =>
  ACCESS_PRESETS.find((preset) => preset.id === id)!
