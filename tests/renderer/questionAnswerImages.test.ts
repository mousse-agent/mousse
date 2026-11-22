// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingUserQuestions } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The transcript is not part of this check: the shell shows the composer, the question card and their notices only.
vi.mock('../../src/renderer/chat/components/MousseAgentChatShell', async () => {
  const { createElement: create } = await import('react')
  const { ComposerNoticeProvider } = await import('../../src/renderer/components/ComposerNotice')
  return { MousseAgentChatShell: ({ composer }: { composer: never }) => create(ComposerNoticeProvider, null, composer) }
})
vi.mock('../../src/renderer/dictation/microphone', () => ({}))

/** A 1×1 PNG. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='

let root: Root
let host: HTMLElement
let listeners: Record<string, Array<(payload?: unknown) => void>>
let orchestrator: Record<string, ReturnType<typeof vi.fn>>

/** `window.mousse` for the chat: `orchestrator` overrides answer, `on…` subscriptions are captured; any other call stays pending. */
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
    skills: section('skills', { list: () => Promise.resolve({ skills: [] }) }),
    // Each inline image also goes as its file: a pasted one is written to a temporary file.
    threads: section('threads', { attachmentPath: async (file: File) => `/tmp/mousse-attachments/${file.name}` }),
    fileDrag: section('fileDrag', { pathOf: () => '' })
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

/** The agent asks; the card opens above the composer. */
async function ask(questions: PendingUserQuestions['questions']): Promise<void> {
  const payload: PendingUserQuestions = { requestId: 'ask-1', threadId: 'thread-a', questions }
  await act(async () => { for (const listener of listeners['orchestrator.onQuestionsPending'] ?? []) listener(payload) })
  await settle()
}

async function type(text: string): Promise<void> {
  const input = host.querySelector<HTMLTextAreaElement>('.composer-input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Attaches a screenshot through the composer's file picker. */
async function attachScreenshot(name = 'screen.png'): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('.composer-file-input')!
  const file = new File([Buffer.from(PNG, 'base64')], name, { type: 'image/png' })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
  await settle()
}

const sendButton = () => host.querySelector<HTMLButtonElement>('.composer-action-btn')!
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === label)

async function click(element: HTMLElement): Promise<void> {
  await act(async () => { element.click() })
  await settle()
}

const screenQuestion = { id: 'screen', prompt: 'Which screen do you mean?', options: [{ id: 'home', label: 'Home' }, { id: 'settings', label: 'Settings' }] }
const wrongQuestion = { id: 'wrong', prompt: 'What looks wrong?', options: [{ id: 'colors', label: 'Colors' }, { id: 'layout', label: 'Layout' }] }

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  // jsdom has no object URLs; the composer only uses them for previews.
  URL.createObjectURL = () => 'blob:preview'
  URL.revokeObjectURL = () => undefined
  listeners = {}
  orchestrator = {
    answerQuestionsDetailed: vi.fn(async () => ({ ok: true })),
    sendToThread: vi.fn(async () => ({ message: '', actions: [] }))
  }
  const now = new Date().toISOString()
  const { useAppStore } = await import('../../src/renderer/stores/appStore')
  useAppStore.setState({
    profileId: 'prf_test', profileReady: true, workspaceReady: true, loading: false,
    activeThreadId: 'thread-a',
    threads: [{ id: 'thread-a', name: 'A', createdAt: now, updatedAt: now, startedAt: now, order: 0 }] as never,
    messages: [{ id: 'm-1', role: 'user', content: 'Fix the screen', timestamp: now }] as never
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

describe('answering the agent\'s question with a screenshot from the composer', () => {
  it('an attached screenshot answers the shown question and goes with that answer', async () => {
    await mount()
    await ask([screenQuestion])
    await attachScreenshot()
    expect(host.querySelectorAll('.composer-attachments-scroll > *:not(script)')).toHaveLength(1)

    // Attaching does not turn the send into a skip: the button still answers.
    expect(sendButton().getAttribute('aria-label')).toBe('Answer and submit')
    await click(sendButton())

    expect(orchestrator.answerQuestionsDetailed).toHaveBeenCalledTimes(1)
    expect(orchestrator.answerQuestionsDetailed).toHaveBeenCalledWith(
      'ask-1',
      // The answer names the image's file too, for the agent to open once a compaction drops the image.
      { screen: '[Attached files: screen.png (/tmp/mousse-attachments/screen.png)]' },
      'thread-a',
      { screen: [{ name: 'screen.png', mimeType: 'image/png', data: PNG }] }
    )
    expect(orchestrator.sendToThread).not.toHaveBeenCalled()
    // The screenshot left the composer with the answer.
    expect(host.querySelectorAll('.composer-attachments-scroll > *:not(script)')).toHaveLength(0)
  })

  it('with two questions, each answer keeps its own screenshot', async () => {
    await mount()
    await ask([screenQuestion, wrongQuestion])

    await type('This one')
    await attachScreenshot('first.png')
    expect(sendButton().getAttribute('aria-label')).toBe('Answer this question')
    await click(sendButton())
    expect(orchestrator.answerQuestionsDetailed).not.toHaveBeenCalled()

    await type('The header')
    expect(sendButton().getAttribute('aria-label')).toBe('Answer and submit')
    await click(sendButton())

    expect(orchestrator.answerQuestionsDetailed).toHaveBeenCalledWith(
      'ask-1',
      { screen: 'This one\n\n[Attached files: first.png (/tmp/mousse-attachments/first.png)]', wrong: 'The header' },
      'thread-a',
      { screen: [{ name: 'first.png', mimeType: 'image/png', data: PNG }] }
    )
  })

  it('"Skip questions and send" on the card sends the message and its screenshot to the thread instead', async () => {
    await mount()
    await ask([screenQuestion])
    expect(button('Skip questions and send')).toBeUndefined()
    await attachScreenshot()

    await click(button('Skip questions and send')!)

    expect(orchestrator.answerQuestionsDetailed).not.toHaveBeenCalled()
    expect(orchestrator.sendToThread).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(orchestrator.sendToThread.mock.calls[0])).toContain(PNG)
  })
})
