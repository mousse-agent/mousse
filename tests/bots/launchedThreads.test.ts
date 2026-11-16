/**
 * How a thread a bot started stands in its "Managing …" list when that thread's own turn has ended but subagents it
 * started still work or ask: it keeps the bot busy and stays out of Done until they finish, as the sidebar rolls it up.
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { launchedThreadsOf, watchLaunchedThreads, type LaunchedThreadMeta } from '../../src/mms/bots/launchedThreads'
import { launchedActive, type BotLaunchedThread } from '../../src/shared/bots/personal/chat'
import type { RunRecord } from '../../src/mms/run/types'

const NOW = '2026-11-15T10:00:00.000Z'
const run = (threadId: string, status: RunRecord['status']): RunRecord => ({ runId: `run:${threadId}`, threadId, status, requestedAt: NOW, startedAt: NOW, completedAt: NOW }) as RunRecord
const sub = (id: string, parent: string): LaunchedThreadMeta => ({ id, createdAt: NOW, lineage: { parentThreadId: parent, rootThreadId: 'launched', relationship: 'subagent' } })
// The bot's chat thread `home` started `launched`, whose turn ran and finished; `child` is its subagent, `grandchild` the child's.
const threads: LaunchedThreadMeta[] = [
  { id: 'launched', name: 'Bot chat: slash commands', createdAt: NOW, updatedAt: NOW, createdByThreadId: 'home' },
  sub('child', 'launched'),
  sub('grandchild', 'child')
]

describe('a thread the bot started, while its subagents still work', () => {
  const rows: Array<[string, { own?: RunRecord['status']; below?: Array<[string, RunRecord['status']]>; asks?: string[] }, BotLaunchedThread['status']]> = [
    ['its turn ended and nothing below it runs', {}, 'done'],
    ['its turn ended and a subagent runs', { below: [['child', 'running']] }, 'subagents'],
    ['its turn ended and a subagent waits its turn', { below: [['child', 'queued']] }, 'subagents'],
    ['its turn ended and a subagent is held by a usage limit', { below: [['child', 'paused']] }, 'subagents'],
    ['its turn ended and a nested subagent runs', { below: [['grandchild', 'running']] }, 'subagents'],
    ['its turn ended and a subagent asks the owner', { asks: ['child'] }, 'needs_input'],
    ['its own turn still runs beside a subagent', { own: 'running', below: [['child', 'running']] }, 'running']
  ]
  it.each(rows)('%s', (_name, state, status) => {
    const activeRuns = [...(state.own ? [run('launched', state.own)] : []), ...(state.below ?? []).map(([id, s]) => run(id, s))]
    const [listed] = launchedThreadsOf({
      creators: new Set(['home']),
      threads,
      activeRuns,
      lastRun: (id) => (id === 'launched' ? run('launched', 'completed') : undefined),
      asks: (id) => (state.asks ?? []).includes(id),
      willStart: () => true
    })
    expect(listed?.status).toBe(status)
    // Only an ended thread with nothing below it working sits under Done and leaves the bot free.
    expect(launchedActive(listed!)).toBe(status !== 'done')
  })

  it('a subagent\'s run changing, however deep, tells the chat thread that started the top of its chain', () => {
    const runs = new EventEmitter()
    const changed: string[] = []
    const byId = new Map(threads.map((thread) => [thread.id, thread]))
    const stop = watchLaunchedThreads({ runs, questions: new EventEmitter(), thread: (id) => byId.get(id), changed: (creator) => changed.push(creator) })
    runs.emit('event', { type: 'run.status', payload: run('grandchild', 'completed') })
    expect(changed).toEqual(['home'])
    stop()
  })
})

// A queued run nothing will start (its turn.start already came and went, as a bot's message to a thread on 15 Nov did)
// never makes the thread go: the bot is not "Managing" a thread that sits idle. One that will start still counts.
describe('a thread the bot started, with a queued run', () => {
  const rows: Array<[string, { own?: [RunRecord['status'], boolean]; below?: [RunRecord['status'], boolean] }, BotLaunchedThread['status'], boolean]> = [
    ['its queued run is about to start', { own: ['queued', true] }, 'queued', true],
    ['its queued run will never start', { own: ['queued', false] }, 'done', false],
    ['a subagent\'s queued run is about to start', { below: ['queued', true] }, 'subagents', true],
    ['a subagent\'s queued run will never start', { below: ['queued', false] }, 'done', false],
    ['its run works, whatever is queued behind it', { own: ['running', false] }, 'running', true]
  ]
  it.each(rows)('%s', (_name, state, status, going) => {
    const activeRuns = [...(state.own ? [run('launched', state.own[0])] : []), ...(state.below ? [run('child', state.below[0])] : [])]
    const starts = new Set([...(state.own?.[1] ? ['run:launched'] : []), ...(state.below?.[1] ? ['run:child'] : [])])
    const [listed] = launchedThreadsOf({
      creators: new Set(['home']),
      threads,
      activeRuns,
      lastRun: (id) => (id === 'launched' ? run('launched', 'completed') : undefined),
      asks: () => false,
      willStart: (queued) => starts.has(queued.runId)
    })
    expect(listed?.status).toBe(status)
    expect(launchedActive(listed!)).toBe(going)
  })
})

// An archived thread never makes the bot busy, whatever it left behind (a run that never ended, a question, a subagent):
// archiving one on 15 Nov left a queued run, and the bot said "Managing" it for a day.
describe('an archived thread the bot started', () => {
  const archived: LaunchedThreadMeta[] = [{ ...threads[0]!, settledAt: NOW }, ...threads.slice(1)]
  const rows: Array<[string, { own?: RunRecord['status']; below?: RunRecord['status']; asks?: string[] }]> = [
    ['a run of it still runs', { own: 'running' }],
    ['a run of it waits its turn', { own: 'queued' }],
    ['a run of it is held', { own: 'paused' }],
    ['it asks the owner', { asks: ['launched'] }],
    ['a subagent below it runs', { below: 'running' }],
    ['a subagent below it asks the owner', { asks: ['child'] }]
  ]
  // Archived below an unarchived thread: a subagent's leftovers never keep the thread above it going.
  it.each([['runs', { below: 'running' as const }], ['asks the owner', { asks: ['child'] }]])('is not managed because an archived subagent %s', (_name, state: { below?: RunRecord['status']; asks?: string[] }) => {
    const [listed] = launchedThreadsOf({
      creators: new Set(['home']),
      threads: [threads[0]!, { ...threads[1]!, settledAt: NOW }, threads[2]!],
      activeRuns: state.below ? [run('child', state.below)] : [],
      lastRun: (id) => (id === 'launched' ? run('launched', 'completed') : undefined),
      asks: (id) => (state.asks ?? []).includes(id),
      willStart: () => true
    })
    expect(listed?.status).toBe('done')
    expect(launchedActive(listed!)).toBe(false)
  })
  it.each(rows)('is not managed while %s', (_name, state) => {
    const activeRuns = [...(state.own ? [run('launched', state.own)] : []), ...(state.below ? [run('child', state.below)] : [])]
    const [listed] = launchedThreadsOf({
      creators: new Set(['home']),
      threads: archived,
      activeRuns,
      lastRun: (id) => (id === 'launched' ? run('launched', 'cancelled') : undefined),
      asks: (id) => (state.asks ?? []).includes(id),
      willStart: () => true
    })
    expect(listed?.threadId).toBe('launched')
    expect(launchedActive(listed!)).toBe(false)
  })
})
