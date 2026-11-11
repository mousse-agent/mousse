// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IDLE_FLUSH_MS,
  PACE_MS,
  finishedBlocksEnd,
  usePacedText
} from '../../src/renderer/chat/components/agent-elements/reply-pacing'
import { setReplyPacing } from '../../src/renderer/lib/replyPacingSetting'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { startRenderCounts, stopRenderCounts } from '../../src/renderer/chat/components/agent-elements/render-counts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('where a streaming reply can be shown up to', () => {
  const shown = (text: string) => text.slice(0, finishedBlocksEnd(text))

  it('shows paragraphs once a blank line ends them, never a word being written', () => {
    expect(shown('The first para')).toBe('')
    expect(shown('The first paragraph.\n')).toBe('')
    expect(shown('The first paragraph.\n\nThe sec')).toBe('The first paragraph.\n\n')
    expect(shown('One.\n\nTwo is here.\n\nThr')).toBe('One.\n\nTwo is here.\n\n')
  })

  it('shows a list an item at a time and a heading as soon as its line ends', () => {
    expect(shown('Steps:\n- one\n- tw')).toBe('Steps:\n- one\n')
    expect(shown('Steps:\n1. one\n2. two\n3. th')).toBe('Steps:\n1. one\n2. two\n')
    expect(shown('## Setup\nThe tool')).toBe('## Setup\n')
    expect(shown('Intro.\n## Setup')).toBe('Intro.\n')
  })

  it('shows code a finished line at a time, and the fence whole once it closes', () => {
    const open = 'Run this:\n\n```ts\nconst a = 1\nconst b = 2\nconst c'
    expect(shown(open)).toBe('Run this:\n\n```ts\nconst a = 1\nconst b = 2\n')
    // Blank lines inside the fence are code, not paragraph ends.
    expect(shown('```py\nx = 1\n\ny = 2\n```\n\nAfter')).toBe('```py\nx = 1\n\ny = 2\n```\n\n')
    // The opening line alone shows nothing: a box appears with its first line.
    expect(shown('Text.\n```ts\n')).toBe('Text.\n')
  })

  it('keeps a list number that is alone on its line with the text after it', () => {
    expect(shown('1.\n\nFirst item')).toBe('')
  })
})

let root: Root
let host: HTMLElement

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'] })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  setReplyPacing(true)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  stopRenderCounts()
  setReplyPacing(true)
  vi.useRealTimers()
})

describe('a paced reply', () => {
  let seen: string[]
  let reveals: Array<{ at: number; text: string }>
  function Probe({ text, paced }: { text: string; paced: boolean }) {
    const value = usePacedText(text, paced)
    if (seen.at(-1) !== value) {
      seen.push(value)
      reveals.push({ at: performance.now(), text: value })
    }
    return null
  }
  const show = (text: string, paced = true) => act(() => root.render(createElement(Probe, { text, paced })))
  const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })

  beforeEach(() => { seen = []; reveals = [] })

  const reply = Array.from({ length: 8 }, (_, index) =>
    index === 3 ? '```ts\nconst one = 1\nconst two = 2\n```' : index === 5 ? '- first item\n- second item' : `Paragraph ${index} has a few words in it and ends here.`
  ).join('\n\n') + '\n\nThe last paragraph has no blank line after it'

  it('reveals whole blocks, no more often than every 400 ms, and everything once the turn ends', () => {
    // The model writes four characters every 15 ms. Time moves a millisecond at a time, so a reveal
    // is seen when it happens.
    for (let end = 4; end <= reply.length; end += 4) {
      show(reply.slice(0, end))
      for (let ms = 0; ms < 15; ms++) wait(1)
    }
    const shown = reveals.filter((reveal) => reveal.text !== '')
    expect(shown.length).toBeGreaterThan(3)
    for (const [index, reveal] of shown.entries()) {
      // Every reveal ends at a block's end: never part of a word, never a half line.
      expect(reveal.text.endsWith('\n'), JSON.stringify(reveal.text.slice(-30))).toBe(true)
      expect(reply.startsWith(reveal.text)).toBe(true)
      if (index > 0) expect(reveal.at - shown[index - 1]!.at).toBeGreaterThanOrEqual(PACE_MS)
    }
    // The last paragraph is still being written: it is not shown.
    expect(seen.at(-1)).not.toContain('The last paragraph')
    // The turn ends: all of it shows at once.
    show(reply, false)
    expect(seen.at(-1)).toBe(reply)
  })

  it('shows what is held once the model pauses', () => {
    show('A sentence before a tool call')
    expect(seen.at(-1)).toBe('')
    wait(IDLE_FLUSH_MS - 10)
    expect(seen.at(-1)).toBe('')
    wait(20)
    expect(seen.at(-1)).toBe('A sentence before a tool call')
  })

  it('shows the first finished block at once', () => {
    show('First paragraph.\n\nSec')
    expect(seen.at(-1)).toBe('First paragraph.\n\n')
  })

  it('never hides text it showed when pacing comes back on', () => {
    show('Live words as they', false)
    expect(seen.at(-1)).toBe('Live words as they')
    show('Live words as they come', true)
    expect(seen.at(-1)).toBe('Live words as they')
  })
})

describe('the setting', () => {
  const ask = (id: string, text: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] })
  const answer = (id: string, text: string): UIMessage => ({ id, role: 'assistant', parts: [{ type: 'text', text }] })
  const thread = (live: string) => [
    ...Array.from({ length: 10 }, (_, i) => [ask(`u${i}`, `Question ${i}`), answer(`a${i}`, `Answer ${i}.`)]).flat(),
    ask('live', 'And now?'),
    answer('reply', live)
  ]
  const render = (messages: UIMessage[], status: 'streaming' | 'ready' = 'streaming') =>
    act(() => root.render(createElement(MessageList, { messages, status })))
  const replyText = () => host.querySelector('[data-message-id="reply"]')?.textContent ?? ''

  beforeEach(() => {
    window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  })

  it('is on by default: the transcript shows finished paragraphs only', () => {
    render(thread('Done paragraph.\n\nHalf writ'))
    expect(replyText()).toContain('Done paragraph.')
    expect(replyText()).not.toContain('Half writ')
  })

  it('off, shows the text live as it arrives', () => {
    render(thread('Done paragraph.\n\nHalf writ'))
    act(() => setReplyPacing(false))
    expect(replyText()).toContain('Half writ')
    render(thread('Done paragraph.\n\nHalf written wor'))
    expect(replyText()).toContain('Half written wor')
  })

  it('shows the whole reply once the turn ends', () => {
    render(thread('Done paragraph.\n\nHalf writ'))
    render(thread('Done paragraph.\n\nHalf written and done.'), 'ready')
    expect(replyText()).toContain('Half written and done.')
  })

  it('a reveal re-renders the reply alone, not the transcript', () => {
    let messages = thread('Start.\n\n')
    render(messages)
    act(() => { vi.advanceTimersByTime(1000) })
    const counts = startRenderCounts()
    // Twenty updates in 300 ms, finishing two paragraphs: one transcript row per update, no more.
    for (let i = 0; i < 20; i++) {
      const extra = i === 5 ? 'Second paragraph done.\n\n' : i === 15 ? 'Third paragraph done.\n\n' : 'more '
      messages = [...messages.slice(0, -1), answer('reply', `${(messages.at(-1)!.parts[0] as { text: string }).text}${extra}`)]
      render(messages)
      act(() => { vi.advanceTimersByTime(15) })
    }
    expect(counts.TurnRow).toBe(20)
    const rows = counts.TurnRow
    const markdown = counts.Markdown ?? 0
    // The paced reveal that was waiting fires on its own: the reply renders, no transcript row does.
    act(() => { vi.advanceTimersByTime(PACE_MS) })
    expect(counts.TurnRow).toBe(rows)
    expect(counts.Markdown ?? 0).toBeGreaterThan(markdown)
    expect(replyText()).toContain('Third paragraph done.')
    // Updates that finish no block do not render the reply's Markdown at all.
    const before = counts.Markdown ?? 0
    messages = [...messages.slice(0, -1), answer('reply', `${(messages.at(-1)!.parts[0] as { text: string }).text}partial wor`)]
    render(messages)
    expect(counts.Markdown ?? 0).toBe(before)
  })
})
