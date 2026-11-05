// @vitest-environment jsdom
import type { UIMessage } from 'ai'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { LOCATED_CLASS, revealMessage } from '../../src/renderer/chat/components/agent-elements/reveal-message'
import { PermissionRequestContext } from '../../src/renderer/chat/components/agent-elements/tools/permission-request'
import { isCommandRegistered, runCommand } from '../../src/renderer/commands/commandRegistry'
import { APPROVAL_OFFLINE_REASON, ApprovalNotice } from '../../src/renderer/components/ApprovalNotice'
import { ComposerNoticeProvider, ComposerNoticeSlot, ComposerNoticeSource } from '../../src/renderer/components/ComposerNotice'
import { SERVICE_LOST_TITLE, ServiceLostNotice } from '../../src/renderer/components/ServiceLostNotice'
import { describeAnswerOutcome } from '../../src/renderer/components/ComposerQuestionModal'
import { usePermissionRequests } from '../../src/renderer/hooks/usePermissionRequests'
import { useAppStore } from '../../src/renderer/stores/appStore'
import {
  CHAT_NAVIGATION_TIMEOUT_MS,
  focusPendingRequest,
  scrollToMessage,
  useChatNavigationStore,
  usePendingRequestFocus
} from '../../src/renderer/stores/chatNavigationStore'
import type { PendingUserQuestions, QuestionAnswerOutcome, ThreadApprovalRequest } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const T0 = Date.parse('2026-11-05T10:00:00.000Z')
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()
const PROMPT = 'Allow Claude Code to run a command (Bash)?\n{"command":"npm test","description":"Run the tests"}'

const user = (id: string, seconds: number, text: string): UIMessage =>
  ({ id, role: 'user', createdAt: at(seconds), parts: [{ type: 'text', text }] }) as unknown as UIMessage
const command = (id: string, seconds: number): UIMessage =>
  ({ id, role: 'assistant', createdAt: at(seconds), parts: [{ type: 'tool-Bash', toolCallId: id, state: 'input-available', input: { command: 'npm test' } }] }) as unknown as UIMessage
const base = [user('u1', 0, 'Test it'), command('c1', 1)]

const pending = (requestId: string): PendingUserQuestions => ({
  requestId,
  threadId: 't1',
  questions: [{
    id: 'permission',
    prompt: PROMPT,
    options: [
      { id: 'allow', label: 'Allow once', decision: 'allow', scope: 'once' },
      { id: 'reject', label: 'Reject', decision: 'reject' }
    ]
  }],
  approval: { answerPath: 'live' }
})
const saved = (requestId: string, seconds: number): ThreadApprovalRequest => ({
  requestId,
  action: 'command',
  prompt: PROMPT,
  status: 'pending',
  createdAt: at(seconds)
})

type Listener<T> = (payload: T) => void
function mockDaemon() {
  const listeners = { pending: [] as Listener<PendingUserQuestions>[] }
  const answered: Array<[string, unknown]> = []
  let settle: ((outcome: QuestionAnswerOutcome) => void) | null = null
  const orchestrator = {
    onQuestionsPending: (cb: Listener<PendingUserQuestions>) => {
      listeners.pending.push(cb)
      return () => undefined
    },
    onQuestionsCleared: () => () => undefined,
    approvalRequests: vi.fn(async () => [saved('r1', 2)]),
    answerQuestionsDetailed: vi.fn((requestId: string, answers: unknown) => {
      answered.push([requestId, answers])
      return new Promise<QuestionAnswerOutcome>((resolve) => { settle = resolve })
    })
  }
  ;(window as { mousse?: unknown }).mousse = { orchestrator }
  return {
    answered,
    ask: (payload: PendingUserQuestions) => act(async () => listeners.pending.forEach((cb) => cb(payload))),
    settle: (outcome: QuestionAnswerOutcome = { ok: true }) => act(async () => settle?.(outcome))
  }
}

/** Stands in for the browser's observer: the test says when the row is on screen. */
const observers: Array<{ callback: (entries: unknown[]) => void; target: Element | null }> = []
class FakeIntersectionObserver {
  entry: { callback: (entries: unknown[]) => void; target: Element | null }
  constructor(callback: (entries: unknown[]) => void) {
    this.entry = { callback, target: null }
    observers.push(this.entry)
  }
  observe(target: Element) { this.entry.target = target }
  disconnect() { this.entry.target = null }
}
const setRowInView = (visible: boolean) => act(async () => {
  for (const observer of observers) {
    if (observer.target) observer.callback([{ isIntersecting: visible, intersectionRatio: visible ? 1 : 0 }])
  }
})

function Chat({ hasText = false, error = false, serviceLost = false, onReconnect = () => undefined }: {
  hasText?: boolean
  error?: boolean
  serviceLost?: boolean
  onReconnect?: () => void
}) {
  const requests = usePermissionRequests('t1', () => undefined, describeAnswerOutcome)
  const shown = requests.place(base)
  const current = requests.current
  return createElement(ComposerNoticeProvider, null,
    createElement(PermissionRequestContext.Provider, { value: requests.controls },
      createElement(MessageList, { messages: shown, status: 'streaming' })),
    createElement('div', { className: 'chat-input-area' },
      createElement(ComposerNoticeSlot),
      createElement('textarea', { className: 'composer-input', defaultValue: hasText ? 'Use pnpm' : '' })),
    createElement(ComposerNoticeSource, { notice: error ? { tone: 'error', title: 'Could not send' } : null }),
    createElement(ServiceLostNotice, { lost: serviceLost, onReconnect, onDismiss: () => undefined }),
    createElement(ApprovalNotice, {
      request: current,
      composerHasText: hasText,
      placed: Boolean(current && shown.some((message) => message.id === `permission:${current.requestId}`)),
      isShown: () => true,
      serviceLost
    }))
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersectionObserver
  observers.length = 0
  useAppStore.setState({ activeThreadId: 't1', shortcuts: {}, appInfo: { platform: 'win32', repoRoot: '', llmProvider: '' } })
  useChatNavigationStore.setState({ message: null, pendingRequest: null })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete (window as { mousse?: unknown }).mousse
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
})

const notice = () => host.querySelector('.composer-notice')
const lines = () => [...host.querySelectorAll<HTMLElement>('.composer-notice')]
const approvalLine = () => host.querySelector('.composer-notice[aria-label="Waiting approval"]')
const noticeButton = (name: string) => [...(approvalLine()?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
  .find((button) => (button.getAttribute('aria-label') ?? button.textContent) === name)
const rowButtons = () => [...host.querySelectorAll<HTMLButtonElement>('.permission-request-actions button')]
const rowAnswer = () => host.querySelector('.permission-request-answer')?.textContent

async function waiting(hasText = false, error = false) {
  const daemon = mockDaemon()
  await act(async () => root.render(createElement(Chat, { hasText, error })))
  await daemon.ask(pending('r1'))
  return daemon
}

describe('a waiting approval above the composer', () => {
  it('names the request while its row is out of view, and goes once the row shows', async () => {
    await waiting()
    await setRowInView(false)
    expect(notice()!.querySelector('.composer-notice-title')!.textContent).toBe('Approval')
    expect(notice()!.querySelector('.composer-notice-detail')!.textContent).toBe('Run npm test')
    expect(notice()!.getAttribute('data-tone')).toBe('warning')
    expect(noticeButton('Deny')!.title).toBe('Deny')
    expect(noticeButton('Approve')!.title).toBe('Approve (Ctrl+Enter)')
    expect(noticeButton('Show request')).toBeDefined()
    await setRowInView(true)
    expect(notice()).toBeNull()
    await setRowInView(false)
    expect(notice()).not.toBeNull()
  })

  it('is not hidden by an error notice, and the error shows again once it is answered or in view', async () => {
    await waiting(false, true)
    await setRowInView(false)
    expect(lines()).toHaveLength(1)
    expect(notice()!.querySelector('.composer-notice-title')!.textContent).toBe('Approval')
    await setRowInView(true)
    expect(notice()!.querySelector('.composer-notice-title')!.textContent).toBe('Could not send')
  })

  it('with the background service lost: its own line on top, the approval below with Deny and Approve waiting', async () => {
    const daemon = await waiting()
    await setRowInView(false)
    const onReconnect = vi.fn()
    await act(async () => root.render(createElement(Chat, { error: true, serviceLost: true, onReconnect })))
    const [top, below] = lines()
    expect(lines()).toHaveLength(2)
    expect(top.getAttribute('aria-label')).toBe(SERVICE_LOST_TITLE)
    expect(top.getAttribute('data-tone')).toBe('error')
    expect(below).toBe(approvalLine())
    expect(below.querySelector('.composer-notice-title')!.textContent).toBe('Approval')
    // The approval line itself says nothing about the service.
    expect(below.textContent).not.toMatch(/service|connection/i)
    expect(noticeButton('Deny')!.getAttribute('aria-disabled')).toBe('true')
    expect(noticeButton('Approve')!.getAttribute('aria-disabled')).toBe('true')
    expect(noticeButton('Approve')!.title).toBe(APPROVAL_OFFLINE_REASON)
    expect(noticeButton('Deny')!.title).toBe(APPROVAL_OFFLINE_REASON)
    expect(APPROVAL_OFFLINE_REASON).toBe("Can't answer until Mousse's background service reconnects")
    await act(async () => noticeButton('Approve')!.click())
    expect(runCommand('approval.allow', 'key')).toBe(false)
    expect(daemon.answered).toEqual([])
    await act(async () => top.querySelector<HTMLButtonElement>('button[aria-label="Reconnect"]')!.click())
    expect(onReconnect).toHaveBeenCalledTimes(1)

    // Reconnected: the top line goes and the approval answers again.
    await act(async () => root.render(createElement(Chat)))
    expect(lines()).toEqual([approvalLine()])
    expect(noticeButton('Approve')!.getAttribute('aria-disabled')).toBeNull()
    expect(noticeButton('Approve')!.title).toBe('Approve (Ctrl+Enter)')
    await act(async () => noticeButton('Approve')!.click())
    expect(daemon.answered).toEqual([['r1', { permission: 'allow' }]])
  })

  it('with the background service lost and the request in view, only the service line shows', async () => {
    await waiting()
    await setRowInView(true)
    await act(async () => root.render(createElement(Chat, { serviceLost: true })))
    expect(lines()).toHaveLength(1)
    expect(notice()!.getAttribute('aria-label')).toBe(SERVICE_LOST_TITLE)
  })

  it('says that sending denies it while the box has text, even with the row in view', async () => {
    await waiting(true)
    await setRowInView(true)
    expect(notice()!.querySelector('.composer-notice-title')!.textContent).toBe('Sending denies this')
  })

  it('answers once, whichever of the row and the notice is pressed', async () => {
    const daemon = await waiting()
    await act(async () => noticeButton('Approve')!.click())
    expect(daemon.answered).toEqual([['r1', { permission: 'allow' }]])
    // While the answer settles, the row waits and the notice ignores presses.
    expect(rowButtons().every((button) => button.disabled)).toBe(true)
    expect(noticeButton('Deny')!.getAttribute('aria-disabled')).toBe('true')
    expect(noticeButton('Approve')!.getAttribute('aria-busy')).toBe('true')
    await act(async () => noticeButton('Deny')!.click())
    await act(async () => rowButtons()[0]!.click())
    expect(isCommandRegistered('approval.deny')).toBe(false)
    expect(daemon.answered).toHaveLength(1)
    await daemon.settle()
    expect(rowAnswer()).toBe('Approved')
    expect(notice()).toBeNull()
  })

  it('approves with Ctrl+Enter while the composer is empty, and leaves the key to a composer with text', async () => {
    const daemon = await waiting()
    expect(runCommand('approval.allow', 'key')).toBe(true)
    expect(daemon.answered).toEqual([['r1', { permission: 'allow' }]])
    await daemon.settle()
    expect(rowAnswer()).toBe('Approved')

    act(() => root.unmount())
    root = createRoot(host)
    const next = await waiting(true)
    const composer = host.querySelector<HTMLTextAreaElement>('.composer-input')!
    composer.focus()
    expect(runCommand('approval.allow', 'key', composer)).toBe(false)
    expect(next.answered).toEqual([])
    // The palette still denies or approves it.
    expect(runCommand('approval.deny', 'palette')).toBe(true)
    expect(next.answered).toEqual([['r1', { permission: 'reject' }]])
  })

  it('jumps to the row and highlights it', async () => {
    await waiting()
    await act(async () => noticeButton('Show request')!.click())
    const row = host.querySelector('[data-permission-request="r1"]')!
    await vi.waitFor(() => expect(row.classList.contains(LOCATED_CLASS)).toBe(true))
    expect(useChatNavigationStore.getState().message).toBeNull()
  })
})

describe('chat navigation requests', () => {
  it('scrollToMessage waits for the transcript that has the message, and a stale one is dropped', async () => {
    await act(async () => root.render(createElement(MessageList, { messages: base, status: 'ready' })))
    act(() => scrollToMessage('elsewhere'))
    expect(useChatNavigationStore.getState().message?.messageId).toBe('elsewhere')
    act(() => scrollToMessage('u1'))
    await vi.waitFor(() => expect(host.querySelector('[data-message-id="u1"]')!.classList.contains(LOCATED_CLASS)).toBe(true))
    expect(useChatNavigationStore.getState().message).toBeNull()

    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    act(() => scrollToMessage('c1'))
    clock.mockReturnValue(now + CHAT_NAVIGATION_TIMEOUT_MS + 1)
    await act(async () => root.render(createElement(MessageList, { messages: [...base], status: 'ready' })))
    expect(useChatNavigationStore.getState().message).toBeNull()
    clock.mockRestore()
  })

  it('focusPendingRequest waits for its thread and a row, then scrolls to the row', () => {
    function Probe({ threadId, rowId }: { threadId: string; rowId: string | null }) {
      usePendingRequestFocus(threadId, rowId)
      return null
    }
    act(() => root.render(createElement(Probe, { threadId: 't2', rowId: 'permission:r1' })))
    act(() => focusPendingRequest('t1'))
    expect(useChatNavigationStore.getState().pendingRequest?.threadId).toBe('t1')
    act(() => root.render(createElement(Probe, { threadId: 't1', rowId: null })))
    expect(useChatNavigationStore.getState().pendingRequest).not.toBeNull()
    act(() => root.render(createElement(Probe, { threadId: 't1', rowId: 'permission:r1' })))
    expect(useChatNavigationStore.getState().pendingRequest).toBeNull()
    expect(useChatNavigationStore.getState().message?.messageId).toBe('permission:r1')
  })
})

describe('revealMessage', () => {
  const box = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) }) as DOMRect

  it('lands a turn that is not mounted, then centres the message', async () => {
    const container = document.createElement('div')
    const rows = document.createElement('div')
    container.append(rows)
    container.getBoundingClientRect = () => box(0, 400)
    let scrollTop = 0
    Object.defineProperty(container, 'scrollTop', { get: () => scrollTop, set: (value: number) => { scrollTop = value } })
    const scrollToKey = vi.fn(async () => {
      const row = document.createElement('div')
      row.dataset.turnKey = 'turn-9'
      const text = document.createElement('div')
      text.dataset.messageId = 'm9'
      text.getBoundingClientRect = () => box(900 - scrollTop, 40)
      row.append(text)
      rows.append(row)
      return true
    })
    const end = vi.fn()
    const element = await revealMessage(
      { turnKey: 'turn-9', messageId: 'm9' },
      { isCurrent: () => true, end },
      { container, rows, scrollToKey, onProgrammaticScroll: () => undefined, nextFrame: async () => undefined }
    )
    expect(scrollToKey).toHaveBeenCalledWith('turn-9', { align: 'start' })
    expect(element?.dataset.messageId).toBe('m9')
    // Its middle (920) sits at the middle of the 400px viewport.
    expect(scrollTop).toBe(720)
    expect(end).toHaveBeenCalled()
  })
})
