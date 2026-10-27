import type { NodeId } from '../../shared/net'
import type { Thread } from '../../shared/types'
import type { PlatformRequestMethod } from '../../shared/platform'
import type { Device } from './netDevices'
import type { RemoteThreadTarget } from './openRemoteThread'
import { connectedRemoteDevices } from '../components/sideCard/deviceMenu'

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

/** Base64 characters per staged slice; the target accepts at most 48 KiB. */
const STAGE_SLICE_CHARS = 48 * 1024
/** A turn on the other computer can run for hours; this is the longest the hub allows. */
const SEND_DEADLINE_MS = 86_400_000
/** Chat modes the target accepts as plain strings. */
const REMOTE_MODES = new Set(['agent', 'plan', 'build'])

export interface RemoteComposerThread {
  ref: Pick<RemoteThreadTarget, 'nodeId' | 'entityId'>
  deviceName: string
  /**
   * Settles when the first turn ends: with the target's refusal, if it gave one. A rejection
   * means the message may not have been sent. Not awaited by the composer, which has moved on.
   */
  sent: Promise<string | undefined>
}

/** First line of the message, as the name of a thread the target will title itself. */
export function remoteThreadName(content: string): string {
  const line = content.trim().split('\n', 1)[0]?.trim().slice(0, 80)
  return line || 'New chat'
}

/**
 * Starts a chat on another computer from the composer: stages any images, creates the thread in
 * the picked project, attaches to its display stream, and only then sends, so the first turn's
 * events are not lost. Resolves with the thread, or null when the user moved on before it was
 * created. Throws `RemoteNotConnectedError` when the computer is not connected.
 */
export async function startRemoteComposerThread(deps: {
  node: NodeId
  /** The user's devices, read just now. */
  devices: () => Promise<Device[]>
  projectId?: string
  worktreeEnabled: boolean
  content: string
  images: readonly RemoteImage[]
  mode?: string | { type: 'skill'; skillId: string }
  request: Request
  stillVisible: () => boolean
  openRemoteThread: (target: RemoteThreadTarget) => void
  uploadId?: () => string
}): Promise<RemoteComposerThread | null> {
  const devices = await deps.devices()
  const device = devices.find((entry) => entry.node === deps.node && !entry.self)
  const deviceName = device?.name ?? 'That computer'
  if (!device || !connectedRemoteDevices(devices).some((entry) => entry.node === deps.node))
    throw new RemoteNotConnectedError(deviceName)
  if (!deps.stillVisible()) return null

  const uploads: string[] = []
  for (const image of deps.images) {
    const upload = deps.uploadId?.() ?? `up-${crypto.randomUUID()}`
    const total = Math.max(1, Math.ceil(image.data.length / STAGE_SLICE_CHARS))
    for (let index = 0; index < total; index += 1) {
      const staged = await deps.request<{ ok?: boolean; error?: string } | undefined>('bridge.hub.stage', {
        target: deps.node,
        upload,
        index,
        total,
        name: image.name,
        mimeType: image.mimeType,
        data: image.data.slice(index * STAGE_SLICE_CHARS, (index + 1) * STAGE_SLICE_CHARS)
      })
      if (staged?.ok === false) throw new Error(staged.error || `${deviceName} did not accept the image`)
    }
    uploads.push(upload)
  }
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

  // Attach first: the display stream then carries the first turn from its first event.
  await deps.request('bridge.hub.attach', { ref })
  const mode = typeof deps.mode === 'string' ? (REMOTE_MODES.has(deps.mode) ? deps.mode : undefined) : deps.mode
  const sent = deps.request<{ error?: unknown } | undefined>('bridge.hub.send', {
    ref,
    content: deps.content,
    ...(mode ? { mode } : {}),
    ...(uploads.length ? { attachments: uploads } : {}),
    options: { deadlineMs: SEND_DEADLINE_MS }
  }).then((result) => typeof result?.error === 'string' && result.error ? result.error : undefined)
  // A message the target never started is reported by the caller; a still-running turn is not an error.
  deps.openRemoteThread({ ...ref, deviceName, title: remoteThreadName(deps.content) })
  return { ref, deviceName, sent }
}
