import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceBusyError, executeQuickAction } from '../src/renderer/lib/executeQuickAction'
import { isComposerWorkspaceLocked, isWorkspacePending, workspacePendingKey } from '../src/renderer/lib/newThread'
import { createQuickAction } from '../src/renderer/lib/quickActions'
import { useAppStore } from '../src/renderer/stores/appStore'
import type { Thread } from '../src/shared/types'

const thread = (patch: Partial<Thread>): Thread => ({
  id: 't1', name: 'New Thread', order: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...patch
}) as Thread

const action = createQuickAction({ label: 'Review', kind: 'send-current', payload: 'Review this', isBuiltIn: false })

function stubMousse(created?: Thread) {
  const create = vi.fn(async () => created!)
  const setWorktreeEnabled = vi.fn(async (id: string, enabled: boolean) => thread({ id, projectId: 'p', worktreeEnabled: enabled }))
  const select = vi.fn(async () => undefined)
  const sendToThread = vi.fn(async () => ({ queued: false }))
  const isTurnActive = vi.fn(async () => false)
  vi.stubGlobal('window', {
    localStorage: { getItem: () => null, setItem: () => undefined },
    mousse: {
      threads: { create, setWorktreeEnabled, select },
      orchestrator: { sendToThread, send: vi.fn(), isTurnActive }
    }
  })
  return { create, setWorktreeEnabled, select, sendToThread, isTurnActive }
}

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState({
    profileId: 'default', activeThreadId: null, loading: false, threads: [], messages: [], composerWorkspaceDrafts: {}, workspacePending: {}
  })
})

describe('send-in-current-chat on a new chat', () => {
  it('starts a blank chat in the worktree picked in the side card', async () => {
    const created = thread({ id: 'made', projectId: 'p', worktreeEnabled: true })
    const mousse = stubMousse(created)
    useAppStore.setState({
      activeThreadId: null,
      composerWorkspaceDrafts: { __blank__: { projectId: 'p', worktreeEnabled: true } }
    })

    await executeQuickAction(action, 'default')

    expect(mousse.create).toHaveBeenCalledWith(undefined, 'p', { worktreeEnabled: true })
    expect(mousse.select).toHaveBeenCalledWith('made')
    expect(mousse.sendToThread).toHaveBeenCalledWith('made', expect.objectContaining({ content: 'Review this' }))
    const state = useAppStore.getState()
    expect(state.activeThreadId).toBe('made')
    expect(state.composerWorkspaceDrafts.__blank__).toBeUndefined()
    expect(state.threads.find((entry) => entry.id === 'made')?.startedAt).toBeTruthy()
  })

  it('turns the worktree on for an unstarted thread in the same project', async () => {
    const mousse = stubMousse()
    useAppStore.setState({
      activeThreadId: 't1',
      threads: [thread({ projectId: 'p', worktreeEnabled: false })],
      composerWorkspaceDrafts: { t1: { projectId: 'p', worktreeEnabled: true } }
    })

    await executeQuickAction(action, 'default')

    expect(mousse.create).not.toHaveBeenCalled()
    expect(mousse.setWorktreeEnabled).toHaveBeenCalledWith('t1', true)
    expect(mousse.sendToThread).toHaveBeenCalledWith('t1', expect.objectContaining({ content: 'Review this' }))
    expect(useAppStore.getState().threads.find((entry) => entry.id === 't1')?.worktreeEnabled).toBe(true)
  })

  it('leaves a started thread alone', async () => {
    const mousse = stubMousse()
    useAppStore.setState({
      activeThreadId: 't1',
      threads: [thread({ projectId: 'p', startedAt: '2026-01-01T00:00:01Z' })],
      composerWorkspaceDrafts: { t1: { projectId: 'p', worktreeEnabled: true } }
    })

    await executeQuickAction(action, 'default')

    expect(mousse.create).not.toHaveBeenCalled()
    expect(mousse.setWorktreeEnabled).not.toHaveBeenCalled()
    expect(mousse.sendToThread).toHaveBeenCalledWith('t1', expect.anything())
  })

  it('keeps loading on after selecting the new thread while the turn runs', async () => {
    const mousse = stubMousse(thread({ id: 'made', projectId: 'p' }))
    mousse.isTurnActive.mockResolvedValue(true)
    useAppStore.setState({ composerWorkspaceDrafts: { __blank__: { projectId: 'p', worktreeEnabled: false } } })

    await executeQuickAction(action, 'default')

    expect(useAppStore.getState().loading).toBe(true)
  })

  it('does not send when creating the thread fails', async () => {
    const mousse = stubMousse()
    mousse.create.mockRejectedValue(new Error('Disk full'))
    useAppStore.setState({ composerWorkspaceDrafts: { __blank__: { projectId: 'p', worktreeEnabled: true } } })

    await expect(executeQuickAction(action, 'default')).rejects.toThrow('Failed to send message.')

    expect(mousse.sendToThread).not.toHaveBeenCalled()
    expect(useAppStore.getState().loading).toBe(false)
  })
})

describe('preparing a new chat from a quick action', () => {
  const deferred = <T,>() => {
    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }
  const state = () => useAppStore.getState()

  it('locks the workspace while the worktree is switching, and a second action cannot start', async () => {
    const mousse = stubMousse()
    const gate = deferred<Thread>()
    mousse.setWorktreeEnabled.mockReturnValue(gate.promise)
    useAppStore.setState({
      activeThreadId: 't1',
      threads: [thread({ projectId: 'p', worktreeEnabled: false })],
      composerWorkspaceDrafts: { t1: { projectId: 'p', worktreeEnabled: true } }
    })

    const first = executeQuickAction(action, 'default')
    expect(isWorkspacePending(state())).toBe(true)
    expect(isComposerWorkspaceLocked(state())).toBe(true)
    expect(state().workspacePending).toEqual({ [workspacePendingKey('default', 't1')]: true })

    await expect(executeQuickAction(action, 'default')).rejects.toBeInstanceOf(WorkspaceBusyError)
    await expect(executeQuickAction(action, 'default')).rejects.toThrow(/^Busy/)
    expect(mousse.setWorktreeEnabled).toHaveBeenCalledTimes(1)
    expect(mousse.sendToThread).not.toHaveBeenCalled()
    // The refused attempts leave the first one's lock in place.
    expect(isComposerWorkspaceLocked(state())).toBe(true)

    gate.resolve(thread({ projectId: 'p', worktreeEnabled: true }))
    await first
    expect(mousse.sendToThread).toHaveBeenCalledTimes(1)
    expect(state().workspacePending).toEqual({})
    expect(state().threads.find((entry) => entry.id === 't1')?.worktreeEnabled).toBe(true)
  })

  it('refuses while the composer is preparing the same blank draft', async () => {
    const mousse = stubMousse(thread({ id: 'made', projectId: 'p' }))
    useAppStore.setState({ composerWorkspaceDrafts: { __blank__: { projectId: 'p', worktreeEnabled: false } } })
    state().setWorkspacePending('default', null, true)

    await expect(executeQuickAction(action, 'default')).rejects.toBeInstanceOf(WorkspaceBusyError)
    expect(mousse.create).not.toHaveBeenCalled()
    expect(mousse.sendToThread).not.toHaveBeenCalled()
    // Not the action's lock to release.
    expect(isWorkspacePending(state())).toBe(true)
  })

  it('keeps the new thread locked until it is selected, then releases both keys', async () => {
    const mousse = stubMousse(thread({ id: 'made', projectId: 'p' }))
    const gate = deferred<undefined>()
    mousse.select.mockReturnValue(gate.promise)
    useAppStore.setState({ composerWorkspaceDrafts: { __blank__: { projectId: 'p', worktreeEnabled: false } } })

    const pending = executeQuickAction(action, 'default')
    expect(isComposerWorkspaceLocked(state())).toBe(true)
    await vi.waitFor(() => expect(state().activeThreadId).toBe('made'))
    expect(isComposerWorkspaceLocked(state())).toBe(true)
    expect(Object.keys(state().workspacePending).sort()).toEqual(
      [workspacePendingKey('default', null), workspacePendingKey('default', 'made')].sort()
    )

    gate.resolve(undefined)
    await pending
    expect(state().workspacePending).toEqual({})
    expect(mousse.create).toHaveBeenCalledTimes(1)
  })

  it('releases the lock when preparing fails', async () => {
    const mousse = stubMousse()
    mousse.create.mockRejectedValue(new Error('Disk full'))
    useAppStore.setState({ composerWorkspaceDrafts: { __blank__: { projectId: 'p', worktreeEnabled: true } } })

    await expect(executeQuickAction(action, 'default')).rejects.toThrow('Failed to send message.')
    expect(state().workspacePending).toEqual({})
    expect(isComposerWorkspaceLocked(state())).toBe(false)
  })

  it('does not lock or refuse in a started thread', async () => {
    const mousse = stubMousse()
    useAppStore.setState({
      activeThreadId: 't1',
      threads: [thread({ projectId: 'p', startedAt: '2026-01-01T00:00:01Z' })]
    })
    state().setWorkspacePending('default', 'other', true)

    await executeQuickAction(action, 'default')
    expect(mousse.sendToThread).toHaveBeenCalledTimes(1)
  })
})

describe('workspace pending flag', () => {
  const idle = { loading: false, activeThreadId: 't1', turnStates: {} }

  it('locks only the thread or draft it is set for, in the profile it is set for', () => {
    const pending = { [workspacePendingKey('alice', 't1')]: true as const }
    expect(isComposerWorkspaceLocked({ ...idle, profileId: 'alice', workspacePending: pending })).toBe(true)
    expect(isComposerWorkspaceLocked({ ...idle, profileId: 'bob', workspacePending: pending })).toBe(false)
    expect(isComposerWorkspaceLocked({ ...idle, activeThreadId: 't2', profileId: 'alice', workspacePending: pending })).toBe(false)
    const blank = { [workspacePendingKey('alice', null)]: true as const }
    expect(isComposerWorkspaceLocked({ ...idle, activeThreadId: null, profileId: 'alice', workspacePending: blank })).toBe(true)
  })

  it('is not locked when the state carries no pending map', () => {
    expect(isComposerWorkspaceLocked(idle)).toBe(false)
    expect(isWorkspacePending({ activeThreadId: 't1' })).toBe(false)
  })

  it('is set and cleared per key, and a late clear from another profile leaves the active one alone', () => {
    const store = useAppStore.getState()
    store.setWorkspacePending('default', null, true)
    store.setWorkspacePending('other', null, false)
    expect(isWorkspacePending(useAppStore.getState())).toBe(true)
    const before = useAppStore.getState().workspacePending
    store.setWorkspacePending('default', null, true)
    expect(useAppStore.getState().workspacePending).toBe(before)
    store.setWorkspacePending('default', null, false)
    expect(useAppStore.getState().workspacePending).toEqual({})
  })

  it('is shared by the composer instead of a local flag', () => {
    const source = readFileSync(new URL('../src/renderer/components/OrchestratorChat.tsx', import.meta.url), 'utf8')
    expect(source).toContain('useAppStore(isComposerWorkspaceLocked)')
    expect(source).toContain('isWorkspacePending(useAppStore.getState())')
    expect(source).not.toMatch(/const \[workspacePending/)
  })
})
