// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingUserQuestions } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The transcript is not part of this check: the shell shows the composer only.
vi.mock('../../src/renderer/chat/components/MousseAgentChatShell', () => ({
  MousseAgentChatShell: ({ composer }: { composer: unknown }) => composer
}))
vi.mock('../../src/renderer/dictation/microphone', () => ({}))

let root: Root
let host: HTMLElement
let pendingListeners: Array<(payload: PendingUserQuestions) => void>
let answerCalls: unknown[][]

/** `window.mousse` for the composer: question events are captured; any other call stays pending. */
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
    orchestrator: section({
      onQuestionsPending: (listener: (payload: PendingUserQuestions) => void) => {
        pendingListeners.push(listener)
        return () => { pendingListeners = pendingListeners.filter((entry) => entry !== listener) }
      },
      answerQuestionsDetailed: (...args: unknown[]) => { answerCalls.push(args); return Promise.resolve({ ok: true }) },
      answerQuestions: (...args: unknown[]) => { answerCalls.push(args); return Promise.resolve(true) }
    }),
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

const question = (requestId: string, threadId?: string): PendingUserQuestions => ({
  requestId,
  questions: [{ id: 'scope', prompt: 'Which area?', options: [{ id: 'ui', label: 'UI' }, { id: 'api', label: 'API' }] }],
  ...(threadId ? { threadId } : {})
})

async function ask(payload: PendingUserQuestions): Promise<void> {
  await act(async () => { for (const listener of pendingListeners) listener(payload) })
  // The card's open animation runs over two frames.
  await settle()
}

async function openThread(threadId: string): Promise<void> {
  const { useAppStore } = await import('../../src/renderer/stores/appStore')
  await act(async () => { useAppStore.setState({ activeThreadId: threadId }) })
  await settle()
}

const card = () => host.querySelector('.composer-question-modal')

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  pendingListeners = []
  answerCalls = []
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

describe('a question card belongs to the thread that asked it', () => {
  it('shows in its own thread and not in the next one, and comes back with the thread', async () => {
    await ask(question('req-a', 'thread-a'))
    expect(card()?.textContent).toContain('Which area?')

    await openThread('thread-b')
    expect(card()).toBeNull()
    // Selecting a thread again sends its waiting questions again.
    await openThread('thread-a')
    expect(card()).toBeNull()
    await ask(question('req-a', 'thread-a'))
    expect(card()?.textContent).toContain('Which area?')
  })

  it("does not answer the last thread's question with a message sent in the next one", async () => {
    await ask(question('req-a', 'thread-a'))
    await openThread('thread-b')
    const input = host.querySelector<HTMLTextAreaElement>('.composer-input')!
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setValue.call(input, 'API')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await settle()
    expect(answerCalls).toEqual([])
  })

  it("ignores a question another thread asks while this one is open, and one that names no thread after a switch", async () => {
    await openThread('thread-b')
    await ask(question('req-a', 'thread-a'))
    expect(card()).toBeNull()
    // A question that names no thread is taken as the open thread's.
    await ask(question('req-b'))
    expect(card()?.textContent).toContain('Which area?')
    await openThread('thread-c')
    expect(card()).toBeNull()
  })
})
