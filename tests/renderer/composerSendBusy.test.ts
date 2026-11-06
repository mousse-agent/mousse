// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SERVICE_LOST_RECONNECT, SERVICE_LOST_TITLE } from '../../src/renderer/components/ServiceLostNotice'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The transcript is not part of this check: the shell shows the composer and its notices only.
vi.mock('../../src/renderer/chat/components/MousseAgentChatShell', async () => {
  const { createElement: create } = await import('react')
  const { ComposerNoticeProvider } = await import('../../src/renderer/components/ComposerNotice')
  return { MousseAgentChatShell: ({ composer }: { composer: never }) => create(ComposerNoticeProvider, null, composer) }
})
vi.mock('../../src/renderer/dictation/microphone', () => ({}))

let root: Root
let host: HTMLElement
let listeners: Record<string, Array<(payload?: unknown) => void>>
let orchestrator: Record<string, unknown>

/** `window.mousse` for the composer: `orchestrator` overrides answer, `on…` subscriptions are captured; any other call stays pending. */
function stubBridge(): void {
  const pending = () => new Promise(() => undefined)
  const section = (name: string, overrides: Record<string, unknown>): unknown =>
    new Proxy(overrides, {
      get: (target, key) => {
        if (typeof key !== 'string') return undefined
        if (key in target) return target[key]
        if (key.startsWith('on')) {
          return (listener: (payload?: unknown) => void) => {
            const list = (listeners[`${name}.${key}`] ??= [])
            list.push(listener)
            return () => { list.splice(list.indexOf(listener), 1) }
          }
        }
        return (..._args: unknown[]) => pending()
      }
    })
  const sections: Record<string, unknown> = {
    orchestrator: section('orchestrator', orchestrator),
    skills: section('skills', { list: () => Promise.resolve({ skills: [] }) })
  }
  ;(window as unknown as { mousse: unknown }).mousse = new Proxy(sections, {
    get: (target, key) => {
      if (typeof key !== 'string') return undefined
      if (!(key in target)) target[key] = section(key, {})
      return target[key]
    }
  })
}

async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

async function mount(): Promise<void> {
  stubBridge()
  const { OrchestratorChat } = await import('../../src/renderer/components/OrchestratorChat')
  await act(async () => root.render(createElement(OrchestratorChat)))
  await settle()
}

async function send(text: string): Promise<void> {
  const input = host.querySelector<HTMLTextAreaElement>('.composer-input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  await settle()
}

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  listeners = {}
  orchestrator = {}
  const now = new Date().toISOString()
  const { useAppStore } = await import('../../src/renderer/stores/appStore')
  useAppStore.setState({
    profileId: 'prf_test', profileReady: true, workspaceReady: true, loading: false,
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

describe('the composer follows what a send did', () => {
  it('shows a message the service queued in the queue only, not also in the transcript', async () => {
    // The composer was idle when the message was sent, but a turn started meanwhile, so the service queued it.
    let turnRunning = false
    const now = new Date().toISOString()
    orchestrator.sendToThread = vi.fn(async () => {
      turnRunning = true
      return {
        message: '', actions: [], queued: true,
        queueItem: { id: 'queue-1', threadId: 'thread-a', content: 'Second message', mode: 'build', enqueuedAt: now, order: 1, intent: 'normal', state: 'pending', source: 'gui' }
      }
    })
    orchestrator.isTurnActive = vi.fn(async () => turnRunning)
    await mount()
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    const shown: string[][] = []
    const off = useAppStore.subscribe((state) => { shown.push(state.messages.map((message) => message.id)) })
    await send('Second message')
    off()

    expect(orchestrator.sendToThread).toHaveBeenCalledTimes(1)
    // The message was painted in the transcript while the send was on its way, then moved to the queue.
    expect(shown.some((ids) => ids.some((id) => id.startsWith('optimistic:')))).toBe(true)
    expect(useAppStore.getState().messages.map((message) => message.id)).toEqual(['m-1'])
  })

  it('stops showing busy and shows the service notice again when reconnecting fails', async () => {
    orchestrator.retryConnection = vi.fn(async () => { throw new Error('ipc closed') })
    orchestrator.isTurnActive = vi.fn(async () => false)
    await mount()
    await act(async () => { for (const listener of listeners['orchestrator.onConnectionFailed'] ?? []) listener({}) })
    await settle()
    expect(host.textContent).toContain(SERVICE_LOST_TITLE)

    const reconnect = host.querySelector<HTMLButtonElement>(`button[aria-label="${SERVICE_LOST_RECONNECT}"]`)!
    await act(async () => { reconnect.click() })
    await settle()

    expect(orchestrator.retryConnection).toHaveBeenCalledWith('thread-a')
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    expect(useAppStore.getState().loading).toBe(false)
    expect(host.textContent).toContain(SERVICE_LOST_TITLE)
  })
})
