// @vitest-environment jsdom
/**
 * A running turn's live view holds still while it streams: one live row at its end, the same element from the first
 * thought to the reply. The live row is the turn's current run: no group line repeats it while it runs; opened, it shows
 * the run's rows, the thought being written in full; when text starts, the run takes one group line, titled with the
 * headline the live row last showed for it, which never changes. The headline moves only at a new section or paragraph.
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
/** Group lines: toggles outside the live row and outside any group's rows. */
const groupLines = () => [...host.querySelectorAll<HTMLButtonElement>('.turn-answer button[aria-expanded]')]
  .filter((button) => !button.closest('.an-tool-group-rows') && !button.closest('[data-turn-live]'))
const toggle = () => liveRow()!.querySelector<HTMLButtonElement>('button.turn-live-toggle')
const openRows = () => liveRow()!.querySelector('.an-tool-group-rows')?.textContent ?? ''

describe('a running turn, streamed step by step', () => {
  it('is one live row while its run works, and the run takes one still group line when the reply starts', () => {
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
    expect(progress()!.textContent).toContain('Thinking…')
    expect(groupLines()).toEqual([])
    // A titled section: its title heads it, through every paragraph under it.
    text += '\n\n**Running it once**\n\nTo time it.'
    stream(thinking('th1', 1, text))
    expect(headline()).toBe('Running it once')
    text += '\n\nThen I can compare it with a run of only the slow file.'
    stream(thinking('th1', 1, text))
    same()
    expect(headline()).toBe('Running it once')

    // Opened, the live row shows the thought being written, open, as far as it has gone.
    act(() => toggle()!.click())
    expect(toggle()!.getAttribute('aria-expanded')).toBe('true')
    expect(openRows()).toContain('Then I can compare it with a run of only the slow file.')
    text += ' And the watcher.'
    stream(thinking('th1', 1, text))
    expect(openRows()).toContain('And the watcher.')

    // The thought ends and a call starts: still no group line; the live row says what runs, and its rows grow.
    render(TOOL)
    stream(thinking('th1', 1, text, 'complete'), bash('c1', 2, 'npm test', 'running'))
    same()
    expect(groupLines()).toEqual([])
    expect(headline()).toBe('Running it once')
    expect(progress()!.textContent).toContain('npm test')
    expect(openRows()).toContain('npm test')
    // Nothing above the live row repeats the headline: the live row is the run.
    expect([...host.querySelector('.turn-answer')!.children].filter((child) => child !== row && child.textContent!.includes('Running it once'))).toEqual([])

    // The call finishes: the live row says what it did.
    stream(bash('c1', 2, 'npm test', 'ok'))
    same()
    expect(progress()!.dataset.turnProgress).toBe('ran-tool')
    expect(progress()!.textContent).toBe('Rannpm test')

    // A later thought streams: it heads the live row.
    render(THINKING)
    stream(thinking('th2', 3, 'The watcher restarts it.'))
    same()
    expect(headline()).toBe('The watcher restarts it.')
    expect(groupLines()).toEqual([])

    // The next call fails: the live row says so under the same headline.
    render(TOOL)
    stream(thinking('th2', 3, 'The watcher restarts it.', 'complete'), bash('c2', 4, 'npm test -- --no-watch', 'running'))
    stream(bash('c2', 4, 'npm test -- --no-watch', 'failed'))
    same()
    expect(progress()!.dataset.turnProgress).toBe('failed-tool')
    expect(progress()!.querySelector('.turn-progress-failed')).not.toBeNull()
    expect(progress()!.querySelector('.turn-progress-badge')).toBeNull()
    expect(headline()).toBe('The watcher restarts it.')
    // The agent thinks on: line 2 says so, and still names the failure.
    render(THINKING)
    stream(thinking('th3', 5, 'Try it without the flag.'))
    expect(progress()!.textContent).toContain('Thinking…')
    expect(progress()!.querySelector('.turn-progress-badge')!.textContent).toBe('· 1 failed')

    // A reply starts: the live row hides, still the same element, and the run takes its group line, open as the person
    // left it, titled with the headline the live row last showed for its calls.
    render(STREAMING)
    stream(thinking('th3', 5, 'Try it without the flag.', 'complete'), { id: 'reply', role: 'assistant', content: 'The watcher', timestamp: at(6), streaming: true })
    same()
    expect(row.hidden).toBe(true)
    const lines = groupLines()
    expect(lines).toHaveLength(1)
    const line = lines[0]!
    expect(line.textContent).toContain('The watcher restarts it.')
    expect(line.textContent).toContain('2 commands')
    expect(line.getAttribute('aria-expanded')).toBe('true')
    const title = line.textContent
    // It never changes after that.
    stream({ id: 'reply', role: 'assistant', content: 'The watcher restarts the suite.', timestamp: at(6), streaming: true })
    expect(groupLines()[0]).toBe(line)
    expect(line.textContent).toBe(title)
  })

  it('a lone call is the live row until the reply, then one group line titled like the call', () => {
    useAppStore.setState({ messages: [prompt, bash('c1', 1, 'ls', 'running')], activeThreadId: 'thread-1' })
    render(TOOL)
    expect(groupLines()).toEqual([])
    expect(progress()!.textContent).toContain('ls')
    stream(bash('c1', 1, 'ls', 'ok'))
    expect(groupLines()).toEqual([])
    render(STREAMING)
    stream({ id: 'reply', role: 'assistant', content: 'Two files.', timestamp: at(2), streaming: true })
    expect(groupLines()).toHaveLength(1)
    expect(groupLines()[0]!.textContent).toContain('Ran ls')
  })
})
