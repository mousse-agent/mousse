import { isComputerErrorCode } from '../../shared/bridge/computerErrors'
import type { NodeId } from '../../shared/net'
import type { LlmProviderOption } from '../../shared/settings'
import type { Project } from '../../shared/types'
import { routedThreadsOn } from './computers'
import { readDevices, type Device } from './netDevices'
import { localProjectIdOf, workspaceOnOtherComputer, workspaceOnThisComputer, type ComposerWorkspace } from './newThread'

const request = <T>(method: Parameters<typeof window.mousse.platformRequest.request>[0], params: unknown) =>
  window.mousse.platformRequest.request<T>(method, params)

/** What the target answered to a request to open a folder as a project. */
export type OpenRemoteProjectResult = { ok: true; project: Project } | { ok: false; error: string }

/**
 * The user's devices that a new chat can be started on, or none when Net is off or locked, or when the
 * threads of other computers are not routed (a chat for another computer is created through that routing).
 */
export async function readRunOnDevices(): Promise<Device[]> {
  try {
    const { current, nodes } = await readDevices(false)
    return routedThreadsOn(current) ? nodes : []
  } catch {
    return []
  }
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
