// @vitest-environment jsdom
import type { UIMessage } from 'ai'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageList } from '../src/renderer/chat/components/agent-elements/message-list'
import {
  PermissionRequestContext,
  permissionRequestOptions,
  permissionSummary,
  withPermissionRequests
} from '../src/renderer/chat/components/agent-elements/tools/permission-request'
import { usePermissionRequests } from '../src/renderer/hooks/usePermissionRequests'
import { threadsAwaitingApproval } from '../src/renderer/hooks/useThreadsAwaitingApproval'
import { describeAnswerOutcome } from '../src/renderer/components/ComposerQuestionModal'
import type { PendingUserQuestions, QuestionAnswerOutcome, ThreadApprovalRequest } from '../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const T0 = Date.parse('2026-10-29T10:00:00.000Z')
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()
const PROMPT = 'Allow Claude Code to run a command (Bash)?\n{"command":"npm test","description":"Run the tests"}'

const user = (id: string, seconds: number, text: string): UIMessage =>
  ({ id, role: 'user', createdAt: at(seconds), parts: [{ type: 'text', text }] }) as unknown as UIMessage
const command = (id: string, seconds: number): UIMessage =>
  ({ id, role: 'assistant', createdAt: at(seconds), parts: [{ type: 'tool-Bash', toolCallId: id, state: 'input-available', input: { command: 'npm test' } }] }) as unknown as UIMessage
const reply = (id: string, seconds: number, text: string): UIMessage =>
  ({ id, role: 'assistant', createdAt: at(seconds), parts: [{ type: 'text', text }] }) as unknown as UIMessage

const pending = (requestId: string, options: PendingUserQuestions['questions'][number]['options'] = [
  { id: 'allow', label: 'Allow once', decision: 'allow', scope: 'once' },
  { id: 'allow_always', label: 'Always for this thread', decision: 'allow', scope: 'always' },
  { id: 'reject', label: 'Reject', decision: 'reject' }
]): PendingUserQuestions => ({
  requestId,
  threadId: 't1',
  questions: [{ id: 'permission', prompt: PROMPT, options }],
  approval: { answerPath: 'live' }
})
const saved = (requestId: string, seconds: number, extra: Partial<ThreadApprovalRequest> = {}): ThreadApprovalRequest => ({
  requestId,
  action: 'command',
  prompt: PROMPT,
  status: 'pending',
  createdAt: at(seconds),
  ...extra
})

describe('which requests are answered inline', () => {
  it('a permission request gives its allow, always and deny options', () => {
    expect(permissionRequestOptions(pending('r1'))).toEqual({ allow: 'allow', always: 'allow_always', deny: 'reject' })
  })

  it('an agent question and a quick action keep their dialog and card', () => {
    const question: PendingUserQuestions = { requestId: 'q1', questions: [{ id: 'q', prompt: 'Which database?', options: [{ id: 'pg', label: 'Postgres' }, { id: 'sqlite', label: 'SQLite' }] }] }
    expect(permissionRequestOptions(question)).toBeNull()
    const quickAction: PendingUserQuestions = { requestId: 'q2', questions: [{ id: 'approval', prompt: 'Create quick action "Deploy" (bash)?', options: [{ id: 'approve', label: 'Approve', decision: 'allow' }, { id: 'reject', label: 'Reject', decision: 'reject' }] }] }
    expect(permissionRequestOptions(quickAction)).toBeNull()
  })

  it('the sidebar learns which waiting threads wait for an approval', () => {
    const question: PendingUserQuestions = { requestId: 'q1', threadId: 't2', questions: [{ id: 'q', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] }] }
    expect([...threadsAwaitingApproval([pending('r1'), question])]).toEqual(['t1'])
  })
})

describe('the one-line summary', () => {
  it('reads the command of a Claude Code request', () => {
    expect(permissionSummary(PROMPT, 'command')).toEqual({ verb: 'Run', target: 'npm test' })
  })

  it('reads a cut-off tool input', () => {
    expect(permissionSummary('Allow Claude Code to edit files (Edit)?\n{"file_path":"src/app.ts","old_string":"a very long', 'edit')).toEqual({ verb: 'Edit', target: 'src/app.ts' })
  })

  it('reads Codex and Pi requests', () => {
    expect(permissionSummary('Allow Codex to run this command?\npnpm build\nin /work/app', 'command')).toEqual({ verb: 'Run', target: 'pnpm build' })
    expect(permissionSummary('Allow Codex to edit src/a.ts, src/b.ts?', 'edit')).toEqual({ verb: 'Edit', target: 'src/a.ts, src/b.ts' })
    expect(permissionSummary('Allow Pi to edit this file?\nnotes.md', 'tool')).toEqual({ verb: 'Edit', target: 'notes.md' })
  })
})

describe('placing requests in the transcript', () => {
  const messages = [user('u1', 0, 'Test it'), command('c1', 1), reply('a1', 9, 'Done.'), user('u2', 20, 'Again'), reply('a2', 21, 'Ok.')]

  it('puts a saved request after the call that asked, inside its turn', () => {
    const placed = withPermissionRequests(messages, [saved('r1', 2, { status: 'answered', decision: 'allow' })])
    expect(placed.map((message) => message.id)).toEqual(['u1', 'c1', 'permission:r1', 'a1', 'u2', 'a2'])
  })

  it('puts a waiting request the saved list does not have yet at the end, and shows an answer given here', () => {
    const placed = withPermissionRequests(messages, [], [pending('r2')], { r2: { decision: 'reject' } })
    expect(placed.at(-1)!.id).toBe('permission:r2')
    expect((placed.at(-1)!.parts[0] as unknown as { data: { status: string; decision: string } }).data).toMatchObject({ status: 'answered', decision: 'reject' })
  })

  it('leaves out a request asked before the first message shown', () => {
    expect(withPermissionRequests(messages.slice(3), [saved('r1', 2)]).map((message) => message.id)).toEqual(['u2', 'a2'])
  })
})

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete (window as { mousse?: unknown }).mousse
})

const indicator = () => host.querySelector('.turn-work-label')?.textContent
const request = () => host.querySelector('[data-permission-request]')
const buttons = () => [...(request()?.querySelectorAll('.permission-request-actions button') ?? [])].map((button) => button.textContent)
const click = async (label: string) => {
  const button = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent === label)!
  await act(async () => button.click())
}

describe('a waiting permission request in the turn', () => {
  it('shows one line with Approve, Always for this thread and Deny, and the turn says it needs approval', async () => {
    const onAnswer = vi.fn()
    const messages = withPermissionRequests([user('u1', 0, 'Test it'), command('c1', 1)], [saved('r1', 2)])
    await act(async () => {
      root.render(createElement(PermissionRequestContext.Provider, { value: { r1: { options: { allow: 'allow', always: 'allow_always', deny: 'reject' }, onAnswer } } },
        createElement(MessageList, { messages, status: 'streaming' })))
    })
    expect(host.querySelectorAll('[data-turn-key]')).toHaveLength(1)
    expect(request()!.querySelector('.permission-request-target')!.textContent).toBe('npm test')
    // The full request is on hover.
    expect(request()!.querySelector('.permission-request-summary')!.getAttribute('title')).toBe(PROMPT)
    expect(buttons()).toEqual(['Deny', 'Always for this thread', 'Approve'])
    expect(indicator()).toBe('Waiting for approval')
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    await click('Approve')
    expect(onAnswer).toHaveBeenCalledWith('allow')
  })

  it('shows the answer it got from the saved data, and the turn is working again', async () => {
    const messages = withPermissionRequests([user('u1', 0, 'Test it'), command('c1', 1)], [saved('r1', 2, { status: 'answered', decision: 'allow', scope: 'always' })])
    await act(async () => {
      root.render(createElement(MessageList, { messages, status: 'streaming' }))
    })
    expect(buttons()).toEqual([])
    expect(request()!.querySelector('.permission-request-answer')!.textContent).toBe('Always allowed')
    expect(indicator()).toMatch(/^Working for/)
  })
})

describe('answering through the daemon', () => {
  type Listener<T> = (payload: T) => void
  function mockDaemon() {
    const listeners = { pending: [] as Listener<PendingUserQuestions>[], cleared: [] as Listener<{ requestId: string; threadId?: string }>[] }
    let history: ThreadApprovalRequest[] = []
    const answered: Array<[string, unknown, unknown]> = []
    const orchestrator = {
      onQuestionsPending: (cb: Listener<PendingUserQuestions>) => {
        listeners.pending.push(cb)
        return () => undefined
      },
      onQuestionsCleared: (cb: Listener<{ requestId: string; threadId?: string }>) => {
        listeners.cleared.push(cb)
        return () => undefined
      },
      approvalRequests: vi.fn(async () => history),
      answerQuestionsDetailed: vi.fn(async (requestId: string, answers: unknown, threadId: unknown): Promise<QuestionAnswerOutcome> => {
        answered.push([requestId, answers, threadId])
        return { ok: true }
      })
    }
    ;(window as { mousse?: unknown }).mousse = { orchestrator }
    return {
      orchestrator,
      answered,
      setHistory: (next: ThreadApprovalRequest[]) => {
        history = next
      },
      ask: (payload: PendingUserQuestions) => act(async () => listeners.pending.forEach((cb) => cb(payload))),
      clear: (requestId: string) => act(async () => listeners.cleared.forEach((cb) => cb({ requestId, threadId: 't1' })))
    }
  }

  function Chat({ messages, onRefused }: { messages: UIMessage[]; onRefused: (text: string) => void }) {
    const requests = usePermissionRequests('t1', onRefused, describeAnswerOutcome)
    return createElement(PermissionRequestContext.Provider, { value: requests.controls },
      createElement(MessageList, { messages: requests.place(messages), status: 'streaming' }))
  }
  const base = [user('u1', 0, 'Test it'), command('c1', 1)]

  it('records the answer: Approve answers the request and the row shows it', async () => {
    const daemon = mockDaemon()
    await act(async () => root.render(createElement(Chat, { messages: base, onRefused: () => undefined })))
    daemon.setHistory([saved('r1', 2)])
    await daemon.ask(pending('r1'))
    expect(buttons()).toEqual(['Deny', 'Always for this thread', 'Approve'])
    await click('Approve')
    expect(daemon.answered).toEqual([['r1', { permission: 'allow' }, 't1']])
    expect(buttons()).toEqual([])
    expect(request()!.querySelector('.permission-request-answer')!.textContent).toBe('Approved')
    // The daemon's saved answer replaces the one given here.
    daemon.setHistory([saved('r1', 2, { status: 'answered', decision: 'allow', scope: 'once', answeredBy: { kind: 'user', via: 'gui' } })])
    await daemon.clear('r1')
    expect(request()!.querySelector('.permission-request-answer')!.textContent).toBe('Approved')
    expect(indicator()).toMatch(/^Working for/)
  })

  it('a message sent while the request waits denies it: the row shows Denied and is no longer answerable', async () => {
    const daemon = mockDaemon()
    await act(async () => root.render(createElement(Chat, { messages: base, onRefused: () => undefined })))
    daemon.setHistory([saved('r1', 2)])
    await daemon.ask(pending('r1'))
    expect(indicator()).toBe('Waiting for approval')
    // The send is the daemon's to settle: it denies the request with the message as the reason and clears it.
    daemon.setHistory([saved('r1', 2, { status: 'answered', decision: 'reject', answeredBy: { kind: 'user', via: 'gui' } })])
    await daemon.clear('r1')
    expect(buttons()).toEqual([])
    expect(request()!.querySelector('.permission-request-answer')!.textContent).toBe('Denied')
    expect(daemon.answered).toEqual([])
  })

  it('an agent question is left to the dialog', async () => {
    const daemon = mockDaemon()
    await act(async () => root.render(createElement(Chat, { messages: base, onRefused: () => undefined })))
    await daemon.ask({ requestId: 'q1', threadId: 't1', questions: [{ id: 'q', prompt: 'Which database?', options: [{ id: 'pg', label: 'Postgres' }] }] })
    expect(request()).toBeNull()
  })

  it('says so when someone else answered first', async () => {
    const daemon = mockDaemon()
    daemon.orchestrator.answerQuestionsDetailed.mockResolvedValueOnce({ ok: false, reason: 'already_answered', decision: 'reject', answeredBy: { kind: 'user', via: 'cli' } })
    const refused: string[] = []
    await act(async () => root.render(createElement(Chat, { messages: base, onRefused: (text: string) => refused.push(text) })))
    await daemon.ask(pending('r1'))
    await click('Approve')
    expect(refused).toEqual(['Already answered: denied from the CLI.'])
    expect(buttons()).toEqual([])
  })
})
