import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateState } from '../src/shared/updates'
import {
  dismissUpdateError,
  retryUpdate,
  stateAfterFailedRequest,
  updateActions,
  updateErrorMessage,
  useUpdateStore
} from '../src/renderer/stores/updateStore'

const state = (patch: Partial<UpdateState> = {}): UpdateState => ({
  phase: 'available', currentVersion: '1.0.0', channel: 'stable', availableVersion: '1.1.0', releaseNotes: [], omittedReleaseCount: 0, ...patch
})

const ipcFailure = (channel: string, message: string) => new Error(`Error invoking remote method '${channel}': Error: ${message}`)

function stubUpdates(overrides: Partial<Record<'check' | 'download' | 'install' | 'setChannel', () => Promise<UpdateState>>>) {
  const updates = {
    getState: vi.fn(), onState: vi.fn(), setChannel: vi.fn(),
    check: vi.fn(async () => state({ phase: 'up-to-date' })),
    download: vi.fn(async () => state({ phase: 'downloaded' })),
    install: vi.fn(async () => state({ phase: 'installing' })),
    ...overrides
  }
  vi.stubGlobal('window', { mousse: { updates } })
  return updates
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  useUpdateStore.setState(state(), true)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('update error messages', () => {
  it('drops the call prefix and error label, keeping the first line', () => {
    expect(updateErrorMessage(ipcFailure('updates:download', 'ENOSPC: no space left\n    at foo'), 'download')).toBe('ENOSPC: no space left')
  })

  it('says what failed when the error carries no message', () => {
    expect(updateErrorMessage(new Error(''), 'check')).toBe('Mousse could not check for updates.')
    expect(updateErrorMessage(undefined, 'install')).toBe('Mousse could not install the update.')
  })
})

describe('update store errors', () => {
  it('shows a rejected check as a failed check', async () => {
    useUpdateStore.setState(state({ phase: 'idle', availableVersion: undefined }), true)
    stubUpdates({ check: () => Promise.reject(ipcFailure('updates:check', 'No handler registered for \'updates:check\'')) })
    await updateActions.check()
    expect(useUpdateStore.getState()).toMatchObject({ phase: 'error', error: { during: 'check', message: "No handler registered for 'updates:check'" } })
  })

  it('shows a rejected download as a failed download and drops its progress', async () => {
    useUpdateStore.setState(state({ phase: 'downloading', downloadPercent: 40 }), true)
    stubUpdates({ download: () => Promise.reject(ipcFailure('updates:download', 'Download interrupted')) })
    await updateActions.download()
    const next = useUpdateStore.getState()
    expect(next).toMatchObject({ phase: 'error', availableVersion: '1.1.0', error: { during: 'download', message: 'Download interrupted' } })
    expect(next.downloadPercent).toBeUndefined()
  })

  it('keeps the download when an install call is rejected', async () => {
    useUpdateStore.setState(state({ phase: 'downloaded' }), true)
    stubUpdates({ install: () => Promise.reject(ipcFailure('updates:install', 'The background service did not stop')) })
    await updateActions.install()
    expect(useUpdateStore.getState()).toMatchObject({ phase: 'downloaded', error: { during: 'install', message: 'The background service did not stop' } })
  })

  it('cleans the message of an error the updater reported itself', async () => {
    stubUpdates({ download: async () => state({ phase: 'error', error: { during: 'download', message: "Error invoking remote method 'x': Error: boom" } }) })
    await updateActions.download()
    expect(useUpdateStore.getState().error?.message).toBe('boom')
  })

  it('retries the step that failed', async () => {
    const updates = stubUpdates({})
    useUpdateStore.setState(stateAfterFailedRequest(state(), 'download', new Error('x')), true)
    await retryUpdate()
    expect(updates.download).toHaveBeenCalledTimes(1)
    useUpdateStore.setState(stateAfterFailedRequest(state({ phase: 'downloaded' }), 'install', new Error('x')), true)
    await retryUpdate()
    expect(updates.install).toHaveBeenCalledTimes(1)
    useUpdateStore.setState(stateAfterFailedRequest(state({ phase: 'idle' }), 'check', new Error('x')), true)
    await retryUpdate()
    expect(updates.check).toHaveBeenCalledTimes(1)
  })

  it('dismisses an error: a failed download is offered again, a failed install stays downloaded', () => {
    useUpdateStore.setState(stateAfterFailedRequest(state(), 'download', new Error('x')), true)
    dismissUpdateError()
    expect(useUpdateStore.getState()).toMatchObject({ phase: 'available', availableVersion: '1.1.0' })
    expect(useUpdateStore.getState().error).toBeUndefined()
    useUpdateStore.setState(stateAfterFailedRequest(state({ phase: 'downloaded' }), 'install', new Error('x')), true)
    dismissUpdateError()
    expect(useUpdateStore.getState()).toMatchObject({ phase: 'downloaded' })
    expect(useUpdateStore.getState().error).toBeUndefined()
  })
})
