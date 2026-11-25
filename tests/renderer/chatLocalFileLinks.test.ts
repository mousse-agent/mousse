// @vitest-environment jsdom
/**
 * A link to a local file in an agent's reply is a link that opens the file in the Files panel: a path relative to the
 * thread's folder (the Files panel resolves it against the thread), an absolute path, a Windows path written with `\`
 * or `/`, and a `file:` URL, each with an optional line and column. None of them shows as "[blocked]". Dangerous
 * schemes stay plain text, and a fenced example stays exactly as written.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Markdown, type MarkdownImages } from '../../src/renderer/chat/components/agent-elements/markdown'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let opened: unknown[]
const record = (event: Event) => { opened.push((event as CustomEvent).detail) }

beforeEach(() => {
  opened = []
  window.addEventListener('mousse:open-file', record)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.removeEventListener('mousse:open-file', record)
})

// A bot's chat renders its Markdown with an image rule, which takes its own plugin list.
const imageRule: MarkdownImages = { Image: () => null }

function show(content: string, images?: MarkdownImages): void {
  act(() => root.render(createElement(Markdown, { content, images })))
}

/** Clicks the reply's only link and returns what it asked the Files panel to open. */
function clickLink(): unknown {
  const links = host.querySelectorAll('a')
  expect(links, host.innerHTML).toHaveLength(1)
  act(() => { links[0]!.click() })
  return opened.at(-1)
}

describe('a local file link in an agent reply', () => {
  // How agents write local file links. Each opens the file (line and column when given), never "[blocked]".
  const cases: Array<[written: string, opens: { path: string; line?: number; column?: number }]> = [
    ['[app.ts](src/app.ts)', { path: 'src/app.ts' }],
    ['[app.ts](./src/app.ts:42)', { path: './src/app.ts', line: 42 }],
    ['[app.ts](../lib/app.ts#L42)', { path: '../lib/app.ts', line: 42 }],
    ['[app.ts](src/app.ts#L42C7)', { path: 'src/app.ts', line: 42, column: 7 }],
    ['[app.ts](docs/my%20app.ts)', { path: 'docs/my app.ts' }],
    ['[app.ts](/Users/me/app.ts:42)', { path: '/Users/me/app.ts', line: 42 }],
    ['[app.ts](C:/Users/me/app.ts:42:7)', { path: 'C:/Users/me/app.ts', line: 42, column: 7 }],
    ['[app.ts](C:\\Users\\me\\app.ts)', { path: 'C:\\Users\\me\\app.ts' }],
    ['[app.ts](C:\\Users\\me\\app.ts:42)', { path: 'C:\\Users\\me\\app.ts', line: 42 }],
    ['[app.ts](<C:\\Users\\me\\my app.ts>)', { path: 'C:\\Users\\me\\my app.ts' }],
    ['[app.ts](file:///C:/Users/me/app.ts)', { path: 'C:/Users/me/app.ts' }],
    ['[app.ts](file:///C:/Users/me/my%20app.ts#L42)', { path: 'C:/Users/me/my app.ts', line: 42 }],
    ['[app.ts](file:///home/me/app.ts:42:7)', { path: '/home/me/app.ts', line: 42, column: 7 }],
    ['[app.ts](file://localhost/home/me/app.ts)', { path: '/home/me/app.ts' }],
    ['[app.ts](file:///home/me/app.ts#L10-L20)', { path: '/home/me/app.ts', line: 10 }],
    ['[app.ts](file:///home/me/app.ts#L10C3-L20C8)', { path: '/home/me/app.ts', line: 10, column: 3 }],
    ['[app.ts](/home/me/app.ts:42-50)', { path: '/home/me/app.ts', line: 42 }],
    ['[app.ts](src/app.ts:42:7-50:12)', { path: 'src/app.ts', line: 42, column: 7 }],
    ['[app.ts](C:\\Users\\me\\app.ts:42-50)', { path: 'C:\\Users\\me\\app.ts', line: 42 }],
    ['[`app.ts`](src/app.ts:42)', { path: 'src/app.ts', line: 42 }],
  ]

  it.each(cases.flatMap(([written, opens]) => [
    [written, 'a thread', opens, undefined],
    [written, "a bot's chat", opens, imageRule],
  ] as const))('%s opens the file in %s', (written, _where, opens, images) => {
    show(`See ${written} for details.`, images)
    expect(host.textContent).not.toContain('[blocked]')
    expect(host.querySelector('a')?.textContent).toContain('app.ts')
    const detail = clickLink() as Record<string, unknown>
    expect({ path: detail.path, line: detail.line, column: detail.column }).toEqual({ line: undefined, column: undefined, ...opens })
  })

  it('opens a link written as raw HTML the same way', () => {
    show('See <a href="C:\\Users\\me\\app.ts">app.ts</a>.')
    expect(host.textContent).not.toContain('[blocked]')
    expect((clickLink() as { path: string }).path).toBe('C:\\Users\\me\\app.ts')
  })

  // A file URL on another computer would reach out to that host when opened.
  it.each([
    '[run](javascript:alert(1))',
    '[run](JaVaScRiPt:alert(1))',
    '[run](vbscript:msgbox(1))',
    '[run](data:text/html,<script>alert(1)</script>)',
    '[share](file://server/share/app.ts)',
  ])('%s stays text that opens nothing', (written) => {
    show(written)
    expect(host.querySelector('a')).toBeNull()
    expect(host.innerHTML).not.toMatch(/javascript:|vbscript:|data:text|file:\/\/server/i)
  })

  it('keeps a fenced example exactly as written', () => {
    const code = '[app.ts](C:\\Users\\me\\app.ts) [b](file:///C:/x.ts) mousse-file://open?path=x\nsrc/app.ts:42'
    show(`\`\`\`text\n${code}\n\`\`\``)
    expect(host.querySelector('pre')?.textContent).toBe(code)
    expect(host.querySelector('a')).toBeNull()
  })

  // Inline code file paths written by Claude/Codex (`src/app.ts:42`, `.github/workflows/ci.yml`, Windows/POSIX paths)
  // open the file at its starting line while keeping inline code formatting.
  const inlineCodeCases: Array<[code: string, opens: { path: string; line?: number; column?: number }]> = [
    ['`src/app.ts`', { path: 'src/app.ts' }],
    ['`src/app.ts:42`', { path: 'src/app.ts', line: 42 }],
    ['`src/app.ts:42:7`', { path: 'src/app.ts', line: 42, column: 7 }],
    ['`src/app.ts:42-50`', { path: 'src/app.ts', line: 42 }],
    ['`src/app.ts#L42-L50`', { path: 'src/app.ts', line: 42 }],
    ['`src/app.ts#L42C3-L50C9`', { path: 'src/app.ts', line: 42, column: 3 }],
    ['`.agents/skills/work/SKILL.md`', { path: '.agents/skills/work/SKILL.md' }],
    ['`./src/app.d.ts:12`', { path: './src/app.d.ts', line: 12 }],
    ['`../lib/app.ts`', { path: '../lib/app.ts' }],
    ['`/home/me/repo/src/app.ts:1331`', { path: '/home/me/repo/src/app.ts', line: 1331 }],
    ['`C:\\repo\\src\\app.ts:42:7`', { path: 'C:\\repo\\src\\app.ts', line: 42, column: 7 }],
    ['`C:/repo/src/app.ts#L10-L20`', { path: 'C:/repo/src/app.ts', line: 10 }],
  ]

  it.each(inlineCodeCases)('inline code %s opens the file when clicked', (code, opens) => {
    show(`Updated ${code} to handle ranges.`)
    expect(host.textContent).not.toContain('[blocked]')
    const link = host.querySelector('a')
    expect(link?.querySelector('code')?.textContent).toBe(code.slice(1, -1))
    const detail = clickLink() as Record<string, unknown>
    expect({ path: detail.path, line: detail.line, column: detail.column }).toEqual({ line: undefined, column: undefined, ...opens })
  })

  it.each([
    '`node scripts/verify.mjs`',
    '`and/or`',
    '`2026/11/24`',
    '`v1.0/v2.0`',
    '`@types/node`',
    '`application/vnd.ms-excel`',
    '`text/html`',
    '`src/**/*.test.ts`',
    '`src/<name>.ts`',
    '`https://example.com/a.ts`',
    '`file:///etc/passwd`',
    '`example.com/index.html`',
    '`App.tsx:30`',
    '`C:\\dir\\`',
    '`~/package.json`',
  ])('inline code %s stays plain code instead of becoming a file link', (code) => {
    show(`See ${code}.`)
    expect(host.querySelector('a')).toBeNull()
    expect(host.querySelector('code')?.textContent).toBe(code.slice(1, -1))
  })

  it('does not double-wrap inline code that is already inside a web link', () => {
    show('See [`src/app.ts`](https://github.com/acme/repo/blob/main/src/app.ts).')
    const links = host.querySelectorAll('a')
    expect(links).toHaveLength(1)
    expect(links[0]!.getAttribute('href')).toBe('https://github.com/acme/repo/blob/main/src/app.ts')
    expect(links[0]!.querySelector('a')).toBeNull()
  })
})
