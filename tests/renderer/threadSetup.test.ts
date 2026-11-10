import { beforeEach, describe, expect, it, vi } from 'vitest'
import { finishThreadSetup, recordThreadSetup, ThreadSetupError } from '../../src/renderer/lib/threadSetup'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { Thread } from '../../src/shared/types'

const OPUS = { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'opus' }
const pending = () => useAppStore.getState().pendingThreadSetup.t1

beforeEach(() => { useAppStore.setState({ pendingThreadSetup: {} }) })

describe("a new chat's thread setup", () => {
  it('keeps what was recorded when a later record leaves a part out, and forgets an empty setup', () => {
    recordThreadSetup('t1', { model: OPUS, permissionMode: 'ask' })
    recordThreadSetup('t1', {})
    expect(pending()).toEqual({ model: OPUS, permissionMode: 'ask' })
    recordThreadSetup('t1', { permissionMode: 'full' })
    expect(pending()).toEqual({ model: OPUS, permissionMode: 'full' })
    recordThreadSetup('t2', {})
    expect(useAppStore.getState().pendingThreadSetup.t2).toBeUndefined()
  })

  it('forgets each part once it went through, keeps the rest after a failure, and says nothing was sent', async () => {
    recordThreadSetup('t1', { model: OPUS, permissionMode: 'ask' })
    const update = vi.fn()
    const setModel = vi.fn(async (id: string) => ({ id } as Thread))
    const setPermissionMode = vi.fn(async () => { throw new Error('The other computer did not answer.') })
    const failed = finishThreadSetup('t1', { setModel, setPermissionMode, update })
    await expect(failed).rejects.toBeInstanceOf(ThreadSetupError)
    await expect(failed).rejects.toThrow(/^Nothing was sent/)
    expect(pending()).toEqual({ permissionMode: 'ask' })

    setPermissionMode.mockImplementation(async () => ({ id: 't1', permissionMode: 'ask' } as Thread))
    await finishThreadSetup('t1', { setModel, setPermissionMode, update })
    expect(setModel).toHaveBeenCalledTimes(1)
    expect(pending()).toBeUndefined()
    expect(update).toHaveBeenLastCalledWith({ id: 't1', permissionMode: 'ask' })
  })
})
