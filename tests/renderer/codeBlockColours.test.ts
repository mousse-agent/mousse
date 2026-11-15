// @vitest-environment jsdom
/**
 * Code blocks draw a line as one text node until the block comes near the viewport; then runs of one colour become
 * spans with a shared colour class (code-block.tsx, code-colours.ts). jsdom has no layout and no
 * IntersectionObserver: the observer is stood in for and a test says which blocks are near. How the colours look is
 * checked in the app (see the PR).
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Markdown } from '../../src/renderer/chat/components/agent-elements/markdown'
import { colourRuns } from '../../src/renderer/chat/components/agent-elements/code-colours'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Stands in for the one IntersectionObserver the blocks share. */
class FakeObserver {
  static current: FakeObserver | null = null
  targets = new Set<Element>()
  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeObserver.current = this
  }
  observe(target: Element) { this.targets.add(target) }
  unobserve(target: Element) { this.targets.delete(target) }
  disconnect() { this.targets.clear() }
  report(target: Element, near: boolean) {
    this.callback([{ target, isIntersecting: near } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}

const saved: Record<string, PropertyDescriptor | undefined> = {}
beforeAll(() => {
  for (const name of ['IntersectionObserver', 'CSS']) saved[name] = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, writable: true, value: FakeObserver })
  Object.defineProperty(globalThis, 'CSS', { configurable: true, writable: true, value: {
    supports: (_property: string, value: string) => /^#[0-9a-f]{3,8}$/i.test(value),
    escape: (value: string) => value,
  } })
})
afterAll(() => {
  for (const [name, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete (globalThis as Record<string, unknown>)[name]
  }
})

let root: Root
let host: HTMLElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const CODE = ['const total = 1', '', 'function add(a: number) {', '  return a + total', '}'].join('\n')
const fence = (code: string, language = 'ts') => `Some text.\n\n\`\`\`${language}\n${code}\n\`\`\`\n`

function show(content: string, streaming = false) {
  act(() => root.render(createElement(Markdown, { content, streaming })))
}
const body = () => host.querySelector<HTMLElement>('[data-streamdown="code-block-body"]')!
const code = () => body().querySelector('code')!
const spans = () => Array.from(code().querySelectorAll('span'))
const near = (value: boolean) => act(() => FakeObserver.current!.report(body(), value))

/** A colour as the page's CSS reports it. */
function colour(value: string): string {
  const probe = document.createElement('i')
  probe.style.color = value
  return probe.style.color
}

/** The light-theme colour the page's rules give a class. */
function lightColour(name: string): string | undefined {
  const sheet = document.querySelector<HTMLStyleElement>('style[data-mousse-code-colours]')?.sheet
  for (const rule of Array.from(sheet?.cssRules ?? [])) {
    if (rule instanceof CSSStyleRule && rule.selectorText === `.${name}`) return rule.style.getPropertyValue('color')
  }
  return undefined
}

async function nearAndColoured() {
  near(true)
  await vi.waitFor(() => expect(spans().length).toBeGreaterThan(0), { timeout: 10_000 })
}

describe('a code block in a reply', () => {
  it('draws each line as one text node while it is away from the viewport', () => {
    show(fence(CODE))
    const nodes = Array.from(code().childNodes)
    expect(nodes.every((node) => node.nodeType === Node.TEXT_NODE)).toBe(true)
    expect(nodes.map((node) => (node as Text).data)).toEqual(['const total = 1\n', '\n', 'function add(a: number) {\n', '  return a + total\n', '}'])
  })

  it('near the viewport, colours runs of one colour with a shared class and no inline style', async () => {
    show(fence(CODE))
    await nearAndColoured()
    expect(code().textContent).toBe(CODE)
    for (const span of spans()) {
      expect(span.getAttribute('style')).toBeNull()
      expect(span.children).toHaveLength(0)
    }
    const keyword = spans().find((span) => span.textContent!.trim() === 'const')!
    const fn = spans().find((span) => span.textContent!.trim() === 'add')!
    // github-light: keywords red, function names purple. `function` shares the keyword's class.
    expect(lightColour(keyword.className)).toBe(colour('#d73a49'))
    expect(lightColour(fn.className)).toBe(colour('#6f42c1'))
    expect(spans().find((span) => span.textContent!.trim() === 'function')!.className).toBe(keyword.className)
    // Fewer spans than tokens: `return a + total` is one keyword, then plain and operator runs, not a span per token.
    expect(spans().length).toBeLessThan(CODE.split(/\s+/).length * 2)
  })

  it('stays coloured once it has been near the viewport, and stops watching it', async () => {
    show(fence(CODE))
    await nearAndColoured()
    const count = spans().length
    expect(FakeObserver.current!.targets.has(body())).toBe(false)
    // A late report from the observer changes nothing: the lines are not drawn again.
    near(false)
    expect(spans()).toHaveLength(count)
    expect(code().textContent).toBe(CODE)
  })

  it('stops watching the viewport when it unmounts before it was near', async () => {
    show(fence(CODE))
    const watched = body()
    expect(FakeObserver.current!.targets.has(watched)).toBe(true)
    act(() => root.render(createElement(Markdown, { content: 'Only prose now.' })))
    expect(FakeObserver.current!.targets.has(watched)).toBe(false)
  })

  it('colours a long block\'s first lines, and more as it is scrolled', async () => {
    const long = Array.from({ length: 200 }, (_, index) => `const line${index} = ${index}`).join('\n')
    show(fence(long))
    await nearAndColoured()
    const colouredLines = () => new Set(spans().map((span) => /line(\d+)/.exec(span.textContent!)?.[1]).filter(Boolean).map(Number))
    expect(Math.max(...colouredLines())).toBeLessThan(80)
    // jsdom has no layout: give the box the scroll a reader made, 150 lines down.
    Object.defineProperty(body(), 'clientHeight', { configurable: true, value: 640 })
    body().scrollTop = 150 * 18
    act(() => body().dispatchEvent(new Event('scroll')))
    expect(Math.max(...colouredLines())).toBe(199)
    expect(code().textContent).toBe(long)
  })

  it('shows every streamed delta at once and colours it once tokenised', async () => {
    let text = 'const first = 1'
    show(`Some text.\n\n\`\`\`ts\n${text}`, true)
    near(true)
    for (let index = 0; index < 12; index++) {
      text += index % 3 === 0 ? `\nconst line${index} = ${index}` : ` + ${index}`
      show(`Some text.\n\n\`\`\`ts\n${text}`, true)
      expect(code().textContent).toBe(text)
    }
    show(fence(text))
    near(true)
    await vi.waitFor(() => expect(spans().some((span) => span.textContent!.trim() === 'line9')).toBe(true), { timeout: 10_000 })
    expect(code().textContent).toBe(text)
  })
})

describe('colourRuns', () => {
  const token = (content: string, color?: string, dark?: string) =>
    ({ content, offset: 0, htmlStyle: color ? { color, '--shiki-dark': dark ?? color } : {}, color: color ? undefined : 'inherit' }) as never

  const rows: Array<[string, Parameters<typeof colourRuns>[0], string, Array<[number, number, string]> | null]> = [
    ['one run per colour', [token('a', '#111'), token('b', '#222')], 'ab', [[0, 1, '#111'], [1, 2, '#222']]],
    ['neighbours of one colour merge', [token('a', '#111'), token('b', '#111')], 'ab', [[0, 2, '#111']]],
    ['whitespace joins the run before it', [token('a', '#111'), token(' ', '#222'), token('b', '#111')], 'a b', [[0, 3, '#111']]],
    ['leading whitespace is left out', [token('  ', '#222'), token('a', '#111')], '  a', [[2, 3, '#111']]],
    ['plain text gets no run', [token('a', '#111'), token('b')], 'ab', [[0, 1, '#111']]],
    ['the dark colour keeps runs apart', [token('a', '#111', '#eee'), token('b', '#111', '#ddd')], 'ab', [[0, 1, '#111'], [1, 2, '#111']]],
    ['tokens of another text colour nothing', [token('a', '#111')], 'b', null],
    ['tokens shorter than the text colour nothing', [token('a', '#111')], 'ab', null],
  ]

  it.each(rows)('%s', (_name, line, text, expected) => {
    const runs = colourRuns(line, text)
    expect(runs?.map((run) => [run.start, run.end, run.style.light]) ?? null).toEqual(expected)
  })
})
