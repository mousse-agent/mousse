// @vitest-environment jsdom
// #595: an agent's secret request shows as a private form in the transcript of its thread, in the turn that asked. The value is typed into a
// masked field, sent once with the chosen keep, and is gone from the window once saved; Decline and Use saved answer too.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SecretRequestView } from '../../src/shared/secretRequests'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The shell's chrome is not part of this check: it shows the real transcript list, then the composer.
vi.mock('../../src/renderer/chat/components/MousseAgentChatShell', async () => {
  const { createElement, Fragment } = await import('react')
  const { MessageList } = await import('../../src/renderer/chat/components/agent-elements/message-list')
  return {
    MousseAgentChatShell: ({ composer, messages }: { composer: unknown; messages: unknown[] }) =>
      createElement(Fragment, null, createElement('div', { 'data-testid': 'transcript' }, createElement(MessageList, { messages, status: 'streaming' } as never)), composer)
  }
})
vi.mock('../../src/renderer/dictation/microphone', () => ({}))

const VALUE = 'hf_typed-secret-value-1234'

let root: Root
let host: HTMLElement
let open: Record<string, SecretRequestView[]>
let calls: Array<{ method: string; params: Record<string, unknown> }>
let changed: Array<(payload: { threadId: string }) => void>

const request = (threadId: string, extra: Partial<SecretRequestView> = {}): SecretRequestView => ({
  requestId: `req-${threadId}`,
  threadId,
  label: 'Hugging Face write token',
  reason: 'To upload the model to the Hub.',
  link: 'https://huggingface.co/settings/tokens',
  format: 'starts with hf_',
  name: 'HF_TOKEN',
  savedExists: false,
  createdAt: '2026-11-15T10:00:00.000Z',
  ...extra
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
  const answered = (threadId: string) => {
    open[threadId] = []
    for (const listener of changed) listener({ threadId })
  }
  const sections: Record<string, unknown> = {
    orchestrator: section({
      onSecretRequestsChanged: (listener: (payload: { threadId: string }) => void) => {
        changed.push(listener)
        return () => { changed = changed.filter((entry) => entry !== listener) }
      }
    }),
    platformRequest: {
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params })
        const threadId = params.threadId as string
        if (method === 'secrets.requests.list') return { requests: open[threadId] ?? [] }
        if (method === 'secrets.requests.answer' || method === 'secrets.requests.useSaved') { answered(threadId); return { name: 'HF_TOKEN' } }
        if (method === 'secrets.requests.decline') { answered(threadId); return { ok: true } }
        return pending()
      }
    },
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
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

async function asked(threadId: string, extra: Partial<SecretRequestView> = {}): Promise<void> {
  open[threadId] = [request(threadId, extra)]
  await act(async () => { for (const listener of changed) listener({ threadId }) })
  await settle()
}

const card = () => host.querySelector<HTMLElement>('.secret-request-card')
const field = () => card()!.querySelector<HTMLInputElement>('input')!
const button = (name: string) => [...card()!.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent?.trim() === name || entry.getAttribute('aria-label') === name)

async function type(value: string): Promise<void> {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setValue.call(field(), value)
    field().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function click(target: HTMLElement | undefined): Promise<void> {
  expect(target).toBeDefined()
  await act(async () => { target!.click() })
  await settle()
}

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  open = {}
  calls = []
  changed = []
  stubBridge()
  const { useAppStore } = await import('../../src/renderer/stores/appStore')
  useAppStore.setState({ profileId: 'prf_test', profileReady: true, workspaceReady: true, activeThreadId: 'thread-a' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const { OrchestratorChat } = await import('../../src/renderer/components/OrchestratorChat')
  await act(async () => root.render(createElement(OrchestratorChat)))
  await settle()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('the secret card', () => {
  it('asks in its own thread with a masked field, and Save securely sends the value once with how long to keep it', async () => {
    await asked('thread-b')
    expect(card()).toBeNull()
    await asked('thread-a')
    const dialog = card()!
    // In the transcript, not over the composer.
    expect(dialog.closest('[data-testid="transcript"]')).not.toBeNull()
    expect(dialog.closest('.chat-input-area')).toBeNull()
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy()
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Hugging Face write token')
    expect(dialog.textContent).toContain('Hugging Face write token')
    expect(dialog.textContent).toContain('To upload the model to the Hub.')
    expect(dialog.textContent).toContain('Expected: starts with hf_')
    expect(dialog.querySelector('a')?.getAttribute('href')).toBe('https://huggingface.co/settings/tokens')
    expect(field().type).toBe('password')
    expect(field().getAttribute('aria-label')).toBe('Hugging Face write token')
    // Where it is kept and for how long, for the choice made.
    expect(dialog.textContent).toContain('for 24 hours, then deleted')
    await click([...dialog.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((entry) => entry.textContent === 'This thread only'))
    expect(card()!.textContent).toContain('for this thread only')

    expect(button('Save securely')!.disabled).toBe(true)
    await type(VALUE)
    await click(button('Save securely'))
    const answers = calls.filter((call) => call.method === 'secrets.requests.answer')
    expect(answers).toEqual([{ method: 'secrets.requests.answer', params: { threadId: 'thread-a', requestId: 'req-thread-a', value: VALUE, keep: 'thread' } }])
    // The card is gone and the value is nowhere in the window.
    expect(card()).toBeNull()
    expect(document.body.innerHTML).not.toContain(VALUE)
    expect(host.querySelector<HTMLTextAreaElement>('.composer-input')?.value ?? '').not.toContain(VALUE)
  })

  it('Decline answers without a value; Use saved is offered only when a saved secret has the name', async () => {
    await asked('thread-a')
    expect(button('Use saved HF_TOKEN')).toBeUndefined()
    await type(VALUE)
    await click(button('Decline'))
    expect(calls.filter((call) => call.method.startsWith('secrets.requests.') && call.method !== 'secrets.requests.list')).toEqual([
      { method: 'secrets.requests.decline', params: { threadId: 'thread-a', requestId: 'req-thread-a' } }
    ])
    expect(card()).toBeNull()

    await asked('thread-a', { savedExists: true })
    await click(button('Use saved HF_TOKEN'))
    expect(calls.filter((call) => call.method === 'secrets.requests.useSaved')).toEqual([{ method: 'secrets.requests.useSaved', params: { threadId: 'thread-a', requestId: 'req-thread-a' } }])
    expect(card()).toBeNull()
  })
})
