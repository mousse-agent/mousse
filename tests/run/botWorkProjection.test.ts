/**
 * Rule 1 of issue #1454: ordinary threads never depend on bots.db. A bot work's projection in the run database
 * (`delegation/botWork.ts`) stays out of every generic delegation list, hold and Stop. Here the bots are not running (no
 * bot port, no bots.db): an ordinary thread's tree, hold and Stop are what they were, the bot's chat is not held by its
 * work, and the projection is changed by nothing but the bots.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { botWorkDelegationId, botWorkInto, projectBotWork } from '../../src/mms/run/delegation/botWork'
import { childBusyInputs } from '../../src/mms/run/delegation/hold'
import { buildSubagentView } from '../../src/mms/run/delegation/subagentView'
import { Inbox } from '../../src/mms/run/Inbox'
import { delegationFixture, type DelegationFixture } from './delegationFixture'
import { phase6Daemon, piAdapter, waitFor, type Phase6Daemon } from './phase6Fixture'

describe('a bot work\'s projection beside ordinary threads, with no bots here', () => {
  let fx: DelegationFixture | undefined
  afterEach(() => {
    fx?.dispose()
    fx = undefined
  })

  it('an ordinary thread\'s tree, hold and Stop are unchanged, and nothing but the bots touches the work\'s row', async () => {
    fx = delegationFixture()
    const { engine, store } = fx
    const parentRun = await fx.runningRun('parent')
    await fx.delegate(parentRun.runId, 'call-1')
    const tree = (threadId: string) => buildSubagentView({ delegations: engine.delegations, inbox: new Inbox(store), store, thread: (id) => ({ name: id }), hasPendingQuestion: () => false }, threadId)
    const before = { tree: tree('parent'), tasks: engine.delegations.listForParentThread('parent'), busy: childBusyInputs(store, 'parent') }
    expect(before.tree).toHaveLength(1)

    await fx.runningRun('home')
    projectBotWork(store, { activationId: 'act-9', homeThreadId: 'home', threadId: 'work', status: 'running', createdAt: '2026-11-27T10:00:00.000Z', endedAt: null })
    // Boot's pass over running delegations leaves it alone: it has no lineage, no runs and nothing to publish.
    engine.settleAllWaitingDelegations()

    expect(tree('parent')).toEqual(before.tree)
    expect(engine.delegations.listForParentThread('parent')).toEqual(before.tasks)
    expect(childBusyInputs(store, 'parent')).toEqual(before.busy)
    // The bot's chat is not held by its work, and no generic list takes the row.
    expect(childBusyInputs(store, 'home').runningOutboundDelegation).toBe(false)
    expect(engine.delegations.listForParentThread('home')).toEqual([])
    expect(engine.delegations.listForChildThread('work')).toEqual([])
    // A Stop for the work with no bots here has nowhere to go, and a Stop of its thread leaves the row alone.
    expect(await engine.stopBotWork('work')).toBe('no_port')
    expect(engine.noteBotWork('work', 'Only cordless ones.')).toBe('no_port')
    engine.stopSubtree({ threadId: 'work', reason: 'user' })
    // An ordinary thread is never a bot work's.
    expect(await engine.stopBotWork('parent')).toBeNull()
    expect(botWorkInto(store, 'work')).toMatchObject({ status: 'running', result: null })
    expect(store.db.statement("SELECT COUNT(*) AS n FROM inbox WHERE thread_id IN ('home', 'work')").get()!.n).toBe(0)
  })
})

describe('a bot work\'s row and the generic Stop paths, with a real orchestrator', () => {
  let home: string | undefined
  let daemon: Phase6Daemon | undefined
  let release: (() => void) | undefined
  const previousHome = process.env.MOUSSE_HOME
  afterEach(async () => {
    release?.()
    await daemon?.stop().catch(() => undefined)
    daemon = undefined
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  /** A bot's chat and its work's thread: the work's first turn ended, its second still runs; a spy port stands in for the bots. */
  async function world() {
    home = mkdtempSync(join(tmpdir(), 'mousse-bot-work-'))
    process.env.MOUSSE_HOME = home
    const held = new Promise<void>((resolve) => { release = resolve })
    const d = phase6Daemon(home, [piAdapter(async (input) => (input.prompt.includes('second') ? held.then(() => 'Done.') : 'First.'))])
    daemon = d
    const chat = d.store.createThread('Pip')
    const work = d.store.createThread('Compare vacuum cleaners')
    const stops: string[] = []
    d.engine.setBotPort({
      authorizeSubagent: () => ({ ok: false, code: 'none', message: 'none' }),
      reserveSubagent: () => undefined,
      onSubagentSettled: () => false,
      stopBotWork: async (activationId) => { stops.push(activationId); return 'stopped' }
    })
    await d.orch.send('first', false, { threadId: work.id, clientRequestId: 'first' })
    await waitFor(() => d.engine.getActiveRun(work.id) === null && d.engine.listRuns(work.id).length === 1, 'first turn ended')
    const ended = d.engine.listRuns(work.id)[0]!.runId
    // Its turn is held until the test ends, so the send is not awaited.
    void d.orch.send('second', false, { threadId: work.id, clientRequestId: 'second' })
    await waitFor(() => d.engine.getActiveRun(work.id) !== null, 'second turn running')
    const current = d.engine.getActiveRun(work.id)!.runId
    projectBotWork(d.engine.store, { activationId: 'act-9', homeThreadId: chat.id, threadId: work.id, status: 'running', createdAt: '2026-11-27T10:00:00.000Z', endedAt: null })
    return { d, chat, work, stops, ended, current }
  }

  it('task_cancel on the work\'s row is refused: no generic path reaches it, and the work runs on', async () => {
    const w = await world()
    await expect(w.d.orch.cancelDelegation(w.chat.id, botWorkDelegationId('act-9'))).rejects.toThrow(/Unknown delegation/)
    expect(() => w.d.engine.acknowledgeDelegation(botWorkDelegationId('act-9'))).toThrow(/Unknown delegation/)
    expect(w.d.engine.getActiveRun(w.work.id)?.runId).toBe(w.current)
    expect(botWorkInto(w.d.engine.store, w.work.id)).toMatchObject({ status: 'running' })
    expect(w.stops).toEqual([])
  })

  it('a stale abort naming the work thread\'s ended run leaves the current work running', async () => {
    const w = await world()
    const result = await w.d.orch.abortRun(w.ended, 'stale-stop', w.work.id)
    expect(result.status).toBe('ignored')
    expect(w.stops).toEqual([])
    expect(w.d.engine.getActiveRun(w.work.id)?.runId).toBe(w.current)
    // Naming the running one reaches the bots.
    expect((await w.d.orch.abortRun(w.current, 'stop', w.work.id)).status).toBe('accepted')
    expect(w.stops).toEqual(['act-9'])
  })
})
