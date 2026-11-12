// @vitest-environment jsdom
import { act, createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolRenderer } from '../../src/renderer/chat/components/agent-elements/tools/tool-renderer'
import { BashTool } from '../../src/renderer/chat/components/agent-elements/tools/bash-tool'
import { toolIconFor } from '../../src/renderer/chat/components/agent-elements/tools/tool-icon'
import { ClipboardList, FilePlus, FileText, FolderSearch, Globe, Pencil, Plug, Search, Terminal, Wrench } from '../../src/renderer/lib/icons'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const render = (part: Record<string, unknown>, chatStatus?: string) => act(() => root.render(createElement(ToolRenderer, { part, chatStatus })))
const text = () => host.textContent?.replace(/\s+/g, ' ').trim() ?? ''
/** The drawing of an icon: its paths, whatever classes it was given. */
const shape = (svg: Element | string | null | undefined): string => {
  const markup = typeof svg === 'string' ? svg : svg?.outerHTML ?? ''
  return [...markup.matchAll(/ d="([^"]+)"/g)].map((match) => match[1]).join('|')
}
const drawingOf = (Icon: ComponentType<{ size?: number }>) => shape(renderToStaticMarkup(createElement(Icon, { size: 18 })))
const rowIcon = () => host.querySelector('.an-tool-icon')

describe('the icon of each tool', () => {
  it.each([
    ['tool-Bash', Terminal],
    ['tool-Read', FileText],
    ['tool-Write', FilePlus],
    ['tool-Edit', Pencil],
    ['tool-MultiEdit', Pencil],
    ['tool-Grep', Search],
    ['tool-Glob', FolderSearch],
    ['tool-WebFetch', Globe],
    ['tool-WebSearch', Globe],
    ['tool-TodoWrite', ClipboardList],
    ['tool-ToolSearch', Plug],
    ['tool-mcp__tracker__search_issues', Plug],
    ['tool-SomethingNew', Wrench],
  ] as const)('%s', (type, Icon) => {
    expect(toolIconFor(type)).toBe(Icon)
  })

  it.each([
    ['a command', { type: 'tool-Bash', input: { command: 'npm test' } }, Terminal],
    ['a read', { type: 'tool-Read', input: { file_path: 'src/app.ts' } }, FileText],
    ['an edit', { type: 'tool-Edit', input: { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' } }, Pencil],
    ['a new file', { type: 'tool-Write', input: { file_path: 'src/new.ts', content: 'x' } }, FilePlus],
    ['a code search', { type: 'tool-Grep', input: { pattern: 'cache' } }, Search],
    ['a file search', { type: 'tool-Glob', input: { pattern: '**/*.ts' } }, FolderSearch],
    ['a web search', { type: 'tool-WebSearch', input: { query: 'stale cache' } }, Globe],
    ['a page fetch', { type: 'tool-WebFetch', input: { url: 'https://example.com/a' } }, Globe],
    ['a to-do list', { type: 'tool-TodoWrite', input: { todos: [{ content: 'Read', status: 'completed' }, { content: 'Fix', status: 'pending' }] } }, ClipboardList],
    ['an MCP tool', { type: 'tool-mcp__tracker__search_issues', input: { query: 'crash' } }, Plug],
  ] as const)('%s row draws its icon, running then done', (_name, part, Icon) => {
    render({ ...part, toolCallId: 't1', state: 'input-available' }, 'streaming')
    expect(rowIcon()?.getAttribute('data-state')).toBe('running')
    expect(shape(rowIcon()?.querySelector('svg'))).toBe(drawingOf(Icon))
    render({ ...part, toolCallId: 't1', state: 'output-available', output: part.type === 'tool-Bash' ? { stdout: 'ok', exitCode: 0 } : 'ok' })
    expect(rowIcon()?.getAttribute('data-state')).toBe('done')
    expect(shape(rowIcon()?.querySelector('svg'))).toBe(drawingOf(Icon))
  })

  it('a failed call keeps its own icon, in the danger colour', () => {
    for (const [type, Icon] of [['tool-Read', FileText], ['tool-Grep', Search], ['tool-mcp__tracker__search_issues', Plug], ['tool-Bash', Terminal]] as const) {
      render({ type, toolCallId: `f-${type}`, state: 'output-error', input: { file_path: 'a.ts', pattern: 'x', command: 'ls nope' } })
      expect(rowIcon()?.getAttribute('data-state')).toBe('failed')
      expect(shape(rowIcon()?.querySelector('svg'))).toBe(drawingOf(Icon))
      expect(text()).toMatch(/^Failed/)
    }
  })

  it('the thinking row keeps its own turning icon', () => {
    render({ type: 'tool-Thinking', toolCallId: 'th', state: 'input-available', input: { thought: 'Looking at the cache' } })
    expect(host.querySelector('svg.thinking-icon.is-thinking')).not.toBeNull()
    expect(rowIcon()).toBeNull()
  })
})

describe('the running icon', () => {
  it('pulses by opacity, and is still with motion off or reduced motion', async () => {
    const { readFileSync } = await import('node:fs')
    const css = readFileSync('src/renderer/chat/components/agent-elements/tools/tool-icon.css', 'utf8')
    expect(css).toMatch(/\.an-tool-icon\[data-state='running'\] \{\s*animation: an-tool-icon-pulse/)
    expect(css).toMatch(/@keyframes an-tool-icon-pulse \{[^}]*opacity/)
    expect(css).toMatch(/\[data-motion='off'\] \.an-tool-icon\[data-state='running'\] \{\s*animation: none !important;/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.an-tool-icon\[data-state='running'\] \{\s*animation: none !important;/)
    expect(css).toMatch(/\.an-tool-icon\[data-state='failed'\] \{\s*color: var\(--danger\);/)
  })
})

describe('a command', () => {
  const command = 'npm test -- --run tests/cache.test.ts'
  const output = 'Test Files  1 passed (1)\n     Tests  4 passed (4)'

  it('is one quiet line, collapsed, with no card around it', () => {
    render({ type: 'tool-Bash', toolCallId: 'b1', state: 'output-available', input: { command }, output: { stdout: output, exitCode: 0 } })
    const toggle = host.querySelector('button[aria-expanded]')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toBe(`Ran${command}`)
    expect(toggle.querySelector('.an-bash-row-command')?.getAttribute('title')).toBe(command)
    expect([...host.querySelectorAll('*')].some((node) => node.classList.contains('border'))).toBe(false)
    expect(host.innerHTML).not.toMatch(/an-bash-card|animate-spin/)
  })

  it('reads Running while it runs', () => {
    render({ type: 'tool-Bash', toolCallId: 'b1', state: 'input-available', input: { command } }, 'streaming')
    expect(host.querySelector('button[aria-expanded]')!.textContent).toBe(`Running${command}`)
  })

  it('opens to the full command and its output', () => {
    render({ type: 'tool-Bash', toolCallId: 'b1', state: 'output-available', input: { command }, output: { stdout: output, exitCode: 0, durationMs: 1200 } })
    act(() => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click())
    expect(host.querySelector('button[aria-expanded]')!.getAttribute('aria-expanded')).toBe('true')
    const body = host.querySelector('.an-bash-body')!
    expect(body.textContent).toContain(`$ ${command}`)
    expect(body.querySelector('.an-bash-output')!.textContent).toBe(output)
    expect(body.textContent).toContain('exit 0')
    expect(body.textContent).toContain('1.2s')
  })

  it('that failed reads Failed, with its exit code and its icon in the danger colour', () => {
    render({ type: 'tool-Bash', toolCallId: 'b1', state: 'output-error', input: { command: 'ls build' }, output: { stdout: 'ls: build: No such file or directory', exitCode: 1 } })
    const toggle = host.querySelector('button[aria-expanded]')!
    expect(toggle.textContent).toBe('Failedls buildexit 1')
    expect(rowIcon()!.getAttribute('data-state')).toBe('failed')
    expect(toggle.querySelector('.text-\\[var\\(--danger\\)\\]')?.textContent).toBe('Failed')
    act(() => (toggle as HTMLButtonElement).click())
    expect(host.querySelector('.an-bash-output')!.textContent).toBe('ls: build: No such file or directory')
  })

  it('waiting for approval keeps its approval buttons', () => {
    const onApprove = vi.fn()
    const onReject = vi.fn()
    act(() => root.render(createElement(BashTool, {
      part: { type: 'tool-Bash', toolCallId: 'b1', state: 'input-available', input: { command: 'rm -rf build', approval: { approveLabel: 'Run', rejectLabel: 'Skip', onApprove, onReject } } },
    })))
    const buttons = [...host.querySelectorAll('button')].map((button) => button.textContent)
    expect(buttons).toContain('Run')
    expect(buttons).toContain('Skip')
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Run')!.click())
    expect(onApprove).toHaveBeenCalledOnce()
    expect(text()).toContain('Approved')
  })
})

describe('a failure the agent got past', () => {
  const failedCommand = { type: 'tool-Bash', toolCallId: 'b1', state: 'output-error', input: { command: 'ls build' }, output: { stdout: 'ls: build: No such file or directory', exitCode: 1 } }
  const danger = () => host.querySelectorAll('.text-\\[var\\(--danger\\)\\]')

  it('only dims its icon toward red and adds a small ×; the label stays grey, with no red exit code', () => {
    render({ ...failedCommand, failureRecovered: true })
    const toggle = host.querySelector('button[aria-expanded]')!
    expect(rowIcon()!.getAttribute('data-state')).toBe('recovered')
    expect(toggle.querySelector('.an-tool-failed-mark')?.textContent).toBe('×')
    expect(toggle.textContent).toBe('Failedls build×')
    expect(danger()).toHaveLength(0)
    act(() => (toggle as HTMLButtonElement).click())
    // Opened, the output still ends on its red exit line.
    expect(host.querySelector('.an-bash-exit .text-\\[var\\(--danger\\)\\]')?.textContent).toBe('exit 1')
  })

  it('keeps any other tool quiet the same way', () => {
    render({ type: 'tool-Read', toolCallId: 'r1', state: 'output-error', input: { file_path: 'config.json' }, failureRecovered: true })
    expect(rowIcon()!.getAttribute('data-state')).toBe('recovered')
    expect(text()).toContain('Failed Read')
    expect(host.querySelector('.an-tool-failed-mark')).not.toBeNull()
    expect(danger()).toHaveLength(0)
  })

  it('stays clearly red when the failure ended the turn', () => {
    render(failedCommand)
    expect(rowIcon()!.getAttribute('data-state')).toBe('failed')
    expect(host.querySelector('.an-tool-failed-mark')).toBeNull()
    expect([...danger()].map((node) => node.textContent)).toEqual(['Failed', 'exit 1'])
  })

  it('dims the icon in the danger colour, lighter than a failure that ended the turn', async () => {
    const { readFileSync } = await import('node:fs')
    const css = readFileSync('src/renderer/chat/components/agent-elements/tools/tool-icon.css', 'utf8')
    expect(css).toMatch(/\.an-tool-icon\[data-state='recovered'\] \{\s*color: color-mix\(in srgb, var\(--danger\) 55%, transparent\);/)
  })
})

describe('the time of a work row', () => {
  const at = '2026-11-12T14:13:00'

  it('is on the row, at its right edge, from the time the call started', () => {
    render({ type: 'tool-Bash', toolCallId: 'b1', state: 'output-available', input: { command: 'npm test' }, output: { stdout: 'ok', exitCode: 0 }, createdAt: at })
    const time = host.querySelector('button[aria-expanded] .an-tool-row-line > .an-tool-row-time')!
    expect(time.textContent).toBe('2:13 PM')
    expect(time.getAttribute('dateTime')).toBe(new Date(at).toISOString())
    act(() => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click())
    expect(host.querySelectorAll('.an-tool-row-time')).toHaveLength(1)
  })

  it('shows on any row kind, and not at all without a start time', () => {
    render({ type: 'tool-Read', toolCallId: 'r1', state: 'output-available', input: { file_path: 'a.ts' }, createdAt: at })
    expect(host.querySelector('.an-tool-row-time')?.textContent).toBe('2:13 PM')
    render({ type: 'tool-Read', toolCallId: 'r1', state: 'output-available', input: { file_path: 'a.ts' } })
    expect(host.querySelector('.an-tool-row-time')).toBeNull()
  })

  it('fades in on hover or keyboard focus, in quiet meta text', async () => {
    const { readFileSync } = await import('node:fs')
    const css = readFileSync('src/renderer/chat/components/agent-elements/tools/tool-icon.css', 'utf8')
    expect(css).toMatch(/\.an-tool-row-time \{[^}]*margin-left: auto;[^}]*font-size: 12px;[^}]*opacity: 0;[^}]*transition: opacity/)
    expect(css).toMatch(/\.an-tool-row-line:hover \.an-tool-row-time,\s*:focus-visible > \.an-tool-row-line \.an-tool-row-time/)
  })
})
