// @vitest-environment jsdom
/**
 * The new chat composer's Send and its sidebar row (`lib/pendingThreadRows`): the row is listed in the click itself,
 * before anything is awaited; the composer locks once that frame is drawn; one Send (or one quick action) prepares a
 * chat at a time; a failed create takes the row away and keeps the prompt; a thread made after the composer moved on is
 * still listed; text typed while the row's frame was drawn is kept.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/chat/components/MousseAgentChatShell', () => ({
  MousseAgentChatShell: ({ composer }: { composer: unknown }) => composer
}))
vi.mock('../../src/renderer/dictation/microphone', () => ({}))

const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { usePendingThreadRows } = await import('../../src/renderer/lib/pendingThreadRows')
const { isWorkspacePending } = await import('../../src/renderer/lib/newThread')
const { threadForSend, WorkspaceBusyError } = await import('../../src/renderer/lib/executeQuickAction')

let root: Root
let host: HTMLElement
/** Animation frame callbacks not run yet: a test draws a frame with `drawFrame`. */
let frames: FrameRequestCallback[]
let create: ReturnType<typeof vi.fn>
let sendToThread: ReturnType<typeof vi.fn>

const project: Project = { id: 'p1', name: 'Mousse', path: '/work/mousse', createdAt: '', order: 0 }
const madeThread = (id: string): Thread => ({
  id, name: 'New Thread', projectId: 'p1', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  startedAt: new Date().toISOString(), order: -1, settingsRevision: 0, firstSendPending: true
})

function stubBridge(): void {
  const pending = () => new Promise(() => undefined)
  const section = (overrides: Record<string, unknown>): unknown =>
    new Proxy(overrides, {
      get: (target, key) => {
        if (typeof key !== 'string') return undefined
        if (key in target) return target[key]
        return key.startsWith('on') ? () => () => undefined : (..._args: unknown[]) => pending()
      }
    })
  const sections: Record<string, unknown> = {
    settings: section({
      get: async () => ({ provider: { llmProvider: 'claude-subscription', model: 'opus' }, permissions: { defaultMode: 'accept_edits' }, integrations: { skills: { enabledSkills: [] } } }),
      getOptions: async () => ({ themes: [], accentColors: [], llmProviders: [], agentTypes: [] })
    }),
    skills: section({ list: async () => ({ skills: [] }) }),
    threads: section({
      create, select: async () => undefined, get: async (id: string) => madeThread(id),
      applySettings: async (id: string, _setup: unknown, revision: number) => ({ ok: true, thread: { ...madeThread(id), settingsRevision: revision + 1 } })
    }),
    orchestrator: section({ sendToThread, isTurnActive: async () => false })
  }
  ;(window as unknown as { mousse: unknown }).mousse = new Proxy(sections, {
    get: (target, key) => {
      if (typeof key !== 'string') return undefined
      if (!(key in target)) target[key] = section({})
      return target[key]
    }
  })
}

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

/** Runs the frame callbacks queued so far, then the task each queues: the frame is drawn. */
async function drawFrame(): Promise<void> {
  const queued = frames.splice(0)
  for (const callback of queued) callback(performance.now())
  await settle(2)
}

const input = () => host.querySelector<HTMLTextAreaElement>('.composer-input')!
const pendingRows = () => usePendingThreadRows.getState().rows

function type(text: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), text)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Presses Enter in the composer; nothing is awaited, so a test sees the state the click itself left. */
function pressEnter(): void {
  act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
}

async function showNewChat(): Promise<void> {
  stubBridge()
  useAppStore.setState({
    profileId: 'prf_test', profileReady: true, workspaceReady: true, loading: false,
    projects: [project], threads: [], activeThreadId: null, messages: [], workspacePending: {}, composerDrafts: {},
    composerWorkspaceDrafts: { __blank__: { projectId: 'p1', worktreeEnabled: false } }
  })
  const { OrchestratorChat } = await import('../../src/renderer/components/OrchestratorChat')
  await act(async () => root.render(createElement(OrchestratorChat)))
  await settle()
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  frames = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  create = vi.fn(async () => madeThread('t1'))
  sendToThread = vi.fn(() => new Promise(() => undefined))
  usePendingThreadRows.setState({ rows: [], rowKeys: new Map() })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  // A send left waiting for its frame ends; its hold on the chat goes with it.
  await drawFrame()
})

describe('Send in a new chat', () => {
  it('lists the row in the click itself, before anything is awaited or the service is called', async () => {
    await showNewChat()
    type('Plan the release notes')
    pressEnter()
    expect(pendingRows()).toHaveLength(1)
    expect(pendingRows()[0]!.thread).toMatchObject({ name: 'Plan the release notes', projectId: 'p1' })
    expect(create).not.toHaveBeenCalled()
  })

  it('locks the composer only once the row frame is drawn, and calls the service after it', async () => {
    await showNewChat()
    type('Plan the release notes')
    pressEnter()
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })
    expect(isWorkspacePending(useAppStore.getState())).toBe(false)
    expect(create).not.toHaveBeenCalled()
    await drawFrame()
    expect(create).toHaveBeenCalledTimes(1)
    await settle()
    expect(sendToThread).toHaveBeenCalledTimes(1)
  })

  it('makes one thread for a double Send', async () => {
    await showNewChat()
    type('Plan the release notes')
    pressEnter()
    pressEnter()
    await drawFrame()
    await settle()
    expect(create).toHaveBeenCalledTimes(1)
    expect(pendingRows()).toHaveLength(1)
  })

  it('refuses a quick action for the chat in the frame before the composer locks', async () => {
    await showNewChat()
    type('Plan the release notes')
    pressEnter()
    expect(isWorkspacePending(useAppStore.getState())).toBe(false)
    await expect(threadForSend('prf_test')).rejects.toBeInstanceOf(WorkspaceBusyError)
    await drawFrame()
    await settle()
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('takes the row away when the create fails, and keeps the prompt with the error', async () => {
    create.mockImplementation(async () => { throw new Error('The service did not answer.') })
    await showNewChat()
    type('Plan the release notes')
    pressEnter()
    expect(pendingRows()).toHaveLength(1)
    await drawFrame()
    await settle()
    expect(pendingRows()).toEqual([])
    expect(input().value).toBe('Plan the release notes')
    expect(host.textContent).toContain('The service did not answer.')
    expect(isWorkspacePending(useAppStore.getState())).toBe(false)
  })

  it('claims the made thread for the row and lists it', async () => {
    await showNewChat()
    type('Plan the release notes')
    pressEnter()
    const key = pendingRows()[0]!.key
    await drawFrame()
    await settle()
    expect(pendingRows()[0]).toMatchObject({ key, threadId: 't1' })
    expect(usePendingThreadRows.getState().rowKeys.get('t1')?.key).toBe(key)
    expect(useAppStore.getState().threads.map((thread) => thread.id)).toContain('t1')
  })

  it('lists a thread made after the composer moved on, so its row does not blink out', async () => {
    let answer!: (thread: Thread) => void
    create.mockImplementation(() => new Promise<Thread>((resolve) => { answer = resolve }))
    await showNewChat()
    type('Plan the release notes')
    pressEnter()
    await drawFrame()
    // The person opens another thread before the create answers.
    act(() => useAppStore.setState({ activeThreadId: 'elsewhere' }))
    await act(async () => { answer(madeThread('t1')) })
    await settle()
    expect(useAppStore.getState().threads.map((thread) => thread.id)).toEqual(['t1'])
    // The send stopped there: its row is the thread's own now.
    expect(pendingRows()).toEqual([])
  })

  it('keeps what was typed while the row frame was drawn', async () => {
    await showNewChat()
    type('Plan the release notes')
    pressEnter()
    type('Plan the release notes and then')
    await drawFrame()
    await settle()
    expect(sendToThread).toHaveBeenCalledWith('t1', expect.objectContaining({ content: 'Plan the release notes' }))
    expect(input().value).toBe(' and then')
  })
})
