import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderOperationEvent } from '../src/shared/harness/types'
import type { UpdateState } from '../src/shared/updates'
import {
  DOWNLOAD_LINGER_MS,
  applyLocalModelStatus,
  applyProviderOperation,
  applyUpdateState,
  downloadsActions,
  pruneSettled,
  receiveLocalModelStatus,
  receiveUpdateState,
  resetDownloadsStore,
  summarizeDownloads,
  updateEntry,
  useDownloadsStore,
  type DownloadEntry
} from '../src/renderer/stores/downloadsStore'

const update = (patch: Partial<UpdateState>): UpdateState => ({
  phase: 'idle', currentVersion: '1.0.0', channel: 'stable', releaseNotes: [], omittedReleaseCount: 0, ...patch
})

const downloading = (modelId: string, receivedBytes: number, totalBytes: number) =>
  ({ modelId, state: { status: 'downloading' as const, receivedBytes, totalBytes } })

describe('downloads store transitions', () => {
  it('tracks a model download from start to done, and ignores models that were already on disk', () => {
    let entries: DownloadEntry[] = []
    entries = applyLocalModelStatus(entries, 'dictation-model', 'Moonshine Base', { modelId: 'm', state: { status: 'downloaded' } }, 1)
    expect(entries).toEqual([])

    entries = applyLocalModelStatus(entries, 'dictation-model', 'Moonshine Base', downloading('m', 57_000_000, 136_000_000), 2)
    expect(entries).toMatchObject([{ id: 'dictation-model:m', phase: 'downloading', percent: 41, receivedBytes: 57_000_000 }])

    entries = applyLocalModelStatus(entries, 'dictation-model', 'Moonshine Base', { modelId: 'm', state: { status: 'downloaded' } }, 3)
    expect(entries).toMatchObject([{ phase: 'done', percent: 100, settledAt: 3 }])
  })

  it('marks a download that stops without finishing as cancelled, and drops a deleted model', () => {
    let entries = applyLocalModelStatus([], 'voice-model', 'Kokoro', downloading('k', 1, 10), 1)
    entries = applyLocalModelStatus(entries, 'voice-model', 'Kokoro', { modelId: 'k', state: { status: 'not-downloaded' } }, 2)
    expect(entries).toMatchObject([{ phase: 'cancelled', settledAt: 2 }])

    entries = applyLocalModelStatus(entries, 'voice-model', 'Kokoro', { modelId: 'k', state: { status: 'not-downloaded' } }, 3)
    expect(entries).toEqual([])
  })

  it('keeps a failure with its message until it is retried or dismissed', () => {
    let entries = applyLocalModelStatus([], 'dictation-model', 'Parakeet', downloading('p', 5, 10), 1)
    entries = applyLocalModelStatus(entries, 'dictation-model', 'Parakeet', { modelId: 'p', state: { status: 'error', message: 'HTTP 503' } }, 2)
    expect(entries).toMatchObject([{ phase: 'failed', error: 'HTTP 503', totalBytes: 10 }])
    expect(entries[0].settledAt).toBeUndefined()
    expect(pruneSettled(entries, 10 ** 9)).toHaveLength(1)
  })

  it('maps every update phase that needs attention and nothing else', () => {
    expect(updateEntry(update({ phase: 'up-to-date' }))).toBeNull()
    expect(updateEntry(update({ phase: 'error', error: { message: 'offline', during: 'check' } }))).toBeNull()
    expect(updateEntry(update({ phase: 'available', availableVersion: '1.1.0' }))).toMatchObject({ phase: 'available', label: 'Mousse 1.1.0' })
    expect(updateEntry(update({ phase: 'downloading', availableVersion: '1.1.0', downloadPercent: 42 }))).toMatchObject({ phase: 'downloading', percent: 42 })
    expect(updateEntry(update({ phase: 'downloaded', availableVersion: '1.1.0' }))).toMatchObject({ phase: 'ready' })
    expect(updateEntry(update({ phase: 'downloaded', availableVersion: '1.1.0', error: { message: 'not applied', during: 'install' } })))
      .toMatchObject({ phase: 'ready', error: 'not applied' })
    expect(updateEntry(update({ phase: 'installing', availableVersion: '1.1.0' }))).toMatchObject({ phase: 'installing' })
    expect(updateEntry(update({ phase: 'error', availableVersion: '1.1.0', error: { message: 'disk full', during: 'download' } })))
      .toMatchObject({ phase: 'failed', error: 'disk full' })
  })

  it('puts the update first and removes it when it no longer needs attention', () => {
    let entries = applyLocalModelStatus([], 'voice-model', 'Kokoro', downloading('k', 1, 10), 1)
    entries = applyUpdateState(entries, update({ phase: 'available', availableVersion: '1.1.0' }))
    expect(entries.map((entry) => entry.id)).toEqual(['update', 'voice-model:k'])
    entries = applyUpdateState(entries, update({ phase: 'up-to-date' }))
    expect(entries.map((entry) => entry.id)).toEqual(['voice-model:k'])
  })

  it('summarizes the most urgent state with a byte-weighted percent and a count', () => {
    expect(summarizeDownloads([]).status).toBe('idle')
    let entries = applyLocalModelStatus([], 'dictation-model', 'A', downloading('a', 30, 100), 1)
    entries = applyLocalModelStatus(entries, 'dictation-model', 'B', downloading('b', 70, 100), 1)
    expect(summarizeDownloads(entries)).toEqual({ status: 'downloading', active: 2, percent: 50, label: 'Downloading 2 · 50%' })

    // The update reports only a percent, so the running downloads average their percents.
    entries = applyUpdateState(entries, update({ phase: 'downloading', availableVersion: '1.1.0', downloadPercent: 80 }))
    expect(summarizeDownloads(entries)).toMatchObject({ active: 3, percent: 60 })

    expect(summarizeDownloads(applyUpdateState([], update({ phase: 'downloaded', availableVersion: '1.1.0' }))).label).toBe('Restart to update')
    expect(summarizeDownloads(applyUpdateState([], update({ phase: 'available', availableVersion: '1.1.0' }))).label).toBe('Update available')
    const failed = applyLocalModelStatus([], 'voice-model', 'K', { modelId: 'k', state: { status: 'error', message: 'x' } }, 1)
    expect(summarizeDownloads(applyUpdateState(failed, update({ phase: 'available', availableVersion: '1.1.0' }))).status).toBe('failed')
  })
})

describe('downloads store: agent installs and updates', () => {
  const op = (patch: Partial<ProviderOperationEvent> & Pick<ProviderOperationEvent, 'phase'>): ProviderOperationEvent =>
    ({ operationId: 'op-1', instanceId: 'antigravity', kind: 'install', ...patch }) as ProviderOperationEvent

  it('tracks an install from its byte progress to done, one entry per instance', () => {
    let entries: DownloadEntry[] = []
    entries = applyProviderOperation(entries, op({ phase: 'progress', message: 'Starting' }), 'Antigravity', 1)
    expect(entries).toEqual([{ id: 'agent:antigravity', kind: 'agent', sourceId: 'op-1', label: 'Antigravity', phase: 'downloading' }])
    entries = applyProviderOperation(entries, op({ phase: 'progress', message: 'Downloading 57 MB of 136 MB', fraction: 0.419 }), 'Antigravity', 2)
    expect(entries).toMatchObject([{ phase: 'downloading', percent: 41 }])
    // A step without a fraction keeps the last percent.
    entries = applyProviderOperation(entries, op({ phase: 'progress', message: 'Verifying' }), 'Antigravity', 3)
    expect(entries).toMatchObject([{ percent: 41 }])
    entries = applyProviderOperation(entries, op({ phase: 'completed' }), 'Antigravity', 4)
    expect(entries).toEqual([{ id: 'agent:antigravity', kind: 'agent', sourceId: 'op-1', label: 'Antigravity', phase: 'done', percent: 100, settledAt: 4 }])
  })

  it('shows bytes when the install reports them, keeps them through steps without bytes, and weights the total by them', () => {
    let entries = applyProviderOperation([], op({ phase: 'progress', message: 'Downloading 1 MB of 4 MB', receivedBytes: 1_000_000, totalBytes: 4_000_000 }), 'Demo', 1)
    expect(entries).toMatchObject([{ phase: 'downloading', receivedBytes: 1_000_000, totalBytes: 4_000_000, percent: 25 }])
    entries = applyProviderOperation(entries, op({ phase: 'progress', message: 'Unpacking Demo…' }), 'Demo', 2)
    expect(entries).toMatchObject([{ receivedBytes: 1_000_000, totalBytes: 4_000_000, percent: 25 }])
    const other = applyProviderOperation(entries, op({ operationId: 'op-3', instanceId: 'acp:other', phase: 'progress', message: 'Downloading', receivedBytes: 3_000_000, totalBytes: 4_000_000 }), 'Other', 3)
    expect(summarizeDownloads(other)).toMatchObject({ status: 'downloading', active: 2, percent: 50 })
  })

  it('keeps a failed update with its message and marks a cancelled install', () => {
    const update = (patch: Parameters<typeof op>[0]) => op({ operationId: 'op-2', instanceId: 'codex', kind: 'update', ...patch })
    let entries = applyProviderOperation([], update({ phase: 'progress', message: 'Updating' }), 'Codex', 1)
    entries = applyProviderOperation(entries, update({ phase: 'failed', error: { code: 'unsupported', message: 'npm failed' } }), 'Codex', 2)
    expect(entries).toMatchObject([{ id: 'agent:codex', phase: 'failed', error: 'npm failed' }])
    expect(entries[0].settledAt).toBeUndefined()

    let install = applyProviderOperation([], op({ phase: 'progress', message: 'Downloading', fraction: 0.1 }), 'Antigravity', 1)
    install = applyProviderOperation(install, op({ phase: 'cancelled' }), 'Antigravity', 2)
    expect(install).toMatchObject([{ phase: 'cancelled', percent: 10, settledAt: 2 }])
    // A cancel for an operation never shown adds nothing.
    expect(applyProviderOperation([], op({ phase: 'cancelled' }), 'Antigravity', 3)).toEqual([])
  })

  it('leaves sign-ins and their prompts out', () => {
    const signIn = op({ kind: 'sign_in', phase: 'progress', message: 'Waiting for the browser' })
    expect(applyProviderOperation([], signIn, 'Claude Code', 1)).toEqual([])
    expect(applyProviderOperation([], op({ kind: 'sign_in', phase: 'completed' }), 'Claude Code', 2)).toEqual([])
    expect(applyProviderOperation([], op({ phase: 'prompt', prompt: { promptId: 'p', type: 'input', secret: false, message: 'Code' } }), 'Antigravity', 3)).toEqual([])
  })
})

describe('downloads store lingering', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetDownloadsStore()
  })
  afterEach(() => {
    resetDownloadsStore()
    vi.useRealTimers()
  })

  const ids = () => useDownloadsStore.getState().entries.map((entry) => `${entry.id}:${entry.phase}`)

  it('clears a finished download after it has lingered', () => {
    receiveLocalModelStatus('dictation-model', downloading('moonshine-base', 1, 10))
    receiveLocalModelStatus('dictation-model', { modelId: 'moonshine-base', state: { status: 'downloaded' } })
    expect(ids()).toEqual(['dictation-model:moonshine-base:done'])
    vi.advanceTimersByTime(DOWNLOAD_LINGER_MS - 1)
    expect(ids()).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(ids()).toEqual([])
  })

  it('keeps finished downloads while the popover is open and clears them when it closes', () => {
    downloadsActions.setPinned(true)
    receiveLocalModelStatus('voice-model', downloading('kokoro-82m', 1, 10))
    receiveLocalModelStatus('voice-model', { modelId: 'kokoro-82m', state: { status: 'not-downloaded' } })
    vi.advanceTimersByTime(DOWNLOAD_LINGER_MS * 3)
    expect(ids()).toEqual(['voice-model:kokoro-82m:cancelled'])
    downloadsActions.setPinned(false)
    expect(ids()).toEqual([])
  })

  it('labels models from the catalogue, dismisses failures and never dismisses the update', () => {
    receiveUpdateState(update({ phase: 'error', availableVersion: '1.1.0', error: { message: 'x', during: 'download' } }))
    receiveLocalModelStatus('dictation-model', { modelId: 'moonshine-base', state: { status: 'error', message: 'HTTP 503' } })
    expect(useDownloadsStore.getState().entries[1].label).toBe('Moonshine Base')
    downloadsActions.dismiss('dictation-model:moonshine-base')
    downloadsActions.dismiss('update')
    expect(ids()).toEqual(['update:failed'])
  })
})
