// @vitest-environment jsdom
/**
 * The composer's status row of a thread's background work (issue #1605): what its line says, what Details lists and
 * what each Stop stops. The data is what the daemon pushes (`thread.backgroundWork`) plus the thread's running subagents.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackgroundWorkRow, backgroundLines, rowNames } from '../../src/renderer/components/BackgroundWorkRow'
import { PROVIDER_BACKGROUND_ID, backgroundCounts, backgroundHeadline, type BackgroundWorkItem, type ThreadBackgroundWork } from '../../src/shared/backgroundWork'
import type { SubagentSummary } from '../../src/shared/subagents'

// The command's colours are a matter of looks (checked in the app); here it shows as plain text.
vi.mock('../../src/renderer/chat/components/agent-elements/code-highlighter', () => ({
  codeHighlighter: { highlight: () => null, getThemes: () => ['github-light', 'github-dark'] }
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const item = (id: string, kind: BackgroundWorkItem['kind'], description = id): BackgroundWorkItem => ({
  id, kind, description, startedAt: '2026-11-20T10:00:00.000Z', until: '2026-11-20T10:30:00.000Z'
})
const work = (items: BackgroundWorkItem[], providerWork = false): ThreadBackgroundWork => ({ threadId: 't1', items, providerWork })
const subagent = (childThreadId: string, state: string) => ({ childThreadId, title: `Sub ${childThreadId}`, state }) as unknown as SubagentSummary

describe('the background work line', () => {
  it.each([
    [{ subagents: 2, commands: 1, monitors: 3, wakes: 0 }, 'Waiting on 2 subagents, 1 command and 3 monitors'],
    [{ subagents: 0, commands: 2, monitors: 1, wakes: 0 }, 'Waiting on 2 commands and 1 monitor'],
    [{ subagents: 1, commands: 0, monitors: 0, wakes: 0 }, 'Waiting on 1 subagent'],
    [{ subagents: 0, commands: 0, monitors: 0, wakes: 0 }, ''],
    // A wake-up runs nothing: it is named after what runs, or alone.
    [{ subagents: 0, commands: 0, monitors: 1, wakes: 1 }, 'Waiting on 1 monitor · 1 wake-up set'],
    [{ subagents: 0, commands: 0, monitors: 0, wakes: 2 }, '2 wake-ups set']
  ])('%j → %s', (counts, text) => {
    expect(backgroundHeadline(counts)).toBe(text)
  })

  it('counts holds with monitors, the provider\'s own work with commands and wake-ups on their own', () => {
    const counts = backgroundCounts(work([item('mon-1', 'command'), item('mon-2', 'url'), item('kw-1', 'keep_working'), item('bg-1', 'background'), item('wake-1', 'wake')], true), 2)
    expect(counts).toEqual({ subagents: 2, commands: 2, monitors: 3, wakes: 1 })
    expect(backgroundCounts(undefined, 0)).toEqual({ subagents: 0, commands: 0, monitors: 0, wakes: 0 })
  })
})

describe('Details', () => {
  it('lists running subagents, then the thread\'s own work, then the provider\'s; each Stop stops only its own', () => {
    const stopSubagent = vi.fn()
    const stopItem = vi.fn()
    const lines = backgroundLines(
      [subagent('c1', 'working'), subagent('c2', 'completed')],
      work([item('mon-1', 'command', 'CI for PR 12'), item('kw-1', 'keep_working', 'review')], true),
      { stopSubagent, stopItem }
    )
    expect(lines.map((line) => [line.title, line.kind])).toEqual([
      ['Sub c1', 'Subagent'], ['CI for PR 12', 'Monitor'], ['review', 'Waiting'], ['Agent background work', 'Command']
    ])
    lines[0]!.stop()
    lines[1]!.stop()
    lines[3]!.stop()
    expect(stopSubagent).toHaveBeenCalledWith('c1')
    expect(stopItem.mock.calls).toEqual([['mon-1'], [PROVIDER_BACKGROUND_ID]])
  })

  it('a wake-up says when it wakes: what it waits for and when it gives up, or its time', () => {
    const at = new Date()
    at.setHours(15, 30, 0, 0)
    const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const lines = backgroundLines([], work([
      { ...item('wake-1', 'wake', 'Read the review on PR 12'), until: at.toISOString(), waitsFor: 'when acme/app#12 is reviewed' },
      { ...item('wake-2', 'wake', 'Check the nightly'), until: at.toISOString() }
    ]), { stopSubagent: vi.fn(), stopItem: vi.fn() })
    expect(lines.map((line) => [line.kind, line.tooltip])).toEqual([
      ['Wake-up', `Wakes when acme/app#12 is reviewed, or at ${time} at the latest`],
      ['Wake-up', `Wakes at ${time}`]
    ])
  })
})

describe('what the closed row names', () => {
  const line = (title: string) => ({ key: title, title, kind: 'Command', tooltip: '', mark: { kind: 'command' as const } })
  const reported = (items: BackgroundWorkItem[], id: string): ThreadBackgroundWork => ({ ...work(items), latest: { id, line: 'Permission denied', at: '2026-11-20T10:05:00.000Z' } })
  it.each([
    // [what runs, the lines, what the row names]
    ['the work that reported last, by its description, never the line it printed',
      reported([item('bg-1', 'background', 'Measure folder sizes'), item('bg-2', 'background', 'Run the tests')], 'bg-1'), ['Measure folder sizes', 'Run the tests'], 'Measure folder sizes'],
    ['the one thing that runs when nothing reported', work([]), ['API reviewer'], 'API reviewer'],
    ['the one thing that runs when what reported has ended', reported([], 'bg-gone'), ['API reviewer'], 'API reviewer'],
    ['nothing when several run and none reported', work([item('bg-1', 'background'), item('bg-2', 'background')]), ['bg-1', 'bg-2'], undefined]
  ])('%s', (_case, threadWork, titles, names) => {
    expect(rowNames(titles.map(line), threadWork)).toBe(names)
  })
})

describe('the row', () => {
  let host: HTMLDivElement
  let root: Root
  const writeText = vi.fn(async () => undefined)
  const threadWork: ThreadBackgroundWork = {
    ...work([
      { ...item('bg-1', 'background', 'Measure folder sizes'), command: 'du -sh * | sort -h' },
      { ...item('mon-1', 'command', 'CI for PR 12'), command: 'gh pr checks 12 --watch' },
      item('kw-1', 'keep_working', 'review')
    ]),
    latest: { id: 'bg-1', line: 'du: cannot read directory: Permission denied', at: '2026-11-20T10:05:00.000Z' }
  }

  beforeEach(() => {
    ;(window as unknown as { mousse: unknown }).mousse = { orchestrator: { abort: vi.fn() }, threads: { stopBackground: vi.fn() } }
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  const lineOf = (title: string) => [...host.querySelectorAll('li')].find((li) => li.querySelector('.background-work-title')?.textContent === title)!

  it('names the work, not what it printed; Details shows each command in full with Copy', async () => {
    await act(async () => root.render(createElement(BackgroundWorkRow, { threadId: 't1', subagents: [], work: threadWork, onStopAll: () => undefined })))
    const summary = host.querySelector('button[aria-expanded]')!
    expect(summary.textContent).toContain('Waiting on 1 command and 2 monitors · Measure folder sizes')
    expect(host.textContent).not.toContain('Permission denied')
    expect(host.textContent).not.toContain('du -sh')

    act(() => { (summary as HTMLElement).click() })
    expect(lineOf('Measure folder sizes').textContent).toContain('du -sh * | sort -h')
    expect(lineOf('CI for PR 12').textContent).toContain('gh pr checks 12 --watch')
    // A hold runs no command: nothing to show or copy.
    expect(lineOf('review').querySelector('button[aria-label="Copy command"]')).toBeNull()
    expect(host.textContent).not.toContain('Permission denied')

    await act(async () => { lineOf('Measure folder sizes').querySelector<HTMLElement>('button[aria-label="Copy command"]')!.click() })
    expect(writeText).toHaveBeenCalledWith('du -sh * | sort -h')
  })
})
