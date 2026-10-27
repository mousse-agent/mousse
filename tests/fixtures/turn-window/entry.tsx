import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { UIMessage } from 'ai'
import { MessageList } from '../../../src/renderer/chat/components/agent-elements/message-list'
import { runCommand } from '../../../src/renderer/commands/commandRegistry'
import { attachCommandShortcuts } from '../../../src/renderer/commands/useCommandShortcuts'
import { useAppStore } from '../../../src/renderer/stores/appStore'
import '../../../src/renderer/styles/app.css'

// Ctrl/Cmd+F goes through the command registry like in the app: a thread is open and the dispatcher listens.
useAppStore.setState({ activeThreadId: 'fixture', appInfo: { platform: 'win32', repoRoot: '', llmProvider: '' } })
attachCommandShortcuts(window)

const WORDS = 'the quick brown fox jumps over a lazy dog while reading a long transcript of prior turns'.split(' ')

/** Deterministic prose of about `chars` characters, one unbroken paragraph. */
function prose(seed: number, chars: number): string {
  let out = ''
  for (let index = seed; out.length < chars; index += 1) out += `${WORDS[(index * 7) % WORDS.length]} `
  return out.trim()
}

/** A fenced `ts` block of `lines` lines. Blocks over 500 lines are shown unhighlighted, shorter ones get a late syntax pass. */
function fence(seed: number, lines: number, replace: Record<number, string> = {}): string {
  const body = Array.from({ length: lines }, (_, line) => replace[line] ?? `const value${seed}_${line} = compute(${line}, "${seed}")`)
  return ['```ts', ...body, '```'].join('\n')
}

// Turns with a fixed role in the thread. Everything else is a generated turn.
const STRADDLE = 400
const NESTED = 450
const FENCE = 600
const TABLE = 650
const THINKING = 700
const FENCE_LINES = 5000
const WIDE_LINE = 2400

const tool = (id: string, step: number) => ({
  type: 'tool-Bash',
  toolCallId: `${id}-${step}`,
  state: 'output-available',
  input: { command: `npm run step-${step}`, label: `Run step ${step}` },
  output: { stdout: `step ${step} finished\nall checks passed`, exitCode: 0 },
})

/** Consecutive messages that hold only tool calls: the list shows a run of two or more as one collapsed group. */
const toolGroup = (id: string, messageCount: number, perMessage: number): UIMessage[] =>
  Array.from({ length: messageCount }, (_, message) =>
    ({ id: `${id}-${message}`, role: 'assistant', parts: Array.from({ length: perMessage }, (_, step) => tool(`${id}-${message}`, step)) }) as UIMessage)

const user = (index: number, extra: unknown[] = []): UIMessage =>
  ({ id: `u-${index}`, role: 'user', parts: [{ type: 'text', text: `Prompt ${index} sentinel-u${index}` }, ...extra] }) as UIMessage
const assistant = (id: string, parts: unknown[]): UIMessage => ({ id, role: 'assistant', parts }) as UIMessage
const text = (value: string) => ({ type: 'text', text: value })

let pngBase64: string | null = null
/** A 64x48 PNG, drawn once: the thumbnails are real images that decode, not placeholders. */
function png(): string {
  if (pngBase64) return pngBase64
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 48
  const context = canvas.getContext('2d')!
  context.fillStyle = '#3b82f6'
  context.fillRect(0, 0, 64, 48)
  context.fillStyle = '#f59e0b'
  context.fillRect(8, 8, 24, 16)
  pngBase64 = canvas.toDataURL('image/png').split(',')[1]!
  return pngBase64
}

/** A turn whose first group, long text and second group let the viewport edge cut through it. */
function straddlingTurn(index: number): UIMessage[] {
  const paragraphs = Array.from({ length: 12 }, (_, p) => `anchor-paragraph-${p + 1} ${prose(index + p, 420)}`)
  return [
    user(index),
    ...toolGroup(`s-first-${index}`, 2, 5),
    assistant(`a-${index}`, [text(paragraphs.join('\n\n'))]),
    ...toolGroup(`s-second-${index}`, 2, 5),
  ]
}

/** A block quote taller than the viewport that holds two fences and text between them. */
function nestedTurn(index: number): UIMessage[] {
  const quote = (markdown: string) => markdown.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n')
  const paragraphs = Array.from({ length: 8 }, (_, p) => `quote-paragraph-${p + 1} ${prose(index + p, 360)}`)
  const body = [
    'quote-intro opens the quoted answer.',
    fence(index, 30),
    ...paragraphs,
    fence(index + 1, 30),
  ].join('\n\n')
  return [user(index), assistant(`a-${index}`, [text(quote(body))])]
}

/** One 5,000-line fence: an inner scroller in a row of ordinary height. Occurrences on its first, a very wide and its last line. */
function fenceTurn(index: number): UIMessage[] {
  const wide = `// ${'wide-column '.repeat(32)}needle-fence-wide`
  const code = fence(index, FENCE_LINES, {
    0: 'first line needle-fence-first',
    [WIDE_LINE]: wide,
    [FENCE_LINES - 1]: 'last line needle-fence-last',
  })
  return [user(index), assistant(`a-${index}`, [text(`The full log follows.\n\n${code}\n\nEnd of the log.`)])]
}

/** A 300-row table, taller than the viewport many times over, with an occurrence in its first and last row. */
function tableTurn(index: number): UIMessage[] {
  const rows = Array.from({ length: 300 }, (_, row) => {
    const mark = row === 0 ? 'needle-table-first' : row === 299 ? 'needle-table-last' : `cell-${row}`
    return `| row ${row} | value ${row} | ${mark} |`
  })
  const table = ['| name | value | note |', '| --- | --- | --- |', ...rows].join('\n')
  return [user(index), assistant(`a-${index}`, [text(`Results table.\n\n${table}`)])]
}

/** A 300,000-character thought, collapsed: its text must never be mounted. */
function thinkingTurn(index: number): UIMessage[] {
  const thought = `Weighing the options. ${prose(index, 300_000)}`
  return [
    user(index),
    assistant(`k-${index}`, [{ type: 'tool-Thinking', toolCallId: `think-${index}`, state: 'output-available', input: { thought }, output: thought }]),
    assistant(`a-${index}`, [text(`anchor-${index}-0 ${prose(index, 400)}`)]),
  ]
}

/**
 * Turn `index`: a short prompt and an answer whose paragraphs are single long
 * lines. The height estimate counts lines of source text, so it sits far below
 * what the wrapped paragraphs measure: mounting a row always moves the layout.
 * Every fifth turn also has a fenced block (late syntax highlighting, a
 * 200 px placeholder until it is near the viewport), every twentieth a prompt
 * with an image, three in ten a group of tool calls before the answer.
 */
function turnMessages(index: number): UIMessage[] {
  if (index === STRADDLE) return straddlingTurn(index)
  if (index === NESTED) return nestedTurn(index)
  if (index === FENCE) return fenceTurn(index)
  if (index === TABLE) return tableTurn(index)
  if (index === THINKING) return thinkingTurn(index)
  const paragraphs: string[] = []
  const count = 1 + (index % 4)
  for (let p = 0; p < count; p += 1) {
    paragraphs.push(`anchor-${index}-${p} ${prose(index + p, 300 + ((index * 37 + p * 91) % 500))}`)
  }
  if (index % 7 === 0) paragraphs.unshift(`## Heading ${index}`)
  if (index % 5 === 0) paragraphs.push(['- first item', '- second item', '- third item'].join('\n'))
  if (index % 5 === 2) paragraphs.push(fence(index, 8 + ((index * 13) % 33)))
  const image = index % 20 === 11 ? [{ type: 'file', mediaType: 'image/png', data: png() }] : []
  const calls = index % 10 < 3 ? toolGroup(`t-${index}`, 2, 1 + (index % 3)) : []
  return [user(index, image), ...calls, assistant(`a-${index}`, [text(paragraphs.join('\n\n'))])]
}

let messages: UIMessage[] = []
let turnCount = 0
let epoch = 0
let streaming = false

function Fixture({ list, version, status }: { list: UIMessage[]; version: number; status: 'ready' | 'streaming' }) {
  return (
    <div style={{ height: 800, width: 1000, display: 'flex', flexDirection: 'column' }}>
      <MessageList key={version} messages={list} status={status} enableFind />
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
const row = (index: number) => document.querySelector<HTMLElement>(`[data-turn-key="u-${index}"]`)
const render = () =>
  flushSync(() => root.render(<Fixture list={messages} version={epoch} status={streaming ? 'streaming' : 'ready'} />))
const endGap = () => {
  const el = container()
  return el.scrollHeight - el.clientHeight - el.scrollTop
}

/** Top of the paragraph holding `text`, relative to the scroll container's top edge, or null when it is not mounted. */
function targetTop(text: string): number | null {
  // A whole token: 'sentinel-u9' is not the start of 'sentinel-u999'.
  const token = new RegExp(`${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)`)
  const walker = document.createTreeWalker(container(), NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent && token.test(node.textContent)) {
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
    const match = /anchor-\d+-\d+|sentinel-u\d+/.exec(block.textContent ?? '')
    if (!match) continue
    const top = block.getBoundingClientRect().top - edge
    if (top >= minTop && top < 780) return { text: match[0], top }
  }
  return null
}

/** How much of the row at the top edge is still below the edge: the last pixels of a row are only its toolbar. */
const TAIL_PX = 64
function rowTail(): number {
  const edge = container().getBoundingClientRect().top
  for (const turn of Array.from(document.querySelectorAll<HTMLElement>('[data-turn-key]'))) {
    const bottom = turn.getBoundingClientRect().bottom - edge
    if (bottom > 0) return bottom
  }
  return Number.POSITIVE_INFINITY
}

/** Text appended while an answer streams: paragraphs, then a fenced block that opens, fills and closes. */
function streamChunk(step: number): string {
  if (step % 10 === 0) return `\n\nstreamed paragraph ${step} ${prose(step, 260)}`
  if (step === 12) return '\n\n```ts\nconst streamed = 0\n'
  if (step > 12 && step < 30) return `const streamed${step} = ${step}\n`
  if (step === 30) return '```\n'
  return ` streamed text ${step} that keeps the answer growing line after line.`
}

const groupTriggers = (index: number) =>
  Array.from(row(index)?.querySelectorAll<HTMLButtonElement>('button') ?? []).filter((button) => /^\s*Tool calls/.test(button.textContent ?? ''))

const qa = {
  /** Mounts `count` turns (two messages or more each); resolves once every thumbnail has decoded. */
  async mount(count: number): Promise<number> {
    turnCount = count
    messages = Array.from({ length: count }, (_, index) => turnMessages(index)).flat()
    epoch += 1
    streaming = false
    const started = performance.now()
    render()
    await frames(3)
    await Promise.all(
      Array.from(container().querySelectorAll('img'), (image) => (image.complete ? undefined : new Promise((done) => { image.onload = image.onerror = done }))),
    )
    return performance.now() - started
  },
  messageCount: () => messages.length,
  mountedTurns: () => document.querySelectorAll('[data-turn-key]').length,
  isMounted: (index: number) => Boolean(row(index)),
  mountedRange(): { first: number; last: number } {
    const indexes = Array.from(document.querySelectorAll<HTMLElement>('[data-turn-key]')).map((turn) =>
      Number(turn.dataset.turnKey!.slice(2)),
    )
    return { first: Math.min(...indexes), last: Math.max(...indexes) }
  },
  windowed: () => container().dataset.windowed === 'true',
  spacers: () => document.querySelectorAll('[data-spacer]').length,
  /** Elements and text of the mounted transcript, and what the heap holds: reported, never asserted. */
  domNodes: () => container().querySelectorAll('*').length,
  heapMB: () => ((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1048576,
  /** Characters of mounted text: a collapsed 300,000-character thought adds none of its own. */
  textLength: () => container().textContent?.length ?? 0,
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
  /** Scrolls so the paragraph with `text` has its top `top` px below the container's top edge. */
  placeSentinel(text: string, top: number): boolean {
    for (const block of Array.from(container().querySelectorAll('p, li'))) {
      if (!block.textContent?.includes(text)) continue
      container().scrollTop += block.getBoundingClientRect().top - container().getBoundingClientRect().top - top
      return true
    }
    return false
  },
  /**
   * Scrolls turn `index` to `top` px below the container's top edge, the way a
   * person drags toward it: a turn that is not mounted yet is approached by
   * its share of the thread, then corrected once it mounts.
   */
  async goToRow(index: number, top = 0): Promise<boolean> {
    const el = container()
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const target = row(index)
      if (target) {
        const delta = target.getBoundingClientRect().top - el.getBoundingClientRect().top - top
        if (Math.abs(delta) <= 1) return true
        el.scrollTop += delta
      } else {
        // Not mounted: move by the average turn height times the turns still to go from the one in view.
        const visible = qa.firstVisibleTurn()
        const average = el.scrollHeight / Math.max(1, turnCount)
        el.scrollTop += (index - visible) * average * 0.8
      }
      await frames(3)
    }
    return Boolean(row(index))
  },
  /** The turn whose row holds the paragraph with `text`, or -1. */
  rowIndexOf(text: string): number {
    for (const block of Array.from(container().querySelectorAll('p'))) {
      if (block.textContent?.includes(text)) {
        const turn = block.closest<HTMLElement>('[data-turn-key]')
        return turn ? Number(turn.dataset.turnKey!.slice(2)) : -1
      }
    }
    return -1
  },
  /** The first mounted turn above `index` that holds a fenced block, or -1. */
  codeRowAbove(index: number): number {
    for (let candidate = index - 1; candidate >= Math.max(0, index - 12); candidate -= 1) {
      if (row(candidate)?.querySelector('[data-streamdown="code-block"]')) return candidate
    }
    return -1
  },
  /** Inserts `px` of height above everything in a mounted row, so what is inside it moves down. */
  growRow(index: number, px: number) {
    const turn = row(index)
    if (!turn) throw new Error(`row ${index} is not mounted`)
    let filler = turn.querySelector<HTMLElement>(':scope > [data-growth]')
    if (!filler) {
      filler = document.createElement('div')
      filler.dataset.growth = 'true'
      turn.prepend(filler)
    }
    filler.style.height = `${px}px`
  },
  /** Makes a fenced block `px` taller from its top edge: what a late syntax pass or an expanding placeholder does. */
  growCodeBlock(index: number, which: 'first' | 'last', px: number) {
    const blocks = Array.from(row(index)?.querySelectorAll<HTMLElement>('[data-streamdown="code-block"]') ?? [])
    const block = which === 'first' ? blocks[0] : blocks[blocks.length - 1]
    if (!block) throw new Error(`row ${index} has no fenced block`)
    block.style.paddingTop = `${px}px`
  },
  /** The fenced blocks of a row: their capped height and whether they scroll inside themselves. */
  codeBlocks(index: number): { rowHeight: number; bodies: { clientHeight: number; scrollHeight: number; scrollWidth: number; clientWidth: number }[] } {
    const turn = row(index)
    const bodies = Array.from(turn?.querySelectorAll<HTMLElement>('[data-streamdown="code-block-body"]') ?? [], (body) => ({
      clientHeight: body.clientHeight, scrollHeight: body.scrollHeight, scrollWidth: body.scrollWidth, clientWidth: body.clientWidth,
    }))
    return { rowHeight: turn?.offsetHeight ?? 0, bodies }
  },
  /** Opens or closes the `which` group of tool calls in a row; resolves with its top edge before the click. */
  toggleGroup(index: number, which: 'first' | 'second'): number | null {
    const trigger = groupTriggers(index)[which === 'first' ? 0 : 1]
    if (!trigger) return null
    trigger.click()
    return trigger.getBoundingClientRect().top - container().getBoundingClientRect().top
  },
  groupCount: (index: number) => groupTriggers(index).length,
  /** Top of a group header relative to the container's top edge. */
  groupTop(index: number, which: 'first' | 'second'): number | null {
    const trigger = groupTriggers(index)[which === 'first' ? 0 : 1]
    return trigger ? trigger.getBoundingClientRect().top - container().getBoundingClientRect().top : null
  },
  rowHeight: (index: number) => row(index)?.offsetHeight ?? 0,
  /** The first mounted row that reaches below the viewport's top edge. */
  firstVisibleTurn(): number {
    const edge = container().getBoundingClientRect().top
    for (const turn of Array.from(document.querySelectorAll<HTMLElement>('[data-turn-key]'))) {
      if (turn.getBoundingClientRect().bottom > edge + 1) return Number(turn.dataset.turnKey!.slice(2))
    }
    return -1
  },
  /** Appends a turn; `tall` gives it an answer of twelve paragraphs (`anchor-<n>-0` to `-11`), taller than the viewport. */
  addTurn(tall = false) {
    const added = tall
      ? [user(turnCount), assistant(`a-${turnCount}`, [text(Array.from({ length: 12 }, (_, p) => `anchor-${turnCount}-${p} ${prose(turnCount + p, 420)}`).join('\n\n'))])]
      : turnMessages(turnCount)
    messages = [...messages, ...added]
    turnCount += 1
    render()
  },
  lastTurn: () => turnCount - 1,
  streamAppend(extra: string) {
    streaming = true
    const last = messages[messages.length - 1]!
    const parts = (last.parts ?? []).map((part) =>
      part.type === 'text' ? { ...part, text: `${part.text}${extra}` } : part,
    )
    messages = [...messages.slice(0, -1), { ...last, parts } as UIMessage]
    render()
  },
  /**
   * Streams `count` chunks into the last answer, one per frame, and after each
   * frame reports where `sentinel` and the scroll position are. The chunks open
   * and close a fenced block, so the row grows by paragraphs and by a code box.
   */
  async streamRun(count: number, sentinel: string) {
    const el = container()
    const start = { top: targetTop(sentinel), scrollTop: el.scrollTop, gap: endGap() }
    const samples: { top: number | null; scrollTop: number; mounted: number }[] = []
    for (let index = 0; index < count; index += 1) {
      qa.streamAppend(streamChunk(index))
      await frame()
      samples.push({ top: targetTop(sentinel), scrollTop: el.scrollTop, mounted: qa.mountedTurns() })
    }
    await frames(2)
    return { start, samples, endGap: endGap(), jumpVisible: qa.jumpVisible() }
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
  ): Promise<{ drift: number[]; tailDrift: number[]; scrollHeightDelta: number }> {
    const el = container()
    const startHeight = el.scrollHeight
    const drift: number[] = []
    // Samples taken while only the last few px of a row (its toolbar) were at the top edge; see `rowTail`.
    const tailDrift: number[] = []
    let base = pickSentinel(minTop) ?? pickSentinel(-300)
    let moved = 0
    let inTail = false
    for (let index = 0; index < count; index += 1) {
      if (index % 4 === 0) {
        base = pickSentinel(minTop) ?? pickSentinel(-300)
        moved = 0
        inTail = false
      }
      if (!base) {
        const edge = container().getBoundingClientRect().top
        const seen = Array.from(container().querySelectorAll('p'), (block) => `${Math.round(block.getBoundingClientRect().top - edge)}:${(block.textContent ?? '').slice(0, 14)}`)
        throw new Error(`no sentinel paragraph in view at step ${index}, scrollTop ${el.scrollTop}, turn ${qa.firstVisibleTurn()}; paragraphs ${seen.slice(0, 40).join(' | ')}`)
      }
      const before = el.scrollTop
      if (rowTail() < TAIL_PX) inTail = true
      el.scrollTop = Math.max(0, before + step)
      moved += el.scrollTop - before
      if (rowTail() < TAIL_PX) inTail = true
      // The window and the anchor settle on the frames that follow the scroll.
      await frames(2)
      const now = targetTop(base.text)
      if (now === null) throw new Error(`sentinel ${base.text} left the DOM`)
      ;(inTail ? tailDrift : drift).push(now - (base.top - moved))
    }
    return { drift, tailDrift, scrollHeightDelta: Math.abs(el.scrollHeight - startHeight) }
  },
  /** Scrolls `steps` times by `px` from the top, one step per frame, and reports the longest gap between frames. */
  async scriptedScroll(steps: number, px: number): Promise<number> {
    const el = container()
    el.scrollTop = 0
    await frames(2)
    let longest = 0
    let last = performance.now()
    for (let index = 0; index < steps; index += 1) {
      el.scrollTop += px
      await frame()
      const now = performance.now()
      longest = Math.max(longest, now - last)
      last = now
    }
    return longest
  },
  pickSentinel,
  /** Opens the find bar the way the command palette does. */
  openFind: () => runCommand('chat.findInThread', 'palette'),
  findOpen: () => Boolean(document.querySelector('[role="search"]')),
  findCount: () => document.querySelector('.chat-find-count')?.textContent ?? null,
  /** Where the active match is painted, relative to the transcript's top edge, or null when none is. */
  activeMatch(): { top: number; bottom: number; text: string; viewport: number; turn: string | null } | null {
    const highlight = (CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights.get('mousse-find-active')
    const range = highlight ? Array.from(highlight)[0] : undefined
    if (!range) return null
    const rect = range.getBoundingClientRect()
    const edge = container().getBoundingClientRect()
    const turn = range.startContainer.parentElement?.closest<HTMLElement>('[data-turn-key]')
    return { top: rect.top - edge.top, bottom: rect.bottom - edge.top, text: range.toString(), viewport: edge.height, turn: turn?.dataset.turnKey ?? null }
  },
  activeInView(): boolean {
    const match = qa.activeMatch()
    return match !== null && match.top >= 0 && match.bottom <= match.viewport
  },
  /**
   * Whether the active match is inside every box that clips it: the transcript
   * and, for a fenced block, the block's own scroller (with where that scroller is).
   */
  activeGeometry(): { inContainer: boolean; body: { inside: boolean; scrollTop: number; scrollLeft: number; scrollHeight: number; clientHeight: number } | null } | null {
    const highlight = (CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights.get('mousse-find-active')
    const range = highlight ? Array.from(highlight)[0] : undefined
    if (!range) return null
    const rect = range.getBoundingClientRect()
    const box = container().getBoundingClientRect()
    const within = (outer: DOMRect) => rect.width > 0 && rect.top >= outer.top - 1 && rect.bottom <= outer.bottom + 1 && rect.left >= outer.left - 1 && rect.right <= outer.right + 1
    const body = range.startContainer.parentElement?.closest<HTMLElement>('[data-streamdown="code-block-body"]')
    return {
      inContainer: within(box),
      body: body
        ? { inside: within(body.getBoundingClientRect()), scrollTop: body.scrollTop, scrollLeft: body.scrollLeft, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight }
        : null,
    }
  },
  highlightCount: () => (CSS as unknown as { highlights: Map<string, unknown> }).highlights.size,
  /** Types into the find field the way a person does: React sees an input event. */
  setFindQuery(value: string) {
    const field = document.querySelector<HTMLInputElement>('input[aria-label="Find in thread"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  },
  findFocused: () => document.activeElement === document.querySelector('input[aria-label="Find in thread"]'),
  errors: () => errors,
  unmount: () => root.unmount(),
}

;(window as unknown as { qa: typeof qa }).qa = qa
