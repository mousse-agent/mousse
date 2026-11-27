/**
 * How a thread a bot started stands in its "Managing …" list when that thread's own turn has ended but subagents it
 * started still work or ask: it keeps the bot busy and stays out of Done until they finish, as the sidebar rolls it up.
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { launchedThreadsIn, launchedThreadsOf, launchedHereAndThere, remoteLaunchedThreadsOf, runStanding, watchLaunchedThreads, withRemoteLaunched, type LaunchedThreadMeta, type RunStanding } from '../../src/mms/bots/launchedThreads'
import { launchedActive, launchedGoing, type BotLaunchedThread } from '../../src/shared/bots/personal/chat'
import type { EffectRecord, RunPause, RunRecord } from '../../src/mms/run/types'
import type { QueuedMessage, Thread, ThreadActivitySnapshot } from '../../src/shared/types'

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
      standing: () => 'goes'
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

// The bot's "Recent" list (`doneSince`, six hours back in the app): an archived thread leaves it at once and one not updated
// since drops off, so it no longer reads "Done 30" forever. What still goes is listed whatever its age; a job's ledger (no `doneSince`) still
// reads an archived or old thread.
describe("the bot's Recent list", () => {
  const SINCE = '2026-11-14T10:00:00.000Z'
  const OLD = '2026-11-14T09:59:59.999Z'
  const meta = (id: string, more: Partial<LaunchedThreadMeta> = {}): LaunchedThreadMeta => ({ id, name: id, createdAt: OLD, updatedAt: NOW, createdByThreadId: 'home', ...more })
  const rows: Array<[string, LaunchedThreadMeta, RunRecord['status'] | undefined, boolean]> = [
    ['an ended thread updated since is listed', meta('recent'), undefined, true],
    ['an ended thread updated exactly then is listed', meta('edge', { updatedAt: SINCE }), undefined, true],
    ['an ended thread updated before is not', meta('stale', { updatedAt: OLD }), undefined, false],
    ['a thread that never ran, made before, is not', meta('never', { updatedAt: undefined }), undefined, false],
    ['an archived thread is not, however recent', meta('archived', { archivedAt: NOW }), undefined, false],
    ['a thread still working is listed however old', meta('working', { updatedAt: OLD }), 'running', true]
  ]
  const list = (thread: LaunchedThreadMeta, own: RunRecord['status'] | undefined, doneSince?: string) => launchedThreadsOf({
    creators: new Set(['home']),
    threads: [thread],
    activeRuns: own ? [run(thread.id, own)] : [],
    lastRun: (id) => (id === thread.id ? run(id, 'completed') : undefined),
    asks: () => false,
    standing: () => 'goes',
    ...(doneSince ? { doneSince } : {})
  }).map((listed) => listed.threadId)
  it.each(rows)('%s', (_name, thread, own, shown) => {
    expect(list(thread, own, SINCE)).toEqual(shown ? [thread.id] : [])
    expect(list(thread, own)).toEqual([thread.id])
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
      standing: (queued) => (queued.status !== 'queued' || starts.has(queued.runId) ? 'goes' : 'never')
    })
    expect(listed?.status).toBe(status)
    expect(launchedActive(listed!)).toBe(going)
  })
})

// An archived thread never makes the bot busy, whatever it left behind (a run that never ended, a question, a subagent):
// archiving one on 15 Nov left a queued run, and the bot said "Managing" it for a day.
describe('an archived thread the bot started', () => {
  const archived: LaunchedThreadMeta[] = [{ ...threads[0]!, archivedAt: NOW }, ...threads.slice(1)]
  const rows: Array<[string, { own?: RunRecord['status']; below?: RunRecord['status']; asks?: string[]; standing?: RunStanding }]> = [
    ['a run of it still runs', { own: 'running' }],
    ['a run of it waits its turn', { own: 'queued' }],
    ['a run of it is held', { own: 'paused' }],
    ['a run of it is on hold for the owner', { own: 'paused', standing: 'held' }],
    ['it asks the owner', { asks: ['launched'] }],
    ['a subagent below it runs', { below: 'running' }],
    ['a subagent below it asks the owner', { asks: ['child'] }]
  ]
  // Archived below an unarchived thread: a subagent's leftovers never keep the thread above it going.
  it.each([['runs', { below: 'running' as const }], ['asks the owner', { asks: ['child'] }]])('is not managed because an archived subagent %s', (_name, state: { below?: RunRecord['status']; asks?: string[] }) => {
    const [listed] = launchedThreadsOf({
      creators: new Set(['home']),
      threads: [threads[0]!, { ...threads[1]!, archivedAt: NOW }, threads[2]!],
      activeRuns: state.below ? [run('child', state.below)] : [],
      lastRun: (id) => (id === 'launched' ? run('launched', 'completed') : undefined),
      asks: (id) => (state.asks ?? []).includes(id),
      standing: () => 'goes'
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
      standing: () => state.standing ?? 'goes'
    })
    expect(listed?.threadId).toBe('launched')
    expect(launchedActive(listed!)).toBe(false)
    expect(launchedGoing(listed!)).toBe(false)
  })
})

// A thread that only a person can move on (a pause only Resume now ends, messages a Stop held for Send now) never keeps
// the bot busy: it is on hold, listed with what waits on the owner. On 15 Nov a paused thread kept a bot "Managing" it.
// Each run is given with how it stands (`runStanding`), oldest first.
describe('a thread the bot started, paused or held for the owner', () => {
  type Runs = Array<[string, RunRecord['status'], RunStanding]>
  const rows: Array<[string, { runs: Runs; asks?: string[] }, BotLaunchedThread['status'], boolean]> = [
    ['its pause resumes by itself', { runs: [['launched', 'paused', 'goes']] }, 'paused', true],
    ['its pause only a person ends', { runs: [['launched', 'paused', 'held']] }, 'on_hold', false],
    ['a message waits behind a pause that resumes by itself', { runs: [['launched', 'paused', 'goes'], ['launched', 'queued', 'waits']] }, 'paused', true],
    ['a message waits behind a pause only a person ends', { runs: [['launched', 'paused', 'held'], ['launched', 'queued', 'waits']] }, 'on_hold', false],
    ['a Stop held its message for Send now', { runs: [['launched', 'queued', 'held']] }, 'on_hold', false],
    ['a message waits in the queue with no pause ahead of it (a compaction, a lease)', { runs: [['launched', 'queued', 'waits']] }, 'queued', true],
    ['its pause only a person ends, and it asks the owner', { runs: [['launched', 'paused', 'held']], asks: ['launched'] }, 'needs_input', true],
    ['its pause only a person ends, while a subagent works', { runs: [['launched', 'paused', 'held'], ['child', 'running', 'goes']] }, 'subagents', true],
    ['its turn ended, and a subagent\'s pause only a person ends', { runs: [['child', 'paused', 'held']] }, 'on_hold', false],
    ['its turn ended, a subagent is on hold and another below works', { runs: [['child', 'paused', 'held'], ['grandchild', 'running', 'goes']] }, 'subagents', true]
  ]
  it.each(rows)('%s', (_name, state, status, busy) => {
    const runs = state.runs.map(([threadId, runStatus], index) => ({ ...run(threadId, runStatus), runId: `run:${index}`, ordinal: index }))
    const standings = new Map(state.runs.map(([, , standing], index) => [`run:${index}`, standing]))
    const [listed] = launchedThreadsOf({
      creators: new Set(['home']),
      threads,
      activeRuns: runs,
      lastRun: (id) => (id === 'launched' ? run('launched', 'completed') : undefined),
      asks: (id) => (state.asks ?? []).includes(id),
      standing: (each) => standings.get(each.runId)!
    })
    expect(listed?.status).toBe(status)
    expect(launchedActive(listed!)).toBe(busy)
    // On hold or not, it is listed with what still goes, never under Done.
    expect(launchedGoing(listed!)).toBe(true)
  })
})

// How a run that has not ended stands, read from the Run Engine's effects and the thread's saved queue.
describe('how a run of a thread the bot started stands', () => {
  const effect = (kind: string, status: EffectRecord['status']): EffectRecord => ({ effectId: `${kind}:${status}`, runId: 'run:x', kind, status }) as EffectRecord
  const item = (id: string, extra: Partial<QueuedMessage> = {}): QueuedMessage => ({ id, threadId: 'launched', content: 'Also the signup page.', state: 'pending', intent: 'normal', order: 0, enqueuedAt: NOW, ...extra }) as QueuedMessage
  const pause = (extra: Partial<RunPause> = {}): RunPause => ({ reason: 'usage_limit', until: NOW, estimated: false, count: 1, autoResume: true, ...extra })
  // `effects`: the run's own; `others`: those of runs whose messages wait ahead of it.
  type Case = { status: RunRecord['status']; pause?: RunPause; effects?: EffectRecord[]; others?: Record<string, EffectRecord[]>; queue?: QueuedMessage[]; remote?: true }
  const rows: Array<[string, Case, RunStanding]> = [
    ['it runs', { status: 'running' }, 'goes'],
    ['a usage limit paused it and its timer resumes it', { status: 'paused', pause: pause() }, 'goes'],
    ['its timer was dropped as stale (Mousse was off past the reset)', { status: 'paused', pause: pause({ autoResume: false, stale: true }) }, 'held'],
    ['automatic resume is off', { status: 'paused', pause: pause({ autoResume: false }) }, 'held'],
    ['automatic resume is off and Resume now waits to run', { status: 'paused', pause: pause({ autoResume: false }), effects: [effect('run.resume', 'pending')] }, 'goes'],
    ['automatic resume is off and Resume now runs', { status: 'paused', pause: pause({ stale: true, autoResume: false }), effects: [effect('run.resume', 'running')] }, 'goes'],
    ['Resume now queued its continue message', { status: 'paused', pause: pause({ autoResume: false, resumeItemId: 'resume:run:x', resumeRequested: 'user' }), effects: [effect('run.resume', 'done')], queue: [item('resume:run:x', { internal: true })] }, 'goes'],
    ['Resume now\'s continue message is gone', { status: 'paused', pause: pause({ autoResume: false, resumeItemId: 'resume:run:x', resumeRequested: 'user' }), effects: [effect('run.resume', 'done')], queue: [] }, 'held'],
    ['queued, its turn.start waits', { status: 'queued', effects: [effect('turn.start', 'pending')] }, 'goes'],
    ['queued, its turn.start runs', { status: 'queued', effects: [effect('turn.start', 'running')] }, 'goes'],
    ['queued, every turn.start it had ended', { status: 'queued', effects: [effect('turn.start', 'cancelled'), effect('turn.start', 'failed')] }, 'never'],
    ['queued for a remote subagent', { status: 'queued', remote: true }, 'goes'],
    ['queued in the message queue', { status: 'queued', queue: [item('q1', { runId: 'run:x' })] }, 'waits'],
    ['queued, its send not recorded in the queue yet', { status: 'queued', queue: [] }, 'waits'],
    ['queued, a Stop held its message', { status: 'queued', queue: [item('q1', { runId: 'run:x', heldAfterStop: true })] }, 'held'],
    ['queued, sent after a Stop held the others', { status: 'queued', queue: [item('q0', { runId: 'run:w', heldAfterStop: true, order: 1 }), item('q1', { runId: 'run:x', order: 0 })] }, 'waits'],
    // A thread waiting on workspace recovery refuses the turn: the drain gives the message back, and the queue stops there.
    ['queued, its turn could not start and its message is back in the queue', { status: 'queued', effects: [effect('turn.start', 'succeeded')], queue: [item('q1', { runId: 'run:x' })] }, 'held'],
    ['queued behind a message whose turn could not start', { status: 'queued', others: { 'run:w': [effect('turn.start', 'succeeded')] }, queue: [item('q0', { runId: 'run:w', order: 0 }), item('q1', { runId: 'run:x', order: 1 })] }, 'held'],
    ['queued behind a message whose turn starts now', { status: 'queued', others: { 'run:w': [effect('turn.start', 'running')] }, queue: [item('q0', { runId: 'run:w', order: 0 }), item('q1', { runId: 'run:x', order: 1 })] }, 'waits'],
    ['queued ahead of a message whose turn could not start', { status: 'queued', others: { 'run:w': [effect('turn.start', 'succeeded')] }, queue: [item('q1', { runId: 'run:x', order: 0 }), item('q2', { runId: 'run:w', order: 1 })] }, 'waits']
  ]
  it.each(rows)('%s', (_name, state, standing) => {
    const engine = {
      outbox: { listForRun: (runId: string) => (runId === 'run:x' ? state.effects ?? [] : state.others?.[runId] ?? []) },
      remoteSubagents: { getByChildRun: (runId: string) => (state.remote && runId === 'run:x' ? {} : undefined) }
    } as unknown as Parameters<typeof runStanding>[0]
    const record = { ...run('launched', state.status), runId: 'run:x', ...(state.pause ? { outcome: { pause: state.pause } } : {}) } as RunRecord
    expect(runStanding(engine, record, () => state.queue ?? [])).toBe(standing)
  })

  it('the service reads a queue at most once per listing, only for a run that may wait on a person, and never for a thread the bot did not start', () => {
    const reads: string[] = []
    const runs = [
      { ...run('launched', 'queued'), runId: 'run:q1', ordinal: 1 },
      { ...run('launched', 'queued'), runId: 'run:q2', ordinal: 2 },
      { ...run('child', 'running'), runId: 'run:c', ordinal: 1 },
      { ...run('someone-else', 'queued'), runId: 'run:other', ordinal: 1 }
    ]
    const listed = launchedThreadsIn({
      threads: { listAllThreads: () => [...threads, { id: 'someone-else', createdAt: NOW }], loadMessageQueue: (id) => { reads.push(id); return [] } },
      engine: {
        store: { listNonTerminalRuns: () => runs, listRuns: () => [] },
        outbox: { listForRun: () => [] },
        remoteSubagents: { getByChildRun: () => undefined }
      } as unknown as Parameters<typeof launchedThreadsIn>[0]['engine'],
      asks: () => false
    }, new Set(['home']))
    expect(listed.map((thread) => [thread.threadId, thread.status])).toEqual([['launched', 'queued']])
    expect(reads).toEqual(['launched'])
  })
})

// A bot's thread_create with `computer` runs the thread on another computer: the merged lists name the bot on its row
// (`startedByBot`, from `startedFrom.agent`), and the bot's list shows it beside its threads here, by its status there.
describe('a thread the bot started on another computer', () => {
  const SINCE = '2026-11-14T10:00:00.000Z'
  const OLD = '2026-11-14T09:00:00.000Z'
  const bot = { botId: 'b1', name: 'Mousseroni' }
  const row = (id: string, more: Partial<Thread> = {}): Thread => ({
    id: `node-a:${id}`, name: id, createdAt: OLD, updatedAt: NOW, order: 0, node: 'node-a', projectId: 'node-a:p1',
    startedFrom: { node: 'self', agent: { thread: 'home', title: 'Mousseroni', mode: 'auto' } }, startedByBot: bot, ...more
  }) as Thread
  const list = (rows: Thread[], activity: ThreadActivitySnapshot = {}) => remoteLaunchedThreadsOf({
    creators: new Set(['home']),
    rows,
    activity,
    computerName: (node) => (node === 'node-a' ? 'AEONIX' : undefined),
    projectName: (id) => (id === 'node-a:p1' ? 'mousse' : undefined),
    doneSince: SINCE
  })
  const statuses: Array<[string, ThreadActivitySnapshot[string] | undefined, Partial<Thread>, BotLaunchedThread['status']]> = [
    ['working there', 'processing', {}, 'running'],
    ['its turn ended, its subagents still work there', 'waiting', {}, 'subagents'],
    ['it asks the owner there', 'awaiting_input', {}, 'needs_input'],
    ['held by a usage limit there', 'paused', {}, 'paused'],
    ['just finished there', 'completed', {}, 'done'],
    ['nothing runs there', undefined, {}, 'done'],
    ['that computer is offline', undefined, { offline: true }, 'idle'],
    ['archived there, whatever it did', 'processing', { archivedAt: NOW }, 'done']
  ]
  it.each(statuses)('%s', (_name, state, more, status) => {
    const [listed] = remoteLaunchedThreadsOf({ creators: new Set(['home']), rows: [row('t', more)], activity: state ? { 'node-a:t': state } : {} })
    expect(listed?.status).toBe(status)
  })

  it('keeps the bot busy while it works, and names the project and the computer', () => {
    const [listed] = list([row('t')], { 'node-a:t': 'processing' })
    expect(listed).toMatchObject({ threadId: 'node-a:t', title: 't', project: 'mousse on AEONIX', status: 'running' })
    expect(launchedActive(listed!)).toBe(true)
  })

  it('marks a thread hidden there as hidden, and leaves a shown one unmarked', () => {
    const [hidden, shown] = list([row('quiet', { hidden: true }), row('loud')])
    expect(hidden).toMatchObject({ threadId: 'node-a:quiet', hidden: true })
    expect(shown?.threadId).toBe('node-a:loud')
    expect(shown?.hidden).toBeUndefined()
  })

  const which: Array<[string, Thread, boolean]> = [
    ['started by the bot, working, however old', row('old-working', { updatedAt: OLD }), true],
    ['started by the bot, ended lately', row('recent'), true],
    ['started by the bot, ended before Recent', row('stale', { updatedAt: OLD }), false],
    ['started by the bot, archived', row('archived', { archivedAt: NOW }), false],
    ['started by another of its threads', row('other', { startedFrom: { node: 'self', agent: { thread: 'not-the-bot', title: 'x', mode: 'auto' } } }), false],
    ['started there by an agent here that is no bot', row('agent', { startedByBot: undefined }), false],
    ['a subagent there', row('sub', { lineage: { parentThreadId: 'node-a:t', rootThreadId: 'node-a:t', relationship: 'subagent' } }), false]
  ]
  it.each(which)('%s', (_name, thread, shown) => {
    const activity: ThreadActivitySnapshot = thread.id === 'node-a:old-working' ? { [thread.id]: 'processing' } : {}
    expect(list([thread], activity).map((listed) => listed.threadId)).toEqual(shown ? [thread.id] : [])
  })

  it('joins the threads here in one order, what works first', () => {
    const here: BotLaunchedThread = { threadId: 'local-done', title: 'here', status: 'done', startedAt: OLD, updatedAt: NOW }
    const there = list([row('t')], { 'node-a:t': 'processing' })
    expect(withRemoteLaunched([here], there).map((listed) => listed.threadId)).toEqual(['node-a:t', 'local-done'])
  })

  it('leaves only the threads here when the other computers cannot be read', () => {
    const here: BotLaunchedThread = { threadId: 'local', title: 'here', status: 'running', startedAt: OLD, updatedAt: NOW }
    const broken = { threads: () => { throw new Error('lists off') }, projects: () => [], activity: () => ({}) }
    expect(launchedHereAndThere([here], broken, new Set(['home']))).toEqual([here])
    expect(launchedHereAndThere([here], undefined, new Set(['home']))).toEqual([here])
  })
})
