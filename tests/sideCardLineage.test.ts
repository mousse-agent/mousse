import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LineageList, LineageSection } from '../src/renderer/components/sideCard/LineageSection'
import {
  LINEAGE_COLLAPSED_COUNT,
  formatAgo,
  lineageAgentName,
  lineageFinishedAt,
  lineageStatusLabel,
  orderLineageAgents,
  sliceLineage
} from '../src/renderer/components/sideCard/lineageLogic'
import { useAppStore } from '../src/renderer/stores/appStore'
import type { Agent } from '../src/shared/types'

const NOW = Date.parse('2026-10-24T12:00:00.000Z')
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

const agent = (id: string, patch: Partial<Agent> = {}): Agent => ({
  id,
  cliType: 'claude-code',
  worktreePath: `/tmp/${id}`,
  branch: `agent/${id}`,
  executionMode: 'headless',
  status: 'running',
  task: `Task ${id}`,
  createdAt: minutesAgo(30),
  ...patch
})

const ids = (agents: readonly Pick<Agent, 'id'>[]) => agents.map((entry) => entry.id)

describe('orderLineageAgents', () => {
  it('lists active agents before finished ones', () => {
    const ordered = orderLineageAgents([
      agent('done', { status: 'completed', exitedAt: minutesAgo(1) }),
      agent('live', { status: 'running' }),
      agent('waiting', { status: 'ready', createdAt: minutesAgo(20) })
    ])
    expect(ids(ordered)).toEqual(['live', 'waiting', 'done'])
  })

  it('sorts active agents newest first by start time', () => {
    const ordered = orderLineageAgents([
      agent('old', { createdAt: minutesAgo(50) }),
      agent('new', { status: 'starting', createdAt: minutesAgo(2) }),
      agent('mid', { createdAt: minutesAgo(10) })
    ])
    expect(ids(ordered)).toEqual(['new', 'mid', 'old'])
  })

  it('sorts finished agents by most recent finish, with fallbacks', () => {
    const ordered = orderLineageAgents([
      agent('exited-early', { status: 'completed', createdAt: minutesAgo(90), exitedAt: minutesAgo(60) }),
      agent('idle-recent', { status: 'failed', createdAt: minutesAgo(90), idleAt: minutesAgo(5) }),
      agent('created-only', { status: 'cancelled', createdAt: minutesAgo(30) }),
      agent('exited-late', { status: 'interrupted', createdAt: minutesAgo(90), exitedAt: minutesAgo(2), idleAt: minutesAgo(40) })
    ])
    expect(ids(ordered)).toEqual(['exited-late', 'idle-recent', 'created-only', 'exited-early'])
  })

  it('does not mutate its input and tolerates bad timestamps', () => {
    const input = [agent('a', { createdAt: 'nope' }), agent('b')]
    const snapshot = [...input]
    expect(ids(orderLineageAgents(input))).toEqual(['b', 'a'])
    expect(input).toEqual(snapshot)
  })
})

describe('lineageFinishedAt', () => {
  it('prefers exitedAt, then idleAt, then createdAt', () => {
    expect(lineageFinishedAt({ status: 'completed', createdAt: minutesAgo(30), idleAt: minutesAgo(10), exitedAt: minutesAgo(5) })).toBe(NOW - 5 * 60_000)
    expect(lineageFinishedAt({ status: 'completed', createdAt: minutesAgo(30), idleAt: minutesAgo(10) })).toBe(NOW - 10 * 60_000)
    expect(lineageFinishedAt({ status: 'completed', createdAt: minutesAgo(30) })).toBe(NOW - 30 * 60_000)
  })
})

describe('sliceLineage', () => {
  const rows = Array.from({ length: 8 }, (_, index) => index)

  it('shows the first five and counts the rest', () => {
    expect(LINEAGE_COLLAPSED_COUNT).toBe(5)
    const { visible, hiddenCount } = sliceLineage(rows, false)
    expect(visible).toEqual([0, 1, 2, 3, 4])
    expect(hiddenCount).toBe(3)
  })

  it('shows everything once expanded', () => {
    expect(sliceLineage(rows, true)).toEqual({ visible: rows, hiddenCount: 0 })
  })

  it('has no overflow row at or below the limit', () => {
    expect(sliceLineage(rows.slice(0, 5), false).hiddenCount).toBe(0)
    expect(sliceLineage([], false)).toEqual({ visible: [], hiddenCount: 0 })
  })
})

describe('formatAgo', () => {
  it('uses the coarsest whole unit', () => {
    expect(formatAgo(NOW - 5_000, NOW)).toBe('just now')
    expect(formatAgo(NOW - 59_000, NOW)).toBe('just now')
    expect(formatAgo(NOW - 60_000, NOW)).toBe('1m ago')
    expect(formatAgo(NOW - 59 * 60_000, NOW)).toBe('59m ago')
    expect(formatAgo(NOW - 3 * 3_600_000, NOW)).toBe('3h ago')
    expect(formatAgo(NOW - 2 * 86_400_000, NOW)).toBe('2d ago')
    expect(formatAgo(NOW - 45 * 86_400_000, NOW)).toBe('1mo ago')
    expect(formatAgo(NOW - 400 * 86_400_000, NOW)).toBe('1y ago')
  })

  it('treats a future time as just now and an unknown time as empty', () => {
    expect(formatAgo(NOW + 60_000, NOW)).toBe('just now')
    expect(formatAgo(Number.NaN, NOW)).toBe('')
  })
})

describe('lineageStatusLabel', () => {
  it('names the status while active', () => {
    expect(lineageStatusLabel(agent('a', { status: 'running' }), NOW)).toBe('Running')
    expect(lineageStatusLabel(agent('a', { status: 'starting' }), NOW)).toBe('Starting')
    expect(lineageStatusLabel(agent('a', { status: 'conflict' }), NOW)).toBe('Conflict')
  })

  it('shows how long ago a finished agent ended', () => {
    expect(lineageStatusLabel(agent('a', { status: 'completed', exitedAt: minutesAgo(12) }), NOW)).toBe('12m ago')
    expect(lineageStatusLabel(agent('a', { status: 'failed', idleAt: minutesAgo(3) }), NOW)).toBe('Failed 3m ago')
    expect(lineageStatusLabel(agent('a', { status: 'cancelled' }), NOW)).toBe('Stopped 30m ago')
  })
})

describe('lineageAgentName', () => {
  it('collapses whitespace and falls back to the agent type', () => {
    expect(lineageAgentName({ task: '  Fix\n  the   tests ', cliType: 'codex' })).toBe('Fix the tests')
    expect(lineageAgentName({ task: '   ', cliType: 'codex' })).toBe('codex')
  })
})

describe('LineageList rendering', () => {
  const render = (agents: Agent[], extra: { expanded?: boolean } = {}) =>
    renderToStaticMarkup(createElement(LineageList, {
      agents,
      now: NOW,
      expanded: extra.expanded ?? false,
      onExpand: () => undefined
    }))

  it('renders nothing for an empty list; the section collapses instead', () => {
    expect(render([])).toBe('')
  })

  it('renders running agents with a live dot ahead of finished ones', () => {
    const html = render([
      agent('done', { status: 'completed', task: 'Finished job', exitedAt: minutesAgo(4) }),
      agent('live', { task: 'Live job' })
    ])
    expect(html.indexOf('Live job')).toBeLessThan(html.indexOf('Finished job'))
    expect(html.match(/lineage-live/g)).toHaveLength(1)
    expect(html).toContain('4m ago')
    expect(html).toContain('Running')
  })

  it('exposes the full task as a title and has no clickable agent rows', () => {
    const html = render([agent('one', { task: 'A very long task name' }), agent('two')])
    expect(html).toContain('title="A very long task name"')
    expect(html).not.toContain('<button')
  })

  it('adds a "Show N more" row past five agents and drops it when expanded', () => {
    const many = Array.from({ length: 7 }, (_, index) => agent(`a${index}`, { createdAt: minutesAgo(index + 1) }))
    const collapsed = render(many)
    expect(collapsed).toContain('Show 2 more')
    expect(collapsed.match(/lineage-name/g)).toHaveLength(5)
    const expanded = render(many, { expanded: true })
    expect(expanded).not.toContain('Show')
    expect(expanded.match(/lineage-name/g)).toHaveLength(7)
  })
})

describe('LineageSection rendering', () => {
  it('collapses to one quiet line with no heading when there are no agents', () => {
    const html = renderToStaticMarkup(createElement(LineageSection, { threadId: 't1', projectId: null }))
    expect(html).toContain('No agents started yet')
    expect(html).not.toContain('side-card-section-title')
    expect(html).not.toContain('Lineage')
    expect(html).not.toContain('<ul')
    expect(html).toContain('data-thread-id="t1"')
  })

  it('keeps the Lineage heading once there are agents', () => {
    const initial = useAppStore.getInitialState()
    const patch = { agents: [agent('one')] }
    useAppStore.setState(patch)
    Object.assign(initial, patch)
    try {
      const html = renderToStaticMarkup(createElement(LineageSection, { threadId: 't1', projectId: null }))
      expect(html).toContain('side-card-section-title">Lineage<')
      expect(html).toContain('Task one')
      expect(html).not.toContain('No agents started yet')
    } finally {
      useAppStore.setState({ agents: [] })
      Object.assign(initial, { agents: [] })
    }
  })
})
