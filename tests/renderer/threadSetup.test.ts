import { beforeEach, describe, expect, it, vi } from 'vitest'
import { finishThreadSetup, recordThreadSetup, ThreadSetupError } from '../../src/renderer/lib/threadSetup'
import { threadsLeavingSetup, useAppStore } from '../../src/renderer/stores/appStore'
import type { Thread } from '../../src/shared/types'

const OPUS = { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'opus' }
const SONNET = { ...OPUS, model: 'sonnet' }
const pending = () => useAppStore.getState().pendingThreadSetup.t1
const thread = (patch: Partial<Thread> = {}): Thread => ({ id: 't1', name: 'New Chat', createdAt: '', updatedAt: '', ...patch }) as Thread
/** Puts the thread in the window's list as another route changed it. */
const listed = (patch: Partial<Thread> = {}) => useAppStore.setState({ threads: [thread(patch)] })

beforeEach(() => { useAppStore.setState({ pendingThreadSetup: {}, threads: [thread()] }) })

const calls = () => ({
  update: vi.fn(),
  setModel: vi.fn(async (id: string, model: Thread['modelOverride']) => ({ id, modelOverride: model } as Thread)),
  setPermissionMode: vi.fn(async (id: string, permissionMode: Thread['permissionMode']) => ({ id, permissionMode } as Thread))
})

describe("a new chat's thread setup", () => {
  it('keeps what was recorded when a later record leaves a part out, with the thread values it started from', () => {
    recordThreadSetup(thread(), { model: OPUS, permissionMode: 'ask' })
    recordThreadSetup(thread({ permissionMode: 'full' }), {})
    expect(pending()).toEqual({ model: OPUS, permissionMode: 'ask', base: { model: null, permissionMode: null } })
    // A newer pick replaces the value but keeps the base it was first compared against.
    recordThreadSetup(thread({ permissionMode: 'full' }), { permissionMode: 'auto' })
    expect(pending()?.permissionMode).toBe('auto')
    expect(pending()?.base?.permissionMode).toBeNull()
    recordThreadSetup({ ...thread(), id: 't2' }, {})
    expect(useAppStore.getState().pendingThreadSetup.t2).toBeUndefined()
  })

  it('forgets each part once it went through, keeps the rest after a failure, and says nothing was sent', async () => {
    recordThreadSetup(thread(), { model: OPUS, permissionMode: 'ask' })
    const c = calls()
    c.setPermissionMode.mockImplementationOnce(async () => { throw new Error('The other computer did not answer.') })
    const failed = finishThreadSetup('t1', c)
    await expect(failed).rejects.toBeInstanceOf(ThreadSetupError)
    await expect(failed).rejects.toThrow(/^Nothing was sent/)
    expect(pending()).toEqual({ permissionMode: 'ask', base: { permissionMode: null } })
    // The model this setup set is its own change: the mode is still compared with what it started from.
    listed({ modelOverride: OPUS })
    expect(await finishThreadSetup('t1', c)).toEqual([])
    expect(c.setModel).toHaveBeenCalledTimes(1)
    expect(c.setPermissionMode).toHaveBeenLastCalledWith('t1', 'ask')
    expect(pending()).toBeUndefined()
  })

  it('drops a field the thread changed by another route since it was recorded, and applies only the unchanged ones', async () => {
    recordThreadSetup(thread(), { model: OPUS, permissionMode: 'full' })
    listed({ permissionMode: 'ask' })
    const c = calls()
    expect(await finishThreadSetup('t1', c)).toEqual(['permissionMode'])
    expect(c.setModel).toHaveBeenCalledWith('t1', OPUS)
    expect(c.setPermissionMode).not.toHaveBeenCalled()
    expect(pending()).toBeUndefined()

    recordThreadSetup(thread(), { model: OPUS, permissionMode: 'full' })
    listed({ modelOverride: SONNET })
    const d = calls()
    expect(await finishThreadSetup('t1', d)).toEqual(['model'])
    expect(d.setModel).not.toHaveBeenCalled()
    expect(d.setPermissionMode).toHaveBeenCalledWith('t1', 'full')
  })

  it('sends nothing when the thread is not listed, since its current values cannot be compared', async () => {
    // Not in the window's list yet (another computer's list has not come), so never seen there.
    useAppStore.setState({ threads: [{ ...thread(), id: 'other' }] })
    recordThreadSetup(thread(), { permissionMode: 'full' })
    const c = calls()
    await expect(finishThreadSetup('t1', c)).rejects.toThrow(/not listed/)
    expect(c.setPermissionMode).not.toHaveBeenCalled()
    expect(pending()).toBeDefined()
  })

  it('goes with its thread when the thread is deleted, archived or gone with an unlinked computer, but not before the first list', () => {
    const state = useAppStore.getState()
    const withPending = { ...state, pendingThreadSetup: { t1: { permissionMode: 'full' as const }, 'node-1:t2': { permissionMode: 'full' as const } } }
    const before = { ...withPending, threads: [thread(), { ...thread(), id: 'node-1:t2' }] }
    expect(threadsLeavingSetup(before, { ...withPending, threads: [thread()] })).toEqual(['node-1:t2'])
    expect(threadsLeavingSetup(before, { ...withPending, threads: [thread({ settledAt: '2026-11-10T00:00:00Z' }), { ...thread(), id: 'node-1:t2' }] })).toEqual(['t1'])
    expect(threadsLeavingSetup({ ...withPending, threads: [] }, { ...withPending, threads: [{ ...thread(), id: 'x' }] })).toEqual([])
    // Wired to the store: archiving drops the entry.
    useAppStore.setState({ pendingThreadSetup: { t1: { permissionMode: 'full' } }, threads: [thread()] })
    useAppStore.setState({ threads: [thread({ settledAt: '2026-11-10T00:00:00Z' })] })
    expect(pending()).toBeUndefined()
  })
})
