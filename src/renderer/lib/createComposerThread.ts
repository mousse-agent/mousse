import type { NodeId } from '../../shared/net'
import type { BridgeRemoteParams } from '../../shared/bridge/types'
import type { PlatformRequestMethod } from '../../shared/platform'
import type { ChatMode, SkillChatMode, Thread } from '../../shared/types'
import { connectedRemoteDevices } from '../components/sideCard/deviceMenu'
import type { Device } from './netDevices'

/** Keep an asynchronous blank-composer creation from overriding later navigation. */
export async function createComposerThread(deps: {
  create: () => Promise<Thread>
  stillVisible: () => boolean
  activate: (thread: Thread) => void
  select: (id: string) => Promise<void>
}): Promise<string | null> {
  const thread = await deps.create()
  if (!deps.stillVisible()) return null
  deps.activate(thread)
  await deps.select(thread.id)
  return deps.stillVisible() ? thread.id : null
}

/** Apply the blank composer's workspace selection before the first send. */
export async function prepareComposerThread(deps: {
  thread?: Thread
  workspace: { projectId?: string; worktreeEnabled: boolean }
  create: (projectId: string | undefined, opts: { worktreeEnabled: boolean }) => Promise<Thread>
  setWorktreeEnabled: (id: string, enabled: boolean) => Promise<Thread>
  update: (thread: Thread) => void
  stillVisible: () => boolean
  activate: (thread: Thread) => void
  select: (id: string) => Promise<void>
}): Promise<string | null> {
  if (!deps.stillVisible()) return null
  const { thread, workspace } = deps
  const enabled = Boolean(workspace.projectId && workspace.worktreeEnabled)
  if (!thread || thread.projectId !== workspace.projectId) {
    return createComposerThread({ ...deps, create: () => deps.create(workspace.projectId, { worktreeEnabled: enabled }) })
  }
  if (Boolean(thread.worktreeEnabled) !== enabled) {
    const updated = await deps.setWorktreeEnabled(thread.id, enabled)
    if (!deps.stillVisible()) return null
    deps.update(updated)
  }
  return deps.stillVisible() ? thread.id : null
}

/** The computer picked for a new chat is not connected right now. */
export class RemoteNotConnectedError extends Error {
  constructor(readonly deviceName: string) {
    super(`${deviceName} is not connected`)
    this.name = 'RemoteNotConnectedError'
  }
}

type Request = <T = unknown>(method: PlatformRequestMethod, params?: unknown) => Promise<T>

/** An image from the composer: raw base64, no `data:` prefix. */
export interface RemoteImage {
  name: string
  mimeType: string
  data: string
}

/** The thread on the other computer, as the remote thread view takes it. */
export interface RemoteThreadTarget {
  nodeId: NodeId
  entityId: string
  deviceName?: string
  title?: string
  /** The project of this computer the thread belongs with, so the sidebar lists it there. */
  localProjectId?: string
}

export interface RemoteComposerThread {
  ref: Pick<RemoteThreadTarget, 'nodeId' | 'entityId'>
  deviceName: string
  /** Settles when the first turn ends. Failures are shown by the remote thread view, not thrown. */
  sent: Promise<void>
}

/** First line of the message, as the name of a thread the target will title itself. */
export function remoteThreadName(content: string): string {
  const line = content.trim().split('\n', 1)[0]?.trim().slice(0, 80)
  return line || 'New chat'
}

/**
 * Starts a chat on another computer from the composer: checks the computer is connected, creates
 * the thread in the picked project with the picked model, opens it in the remote thread view
 * (which attaches to its display stream), then sends the first message through the view, which
 * stages images and keeps the run for Stop. Resolves with the thread, or null when the user moved
 * on before it was created. Throws `RemoteNotConnectedError` when the computer is not connected.
 */
export async function startRemoteComposerThread(deps: {
  node: NodeId
  /** The user's devices, read just now. */
  devices: () => Promise<Device[]>
  projectId?: string
  /** The draft's project on this computer; it counts only when `projectId` is that project's match. */
  localProjectId?: string
  worktreeEnabled: boolean
  content: string
  images: readonly RemoteImage[]
  /** Only a skill mode travels; the built-in modes are not offered for another computer. */
  mode?: ChatMode
  /** The model picked for the chat, from the target's own list; its default applies without one. */
  model?: BridgeRemoteParams['threads.setModel']['model']
  /** Why the target cannot take these images, or an empty string. */
  imageProblem: (images: readonly RemoteImage[]) => string
  request: Request
  stillVisible: () => boolean
  openRemoteThread: (target: RemoteThreadTarget) => void
  submit: (ref: RemoteComposerThread['ref'], input: { content: string; images: readonly RemoteImage[]; mode?: SkillChatMode }) => Promise<void>
}): Promise<RemoteComposerThread | null> {
  const devices = await deps.devices()
  const device = devices.find((entry) => entry.node === deps.node && !entry.self)
  const deviceName = device?.name ?? 'That computer'
  if (!device || !connectedRemoteDevices(devices).some((entry) => entry.node === deps.node))
    throw new RemoteNotConnectedError(deviceName)
  const problem = deps.imageProblem(deps.images)
  if (problem) throw new Error(problem)
  if (!deps.stillVisible()) return null

  const created = await deps.request<{ thread?: { id?: string } }>('bridge.hub.create', {
    target: deps.node,
    name: remoteThreadName(deps.content),
    ...(deps.projectId ? { projectId: deps.projectId } : {}),
    options: { worktreeEnabled: Boolean(deps.projectId && deps.worktreeEnabled) }
  })
  const entityId = created?.thread?.id
  if (!entityId) throw new Error(`${deviceName} did not create the chat`)
  const ref = { nodeId: deps.node, entityId }
  if (!deps.stillVisible()) return null

  if (deps.model) {
    const picked = await deps.request<{ ok?: boolean; error?: string } | undefined>('bridge.hub.setModel', { ref, model: deps.model })
    if (picked?.ok === false) throw new Error(picked.error || `${deviceName} did not accept that model`)
  }
  // Opening attaches to the thread's display; the first message goes right after, so its events arrive.
  deps.openRemoteThread({
    ...ref,
    deviceName,
    title: remoteThreadName(deps.content),
    ...(deps.projectId && deps.localProjectId ? { localProjectId: deps.localProjectId } : {})
  })
  const mode = deps.mode && typeof deps.mode === 'object' ? deps.mode : undefined
  const sent = deps.submit(ref, { content: deps.content, images: deps.images, ...(mode ? { mode } : {}) })
  return { ref, deviceName, sent }
}
