// @vitest-environment jsdom
/**
 * A copied thread reference pasted into a thread's composer: it becomes a thread pill, and the message sent carries a
 * pointer to the thread (its id, link and how to read it), never its transcript. A private thread can't be pointed at
 * from a shared one. The real chat and composer; the bridge is a stub.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { THREAD_REFERENCE_NOTE, extractChatReferences } from '../../src/shared/chatReferences'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The transcript is not part of this check: the shell shows the composer and its notices only.
vi.mock('../../src/renderer/chat/components/MousseAgentChatShell', async () => {
  const { createElement: create } = await import('react')
  const { ComposerNoticeProvider } = await import('../../src/renderer/components/ComposerNotice')
  return { MousseAgentChatShell: (props: { composer: never; children?: never }) => create(ComposerNoticeProvider, null, props.children, props.composer) }
})
vi.mock('../../src/renderer/dictation/microphone', () => ({}))

let root: Root
let host: HTMLElement
let sendToThread: ReturnType<typeof vi.fn>
let resolve: ReturnType<typeof vi.fn>

function stubBridge(): void {
  const pending = () => new Promise(() => undefined)
  const section = (overrides: Record<string, unknown>): unknown => new Proxy(overrides, {
    get: (target, key) => {
      if (typeof key !== 'string') return undefined
      if (key in target) return target[key]
      if (key.startsWith('on')) return () => () => {}
      return () => pending()
    }
  })
  const sections: Record<string, unknown> = {
    orchestrator: section({ sendToThread, isTurnActive: async () => false }),
    chatReferences: section({ resolve }),
    skills: section({ list: () => Promise.resolve({ skills: [] }) })
  }
  ;(window as unknown as { mousse: unknown }).mousse = new Proxy(sections, {
    get: (target, key) => {
      if (typeof key !== 'string') return undefined
      if (!(key in target)) target[key] = section({})
      return target[key]
    }
  })
}

async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((done) => setTimeout(done, 0)) })
}

async function mount(activeThreadId = 'thread-a'): Promise<void> {
  const now = new Date().toISOString()
  const { useAppStore } = await import('../../src/renderer/stores/appStore')
  useAppStore.setState({
    profileId: 'prf_test', profileReady: true, workspaceReady: true, loading: false,
    activeThreadId, composerDrafts: {}, composerReferences: {},
    threads: [
      { id: 'thread-a', name: 'A', createdAt: now, updatedAt: now, startedAt: now, order: 0 },
      { id: 'thread-b', name: 'Design notes', projectId: 'p1', createdAt: now, updatedAt: now, startedAt: now, order: 1 },
      { id: 'thread-p', name: 'Secret plans', localOnly: true, createdAt: now, updatedAt: now, startedAt: now, order: 2 }
    ] as never,
    messages: [] as never
  })
  stubBridge()
  const { OrchestratorChat } = await import('../../src/renderer/components/OrchestratorChat')
  await act(async () => root.render(createElement(OrchestratorChat)))
  await settle()
}

const box = () => host.querySelector<HTMLTextAreaElement>('.composer-input')!
const pills = () => [...host.querySelectorAll('.composer-reference-pill')].map((pill) => pill.textContent?.trim())

/** A text paste in the composer. Returns whether the composer took it. */
async function paste(text: string): Promise<boolean> {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }], files: [], types: ['text/plain'], getData: () => text } })
  await act(async () => { box().dispatchEvent(event) })
  await settle()
  return event.defaultPrevented
}

async function type(text: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box(), text)
    box().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function send(): Promise<string> {
  await act(async () => { box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  await settle()
  return (sendToThread.mock.calls.at(-1)?.[1] as { content: string }).content
}

// The chat's module graph is large: load it once, outside the tests' time limit, so a busy machine can't time out the first test.
beforeAll(async () => { await import('../../src/renderer/components/OrchestratorChat') }, 120_000)

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  sendToThread = vi.fn(async () => ({ message: '', actions: [] }))
  // The daemon answers with the thread as it holds it.
  resolve = vi.fn(async (reference: { threadId: string }) => ({ ...reference, title: 'Design notes', projectId: 'p1' }))
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('a thread reference pasted in a thread\'s composer', () => {
  it('becomes a pill, and the message sent points at the thread without its content', async () => {
    await mount()
    expect(await paste('mousse://thread/thread-b')).toBe(true)
    expect(box().value).toBe('')
    expect(pills()).toEqual(['Design notes'])

    await type('Pick up where this left off')
    const content = await send()
    expect(content).toContain('Pick up where this left off')
    expect(content).toContain('Thread ID: thread-b')
    expect(content).toContain('Link: mousse://thread/thread-b')
    expect(content).toContain(THREAD_REFERENCE_NOTE)
    expect(content).not.toMatch(/meta\.json|Path:/)
    // The sent bubble shows the same pill again.
    expect(extractChatReferences(content)).toMatchObject({ text: 'Pick up where this left off', references: [{ kind: 'thread', threadId: 'thread-b', title: 'Design notes' }] })
    expect(pills()).toEqual([])
  })

  it('a link amid other words stays text', async () => {
    await mount()
    expect(await paste('see mousse://thread/thread-b for context')).toBe(false)
    expect(pills()).toEqual([])
  })

  it('a thread of another computer becomes a pill without asking this daemon', async () => {
    await mount()
    expect(await paste('mousse://thread/nod_0123456789abcdefghjkmnpqrs:thread-z')).toBe(true)
    expect(host.querySelectorAll('.composer-reference-pill')).toHaveLength(1)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('a private thread is refused from a shared thread, with the reason', async () => {
    await mount()
    await paste('mousse://thread/thread-p')
    expect(pills()).toEqual([])
    expect(host.textContent).toContain('“Secret plans” is private')
  })

  it('a private thread may point at another private thread', async () => {
    await mount('thread-p')
    await paste('mousse://thread/thread-b')
    expect(pills()).toEqual(['Design notes'])
  })
})
