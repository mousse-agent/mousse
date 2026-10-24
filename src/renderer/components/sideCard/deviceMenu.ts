import type { Device } from '../../lib/netDevices'
import type { ComposerWorkspace } from '../../lib/newThread'

export const LOCAL_DEVICE_FALLBACK_NAME = 'This computer'

const REMOTE_NOT_AVAILABLE = 'Not available yet'

export type WorkspaceChoice = 'checkout' | 'worktree'

export interface RunOnOption {
  id: string
  name: string
  /** Where the thread will run; only this computer today. */
  active: boolean
  disabled: boolean
  /** Why the row cannot be picked; shown as its tooltip and accessible name, not as text. */
  reason?: string
}

export interface WorkspaceOption {
  id: WorkspaceChoice
  label: string
  active: boolean
  disabled: boolean
  reason?: string
}

export interface DeviceMenuModel {
  /** Null when no other device is connected, so the whole group is left out. */
  runOn: RunOnOption[] | null
  /** One muted line under the Run on group when some of its rows are dimmed. */
  runOnNote?: string
  workspace: WorkspaceOption[]
}

/** Name shown for this computer. */
export function localDeviceName(deviceName: string | undefined | null): string {
  return deviceName?.trim() || LOCAL_DEVICE_FALLBACK_NAME
}

/** Devices other than this one that are connected right now. */
export function connectedRemoteDevices(devices: readonly Device[]): Device[] {
  return devices.filter((device) => !device.self && !device.revoked && device.state === 'open')
}

/** The workspace choice a draft stands for. A worktree needs a project, as in the composer toolbar. */
export function activeWorkspaceChoice(workspace: ComposerWorkspace): WorkspaceChoice {
  return workspace.projectId && workspace.worktreeEnabled ? 'worktree' : 'checkout'
}

/** The draft to store when a choice is picked; the project is kept. */
export function workspaceDraftForChoice(workspace: ComposerWorkspace, choice: WorkspaceChoice): ComposerWorkspace {
  return { projectId: workspace.projectId, worktreeEnabled: choice === 'worktree' }
}

/** True when at least one row would change something if picked. */
export function hasDeviceChoices(model: DeviceMenuModel): boolean {
  return model.workspace.some((option) => !option.disabled) ||
    (model.runOn ?? []).some((option) => !option.disabled && !option.active)
}

/** Accessible name of a row: its label, plus why it is unavailable. */
export function menuRowLabel(label: string, reason: string | undefined): string {
  return reason ? `${label}, ${reason.toLowerCase()}` : label
}

/**
 * Rows of the new-thread menu. Other devices are listed but cannot be picked
 * yet, because a thread can only start on this computer.
 */
export function buildDeviceMenu(input: {
  localName: string
  devices: readonly Device[]
  workspace: ComposerWorkspace
}): DeviceMenuModel {
  const remote = connectedRemoteDevices(input.devices)
  const hasProject = Boolean(input.workspace.projectId)
  const choice = activeWorkspaceChoice(input.workspace)
  const noProject = hasProject ? undefined : 'Needs a project'
  return {
    runOnNote: remote.length === 0 ? undefined : REMOTE_NOT_AVAILABLE,
    runOn: remote.length === 0 ? null : [
      { id: 'local', name: input.localName, active: true, disabled: false },
      ...remote.map((device) => ({
        id: device.node,
        name: device.name,
        active: false,
        disabled: true,
        reason: REMOTE_NOT_AVAILABLE
      }))
    ],
    workspace: [
      { id: 'checkout', label: 'Current checkout', active: choice === 'checkout', disabled: !hasProject, reason: noProject },
      { id: 'worktree', label: 'New worktree', active: choice === 'worktree', disabled: !hasProject, reason: noProject }
    ]
  }
}
