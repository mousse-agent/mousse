import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeQuickAction } from '../src/renderer/lib/executeQuickAction'
import { createQuickAction } from '../src/renderer/lib/quickActions'
import { useAppStore } from '../src/renderer/stores/appStore'

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState({ profileId: 'default', activeThreadId: null, loading: false, threads: [] })
})

describe('profile-owned quick action execution', () => {
  it('does not apply or send a delayed new-chat result after the profile changes', async () => {
    const storage = new Map<string, string>()
    let resolveThread!: (thread: { id: string }) => void
    const createAndSelect = vi.fn(() => new Promise<{ id: string }>((resolve) => { resolveThread = resolve }))
    const sendToThread = vi.fn()
    const isTurnActive = vi.fn()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value) }
      },
      mousse: {
        threads: { createAndSelect },
        orchestrator: { sendToThread, isTurnActive }
      }
    })
    useAppStore.getState().activateProfile('alice')
    const action = createQuickAction({
      label: 'Alice follow-up',
      kind: 'send-new-chat',
      payload: 'Continue Alice work',
      isBuiltIn: false
    })

    const running = executeQuickAction(action, 'alice')
    await vi.waitFor(() => expect(createAndSelect).toHaveBeenCalledTimes(1))
    useAppStore.getState().activateProfile('bob')
    resolveThread({ id: 'alice-thread' })

    await expect(running).rejects.toThrow('Profile changed')
    expect(sendToThread).not.toHaveBeenCalled()
    expect(isTurnActive).not.toHaveBeenCalled()
    expect(useAppStore.getState()).toMatchObject({ profileId: 'bob', activeThreadId: null, loading: false })
  })

  it("does not change another thread's busy state when a send in the current chat settles after a switch", async () => {
    let resolveSend!: (result: { queued: boolean }) => void
    const sendToThread = vi.fn(() => new Promise<{ queued: boolean }>((resolve) => { resolveSend = resolve }))
    const isTurnActive = vi.fn(async () => true)
    vi.stubGlobal('window', { mousse: { orchestrator: { sendToThread, isTurnActive } } })
    const now = new Date().toISOString()
    useAppStore.setState({
      profileId: 'alice',
      activeThreadId: 'thread-a',
      loading: false,
      threads: [{ id: 'thread-a', name: 'A', createdAt: now, updatedAt: now, startedAt: now, order: 0 }] as never
    })
    const action = createQuickAction({ label: 'Review', kind: 'send-current', payload: 'Review the diff', isBuiltIn: false })

    const running = executeQuickAction(action, 'alice')
    await vi.waitFor(() => expect(sendToThread).toHaveBeenCalledTimes(1))
    expect(useAppStore.getState().loading).toBe(true)
    // The person opens thread B, which is idle.
    useAppStore.setState({ activeThreadId: 'thread-b', loading: false })
    resolveSend({ queued: false })
    await running

    expect(isTurnActive).toHaveBeenCalledWith('thread-a')
    expect(useAppStore.getState()).toMatchObject({ activeThreadId: 'thread-b', loading: false })
  })
})
