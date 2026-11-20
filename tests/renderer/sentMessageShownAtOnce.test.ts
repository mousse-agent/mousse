// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The shell shows the composer; the transcript and the queue it is given are what the chat shows (`shown`, `queued`).
const shell = vi.hoisted(() => ({
  messages: [] as Array<{ role: string; parts?: Array<{ type: string; text?: string }>; metadata?: { steered?: boolean } }>,
  queue: null as null | { items: Array<{ content: string }> }
}))
vi.mock('../../src/renderer/chat/components/MousseAgentChatShell', async () => {
  const { createElement: create } = await import('react')
  const { ComposerNoticeProvider } = await import('../../src/renderer/components/ComposerNotice')
  return {
    MousseAgentChatShell: ({ composer, messages, queue }: { composer: never; messages: typeof shell.messages; queue: typeof shell.queue }) => {
      shell.messages = messages
      shell.queue = queue
      return create(ComposerNoticeProvider, null, composer)
    }
  }
})
vi.mock('../../src/renderer/dictation/microphone', () => ({}))

let root: Root
let host: HTMLElement
let orchestrator: Record<string, unknown>
/** The retry signature's hash, held until the test lets it finish: the moment between the click and the send. */
let releaseDigest: () => void

function stubBridge(): void {
  const pending = () => new Promise(() => undefined)
  const section = (overrides: Record<string, unknown>): unknown =>
    new Proxy(overrides, {
      get: (target, key) => {
        if (typeof key !== 'string') return undefined
        if (key in target) return target[key]
        if (key.startsWith('on')) return () => () => undefined
        return () => pending()
      }
    })
  const sections: Record<string, unknown> = {
    orchestrator: section(orchestrator),
    skills: section({ list: () => Promise.resolve({ skills: [] }) }),
    queue: section({ list: async () => [], promoteToSteer: async () => ({ ok: true }) })
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
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

const composer = () => host.querySelector<HTMLTextAreaElement>('.composer-input')!
const textOf = (message: (typeof shell.messages)[number]) => (message.parts ?? []).map((part) => part.text ?? '').join('')
/** The prompts the transcript shows, by their words. */
const shown = () => shell.messages.filter((message) => message.role === 'user' && !message.metadata?.steered).map(textOf)
/** The steered messages the reply shows. */
const steered = () => shell.messages.filter((message) => message.role === 'user' && message.metadata?.steered).map(textOf)
const queued = () => (shell.queue?.items ?? []).map((item) => item.content)

async function type(text: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer(), text)
    composer().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function press(init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => { composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...init })) })
  await settle()
}

async function mount(working: boolean): Promise<void> {
  const { useAppStore } = await import('../../src/renderer/stores/appStore')
  useAppStore.setState({
    loading: working,
    turnStates: { 'thread-a': { phase: working ? 'streaming' : 'completed', turnId: 'run-1' } } as never
  })
  stubBridge()
  const { OrchestratorChat } = await import('../../src/renderer/components/OrchestratorChat')
  await act(async () => root.render(createElement(OrchestratorChat)))
  await settle()
}

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const real = globalThis.crypto
  const held = new Promise<void>((resolve) => { releaseDigest = resolve })
  vi.stubGlobal('crypto', {
    randomUUID: () => real.randomUUID(),
    getRandomValues: <T extends ArrayBufferView>(array: T) => real.getRandomValues(array as never) as T,
    subtle: { digest: async (algorithm: string, data: BufferSource) => { await held; return real.subtle.digest(algorithm, data) } }
  })
  orchestrator = { isTurnActive: vi.fn(async () => false) }
  const now = new Date().toISOString()
  const { useAppStore } = await import('../../src/renderer/stores/appStore')
  useAppStore.setState({
    profileId: 'prf_test', profileReady: true, workspaceReady: true, threadActivity: {},
    activeThreadId: 'thread-a',
    threads: [{ id: 'thread-a', name: 'A', createdAt: now, updatedAt: now, startedAt: now, order: 0 }] as never,
    messages: [{ id: 'm-1', role: 'user', content: 'First message', timestamp: now }] as never
  })
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

describe('a sent message is on the screen from the click', () => {
  it('a prompt shows in the transcript as the composer clears; a refused one leaves it and comes back to the composer', async () => {
    let refuse: (error: Error) => void = () => undefined
    orchestrator.sendToThread = vi.fn(() => new Promise((_resolve, reject) => { refuse = reject }))
    await mount(false)
    await type('Fix the login bug')
    await press()
    expect(composer().value).toBe('')
    expect(shown()).toEqual(['First message', 'Fix the login bug'])

    releaseDigest()
    await settle()
    expect(orchestrator.sendToThread).toHaveBeenCalledTimes(1)
    await act(async () => { refuse(new Error('The thread was deleted')) })
    await settle()
    expect(shown()).toEqual(['First message'])
    expect(composer().value).toBe('Fix the login bug')
  })

  it('a message sent while a reply runs shows in the queue as the composer clears', async () => {
    orchestrator.sendToThread = vi.fn(() => new Promise(() => undefined))
    await mount(true)
    await type('Then run the tests')
    await press()
    expect(composer().value).toBe('')
    expect(queued()).toEqual(['Then run the tests'])
  })

  it('a steer with an image shows in the reply as the composer clears', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:shot', revokeObjectURL: () => undefined }))
    orchestrator.steer = vi.fn(async () => true)
    orchestrator.sendToThread = vi.fn(() => new Promise(() => undefined))
    await mount(true)
    const shot = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' })
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: { items: [{ kind: 'file', getAsFile: () => shot }], files: [], getData: () => '' } })
    await act(async () => { composer().dispatchEvent(paste) })
    await settle()
    await type('Look at this')
    await press({ ctrlKey: true })
    expect(composer().value).toBe('')
    expect(steered()).toEqual(['Look at this'])
  })
})
