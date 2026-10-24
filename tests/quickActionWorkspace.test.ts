import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeQuickAction } from '../src/renderer/lib/executeQuickAction'
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
    profileId: 'default', activeThreadId: null, loading: false, threads: [], messages: [], composerWorkspaceDrafts: {}
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
