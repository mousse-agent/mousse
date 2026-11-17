// @vitest-environment jsdom
/**
 * The question card for questions an agent asked without waiting (issue #1372): several can be open in one thread, and
 * the card shows one at a time, says the agent keeps working, and moves on to the next once one is answered or settled
 * elsewhere.
 */
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
let clearedListeners: Array<(payload: { requestId: string; threadId?: string }) => void>
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
      onQuestionsCleared: (listener: (payload: { requestId: string; threadId?: string }) => void) => {
        clearedListeners.push(listener)
        return () => { clearedListeners = clearedListeners.filter((entry) => entry !== listener) }
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

/** A question the agent asked without waiting, in thread-a. */
const open = (requestId: string, prompt: string): PendingUserQuestions => ({
  requestId,
  threadId: 'thread-a',
  wait: false,
  questions: [{ id: 'q', prompt, options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] }]
})

async function pause(ms: number): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) })
  await settle()
}

async function clear(requestId: string): Promise<void> {
  await act(async () => { for (const listener of clearedListeners) listener({ requestId, threadId: 'thread-a' }) })
  await settle()
}

const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent?.trim() === name)

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
  clearedListeners = []
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

describe('questions asked without waiting', () => {
  it('shows one at a time, says the agent keeps working, and moves on once it is answered', async () => {
    await ask(open('req-1', 'Round corners?'))
    await ask(open('req-2', 'Add a shadow?'))
    expect(card()?.textContent).toContain('Round corners?')
    expect(card()?.textContent).toContain('The agent keeps working while you decide.')

    await act(async () => { button('Yes')!.click() })
    await settle()
    await act(async () => { button('Submit')!.click() })
    await settle()
    expect(answerCalls.map((call) => call[0])).toEqual(['req-1'])
    expect(answerCalls[0]![1]).toEqual({ q: 'yes' })
    // The next open question takes its place.
    expect(card()?.textContent).toContain('Add a shadow?')
  })

  it('shows the next one when the shown one is settled elsewhere (another device, or withdrawn)', async () => {
    await ask(open('req-1', 'Round corners?'))
    await ask(open('req-2', 'Add a shadow?'))
    await clear('req-1')
    expect(card()?.textContent).toContain('Add a shadow?')
    await clear('req-2')
    // The card closes with its leave animation.
    await pause(400)
    expect(card()).toBeNull()
  })

  it('shows a question the agent waits on before the ones it does not', async () => {
    await ask(open('req-1', 'Round corners?'))
    await ask({ requestId: 'req-wait', threadId: 'thread-a', questions: [{ id: 'q', prompt: 'Delete the old badge?', options: [{ id: 'y', label: 'Delete' }, { id: 'n', label: 'Keep' }] }] })
    expect(card()?.textContent).toContain('Delete the old badge?')
    expect(card()?.textContent).not.toContain('The agent keeps working')
  })

  it('offers to send a typed message as a message, which leaves the question open', async () => {
    await ask(open('req-1', 'Round corners?'))
    const input = host.querySelector<HTMLTextAreaElement>('.composer-input')!
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setValue.call(input, 'also make it bigger')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await settle()
    expect(button('Skip questions and send')).toBeUndefined()
    await act(async () => { button('Send as a message')!.click() })
    await settle()
    expect(answerCalls).toEqual([])
    expect(card()?.textContent).toContain('Round corners?')
  })
})
