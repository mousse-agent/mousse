import type { Device } from '../../lib/netDevices'
import type { ComposerWorkspace } from '../../lib/newThread'

export const LOCAL_DEVICE_FALLBACK_NAME = 'This computer'

export type WorkspaceChoice = 'checkout' | 'worktree'

export interface RunOnOption {
  id: string
  name: string
  /** Where the thread will run; only this computer today. */
  active: boolean
  disabled: boolean
  /** Muted text beside the name. */
  hint?: string
}

export interface WorkspaceOption {
  id: WorkspaceChoice
  label: string
  active: boolean
  disabled: boolean
  hint?: string
}

export interface DeviceMenuModel {
  /** Null when no other device is connected, so the whole group is left out. */
  runOn: RunOnOption[] | null
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
    runOn: remote.length === 0 ? null : [
      { id: 'local', name: input.localName, active: true, disabled: false },
      ...remote.map((device) => ({
        id: device.node,
        name: device.name,
        active: false,
        disabled: true,
        hint: 'Not available yet'
      }))
    ],
    workspace: [
      { id: 'checkout', label: 'Current checkout', active: choice === 'checkout', disabled: !hasProject, hint: noProject },
      { id: 'worktree', label: 'New worktree', active: choice === 'worktree', disabled: !hasProject, hint: noProject }
    ]
  }
}
