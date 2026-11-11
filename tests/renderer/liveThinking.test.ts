// @vitest-environment jsdom
/**
 * A thought's streamed text lives in its own slice (liveTextStore), as a reply's does: a delta that only adds text
 * to the thought being written renders its row (or the header of the group it ends), never the transcript, the
 * message list or the store. Its start, its end and any other change go to the store, and its final text takes
 * over once.
 */
import { act, createElement, useMemo, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { TurnProgressContext, type TurnProgressState } from '../../src/renderer/chat/components/agent-elements/turn-progress'
import { countRender, startRenderCounts, stopRenderCounts } from '../../src/renderer/chat/components/agent-elements/render-counts'
import { mousseToUIMessages, reuseUIMessages } from '../../src/renderer/chat/adapters/mousseToUI'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { applyStreamedUpdates, clearAllLiveText, hasLiveText, isLiveThoughtUpdate, landMessage } from '../../src/renderer/stores/liveTextStore'
import { setReplyPacing } from '../../src/renderer/lib/replyPacingSetting'
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
  setReplyPacing(false)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.matchMedia = realMatchMedia
  globalThis.ResizeObserver = realResizeObserver
  stopRenderCounts()
  clearAllLiveText()
  useAppStore.setState({ messages: [], activeThreadId: null, profileId: 'default' })
  setReplyPacing(true)
})

const at = (n: number) => new Date(Date.UTC(2026, 10, 12, 10, 0, 0) + n * 1000).toISOString()
const user = (id: string, n: number, content: string): ChatMessage => ({ id, role: 'user', content, timestamp: at(n), turnId: `t-${id}` })
const assistant = (id: string, n: number, content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: 'assistant', content, timestamp: at(n), ...extra })
/** A thought as the service writes it: a system row, processing while it is written. */
const thinking = (id: string, n: number, content: string, status: 'processing' | 'complete' = 'processing'): ChatMessage =>
  ({ id, role: 'system', kind: 'thinking', content: '', timestamp: at(n), thinking: { content, status } })
const tool = (id: string, n: number): ChatMessage => ({
  id, role: 'system', kind: 'tool_call', content: '', timestamp: at(n),
  toolCall: { title: 'Read', summary: 'Read a.ts', details: ['Tool: Read'], status: 'complete', toolName: 'Read', input: { file_path: 'a.ts' } }
})

/** `turns` finished turns, then a prompt, `before` (anything the turn did first) and a thought being written. */
function thread(turns: number, live: string, before: ChatMessage[] = []): ChatMessage[] {
  const out: ChatMessage[] = []
  for (let i = 0; i < turns; i += 1) {
    out.push(user(`u${i}`, i * 2, `Question ${i}`))
    out.push(assistant(`a${i}`, i * 2 + 1, `Answer ${i}\n\n\`\`\`ts\nconst x${i} = ${i}\n\`\`\``))
  }
  out.push(user('live', turns * 2, 'And now?'))
  out.push(...before)
  out.push(thinking('th', turns * 2 + 5, live))
  return out
}

/** What the chat view does with the store's messages, counted. */
function Transcript({ progress, status = 'streaming' }: { progress: TurnProgressState; status?: 'streaming' | 'ready' }) {
  countRender('Transcript')
  const messages = useAppStore((s) => s.messages)
  const shown = useRef<UIMessage[]>([])
  const ui = useMemo(() => {
    const next = reuseUIMessages(shown.current, mousseToUIMessages(messages))
    shown.current = next
    return next
  }, [messages])
  return createElement(TurnProgressContext.Provider, { value: progress }, createElement(MessageList, { messages: ui, status }))
}

let writes = 0
function write(messages: ChatMessage[]) {
  writes += 1
  useAppStore.getState().updateMessages(messages)
}

const THINKING: TurnProgressState = { phase: 'thinking', step: { kind: 'reasoning' } }

function mount(messages: ChatMessage[], status: 'streaming' | 'ready' = 'streaming') {
  useAppStore.setState({ messages, activeThreadId: 'thread-1' })
  act(() => root.render(createElement(Transcript, { progress: THINKING, status })))
}

/** Applies one frame's updates as App's batcher does. */
function stream(...updates: ChatMessage[]) {
  act(() => applyStreamedUpdates(updates, useAppStore.getState().messages, write))
}

/** A new message lands through App's message handler, after `pending` (the frame's held updates) are flushed. */
function land(message: ChatMessage, ...pending: ChatMessage[]) {
  act(() => landMessage(message, () => {
    if (pending.length > 0) applyStreamedUpdates(pending, useAppStore.getState().messages, write)
  }))
}

/** How many times the store's messages change while `run` runs. */
function messageWrites(run: () => void): number {
  let count = 0
  const stop = useAppStore.subscribe((state, previous) => {
    if (state.messages !== previous.messages) count += 1
  })
  try {
    run()
  } finally {
    stop()
  }
  return count
}

/** The turn's thought rows (outside any group), by their header button, and the live ones' line. */
const thoughtRows = () => [...host.querySelectorAll<HTMLButtonElement>('.turn-answer button[aria-expanded]')]
  .filter((button) => button.querySelector('svg.thinking-icon') && !button.closest('.an-tool-group-rows'))
const liveRows = () => [...host.querySelectorAll<HTMLElement>('.turn-answer svg.thinking-icon.is-thinking')]
  .filter((icon) => !icon.closest('[data-turn-progress]'))
const answerText = () => [...host.querySelectorAll('.turn-answer')].at(-1)?.textContent ?? ''
const progressLine = () => host.querySelector<HTMLElement>('[data-turn-progress]')

describe('a streamed thought renders only its row', () => {
  it('renders the thought row alone in a 40-turn thread, and leaves the store, the transcript and the list as they were', () => {
    mount(thread(40, '**Reading the tests**\n\nThe output says'))
    const before = useAppStore.getState().messages
    const counts = startRenderCounts()
    writes = 0
    stream(thinking('th', 85, '**Reading the tests**\n\nThe output says the reminder starts twice'))
    expect(counts.ThinkingTool).toBe(1)
    expect(counts.Transcript ?? 0).toBe(0)
    expect(counts.MessageList ?? 0).toBe(0)
    expect(counts.TurnRow ?? 0).toBe(0)
    expect(counts.AssistantParts ?? 0).toBe(0)
    expect(counts.TurnProgressRow ?? 0).toBe(0)
    expect(writes).toBe(0)
    expect(useAppStore.getState().messages).toBe(before)
    // The row is the turn's live line: it follows the thought as it is written.
    expect(liveRows()).toHaveLength(1)
    expect(answerText()).toContain('the reminder starts twice')
    expect(progressLine()).toBeNull()
  })

  it('renders the row once per delta over 30 deltas, and nothing else', () => {
    mount(thread(10, 'Start'))
    const counts = startRenderCounts()
    let text = 'Start'
    for (let i = 0; i < 30; i += 1) {
      text += ` word${i}`
      stream(thinking('th', 25, text))
    }
    expect(counts.ThinkingTool).toBe(30)
    expect(counts.MessageList ?? 0).toBe(0)
    expect(counts.TurnRow ?? 0).toBe(0)
    expect(counts.Transcript ?? 0).toBe(0)
    expect(answerText()).toContain('word29')
  })

  it('in a group, renders the group header alone and its line follows the thought', () => {
    // A tool call, then the thought: they share one group, whose header is the live line.
    const mounted = startRenderCounts()
    mount(thread(5, 'Checking the build', [tool('tool-1', 12)]))
    expect(mounted.ToolCallsGroup).toBeGreaterThan(0)
    const counts = startRenderCounts()
    stream(thinking('th', 15, 'Checking the build output for the failing step'))
    expect(hasLiveText('th')).toBe(true)
    expect(counts.ToolCallsGroup).toBe(1)
    expect(counts.MessageList ?? 0).toBe(0)
    expect(counts.TurnRow ?? 0).toBe(0)
    expect(counts.Transcript ?? 0).toBe(0)
    expect(answerText()).toContain('for the failing step')
  })

  it('a row that joins back-to-back thoughts shows the earlier ones, then the newest as it is written', () => {
    mount(thread(3, 'Second thought', [thinking('th0', 7, 'First thought, done.', 'complete')]))
    expect(thoughtRows()).toHaveLength(1)
    const counts = startRenderCounts()
    stream(thinking('th', 11, 'Second thought, still going'))
    expect(hasLiveText('th')).toBe(true)
    expect(counts.MessageList ?? 0).toBe(0)
    expect(answerText()).toContain('still going')
    // Opened, the row shows both thoughts, each once, in order.
    act(() => thoughtRows()[0]!.click())
    const body = answerText()
    expect(body.split('First thought, done.').length - 1).toBe(1)
    expect(body.indexOf('First thought, done.')).toBeLessThan(body.lastIndexOf('Second thought, still going'))
    expect(thoughtRows()).toHaveLength(1)
  })

  it('keeps an opened row open while its thought streams', () => {
    mount(thread(3, 'One'))
    const row = thoughtRows()[0]!
    act(() => row.click())
    expect(thoughtRows()[0]!.getAttribute('aria-expanded')).toBe('true')
    stream(thinking('th', 11, 'One two three'))
    expect(hasLiveText('th')).toBe(true)
    expect(thoughtRows()[0]!.getAttribute('aria-expanded')).toBe('true')
    expect(answerText()).toContain('One two three')
  })

  it('sends a thought\'s start, its end and any other change to the store', () => {
    const empty = thinking('th', 1, '')
    const started = thinking('th', 1, 'Let me')
    expect(isLiveThoughtUpdate(empty, started)).toBe(false)
    expect(isLiveThoughtUpdate(started, thinking('th', 1, 'Let me see'))).toBe(true)
    expect(isLiveThoughtUpdate(started, thinking('th', 1, 'Let me see', 'complete'))).toBe(false)
    expect(isLiveThoughtUpdate(started, { ...thinking('th', 1, 'Let me see'), turnId: 'other' })).toBe(false)
    expect(isLiveThoughtUpdate(started, assistant('th', 1, 'Let me see', { streaming: true }))).toBe(false)
  })

  it('a thought with something after it in the transcript goes to the store', () => {
    mount([...thread(2, 'Thinking about it'), assistant('reply', 9, 'Hi', { streaming: true })])
    writes = 0
    stream(thinking('th', 9, 'Thinking about it more'))
    expect(writes).toBe(1)
    expect(hasLiveText('th')).toBe(false)
  })
})

describe('the end of a thought', () => {
  it('its final text reaches the store once, with nothing left live and nothing shown twice or shorter', () => {
    mount(thread(5, '**Plan**\n\nPart one'))
    stream(thinking('th', 15, '**Plan**\n\nPart one. Part two'))
    stream(thinking('th', 15, '**Plan**\n\nPart one. Part two. Part three'))
    expect(hasLiveText('th')).toBe(true)
    writes = 0
    const counts = startRenderCounts()
    stream(thinking('th', 15, '**Plan**\n\nPart one. Part two. Part three. The end.', 'complete'))
    expect(writes).toBe(1)
    expect(hasLiveText('th')).toBe(false)
    const stored = useAppStore.getState().messages.filter((m) => m.id === 'th')
    expect(stored).toHaveLength(1)
    expect(stored[0]!.thinking).toEqual({ content: '**Plan**\n\nPart one. Part two. Part three. The end.', status: 'complete' })
    // The row renders once, in the same pass as the transcript, and is no longer live.
    expect(counts.ThinkingTool).toBe(1)
    expect(liveRows()).toHaveLength(0)
    // The turn ends: one row, its text once.
    act(() => root.render(createElement(Transcript, { progress: { phase: 'completed' } as TurnProgressState, status: 'ready' })))
    expect(thoughtRows()).toHaveLength(1)
    act(() => thoughtRows()[0]!.click())
    expect(answerText().split('The end.').length - 1).toBe(1)
    expect(answerText().split('Part two.').length - 1).toBe(1)
  })

  it('a message that lands after the thought takes its live text into the store first', () => {
    mount(thread(3, 'Weighing'))
    stream(thinking('th', 11, 'Weighing the two options'))
    expect(useAppStore.getState().messages.find((m) => m.id === 'th')!.thinking!.content).toBe('Weighing')
    const changes = messageWrites(() => land(assistant('reply', 12, 'Option two.', { streaming: true })))
    // The thought's text, then the reply.
    expect(changes).toBe(2)
    expect(hasLiveText('th')).toBe(false)
    expect(useAppStore.getState().messages.find((m) => m.id === 'th')!.thinking!.content).toBe('Weighing the two options')
    expect(answerText()).toContain('Option two.')
  })

  it('a message that lands takes the thought\'s held deltas first, then its live text, then itself', () => {
    mount(thread(3, 'Weighing'))
    stream(thinking('th', 11, 'Weighing the two'))
    // The frame still holds a delta when the message lands: App flushes it, then hands the thought over.
    land(assistant('reply', 12, 'Option two.', { streaming: true }), thinking('th', 11, 'Weighing the two options, carefully'))
    expect(hasLiveText('th')).toBe(false)
    const messages = useAppStore.getState().messages
    expect(messages.find((m) => m.id === 'th')!.thinking!.content).toBe('Weighing the two options, carefully')
    expect(messages.at(-1)!.id).toBe('reply')
  })

  it('a user message replaces its optimistic copy', () => {
    mount([...thread(1, 'Done', []), user('optimistic:1', 10, 'Next')])
    land(user('u-real', 10, 'Next'))
    const ids = useAppStore.getState().messages.map((m) => m.id)
    expect(ids).not.toContain('optimistic:1')
    expect(ids.at(-1)).toBe('u-real')
  })

  it('a row that lands through the update channel gives the group title the thought\'s full text, in one write', () => {
    mount(thread(5, '**Checking the build**\n\nIt fails', [tool('tool-1', 12)]))
    stream(thinking('th', 15, '**Checking the build**\n\nIt fails.\n\n**Running the tests**\n\nNow'))
    expect(hasLiveText('th')).toBe(true)
    writes = 0
    stream(tool('tool-2', 16))
    expect(writes).toBe(1)
    expect(hasLiveText('th')).toBe(false)
    expect(useAppStore.getState().messages.find((m) => m.id === 'th')!.thinking!.content).toContain('Running the tests')
    expect(useAppStore.getState().messages.at(-1)!.id).toBe('tool-2')
    // The group, now titled from the stored thought, shows its newest heading.
    expect(answerText()).toContain('Running the tests')
  })

  it('a thought delta after a row landed in the same frame goes to the store', () => {
    mount(thread(2, 'Alpha'))
    stream(thinking('th', 9, 'Alpha beta'))
    writes = 0
    stream(tool('tool-2', 10), thinking('th', 9, 'Alpha beta gamma'))
    expect(writes).toBe(1)
    expect(hasLiveText('th')).toBe(false)
    expect(useAppStore.getState().messages.find((m) => m.id === 'th')!.thinking!.content).toBe('Alpha beta gamma')
  })

  it('a thread switch while the thought streams clears its live text, and the view brings the full text', () => {
    mount(thread(3, 'Weighing'))
    stream(thinking('th', 11, 'Weighing the two options'))
    expect(hasLiveText('th')).toBe(true)
    act(() => useAppStore.getState().switchToThread('thread-2'))
    expect(hasLiveText('th')).toBe(false)
    act(() => useAppStore.getState().switchToThread('thread-1'))
    expect(hasLiveText('th')).toBe(false)
    const view = { threadId: 'thread-1', messages: thread(3, 'Weighing the two options, and a third') }
    act(() => useAppStore.getState().applyThreadView(view as unknown as Parameters<ReturnType<typeof useAppStore.getState>['applyThreadView']>[0]))
    expect(useAppStore.getState().messages.find((m) => m.id === 'th')!.thinking!.content).toBe('Weighing the two options, and a third')
    expect(answerText()).toContain('and a third')
  })

  it('a lagging snapshot of the thought does not shorten what streamed', () => {
    mount(thread(2, 'Alpha'))
    stream(thinking('th', 9, 'Alpha beta gamma'))
    expect(hasLiveText('th')).toBe(true)
    act(() => useAppStore.getState().updateMessages([thinking('th', 9, 'Alpha beta')]))
    expect(answerText()).toContain('Alpha beta gamma')
  })

  it('a turn that ends before the thought\'s end arrives keeps showing its text', () => {
    mount(thread(2, 'Alpha'))
    stream(thinking('th', 9, 'Alpha beta gamma'))
    expect(hasLiveText('th')).toBe(true)
    act(() => root.render(createElement(Transcript, { progress: { phase: 'completed' } as TurnProgressState, status: 'ready' })))
    act(() => thoughtRows()[0]!.click())
    expect(answerText()).toContain('Alpha beta gamma')
  })
})
