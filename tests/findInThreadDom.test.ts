// @vitest-environment jsdom
import type { UIMessage } from 'ai'
import { createElement, useMemo, useRef, useState } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageList } from '../src/renderer/chat/components/agent-elements/message-list'
import { collectFindRanges, createFindPainter } from '../src/renderer/chat/components/agent-elements/find/dom-highlight'
import { FindInThreadBar } from '../src/renderer/chat/components/agent-elements/find/FindInThreadBar'
import { buildFindIndex, normalizeForSearch, type FindTurn } from '../src/renderer/chat/components/agent-elements/find/find-index'
import { bringIntoView, revealMatch, type RevealDeps } from '../src/renderer/chat/components/agent-elements/find/reveal'
import { useThreadFind } from '../src/renderer/chat/components/agent-elements/find/use-thread-find'
import { pickFindController, focusOwnsFind } from '../src/renderer/chat/components/agent-elements/find/use-find-shortcut'
import { pushOverlay, registerCommand, runCommand, useCommandRegistry } from '../src/renderer/commands/commandRegistry'
import { attachCommandShortcuts } from '../src/renderer/commands/useCommandShortcuts'
import { useAppStore } from '../src/renderer/stores/appStore'

const message = (id: string, role: 'user' | 'assistant', parts: unknown[]): UIMessage =>
  ({ id, role, parts, createdAt: '2026-10-25T12:00:00.000Z' }) as unknown as UIMessage
const user = (id: string, text: string) => message(id, 'user', [{ type: 'text', text }])
const assistant = (id: string, ...texts: string[]) => message(id, 'assistant', texts.map((text) => ({ type: 'text', text })))
const turn = (key: string, userMsg: UIMessage | undefined, ...assistantMsgs: UIMessage[]): FindTurn => ({ key, userMsg, assistantMsgs })

type Geometry = { top: number; left?: number; height: number; width?: number }

/** jsdom has no layout and no Range rectangles; give a range or an element the box a test describes. */
function boxOf({ top, left = 0, height, width = 40 }: Geometry): DOMRect {
  return { top, bottom: top + height, left, right: left + width, width, height, x: left, y: top, toJSON: () => ({}) } as DOMRect
}

const rangeBoxes = new WeakMap<Range, () => Geometry>()

beforeEach(() => {
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: Range) {
      return boxOf(rangeBoxes.get(this)?.() ?? { top: 0, height: 0 })
    }
  })
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('the collector reads what the index reads', () => {
  const corpus = [
    'Intro with **bold needle** and a [link needle](https://example.com) and a [ref needle][r1].',
    '',
    '[r1]: https://example.com/r',
    '',
    'Inline `code with **needle**` and an escaped \\*needle\\* and &amp; entity needle & more.',
    '',
    '![needle alt](https://example.com/x.png)',
    '',
    '| head needle | other |',
    '| --- | --- |',
    '| cell one | needle two |',
    '',
    'needle phrase across',
    'a soft break needle',
    '',
    'line one  ',
    'hard needle break',
    '',
    '> quote needle',
    '> - nested needle',
    '',
    '```ts',
    'const needle = "**needle**";',
    'second needle line',
    '',
    'last needle',
    '```',
    '',
    '- list needle',
    '  - nested needle',
    '',
    'emoji 🎉 needle and 中文 needle',
    '',
    'decomposed é in **é needle** and later needle'
  ].join('\n')

  const turns = [
    // A row is keyed by its prompt's id.
    turn('u0', user('u0', 'a prompt with Needle\nand a second needle line'), assistant('a0', corpus, 'second part needle')),
    turn('u1', user('u1', 'needle again'), assistant('a1', 'plain needle'))
  ]
  const html = renderToStaticMarkup(
    createElement(MessageList, { messages: turns.flatMap((t) => [t.userMsg!, ...t.assistantMsgs]), status: 'ready', enableFind: true })
  )

  function mountRows(): HTMLElement[] {
    const host = document.createElement('div')
    host.innerHTML = html
    document.body.append(host)
    return Array.from(host.querySelectorAll<HTMLElement>('[data-turn-key]'))
  }

  const queries = ['needle', 'NEEDLE', 'bold needle', 'a soft', 'across a', 'é needle', 'later needle', 'hard needle', 'entity needle', 'const needle']

  it.each(queries)('finds the same ordered occurrences for %j', (query) => {
    const rows = mountRows()
    expect(rows).toHaveLength(2)
    const fromDom = rows.flatMap((row) =>
      collectFindRanges(row, query).map((o) => ({
        turnKey: row.dataset.turnKey,
        messageId: o.messageId,
        partIndex: o.partIndex,
        ordinal: o.ordinal,
        text: normalizeForSearch(o.range.toString().replace(/[\r\n]/g, ' '))
      }))
    )
    const fromIndex = buildFindIndex(turns, query).map((m) => ({
      turnKey: m.turnKey,
      messageId: m.messageId,
      partIndex: m.partIndex,
      ordinal: m.ordinal,
      text: normalizeForSearch(query)
    }))
    expect(fromIndex.length).toBeGreaterThan(0)
    expect(fromDom).toEqual(fromIndex)
    // Counted by hand from the corpus: 2 in the first prompt, 23 in the first reply part, 1 in its second part, 2 in the second turn.
    if (query.toLowerCase() === 'needle') expect(fromIndex).toHaveLength(28)
    for (const occurrence of fromDom) expect(occurrence.text).toBe(normalizeForSearch(query))
  })

  it('does not match a phrase across two table cells, or the alt text of an image', () => {
    const rows = mountRows()
    expect(rows.flatMap((row) => collectFindRanges(row, 'cell one needle two'))).toEqual([])
    expect(rows.flatMap((row) => collectFindRanges(row, 'needle alt'))).toEqual([])
    expect(buildFindIndex(turns, 'needle alt')).toEqual([])
  })

  it('numbers the occurrences of each part separately, in document order', () => {
    const rows = mountRows()
    const second = collectFindRanges(rows[0]!, 'second part needle')
    expect(second.map((o) => [o.messageId, o.partIndex, o.ordinal])).toEqual([['a0', 1, 0]])
  })
})

describe('the painter', () => {
  const highlights = new Map<string, { ranges: Range[]; priority: number }>()

  beforeEach(() => {
    highlights.clear()
    ;(globalThis as { CSS?: unknown }).CSS = { highlights }
    ;(globalThis as { Highlight?: unknown }).Highlight = class {
      ranges: Range[]
      priority = 0
      constructor(...ranges: Range[]) {
        this.ranges = ranges
      }
    }
  })

  afterEach(() => {
    delete (globalThis as { CSS?: unknown }).CSS
    delete (globalThis as { Highlight?: unknown }).Highlight
  })

  function rowsRoot(): HTMLElement {
    const root = document.createElement('div')
    root.innerHTML =
      '<div data-turn-key="k0"><p data-find-text data-message-id="m0" data-part-index="0">Alpha needle beta needle</p></div>' +
      '<div data-turn-key="k1"><div data-find-text data-message-id="m1" data-part-index="2"><p>one <b>nee</b>dle</p><pre><code><span class="block">first needle</span><span class="block">needle second</span></code></pre></div></div>'
    document.body.append(root)
    return root
  }

  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

  it('paints every occurrence and the active one with a stronger highlight', async () => {
    const root = rowsRoot()
    const painter = createFindPainter(root)
    painter.setQuery('NEEDLE')
    painter.setActive({ turnKey: 'k1', messageId: 'm1', partIndex: 2, ordinal: 1 })
    await nextFrame()
    const all = highlights.get('mousse-find')!
    expect(all.ranges.map((range) => range.toString())).toEqual(['needle', 'needle', 'needle', 'needle', 'needle'])
    const active = highlights.get('mousse-find-active')!
    expect(active.priority).toBeGreaterThan(all.priority)
    expect(active.ranges).toHaveLength(1)
    // Ordinal 1 of k1's part is the second occurrence there: the first line of the code block.
    expect(active.ranges[0]!.startContainer.textContent).toBe('first needle')
    painter.dispose()
    expect(highlights.size).toBe(0)
  })

  it('reads a match across inline elements as one range and code lines as separate lines', () => {
    const root = rowsRoot()
    const painter = createFindPainter(root)
    painter.setQuery('needle')
    expect(painter.locate({ turnKey: 'k1', messageId: 'm1', partIndex: 2, ordinal: 0 })!.toString()).toBe('needle')
    painter.setQuery('first needle')
    expect(painter.locate({ turnKey: 'k1', messageId: 'm1', partIndex: 2, ordinal: 0 })!.toString()).toBe('first needle')
    // A phrase that would only exist by joining the end of one line to the start of the next is not a match.
    painter.setQuery('needleneedle')
    expect(painter.locate({ turnKey: 'k1', messageId: 'm1', partIndex: 2, ordinal: 0 })).toBeNull()
    painter.dispose()
  })

  it('repaints after a row changes and leaves rows that are not mounted alone', async () => {
    const root = rowsRoot()
    const painter = createFindPainter(root)
    painter.setQuery('needle')
    await nextFrame()
    expect(highlights.get('mousse-find')!.ranges).toHaveLength(5)
    root.querySelector('[data-turn-key="k0"] p')!.textContent = 'needle'
    await nextFrame()
    await nextFrame()
    expect(highlights.get('mousse-find')!.ranges).toHaveLength(4)
    root.querySelector('[data-turn-key="k1"]')!.remove()
    await nextFrame()
    await nextFrame()
    expect(highlights.get('mousse-find')!.ranges).toHaveLength(1)
    expect(painter.row('k1')).toBeNull()
    painter.dispose()
  })

  it('skips ignored text such as toolbars and the clock', () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<div data-turn-key="k"><div data-find-text data-message-id="m" data-part-index="0"><p>needle</p><div data-find-ignore>needle</div><div role="toolbar">needle</div><svg><text>needle</text></svg></div></div>'
    document.body.append(root)
    expect(collectFindRanges(root.firstElementChild!, 'needle')).toHaveLength(1)
  })
})

describe('landing on a match', () => {
  /** A transcript container 600 px tall whose scrollTop is a plain number. */
  function fixture() {
    const container = document.createElement('div')
    let scrollTop = 0
    Object.defineProperty(container, 'scrollTop', { get: () => scrollTop, set: (value: number) => void (scrollTop = value) })
    container.getBoundingClientRect = () => boxOf({ top: 100, height: 600, width: 800 })
    const writes: number[] = []
    const mounted = new Set<string>()
    const text = document.createTextNode('a needle here')
    const row = document.createElement('div')
    row.append(text)
    container.append(row)
    document.body.append(container)
    // The match sits at `matchTop` in the viewport when scrollTop is 0 and moves with the scroll.
    const range = document.createRange()
    range.setStart(text, 2)
    range.setEnd(text, 8)
    let matchTop = 1500
    rangeBoxes.set(range, () => ({ top: matchTop - scrollTop, height: 20 }))
    row.getBoundingClientRect = () => boxOf({ top: matchTop - scrollTop - 10, height: 100 })
    const current = { isCurrent: () => true, end: vi.fn() }
    const calls: string[] = []
    const deps: RevealDeps = {
      container,
      painter: {
        row: (key) => (mounted.has(key) ? row : null),
        locate: () => (mounted.has('far') ? range : null),
        locateFirstInPart: () => null,
        setActive: vi.fn()
      },
      scrollToKey: async (key, target) => {
        calls.push(`${key}:${target.align}`)
        mounted.add(key)
        return true
      },
      onProgrammaticScroll: () => writes.push(scrollTop),
      nextFrame: () => Promise.resolve()
    }
    return {
      container,
      deps,
      current,
      calls,
      writes,
      mounted,
      setMatchTop: (value: number) => (matchTop = value),
      scrollTop: () => scrollTop,
      range
    }
  }

  const target = { turnKey: 'far', messageId: 'm', partIndex: 0, ordinal: 0 }

  it('lands on a turn that is not mounted through the turn window, then centres the match', async () => {
    const f = fixture()
    const result = await revealMatch(target, f.current, f.deps)
    expect(result).toBe('revealed')
    expect(f.calls).toEqual(['far:start'])
    // The match was 1,400 px below the container's top edge: it is now centred (container 600 px tall).
    const rect = f.range.getBoundingClientRect()
    expect(rect.top + rect.height / 2).toBeCloseTo(100 + 300, 0)
    expect(f.writes.length).toBeGreaterThan(0)
    expect(f.deps.painter.setActive).toHaveBeenCalledWith(target)
    expect(f.current.end).toHaveBeenCalled()
  })

  it('does not use the turn window for a turn that is already mounted, and leaves a visible match where it is', async () => {
    const f = fixture()
    f.mounted.add('far')
    f.setMatchTop(300)
    expect(await revealMatch(target, f.current, f.deps)).toBe('revealed')
    expect(f.calls).toEqual([])
    expect(f.scrollTop()).toBe(0)
    expect(f.writes).toEqual([])
  })

  it('lands through the turn window on a row that is mounted but far away, as the first and last turns can be', async () => {
    const f = fixture()
    f.mounted.add('far')
    // The row is mounted, 1,400 px below a 600 px viewport: more than a viewport's height away.
    expect(await revealMatch(target, f.current, f.deps)).toBe('revealed')
    expect(f.calls).toEqual(['far:start'])
  })

  it('keeps aiming while the match moves (rows measured, late highlighting), then stops', async () => {
    const f = fixture()
    f.mounted.add('far')
    let frames = 0
    // A frame after the landing, the content moves 400 px (a row above measured taller than its estimate).
    f.deps.nextFrame = () => {
      frames += 1
      if (frames === 1) f.setMatchTop(1500 + 400)
      return Promise.resolve()
    }
    expect(await revealMatch(target, f.current, f.deps)).toBe('revealed')
    const rect = f.range.getBoundingClientRect()
    expect(rect.top + rect.height / 2).toBeCloseTo(400, 0)
    expect(frames).toBeLessThan(10)
  })

  it('stops writing the moment its navigation is cancelled', async () => {
    const f = fixture()
    let live = true
    const cancelled = { isCurrent: () => live, end: vi.fn() }
    f.deps.scrollToKey = async (key) => {
      f.calls.push(key)
      live = false
      f.mounted.add(key)
      return false
    }
    expect(await revealMatch(target, cancelled, f.deps)).toBe('cancelled')
    expect(f.scrollTop()).toBe(0)
    expect(f.writes).toEqual([])
    expect(cancelled.end).toHaveBeenCalled()
  })

  it('gives up when the row never mounts', async () => {
    const f = fixture()
    f.deps.scrollToKey = async () => true
    expect(await revealMatch(target, f.current, f.deps)).toBe('missing')
  })

  it('scrolls a code block and a table wrapper to the match before it scrolls the transcript', () => {
    const container = document.createElement('div')
    container.getBoundingClientRect = () => boxOf({ top: 0, height: 600, width: 800 })
    let transcriptTop = 0
    Object.defineProperty(container, 'scrollTop', { get: () => transcriptTop, set: (value: number) => void (transcriptTop = value) })
    const body = document.createElement('div')
    body.style.overflowX = 'auto'
    body.style.overflowY = 'auto'
    body.getBoundingClientRect = () => boxOf({ top: 200, height: 400, width: 500, left: 50 })
    Object.defineProperty(body, 'scrollHeight', { value: 5000 })
    Object.defineProperty(body, 'clientHeight', { value: 400 })
    Object.defineProperty(body, 'scrollWidth', { value: 3000 })
    Object.defineProperty(body, 'clientWidth', { value: 500 })
    let innerTop = 0
    let innerLeft = 0
    Object.defineProperty(body, 'scrollTop', { get: () => innerTop, set: (value: number) => void (innerTop = value) })
    Object.defineProperty(body, 'scrollLeft', { get: () => innerLeft, set: (value: number) => void (innerLeft = value) })
    const text = document.createTextNode('very far needle')
    body.append(text)
    container.append(body)
    document.body.append(container)
    const range = document.createRange()
    range.setStart(text, 9)
    range.setEnd(text, 15)
    // 3,000 px down and 1,200 px to the right inside the code block, minus what the code block has scrolled.
    rangeBoxes.set(range, () => ({ top: 200 + 3000 - innerTop, left: 50 + 1200 - innerLeft, height: 20, width: 60 }))
    const writes: number[] = []
    bringIntoView(range, { container, onProgrammaticScroll: () => writes.push(transcriptTop) })
    const rect = range.getBoundingClientRect()
    // Inside the code block with the margin, vertically and horizontally.
    expect(rect.top).toBeGreaterThanOrEqual(200 + 16)
    expect(rect.bottom).toBeLessThanOrEqual(600 - 16)
    expect(rect.left).toBeGreaterThanOrEqual(50 + 16)
    expect(rect.right).toBeLessThanOrEqual(550 - 16)
    expect(innerTop).toBeGreaterThan(0)
    expect(innerLeft).toBeGreaterThan(0)
  })
})

describe('Ctrl/Cmd+F and the find bar', () => {
  let host: HTMLElement
  let root: Root
  let detach: () => void

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    useCommandRegistry.setState({ handlers: new Map(), recording: false, overlays: [] })
    useAppStore.setState({
      shortcuts: {},
      activeThreadId: 'thread-1',
      turnStates: {},
      mainAreaOpen: true,
      sidebarMode: 'projects',
      appInfo: { platform: 'win32', repoRoot: '', llmProvider: '' }
    })
    detach = attachCommandShortcuts(window)
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    detach()
  })

  const turns = Array.from({ length: 12 }, (_, i) =>
    turn(
      `k${i}`,
      user(`u${i}`, `question ${i}`),
      assistant(`a${i}`, i === 9 ? 'the zebra is here, and a second Zebra' : i === 2 || i === 5 ? `answer ${i} zebra` : `answer ${i}`)
    )
  )

  type Log = string[]

  /**
   * A transcript with a find bar. Rows are mounted only for `initiallyMounted`; the stand-in for the turn
   * window mounts a row when it is asked to land on it.
   */
  function Harness({ log, initiallyMounted, id = 'list' }: { log: Log; initiallyMounted: string[]; id?: string }) {
    const containerRef = useRef<HTMLDivElement>(null)
    const rowsRef = useRef<HTMLDivElement>(null)
    const [mounted, setMounted] = useState(() => new Set(initiallyMounted))
    const navigation = useRef(0)
    const virtualization = useMemo(
      () => ({
        beginNavigation: () => {
          const mine = ++navigation.current
          log.push('begin')
          return { token: mine, isCurrent: () => navigation.current === mine, end: () => void log.push('end') }
        },
        cancelNavigation: () => {
          navigation.current += 1
          log.push('cancel')
        },
        scrollToKey: async (key: string, target: { align: string }) => {
          log.push(`scrollToKey:${key}:${target.align}`)
          setMounted((previous) => new Set(previous).add(key))
          return true
        }
      }),
      [log]
    )
    const find = useThreadFind({
      enabled: true,
      turns,
      isStreaming: false,
      containerRef,
      rowsRef,
      virtualization: virtualization as never,
      onNavigate: () => void log.push('navigate'),
      onProgrammaticScroll: () => undefined
    })
    return createElement(
      'section',
      { 'data-list': id },
      createElement('textarea', { 'data-testid': `composer-${id}` }),
      createElement(
        'div',
        { ref: containerRef, 'data-testid': `container-${id}` },
        createElement('button', { 'data-testid': `inside-${id}` }, 'inside'),
        createElement(
          'div',
          { ref: rowsRef },
          turns
            .filter((t) => mounted.has(t.key))
            .map((t) =>
              createElement(
                'div',
                { key: t.key, 'data-turn-key': t.key },
                [t.userMsg!, ...t.assistantMsgs].map((m) =>
                  createElement('p', { key: m.id, 'data-find-text': '', 'data-message-id': m.id, 'data-part-index': m.role === 'user' ? 0 : 0 }, (m.parts as { text: string }[])[0]!.text)
                )
              )
            )
        )
      ),
      find.barProps ? createElement(FindInThreadBar, find.barProps) : null
    )
  }

  const wait = (ms = 8) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))))
  async function until(condition: () => boolean, label: string) {
    for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) await wait()
    expect(condition(), label).toBe(true)
  }

  function render(...harnesses: ReturnType<typeof createElement>[]) {
    act(() => root.render(createElement('div', null, ...harnesses)))
  }

  function press(target: Element, init: KeyboardEventInit & { key: string }): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    act(() => void target.dispatchEvent(event))
    return event
  }
  const ctrlF = { key: 'f', code: 'KeyF', ctrlKey: true }

  const bar = () => document.querySelector<HTMLElement>('[role="search"]')
  const input = () => document.querySelector<HTMLInputElement>('input[aria-label="Find in thread"]')!
  const count = () => document.querySelector('.chat-find-count')?.textContent
  function type(value: string) {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value)
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const composer = (id = 'list') => document.querySelector<HTMLTextAreaElement>(`[data-testid="composer-${id}"]`)!

  it('opens the bar from the composer with Ctrl+F, focuses the field, and Escape returns focus to the composer', async () => {
    render(createElement(Harness, { log: [], initiallyMounted: ['k0', 'k1'] }))
    composer().focus()
    const event = press(composer(), ctrlF)
    expect(event.defaultPrevented).toBe(true)
    expect(bar()).not.toBeNull()
    await until(() => document.activeElement === input(), 'the field has focus')
    press(input(), { key: 'Escape' })
    expect(bar()).toBeNull()
    expect(document.activeElement).toBe(composer())
  })

  it('returns focus to the element that had it, and to the composer when nothing did', async () => {
    const other = document.createElement('button')
    document.body.append(other)
    const log: Log = []
    render(createElement(Harness, { log, initiallyMounted: ['k0'] }))
    registerCommand('composer.focus', { run: () => composer().focus() })
    other.focus()
    press(other, ctrlF)
    await until(() => document.activeElement === input(), 'field focused')
    press(input(), { key: 'Escape' })
    expect(document.activeElement).toBe(other)

    ;(document.activeElement as HTMLElement).blur()
    expect(runCommand('chat.findInThread', 'palette')).toBe(true)
    await until(() => document.activeElement === input(), 'field focused again')
    press(input(), { key: 'Escape' })
    expect(document.activeElement).toBe(composer())
  })

  it('selects the field text when Ctrl+F is pressed again while the bar is open', async () => {
    render(createElement(Harness, { log: [], initiallyMounted: ['k0'] }))
    press(document.body, ctrlF)
    await until(() => document.activeElement === input(), 'field focused')
    type('zebra')
    press(input(), ctrlF)
    await wait()
    expect(input().selectionStart).toBe(0)
    expect(input().selectionEnd).toBe(5)
  })

  it('does not take the key inside a terminal, Monaco or a page with its own find, and leaves the key alone there', () => {
    render(createElement(Harness, { log: [], initiallyMounted: ['k0'] }))
    const terminal = document.createElement('div')
    terminal.className = 'xterm'
    terminal.innerHTML = '<textarea></textarea>'
    const monaco = document.createElement('div')
    monaco.className = 'monaco-editor'
    monaco.innerHTML = '<textarea></textarea>'
    const own = document.createElement('div')
    own.setAttribute('data-find-own', '')
    own.innerHTML = '<input />'
    document.body.append(terminal, monaco, own)
    for (const wrapper of [terminal, monaco, own]) {
      const field = wrapper.firstElementChild as HTMLElement
      field.focus()
      const event = press(field, ctrlF)
      expect(event.defaultPrevented, wrapper.className || 'data-find-own').toBe(false)
      expect(bar()).toBeNull()
    }
    expect(focusOwnsFind(monaco.firstElementChild)).toBe(true)
    expect(focusOwnsFind(composer())).toBe(false)
  })

  it('does not take the key while the command palette, thread search or a dialog owns the keyboard', () => {
    render(createElement(Harness, { log: [], initiallyMounted: ['k0'] }))
    for (const scope of ['palette', 'thread-search', 'modal'] as const) {
      const pop = pushOverlay(scope)
      expect(press(composer(), ctrlF).defaultPrevented, scope).toBe(false)
      expect(bar()).toBeNull()
      pop()
    }
    expect(press(composer(), ctrlF).defaultPrevented).toBe(true)
  })

  it('does not register the command without a thread, and Mod+K keeps opening the palette', () => {
    useAppStore.setState({ activeThreadId: null })
    render(createElement(Harness, { log: [], initiallyMounted: ['k0'] }))
    expect(press(document.body, ctrlF).defaultPrevented).toBe(false)
    expect(bar()).toBeNull()
    const palette = vi.fn()
    registerCommand('palette.open', { run: palette })
    expect(press(document.body, { key: 'k', code: 'KeyK', ctrlKey: true }).defaultPrevented).toBe(true)
    expect(palette).toHaveBeenCalledTimes(1)
  })

  it('counts the matches, and Enter and Shift+Enter step through them with wrap-around', async () => {
    const log: Log = []
    render(createElement(Harness, { log, initiallyMounted: turns.map((t) => t.key) }))
    press(document.body, ctrlF)
    await until(() => document.activeElement === input(), 'field focused')
    type('zebra')
    // k2, k5 and two in k9, across mounted and (here) all-mounted turns.
    await until(() => count() === '1 of 4', 'count after typing')
    press(input(), { key: 'Enter' })
    await until(() => count() === '2 of 4', 'next')
    press(input(), { key: 'Enter' })
    press(input(), { key: 'Enter' })
    await until(() => count() === '4 of 4', 'fourth')
    press(input(), { key: 'Enter' })
    await until(() => count() === '1 of 4', 'wraps forward')
    press(input(), { key: 'Enter', shiftKey: true })
    await until(() => count() === '4 of 4', 'wraps backward')
    type('Zebra is')
    await until(() => count() === '1 of 1', 'case-insensitive phrase')
    type('no such text')
    await until(() => count() === 'No matches', 'no matches')
    expect(document.querySelectorAll('button[aria-label="Next match"]:disabled')).toHaveLength(1)
    type('')
    await until(() => count() === '', 'empty field shows no count')
  })

  it('lands on a match in a turn that is not mounted, through the turn window, and paints it as the active match', async () => {
    const highlights = new Map<string, { ranges: Range[]; priority: number }>()
    ;(globalThis as { CSS?: unknown }).CSS = { highlights }
    ;(globalThis as { Highlight?: unknown }).Highlight = class {
      ranges: Range[]
      priority = 0
      constructor(...ranges: Range[]) {
        this.ranges = ranges
      }
    }
    try {
      const log: Log = []
      // Only the first two turns are mounted; the first match is in k2, the last two in k9.
      render(createElement(Harness, { log, initiallyMounted: ['k0', 'k1'] }))
      press(document.body, ctrlF)
      await until(() => document.activeElement === input(), 'field focused')
      type('zebra')
      await until(() => count() === '1 of 4', 'index covers unmounted turns')
      await until(() => log.includes('scrollToKey:k2:start'), 'lands on turn k2 through the turn window')
      await until(() => document.querySelector('[data-turn-key="k2"]') !== null, 'k2 mounted')
      await until(() => (highlights.get('mousse-find-active')?.ranges.length ?? 0) === 1, 'active match painted')
      expect(highlights.get('mousse-find-active')!.ranges[0]!.toString()).toBe('zebra')
      expect(log.indexOf('navigate')).toBeGreaterThanOrEqual(0)

      // A match further away: also not mounted.
      press(input(), { key: 'Enter' })
      press(input(), { key: 'Enter' })
      await until(() => count() === '3 of 4', 'third')
      await until(() => log.includes('scrollToKey:k9:start'), 'lands on turn k9')
      await until(() => document.querySelector('[data-turn-key="k9"]') !== null, 'k9 mounted')
      // Already mounted, the second occurrence in k9 needs no landing.
      const landings = log.filter((entry) => entry.startsWith('scrollToKey')).length
      press(input(), { key: 'Enter' })
      await until(() => count() === '4 of 4', 'fourth')
      await wait(30)
      expect(log.filter((entry) => entry.startsWith('scrollToKey')).length).toBe(landings)
    } finally {
      delete (globalThis as { CSS?: unknown }).CSS
      delete (globalThis as { Highlight?: unknown }).Highlight
    }
  })

  it('closing the bar cancels a landing and clears the highlights', async () => {
    const highlights = new Map<string, unknown>()
    ;(globalThis as { CSS?: unknown }).CSS = { highlights }
    ;(globalThis as { Highlight?: unknown }).Highlight = class {
      priority = 0
      constructor(..._ranges: Range[]) {}
    }
    try {
      const log: Log = []
      render(createElement(Harness, { log, initiallyMounted: ['k2'] }))
      press(document.body, ctrlF)
      await until(() => document.activeElement === input(), 'field focused')
      type('zebra')
      await until(() => highlights.has('mousse-find'), 'painted')
      press(input(), { key: 'Escape' })
      expect(log).toContain('cancel')
      await until(() => highlights.size === 0, 'highlights cleared')
    } finally {
      delete (globalThis as { CSS?: unknown }).CSS
      delete (globalThis as { Highlight?: unknown }).Highlight
    }
  })

  it('with two transcripts, Ctrl+F opens the bar of the one that has focus', async () => {
    render(createElement(Harness, { log: [], initiallyMounted: ['k0'], id: 'one' }), createElement(Harness, { log: [], initiallyMounted: ['k0'], id: 'two' }))
    const inside = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="inside-${id}"]`)!
    inside('one').focus()
    press(inside('one'), ctrlF)
    expect(document.querySelectorAll('[role="search"]')).toHaveLength(1)
    expect(document.querySelector('[data-list="one"] [role="search"]')).not.toBeNull()
    press(input(), { key: 'Escape' })
    inside('two').focus()
    press(inside('two'), ctrlF)
    expect(document.querySelector('[data-list="two"] [role="search"]')).not.toBeNull()
    expect(document.querySelector('[data-list="one"] [role="search"]')).toBeNull()
    // Focus outside both: the last one mounted that is showing.
    press(input(), { key: 'Escape' })
    ;(document.activeElement as HTMLElement).blur()
    press(document.body, ctrlF)
    expect(document.querySelector('[data-list="two"] [role="search"]')).not.toBeNull()
  })
})

describe('choosing a transcript for the shortcut', () => {
  const controller = (container: HTMLElement | null, visible = true) => ({
    container: () => container,
    open: vi.fn(),
    // `checkVisibility` is what the picker asks of the container.
    visible
  })

  it('prefers the transcript that holds focus, else the last visible one', () => {
    const a = document.createElement('div')
    const b = document.createElement('div')
    const c = document.createElement('div')
    const inA = document.createElement('input')
    a.append(inA)
    for (const element of [a, b, c]) element.checkVisibility = () => element !== c
    const list = [controller(a), controller(b), controller(c, false)]
    expect(pickFindController(list, inA)).toBe(list[0])
    expect(pickFindController(list, document.body)).toBe(list[1])
    expect(pickFindController([controller(null)], null)).toBeNull()
  })
})
