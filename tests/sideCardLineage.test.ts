import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LINEAGE_CLOSED, LineageList, LineageSection, type LineageOpenParts } from '../src/renderer/components/sideCard/LineageSection'
import {
  LINEAGE_COLLAPSED_COUNT,
  LINEAGE_RUNNING_COUNT,
  countRunningSubagents,
  finishedGroupLabel,
  formatAgo,
  groupLineageSubagents,
  lineageModelLabel,
  lineageStatusLabel,
  lineageSubagentName,
  lineageTitle,
  orderLineageSubagents,
  sliceLineage,
  stopAllSubagents
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
    ['paused', true],
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

describe('groupLineageSubagents and finishedGroupLabel', () => {
  it('splits running from finished subagents, each in its own order', () => {
    const { running, finished } = groupLineageSubagents([
      subagent('old-done', { state: 'done', updatedAt: minutesAgo(50) }),
      subagent('live', { createdAt: minutesAgo(5) }),
      subagent('new-done', { state: 'failed', updatedAt: minutesAgo(1) }),
      subagent('asking', { state: 'needs_input', createdAt: minutesAgo(40) })
    ])
    expect(ids(running)).toEqual(['asking', 'live'])
    expect(ids(finished)).toEqual(['new-done', 'old-done'])
  })

  it('counts finished subagents and names failures', () => {
    expect(finishedGroupLabel([subagent('a', { state: 'done' })])).toBe('1 finished')
    expect(finishedGroupLabel([subagent('a', { state: 'done' }), subagent('b', { state: 'failed' }), subagent('c', { state: 'stopped' })])).toBe('3 finished · 1 failed')
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
    expect(label('paused')).toBe('Paused')
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
  const render = (subagents: SubagentSummary[], extra: { open?: Partial<LineageOpenParts>; inheritedProvider?: string } = {}) =>
    renderToStaticMarkup(createElement(LineageList, {
      subagents,
      now: NOW,
      inheritedProvider: extra.inheritedProvider ?? null,
      open: { ...LINEAGE_CLOSED, ...extra.open },
      onOpenPart: () => undefined,
      onOpen: () => undefined,
      onStop: () => undefined
    }))
  const finishedOpen = { open: { finished: true } }

  it('renders nothing for an empty list; the section collapses instead', () => {
    expect(render([])).toBe('')
  })

  it('renders running subagents ahead of finished ones, each with its provider icon and a status dot', () => {
    const html = render([
      subagent('done', { state: 'done', title: 'Finished job', updatedAt: minutesAgo(4), provider: 'codex' }),
      subagent('live', { title: 'Live job', provider: 'claude' }),
      subagent('failed', { state: 'failed', title: 'Broken job' }),
      subagent('asking', { state: 'needs_input', title: 'Asking job' })
    ], finishedOpen)
    expect(html.indexOf('Live job')).toBeLessThan(html.indexOf('Finished job'))
    expect(html.match(/class="subagent-avatar"/g)).toHaveLength(4)
    expect(html).toContain('background-color:#D97757')
    expect(html.match(/data-tone="running"/g)).toHaveLength(1)
    expect(html.match(/data-tone="done"/g)).toHaveLength(1)
    expect(html.match(/data-tone="failed"/g)).toHaveLength(1)
    expect(html.match(/data-tone="attention"/g)).toHaveLength(1)
    expect(html).toContain('4m ago')
    expect(html).toContain('Working')
  })

  it('folds finished subagents into one closed row with a count and the latest finish time', () => {
    const html = render([
      subagent('live', { title: 'Live job' }),
      subagent('done', { state: 'done', title: 'Finished job', updatedAt: minutesAgo(4) }),
      subagent('old', { state: 'failed', title: 'Broken job', updatedAt: minutesAgo(90) })
    ])
    expect(html).toContain('Live job')
    expect(html).not.toContain('Finished job')
    expect(html).not.toContain('Broken job')
    expect(html).toContain('2 finished · 1 failed')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('4m ago')
    expect(html.match(/class="subagent-avatar"/g)).toHaveLength(1)
  })

  it('opens the finished group in place, with its own "Show N more" past five', () => {
    const finished = Array.from({ length: 7 }, (_, index) => subagent(`d${index}`, { state: 'done', updatedAt: minutesAgo(index + 1) }))
    const opened = render(finished, finishedOpen)
    expect(opened).toMatch(/aria-expanded="true" aria-controls="[^"]+"/)
    expect(opened).toContain('class="lineage-list lineage-sublist"')
    expect(opened.match(/class="lineage-item"/g)).toHaveLength(5)
    expect(opened).toContain('Show 2 more')
    const all = render(finished, { open: { finished: true, finishedAll: true } })
    expect(all.match(/class="lineage-item"/g)).toHaveLength(7)
    expect(all).not.toContain('Show')
  })

  it('draws the thread provider for a subagent that inherited it', () => {
    const html = render([subagent('a', { provider: null })], { inheritedProvider: 'claude' })
    expect(html).toContain('background-color:#D97757')
    expect(render([subagent('a', { provider: null })])).toContain('<svg')
  })

  it('opens a subagent from its row and offers Stop on running rows only', () => {
    const html = render([subagent('live', { title: 'Live job' }), subagent('done', { state: 'done', title: 'Finished job' })], finishedOpen)
    expect(html.match(/class="lineage-item"/g)).toHaveLength(2)
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

  it('shows three running subagents with a "Show N more" row, and all of them once expanded', () => {
    expect(LINEAGE_RUNNING_COUNT).toBe(3)
    const many = Array.from({ length: 7 }, (_, index) => subagent(`a${index}`, { createdAt: minutesAgo(index + 1) }))
    const collapsed = render(many)
    expect(collapsed).toContain('Show 4 more')
    expect(collapsed.match(/lineage-name/g)).toHaveLength(3)
    const expanded = render(many, { open: { running: true } })
    expect(expanded).not.toContain('Show')
    expect(expanded.match(/lineage-name/g)).toHaveLength(7)
  })
})

describe('stopAllSubagents', () => {
  const fakeApi = (stopAll: () => Promise<unknown>) => {
    const aborted: string[] = []
    return { aborted, api: { stopAll, abort: async (id: string) => void aborted.push(id) } }
  }

  it('is one call to the daemon, and aborts nothing when it works', async () => {
    const { aborted, api } = fakeApi(async () => true)
    await stopAllSubagents(api, 't1', [subagent('a'), subagent('b', { state: 'done' })])
    expect(aborted).toEqual([])
  })

  it.each([
    ['the daemon rejection', Object.assign(new Error('Method not allowed: subagents.stopAll'), { code: 'method_not_allowed' })],
    ['the same rejection as the renderer sees it over IPC', new Error("Error invoking remote method 'subagents:stopAll': MmsProtocolError: Method not allowed: subagents.stopAll")]
  ])('falls back to stopping each working subagent for an older daemon (%s), never the thread', async (_name, error) => {
    const { aborted, api } = fakeApi(async () => { throw error })
    await stopAllSubagents(api, 't1', [subagent('a'), subagent('b', { state: 'done' }), subagent('c', { state: 'waiting' })])
    expect(aborted.sort()).toEqual(['a', 'c'])
  })

  it('does not retry from its own list after any other failure: the call may already have run on the daemon', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { aborted, api } = fakeApi(async () => { throw new Error('request timed out') })
    await stopAllSubagents(api, 't1', [subagent('a')])
    // Another method the daemon refused is not this one.
    const other = fakeApi(async () => { throw new Error('Method not allowed: orchestrator.abort') })
    await stopAllSubagents(other.api, 't1', [subagent('a')])
    expect(other.aborted).toEqual([])
    expect(aborted).toEqual([])
    expect(warned).toHaveBeenCalled()
    warned.mockRestore()
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
      expect(html).toContain('side-card-section-name">Lineage · 1 running<')
      expect(html).toContain('Task one')
      expect(html).toContain('1 finished')
      expect(html).not.toContain('Task two')
      expect(html).not.toContain('Elsewhere')
      expect(html).not.toContain('No subagents started yet')
    })
  })

  it('offers Stop all in the heading while any subagent runs, and not when none does', () => {
    const render = () => renderToStaticMarkup(createElement(LineageSection, { threadId: 't1', projectId: null }))
    withStore({ subagentsByParent: { t1: [subagent('one'), subagent('two', { state: 'done' })] } }, () => {
      const html = render()
      expect(html).toContain('class="side-card-section-head"')
      expect(html).toMatch(/side-card-section-name">Lineage · 1 running<\/span>.*?<\/h3><button[^>]*class="lineage-stop-all"[^>]*>Stop all<\/button>/)
      expect(html).toContain('aria-label="Stop all subagents"')
    })
    // A waiting subagent still runs; a finished one does not.
    withStore({ subagentsByParent: { t1: [subagent('one', { state: 'waiting' })] } }, () => expect(render()).toContain('Stop all'))
    withStore({ subagentsByParent: { t1: [subagent('one', { state: 'done' }), subagent('two', { state: 'stopped' })] } }, () => {
      const html = render()
      expect(html).not.toContain('Stop all')
      expect(html).not.toContain('lineage-stop-all')
    })
  })

  it('selects an empty list for a thread the daemon has not answered for', () => {
    const state = useAppStore.getState()
    expect(selectSubagents(state, 'unknown')).toEqual([])
    expect(selectSubagents(state, null)).toBe(selectSubagents(state, 'unknown'))
  })
})
