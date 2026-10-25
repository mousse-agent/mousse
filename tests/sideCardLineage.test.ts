import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LineageList, LineageSection } from '../src/renderer/components/sideCard/LineageSection'
import {
  LINEAGE_COLLAPSED_COUNT,
  countRunningSubagents,
  formatAgo,
  lineageModelLabel,
  lineageStatusLabel,
  lineageSubagentName,
  lineageTitle,
  orderLineageSubagents,
  sliceLineage
} from '../src/renderer/components/sideCard/lineageLogic'
import { selectSubagents } from '../src/renderer/hooks/useSubagents'
import { useAppStore } from '../src/renderer/stores/appStore'
import { isRunningSubagent, type SubagentState, type SubagentSummary } from '../src/shared/subagents'

const NOW = Date.parse('2026-10-24T12:00:00.000Z')
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

const subagent = (id: string, patch: Partial<SubagentSummary> = {}): SubagentSummary => ({
  childThreadId: id,
  title: `Task ${id}`,
  activity: 'working',
  state: 'working',
  latestDelegationId: `delegation-${id}`,
  unread: false,
  provider: null,
  model: null,
  workspace: 'shared',
  role: null,
  createdAt: minutesAgo(30),
  updatedAt: minutesAgo(30),
  waitingOn: [],
  tasks: [],
  ...patch
})

const ids = (rows: readonly Pick<SubagentSummary, 'childThreadId'>[]) => rows.map((entry) => entry.childThreadId)

describe('isRunningSubagent', () => {
  it.each<[SubagentState, boolean]>([
    ['needs_input', true],
    ['queued', true],
    ['starting', true],
    ['working', true],
    ['waiting', true],
    ['done', false],
    ['failed', false],
    ['stopped', false],
    ['interrupted', false],
    ['idle', false]
  ])('%s', (state, expected) => {
    expect(isRunningSubagent({ state })).toBe(expected)
  })
})

describe('lineageTitle', () => {
  it('counts the subagents still running', () => {
    const rows = [subagent('a'), subagent('b', { state: 'waiting' }), subagent('c', { state: 'done' })]
    expect(countRunningSubagents(rows)).toBe(2)
    expect(lineageTitle(rows)).toBe('Lineage · 2 running')
  })

  it('is a plain heading when nothing is running', () => {
    expect(lineageTitle([subagent('a', { state: 'done' })])).toBe('Lineage')
    expect(lineageTitle([])).toBe('Lineage')
  })
})

describe('orderLineageSubagents', () => {
  it('lists running subagents before finished ones', () => {
    const ordered = orderLineageSubagents([
      subagent('done', { state: 'done', updatedAt: minutesAgo(1) }),
      subagent('live', { state: 'working', createdAt: minutesAgo(5) }),
      subagent('waiting', { state: 'waiting', createdAt: minutesAgo(20) })
    ])
    expect(ids(ordered)).toEqual(['live', 'waiting', 'done'])
  })

  it('sorts running subagents newest first, with those needing input ahead of the rest', () => {
    const ordered = orderLineageSubagents([
      subagent('old', { createdAt: minutesAgo(50) }),
      subagent('new', { state: 'starting', createdAt: minutesAgo(2) }),
      subagent('asking', { state: 'needs_input', createdAt: minutesAgo(40) }),
      subagent('mid', { createdAt: minutesAgo(10) })
    ])
    expect(ids(ordered)).toEqual(['asking', 'new', 'mid', 'old'])
  })

  it('sorts finished subagents by most recent update, and tolerates bad timestamps', () => {
    const ordered = orderLineageSubagents([
      subagent('early', { state: 'done', updatedAt: minutesAgo(60) }),
      subagent('late', { state: 'failed', updatedAt: minutesAgo(2) }),
      subagent('broken', { state: 'stopped', updatedAt: 'nope' })
    ])
    expect(ids(ordered)).toEqual(['late', 'early', 'broken'])
  })

  it('does not mutate its input', () => {
    const input = [subagent('a', { state: 'done' }), subagent('b')]
    const snapshot = [...input]
    expect(ids(orderLineageSubagents(input))).toEqual(['b', 'a'])
    expect(input).toEqual(snapshot)
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
  const label = (state: SubagentState, patch: Partial<SubagentSummary> = {}) => lineageStatusLabel(subagent('a', { state, ...patch }), NOW)

  it('names the state while running', () => {
    expect(label('working')).toBe('Working')
    expect(label('starting')).toBe('Starting')
    expect(label('queued')).toBe('Queued')
    expect(label('needs_input')).toBe('Needs input')
  })

  it('says a subagent is waiting on its own subagents, counting them when known', () => {
    expect(label('waiting')).toBe('Waiting on subagents')
    expect(label('waiting', { waitingOn: [{ title: 'Helper', state: 'working' }] })).toBe('Waiting on 1 subagent')
    expect(label('waiting', { waitingOn: [{ title: 'A', state: 'working' }, { title: 'B', state: 'queued' }] })).toBe('Waiting on 2 subagents')
  })

  it('shows how long ago a finished subagent ended', () => {
    expect(label('done', { updatedAt: minutesAgo(12) })).toBe('12m ago')
    expect(label('failed', { updatedAt: minutesAgo(3) })).toBe('Failed 3m ago')
    expect(label('stopped')).toBe('Stopped 30m ago')
    expect(label('interrupted', { updatedAt: minutesAgo(1) })).toBe('Interrupted 1m ago')
    expect(label('idle', { updatedAt: 'nope' })).toBe('Idle')
  })
})

describe('lineageSubagentName and lineageModelLabel', () => {
  it('collapses whitespace in the title and falls back for an empty one', () => {
    expect(lineageSubagentName({ title: '  API\n  reviewer ' })).toBe('API reviewer')
    expect(lineageSubagentName({ title: '   ' })).toBe('Subagent')
  })

  it('names provider and model, or nothing when the subagent inherited its parent’s', () => {
    expect(lineageModelLabel({ provider: 'claude-code', model: 'opus' })).toBe('claude-code · opus')
    expect(lineageModelLabel({ provider: null, model: 'gpt-5' })).toBe('gpt-5')
    expect(lineageModelLabel({ provider: null, model: null })).toBeNull()
  })
})

describe('LineageList rendering', () => {
  const render = (subagents: SubagentSummary[], extra: { expanded?: boolean } = {}) =>
    renderToStaticMarkup(createElement(LineageList, {
      subagents,
      now: NOW,
      expanded: extra.expanded ?? false,
      onExpand: () => undefined,
      onOpen: () => undefined,
      onStop: () => undefined
    }))

  it('renders nothing for an empty list; the section collapses instead', () => {
    expect(render([])).toBe('')
  })

  it('renders running subagents with a live dot ahead of finished ones', () => {
    const html = render([
      subagent('done', { state: 'done', title: 'Finished job', updatedAt: minutesAgo(4) }),
      subagent('live', { title: 'Live job' })
    ])
    expect(html.indexOf('Live job')).toBeLessThan(html.indexOf('Finished job'))
    expect(html.match(/lineage-live/g)).toHaveLength(1)
    expect(html).toContain('4m ago')
    expect(html).toContain('Working')
  })

  it('opens a subagent from its row and offers Stop on running rows only', () => {
    const html = render([subagent('live', { title: 'Live job' }), subagent('done', { state: 'done', title: 'Finished job' })])
    expect(html.match(/class="lineage-row/g)).toHaveLength(2)
    expect(html.match(/title="Live job"/g)).toHaveLength(1)
    expect(html.match(/lineage-stop/g)).toHaveLength(1)
    expect(html).toContain('aria-label="Stop Live job"')
    expect(html).not.toContain('Stop Finished job')
  })

  it('shows the provider and model a subagent was given, and what it waits on', () => {
    const html = render([
      subagent('a', { provider: 'claude-code', model: 'opus' }),
      subagent('b', { state: 'waiting', waitingOn: [{ title: 'Helper', state: 'working' }] })
    ])
    expect(html).toContain('claude-code · opus')
    expect(html).toContain('Waiting on 1 subagent')
    expect(html.match(/lineage-model/g)).toHaveLength(1)
  })

  it('adds a "Show N more" row past five subagents and drops it when expanded', () => {
    const many = Array.from({ length: 7 }, (_, index) => subagent(`a${index}`, { createdAt: minutesAgo(index + 1) }))
    const collapsed = render(many)
    expect(collapsed).toContain('Show 2 more')
    expect(collapsed.match(/lineage-name/g)).toHaveLength(5)
    const expanded = render(many, { expanded: true })
    expect(expanded).not.toContain('Show')
    expect(expanded.match(/lineage-name/g)).toHaveLength(7)
  })
})

describe('LineageSection rendering', () => {
  const withStore = (patch: Parameters<typeof useAppStore.setState>[0], run: () => void) => {
    const initial = useAppStore.getInitialState()
    const before = { subagentsByParent: initial.subagentsByParent }
    useAppStore.setState(patch)
    Object.assign(initial, patch)
    try {
      run()
    } finally {
      useAppStore.setState(before)
      Object.assign(initial, before)
    }
  }

  it('collapses to one quiet line with no heading when the thread has no subagents', () => {
    const html = renderToStaticMarkup(createElement(LineageSection, { threadId: 't1', projectId: null }))
    expect(html).toContain('No subagents started yet')
    expect(html).not.toContain('side-card-section-title')
    expect(html).not.toContain('Lineage')
    expect(html).not.toContain('<ul')
    expect(html).toContain('data-thread-id="t1"')
  })

  it('reads the subagents the daemon reported for this thread, with the running count in its heading', () => {
    withStore({ subagentsByParent: { t1: [subagent('one'), subagent('two', { state: 'done' })], other: [subagent('x', { title: 'Elsewhere' })] } }, () => {
      const html = renderToStaticMarkup(createElement(LineageSection, { threadId: 't1', projectId: null }))
      expect(html).toContain('side-card-section-title">Lineage · 1 running<')
      expect(html).toContain('Task one')
      expect(html).toContain('Task two')
      expect(html).not.toContain('Elsewhere')
      expect(html).not.toContain('No subagents started yet')
      expect(html).not.toContain('Stop all')
    })
  })

  it('selects an empty list for a thread the daemon has not answered for', () => {
    const state = useAppStore.getState()
    expect(selectSubagents(state, 'unknown')).toEqual([])
    expect(selectSubagents(state, null)).toBe(selectSubagents(state, 'unknown'))
  })
})
