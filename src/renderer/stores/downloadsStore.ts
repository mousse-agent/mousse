import { create } from 'zustand'
import { LOCAL_STT_MODELS } from '../../shared/dictation'
import type { LocalModelManifest, LocalModelStatus } from '../../shared/localModels'
import { LOCAL_TTS_MODELS } from '../../shared/readAloud'
import type { UpdateState } from '../../shared/updates'
import type { ProviderOperationEvent } from '../../shared/harness/types'
import { useProviderSnapshotsStore } from '../lib/providerSnapshots'
import { subscribeToUpdates, updateActions, useUpdateStore } from './updateStore'

/**
 * Every download Mousse runs, in one list for the downloads indicator (navigation rail and the
 * Settings nav): the app update, the local speech models and the agents Mousse installs or updates. Each source keeps its own state in
 * the main process; this store mirrors their broadcasts, so progress keeps flowing whichever
 * dialog started a download and whether or not it is still open.
 */

export type DownloadKind = 'update' | 'dictation-model' | 'voice-model' | 'agent'

/** The local speech model kinds, each with its own IPC group. */
type LocalModelKind = 'dictation-model' | 'voice-model'

export type DownloadPhase =
  /** An update is offered but not downloaded yet. */
  | 'available'
  | 'queued'
  | 'downloading'
  | 'verifying'
  /** An update is downloaded and waits for a restart. */
  | 'ready'
  | 'installing'
  | 'done'
  | 'failed'
  | 'cancelled'

export interface DownloadEntry {
  /** `update`, `<kind>:<model id>`, or `agent:<instance id>`. */
  id: string
  kind: DownloadKind
  /** The model id, the update's version, or an agent operation's id. */
  sourceId: string
  label: string
  phase: DownloadPhase
  receivedBytes?: number
  totalBytes?: number
  /** 0–100 when known. */
  percent?: number
  error?: string
  /** When a done or cancelled entry finished; it clears after lingering. */
  settledAt?: number
}

/** How long a finished entry stays while the popover is closed. */
export const DOWNLOAD_LINGER_MS = 8000

const ACTIVE: ReadonlySet<DownloadPhase> = new Set(['queued', 'downloading', 'verifying'])
export const isActiveDownload = (entry: DownloadEntry): boolean => ACTIVE.has(entry.phase)
const isSettled = (entry: DownloadEntry): boolean => entry.settledAt !== undefined

// ---------- Pure transitions (tested in tests/downloadsStore.test.ts) ----------

const percentOf = (received: number, total: number): number =>
  total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0

function replace(entries: readonly DownloadEntry[], next: DownloadEntry): DownloadEntry[] {
  const index = entries.findIndex((entry) => entry.id === next.id)
  if (index < 0) return [...entries, next]
  const copy = entries.slice()
  copy[index] = next
  return copy
}

const without = (entries: readonly DownloadEntry[], id: string): DownloadEntry[] => entries.filter((entry) => entry.id !== id)

/** Folds one local model status event into the list. Only downloads seen starting get an entry. */
export function applyLocalModelStatus(
  entries: readonly DownloadEntry[],
  kind: LocalModelKind,
  label: string,
  status: LocalModelStatus,
  now: number
): DownloadEntry[] {
  const id = `${kind}:${status.modelId}`
  const current = entries.find((entry) => entry.id === id)
  const base = { id, kind, sourceId: status.modelId, label }
  const state = status.state
  switch (state.status) {
    case 'downloading':
      return replace(entries, {
        ...base,
        phase: 'downloading',
        receivedBytes: state.receivedBytes,
        totalBytes: state.totalBytes,
        percent: percentOf(state.receivedBytes, state.totalBytes)
      })
    case 'downloaded':
      // A model that was already on disk is not news.
      if (!current || !isActiveDownload(current)) return entries.slice()
      return replace(entries, { ...base, phase: 'done', totalBytes: current.totalBytes, receivedBytes: current.totalBytes, percent: 100, settledAt: now })
    case 'error':
      return replace(entries, { ...base, phase: 'failed', error: state.message, totalBytes: current?.totalBytes })
    case 'not-downloaded':
      // A running download that stops without finishing was cancelled; otherwise the model was deleted.
      if (current && isActiveDownload(current)) return replace(entries, { ...current, phase: 'cancelled', settledAt: now })
      return current ? without(entries, id) : entries.slice()
  }
}

/** Folds one agent install or update into the list; sign-ins are not downloads. */
export function applyProviderOperation(entries: readonly DownloadEntry[], event: ProviderOperationEvent, label: string, now: number): DownloadEntry[] {
  if (event.kind === 'sign_in' || event.phase === 'prompt') return entries.slice()
  const id = `agent:${event.instanceId}`
  const current = entries.find((entry) => entry.id === id)
  const base = { id, kind: 'agent' as const, sourceId: event.operationId, label }
  switch (event.phase) {
    case 'progress': {
      // Bytes when the download knows them (they also weight the combined percent), else the fraction.
      // A step without bytes (unpacking) keeps the last ones.
      const bytes = event.receivedBytes !== undefined && event.totalBytes ? { receivedBytes: event.receivedBytes, totalBytes: event.totalBytes }
        : event.fraction === undefined && current?.totalBytes ? { receivedBytes: current.receivedBytes ?? 0, totalBytes: current.totalBytes } : undefined
      const percent = bytes ? percentOf(bytes.receivedBytes, bytes.totalBytes)
        : event.fraction !== undefined ? Math.min(100, Math.floor(event.fraction * 100)) : current?.percent
      return replace(entries, { ...base, phase: 'downloading', ...(bytes ?? {}), ...(percent !== undefined ? { percent } : {}) })
    }
    case 'completed':
      return replace(entries, { ...base, phase: 'done', percent: 100, settledAt: now })
    case 'failed':
      return replace(entries, { ...base, phase: 'failed', error: event.error.message })
    case 'cancelled':
      return current ? replace(entries, { ...current, phase: 'cancelled', settledAt: now }) : entries.slice()
  }
}

/** The update's entry, or null when there is nothing to offer, download, install or retry. */
export function updateEntry(state: UpdateState): DownloadEntry | null {
  const version = state.availableVersion ?? ''
  const base = { id: 'update', kind: 'update' as const, sourceId: version, label: version ? `Mousse ${version}` : 'Mousse update' }
  switch (state.phase) {
    case 'available': return { ...base, phase: 'available' }
    case 'downloading': return { ...base, phase: 'downloading', percent: state.downloadPercent ?? 0 }
    // "Downloaded" with an error: the last install did not take; restarting is still the action.
    case 'downloaded': return { ...base, phase: 'ready', error: state.error?.message }
    case 'installing': return { ...base, phase: 'installing' }
    case 'error':
      return state.error && state.error.during !== 'check' ? { ...base, phase: 'failed', error: state.error.message } : null
    default: return null
  }
}

export function applyUpdateState(entries: readonly DownloadEntry[], state: UpdateState): DownloadEntry[] {
  const next = updateEntry(state)
  if (!next) return without(entries, 'update')
  // The update leads the list.
  return [next, ...without(entries, 'update')]
}

/** Drops done and cancelled entries whose linger time is over. */
export function pruneSettled(entries: readonly DownloadEntry[], now: number, lingerMs = DOWNLOAD_LINGER_MS): DownloadEntry[] {
  return entries.filter((entry) => !isSettled(entry) || now - (entry.settledAt as number) < lingerMs)
}

export type DownloadsStatus = 'downloading' | 'installing' | 'failed' | 'ready' | 'available' | 'done' | 'idle'

export interface DownloadsSummary {
  /** What the indicator shows, most urgent first; `idle` hides it. */
  status: DownloadsStatus
  /** Running downloads. */
  active: number
  /** Combined progress of the running downloads, when known. */
  percent?: number
  /** Short label for the wide Settings nav and the tooltip. */
  label: string
}

/** One line for the indicator: the most urgent state across all entries. */
export function summarizeDownloads(entries: readonly DownloadEntry[]): DownloadsSummary {
  const active = entries.filter(isActiveDownload)
  if (active.length > 0) {
    // Weighted by bytes when every running download knows its size, else the plain average.
    const sized = active.every((entry) => entry.totalBytes)
    const percent = sized
      ? percentOf(active.reduce((sum, entry) => sum + (entry.receivedBytes ?? 0), 0), active.reduce((sum, entry) => sum + (entry.totalBytes ?? 0), 0))
      : Math.floor(active.reduce((sum, entry) => sum + (entry.percent ?? 0), 0) / active.length)
    const count = active.length > 1 ? ` ${active.length}` : ''
    return { status: 'downloading', active: active.length, percent, label: `Downloading${count} · ${percent}%` }
  }
  const has = (phase: DownloadPhase) => entries.filter((entry) => entry.phase === phase).length
  if (has('installing')) return { status: 'installing', active: 0, label: 'Installing update' }
  const failed = has('failed')
  if (failed) return { status: 'failed', active: 0, label: failed > 1 ? `${failed} downloads failed` : 'Download failed' }
  if (has('ready')) return { status: 'ready', active: 0, label: 'Restart to update' }
  if (has('available')) return { status: 'available', active: 0, label: 'Update available' }
  if (has('done')) return { status: 'done', active: 0, label: 'Downloaded' }
  return { status: 'idle', active: 0, label: '' }
}

// ---------- Store ----------

interface DownloadsState {
  entries: DownloadEntry[]
  /** The popover is open: finished entries stay until it closes. */
  pinned: boolean
}

export const useDownloadsStore = create<DownloadsState>(() => ({ entries: [], pinned: false }))

let pruneTimer: ReturnType<typeof setTimeout> | undefined

/** Clears finished entries once they have lingered, unless the popover holds them. */
function schedulePrune(): void {
  if (pruneTimer !== undefined) clearTimeout(pruneTimer)
  pruneTimer = undefined
  const { entries, pinned } = useDownloadsStore.getState()
  const settled = entries.filter(isSettled)
  if (pinned || settled.length === 0) return
  const due = Math.min(...settled.map((entry) => (entry.settledAt as number) + DOWNLOAD_LINGER_MS))
  pruneTimer = setTimeout(() => {
    pruneTimer = undefined
    useDownloadsStore.setState((state) => ({ entries: pruneSettled(state.entries, Date.now()) }))
    schedulePrune()
  }, Math.max(0, due - Date.now()))
}

function setEntries(update: (entries: DownloadEntry[]) => DownloadEntry[]): void {
  useDownloadsStore.setState((state) => ({ entries: update(state.entries) }))
  schedulePrune()
}

/** The IPC group of each local model kind (preload `dictation` / `readAloud`). */
interface LocalModelIpc {
  localModels: () => Promise<LocalModelStatus[]>
  downloadLocalModel: (modelId: string) => Promise<LocalModelStatus>
  cancelLocalModelDownload: (modelId: string) => Promise<void>
  onLocalModelStatus: (listener: (status: LocalModelStatus) => void) => () => void
}

const MODEL_SOURCES: Record<LocalModelKind, { models: readonly LocalModelManifest[]; ipc: () => LocalModelIpc | undefined }> = {
  'dictation-model': { models: LOCAL_STT_MODELS, ipc: () => window.mousse?.dictation as unknown as LocalModelIpc | undefined },
  'voice-model': { models: LOCAL_TTS_MODELS, ipc: () => window.mousse?.readAloud as unknown as LocalModelIpc | undefined }
}

const modelLabel = (kind: LocalModelKind, modelId: string): string =>
  MODEL_SOURCES[kind].models.find((model) => model.id === modelId)?.label ?? modelId

/** Feeds a local model status event into the store (also used by tests). */
export function receiveLocalModelStatus(kind: LocalModelKind, status: LocalModelStatus): void {
  setEntries((entries) => applyLocalModelStatus(entries, kind, modelLabel(kind, status.modelId), status, Date.now()))
}

const agentLabel = (instanceId: string): string =>
  useProviderSnapshotsStore.getState().scopes.device?.snapshots?.find((entry) => entry.instanceId === instanceId)?.displayName ?? instanceId

/** Feeds a provider operation event into the store (also used by tests). */
export function receiveProviderOperation(event: ProviderOperationEvent): void {
  setEntries((entries) => applyProviderOperation(entries, event, agentLabel(event.instanceId), Date.now()))
}

export function receiveUpdateState(state: UpdateState): void {
  setEntries((entries) => applyUpdateState(entries, state))
}

let subscribed = false

/** Starts mirroring every download source into this window. Safe to call more than once. */
export function subscribeToDownloads(): void {
  if (subscribed || typeof window === 'undefined' || !window.mousse) return
  subscribed = true
  subscribeToUpdates()
  receiveUpdateState(useUpdateStore.getState())
  useUpdateStore.subscribe((state) => receiveUpdateState(state))
  window.mousse.providers?.onOperation?.((event) => receiveProviderOperation(event))
  for (const kind of Object.keys(MODEL_SOURCES) as LocalModelKind[]) {
    const ipc = MODEL_SOURCES[kind].ipc()
    if (!ipc) continue
    ipc.onLocalModelStatus((status) => receiveLocalModelStatus(kind, status))
    // Downloads already running when this window loaded (a reload mid-download).
    void ipc.localModels().then((list) => {
      for (const status of list) if (status.state.status === 'downloading') receiveLocalModelStatus(kind, status)
    }).catch(() => undefined)
  }
}

const modelIpc = (entry: DownloadEntry): LocalModelIpc | undefined =>
  entry.kind === 'update' || entry.kind === 'agent' ? undefined : MODEL_SOURCES[entry.kind].ipc()

const agentInstanceId = (entry: DownloadEntry): string => entry.id.slice('agent:'.length)

export const downloadsActions = {
  cancel(entry: DownloadEntry): void {
    if (entry.kind === 'agent') {
      void window.mousse.providers.instances.cancelInstall(entry.sourceId).catch(() => undefined)
      return
    }
    void modelIpc(entry)?.cancelLocalModelDownload(entry.sourceId).catch(() => undefined)
  },
  /** Starts the download again; results arrive through the source's status events. */
  retry(entry: DownloadEntry): void {
    if (entry.kind === 'update') {
      void updateActions.download()
      return
    }
    if (entry.kind === 'agent') {
      void window.mousse.providers.instances.install(agentInstanceId(entry)).catch((cause: unknown) => {
        setEntries((entries) => replace(entries, { ...entry, phase: 'failed', error: cause instanceof Error ? cause.message : String(cause) }))
      })
      return
    }
    const kind = entry.kind
    void modelIpc(entry)?.downloadLocalModel(entry.sourceId).catch((cause: unknown) => {
      receiveLocalModelStatus(kind, { modelId: entry.sourceId, state: { status: 'error', message: cause instanceof Error ? cause.message : String(cause) } })
    })
  },
  dismiss(id: string): void {
    if (id === 'update') return
    setEntries((entries) => without(entries, id))
  },
  /** The popover opened or closed. Closing clears every finished entry. */
  setPinned(pinned: boolean): void {
    useDownloadsStore.setState((state) => ({
      pinned,
      entries: pinned ? state.entries : state.entries.filter((entry) => !isSettled(entry))
    }))
    schedulePrune()
  }
}

/** Test hook: empties the store and stops the linger timer. */
export function resetDownloadsStore(): void {
  if (pruneTimer !== undefined) clearTimeout(pruneTimer)
  pruneTimer = undefined
  useDownloadsStore.setState({ entries: [], pinned: false }, true)
}
