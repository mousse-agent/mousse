// @vitest-environment jsdom
/**
 * The mark on a cut-off turn ("Stopped", "Interrupted"), through the whole pipeline: saved messages →
 * `mousseToUIMessages` → `reuseUIMessages` → `MessageList` (its grouping, `reuseTurns` and the turn's header).
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { groupMessagesIntoTurns, MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { TurnProgressContext, type TurnProgressState } from '../../src/renderer/chat/components/agent-elements/turn-progress'
import { startRenderCounts, stopRenderCounts } from '../../src/renderer/chat/components/agent-elements/render-counts'
import { chatStatusFromPhase, mousseToUIMessages, reuseUIMessages } from '../../src/renderer/chat/adapters/mousseToUI'
import { RESTART_INTERRUPTED_TEXT, TURN_STOPPED_TEXT, type ChatMessage, type TurnEnd } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let shown: UIMessage[] = []
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  shown = []
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  stopRenderCounts()
  vi.unstubAllGlobals()
})

const start = Date.parse('2026-11-11T10:00:00.000Z')
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString()
/** A finished turn of run `runId`: its prompt, and a reply `seconds` later. */
const turn = (runId: string, offset: number, seconds = 7): ChatMessage[] => [
  { id: `u-${runId}`, role: 'user', content: `Prompt ${runId}`, timestamp: at(offset), turnId: runId },
  { id: `a-${runId}`, role: 'assistant', content: `Reply ${runId}`, timestamp: at(offset + seconds) }
]
const stopLine = (runId: string | undefined, turnEnd: TurnEnd | undefined, offset: number, content = TURN_STOPPED_TEXT): ChatMessage => ({
  id: `s-${runId ?? offset}`, role: 'system', content, timestamp: at(offset), ...(runId ? { turnId: runId } : {}), ...(turnEnd ? { turnEnd } : {})
})

/** Renders the thread as the chat does: each snapshot reuses the unchanged messages of the one before. */
function show(messages: ChatMessage[], progress: TurnProgressState | null = null) {
  shown = reuseUIMessages(shown, mousseToUIMessages(messages))
  const list = createElement(MessageList, { messages: shown, status: chatStatusFromPhase('idle') })
  act(() => root.render(createElement(TurnProgressContext.Provider, { value: progress }, list)))
}
/** The text a sighted reader sees: without the screen-reader-only reason. */
const visibleText = (element: Element) => {
  const copy = element.cloneNode(true) as Element
  for (const hidden of copy.querySelectorAll('.sr-only')) hidden.remove()
  return copy.textContent
}
const marks = () => [...host.querySelectorAll<HTMLElement>('[data-turn-end]')].map((mark) => ({ word: visibleText(mark), title: mark.getAttribute('title') }))
const headers = () => [...host.querySelectorAll('.turn-work-label')].map(visibleText)

describe('the mark on a cut-off turn', () => {
  it.each([
    ['user', 'Stopped', 'You stopped this turn before it finished.'],
    ['agent', 'Stopped', 'An agent in another thread stopped this turn.'],
    ['daemon_restart', 'Interrupted', 'Mousse restarted during this turn.'],
    ['crash', 'Interrupted', 'Mousse quit during this turn.']
  ] as const)('cause %s reads "%s" after the time, with why in its tooltip', (cause, word, title) => {
    show([...turn('r1', 0), stopLine('r1', { cause }, 7, cause === 'user' || cause === 'agent' ? TURN_STOPPED_TEXT : RESTART_INTERRUPTED_TEXT)])
    expect(headers()).toEqual([`Worked for 7s · ${word}`])
    expect(marks()).toEqual([{ word, title }])
    // The line itself shows nothing of its own.
    expect(host.textContent).not.toContain(TURN_STOPPED_TEXT)
    expect(host.textContent).not.toContain(RESTART_INTERRUPTED_TEXT)
  })

  it('a crash that may have run tools names them in the tooltip', () => {
    show([...turn('r1', 0), stopLine('r1', { cause: 'crash', tools: ['bash'] }, 8, RESTART_INTERRUPTED_TEXT)])
    expect(marks()).toEqual([{ word: 'Interrupted', title: 'Mousse quit during this turn. May have run: bash' }])
  })

  it('screen readers get the reason as text inside the mark, which find in thread skips with the header', () => {
    show([...turn('r1', 0), stopLine('r1', { cause: 'crash', tools: ['bash'] }, 8, RESTART_INTERRUPTED_TEXT)])
    const mark = host.querySelector<HTMLElement>('[data-turn-end]')!
    const reason = mark.querySelector('.sr-only')
    expect(reason?.textContent).toBe(': Mousse quit during this turn. May have run: bash')
    expect(mark.textContent).toBe('Interrupted: Mousse quit during this turn. May have run: bash')
    expect(reason?.closest('[data-find-ignore]')).not.toBeNull()
  })

  it('no mark on a finished turn, a steered turn, a paused turn, a failed turn or a bot\'s wall', () => {
    show([
      ...turn('done', 0),
      { id: 'u-steer', role: 'user', content: 'Steer prompt', timestamp: at(20), turnId: 'steer' },
      { id: 'a-steer-1', role: 'assistant', content: 'Before the steer', timestamp: at(21) },
      { id: 'steer-1', role: 'user', content: 'use pnpm', timestamp: at(22), steered: true },
      { id: 'a-steer-2', role: 'assistant', content: 'After the steer', timestamp: at(24) },
      ...turn('paused', 40),
      { id: 's-paused', role: 'system', content: 'Paused until 3:00 PM: The usage limit was reached (estimated). Continue when it resets.', timestamp: at(48), turnId: 'paused' },
      ...turn('failed', 60),
      { id: 's-failed', role: 'system', content: '[provider_error] boom', timestamp: at(68), error: { code: 'provider_error', message: 'boom' } as ChatMessage['error'] },
      ...turn('wall', 80),
      { id: 's-wall', role: 'system', content: 'Paused: waiting for the owner.', timestamp: at(88) }
    ])
    expect(headers().length).toBe(5)
    expect(marks()).toEqual([])
  })

  it('the latest turn\'s mark gives way while its "Run interrupted" notice shows, and comes back after', () => {
    const thread = [...turn('r1', 0), stopLine('r1', { cause: 'user' }, 7), ...turn('r2', 20, 3), stopLine('r2', { cause: 'daemon_restart' }, 24, RESTART_INTERRUPTED_TEXT)]
    show(thread, { phase: 'stopped' })
    expect(headers()).toEqual(['Worked for 7s · Stopped', 'Worked for 3s'])
    show(thread, { phase: 'idle' })
    expect(headers()).toEqual(['Worked for 7s · Stopped', 'Worked for 3s · Interrupted'])
  })

  it('reads lines written before the field by their text', () => {
    show([...turn('r1', 0), stopLine(undefined, undefined, 8), ...turn('r2', 20, 3), stopLine(undefined, undefined, 24, RESTART_INTERRUPTED_TEXT)])
    expect(marks()).toEqual([
      { word: 'Stopped', title: 'You stopped this turn before it finished.' },
      { word: 'Interrupted', title: 'Mousse restarted during this turn.' }
    ])
  })

  it('a marker that arrives after a snapshot renders its turn again', () => {
    show(turn('r1', 0))
    expect(headers()).toEqual(['Worked for 7s'])
    show([...turn('r1', 0), stopLine('r1', { cause: 'user' }, 7)])
    expect(headers()).toEqual(['Worked for 7s · Stopped'])
  })

  it('a marker written after newer turns lands on its own turn, by its run id', () => {
    show([...turn('r1', 0), ...turn('r2', 20, 3), stopLine('r1', { cause: 'crash' }, 30, RESTART_INTERRUPTED_TEXT)])
    expect(headers()).toEqual(['Worked for 7s · Interrupted', 'Worked for 3s'])
  })

  it('an unchanged marker keeps its turn and the memoised row', () => {
    const thread = [...turn('r1', 0), stopLine('r1', { cause: 'user' }, 7), ...turn('r2', 20, 3)]
    const messages = mousseToUIMessages(thread)
    const [first] = groupMessagesIntoTurns(messages)
    expect(groupMessagesIntoTurns(messages)[0]!.end).toBe(first!.end)
    show(thread)
    const counts = startRenderCounts()
    // Only the last turn changes: its reply grows.
    show([...thread.slice(0, -1), { ...thread.at(-1)!, content: 'Reply r2, longer' }])
    expect(counts.TurnRow).toBe(1)
    expect(headers()).toEqual(['Worked for 7s · Stopped', 'Worked for 3s'])
  })
})

describe('the time of a stopped turn', () => {
  /** A turn stopped 15 s in: its prompt, a thought at 1 s, and a reply that started streaming at 3 s. Saved as a restart reads them. */
  const stoppedTurn = (cause: TurnEnd['cause'] = 'user'): ChatMessage[] => [
    { id: 'u-r1', role: 'user', content: 'Prompt r1', timestamp: at(0), turnId: 'r1' },
    { id: 't-r1', role: 'system', kind: 'thinking', content: '', timestamp: at(1), thinking: { content: 'Planning', status: 'complete' } } as ChatMessage,
    { id: 'a-r1', role: 'assistant', content: 'Partial reply', timestamp: at(3), incomplete: true },
    stopLine('r1', { cause }, 15)
  ]

  it.each(['user', 'agent'] as const)('a turn stopped by cause %s runs to its Stop line, not to where its last message started', (cause) => {
    show(stoppedTurn(cause))
    expect(headers()).toEqual(['Worked for 15s · Stopped'])
  })

  it('shows the same time after a restart as when it was stopped', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(start)
      const live = stoppedTurn().slice(0, -1).map((message) => message.id === 'a-r1' ? { ...message, incomplete: undefined, streaming: true } : message)
      shown = reuseUIMessages(shown, mousseToUIMessages(live))
      act(() => root.render(createElement(MessageList, { messages: shown, status: 'streaming' })))
      // Stop at 15 s: the reply ends and Mousse writes its Stop line.
      vi.setSystemTime(start + 15_000)
      show(stoppedTurn())
      expect(headers()).toEqual(['Worked for 15s · Stopped'])
      // A restart: the window opens the thread again from what was saved.
      act(() => root.unmount())
      root = createRoot(host)
      shown = []
      vi.setSystemTime(start + 3_600_000)
      show(stoppedTurn())
      expect(headers()).toEqual(['Worked for 15s · Stopped'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a line a boot wrote after a crash, long after the turn, does not stretch its time', () => {
    show([...stoppedTurn().slice(0, -1), stopLine('r1', { cause: 'crash' }, 3_600, RESTART_INTERRUPTED_TEXT)])
    expect(headers()).toEqual(['Worked for 3s · Interrupted'])
  })

  it('a finished turn keeps the time its saved messages give', () => {
    show(turn('r1', 0, 12))
    expect(headers()).toEqual(['Worked for 12s'])
  })
})

describe('the time of a finished turn', () => {
  /** A turn whose final reply started streaming at 3 s and finished at 20 s, as it is saved. */
  const longReply = (completedAt: number | null = 20): ChatMessage[] => [
    { id: 'u-r1', role: 'user', content: 'Prompt r1', timestamp: at(0), turnId: 'r1' },
    { id: 't-r1', role: 'system', kind: 'thinking', content: '', timestamp: at(1), thinking: { content: 'Planning', status: 'complete' } } as ChatMessage,
    { id: 'a-r1', role: 'assistant', content: 'A long reply', timestamp: at(3), ...(completedAt != null ? { completedAt: at(completedAt) } : {}) }
  ]

  it('a long final reply shows its full time while open and after a restart', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(start)
      const live = longReply(null).map((message) => message.id === 'a-r1' ? { ...message, streaming: true } : message)
      shown = reuseUIMessages(shown, mousseToUIMessages(live))
      act(() => root.render(createElement(MessageList, { messages: shown, status: 'streaming' })))
      // The reply finishes at 20 s.
      vi.setSystemTime(start + 20_000)
      show(longReply())
      expect(headers()).toEqual(['Worked for 20s'])
      // A restart: the window opens the thread again from what was saved.
      act(() => root.unmount())
      root = createRoot(host)
      shown = []
      vi.setSystemTime(start + 3_600_000)
      show(longReply())
      expect(headers()).toEqual(['Worked for 20s'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('an earlier turn runs to where its last reply ended, not to where it started', () => {
    show([...longReply(), ...turn('r2', 60, 4)])
    expect(headers()).toEqual(['Worked for 20s', 'Worked for 4s'])
  })

  it('a reply saved before replies recorded their end keeps today\'s time', () => {
    show(longReply(null))
    expect(headers()).toEqual(['Worked for 3s'])
  })
})
