import type { NodeId } from '../../shared/net'
import type { LlmProviderOption } from '../../shared/settings'
import type { Project } from '../../shared/types'
import { readDevices, type Device } from './netDevices'
import { workspaceForDevice, type ComposerWorkspace } from './newThread'

const request = <T>(method: Parameters<typeof window.mousse.platformRequest.request>[0], params: unknown) =>
  window.mousse.platformRequest.request<T>(method, params)

/** What the target answered to a request to open a folder as a project. */
export type OpenRemoteProjectResult = { ok: true; project: Project } | { ok: false; error: string }

/** Every device of the signed-in Mousse ID's roster, or none when Net is off or locked. */
export async function readRunOnDevices(): Promise<Device[]> {
  try {
    return (await readDevices(false)).nodes
  } catch {
    return []
  }
}

/** The projects on another computer, as that computer knows them (its own ids and paths). */
export async function readRemoteProjects(node: NodeId): Promise<Project[]> {
  const value = await request<{ projects?: Project[] }>('bridge.hub.projects', { target: node })
  return Array.isArray(value?.projects) ? value.projects : []
}

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
  if (code === 'peer_offline' || code === 'route_unreachable' || code === 'outcome_uncertain') return `${deviceName} is not connected`
  if (code === 'forbidden') return `${deviceName} does not let this computer do that`
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' && message ? message : `Could not reach ${deviceName}`
}

/**
 * The draft after picking where the chat runs: the project carries over only when the picked
 * computer has one at the same path. Reads that computer's projects, so it throws when it
 * cannot be reached.
 */
export async function workspaceOnDevice(
  workspace: ComposerWorkspace,
  shown: readonly Project[],
  local: readonly Project[],
  node: NodeId | undefined
): Promise<ComposerWorkspace> {
  const target = node ? await readRemoteProjects(node) : local
  return workspaceForDevice(workspace, shown, target, node)
}

/** The model a computer would use for a new chat, in the shape `bridge.hub.setModel` takes. */
export interface RemoteDefaultModel {
  instanceId?: string
  llmProvider?: string
  model: string
}

/** What another computer's composer offers: its models, and the one it would pick by default. */
export interface RemoteComposerOptions {
  providers: LlmProviderOption[]
  defaultModel: RemoteDefaultModel | null
}

export async function readRemoteComposerOptions(node: NodeId): Promise<RemoteComposerOptions> {
  const value = await request<Partial<RemoteComposerOptions> | undefined>('bridge.hub.composerOptions', { target: node })
  return {
    providers: Array.isArray(value?.providers) ? value.providers : [],
    defaultModel: value?.defaultModel ?? null
  }
}
