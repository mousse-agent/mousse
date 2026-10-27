import { create } from 'zustand'
import {
  BridgeDisplayDecoder,
  REMOTE_ATTACHMENT_CHUNK_CHARS,
  REMOTE_ATTACHMENT_MAX_CHARS,
  REMOTE_ATTACHMENT_MIME,
  REMOTE_MAX_ATTACHMENTS,
  type BridgeEntityRef
} from '../../shared/bridge'
import { newId, type NodeId, type RpcId } from '../../shared/net'
import type { PlatformRequestMethod } from '../../shared/platform'
import type { LlmProviderOption } from '../../shared/settings'
import type { SkillChatMode } from '../../shared/types'
import { remoteDisplay, type RemoteView } from '../services/remoteThreadDisplay'
import { useAppStore } from '../stores/appStore'
import { readDevices } from './netDevices'

/** What the app says wherever a thread on another computer cannot do what a local one can. */
export const REMOTE_UNSUPPORTED = 'Not available for threads on another computer'

export type RemoteUnsupportedAction = 'terminal' | 'files' | 'git' | 'panel' | 'questions'

/** The message for an action a remote thread cannot do here, with where the user can do it instead. */
export function remoteUnsupported(action: RemoteUnsupportedAction, device?: string): { title: string; detail: string } {
  const where = device ?? 'the other computer'
  const detail = action === 'questions'
    ? `Answer the agent's question on ${where}.`
    : action === 'panel'
      ? `Terminal, files and Git for this thread are on ${where}.`
      : `The ${action === 'git' ? 'Git changes' : action === 'files' ? 'files' : 'terminal'} of this thread are on ${where}.`
  return { title: REMOTE_UNSUPPORTED, detail }
}

/** A turn can run as long as a local one; the hub waits this long for a send to finish. */
const SEND_DEADLINE_MS = 30 * 60_000

const request = <T>(method: PlatformRequestMethod, params: unknown) =>
  window.mousse.platformRequest.request<T>(method, params)
const messageOf = (cause: unknown): string => String((cause as { message?: unknown } | null)?.message ?? cause)

// ── Attach and detach, shared by every view of one remote thread ────────────────────────────────

// Serialize attachment and final detachment for repeated mounts of one display.
const attachments = new Map<string, { users: number; tail: Promise<unknown> }>()

export interface RemoteWatchHandlers {
  /** A complete, verified display (a snapshot, or an update on top of one). */
  view(view: RemoteView): void
  /** The display failed or could not be attached; the last view is no longer current. */
  error(message: string): void
}

/**
 * Attaches this window to a remote thread's display and decodes its events until the returned
 * function runs. Views of the same thread share one attachment: the last to leave detaches it.
 * Nothing is detached when the profile changed meanwhile, because the daemon closes that
 * profile's attachments itself.
 */
export function watchRemoteThread(ref: BridgeEntityRef, handlers: RemoteWatchHandlers): () => void {
  const { nodeId, entityId } = ref
  const profile = useAppStore.getState().profileId
  const key = JSON.stringify([profile, nodeId, entityId])
  const identity = { nodeId, entityId }
  let active = true
  let current: RemoteView | undefined
  const decoder = new BridgeDisplayDecoder({ ref: identity })
  const held = attachments.get(key) ?? { users: 0, tail: Promise.resolve() }
  attachments.set(key, held)
  held.users++
  const fail = (cause: unknown) => {
    if (!active) return
    current = undefined
    handlers.error(messageOf(cause))
  }
  const off = window.mousse.bridge.onThreadPart((part) => {
    if (!active || part.ref.nodeId !== nodeId || part.ref.entityId !== entityId) return
    void decoder.accept(part).then((event) => {
      if (!active || !event) return
      try {
        current = remoteDisplay(current, event)
        if (current) handlers.view(current)
      } catch (cause) {
        fail(cause)
      }
    }, fail)
  })
  const attaching = held.tail
    .catch(() => undefined)
    .then(() => (active ? request('bridge.hub.attach', { ref: identity }) : undefined))
  held.tail = attaching
  void attaching.catch(fail)
  return () => {
    active = false
    off()
    decoder.close()
    held.users--
    const closing = held.tail
      .catch(() => undefined)
      .then(async () => {
        if (held.users || useAppStore.getState().profileId !== profile) return
        await request('bridge.hub.detach', { ref: identity })
      })
      .catch(() => undefined)
      .finally(() => {
        if (!held.users && attachments.get(key) === held && held.tail === closing) attachments.delete(key)
      })
    held.tail = closing
  }
}

// ── Remote threads the main thread area can show ────────────────────────────────────────────────

/** The target's composer choices (`composer.options`), as the model picker needs them. */
export interface RemoteComposerOptions {
  providers: LlmProviderOption[]
  defaultModel: { instanceId?: string; llmProvider: string; model: string } | null
  skills: Array<{ id: string; name: string; description: string }>
}

export interface RemoteThreadEntry {
  key: string
  ref: BridgeEntityRef
  /** The computer the thread runs on, as the user knows it. */
  deviceName?: string
  title?: string
  /** The project of this computer the thread is listed under in the sidebar, if any. */
  localProjectId?: string
  view?: RemoteView
  /** A verified display arrived on the current attachment. */
  live: boolean
  error: string
  /** A message of this window is still running on the target. */
  sending: boolean
  /** Id of that message's request: the run that Stop and steering name. */
  run?: RpcId
  notice: string
  options?: RemoteComposerOptions
  /** Bumped to attach again. */
  attachment: number
}

interface RemoteThreadsState {
  entries: Record<string, RemoteThreadEntry>
  /** Attachment order, oldest first. */
  order: string[]
  /** The remote thread the main thread area shows, if any. */
  activeKey: string | null
}

export const useRemoteThreads = create<RemoteThreadsState>(() => ({ entries: {}, order: [], activeKey: null }))

export const remoteThreadKey = (ref: BridgeEntityRef): string => `${ref.nodeId}:${ref.entityId}`

const watchers = new Map<string, () => void>()
let unsubscribeApp: (() => void) | undefined
let activeThreadAtSelection: string | null = null

function patch(key: string, change: Partial<RemoteThreadEntry> | ((entry: RemoteThreadEntry) => Partial<RemoteThreadEntry>)): void {
  useRemoteThreads.setState((state) => {
    const entry = state.entries[key]
    if (!entry) return state
    const next = typeof change === 'function' ? change(entry) : change
    return { ...state, entries: { ...state.entries, [key]: { ...entry, ...next } } }
  })
}

function attach(key: string): void {
  watchers.get(key)?.()
  const entry = useRemoteThreads.getState().entries[key]
  if (!entry) return
  patch(key, { live: false, error: '' })
  watchers.set(key, watchRemoteThread(entry.ref, {
    view: (view) => patch(key, { view, live: true, error: '' }),
    error: (error) => patch(key, { view: undefined, live: false, error })
  }))
}

/** Leaves the remote thread view when the app moves to a local thread or another profile. */
function followApp(): void {
  if (unsubscribeApp) return
  let profile = useAppStore.getState().profileId
  unsubscribeApp = useAppStore.subscribe((state) => {
    if (state.profileId !== profile) {
      profile = state.profileId
      resetRemoteThreads()
    } else if (state.activeThreadId !== activeThreadAtSelection) {
      clearRemoteSelection()
    }
  })
}

/**
 * Makes a remote thread the one the main thread area shows, attaching to its display if this
 * window is not attached yet. `run` is the request id of a message already sent to it, so Stop
 * and steering can name that run.
 */
export function openRemoteThread(
  ref: { nodeId: NodeId; entityId: string; deviceName?: string; title?: string; localProjectId?: string; run?: RpcId }
): void {
  followApp()
  const identity = { nodeId: ref.nodeId, entityId: ref.entityId }
  const key = remoteThreadKey(identity)
  const { deviceName, title, localProjectId, run } = ref
  activeThreadAtSelection = useAppStore.getState().activeThreadId
  const existing = useRemoteThreads.getState().entries[key]
  if (existing) {
    patch(key, {
      ...(deviceName ? { deviceName } : {}),
      ...(title ? { title } : {}),
      ...(localProjectId ? { localProjectId } : {}),
      ...(run ? { run, sending: true } : {})
    })
    useRemoteThreads.setState({ activeKey: key })
    return
  }
  useRemoteThreads.setState((state) => ({
    entries: {
      ...state.entries,
      [key]: {
        key, ref: identity, deviceName, title, localProjectId, live: false, error: '', sending: !!run, run, notice: '', attachment: 0
      }
    },
    order: [...state.order, key],
    activeKey: key
  }))
  attach(key)
  void loadComposerOptions(key)
  if (!deviceName) void nameDevice(key)
}

async function nameDevice(key: string): Promise<void> {
  try {
    const entry = useRemoteThreads.getState().entries[key]
    const { nodes } = await readDevices(false)
    const name = nodes.find((node) => node.node === entry?.ref.nodeId)?.name
    if (name) patch(key, { deviceName: name })
  } catch {
    // The thread still works; the side card falls back to a generic name.
  }
}

/** Shows an attached remote thread again (a sidebar row was clicked). */
export function selectRemoteThread(key: string): void {
  if (!useRemoteThreads.getState().entries[key]) return
  followApp()
  activeThreadAtSelection = useAppStore.getState().activeThreadId
  useRemoteThreads.setState({ activeKey: key })
}

/** The main thread area goes back to the local threads; remote threads stay attached. */
export function clearRemoteSelection(): void {
  if (useRemoteThreads.getState().activeKey !== null) useRemoteThreads.setState({ activeKey: null })
}

/** Detaches from a remote thread and removes it from the sidebar. */
export function closeRemoteThread(key: string): void {
  watchers.get(key)?.()
  watchers.delete(key)
  useRemoteThreads.setState((state) => {
    if (!state.entries[key]) return state
    const { [key]: _closed, ...entries } = state.entries
    return { entries, order: state.order.filter((entry) => entry !== key), activeKey: state.activeKey === key ? null : state.activeKey }
  })
}

/** Drops every remote thread without detaching: the profile they were attached under is gone. */
export function resetRemoteThreads(): void {
  for (const stop of watchers.values()) stop()
  watchers.clear()
  useRemoteThreads.setState({ entries: {}, order: [], activeKey: null })
}

/** Attaches to the display again, for a thread that went stale or failed. */
export function refreshRemoteThread(key: string): void {
  if (!useRemoteThreads.getState().entries[key]) return
  patch(key, (entry) => ({ attachment: entry.attachment + 1 }))
  attach(key)
}

// ── Composer options and model ──────────────────────────────────────────────────────────────────

async function loadComposerOptions(key: string): Promise<void> {
  const entry = useRemoteThreads.getState().entries[key]
  if (!entry) return
  try {
    const options = await request<Partial<RemoteComposerOptions>>('bridge.hub.composerOptions', {
      target: entry.ref.nodeId,
      threadId: entry.ref.entityId
    })
    patch(key, {
      options: {
        providers: Array.isArray(options?.providers) ? options.providers : [],
        defaultModel: options?.defaultModel ?? null,
        skills: Array.isArray(options?.skills) ? options.skills : []
      }
    })
  } catch {
    // The picker stays empty; sending still works with the target's own default model.
  }
}

/** Sets the model of a remote thread on the target; the picker follows the display's update. */
export async function setRemoteModel(key: string, model: { instanceId?: string; llmProvider?: string; model: string }): Promise<void> {
  const entry = useRemoteThreads.getState().entries[key]
  if (!entry) return
  try {
    const result = await request<{ ok?: boolean; error?: string }>('bridge.hub.setModel', { ref: entry.ref, model })
    if (result?.ok === false) patch(key, { notice: result.error ?? 'The model could not be changed.' })
  } catch (cause) {
    patch(key, { notice: messageOf(cause) })
  }
}

// ── Send, steer and stop ────────────────────────────────────────────────────────────────────────

export interface RemoteImage {
  name: string
  mimeType: string
  /** Raw base64 without a `data:` prefix. */
  data: string
}

/** The pieces one staged image is uploaded in. */
export function imageChunks(data: string): string[] {
  const chunks: string[] = []
  for (let start = 0; start < data.length; start += REMOTE_ATTACHMENT_CHUNK_CHARS) {
    chunks.push(data.slice(start, start + REMOTE_ATTACHMENT_CHUNK_CHARS))
  }
  return chunks
}

/** Why the target cannot take these images, or an empty string when it can. */
export function remoteImageProblem(images: readonly RemoteImage[]): string {
  if (images.length > REMOTE_MAX_ATTACHMENTS) return `Attach at most ${REMOTE_MAX_ATTACHMENTS} images.`
  for (const image of images) {
    if (!REMOTE_ATTACHMENT_MIME.test(image.mimeType)) return `${image.name} is not a supported image.`
    if (image.data.length > REMOTE_ATTACHMENT_MAX_CHARS) return `${image.name} is too large.`
  }
  return ''
}

async function stageImages(target: NodeId, images: readonly RemoteImage[]): Promise<string[]> {
  const uploads: string[] = []
  for (const image of images) {
    const upload = crypto.randomUUID().replaceAll('-', '')
    const chunks = imageChunks(image.data)
    for (const [index, data] of chunks.entries()) {
      const result = await request<{ ok?: boolean; error?: string }>('bridge.hub.stageAttachment', {
        target, upload, index, total: chunks.length, name: image.name, mimeType: image.mimeType, data
      })
      if (result?.ok === false) throw new Error(result.error ?? 'The image could not be uploaded.')
    }
    uploads.push(upload)
  }
  return uploads
}

/** A send that has not finished shows as running; its own failure is shown, not thrown. */
function isRunning(entry: RemoteThreadEntry): boolean {
  return entry.sending || entry.view?.active === true
}

/** The run of the one message this window has running on a computer, when the thread did not record it. */
async function findRun(entry: RemoteThreadEntry): Promise<RpcId | undefined> {
  try {
    const rows = await request<Array<{ id: RpcId; method: string; state: string }>>('bridge.hub.requests', { target: entry.ref.nodeId })
    const running = rows.filter((row) => row.method === 'orchestrator.send' && row.state === 'unknown')
    return running.length === 1 ? running[0]!.id : undefined
  } catch {
    return undefined
  }
}

export interface RemoteSubmit {
  content: string
  images?: readonly RemoteImage[]
  mode?: SkillChatMode
}

/**
 * The composer's Send on a remote thread. While the target is working, the text goes to the
 * running turn as a steer (the target keeps no separate queue for this window); otherwise it
 * starts a turn. Resolves when the turn ends or fails; failures are put on the entry.
 */
export async function submitRemoteMessage(key: string, input: RemoteSubmit): Promise<void> {
  const entry = useRemoteThreads.getState().entries[key]
  if (!entry) return
  const images = input.images ?? []
  patch(key, { notice: '', error: '' })
  if (isRunning(entry)) {
    if (images.length) return patch(key, { notice: 'Images can only be added when a turn starts.' })
    const run = entry.run ?? await findRun(entry)
    if (!run) return patch(key, { notice: `This turn was started on ${entry.deviceName ?? 'another computer'}. Wait for it to finish, then send.` })
    try {
      const result = await request<{ ok?: boolean }>('bridge.hub.steer', { ref: entry.ref, run, text: input.content })
      patch(key, { notice: result?.ok === false ? 'The turn had already finished.' : '' })
    } catch (cause) {
      patch(key, { notice: messageOf(cause) })
    }
    return
  }
  const problem = remoteImageProblem(images)
  if (problem) return patch(key, { notice: problem })
  const run = newId('rpc')
  patch(key, { sending: true, run })
  try {
    const uploads = images.length ? await stageImages(entry.ref.nodeId, images) : []
    const result = await request<{ error?: string } | undefined>('bridge.hub.send', {
      ref: entry.ref,
      content: input.content,
      ...(input.mode ? { mode: input.mode } : {}),
      ...(uploads.length ? { attachments: uploads } : {}),
      options: { id: run, deadlineMs: SEND_DEADLINE_MS }
    })
    if (result?.error) patch(key, { notice: result.error })
  } catch (cause) {
    patch(key, { notice: messageOf(cause) })
  } finally {
    patch(key, (current) => (current.run === run ? { sending: false, run: undefined } : {}))
  }
}

/** Stops the running turn on the target. */
export async function abortRemoteTurn(key: string): Promise<void> {
  const entry = useRemoteThreads.getState().entries[key]
  if (!entry) return
  const run = entry.run ?? await findRun(entry)
  try {
    const result = await request<{ ok?: boolean }>('bridge.hub.abort', { ref: entry.ref, run: run ?? newId('rpc') })
    if (result?.ok === false) patch(key, { notice: 'That turn is running on the other computer and cannot be stopped from here.' })
  } catch (cause) {
    patch(key, { notice: messageOf(cause) })
  }
}

export function setRemoteNotice(key: string, notice: string): void {
  patch(key, { notice })
}
