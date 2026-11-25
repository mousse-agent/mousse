// @vitest-environment jsdom
/**
 * The live line under a running turn's Working (turn-progress.tsx): every phase of a turn shows a
 * specific, non-empty line, or a header that says what the turn waits for.
 */
import { readFileSync } from 'node:fs'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { markRecoveredFailures } from '../../src/renderer/chat/adapters/mousseToUI'
import { setReplyPacing } from '../../src/renderer/lib/replyPacingSetting'
import {
  TurnProgressContext,
  describeTurnProgress,
  stepSeenAt,
  type TurnProgressState
} from '../../src/renderer/chat/components/agent-elements/turn-progress'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const realMatchMedia = window.matchMedia
const realResizeObserver = globalThis.ResizeObserver

beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {}
  })) as unknown as typeof window.matchMedia
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  // Words show as they come; the test of a paced reply turns pacing on itself.
  setReplyPacing(false)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.matchMedia = realMatchMedia
  globalThis.ResizeObserver = realResizeObserver
  vi.useRealTimers()
  setReplyPacing(true)
})

type Status = 'ready' | 'submitted' | 'streaming'
const NOW = Date.parse('2026-11-11T10:00:00Z')
const createdAt = new Date(NOW - 4000).toISOString()

const ask = (id = 'u1', text = 'Fix the failing test', metadata?: Record<string, unknown>): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text }], createdAt, ...(metadata ? { metadata } : {}) }) as unknown as UIMessage
const reply = (id: string, ...parts: unknown[]): UIMessage => ({ id, role: 'assistant', parts, createdAt } as unknown as UIMessage)
const text = (value: string) => ({ type: 'text', text: value })
const tool = (name: string, state: string, input: Record<string, unknown> = {}, id = `call-${name}-${state}`) =>
  ({ type: `tool-${name}`, toolCallId: id, state, input, ...(state === 'output-available' ? { output: { stdout: 'ok' } } : {}) })
const thought = (state: 'input-available' | 'output-available', content = '') =>
  ({ type: 'tool-Thinking', toolCallId: `thought-${state}`, state, input: { thought: content }, ...(state === 'output-available' ? { output: content } : {}) })

function render(messages: UIMessage[], status: Status, state: TurnProgressState | null) {
  act(() => root.render(createElement(TurnProgressContext.Provider, { value: state }, createElement(MessageList, { messages, status }))))
}

/** The last turn's header, its live row, and the row's line saying what the turn does now. */
const header = () => [...host.querySelectorAll<HTMLElement>('.turn-work-label')].at(-1)?.textContent ?? null
const liveRow = () => host.querySelector<HTMLElement>('[data-turn-live]')
/** The live row's first line: the headline of the current run's thought. */
const headline = () => liveRow()?.querySelector('.turn-live-headline')?.textContent ?? null
const line = () => host.querySelector<HTMLElement>('[data-turn-progress]')
/**
 * The live row shows nothing: hidden, or, with reply pacing, saying "Writing…" right under reply text that is on
 * screen, which turn-progress.css hides (\`data-until-text\`).
 */
const rowQuiet = () => {
  const row = liveRow()!
  return row.hidden || (row.dataset.untilText !== undefined && Boolean(row.previousElementSibling?.querySelector('.an-markdown')))
}
/** The line's label; what a running call works on follows it, dim (`.turn-progress-detail`). */
const lineText = () => line()?.querySelector('.turn-progress-label')?.textContent ?? ''
const lineDetail = () => line()?.querySelector('.turn-progress-detail')?.textContent ?? null
/** Reasoning rows and groups of thoughts in the last turn, not the rows inside a group: their header buttons. A group
 * of calls titled by a thought shows the thinking icon too, with what its calls did after a "·"; it is not one. */
const reasoningRows = () => [...host.querySelectorAll<HTMLButtonElement>('.turn-answer button[aria-expanded]')].filter((button) => button.querySelector('svg.thinking-icon') && !button.closest('.an-tool-group-rows') && !button.textContent!.includes('·'))
const reasoningRow = (title: string) => {
  const row = reasoningRows().find((button) => button.textContent!.startsWith(title))
  if (!row) throw new Error(`no reasoning row ${title}: ${reasoningRows().map((button) => button.textContent).join(' | ')}`)
  return row
}
/** A group's header in the last turn, by the start of its title. */
const groupHeader = (title: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('.turn-answer button[aria-expanded]')].find((button) => !button.closest('.an-tool-group-rows') && button.textContent!.startsWith(title)) ?? null
/** The live reasoning rows (a thought being written), as their one line of text. */
const liveRows = () => [...host.querySelectorAll<HTMLElement>('.turn-answer svg.thinking-icon.is-thinking')]
  .filter((icon) => !icon.closest('[data-turn-progress]'))
  .map((icon) => (icon.closest('button') ?? icon.closest('.an-tool-chrome'))!.textContent!.replace(/\s+/g, ' ').trim().replace(/^Thinking(?=\S)/, 'Thinking '))

/** A running turn: its header says it works, and the line under it is non-empty. */
function expectLive(label: string | RegExp) {
  expect(header()).toMatch(/^Working/)
  expect(lineText()).not.toBe('')
  if (typeof label === 'string') expect(lineText()).toBe(label)
  else expect(lineText()).toMatch(label)
  // The live row ends the turn's answer, under the Working header; only its screen reader's status region follows it.
  const answer = line()!.closest('.turn-answer')!
  expect(answer.lastElementChild!.matches('[data-live-announce]')).toBe(true)
  expect(answer.lastElementChild!.previousElementSibling).toBe(liveRow())
  expect(answer.previousElementSibling?.classList.contains('turn-work')).toBe(true)
}

describe('the line under Working', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(NOW)
  })

  it('1. sent, before the service starts the turn: Starting…', () => {
    render([ask('optimistic:1')], 'ready', { phase: 'idle' })
    expectLive('Starting…')
    render([ask()], 'submitted', { phase: 'queued' })
    expectLive('Starting…')
  })

  it('1. an older service that still reports a wait for a free slot: the line of a turn not started yet', () => {
    render([ask()], 'submitted', { phase: 'queued', step: { kind: 'waiting_slot', running: 8, limit: 8 } as never })
    expectLive('Starting…')
  })

  it("1. a slow step of the turn's setup, before the agent starts: its name, with the thinking icon Starting… has", () => {
    for (const [what, label] of [
      ['worktree', 'Creating worktree…'],
      ['check', 'Checking worktree…'],
      ['restore', 'Restoring worktree…'],
      ['snapshot', 'Taking snapshot…']
    ] as const) {
      render([ask()], 'submitted', { phase: 'queued', step: { kind: 'preparing', what } })
      expectLive(label)
      expect(line()!.title).not.toBe('')
      expect(line()!.querySelector('svg.thinking-icon')).not.toBeNull()
    }
    // A step from a newer service this window does not know yet: the line of a turn not started yet.
    render([ask()], 'submitted', { phase: 'queued', step: { kind: 'preparing', what: 'something-new' } as never })
    expectLive('Starting…')
  })

  it('1. the runtime, its tools and Skills being set up: Starting…, what starts in the tooltip', () => {
    render([ask()], 'streaming', { phase: 'thinking', step: { kind: 'starting' } })
    expectLive('Starting…')
    expect(line()!.title).toBe('Starting the agent and its tools')
  })

  it('2. waiting for the first token: Thinking…, the wait in the tooltip', () => {
    render([ask()], 'streaming', { phase: 'thinking', step: { kind: 'waiting' } })
    expectLive('Thinking…')
    expect(line()!.title).toBe("Waiting for the model's first output")
  })

  it("the line is the thinking icon, turning, while the turn thinks, the running tool's icon while a tool runs, and the small dots for anything else", () => {
    for (const kind of ['starting', 'waiting', 'reasoning'] as const) {
      render([ask()], 'streaming', { phase: 'thinking', step: { kind } })
      expect(line()!.querySelector('svg.thinking-icon')?.classList.contains('is-thinking')).toBe(true)
      expect(line()!.querySelector('.turn-progress-dots')).toBeNull()
    }
    render([ask(), reply('c1', tool('Bash', 'input-available', { command: 'npm test' }))], 'streaming', { phase: 'tool_running' })
    expect(line()!.querySelector('svg.thinking-icon')).toBeNull()
    expect(line()!.querySelector('.turn-progress-dots')).toBeNull()
    expect(line()!.querySelector('.an-tool-icon[data-state="running"] svg')).not.toBeNull()
    for (const [messages, state] of [
      [[ask()], { phase: 'thinking', step: { kind: 'retrying', attempt: 1 } }],
      [[ask(), reply('c1', tool('Bash', 'input-available', { command: 'npm test' }))], { phase: 'tool_running', stopping: true }],
      [[ask(), reply('a1', text(''))], { phase: 'streaming' }]
    ] as Array<[UIMessage[], TurnProgressState]>) {
      render(messages, 'streaming', state)
      expect(line()!.querySelector('svg.thinking-icon')).toBeNull()
      expect(line()!.querySelectorAll('.turn-progress-dots > span')).toHaveLength(3)
    }
  })

  it('3. a thinking-only stretch, no text yet: Thinking…', () => {
    render([ask()], 'streaming', { phase: 'thinking', step: { kind: 'reasoning' } })
    expectLive('Thinking…')
  })

  it('3. a thought that streams: the live row shows its headline over Thinking…, and no row of its own', () => {
    render([ask(), reply('t1', thought('input-available', '**Reading the test**\n\nThe output says the'))], 'streaming', { phase: 'thinking' })
    expectLive('Thinking…')
    expect(headline()).toBe('Reading the test')
    // The newest paragraph whole is the headline's tooltip.
    expect(liveRow()!.querySelector<HTMLElement>('.turn-live-thought')!.title).toBe('The output says the')
    expect(liveRows()).toEqual([])
    expect(reasoningRows()).toHaveLength(0)
    // A screen reader hears that the turn is thinking, not each headline (tests/renderer/liveRowAnnouncements.test.ts).
    expect(liveRow()!.querySelector('[role="status"], [aria-live]')).toBeNull()
    expect(document.querySelector('[data-live-announce]')!.textContent).toBe('Thinking')
    render([ask(), reply('t1', thought('input-available', '**Reading the test**\n\nThe output says the reminder starts twice.'))], 'streaming', { phase: 'thinking' })
    expect(headline()).toBe('Reading the test')
  })

  it('3. a thought followed by text is done: its row is still and titled with its headline, and the live row has nothing to add', () => {
    const live = reply('t1', thought('input-available', '**Reading the test**\n\nIt starts both.'))
    render([ask(), live, reply('a1', text('The test is'))], 'streaming', { phase: 'streaming' })
    expect(reasoningRow('Reading the test').querySelector('svg.thinking-icon.is-thinking')).toBeNull()
    expect(rowQuiet()).toBe(true)
  })

  it('3. a long thought moves on paragraph by paragraph, one still line each, and a finished one shows its newest', () => {
    const long = `${'word '.repeat(300)}and the newest words`
    render([ask(), reply('t1', thought('input-available', long))], 'streaming', { phase: 'thinking' })
    // A first sentence still arriving shows its words so far, cut well before the row would grow.
    expect(Array.from(headline()!).length).toBeLessThanOrEqual(200)
    expect(headline()!.endsWith('…')).toBe(true)
    render([ask(), reply('t1', thought('input-available', `${long}.\n\nNow the clock. It drifts`))], 'streaming', { phase: 'thinking' })
    expect(headline()).toBe('Now the clock.')
    // The next step starts: the finished thought is one still row with the same headline.
    render([ask(), reply('t1', { ...thought('output-available', `${long}.\n\nNow the clock. It drifts.`), toolCallId: 'th1' }), reply('r1', text('Here is the plan.'))], 'streaming', { phase: 'streaming' })
    expect(reasoningRow('Now the clock.')).not.toBeNull()
  })

  it('3. a thought whose new paragraph has only begun keeps its last full one as the live line; finished or opened, it reads as written', () => {
    const content = 'Check the file.\n\ne.'
    render([ask(), reply('t1', thought('input-available', content))], 'streaming', { phase: 'thinking' })
    expect(headline()).toBe('Check the file.')
    // The finished thought's row is titled with its newest paragraph as the model wrote it.
    render([ask(), reply('t1', { ...thought('output-available', content), toolCallId: 'th1' }), reply('a1', text('Done.'))], 'streaming', { phase: 'streaming' })
    const row = reasoningRow('e.')
    act(() => { row.click() })
    const opened = row.parentElement!.textContent!
    const first = opened.indexOf('Check the file.')
    expect(first).toBeGreaterThan(-1)
    expect(opened.slice(first + 'Check the file.'.length)).toContain('e.')
  })

  it('3. a thought being written does not shimmer: only its icon turns (no paint every frame)', () => {
    render([ask(), reply('t1', thought('input-available', '**Reading**\n\nThe output says'))], 'streaming', { phase: 'thinking' })
    expect(host.querySelector('.turn-answer .an-text-shimmer--active')).toBeNull()
    expect(host.querySelector('.turn-answer svg.thinking-icon.is-thinking')).not.toBeNull()
    // Nor while a call runs: the live row keeps the headline still and names the call under it.
    const first = reply('t1', { ...thought('output-available', '**Reading the test**\n\nIt starts both.'), toolCallId: 'th1' })
    render([ask(), first, reply('c1', tool('Bash', 'input-available', { command: 'npm test' }))], 'streaming', { phase: 'tool_running' })
    expect(host.querySelector('.turn-answer .an-text-shimmer--active')).toBeNull()
    expect(headline()).toBe('Reading the test')
    expectLive('Running Bash…')
  })

  it('3. a thought with no text yet shows only Thinking…', () => {
    render([ask(), reply('t1', thought('input-available', ''))], 'streaming', { phase: 'thinking' })
    expectLive('Thinking…')
    expect(headline()).toBeNull()
    // And with no thought row at all (an empty thinking block), the line says it.
    render([ask()], 'streaming', { phase: 'thinking', step: { kind: 'reasoning' } })
    expectLive('Thinking…')
    // (The screen reader's status region, which is not shown, says "Thinking".)
    expect(host.querySelector('.turn-answer')!.textContent).toBe('Thinking…Thinking')
    expect(host.querySelector('[data-turn-live]')!.textContent).toBe('Thinking…')
  })

  it('3. one thought is titled with its newest paragraph\'s headline; opened, it shows all of it', () => {
    const blocks = '**Checking the order**\n\nEqual due times are taken by id.\n\n**Planning the fix**\n\nMake the first one due earlier.'
    render([ask(), reply('t1', thought('output-available', blocks)), reply('a1', text('The test is flaky.'))], 'streaming', { phase: 'streaming' })
    const row = reasoningRow('Planning the fix')
    act(() => { row.click() })
    const opened = row.parentElement!.textContent!
    expect(opened.indexOf('Equal due')).toBeLessThan(opened.indexOf('Make the first one'))
  })

  it('3. several thoughts in a row group into one: collapsed, the latest showing; opened, all of them in order', () => {
    const first = reply('t1', { ...thought('output-available', '**Checking the order**\n\nEqual due times are taken by id.'), toolCallId: 'th1' })
    const second = reply('t2', { ...thought('output-available', '**Planning the fix**\n\nMake the first one due earlier.'), toolCallId: 'th2' })
    render([ask(), first, second, reply('a1', text('The test is flaky.'))], 'streaming', { phase: 'streaming' })
    const group = reasoningRow('Planning the fix')
    expect(group.getAttribute('aria-expanded')).toBe('false')
    act(() => { group.click() })
    expect(group.getAttribute('aria-expanded')).toBe('true')
    const opened = group.parentElement!.textContent!
    expect(opened.indexOf('Checking the order')).toBeGreaterThan(-1)
    expect(opened.indexOf('Checking the order')).toBeLessThan(opened.lastIndexOf('Planning the fix'))
  })

  it('3. a thought written after calls heads the live row, which is the run; the run takes a still group line when text starts', () => {
    const first = reply('t1', { ...thought('output-available', '**Reading the test**\n\nIt starts both.'), toolCallId: 'th1' })
    const call = reply('c1', tool('Bash', 'output-available', { command: 'ls' }))
    const live = reply('t2', { ...thought('input-available', '**Planning the fix**\n\nMake A due earlier'), toolCallId: 'th2' })
    render([ask(), first, call, live], 'streaming', { phase: 'thinking' })
    expectLive('Thinking…')
    expect(headline()).toBe('Planning the fix')
    // The run has no group line while it runs: the live row stands for it.
    expect(groupHeader('Reading the test')).toBeNull()
    // The turn moves on to writing. The provider still marks the thought as streaming (it closes it at the turn's
    // end), but with text after it it is done: it joins the group, which keeps its title and stays one row.
    const still = reply('t2', { ...thought('input-available', '**Planning the fix**\n\nMake A due earlier.'), toolCallId: 'th2' })
    render([ask(), first, call, still, reply('a1', text('Fixed by'))], 'streaming', { phase: 'streaming' })
    expect(reasoningRows()).toHaveLength(0)
    expect(groupHeader('Reading the test')!.getAttribute('aria-expanded')).toBe('false')
    // The text being written says the rest: the live row has nothing to add.
    expect(rowQuiet()).toBe(true)
    act(() => { groupHeader('Reading the test')!.click() })
    const opened = groupHeader('Reading the test')!.parentElement!.textContent!
    for (const piece of ['Reading the test', 'ls', 'Planning the fix']) expect(opened).toContain(piece)
  })

  it('3. reasoning again after text, with nothing shown of it: Thinking…', () => {
    render([ask(), reply('a1', text('Found it.'))], 'streaming', { phase: 'streaming', step: { kind: 'reasoning' } })
    expectLive('Thinking…')
  })

  it('4. text streaming: Writing… until its first words show, then the text says it', () => {
    render([ask(), reply('a1', text(''))], 'streaming', { phase: 'streaming' })
    expectLive('Writing…')
    const row = liveRow()
    setReplyPacing(true)
    // Paced, the first words wait for their block to finish: nothing of the reply shows yet, so the row still says it.
    render([ask(), reply('a1', text('The test fails because'))], 'streaming', { phase: 'streaming' })
    expect(host.querySelector('.turn-answer .an-markdown')).toBeNull()
    expectLive('Writing…')
    expect(rowQuiet()).toBe(false)
    // A finished paragraph shows: the reply says it, and the row is hidden by the style rule that reads its mark.
    render([ask(), reply('a1', text('The test fails because the clock drifts.\n\nThe fix'))], 'streaming', { phase: 'streaming' })
    expect(host.querySelector('.turn-answer .an-markdown')).not.toBeNull()
    expect(rowQuiet()).toBe(true)
    expect(readFileSync('src/renderer/chat/components/agent-elements/turn-progress.css', 'utf8')).toMatch(/\.turn-answer > :has\(\.an-markdown\) \+ \.turn-live\[data-until-text\] \{\s*display: none;/)
    // Not paced, the words show as they come: the row is hidden at once. Hidden, not removed: it is the same row.
    setReplyPacing(false)
    try {
      render([ask(), reply('a1', text('The test fails because'))], 'streaming', { phase: 'streaming' })
      expect(line()).toBeNull()
      expect(liveRow()).toBe(row)
      expect(row!.hidden).toBe(true)
    } finally {
      setReplyPacing(true)
    }
  })

  it('5. a tool call being prepared: Preparing <tool>…', () => {
    render([ask(), reply('c1', tool('Bash', 'input-streaming'))], 'streaming', { phase: 'tool_running' })
    expectLive('Preparing Bash…')
    // Claude opens the row at the call's start, before its arguments arrive.
    render([ask(), reply('c1', tool('Bash', 'input-available'))], 'streaming', { phase: 'tool_running' })
    expectLive('Preparing Bash…')
    render([ask(), reply('c1', tool('Bash', 'input-available', { label: 'command', cwd: 'J:/repo' }))], 'streaming', { phase: 'tool_running' })
    expectLive('Preparing Bash…')
  })

  it('5. a long shell command running: Running <tool>…, the command in the tooltip', () => {
    render([ask(), reply('c1', tool('Bash', 'input-available', { command: 'npm test -- --run slow.test.ts' }))], 'streaming', { phase: 'tool_running' })
    expectLive('Running Bash…')
    expect(line()!.title).toBe('npm test -- --run slow.test.ts')
    // The command follows the label, dim. The call has no row above: the live row is its run, and opens to show it.
    expect(lineDetail()).toBe('npm test -- --run slow.test.ts')
    expect(groupHeader('Running npm test')).toBeNull()
    const toggle = liveRow()!.querySelector<HTMLButtonElement>('button.turn-live-toggle')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    act(() => { toggle.click() })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(liveRow()!.querySelector('.an-tool-group-rows')!.textContent).toContain('npm test -- --run slow.test.ts')
  })

  it('5. while a steer waits for the command, the line still reads Running <tool>…, and its tooltip says when the steer goes in', () => {
    render([ask(), reply('c1', tool('Bash', 'input-available', { command: 'sleep 15' }))], 'streaming', { phase: 'tool_running', steerHeld: true })
    expectLive('Running Bash…')
    expect(line()!.title).toBe('sleep 15\nYour steer goes in when it finishes.')
    // Nothing held: the tooltip is the command alone.
    render([ask(), reply('c1', tool('Bash', 'input-available', { command: 'sleep 15' }))], 'streaming', { phase: 'tool_running' })
    expect(line()!.title).toBe('sleep 15')
    // A line that is not a tool's adds nothing.
    expect(describeTurnProgress({ state: { phase: 'streaming', steerHeld: true }, messages: [reply('c1', text('so far'))], now: NOW.valueOf() })?.title).toBeUndefined()
  })

  it('5. under strict release, once no call of the turn runs, a tool the line shows (a subagent\'s) is not what the steer waits for: its tooltip says the turn\'s end', () => {
    render([ask(), reply('c1', tool('Agent', 'input-available', { description: 'research' }))], 'streaming', { phase: 'tool_running', steerHeld: 'turn_end' })
    expect(line()!.title).toMatch(/Your steer goes in when the turn ends\.$/)
    expect(line()!.title).not.toMatch(/when it finishes/)
  })

  it('5. an MCP tool running is named by its tool', () => {
    render([ask(), reply('c1', tool('mcp__github__get_issue', 'input-available', { issue: 12 }))], 'streaming', { phase: 'tool_running' })
    expectLive('Running Get Issue…')
  })

  it('5. a Mousse tool running says what it does, with the Mousse logo', () => {
    render([ask(), reply('c1', tool('mcp__mousse__thread_create', 'input-available', { title: 'Fix login' }))], 'streaming', { phase: 'tool_running' })
    expectLive('Creating a thread in Mousse…')
    expect(line()!.querySelector('svg[data-icon="mousse"]')).not.toBeNull()
    render([ask(), reply('c1', tool('mcp__mousse__memory_save', 'input-streaming'))], 'streaming', { phase: 'tool_running' })
    expectLive('Saving to memory…')
    render([ask(), reply('c1', tool('mcp__mousse__brand_new_thing', 'input-available', { id: 'x' }))], 'streaming', { phase: 'tool_running' })
    expectLive('Running brand new thing in Mousse…')
  })

  it('5. a tool search says what its row says: Loading tools…, the query in the tooltip', () => {
    const label = (input: Record<string, unknown>) =>
      describeTurnProgress({ state: { phase: 'tool_running' }, messages: [reply('c1', tool('ToolSearch', 'input-available', input))], now: NOW })
    expect(label({ query: 'select:mcp__mousse__thread_list' })).toMatchObject({ kind: 'running-tool', label: 'Loading tools…', title: 'select:mcp__mousse__thread_list' })
    expect(label({})?.label).toBe('Loading tools…')
  })

  it('5. a call finished and nothing new started: what it did, in the past tense', () => {
    render([ask(), reply('c1', tool('Bash', 'output-available', { command: 'ls' }))], 'streaming', { phase: 'thinking' })
    expectLive('Ran')
    expect(lineDetail()).toBe('ls')
    expect(line()!.querySelector('.an-tool-icon[data-state="done"] svg')).not.toBeNull()
    // The model reasons about it: Thinking…
    render([ask(), reply('c1', tool('Bash', 'output-available', { command: 'ls' }))], 'streaming', { phase: 'thinking', step: { kind: 'reasoning' } })
    expectLive('Thinking…')
  })

  it('5. a call failed: the failure, in the danger colour, under the thought that led to it', () => {
    // As the chat gets them: a failure with nothing after it in a running turn is marked got past, so its row is quiet.
    const marked = (messages: UIMessage[]) => markRecoveredFailures(structuredClone(messages))
    const lead = reply('t1', { ...thought('output-available', 'Run the auth tests.'), toolCallId: 'th1' })
    const failed = reply('c1', { ...tool('Bash', 'output-error', { command: 'pnpm vitest run tests/auth' }), errorText: 'exit 1' })
    render(marked([ask(), lead, failed]), 'streaming', { phase: 'thinking' })
    expectLive('Failed')
    expect(lineDetail()).toBe('pnpm vitest run tests/auth')
    expect(line()!.querySelector('.turn-progress-failed')).not.toBeNull()
    expect(headline()).toBe('Run the auth tests.')
    expect(groupHeader('Run the auth tests.')).toBeNull()
    // The agent thinks on: the line says so, and still names the failure nothing has got past.
    const next = reply('t2', { ...thought('input-available', 'Try npx instead.'), toolCallId: 'th2' })
    render(marked([ask(), lead, failed, next]), 'streaming', { phase: 'thinking' })
    expectLive('Thinking…')
    expect(line()!.querySelector('.turn-progress-badge')!.textContent).toBe('· 1 failed')
    // A retry that works: the failure is got past and the line stops naming it.
    const retry = reply('c2', tool('Bash', 'output-available', { command: 'npx vitest run tests/auth' }, 'c2'))
    render(marked([ask(), lead, failed, { ...next, parts: [{ ...next.parts[0]!, state: 'output-available' }] } as UIMessage, retry]), 'streaming', { phase: 'thinking' })
    expectLive('Ran')
    expect(line()!.querySelector('.turn-progress-badge')).toBeNull()
  })

  it('5b. a call that ended with `success: false` failed too: counted after a thought, cleared by a retry that works', () => {
    const marked = (messages: UIMessage[]) => markRecoveredFailures(structuredClone(messages))
    const failed = reply('c1', { ...tool('Bash', 'output-available', { command: 'pnpm vitest run tests/auth' }, 'c1'), output: { success: false, stdout: '' } })
    const next = reply('t2', { ...thought('input-available', 'Try npx instead.'), toolCallId: 'th2' })
    render(marked([ask(), failed, next]), 'streaming', { phase: 'thinking' })
    expectLive('Thinking…')
    expect(line()!.querySelector('.turn-progress-badge')!.textContent).toBe('· 1 failed')
    const retry = reply('c2', tool('Bash', 'output-available', { command: 'npx vitest run tests/auth' }, 'c2'))
    render(marked([ask(), failed, { ...next, parts: [{ ...next.parts[0]!, state: 'output-available' }] } as UIMessage, retry]), 'streaming', { phase: 'thinking' })
    expectLive('Ran')
    expect(line()!.querySelector('.turn-progress-badge')).toBeNull()
  })

  it('5c. a run of one call that failed, closed by a step that is not text, is titled as failed', () => {
    const marked = (messages: UIMessage[]) => markRecoveredFailures(structuredClone(messages))
    const failed = reply('c1', { ...tool('Bash', 'output-error', { command: 'pnpm vitest run tests/auth' }, 'c1'), errorText: 'exit 1' })
    // A plan being written closes the run without getting past the failure.
    const plan = reply('p1', tool('PlanWrite', 'input-available', { plan: 'Fix the auth setup.' }, 'p1'))
    render(marked([ask(), failed, plan]), 'streaming', { phase: 'tool_running' })
    const lineOfRun = groupHeader('Failed')
    expect(lineOfRun).not.toBeNull()
    expect(lineOfRun!.textContent).toContain('pnpm vitest run tests/auth')
    expect(lineOfRun!.textContent).toContain('· 1 failed')
    expect(groupHeader('Ran')).toBeNull()
  })

  it('6. between tool calls: the last one, in the past tense, until something new starts', () => {
    const calls = [reply('c1', tool('Read', 'output-available', { file_path: 'src/a.ts' }, 'r1')), reply('c2', tool('Grep', 'output-available', { pattern: 'expiresIn' }, 'g1'))]
    render([ask(), ...calls], 'streaming', { phase: 'thinking' })
    expectLive('Searched')
    expect(lineDetail()).toBe('expiresIn')
    render([ask(), ...calls, reply('t1', thought('input-available', 'Now the fix'))], 'streaming', { phase: 'thinking' })
    expectLive('Thinking…')
  })

  it('6. several calls running at once: the latest, and how many others run', () => {
    const running = (id: string, command: string) => reply(id, tool('Bash', 'input-available', { command }, id))
    render([ask(), running('b1', 'npm run lint'), running('b2', 'npm test'), running('b3', 'npm run build')], 'streaming', { phase: 'tool_running' })
    expectLive('Running Bash…')
    expect(lineDetail()).toBe('npm run build')
    expect(line()!.querySelector('.turn-progress-more')!.textContent).toBe('+2 running')
  })

  it('6. a tool still running behind a finished one is named', () => {
    render([ask(), reply('c1', tool('Bash', 'input-available', { command: 'sleep 30' }, 'b1')), reply('c2', tool('Read', 'output-available', {}, 'r1'))], 'streaming', { phase: 'tool_running' })
    expectLive('Running Bash…')
  })

  it('7. a subagent running: Running subagent…', () => {
    render([ask(), reply('s1', tool('Agent', 'input-available', { description: 'Audit the tests' }))], 'streaming', { phase: 'tool_running' })
    expectLive('Running subagent…')
    expect(line()!.title).toBe('Audit the tests')
  })

  it('7. the turn ended and its subagents still work: Waiting for subagents…', () => {
    const progress = describeTurnProgress({ state: { phase: 'completed' }, messages: [reply('a1', text('Started two agents.'))], awaitingSubagents: true, now: NOW })
    expect(progress?.label).toBe('Waiting for subagents…')
  })

  it('8. an approval waiting: the header says so instead of Working, and the request is the live row', () => {
    const request = { type: 'data-permission-request', data: { requestId: 'r1', action: 'command', prompt: 'Run npm test?', status: 'pending' } }
    render([ask(), reply('p1', request)], 'streaming', { phase: 'awaiting_input' })
    expect(header()).toBe('Waiting for approval')
    expect(line()).toBeNull()
  })

  it('8. a question waiting for its answer: the header says so instead of Working, tooltip too', () => {
    render([ask(), reply('a1', text('One question first.'))], 'streaming', { phase: 'awaiting_input' })
    expect(header()).toBe('Waiting for your answer')
    const label = [...host.querySelectorAll<HTMLElement>('.turn-work-label')].at(-1)!
    expect(label.title).not.toMatch(/Working/)
    expect(line()).toBeNull()
  })

  it('9. compaction: its own live row says it, once', () => {
    const compaction = { ...reply('k1', text('Compacting context…')), metadata: { compaction: true, compacting: true } } as UIMessage
    render([ask(), reply('a1', text('Working through the files.')), compaction], 'streaming', { phase: 'thinking' })
    expect(header()).toMatch(/^Working/)
    expect(host.querySelector('[role="status"] .an-text-shimmer--active')?.textContent).toBe('Compacting context…')
    expect(line()).toBeNull()
  })

  it('9. a compaction before any output, with no text of its own yet, is the line', () => {
    const compaction = { ...reply('k1', text('')), metadata: { compaction: true, compacting: true } } as UIMessage
    render([ask(), compaction], 'streaming', { phase: 'thinking' })
    expectLive('Compacting context…')
  })

  it('10. a retry after a provider error: Retrying in 5s…, counting down, the attempt in the tooltip', () => {
    render([ask()], 'streaming', { phase: 'thinking', step: { kind: 'retrying', attempt: 2, maxAttempts: 5, delayMs: 5000 } })
    expectLive('Retrying in 5s…')
    expect(line()!.title).toBe('Attempt 2 of 5')
    act(() => { vi.advanceTimersByTime(1000) })
    expect(lineText()).toBe('Retrying in 4s…')
    act(() => { vi.advanceTimersByTime(5000) })
    expect(lineText()).toBe('Retrying…')
  })

  it('10. a countdown that starts on a line already shown reads its right second at once', () => {
    const messages = [ask(), reply('a1', text('Partial'))]
    render(messages, 'streaming', { phase: 'streaming', step: { kind: 'waiting' } })
    // The line has been up a while (no timer ran meanwhile) when the retry arrives.
    act(() => { vi.setSystemTime(NOW + 30_000) })
    render(messages, 'streaming', { phase: 'streaming', step: { kind: 'retrying', attempt: 3, maxAttempts: 5, delayMs: 7000 } })
    expect(lineText()).toBe('Retrying in 7s…')
  })

  it("10. counts a retry down on this window's clock, whatever the other computer's says, and does not start over", () => {
    // A step carries a wait, not a time; the same state read again (after missed events) keeps its first sighting.
    const state: TurnProgressState = { threadId: 't1', updatedAt: '2026-11-11T09:00:00.000Z', phase: 'thinking', step: { kind: 'retrying', attempt: 4, maxAttempts: 9, delayMs: 8000 } }
    const first = stepSeenAt(state, NOW)
    expect(stepSeenAt({ ...state, step: { ...state.step! } }, NOW + 3000)).toBe(first)
    const progress = describeTurnProgress({ state, messages: [], stepSince: first, now: NOW + 3000 })
    expect(progress?.label).toBe('Retrying in 5s…')
  })

  it('10. a second retry that says the same counts down again, in the same turn and in another thread', () => {
    const retry = { kind: 'retrying' as const, attempt: 1, maxAttempts: 3, delayMs: 4000 }
    const first: TurnProgressState = { threadId: 't-same', updatedAt: '2026-11-11T09:10:00.000Z', phase: 'thinking', step: retry }
    expect(stepSeenAt(first, NOW)).toBe(NOW)
    // Later in the same turn Pi retries again with the same attempt, limit and wait: a new state change.
    const again: TurnProgressState = { ...first, updatedAt: '2026-11-11T09:12:00.000Z', step: { ...retry } }
    expect(stepSeenAt(again, NOW + 120_000)).toBe(NOW + 120_000)
    const label = (state: TurnProgressState, at: number) =>
      describeTurnProgress({ state, messages: [], stepSince: stepSeenAt(state, at), now: at })?.label
    expect(label(again, NOW + 120_000)).toBe('Retrying in 4s…')
    // Another thread's retry at the same moment, saying the same, counts on its own.
    const other: TurnProgressState = { ...first, threadId: 't-other' }
    expect(label(other, NOW + 120_000)).toBe('Retrying in 4s…')
  })

  it('10. a retry shown in the list counts down again when the same retry comes back later', () => {
    const retry = { kind: 'retrying' as const, attempt: 1, maxAttempts: 3, delayMs: 3000 }
    render([ask()], 'streaming', { threadId: 't-list', updatedAt: '2026-11-11T09:20:00.000Z', phase: 'thinking', step: retry })
    expectLive('Retrying in 3s…')
    act(() => { vi.advanceTimersByTime(4000) })
    expect(lineText()).toBe('Retrying…')
    render([ask()], 'streaming', { threadId: 't-list', updatedAt: '2026-11-11T09:20:04.000Z', phase: 'thinking', step: { ...retry } })
    expect(lineText()).toBe('Retrying in 3s…')
  })

  it('10. a retry after no answer at all says so, without an attempt count', () => {
    render([ask()], 'streaming', { phase: 'thinking', step: { kind: 'retrying', attempt: 1, delayMs: 2000, noResponse: true } })
    expectLive('Retrying in 2s…')
    expect(line()!.title).toBe('No answer from the provider yet')
  })

  it('10. a retry mid-reply replaces the stale line', () => {
    render([ask(), reply('a1', text('Partial'))], 'streaming', { phase: 'streaming', step: { kind: 'retrying', attempt: 1 } })
    expectLive('Retrying…')
  })

  it('11. after Stop, while the turn still ends: Stopping…', () => {
    render([ask(), reply('c1', tool('Bash', 'input-available', { command: 'sleep 60' }))], 'streaming', { phase: 'tool_running', stopping: true })
    expectLive('Stopping…')
  })

  it('11. once the turn shows stopped there is no Working left', () => {
    render([ask(), reply('a1', text('Partial'))], 'ready', { phase: 'stopped' })
    expect(header()).toMatch(/^Worked for/)
    expect(line()).toBeNull()
  })

  it('12. a steered message the model has not answered yet: Thinking…, then what it does', () => {
    // The service says the model has the steer (step `waiting`), whether the steer shows as a turn of its own or as
    // a Steer block inside the running reply.
    const steered = ask('u2', 'Also check the lint', { steered: true })
    render([ask('u1'), reply('a1', text('Looking.')), steered], 'streaming', { phase: 'streaming', step: { kind: 'waiting' } })
    expectLive('Thinking…')
    expect(line()!.title).toBe("Waiting for the model's first output")
    render([ask('u1'), reply('a1', text('Looking.')), steered, reply('t2', thought('input-available'))], 'streaming', { phase: 'thinking' })
    expectLive('Thinking…')
  })

  it('12. a Steer block says nothing by itself: the line follows what the turn does, and waits only by the step', () => {
    // The block shows at the click, before the model reads it (Claude's steer is taken when it is pushed).
    const block = { id: 'steer-group:u2', role: 'user', parts: [], metadata: { steerGroup: [ask('u2', 'Also check the lint', { steered: true })] } } as unknown as UIMessage
    const label = (messages: UIMessage[], state: TurnProgressState) => describeTurnProgress({ state, messages, now: NOW })?.label
    // A long command still runs: it stays the line.
    const running = reply('c1', tool('Bash', 'input-available', { command: 'npm test' }))
    expect(label([running, block], { phase: 'tool_running' })).toBe('Running Bash…')
    expect(label([running, block], { phase: 'tool_running', step: { kind: 'waiting' } })).toBe('Running Bash…')
    // Claude keeps writing into the reply above the block: the text says it, until the service says the model waits.
    const writing = reply('a1', text('Looking at the'))
    expect(label([writing, block], { phase: 'streaming' })).toBeUndefined()
    expect(label([writing, block], { phase: 'streaming', step: { kind: 'waiting' } })).toBe('Thinking…')
  })

  it('12. a steer during a running tool keeps Running <tool>… in the transcript (#873)', () => {
    const steered = ask('u2', 'Also check the lint', { steered: true })
    render([ask('u1'), reply('c1', tool('Bash', 'input-available', { command: 'npm test' })), steered], 'streaming', { phase: 'tool_running' })
    expectLive('Running Bash…')
  })

  it('12. a steer while the reply is written: the text says it until the service says the model waits (#873)', () => {
    const steered = ask('u2', 'Also check the lint', { steered: true })
    const messages = [ask('u1'), reply('a1', text('Looking at the')), steered]
    render(messages, 'streaming', { phase: 'streaming' })
    expect(rowQuiet() || lineText() === 'Writing…').toBe(true)
    render(messages, 'streaming', { phase: 'streaming', step: { kind: 'waiting' } })
    expectLive('Thinking…')
  })

  it('follows the turn inside a memoised row: a new step alone updates it', () => {
    const messages = [ask(), reply('c1', tool('Bash', 'output-available', { command: 'ls' }))]
    render(messages, 'streaming', { phase: 'thinking' })
    expectLive('Ran')
    render(messages, 'streaming', { phase: 'thinking', step: { kind: 'reasoning' } })
    expectLive('Thinking…')
    render(messages, 'streaming', { phase: 'thinking', step: { kind: 'retrying', attempt: 1 } })
    expectLive('Retrying…')
  })

  it('is never empty while a turn runs, in any phase or step, unless text being written is on screen', () => {
    const turns: UIMessage[][] = [
      [ask()],
      [ask(), reply('a1', text('Some text'))],
      [ask(), reply('c1', tool('Bash', 'output-available'))],
      [ask(), reply('t1', thought('output-available', 'Plan'))]
    ]
    const states: TurnProgressState[] = [
      {},
      { phase: 'queued' },
      { phase: 'thinking' },
      { phase: 'streaming' },
      { phase: 'tool_running' },
      { phase: 'finalizing' },
      ...(['starting', 'waiting', 'reasoning'] as const).map((kind) => ({ phase: 'thinking' as const, step: { kind } })),
      { phase: 'thinking', step: { kind: 'retrying', attempt: 1 } }
    ]
    for (const messages of turns) {
      for (const state of states) {
        render(messages, 'streaming', state)
        expect(header()).toMatch(/^Working/)
        const last = messages.at(-1)!
        const textShown = state.phase === 'streaming' && !state.step && last.role === 'assistant' && last.parts.some((part) => part.type === 'text')
        if (textShown) expect(rowQuiet()).toBe(true)
        else expect(lineText(), JSON.stringify({ state, parts: messages.at(-1)!.parts })).not.toBe('')
      }
    }
  })

  it('without a thread behind the list it reads the messages', () => {
    render([ask()], 'submitted', null)
    expectLive('Starting…')
    render([ask(), reply('a1', text('Some text'))], 'streaming', null)
    expectLive('Thinking…')
  })

  it('ends with the turn', () => {
    render([ask(), reply('a1', text('Done.'))], 'ready', { phase: 'completed' })
    expect(header()).toMatch(/^Worked for/)
    expect(line()).toBeNull()
  })
})

describe('its animation', () => {
  const css = readFileSync('src/renderer/chat/components/agent-elements/turn-progress.css', 'utf8')

  it('moves by transform and opacity only, so the compositor draws it', () => {
    const keyframes = [...css.matchAll(/@keyframes [\w-]+\s*\{([^]*?)\n\}/g)].map((match) => match[1]).join('\n')
    expect(keyframes).not.toBe('')
    const properties = [...keyframes.matchAll(/([a-z-]+)\s*:/g)].map((match) => match[1])
    expect(new Set(properties)).toEqual(new Set(['opacity', 'transform']))
    expect(css).not.toMatch(/background-position|an-shimmer/)
  })

  it('has no edge or side bar', () => {
    expect(css).not.toMatch(/border-(left|right)|inset-inline|box-shadow/)
    const group = readFileSync('src/renderer/chat/components/agent-elements/tools/tool-calls-group.tsx', 'utf8')
    expect(group).not.toMatch(/border-l\b/)
  })

  it('caps an open group at about 18rem, which scrolls on its own', () => {
    const groupCss = readFileSync('src/renderer/chat/components/agent-elements/tools/tool-calls-group.css', 'utf8')
    const rule = groupCss.match(/\.an-tool-group-scroll\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(rule).toMatch(/max-height:\s*min\(18rem, 50dvh\)/)
    expect(rule).toMatch(/overflow-y:\s*auto/)
  })
})
