// @vitest-environment jsdom
/**
 * A running turn's live view holds still while it streams: one live row at its end, the same element from the first
 * thought to the last call; a run of calls keeps the container its first call made; a group's title is set by the
 * thought that led to its first call; and the live row's headline changes only when a new paragraph of thought starts.
 * Driven through the store and the streamed-update channel, as the app feeds the list.
 */
import { act, createElement, useMemo, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { TurnProgressContext, type TurnProgressState } from '../../src/renderer/chat/components/agent-elements/turn-progress'
import { markRecoveredFailures, mousseToUIMessages, reuseUIMessages } from '../../src/renderer/chat/adapters/mousseToUI'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { applyStreamedUpdates, clearAllLiveText } from '../../src/renderer/stores/liveTextStore'
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
  clearAllLiveText()
  useAppStore.setState({ messages: [], activeThreadId: null, profileId: 'default' })
  setReplyPacing(true)
})

const at = (n: number) => new Date(Date.UTC(2026, 10, 17, 10, 0, 0) + n * 1000).toISOString()
const prompt: ChatMessage = { id: 'u', role: 'user', content: 'Why is the test slow?', timestamp: at(0), turnId: 't-u' }
const thinking = (id: string, n: number, content: string, status: 'processing' | 'complete' = 'processing'): ChatMessage =>
  ({ id, role: 'system', kind: 'thinking', content: '', timestamp: at(n), thinking: { content, status } })
const bash = (id: string, n: number, command: string, status: 'running' | 'ok' | 'failed'): ChatMessage => ({
  id, role: 'system', kind: 'tool_call', content: '', timestamp: at(n),
  toolCall: {
    title: 'Bash',
    summary: status === 'failed' ? 'The tool returned an error.' : `Ran ${command}`,
    details: ['Tool: Bash'],
    status: status === 'running' ? 'processing' : 'complete',
    toolName: 'Bash',
    input: { command },
    ...(status === 'running' ? {} : { response: status === 'failed' ? 'exit 1' : 'ok' }),
  },
} as ChatMessage)

/** The chat view's path from the store to the list. */
function Transcript({ progress }: { progress: TurnProgressState }) {
  const messages = useAppStore((s) => s.messages)
  const shown = useRef<UIMessage[]>([])
  const ui = useMemo(() => {
    const next = reuseUIMessages(shown.current, markRecoveredFailures(mousseToUIMessages(messages)))
    shown.current = next
    return next
  }, [messages])
  return createElement(TurnProgressContext.Provider, { value: progress }, createElement(MessageList, { messages: ui, status: 'streaming' }))
}

function render(progress: TurnProgressState) {
  act(() => root.render(createElement(Transcript, { progress })))
}

/** One frame of streamed updates, as App's batcher applies them. */
function stream(...updates: ChatMessage[]) {
  act(() => applyStreamedUpdates(updates, useAppStore.getState().messages, (next) => useAppStore.getState().updateMessages(next)))
}

const THINKING: TurnProgressState = { phase: 'thinking', step: { kind: 'reasoning' } }
const TOOL: TurnProgressState = { phase: 'tool_running' }
const STREAMING: TurnProgressState = { phase: 'streaming' }

const liveRow = () => host.querySelector<HTMLElement>('[data-turn-live]')
const headline = () => host.querySelector('.turn-live-headline')?.textContent ?? ''
const progress = () => host.querySelector<HTMLElement>('[data-turn-progress]')
/** The run's container: its group line (the one toggle outside any group's rows). */
const groupLine = () => [...host.querySelectorAll<HTMLButtonElement>('.turn-answer button[aria-expanded]')]
  .find((button) => !button.closest('.an-tool-group-rows'))

describe('a running turn, streamed step by step', () => {
  it('keeps one live row, one run container and one group title, and moves the headline only on a new paragraph', () => {
    useAppStore.setState({ messages: [prompt, thinking('th1', 1, 'Looking')], activeThreadId: 'thread-1' })
    render(THINKING)
    const row = liveRow()!
    expect(row).not.toBeNull()
    const same = () => expect(liveRow()).toBe(row)

    // The thought streams: its headline is its first sentence, which holds while the paragraph grows.
    const headlines: string[] = []
    let text = 'Looking'
    for (const chunk of [' at the slow test.', ' It runs', ' the whole suite', ' twice.', ' Maybe the watcher.']) {
      text += chunk
      stream(thinking('th1', 1, text))
      same()
      headlines.push(headline())
    }
    expect(headlines).toEqual(Array(5).fill('Looking at the slow test.'))
    expect(new Set(headlines).size).toBe(1)
    expect(progress()!.textContent).toContain('Thinking…')
    // A new paragraph: a new headline.
    text += '\n\n**Running it once**\n\nTo time it.'
    stream(thinking('th1', 1, text))
    same()
    expect(headline()).toBe('Running it once')

    // The thought ends and a call starts: the run gets its container, the live row says what runs.
    render(TOOL)
    stream(thinking('th1', 1, text, 'complete'), bash('c1', 2, 'npm test', 'running'))
    same()
    const line = groupLine()!
    expect(line.textContent).toContain('Running it once')
    expect(headline()).toBe('Running it once')
    expect(progress()!.textContent).toContain('npm test')

    // The call finishes: the same container; the live row says what it did.
    stream(bash('c1', 2, 'npm test', 'ok'))
    same()
    expect(groupLine()).toBe(line)
    expect(progress()!.dataset.turnProgress).toBe('ran-tool')
    expect(progress()!.textContent).toBe('Rannpm test')
    expect(headline()).toBe('Running it once')

    // A later thought streams: the group keeps the title its first call's thought gave it.
    render(THINKING)
    stream(thinking('th2', 3, 'The watcher restarts it.'))
    same()
    expect(groupLine()).toBe(line)
    expect(line.textContent).toContain('Running it once')
    expect(line.textContent).not.toContain('The watcher')
    expect(headline()).toBe('The watcher restarts it.')

    // The next call joins the run: the same container, the same title, now counting both.
    render(TOOL)
    stream(thinking('th2', 3, 'The watcher restarts it.', 'complete'), bash('c2', 4, 'npm test -- --no-watch', 'running'))
    same()
    expect(groupLine()).toBe(line)
    expect(line.textContent).toContain('Running it once')
    expect(line.textContent).toContain('2 commands')

    // It fails: the live row says so under the same headline, and the group line counts the failure.
    stream(bash('c2', 4, 'npm test -- --no-watch', 'failed'))
    same()
    expect(groupLine()).toBe(line)
    expect(progress()!.dataset.turnProgress).toBe('failed-tool')
    expect(progress()!.querySelector('.turn-progress-failed')).not.toBeNull()
    expect(headline()).toBe('The watcher restarts it.')
    expect(line.textContent).toContain('· 1 failed')

    // A reply starts: the live row hides (the text being written is on screen), still the same element.
    render(STREAMING)
    stream({ id: 'reply', role: 'assistant', content: 'The watcher', timestamp: at(5), streaming: true })
    same()
    expect(row.hidden).toBe(true)
  })

  it('a lone call keeps its container when it finishes and when the next call arrives', () => {
    useAppStore.setState({ messages: [prompt, bash('c1', 1, 'ls', 'running')], activeThreadId: 'thread-1' })
    render(TOOL)
    const line = groupLine()!
    // A run of one call is titled like the call.
    expect(line.textContent).toContain('ls')
    stream(bash('c1', 1, 'ls', 'ok'))
    expect(groupLine()).toBe(line)
    expect(line.textContent).toContain('Ran ls')
    stream(bash('c2', 2, 'pwd', 'running'))
    expect(groupLine()).toBe(line)
    expect(line.textContent).toContain('2 commands')
  })
})
