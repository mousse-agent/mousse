import type { NodeId } from '../../../shared/net'
import { worksOnThreads, type Device } from '../../lib/netDevices'
import type { ComposerWorkspace } from '../../lib/newThread'

export const LOCAL_DEVICE_FALLBACK_NAME = 'This computer'

/** The id of the row for this computer; every other row is the device's node id. */
export const LOCAL_RUN_ON_ID = 'local'

export type WorkspaceChoice = 'checkout' | 'worktree'

export interface RunOnOption {
  id: string
  name: string
  /** Where the thread will run. */
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
  /** This computer first, then each connected computer. Null with no other computer to pick. */
  runOn: RunOnOption[] | null
  workspace: WorkspaceOption[]
}

/** Name shown for this computer. */
export function localDeviceName(deviceName: string | undefined | null): string {
  return deviceName?.trim() || LOCAL_DEVICE_FALLBACK_NAME
}

/**
 * Computers other than this one that are connected right now. A phone cannot run a thread, so
 * it is left out; a device from a daemon that predates `kind` counts as a computer.
 */
export function connectedRemoteDevices(devices: readonly Device[]): Device[] {
  return devices.filter(
    (device) => !device.self && !device.revoked && device.state === 'open' && device.kind !== 'phone'
  )
}

/** The device a draft names, connected or not, so a stale pick can still be named. */
export function deviceForNode(devices: readonly Device[], node: NodeId | undefined): Device | undefined {
  return node ? devices.find((device) => device.node === node && !device.self) : undefined
}

/** Name on the computer button: the picked computer, or this one. */
export function runOnLabel(localName: string, devices: readonly Device[], node: NodeId | undefined): string {
  return node ? deviceForNode(devices, node)?.name ?? 'Unavailable computer' : localName
}

/**
 * Why no other computer can be picked: routing asks for this computer's own grant to work on threads, which only the
 * computer that manages the user's devices can give. The other computers are not asked to grant anything.
 */
export function thisComputerLacksGrant(localName: string): string {
  return `${localName} cannot work on threads on other computers yet. Turn on Works on threads for ${localName} in Settings, Devices, on the computer that manages your devices.`
}

/** Why a computer that stopped sharing cannot be picked: its owner switch is off, or it blocked this computer. */
export function notSharingReason(name: string): string {
  return `${name} is not sharing its threads with this computer. Turn on "Let my other computers work on this computer's threads" on ${name}, in Settings, Devices, or unblock this computer there.`
}

/** The Run on rows: this computer first, then each connected computer, with the picked one active. */
export function buildRunOnOptions(input: {
  localName: string
  devices: readonly Device[]
  node?: NodeId
  /** Computers whose rows say they stopped sharing their threads with this one. */
  notSharing?: ReadonlySet<string>
}): RunOnOption[] {
  const remote = connectedRemoteDevices(input.devices)
  // Routing checks the caller's own grant (this computer's row of `bridge.nodes`); a list without this row is from an older daemon.
  const self = input.devices.find((device) => device.self)
  const granted = !self || worksOnThreads(self)
  return [
    { id: LOCAL_RUN_ON_ID, name: input.localName, active: !input.node, disabled: false },
    ...remote.map((device): RunOnOption => {
      const active = device.node === input.node
      // A pick that is already made stays, so a person can see where the chat runs and leave it.
      if (active) return { id: device.node, name: device.name, active, disabled: false }
      if (!granted) return { id: device.node, name: device.name, active, disabled: true, reason: thisComputerLacksGrant(input.localName) }
      if (input.notSharing?.has(device.node)) return { id: device.node, name: device.name, active, disabled: true, reason: notSharingReason(device.name) }
      return { id: device.node, name: device.name, active, disabled: false }
    })
  ]
}

/**
 * Whether a computer can be picked at all: another one is connected, or the draft already names
 * one (which may have dropped offline, and then needs a way back to this computer).
 */
export function canPickComputer(devices: readonly Device[], node: NodeId | undefined): boolean {
  return Boolean(node) || connectedRemoteDevices(devices).length > 0
}

/** The workspace choice a draft stands for. A worktree needs a project, as in the composer toolbar. */
export function activeWorkspaceChoice(workspace: ComposerWorkspace): WorkspaceChoice {
  return workspace.projectId && workspace.worktreeEnabled ? 'worktree' : 'checkout'
}

/** The draft to store when a choice is picked; the project and the computer are kept. */
export function workspaceDraftForChoice(workspace: ComposerWorkspace, choice: WorkspaceChoice): ComposerWorkspace {
  return {
    projectId: workspace.projectId,
    worktreeEnabled: choice === 'worktree',
    ...(workspace.node ? { node: workspace.node } : {}),
    ...(workspace.localProjectId ? { localProjectId: workspace.localProjectId } : {})
  }
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

/** Rows of the new-thread menu: where it runs, and whether it starts in a new worktree. */
export function buildDeviceMenu(input: {
  localName: string
  devices: readonly Device[]
  workspace: ComposerWorkspace
  notSharing?: ReadonlySet<string>
}): DeviceMenuModel {
  const hasProject = Boolean(input.workspace.projectId)
  const choice = activeWorkspaceChoice(input.workspace)
  const noProject = hasProject ? undefined : 'Needs a project'
  return {
    runOn: canPickComputer(input.devices, input.workspace.node)
      ? buildRunOnOptions({ localName: input.localName, devices: input.devices, node: input.workspace.node, notSharing: input.notSharing })
      : null,
    workspace: [
      { id: 'checkout', label: 'Current checkout', active: choice === 'checkout', disabled: !hasProject, reason: noProject },
      { id: 'worktree', label: 'New worktree', active: choice === 'worktree', disabled: !hasProject, reason: noProject }
    ]
  }
}
