/**
 * Rule 1 of issue #1454: ordinary threads never depend on bots.db. A bot work's projection in the run database
 * (`delegation/botWork.ts`) stays out of every generic delegation list, hold and Stop. Here the bots are not running (no
 * bot port, no bots.db): an ordinary thread's tree, hold and Stop are what they were, the bot's chat is not held by its
 * work, and the projection is changed by nothing but the bots.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { botWorkDelegationId, projectBotWork } from '../../src/mms/run/delegation/botWork'
import { childBusyInputs } from '../../src/mms/run/delegation/hold'
import { buildSubagentView } from '../../src/mms/run/delegation/subagentView'
import { Inbox } from '../../src/mms/run/Inbox'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

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
    expect(engine.delegations.get(botWorkDelegationId('act-9'))).toMatchObject({ status: 'running', result: null })
    expect(store.db.statement("SELECT COUNT(*) AS n FROM inbox WHERE thread_id IN ('home', 'work')").get()!.n).toBe(0)
  })
})
