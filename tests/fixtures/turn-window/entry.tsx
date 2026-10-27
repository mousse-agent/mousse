import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { UIMessage } from 'ai'
import { MessageList } from '../../../src/renderer/chat/components/agent-elements/message-list'
import '../../../src/renderer/styles/app.css'

const WORDS = 'the quick brown fox jumps over a lazy dog while reading a long transcript of prior turns'.split(' ')

/** Deterministic prose of about `chars` characters, one unbroken paragraph. */
function prose(seed: number, chars: number): string {
  let out = ''
  for (let index = seed; out.length < chars; index += 1) out += `${WORDS[(index * 7) % WORDS.length]} `
  return out.trim()
}

/**
 * Turn `index`: a short prompt and an answer whose paragraphs are single long
 * lines. The height estimate counts lines of source text, so it sits far below
 * what the wrapped paragraphs measure: mounting a row always moves the layout.
 */
function turnMessages(index: number): UIMessage[] {
  const paragraphs: string[] = []
  const count = 1 + (index % 4)
  for (let p = 0; p < count; p += 1) {
    paragraphs.push(`anchor-${index}-${p} ${prose(index + p, 300 + ((index * 37 + p * 91) % 500))}`)
  }
  if (index % 7 === 0) paragraphs.unshift(`## Heading ${index}`)
  if (index % 5 === 0) paragraphs.push(['- first item', '- second item', '- third item'].join('\n'))
  return [
    {
      id: `u-${index}`,
      role: 'user',
      parts: [{ type: 'text', text: `Prompt ${index} sentinel-u${index}` }],
    } as UIMessage,
    {
      id: `a-${index}`,
      role: 'assistant',
      parts: [{ type: 'text', text: paragraphs.join('\n\n') }],
    } as UIMessage,
  ]
}

let messages: UIMessage[] = []
let epoch = 0
let streaming = false

function Fixture({ list, version, status }: { list: UIMessage[]; version: number; status: 'ready' | 'streaming' }) {
  return (
    <div style={{ height: 800, width: 1000, display: 'flex', flexDirection: 'column' }}>
      <MessageList key={version} messages={list} status={status} />
    </div>
  )
}

const root = createRoot(document.getElementById('root')!)
const errors: string[] = []
window.addEventListener('error', (event) => errors.push(event.message))
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)))

const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
const frames = async (count: number) => {
  for (let index = 0; index < count; index += 1) await frame()
}
const container = () => document.querySelector<HTMLElement>('.an-message-list')!
const render = () =>
  flushSync(() => root.render(<Fixture list={messages} version={epoch} status={streaming ? 'streaming' : 'ready'} />))
const endGap = () => {
  const el = container()
  return el.scrollHeight - el.clientHeight - el.scrollTop
}

/** Top of the paragraph holding `text`, relative to the scroll container's top edge, or null when it is not mounted. */
function targetTop(text: string): number | null {
  const walker = document.createTreeWalker(container(), NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.includes(text)) {
      const block = node.parentElement!.closest('p, h1, h2, h3, li') ?? node.parentElement!
      return block.getBoundingClientRect().top - container().getBoundingClientRect().top
    }
  }
  return null
}

/** The first answer paragraph whose top sits at or below `minTop`: a reading point to hold. */
function pickSentinel(minTop: number): { text: string; top: number } | null {
  const edge = container().getBoundingClientRect().top
  for (const block of Array.from(container().querySelectorAll('p'))) {
    const match = /anchor-\d+-\d+/.exec(block.textContent ?? '')
    if (!match) continue
    const top = block.getBoundingClientRect().top - edge
    if (top >= minTop && top < 780) return { text: match[0], top }
  }
  return null
}

const qa = {
  async mount(count: number): Promise<number> {
    messages = Array.from({ length: count }, (_, index) => turnMessages(index)).flat()
    epoch += 1
    streaming = false
    const started = performance.now()
    render()
    await frames(3)
    return performance.now() - started
  },
  mountedTurns: () => document.querySelectorAll('[data-turn-key]').length,
  isMounted: (index: number) => Boolean(document.querySelector(`[data-turn-key="u-${index}"]`)),
  mountedRange(): { first: number; last: number } {
    const indexes = Array.from(document.querySelectorAll<HTMLElement>('[data-turn-key]')).map((row) =>
      Number(row.dataset.turnKey!.slice(2)),
    )
    return { first: Math.min(...indexes), last: Math.max(...indexes) }
  },
  windowed: () => container().dataset.windowed === 'true',
  spacers: () => document.querySelectorAll('[data-spacer]').length,
  scrollTo: (px: number) => {
    container().scrollTop = px
  },
  scrollTop: () => container().scrollTop,
  scrollHeight: () => container().scrollHeight,
  clientHeight: () => container().clientHeight,
  endGap,
  targetTop,
  /** Top of turn `index`'s prompt bubble relative to the container's top edge. */
  promptTop(index: number): number | null {
    const el = document.querySelector(`[data-prompt-id="u-${index}"]`)
    return el ? el.getBoundingClientRect().top - container().getBoundingClientRect().top : null
  },
  /** Scrolls so the container's top edge cuts through the paragraph with `text`, `fraction` of the way down it. */
  placeEdgeIn(text: string, fraction: number) {
    for (const block of Array.from(container().querySelectorAll('p'))) {
      if (!block.textContent?.includes(text)) continue
      const rect = block.getBoundingClientRect()
      container().scrollTop += rect.top - container().getBoundingClientRect().top + rect.height * fraction
      return true
    }
    return false
  },
  /** The turn whose row holds the paragraph with `text`, or -1. */
  rowIndexOf(text: string): number {
    for (const block of Array.from(container().querySelectorAll('p'))) {
      if (block.textContent?.includes(text)) {
        const row = block.closest<HTMLElement>('[data-turn-key]')
        return row ? Number(row.dataset.turnKey!.slice(2)) : -1
      }
    }
    return -1
  },
  /** Inserts `px` of height above everything in a mounted row, so what is inside it moves down. */
  growRow(index: number, px: number) {
    const row = document.querySelector<HTMLElement>(`[data-turn-key="u-${index}"]`)
    if (!row) throw new Error(`row ${index} is not mounted`)
    let filler = row.querySelector<HTMLElement>(':scope > [data-growth]')
    if (!filler) {
      filler = document.createElement('div')
      filler.dataset.growth = 'true'
      row.prepend(filler)
    }
    filler.style.height = `${px}px`
  },
  /** The first mounted row that reaches below the viewport's top edge. */
  firstVisibleTurn(): number {
    const edge = container().getBoundingClientRect().top
    for (const row of Array.from(document.querySelectorAll<HTMLElement>('[data-turn-key]'))) {
      if (row.getBoundingClientRect().bottom > edge + 1) return Number(row.dataset.turnKey!.slice(2))
    }
    return -1
  },
  addTurn() {
    messages = [...messages, ...turnMessages(messages.length / 2)]
    render()
  },
  streamAppend(text: string) {
    streaming = true
    const last = messages[messages.length - 1]!
    const parts = (last.parts ?? []).map((part) =>
      part.type === 'text' ? { ...part, text: `${part.text}${text}` } : part,
    )
    messages = [...messages.slice(0, -1), { ...last, parts } as UIMessage]
    render()
  },
  frames,
  jumpVisible: () => Boolean(document.querySelector('[aria-label="Go to latest"]')),
  clickJump() {
    document.querySelector<HTMLButtonElement>('[aria-label="Go to latest"]')!.click()
  },
  markerClick(index: number) {
    document.querySelector<HTMLButtonElement>(`[data-prompt-marker-id="u-${index}"]`)!.click()
  },
  /** Container centre, in window coordinates, for trusted input events. */
  center() {
    const rect = container().getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  },
  /**
   * Scrolls by `step` px per frame for `count` frames, as a user would, and
   * after each frame reports how far a sentinel paragraph is from where the
   * user's own motion alone would have left it. Layout shifts (rows measured at
   * heights far from their estimates, rows mounting and unmounting) must not
   * show up here. The sentinel is re-picked every few frames so it stays in view.
   */
  async sweep(
    step: number,
    count: number,
    minTop: number,
  ): Promise<{ drift: number[]; scrollHeightDelta: number }> {
    const el = container()
    const startHeight = el.scrollHeight
    const drift: number[] = []
    let base = pickSentinel(minTop)
    let moved = 0
    for (let index = 0; index < count; index += 1) {
      if (index % 4 === 0) {
        base = pickSentinel(minTop)
        moved = 0
      }
      if (!base) throw new Error('no sentinel paragraph in view')
      const before = el.scrollTop
      el.scrollTop = Math.max(0, before + step)
      moved += el.scrollTop - before
      // The window and the anchor settle on the frames that follow the scroll.
      await frames(2)
      const now = targetTop(base.text)
      if (now === null) throw new Error(`sentinel ${base.text} left the DOM`)
      drift.push(now - (base.top - moved))
    }
    return { drift, scrollHeightDelta: Math.abs(el.scrollHeight - startHeight) }
  },
  pickSentinel,
  errors: () => errors,
  unmount: () => root.unmount(),
}

;(window as unknown as { qa: typeof qa }).qa = qa
