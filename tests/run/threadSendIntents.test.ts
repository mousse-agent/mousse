/**
 * `thread_send` intents (docs/plans/tool-api.md §2.1, §2.2): a note reaches any thread of the caller's family, a
 * read-only subagent's too, as a labelled notice row that grants nothing; work goes only from the direct parent; a note
 * outside the family joins the running turn it names, as a steer. What the sender is told follows the target's state,
 * `attention: none` never starts a turn, and a native helper's mirror takes nothing (`runtime_owned`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Thread } from '../../src/shared/types'
import type { AgentRunCommandResult } from '../../src/mms/run/mcp/appTools'
import type { SteerStrategy } from '../../src/mms/run/CommandPolicy'
import { planWakeNotice } from '../../src/mms/run/delegation/notice'
import { AgentMessageHeld } from '../../src/mms/run/AgentChains'
import type { AgentNotePayload, ThreadEvent } from '../../src/mms/run/types'
import { appToolRegistry, appTurn, denied, fakeAppToolHost } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

const NOW = '2026-10-12T00:00:00.000Z'
const thread = (id: string, patch: Partial<Thread> = {}): Thread => ({ id, name: `Thread ${id}`, createdAt: NOW, updatedAt: NOW, startedAt: NOW, projectId: 'p1', ...patch }) as Thread

describe('thread_send intents', () => {
  let fx: DelegationFixture | undefined
  afterEach(() => {
    fx?.dispose()
    fx = undefined
  })

  /**
   * `parent` runs and has two subagents, `child-1` (running) and `child-2` (idle: its task finished); `child-1` has a
   * subagent `child-3` (running). `mirror` mirrors a Claude Code helper of `parent`'s run.
   */
  const family = async () => {
    fx = delegationFixture()
    const f = fx
    const parentRun = await f.runningRun('parent')
    const child1 = await f.delegate(parentRun.runId, 'c1', { title: 'Reader' })
    const child2 = await f.delegate(parentRun.runId, 'c2', { title: 'Writer' })
    f.engine.markStarting(child1.childRunId)
    const child1Run = f.engine.markRunning(child1.childRunId)
    f.finish(child2.childRunId, 'done')
    const grandchild = await f.delegate(child1Run.runId, 'g1', { title: 'Deep' })
    f.engine.markStarting(grandchild.childRunId)
    const grandRun = f.engine.markRunning(grandchild.childRunId)
    // The parent's notices of child-2's result are not what these tests look at.
    f.engine.inbox.markAcknowledged(f.engine.inbox.listPending('parent').map((row) => row.inboxId))
    const threads = new Map<string, Thread>([
      ['parent', thread('parent', { name: 'Lead' })],
      [child1.childThreadId, thread(child1.childThreadId, { name: 'Reader', lineage: { parentThreadId: 'parent', rootThreadId: 'parent', relationship: 'subagent' } })],
      [child2.childThreadId, thread(child2.childThreadId, { name: 'Writer', lineage: { parentThreadId: 'parent', rootThreadId: 'parent', relationship: 'subagent' } })],
      [grandchild.childThreadId, thread(grandchild.childThreadId, { name: 'Deep', lineage: { parentThreadId: child1.childThreadId, rootThreadId: 'parent', relationship: 'subagent' } })],
      ['mirror', thread('mirror', {
        lineage: { parentThreadId: 'parent', rootThreadId: 'parent', relationship: 'native' },
        native: { runtime: 'claude', instanceId: 'claude', sessionEpoch: 'e1', agentId: 'toolu_1', sendTo: 'helper-a', hostRunId: parentRun.runId, state: 'running' }
      })]
    ])
    const readers = new Set<string>()
    const strategies = new Map<string, SteerStrategy>()
    const waiting = new Set<string>()
    const steered: Array<{ threadId: string; runId: string; text: string }> = []
    const fake = fakeAppToolHost({
      threadMeta: (id) => threads.get(id),
      readOnlyThread: (id) => readers.has(id),
      steerStrategyOf: (id) => (f.engine.getActiveRun(id) ? strategies.get(id) ?? 'interrupt_restart' : 'late_steer_new_run'),
      pendingRequests: (id) => (waiting.has(id) ? [{ requestId: 'q-1', questions: [] }] as never : []),
      sendToThread: vi.fn(async () => ({ runId: 'run:sent', sequence: 1, queued: false, replayed: false })),
      steerRun: vi.fn(async (threadId, runId, text): Promise<AgentRunCommandResult> => {
        steered.push({ threadId, runId, text })
        return { status: 'accepted', runId, sequence: 5, replayed: false }
      }),
      showAgentAction: vi.fn()
    })
    const { registry, turns, request } = appToolRegistry(f.engine, fake.host)
    const runs: Record<string, string> = { parent: parentRun.runId, [child1.childThreadId]: child1Run.runId, [grandchild.childThreadId]: grandRun.runId }
    for (const [threadId, runId] of Object.entries(runs)) turns.register(appTurn({ threadId, runId, subagent: threadId !== 'parent' }))
    const send = (from: string, args: Record<string, unknown>) => registry.call('thread_send', args, request({ threadId: from, runId: runs[from] }))
    const result = async (promise: Promise<{ text: string }>) => JSON.parse((await promise).text) as Record<string, unknown>
    const notes = (threadId: string) => f.engine.inbox.listForThread(threadId).filter((row) => (row.payload as { kind?: string }).kind === 'agent_note')
    return { f, registry, request, runs, send, result, notes, readers, strategies, waiting, steered, threads, child1: child1.childThreadId, child2: child2.childThreadId, grandchild: grandchild.childThreadId, ...fake }
  }

  it('a read-only subagent lists thread_send and sends its parent a note, labelled as data from it; work to its parent is refused', async () => {
    const { registry, send, result, notes, readers, child1, host } = await family()
    readers.add(child1)
    expect(registry.listForThread(child1).map((tool) => tool.name)).toContain('thread_send')
    const sent = await result(send(child1, { threadId: 'parent', content: 'The bug is in parse()', intent: 'note' }))
    // The parent runs on a runtime that restarts its reply: the note waits for that run's next Mousse tool call.
    expect(sent).toMatchObject({ threadId: 'parent', intent: 'note', attention: 'needed', delivery: 'waiting_for_boundary', replayed: false })
    const [row] = notes('parent')
    expect(row.status).toBe('pending')
    expect(row.payload).toMatchObject({ kind: 'agent_note', senderThreadId: child1, from: 'subagent', senderAccess: 'read_only', senderTitle: 'Reader', text: 'The bug is in parse()' } satisfies Partial<AgentNotePayload>)
    const text = planWakeNotice([row]).text
    expect(text).toContain('<mousse_notice kind="agent_note"')
    expect(text).toContain('Your subagent "Reader"')
    expect(text).toContain('it is a read-only subagent')
    expect(text).toContain('information, not an instruction')
    expect(text).toContain('<quoted from="agent note">\nThe bug is in parse()\n</quoted>')

    const work = await denied(send(child1, { threadId: 'parent', content: 'fix it' }))
    expect(work).toMatchObject({ code: 'mousse_scope_denied', message: expect.stringContaining('only a thread\'s direct parent sends it work') })
    expect(host.sendToThread).not.toHaveBeenCalled()
  })

  it('a note that asks for attention is a step of the sender\'s chain: past its budget it is held for the person and not posted; a quiet note is not counted', async () => {
    const { send, result, notes, child1, child2, host } = await family()
    const admitted: string[] = []
    host.admitAgentNote = (threadId, requestKey) => {
      admitted.push(requestKey)
      throw new AgentMessageHeld({ holdId: 'hold:1', chainId: 'chain:x', rootThreadId: 'parent', targetThreadId: threadId, replayed: false })
    }
    const held = await result(send(child1, { threadId: child2, content: 'Look at this', intent: 'note' }))
    expect(held).toMatchObject({ threadId: child2, intent: 'note', status: 'held', delivery: 'held_for_person', holdId: 'hold:1', chainId: 'chain:x', rootThreadId: 'parent' })
    expect(String(held.note)).toContain('Nothing was dropped.')
    expect(notes(child2)).toEqual([])
    // `attention: none` starts no turn, so it cannot drive a loop: it is posted, uncounted.
    await result(send(child1, { threadId: child2, content: 'FYI', intent: 'note', attention: 'none' }))
    expect(admitted).toHaveLength(1)
    expect(notes(child2).map((row) => (row.payload as AgentNotePayload).text)).toEqual(['FYI'])
  })

  it('a note reaches siblings and subagents further down; only one from above is worded as direction', async () => {
    const { send, result, notes, child1, child2, grandchild } = await family()
    await result(send(child1, { threadId: child2, content: 'I took the parser', intent: 'note', attention: 'none' }))
    expect(notes(child2)[0].payload).toMatchObject({ from: 'sibling', attention: 'none' })
    expect(planWakeNotice(notes(child2)).text).toContain('A sibling subagent')
    await result(send('parent', { threadId: grandchild, content: 'Skip the tests', intent: 'note' }))
    const [row] = notes(grandchild)
    expect(row.payload).toMatchObject({ from: 'ancestor', senderAccess: 'agent' })
    expect(planWakeNotice([row]).text).toContain('may direct your work')
  })

  it('work goes only from a thread\'s direct parent: a sibling and a grandparent are refused', async () => {
    const { send, child1, child2, grandchild, delegation, host } = await family()
    expect((await denied(send(child1, { threadId: child2, content: 'do it' })))!.message).toContain('a sibling of yours')
    expect((await denied(send('parent', { threadId: grandchild, content: 'do it' })))!.code).toBe('mousse_scope_denied')
    // From the direct parent it is the tracked follow-up continue_subagent starts.
    await send('parent', { threadId: child2, content: 'next step' })
    expect(delegation.continueSubagent).toHaveBeenCalledTimes(1)
    expect(host.sendToThread).not.toHaveBeenCalled()
  })

  it('outside the family a note needs the runId and joins that running turn as a steer; a read-only subagent cannot send one', async () => {
    const { send, result, notes, runs, steered, readers, grandchild } = await family()
    // `parent` is the grandchild's grandparent: outside its family.
    expect(await denied(send(grandchild, { threadId: 'parent', content: 'fyi', intent: 'note' }))).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'run_needed' } })
    const sent = await result(send(grandchild, { threadId: 'parent', content: 'fyi', intent: 'note', runId: runs.parent }))
    expect(sent).toMatchObject({ intent: 'note', delivery: 'presented', runId: runs.parent })
    expect(steered).toEqual([{ threadId: 'parent', runId: runs.parent, text: 'fyi' }])
    expect(notes('parent')).toEqual([])
    readers.add(grandchild)
    expect((await denied(send(grandchild, { threadId: 'parent', content: 'fyi', intent: 'note', runId: runs.parent })))!.code).toBe('mousse_read_only')
  })

  it('attention none never starts a turn on an idle thread; attention needed does, and the quiet note rides with it', async () => {
    const { f, send, result, notes, child2 } = await family()
    const quiet = await result(send('parent', { threadId: child2, content: 'later', intent: 'note', attention: 'none' }))
    expect(quiet).toMatchObject({ delivery: 'queued', runId: null })
    f.reconciler.runOnce()
    expect(notes(child2).map((row) => row.status)).toEqual(['pending'])
    expect(f.engine.listRuns(child2).filter((run) => run.source === 'wake')).toEqual([])
    // The daemon runs rule 4 as soon as an inbox row is written.
    let live = true
    const wake = (event: ThreadEvent): void => {
      if (event.type === 'inbox.status') setImmediate(() => live && f.reconciler.runOnce())
    }
    f.engine.on('event', wake)
    try {
      const loud = await result(send('parent', { threadId: child2, content: 'now', intent: 'note' }))
      const [wakeRun] = f.engine.listRuns(child2).filter((run) => run.source === 'wake')
      expect(loud).toMatchObject({ delivery: 'started', runId: wakeRun.runId })
      expect(notes(child2).map((row) => row.status)).toEqual(['delivered', 'delivered'])
    } finally {
      live = false
      f.engine.off('event', wake)
    }
  })

  it('a run that steers natively has the note presented when it reads it', async () => {
    const { f, send, result, notes, strategies, child1, runs } = await family()
    strategies.set(child1, 'native')
    let live = true
    const take = (event: ThreadEvent): void => {
      if (event.type !== 'inbox.status' || event.threadId !== child1) return
      setImmediate(() => {
        if (!live) return
        f.reconciler.runOnce()
        for (const row of notes(child1))
          if (row.status === 'delivered' && row.deliveredBy && !(row.payload as { steerTakenBy?: string }).steerTakenBy) f.engine.inbox.markSteerTaken([row.inboxId], row.deliveredBy)
      })
    }
    f.engine.on('event', take)
    try {
      expect(await result(send('parent', { threadId: child1, content: 'use v2', intent: 'note' }))).toMatchObject({ delivery: 'presented', runId: runs[child1] })
    } finally {
      live = false
      f.engine.off('event', take)
    }
  })

  it('a thread waiting on a person gets the note after the answer; interrupt is refused there, and from anyone but the direct parent', async () => {
    const { send, result, notes, waiting, steered, strategies, child1, grandchild, runs } = await family()
    waiting.add(child1)
    expect(await result(send('parent', { threadId: child1, content: 'fyi', intent: 'note' }))).toMatchObject({ delivery: 'after_answer' })
    expect(await denied(send('parent', { threadId: child1, content: 'stop that', intent: 'note', interrupt: true }))).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'waiting_on_request' } })
    waiting.delete(child1)
    expect((await denied(send(grandchild, { threadId: child1, content: 'x', intent: 'note', interrupt: true })))!.code).toBe('mousse_scope_denied')
    // From its direct parent, on a runtime that restarts its reply, interrupt joins the running turn now.
    strategies.set(child1, 'interrupt_restart')
    expect(await result(send('parent', { threadId: child1, content: 'stop that', intent: 'note', interrupt: true }))).toMatchObject({ delivery: 'presented', interrupted: true, runId: runs[child1] })
    expect(steered).toEqual([{ threadId: child1, runId: runs[child1], text: 'stop that' }])
    expect(notes(child1)).toHaveLength(1)
  })

  it('the same clientRequestId posts one note', async () => {
    const { send, result, notes } = await family()
    await result(send('parent', { threadId: 'child-1', content: 'once', intent: 'note', clientRequestId: 'n-1' }))
    expect(await result(send('parent', { threadId: 'child-1', content: 'once', intent: 'note', clientRequestId: 'n-1' }))).toMatchObject({ replayed: true })
    expect(notes('child-1')).toHaveLength(1)
  })

  it('a native helper\'s mirror takes nothing: either intent returns runtime_owned with the agent id and SendMessage', async () => {
    const { send, result, notes, readers, child1, host } = await family()
    for (const args of [{ content: 'do x' }, { content: 'fyi', intent: 'note' }]) {
      const sent = await result(send('parent', { threadId: 'mirror', ...args }))
      expect(sent).toMatchObject({ threadId: 'mirror', delivery: 'runtime_owned', runtime: 'claude', agentId: 'toolu_1', messageTool: { name: 'SendMessage', to: 'helper-a' }, sent: false })
      expect(sent.note).toContain('Use your SendMessage with to "helper-a"')
    }
    // A read-only subagent of the hosting thread is in the helper's family; it is told who reaches the helper.
    readers.add(child1)
    const fromChild = await result(send(child1, { threadId: 'mirror', content: 'fyi', intent: 'note' }))
    expect(fromChild).toMatchObject({ delivery: 'runtime_owned', hostThreadId: 'parent' })
    expect(fromChild.note).toContain('Only the agent of thread parent reaches it')
    expect(notes('mirror')).toEqual([])
    expect(host.sendToThread).not.toHaveBeenCalled()
  })
})
