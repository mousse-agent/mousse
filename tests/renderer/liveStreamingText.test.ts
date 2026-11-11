// @vitest-environment jsdom
/**
 * Streamed text of a reply lives in its own slice (liveTextStore): an update renders only that reply's
 * text, the transcript and the store stay as they are, and the reply's final text takes over once.
 * Reply pacing is off unless a test turns it on, so the live text shows word by word.
 */
import { act, createElement, useMemo, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { TurnProgressContext, type TurnProgressState } from '../../src/renderer/chat/components/agent-elements/turn-progress'
import { countRender, startRenderCounts, stopRenderCounts } from '../../src/renderer/chat/components/agent-elements/render-counts'
import { mousseToUIMessages, reuseUIMessages } from '../../src/renderer/chat/adapters/mousseToUI'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { applyStreamedUpdates, clearAllLiveText, isLiveTextUpdate, liveTextOver } from '../../src/renderer/stores/liveTextStore'
import { searchableParts, type FindTurn } from '../../src/renderer/chat/components/agent-elements/find/find-index'
import { STREAMING_REINDEX_MS, useThreadFind, type ThreadFind } from '../../src/renderer/chat/components/agent-elements/find/use-thread-find'
import { PACE_MS } from '../../src/renderer/chat/components/agent-elements/reply-pacing'
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
  vi.useRealTimers()
})

const at = (n: number) => new Date(Date.UTC(2026, 10, 11, 10, 0, 0) + n * 1000).toISOString()
const user = (id: string, n: number, content: string): ChatMessage => ({ id, role: 'user', content, timestamp: at(n), turnId: `t-${id}` })
const assistant = (id: string, n: number, content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: 'assistant', content, timestamp: at(n), ...extra })
const thinking = (id: string, n: number, content: string, status: 'processing' | 'complete'): ChatMessage =>
  ({ id, role: 'assistant', content: '', timestamp: at(n), kind: 'thinking', thinking: { content, status }, streaming: status === 'processing' })

/** `turns` finished turns with code, then a prompt and a reply streaming in. */
function thread(turns: number, live: string): ChatMessage[] {
  const out: ChatMessage[] = []
  for (let i = 0; i < turns; i += 1) {
    out.push(user(`u${i}`, i * 2, `Question ${i}`))
    out.push(assistant(`a${i}`, i * 2 + 1, `Answer ${i}\n\n\`\`\`ts\nconst x${i} = ${i}\n\`\`\``))
  }
  out.push(user('live', turns * 2, 'And now?'))
  out.push(assistant('reply', turns * 2 + 1, live, { streaming: true }))
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

function mount(messages: ChatMessage[], progress: TurnProgressState = { phase: 'streaming' }) {
  useAppStore.setState({ messages, activeThreadId: 'thread-1' })
  act(() => root.render(createElement(Transcript, { progress })))
}

/** Applies one frame's updates as App's batcher does. */
function stream(...updates: ChatMessage[]) {
  act(() => applyStreamedUpdates(updates, useAppStore.getState().messages, write))
}

const replyText = () => host.querySelector('[data-message-id="reply"]')?.textContent ?? ''
const progressLine = () => host.querySelector<HTMLElement>('[data-turn-progress]')

describe('a streamed update renders only the live reply', () => {
  it('renders the reply text alone in a 40-turn thread, and leaves the store and the transcript as they were', () => {
    mount(thread(40, 'The reply so far'))
    const before = useAppStore.getState().messages
    const counts = startRenderCounts()
    writes = 0
    stream(assistant('reply', 81, 'The reply so far, and more words', { streaming: true }))
    expect(counts.LiveMarkdown).toBe(1)
    expect(counts.Markdown).toBe(1)
    expect(counts.Transcript ?? 0).toBe(0)
    expect(counts.TurnRow ?? 0).toBe(0)
    expect(counts.AssistantParts ?? 0).toBe(0)
    expect(writes).toBe(0)
    expect(useAppStore.getState().messages).toBe(before)
    expect(replyText()).toContain('The reply so far, and more words')
  })

  it('renders the reply once per update over 30 updates, and nothing else', () => {
    mount(thread(10, 'Start'))
    const counts = startRenderCounts()
    let text = 'Start'
    for (let i = 0; i < 30; i += 1) {
      text += ` word${i}`
      stream(assistant('reply', 21, text, { streaming: true }))
    }
    expect(counts.LiveMarkdown).toBe(30)
    expect(counts.Transcript ?? 0).toBe(0)
    expect(counts.TurnRow ?? 0).toBe(0)
    expect(replyText()).toContain('word29')
  })

  it('sends the first text of a reply, a new message, and any other change to the store', () => {
    const empty = assistant('reply', 1, '', { streaming: true })
    const started = assistant('reply', 1, 'Hi', { streaming: true })
    expect(isLiveTextUpdate(empty, started)).toBe(false)
    expect(isLiveTextUpdate(started, assistant('reply', 1, 'Hi there', { streaming: true }))).toBe(true)
    // Its metadata changed, it ended, it starts an applet, it is not a plain reply.
    expect(isLiveTextUpdate(started, assistant('reply', 1, 'Hi there', { streaming: true, responseMetadata: { tokensUsed: 3 } }))).toBe(false)
    expect(isLiveTextUpdate(started, assistant('reply', 1, 'Hi there', { streaming: false }))).toBe(false)
    expect(isLiveTextUpdate(started, assistant('reply', 1, 'Hi\n```mousse-applet\n', { streaming: true }))).toBe(false)
    const thought = thinking('th', 1, 'Let me', 'processing')
    expect(isLiveTextUpdate(thought, { ...thought, thinking: { content: 'Let me see', status: 'processing' } })).toBe(false)
  })
})

describe('the end of a reply', () => {
  it('hands the final text to the store once, with no duplicate and nothing left live', () => {
    mount(thread(5, 'Part one'))
    stream(assistant('reply', 11, 'Part one. Part two', { streaming: true }))
    stream(assistant('reply', 11, 'Part one. Part two. Part three', { streaming: true }))
    writes = 0
    const counts = startRenderCounts()
    stream(assistant('reply', 11, 'Part one. Part two. Part three. The end.', { streaming: false }))
    expect(writes).toBe(1)
    const stored = useAppStore.getState().messages.filter((m) => m.id === 'reply')
    expect(stored).toHaveLength(1)
    expect(stored[0]!.content).toBe('Part one. Part two. Part three. The end.')
    expect(stored[0]!.streaming).toBe(false)
    // One reply on screen, its text once, from the store: no live text is left over it.
    expect(host.querySelectorAll('[data-message-id="reply"]')).toHaveLength(1)
    expect(replyText().split('The end.').length - 1).toBe(1)
    expect(liveTextOver('reply', 'Part one. Part two. Part three. The end.')).toBe('Part one. Part two. Part three. The end.')
    // The reply renders in one pass with its final text.
    expect(counts.LiveMarkdown).toBe(1)
  })

  it('never shows text shorter than what streamed, while the store catches up', () => {
    mount(thread(2, 'Alpha'))
    stream(assistant('reply', 5, 'Alpha beta gamma', { streaming: true }))
    // A snapshot that lags behind the live text reaches the store: the live text stays.
    act(() => useAppStore.getState().updateMessages([assistant('reply', 5, 'Alpha beta', { streaming: true })]))
    expect(replyText()).toContain('Alpha beta gamma')
  })

  it('a stopped reply ends on its stored text', () => {
    mount(thread(2, 'Writing'))
    stream(assistant('reply', 5, 'Writing a long', { streaming: true }))
    stream(assistant('reply', 5, 'Writing a long\n\n(Stopped)', { streaming: false, incomplete: true }))
    expect(replyText()).toContain('Writing a long')
    expect(replyText()).not.toContain('(Stopped)')
  })
})

describe('a streamed reply with reply pacing on', () => {
  it('shows finished blocks of the live text only, rendering the reply alone, then the whole text once when the turn ends', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'] })
    setReplyPacing(true)
    mount(thread(5, 'First paragraph.\n\nSec'))
    expect(replyText()).toContain('First paragraph.')
    expect(replyText()).not.toContain('Sec')
    const counts = startRenderCounts()

    // A delta that finishes no block renders the reply, and neither its Markdown nor the transcript.
    stream(assistant('reply', 11, 'First paragraph.\n\nSecond para', { streaming: true }))
    expect(counts.LiveMarkdown).toBe(1)
    expect(counts.Markdown ?? 0).toBe(0)
    expect(replyText()).not.toContain('Second para')

    // A delta that finishes a block shows it whole, never the word being written after it.
    stream(assistant('reply', 11, 'First paragraph.\n\nSecond paragraph done.\n\nThi', { streaming: true }))
    expect(replyText()).toContain('Second paragraph done.')
    expect(replyText()).not.toContain('Thi')

    // The next block finishes within PACE_MS: it waits for the pacing timer, which renders the reply alone.
    stream(assistant('reply', 11, 'First paragraph.\n\nSecond paragraph done.\n\nThird paragraph done.\n\nThe end, still', { streaming: true }))
    expect(replyText()).not.toContain('Third paragraph done.')
    act(() => { vi.advanceTimersByTime(PACE_MS) })
    expect(replyText()).toContain('Third paragraph done.')
    expect(replyText()).not.toContain('The end')
    expect(counts.Transcript ?? 0).toBe(0)
    expect(counts.TurnRow ?? 0).toBe(0)
    expect(counts.AssistantParts ?? 0).toBe(0)

    // The final text reaches the store: nothing shown goes away while the turn is still marked streaming.
    const final = 'First paragraph.\n\nSecond paragraph done.\n\nThird paragraph done.\n\nThe end, still going and done.'
    stream(assistant('reply', 11, final, { streaming: false }))
    expect(replyText()).toContain('Third paragraph done.')
    // The turn ends: the whole text shows at once, each part of it once.
    act(() => root.render(createElement(Transcript, { progress: { phase: 'streaming' }, status: 'ready' })))
    expect(host.querySelectorAll('[data-message-id="reply"]')).toHaveLength(1)
    expect(replyText().split('The end, still going and done.').length - 1).toBe(1)
    expect(replyText().split('Second paragraph done.').length - 1).toBe(1)
    expect(liveTextOver('reply', final)).toBe(final)
  })
})

describe('the progress and thought lines while text streams', () => {
  it('the line under Working still reads Writing… as live text streams, and follows a thought that starts', () => {
    mount(thread(3, 'Some text'))
    expect(progressLine()?.dataset.turnProgress).toBe('writing')
    for (let i = 0; i < 5; i += 1) stream(assistant('reply', 7, `Some text ${'more '.repeat(i + 1)}`, { streaming: true }))
    expect(progressLine()?.dataset.turnProgress).toBe('writing')
    // The reply ends and a thought starts: both go to the store, and the turn shows the live thought.
    act(() => root.render(createElement(Transcript, { progress: { phase: 'thinking', step: { kind: 'reasoning' } } })))
    stream(assistant('reply', 7, 'Some text, done.', { streaming: false }), thinking('th', 8, 'Checking the tests', 'processing'))
    expect(host.textContent).toContain('Checking the tests')
    stream(thinking('th', 8, 'Checking the tests and the build output', 'processing'))
    expect(host.textContent).toContain('the build output')
  })
})

describe('a reply that ends without its last update', () => {
  /** A snapshot of the thread from the service (after a restart, or the thread opened again). */
  const snapshot = (messages: ChatMessage[]) =>
    act(() => useAppStore.getState().applyThreadMessages({ threadId: 'thread-1', messages }, useAppStore.getState().profileId))

  it('a snapshot that brings the finished reply shows its stored text and drops the live text', () => {
    mount(thread(3, 'One'))
    stream(assistant('reply', 7, 'One two three', { streaming: true }))
    expect(replyText()).toContain('One two three')
    snapshot([assistant('reply', 7, 'One two three four. Done.', { streaming: false })])
    expect(replyText()).toContain('One two three four. Done.')
    expect(liveTextOver('reply', 'One')).toBe('One')
  })

  it('a finished reply shorter than the live text (a lagging snapshot) shows the stored text, as Copy and the model read it', () => {
    mount(thread(3, 'One'))
    stream(assistant('reply', 7, 'One two three four', { streaming: true }))
    snapshot([assistant('reply', 7, 'One two', { streaming: false })])
    expect(replyText()).toContain('One two')
    expect(replyText()).not.toContain('three')
    // A later update for the same reply (still in flight) does not bring the live text back.
    stream(assistant('reply', 7, 'One two three four five', { streaming: true }))
    expect(replyText()).not.toContain('five')
  })

  it('opening another thread mid-stream drops the live text; coming back shows what the transcript holds', () => {
    mount(thread(3, 'One'))
    stream(assistant('reply', 7, 'One two three', { streaming: true }))
    act(() => useAppStore.getState().switchToThread('thread-2'))
    expect(liveTextOver('reply', 'One')).toBe('One')
    act(() => useAppStore.getState().switchToThread('thread-1'))
    // The reply ended while away: the thread's view brings it finished.
    act(() => useAppStore.getState().applyThreadView({ threadId: 'thread-1', messages: [...thread(3, 'One').slice(0, -1), assistant('reply', 7, 'One two three four.', { streaming: false })] } as never))
    expect(replyText()).toContain('One two three four.')
    expect(liveTextOver('reply', 'One two three four.')).toBe('One two three four.')
  })

  it('a profile change drops every live text', () => {
    mount(thread(2, 'One'))
    stream(assistant('reply', 5, 'One two', { streaming: true }))
    expect(liveTextOver('reply', 'One')).toBe('One two')
    act(() => useAppStore.setState({ profileId: 'other' }))
    expect(liveTextOver('reply', 'One')).toBe('One')
  })
})

describe('find while a reply streams', () => {
  it('searches the live text of the reply', () => {
    mount(thread(2, 'Alpha'))
    stream(assistant('reply', 5, 'Alpha bravo charlie', { streaming: true }))
    const reply = { id: 'reply', role: 'assistant', parts: [{ type: 'text', text: 'Alpha' }] } as unknown as UIMessage
    const text = searchableParts(reply).flatMap((part) => part.blocks).join(' ')
    expect(text).toContain('charlie')
  })

  /** The find hook over a thread whose turns stay the same object while the reply streams into its live text. */
  function FindHarness({ turns, out }: { turns: FindTurn[]; out: { find: ThreadFind | null } }) {
    countRender('FindHarness')
    const containerRef = useRef<HTMLDivElement>(null)
    const rowsRef = useRef<HTMLDivElement>(null)
    out.find = useThreadFind({
      enabled: true,
      turns,
      isStreaming: true,
      containerRef,
      rowsRef,
      virtualization: { beginNavigation: () => ({}) as never, cancelNavigation: () => {}, scrollToKey: async () => {} } as never,
      onNavigate: () => {},
      onProgrammaticScroll: () => {},
    })
    return createElement('div', { ref: containerRef }, createElement('div', { ref: rowsRef }))
  }

  it('finds text that streams in after the search, within the reindex interval, and renders nothing while closed', async () => {
    const messages = thread(1, 'Alpha')
    useAppStore.setState({ messages, activeThreadId: 'thread-1' })
    const reply = { id: 'reply', role: 'assistant', parts: [{ type: 'text', text: 'Alpha' }] } as unknown as UIMessage
    const prompt = { id: 'live', role: 'user', parts: [{ type: 'text', text: 'And now?' }] } as unknown as UIMessage
    const turns: FindTurn[] = [{ key: 'live', userMsg: prompt, assistantMsgs: [reply] }]
    const out: { find: ThreadFind | null } = { find: null }
    act(() => root.render(createElement(FindHarness, { turns, out })))

    // Closed: a streamed delta does not render the find hook's owner.
    const counts = startRenderCounts()
    stream(assistant('reply', 3, 'Alpha bravo', { streaming: true }))
    expect(counts.FindHarness ?? 0).toBe(0)

    act(() => out.find!.openFind!())
    act(() => out.find!.barProps!.onQueryChange('charlie'))
    expect(out.find!.barProps!.hasMatches).toBe(false)

    stream(assistant('reply', 3, 'Alpha bravo charlie', { streaming: true }))
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, STREAMING_REINDEX_MS + 50))))
    expect(out.find!.barProps!.hasMatches).toBe(true)
    expect(out.find!.barProps!.countLabel).toMatch(/1/)
  })

  it('with find open, renders once per reindex interval however many deltas stream in, and still finds the last text', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const messages = thread(1, 'Alpha')
    useAppStore.setState({ messages, activeThreadId: 'thread-1' })
    const reply = { id: 'reply', role: 'assistant', parts: [{ type: 'text', text: 'Alpha' }] } as unknown as UIMessage
    const prompt = { id: 'live', role: 'user', parts: [{ type: 'text', text: 'And now?' }] } as unknown as UIMessage
    const turns: FindTurn[] = [{ key: 'live', userMsg: prompt, assistantMsgs: [reply] }]
    const out: { find: ThreadFind | null } = { find: null }
    act(() => root.render(createElement(FindHarness, { turns, out })))
    act(() => out.find!.openFind!())
    act(() => out.find!.barProps!.onQueryChange('zulu'))
    act(() => { vi.advanceTimersByTime(STREAMING_REINDEX_MS * 2) })

    // 20 deltas within one interval: the first renders, the rest wait for the interval's end.
    const counts = startRenderCounts()
    const words = ['Alpha']
    for (let i = 0; i < 20; i += 1) {
      words.push(i === 19 ? 'zulu' : `word${i}`)
      stream(assistant('reply', 3, words.join(' '), { streaming: true }))
      act(() => { vi.advanceTimersByTime(10) })
    }
    expect(counts.FindHarness).toBe(1)

    act(() => { vi.advanceTimersByTime(STREAMING_REINDEX_MS * 2) })
    expect(counts.FindHarness).toBeLessThanOrEqual(4)
    expect(out.find!.barProps!.hasMatches).toBe(true)
  })
})
