// @vitest-environment jsdom
/**
 * A copied thread reference pasted into a thread's composer goes in as text, in the line being typed, and the message
 * sent carries the link where it was written, with no references block; the sent bubble draws it as the thread's chip
 * in place. A private thread can't be pointed at from a shared one. A sidebar thread dropped on the composer is still a
 * pill, sent as a pointer to the thread, never its transcript. The real chat, composer and bubble; the bridge is a stub.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { MOUSSE_REFERENCE_MIME, THREAD_REFERENCE_NOTE, extractChatReferences } from '../../src/shared/chatReferences'

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

/** A thread from the sidebar dropped on the composer. */
async function drop(threadId: string, title: string): Promise<void> {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  const data = JSON.stringify({ id: `thread:${threadId}`, kind: 'thread', title, threadId })
  Object.defineProperty(event, 'dataTransfer', { value: { types: [MOUSSE_REFERENCE_MIME], files: [], getData: (type: string) => (type === MOUSSE_REFERENCE_MIME ? data : '') } })
  await act(async () => { box().dispatchEvent(event) })
  await settle()
}

describe('a thread reference pasted in a thread\'s composer', () => {
  it('goes in as text where the caret is, and is sent in the line, with no references block', async () => {
    await mount()
    await type('Pick up where ')
    // Not taken by the composer: the text box inserts it at the caret, as any paste.
    expect(await paste('mousse://thread/thread-b')).toBe(false)
    expect(pills()).toEqual([])

    await type('Pick up where mousse://thread/thread-b left off')
    const content = await send()
    expect(content).toBe('Pick up where mousse://thread/thread-b left off')
    expect(resolve).not.toHaveBeenCalled()
  })

  it('a private thread is refused from a shared thread, with the reason, alone or amid other words', async () => {
    await mount()
    await type('see ')
    expect(await paste('mousse://thread/thread-p')).toBe(true)
    expect(host.textContent).toContain('“Secret plans” is private')
    expect(await paste('notes in mousse://thread/thread-p, and mousse://thread/thread-b')).toBe(true)
    expect(box().value).toBe('see ')
  })

  it('a private thread may point at another private thread', async () => {
    await mount('thread-p')
    expect(await paste('mousse://thread/thread-p')).toBe(false)
    expect(host.textContent).not.toContain('is private')
  })

  it('a dropped sidebar thread is a pill, and the message sent points at the thread without its content', async () => {
    await mount()
    await drop('thread-b', 'Design notes')
    expect(pills()).toEqual(['Design notes'])

    await type('Pick up where this left off')
    const content = await send()
    expect(content).toContain('Thread ID: thread-b')
    expect(content).toContain('Link: mousse://thread/thread-b')
    expect(content).toContain(THREAD_REFERENCE_NOTE)
    expect(content).not.toMatch(/meta\.json|Path:/)
    expect(extractChatReferences(content)).toMatchObject({ text: 'Pick up where this left off', references: [{ kind: 'thread', threadId: 'thread-b', title: 'Design notes' }] })
    expect(pills()).toEqual([])
  })
})

describe('a sent message with a thread link', () => {
  it('shows the thread\'s chip in place, in the flow of the text; a link in inline code stays text', async () => {
    await mount()
    const { UserMessage } = await import('../../src/renderer/chat/components/agent-elements/user-message')
    const text = 'Pick up where mousse://thread/thread-b left off, not `mousse://thread/thread-a`'
    await act(async () => root.render(createElement(UserMessage, { message: { id: 'm1', role: 'user', parts: [{ type: 'text', text }] } as UIMessage })))
    const prompt = host.querySelector('.chat-user-text')!
    expect([...prompt.childNodes].map((node) => (node as Element).classList?.contains('thread-chip') ? `[${node.textContent}]` : node.textContent))
      .toEqual(['Pick up where ', '[Design notes]', ' left off, not `mousse://thread/thread-a`'])
  })
})
