/**
 * The composer's status row of a thread's background work (issue #1605): what its line says, what Details lists and
 * what each Stop stops. The data is what the daemon pushes (`thread.backgroundWork`) plus the thread's running subagents.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { BackgroundWorkRowView, backgroundLines } from '../../src/renderer/components/BackgroundWorkRow'
import { PROVIDER_BACKGROUND_ID, backgroundCounts, backgroundHeadline, type BackgroundWorkItem, type ThreadBackgroundWork } from '../../src/shared/backgroundWork'
import type { SubagentSummary } from '../../src/shared/subagents'

const item = (id: string, kind: BackgroundWorkItem['kind'], description = id): BackgroundWorkItem => ({
  id, kind, description, startedAt: '2026-11-20T10:00:00.000Z', until: '2026-11-20T10:30:00.000Z'
})
const work = (items: BackgroundWorkItem[], providerWork = false): ThreadBackgroundWork => ({ threadId: 't1', items, providerWork })
const subagent = (childThreadId: string, state: string) => ({ childThreadId, title: `Sub ${childThreadId}`, state }) as unknown as SubagentSummary

describe('the background work line', () => {
  it.each([
    [{ subagents: 2, commands: 1, monitors: 3 }, 'Waiting on 2 subagents, 1 command and 3 monitors'],
    [{ subagents: 0, commands: 2, monitors: 1 }, 'Waiting on 2 commands and 1 monitor'],
    [{ subagents: 1, commands: 0, monitors: 0 }, 'Waiting on 1 subagent'],
    [{ subagents: 0, commands: 0, monitors: 0 }, '']
  ])('%j → %s', (counts, text) => {
    expect(backgroundHeadline(counts)).toBe(text)
  })

  it('counts holds with monitors and the provider\'s own work with commands', () => {
    const counts = backgroundCounts(work([item('mon-1', 'command'), item('mon-2', 'url'), item('kw-1', 'keep_working'), item('bg-1', 'background')], true), 2)
    expect(counts).toEqual({ subagents: 2, commands: 2, monitors: 3 })
    expect(backgroundCounts(undefined, 0)).toEqual({ subagents: 0, commands: 0, monitors: 0 })
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
})

describe('the row', () => {
  const render = (props: Partial<Parameters<typeof BackgroundWorkRowView>[0]> = {}) => renderToStaticMarkup(createElement(BackgroundWorkRowView, {
    headline: 'Waiting on 1 monitor', lines: [{ key: 'mon-1', title: 'CI for PR 12', kind: 'Monitor', tooltip: 'gh pr checks 12 --watch', stop: () => undefined }],
    open: false, onToggle: () => undefined, onStopAll: () => undefined, ...props
  }))

  it('shows the line, the latest activity, Details and Stop; the list only once Details is open', () => {
    const closed = render({ latest: 'build: pass' })
    expect(closed).toContain('Waiting on 1 monitor')
    expect(closed).toContain(' · build: pass')
    expect(closed).toContain('>Details<')
    expect(closed).toContain('>Stop<')
    expect(closed).toContain('aria-expanded="false"')
    expect(closed).not.toContain('CI for PR 12')
    const open = render({ open: true })
    expect(open).toContain('CI for PR 12')
    expect(open).toContain('aria-label="Stop CI for PR 12"')
    expect(open).toContain('title="gh pr checks 12 --watch"')
  })
})
