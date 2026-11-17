// @vitest-environment jsdom
/**
 * A finished turn reads as its prompt, one "Worked for" line and its answer: the work that led to the answer
 * (thoughts, calls, narration) folds behind the line, which opens it in place (message-list.tsx).
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { forgetThreadOpenMemory, hasThreadOpenMemory } from '../../src/renderer/chat/components/agent-elements/thread-open-memory'
import { markRecoveredFailures, mousseToUIMessages } from '../../src/renderer/chat/adapters/mousseToUI'
import type { ChatMessage } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const realMatchMedia = window.matchMedia
const realResizeObserver = globalThis.ResizeObserver

beforeEach(() => {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.matchMedia = realMatchMedia
  globalThis.ResizeObserver = realResizeObserver
})

const T0 = Date.parse('2026-11-12T10:00:00Z')
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()
const ask = (id: string, text: string, seconds: number): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text }], createdAt: at(seconds), turnId: `turn-${id}` }) as unknown as UIMessage
const said = (id: string, text: string, seconds: number): UIMessage =>
  ({ id, role: 'assistant', parts: [{ type: 'text', text }], createdAt: at(seconds), metadata: { endedAt: T0 + seconds * 1000 } }) as unknown as UIMessage
const call = (id: string, type: string, input: Record<string, unknown>, seconds: number, state = 'output-available'): UIMessage =>
  ({
    id,
    role: 'assistant',
    createdAt: at(seconds),
    parts: [{ type, toolCallId: id, state, input, ...(state === 'output-available' ? { output: 'ok' } : {}) }]
  }) as unknown as UIMessage
const thought = (id: string, text: string, seconds: number): UIMessage =>
  ({ id, role: 'assistant', createdAt: at(seconds), parts: [{ type: 'tool-Thinking', toolCallId: id, state: 'output-available', input: { thought: text }, output: text }] }) as unknown as UIMessage

const turn = (n: number, start: number): UIMessage[] => [
  ask(`u${n}`, `Fix the cache ${n}`, start),
  thought(`t${n}`, 'Reading the cache code', start + 2),
  said(`n${n}`, `I'll read how the key is built ${n}.`, start + 3),
  call(`r${n}a`, 'tool-Read', { file_path: 'src/cache.ts' }, start + 4),
  call(`r${n}b`, 'tool-Read', { file_path: 'package.json' }, start + 5),
  call(`b${n}`, 'tool-Bash', { command: 'node test.js' }, start + 6),
  call(`e${n}`, 'tool-Edit', { file_path: 'src/cache.ts', old_string: 'a', new_string: 'b' }, start + 8),
  said(`a${n}`, `The key changed every run ${n}.`, start + 12)
]

function render(messages: UIMessage[], status: 'ready' | 'streaming' = 'ready') {
  act(() => root.render(createElement(MessageList, { messages, status })))
}

const toggles = () => [...host.querySelectorAll<HTMLButtonElement>('.turn-work-toggle')]
const answerOf = (index: number) => host.querySelectorAll<HTMLElement>('.turn-answer')[index]!
const visible = (index: number) => answerOf(index).textContent!.replace(/\s+/g, ' ')
/** The name a screen reader gives a control from its content: its text, without what is hidden from it. */
const nameOf = (node: Node): string =>
  node.nodeType === Node.TEXT_NODE
    ? node.textContent!
    : (node as Element).getAttribute?.('aria-hidden') === 'true' ? '' : [...node.childNodes].map(nameOf).join('')

describe('a finished turn', () => {
  it('shows only its answer under one "Worked for" line, folded by default', () => {
    render(turn(1, 0))
    expect(toggles()).toHaveLength(1)
    expect(nameOf(toggles()[0]!)).toBe('Worked for 12s, 1 reply inside')
    expect(toggles()[0]!.getAttribute('aria-expanded')).toBe('false')
    expect(visible(0).trim()).toBe('The key changed every run 1.')
    expect(host.querySelector('.turn-work-chevron')).not.toBeNull()
  })

  it('opens its work in place, in the order it ran: the thought, the narration as prose, the calls grouped by what they did', () => {
    render(turn(1, 0))
    act(() => toggles()[0]!.click())
    expect(toggles()[0]!.getAttribute('aria-expanded')).toBe('true')
    const text = visible(0)
    const order = ['Reading the cache code', "I'll read how the key is built 1.", 'Read 2 files, ran 1 command and edited 1 file', 'The key changed every run 1.']
    for (const piece of order) expect(text).toContain(piece)
    expect(order.map((piece) => text.indexOf(piece))).toEqual(order.map((piece) => text.indexOf(piece)).sort((x, y) => x - y))
    // The narration is prose, like the answer, not a row of the activity.
    const narration = [...answerOf(0).querySelectorAll('[data-find-text]')].map((node) => node.textContent)
    expect(narration).toEqual(["I'll read how the key is built 1.", 'The key changed every run 1.'])
    vi.useFakeTimers()
    try {
      act(() => toggles()[0]!.click())
      // It closes as motion: hidden from screen readers at once, gone when the close ends.
      const closing = [...answerOf(0).querySelectorAll('[aria-hidden="true"]')].find((node) => node.textContent!.includes("I'll read how the key"))
      expect(closing).toBeDefined()
      act(() => vi.advanceTimersByTime(400))
      expect(visible(0).trim()).toBe('The key changed every run 1.')
    } finally {
      vi.useRealTimers()
    }
  })

  it('remembers which turns are open while the thread is open', () => {
    const thread = [...turn(1, 0), ...turn(2, 100)]
    render(thread)
    act(() => toggles()[0]!.click())
    // A new message arrives and the list draws again: the first turn stays open, the second closed.
    render([...thread, ask('u3', 'And now?', 200)], 'streaming')
    expect(toggles()[0]!.getAttribute('aria-expanded')).toBe('true')
    expect(toggles()[1]!.getAttribute('aria-expanded')).toBe('false')
    expect(visible(0)).toContain("I'll read how the key is built 1.")
    expect(visible(1)).not.toContain("I'll read how the key is built 2.")
  })

  it('has no fold control when it did no work', () => {
    render([ask('u1', 'Hi', 0), said('a1', 'Hello.', 2)])
    expect(toggles()).toHaveLength(0)
    expect(host.querySelector('.turn-work-label')!.textContent).toBe('Worked for 2s')
  })

  it('keeps an error in view with its work folded', () => {
    const failed = { id: 'x1', role: 'assistant', createdAt: at(9), parts: [{ type: 'error', title: 'Request failed', message: 'Overloaded' }] } as unknown as UIMessage
    render([...turn(1, 0).slice(0, -1), failed])
    expect(toggles()).toHaveLength(1)
    expect(visible(0)).toContain('Overloaded')
    expect(visible(0)).not.toContain('Read ')
  })
})

describe('the count of replies a finished turn folds', () => {
  // A turn of three runs: each run closed on a reply, and the agent wrote a note beside its last calls.
  const threeRuns = [
    ask('u1', 'How should we test this?', 0),
    call('r1', 'tool-Read', { file_path: 'src/cache.ts' }, 2),
    said('p1', 'Here is the test plan: one table per input.', 10),
    call('r2', 'tool-Read', { file_path: 'tests/cache.test.ts' }, 20),
    said('p2', 'The fix is pushed.', 30),
    {
      id: 'n3',
      role: 'assistant',
      createdAt: at(40),
      parts: [{ type: 'text', text: 'Cleaning up the worktree.' }, { type: 'tool-Bash', toolCallId: 'b3', state: 'output-available', input: { command: 'git worktree prune' }, output: 'ok' }]
    } as unknown as UIMessage,
    said('a1', 'Done.', 50)
  ]

  it('says how many replies the fold hides after the time, with the words in its tooltip and accessible name', () => {
    render(threeRuns)
    const line = toggles()[0]!
    expect(line.textContent!.startsWith('Worked for 50s·3')).toBe(true)
    expect(nameOf(line)).toBe('Worked for 50s, 3 replies inside')
    const count = line.querySelector('[title="3 replies inside"]')!
    expect(count.querySelector('svg')).not.toBeNull()
    expect(visible(0).trim()).toBe('Done.')
    // Opening the work shows the replies it counted.
    act(() => line.click())
    for (const reply of ['Here is the test plan: one table per input.', 'The fix is pushed.', 'Cleaning up the worktree.']) expect(visible(0)).toContain(reply)
  })

  it('shows no count while the turn is still working', () => {
    render(threeRuns.slice(0, -1), 'streaming')
    expect(toggles()).toHaveLength(0)
    expect(host.querySelector('[title$="inside"]')).toBeNull()
    expect(nameOf(host.querySelector('.turn-work')!)).not.toContain('repl')
  })

  it('shows no count when only calls and thoughts fold', () => {
    render([ask('u1', 'Fix it', 0), thought('t1', 'Reading', 1), call('r1', 'tool-Read', { file_path: 'a.ts' }, 2), said('a1', 'Fixed.', 4)])
    expect(toggles()).toHaveLength(1)
    expect(nameOf(toggles()[0]!)).toBe('Worked for 4s')
  })
})

describe('a turn that waited on a secret', () => {
  // The transcript as the service saves it, shown the way the app shows it (`mousseToUIMessages`).
  const prompt: ChatMessage = { id: 'u1', role: 'user', content: 'Deploy it', timestamp: at(0), turnId: 't-u1' } as ChatMessage
  const thinking = { id: 't1', role: 'system', kind: 'thinking', content: '', timestamp: at(2), thinking: { content: 'Need the deploy token', status: 'complete' } } as ChatMessage
  /** The `secret_request` call, from `start`; `end` is when its result arrived (the person answered). */
  const secretCall = (start: number, end?: number) =>
    ({
      id: 's1', role: 'system', kind: 'mcp_tool_call', content: '', timestamp: at(start),
      toolCall: {
        title: 'Called mousse.secret_request', summary: end == null ? 'secret_request' : 'Saved', details: ['Server: mousse', 'Tool: secret_request'],
        status: end == null ? 'processing' : 'complete', toolName: 'secret_request', ...(end == null ? {} : { response: 'saved' })
      },
      activity: { id: 's1', callId: 's1', toolName: 'secret_request', kind: 'generic', server: 'mousse', status: end == null ? 'running' : 'done', startedAt: at(start), ...(end == null ? {} : { endedAt: at(end) }) }
    }) as unknown as ChatMessage
  const bash = (id: string, seconds: number) =>
    ({
      id, role: 'system', kind: 'tool_call', content: '', timestamp: at(seconds),
      toolCall: { title: 'Bash', summary: 'Ran npm run deploy', details: ['Tool: Bash'], status: 'complete', toolName: 'Bash', input: { command: 'npm run deploy' }, response: 'ok' }
    }) as unknown as ChatMessage
  const reply = (seconds: number) => ({ id: 'a1', role: 'assistant', content: 'Deployed.', timestamp: at(seconds), completedAt: at(seconds) }) as ChatMessage
  /** The open request, as the app adds it below the turn until it is answered. */
  const openRequest = (seconds: number) =>
    ({ id: 'secret:1', role: 'assistant', createdAt: at(seconds), parts: [{ type: 'data-secret-request', data: { requestId: '1', label: 'Deploy token', createdAt: T0 + seconds * 1000 } }] }) as unknown as UIMessage
  const label = () => host.querySelector('.turn-work-label')!.textContent

  it('leaves out the whole wait when another call ran in the same step, after the answer and after a reload', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      // Open, with a call the agent started in the same step done long before the answer.
      vi.setSystemTime(T0 + 60_000)
      render([...mousseToUIMessages([prompt, thinking, secretCall(10), bash('d0', 11)]), openRequest(12)], 'streaming')
      // Answered five minutes later: the open request is gone, and the work goes on.
      vi.setSystemTime(T0 + 315_000)
      const answered = [prompt, thinking, secretCall(10, 310), bash('d0', 11), bash('d1', 311)]
      render(mousseToUIMessages(answered), 'streaming')
      // Finished: ten seconds of work before the wait and ten after.
      vi.setSystemTime(T0 + 320_000)
      render(mousseToUIMessages([...answered, reply(320)]), 'ready')
      expect(label()).toBe('Worked for 20s')
      // Reloaded: the saved transcript alone says the same.
      act(() => root.render(createElement(MessageList, { key: 'reloaded', messages: mousseToUIMessages([...answered, reply(320)]), status: 'ready' })))
      expect(label()).toBe('Worked for 20s')
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves out the wait when the answered call is the last thing the turn did', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(T0 + 60_000)
      render([...mousseToUIMessages([prompt, thinking, secretCall(10)]), openRequest(11)], 'streaming')
      // Answered at 5:10; the open request is gone and nothing came after the call yet.
      vi.setSystemTime(T0 + 311_000)
      render(mousseToUIMessages([prompt, thinking, secretCall(10, 310)]), 'streaming')
      // The turn ends there, two seconds after the answer.
      vi.setSystemTime(T0 + 312_000)
      render(mousseToUIMessages([prompt, thinking, secretCall(10, 310)]), 'ready')
      expect(label()).toBe('Worked for 12s')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a turn whose end the window learned late', () => {
  it('shows how long its work really took, not how long until the window heard it ended (#1042)', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(T0 + 1_000)
      const question = ask('u1', 'Fix it', 0)
      render([question, { id: 'a1', role: 'assistant', createdAt: at(1), parts: [{ type: 'text', text: 'Looking' }] } as unknown as UIMessage], 'streaming')
      // The window missed the end; 30 seconds later it caught up with the service, which saved when the reply ended.
      vi.setSystemTime(T0 + 31_000)
      const finished = { id: 'a1', role: 'assistant', createdAt: at(1), completedAt: at(4), parts: [{ type: 'text', text: 'Fixed.' }] } as unknown as UIMessage
      render([question, finished], 'ready')
      expect(host.querySelector('.turn-work-label')!.textContent).toBe('Worked for 4s')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a turn heard ending as it ends still shows its own clock', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(T0 + 1_000)
      const question = ask('u1', 'Fix it', 0)
      render([question, { id: 'a1', role: 'assistant', createdAt: at(1), parts: [{ type: 'text', text: 'Looking' }] } as unknown as UIMessage], 'streaming')
      vi.setSystemTime(T0 + 7_000)
      // The end arrives before the reply's saved end does.
      render([question, { id: 'a1', role: 'assistant', createdAt: at(1), parts: [{ type: 'text', text: 'Fixed.' }] } as unknown as UIMessage], 'ready')
      expect(host.querySelector('.turn-work-label')!.textContent).toBe('Worked for 7s')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a running turn', () => {
  it('shows its current run as one live line, with no group line for it', () => {
    const running = [
      ...turn(1, 0).slice(0, 6),
      call('b2', 'tool-Bash', { command: 'npm test' }, 7, 'input-available')
    ]
    render(running, 'streaming')
    expect(toggles()).toHaveLength(0)
    const text = visible(0)
    expect(text).toContain("I'll read how the key is built 1.")
    // The current run has no group line: the live row is the run, and the line under the work names what runs.
    expect(text).not.toContain('Read 2 files and ran 2 commands')
    expect(answerOf(0).querySelector('.an-tool-group-rows')).toBeNull()
    const live = host.querySelector<HTMLElement>('[data-turn-live]')!
    expect(answerOf(0).lastElementChild!.previousElementSibling).toBe(live)
    expect(live.querySelector('[data-turn-progress]')!.textContent).toBe('Running Bash…npm test')
  })
})

describe('a steered turn', () => {
  const steer = (id: string, text: string, seconds: number): UIMessage =>
    ({ id, role: 'user', parts: [{ type: 'text', text }], createdAt: at(seconds), metadata: { steered: true } }) as unknown as UIMessage
  const steered = [
    ask('u1', 'Fix the cache', 0),
    call('r1', 'tool-Read', { file_path: 'src/cache.ts' }, 2),
    said('n1', 'Reading done, running the tests next.', 10),
    steer('s1', 'use pnpm', 12),
    call('b1', 'tool-Bash', { command: 'pnpm test' }, 14),
    said('a1', 'Tests pass with pnpm.', 20)
  ]

  it('folds each part behind its own line, with its own time, and keeps each part\'s last reply in view', () => {
    render(steered)
    expect(toggles().map(nameOf)).toEqual(['Worked for 12s', 'Continued for 8s'])
    const text = visible(0)
    for (const piece of ['Reading done, running the tests next.', 'use pnpm', 'Tests pass with pnpm.']) expect(text).toContain(piece)
    expect(['Worked for', 'Reading done', 'use pnpm', 'Continued for', 'Tests pass'].map((piece) => text.indexOf(piece))).toEqual(
      ['Worked for', 'Reading done', 'use pnpm', 'Continued for', 'Tests pass'].map((piece) => text.indexOf(piece)).sort((x, y) => x - y)
    )
    expect(text).not.toContain('pnpm test')
    // Each line opens its own part.
    act(() => toggles()[1]!.click())
    expect(toggles().map((line) => line.getAttribute('aria-expanded'))).toEqual(['false', 'true'])
  })
})

describe('a turn stopped before its answer', () => {
  it('keeps what it last said in view and folds only the work', () => {
    render([ask('u1', 'Fix it', 0), said('n1', 'Looking at the cache first.', 2), call('r1', 'tool-Read', { file_path: 'src/cache.ts' }, 3)])
    expect(toggles()).toHaveLength(1)
    expect(visible(0)).toContain('Looking at the cache first.')
    expect(visible(0)).not.toContain('Read ')
  })
})

describe('a message that holds text beside its calls', () => {
  const mixed = (id: string, text: string, part: Record<string, unknown>, seconds: number): UIMessage =>
    ({ id, role: 'assistant', createdAt: at(seconds), parts: [{ type: 'text', text }, part] }) as unknown as UIMessage
  const bash = (id: string, command: string, state: 'output-available' | 'input-available' | 'output-error') =>
    ({ type: 'tool-Bash', toolCallId: id, state, input: { command }, ...(state === 'output-available' ? { output: 'ok' } : {}), ...(state === 'output-error' ? { errorText: 'exit 1' } : {}) })
  const read = (id: string) => ({ type: 'tool-Read', toolCallId: id, state: 'output-available', input: { file_path: 'src/cache.ts' }, output: 'ok' })
  const stopped = { id: 'stop', role: 'assistant', createdAt: at(6), parts: [], metadata: { turnEnd: { cause: 'user' } } } as unknown as UIMessage

  it('keeps that text in view when it is the last thing the turn said', () => {
    render([ask('u1', 'Fix it', 0), call('r1', 'tool-Read', { file_path: 'package.json' }, 2), mixed('m1', 'The key changed every run, so I am rebuilding it.', bash('b1', 'npm run build', 'output-available'), 5)])
    expect(toggles()).toHaveLength(1)
    expect(visible(0)).toContain('The key changed every run, so I am rebuilding it.')
    expect(visible(0)).not.toContain('package.json')
  })

  it('folds it with the work when an answer follows, and counts it among the replies inside', () => {
    render([ask('u1', 'Fix it', 0), mixed('m1', "I'll read how the key is built.", read('r1'), 2), said('a1', 'The key changed every run.', 9)])
    expect(visible(0)).not.toContain("I'll read how the key is built.")
    expect(visible(0)).toContain('The key changed every run.')
    expect(nameOf(toggles()[0]!)).toContain('1 reply inside')
  })

  it('keeps it in view when the turn is stopped during its call', () => {
    render([ask('u1', 'Fix it', 0), call('r1', 'tool-Read', { file_path: 'package.json' }, 2), mixed('m1', 'Running the slow tests now.', bash('b1', 'npm test', 'input-available'), 4), stopped])
    expect(toggles()).toHaveLength(1)
    expect(visible(0)).toContain('Running the slow tests now.')
    expect(visible(0)).not.toContain('package.json')
  })

  // Whether a failure was got past is the transcript's rule (`markRecoveredFailures`), run here as the app runs it.
  const failedRun = { id: 'e1', role: 'assistant', createdAt: at(5), parts: [{ type: 'error', title: 'Run failed', message: 'The agent stopped with an error.' }] } as unknown as UIMessage

  it('keeps a failed call the turn ended on in view, with the text beside it', () => {
    render(markRecoveredFailures([ask('u1', 'Fix it', 0), call('r1', 'tool-Read', { file_path: 'package.json' }, 2), mixed('m1', 'Trying the build.', bash('b1', 'npm run build', 'output-error'), 3), failedRun]))
    const text = visible(0)
    expect(text).toContain('Trying the build.')
    expect(text).toContain('npm run build')
    expect(text).not.toContain('package.json')
  })

  it('folds a failed call with its text when a later reply got past it', () => {
    render(markRecoveredFailures([ask('u1', 'Fix it', 0), call('r1', 'tool-Read', { file_path: 'package.json' }, 2), mixed('m1', 'Trying the build.', bash('b1', 'npm run build', 'output-error'), 3), said('a1', 'The build passes with the key set.', 9)]))
    const text = visible(0)
    expect(text).not.toContain('Trying the build.')
    expect(text).not.toContain('npm run build')
    expect(text).toContain('The build passes with the key set.')
    expect(nameOf(toggles()[0]!)).toContain('1 reply inside')
  })
})

describe('what you opened in a thread', () => {
  const show = (threadId: string, messages: UIMessage[]) =>
    act(() => root.render(createElement(MessageList, { key: threadId, threadId, messages, status: 'ready' })))
  const groupLine = () => answerOf(0).querySelector<HTMLElement>('[aria-expanded]:not(.turn-work-toggle)')!

  it('stays open after switching to another thread and back', () => {
    show('thread-a', turn(1, 0))
    act(() => toggles()[0]!.click())
    act(() => groupLine().click())
    expect(groupLine().getAttribute('aria-expanded')).toBe('true')
    show('thread-b', turn(2, 0))
    expect(toggles()[0]!.getAttribute('aria-expanded')).toBe('false')
    show('thread-a', turn(1, 0))
    expect(toggles()[0]!.getAttribute('aria-expanded')).toBe('true')
    expect(groupLine().getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps a live run opened while the turn ran: the group line it becomes at the end is open, after a switch too', () => {
    const live = (threadId: string, messages: UIMessage[], status: 'ready' | 'streaming') =>
      act(() => root.render(createElement(MessageList, { key: threadId, threadId, messages, status })))
    const running = [...turn(3, 0).slice(0, 5), call('b3', 'tool-Bash', { command: 'node test.js' }, 6, 'input-available')]
    live('thread-c', running, 'streaming')
    const liveToggle = host.querySelector<HTMLButtonElement>('[data-turn-live] button.turn-live-toggle')!
    act(() => liveToggle.click())
    expect(liveToggle.getAttribute('aria-expanded')).toBe('true')
    // The turn ends on that run: it takes its group line, inside the work that folds. The narration before the run
    // moves below the work, so the run joins the thought before it in one line.
    const ended = [...turn(3, 0).slice(0, 5), call('b3', 'tool-Bash', { command: 'node test.js' }, 6)]
    live('thread-c', ended, 'ready')
    act(() => toggles()[0]!.click())
    expect(groupLine().textContent).toContain('3 actions')
    expect(groupLine().getAttribute('aria-expanded')).toBe('true')
    show('thread-b', turn(2, 0))
    show('thread-c', ended)
    expect(toggles()[0]!.getAttribute('aria-expanded')).toBe('true')
    expect(groupLine().getAttribute('aria-expanded')).toBe('true')
  })

  it('gives the focus on a live run to "Worked for" when the run joins the thought before it as the turn ends', () => {
    const live = (messages: UIMessage[], status: 'ready' | 'streaming') =>
      act(() => root.render(createElement(MessageList, { key: 'thread-d', threadId: 'thread-d', messages, status })))
    live([...turn(4, 0).slice(0, 5), call('b4', 'tool-Bash', { command: 'node test.js' }, 6, 'input-available')], 'streaming')
    act(() => host.querySelector<HTMLButtonElement>('[data-turn-live] button.turn-live-toggle')!.focus())
    // The run's line is keyed by the thought it joins, not by the run's first call, which keyed the live row.
    live([...turn(4, 0).slice(0, 5), call('b4', 'tool-Bash', { command: 'node test.js' }, 6)], 'ready')
    expect(host.querySelector('[data-turn-live]')).toBeNull()
    expect(document.activeElement).toBe(toggles()[0])
    expect(toggles()[0]!.getAttribute('aria-expanded')).toBe('false')
  })

  it('is forgotten when the thread is deleted', () => {
    expect(hasThreadOpenMemory('thread-a')).toBe(true)
    forgetThreadOpenMemory(['thread-a'])
    expect(hasThreadOpenMemory('thread-a')).toBe(false)
    show('thread-a', turn(1, 0))
    expect(toggles()[0]!.getAttribute('aria-expanded')).toBe('false')
  })
})
