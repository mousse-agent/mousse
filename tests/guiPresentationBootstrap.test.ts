import { describe, expect, it, vi } from 'vitest'
import type { GuiMmsController } from '../src/main/mms/GuiMmsController'
import { PresentationState } from '../src/main/mms/PresentationState'
import { bootstrapPresentation } from '../src/main/mms/bootstrapPresentation'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const snapshot = {
  messages: [{ id: 'restored', content: 'Restored chat' }],
  queue: [],
  agents: [],
  tasks: [],
  pendingQuestions: [{ requestId: 'question', questions: ['Continue?'] }]
}

function controller(snapshotRequest = vi.fn(async () => snapshot)) {
  return {
    request: vi.fn(async (method: string) => {
      if (method === 'threads.list') return { threads: [{ id: 'existing' }] }
      if (method === 'projects.list') return { projects: [] }
      throw new Error(`Unexpected request: ${method}`)
    }),
    snapshotThread: snapshotRequest
  }
}

describe('subscribed window presentation bootstrap', () => {
  it('selects before restoring the view and forwards pending questions with their thread', async () => {
    const gui = controller()
    const state = new PresentationState()
    let selected: string | null = null
    const view = vi.fn()
    const questions = vi.fn()
    const onTurnSnapshot = vi.fn()
    await bootstrapPresentation(gui as unknown as GuiMmsController, state, (channel, data) => {
      if (channel === 'thread:selected') selected = (data as { id: string }).id
      // Model the renderer's selected-thread event filter.
      if (channel === 'thread:view' && (data as { threadId: string }).threadId === selected) view(data)
      if (channel === 'orchestrator:questionsPending') questions(data)
    }, { onTurnSnapshot })
    expect(selected).toBe('existing')
    expect(view).toHaveBeenCalledWith(expect.objectContaining({ messages: snapshot.messages }))
    expect(questions).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'existing' }))
    expect(onTurnSnapshot).toHaveBeenCalledWith(snapshot)
    expect(gui.snapshotThread).toHaveBeenCalledTimes(1)
  })

  it('does not overwrite a manual selection while restoration is in flight', async () => {
    const pending = deferred<typeof snapshot>()
    const requested = deferred<void>()
    const gui = controller(vi.fn(() => { requested.resolve(); return pending.promise }))
    const state = new PresentationState()
    const broadcast = vi.fn()
    const onTurnSnapshot = vi.fn()
    const boot = bootstrapPresentation(gui as unknown as GuiMmsController, state, broadcast, { onTurnSnapshot })
    await requested.promise
    state.setActiveThreadId('manually-selected')
    pending.resolve(snapshot)
    await boot
    expect(state.getActiveThreadId()).toBe('manually-selected')
    expect(broadcast.mock.calls.some(([channel]) => channel === 'thread:view')).toBe(false)
    expect(onTurnSnapshot).not.toHaveBeenCalled()
  })

  it('preserves a newly created manual selection that was absent from the initial list', async () => {
    const pending = deferred<{ threads: { id: string }[] }>()
    const gui = controller()
    gui.request.mockImplementation((method) => method === 'threads.list' ? pending.promise : Promise.resolve({ projects: [] }))
    const state = new PresentationState()
    const boot = bootstrapPresentation(gui as unknown as GuiMmsController, state, vi.fn())
    state.setActiveThreadId('new-manual-thread')
    pending.resolve({ threads: [{ id: 'existing' }] })
    await boot
    expect(state.getActiveThreadId()).toBe('new-manual-thread')
    expect(gui.snapshotThread).toHaveBeenCalledWith('new-manual-thread')
  })

  it('discards old-profile snapshots after the window binding changes', async () => {
    const pending = deferred<typeof snapshot>()
    const requested = deferred<void>()
    const gui = controller(vi.fn(() => { requested.resolve(); return pending.promise }))
    const broadcast = vi.fn()
    let current = true
    const boot = bootstrapPresentation(gui as unknown as GuiMmsController, new PresentationState(), broadcast, { isCurrent: () => current })
    await requested.promise
    current = false
    broadcast.mockClear()
    pending.resolve(snapshot)
    await boot
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('rejects restoration failures so the renderer can offer a retry', async () => {
    const gui = controller(vi.fn(async () => { throw new Error('Disconnected') }))
    await expect(bootstrapPresentation(gui as unknown as GuiMmsController, new PresentationState(), vi.fn())).rejects.toThrow('Disconnected')
  })
})
