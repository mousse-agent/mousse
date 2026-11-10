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

async function send(text: string, init: KeyboardEventInit = {}): Promise<void> {
  const input = host.querySelector<HTMLTextAreaElement>('.composer-input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...init })) })
  await settle()
}

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  listeners = {}
  orchestrator = {}
  const now = new Date().toISOString()
  const { useAppStore } = await import('../../src/renderer/stores/appStore')
  useAppStore.setState({
    profileId: 'prf_test', profileReady: true, workspaceReady: true, loading: true,
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

describe('a steer from the composer', () => {
  it('is not sent again when its request gets no answer: the thread is read again, and the text comes back only if it did not arrive', async () => {
    orchestrator.isTurnActive = vi.fn(async () => true)
    orchestrator.steer = vi.fn(async () => { throw new Error('reply lost') })
    orchestrator.sendToThread = vi.fn(async () => ({ message: '', actions: [], queued: true }))
    orchestrator.send = vi.fn(async () => ({ message: '', actions: [], queued: true }))
    const select = vi.fn(async () => undefined)
    const list = vi.fn(async () => [])
    ;(window as unknown as { mousse: Record<string, unknown> }).mousse = (window as unknown as { mousse: Record<string, unknown> }).mousse
    await mount()
    const bridge = (window as unknown as { mousse: Record<string, Record<string, unknown>> }).mousse
    bridge.threads.select = select
    bridge.queue.list = list
    await send('Use the id', { ctrlKey: true })
    await settle(20)
    expect(orchestrator.steer).toHaveBeenCalledTimes(1)
    // Never sent a second time as a queued message.
    expect(orchestrator.sendToThread).not.toHaveBeenCalled()
    expect(orchestrator.send).not.toHaveBeenCalled()
    expect(select).toHaveBeenCalledWith('thread-a')
    // It did not arrive: the text is back in the composer.
    expect(host.querySelector<HTMLTextAreaElement>('.composer-input')!.value).toBe('Use the id')
  })
})
