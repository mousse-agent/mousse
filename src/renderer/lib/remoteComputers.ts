import { isComputerErrorCode } from '../../shared/bridge/computerErrors'
import { describePermissionMode, isPermissionMode, isStricter, narrowPermissionMode, type PermissionMode } from '../../shared/permissionMode'
import type { NodeId } from '../../shared/net'
import type { LlmProviderOption } from '../../shared/settings'
import type { Project } from '../../shared/types'
import { localProjectIdOf, workspaceOnOtherComputer, workspaceOnThisComputer, type ComposerWorkspace } from './newThread'

const request = <T>(method: Parameters<typeof window.mousse.platformRequest.request>[0], params: unknown) =>
  window.mousse.platformRequest.request<T>(method, params)

/** What the target answered to a request to open a folder as a project. */
export type OpenRemoteProjectResult = { ok: true; project: Project } | { ok: false; error: string }

/**
 * Asks another computer to register a folder on it as a project. That computer checks the path
 * and answers `{ ok: false, error }` when it refuses; a connection failure throws.
 */
export async function openRemoteProject(node: NodeId, path: string): Promise<OpenRemoteProjectResult> {
  const value = await request<Partial<OpenRemoteProjectResult> | undefined>('bridge.hub.openProject', { target: node, path })
  if (value && value.ok === true && (value as { project?: Project }).project) return value as OpenRemoteProjectResult
  return { ok: false, error: (value as { error?: string } | undefined)?.error || 'That computer did not open the folder.' }
}

/** Plain words for a failed request to another computer. */
export function remoteErrorMessage(error: unknown, deviceName: string): string {
  const code = (error as { code?: unknown } | null)?.code
  const message = (error as { message?: unknown } | null)?.message
  // The router words its own errors for a person ("<computer> is offline."); they are shown as they are.
  if (isComputerErrorCode(code) && typeof message === 'string' && message) return message
  if (code === 'peer_offline' || code === 'route_unreachable' || code === 'outcome_uncertain') return `${deviceName} is not connected`
  if (code === 'forbidden') return `${deviceName} does not let this computer do that`
  return typeof message === 'string' && message ? message : `Could not reach ${deviceName}`
}

/**
 * The draft after picking where the chat runs. Going to another computer carries the project over
 * only when that computer lists a project for the same Git repository (`sameAs` on its row, which
 * this computer worked out from root commits and remotes); going back restores the project the
 * draft had here. With none, the chat starts without a project; it does not stop the pick.
 */
export function workspaceOnDevice(
  workspace: ComposerWorkspace,
  projects: readonly Pick<Project, 'id' | 'node' | 'sameAs'>[],
  node: NodeId | undefined
): ComposerWorkspace {
  if (!node) return workspaceOnThisComputer(workspace, projects.filter((project) => !project.node))
  const source = localProjectIdOf(workspace)
  const matched = source ? projects.find((project) => project.node === node && project.sameAs === source)?.id : undefined
  return workspaceOnOtherComputer(workspace, node, matched)
}

/** The model a computer would use for a new chat, in the shape `threads.setModel` takes. */
export interface RemoteDefaultModel {
  instanceId?: string
  llmProvider?: string
  model: string
}

/** What a turn written from this computer runs in on the other one: its default mode, and the most it lets this device have. */
export interface RemotePermission {
  defaultMode: PermissionMode
  limit?: PermissionMode
}

/** What another computer's composer offers: its models, the one it would pick by default, and its permission rules for this device. */
export interface RemoteComposerOptions {
  providers: LlmProviderOption[]
  defaultModel: RemoteDefaultModel | null
  /** Absent from a computer that predates it; the window then shows the strictest mode, never a looser one than will run. */
  permission?: RemotePermission
}

/**
 * The permission mode a thread of another computer will run its next turn in, and the most this device may pick
 * there. A thread with a mode of its own has it; one without follows that computer's default, not this one's. The
 * device limit caps both. While that computer's rules are not known the mode is the strictest, since showing a looser
 * one than will run would misreport what the agent may do.
 */
export function remotePermissionView(input: { threadMode?: PermissionMode; permission?: RemotePermission }): { mode: PermissionMode; limit?: PermissionMode } {
  const { permission } = input
  const base = input.threadMode ?? permission?.defaultMode ?? 'ask'
  const limit = permission?.limit
  return { mode: limit ? narrowPermissionMode(base, limit) : base, ...(limit ? { limit } : {}) }
}

/**
 * The highest mode the picker offers: the stricter of a subagent's lineage ceiling and the device limit, with the
 * words that say which one holds it down.
 */
export function remotePermissionCeiling(lineage: PermissionMode | undefined, limit: PermissionMode | undefined, computer: string): { ceiling?: PermissionMode; reason?: string } {
  if (limit === undefined) return lineage === undefined ? {} : { ceiling: lineage }
  if (lineage !== undefined && isStricter(lineage, limit)) return { ceiling: lineage }
  return { ceiling: limit, reason: `${computer} lets this device use ${describePermissionMode(limit)} at most. Raise the limit for this device on ${computer}, in Settings, Devices.` }
}

export async function readRemoteComposerOptions(node: NodeId): Promise<RemoteComposerOptions> {
  const value = await request<Partial<RemoteComposerOptions> | undefined>('bridge.hub.composerOptions', { target: node })
  const permission = value?.permission
  return {
    providers: Array.isArray(value?.providers) ? value.providers : [],
    defaultModel: value?.defaultModel ?? null,
    ...(permission && isPermissionMode(permission.defaultMode)
      ? { permission: { defaultMode: permission.defaultMode, ...(isPermissionMode(permission.limit) ? { limit: permission.limit } : {}) } }
      : {})
  }
}
