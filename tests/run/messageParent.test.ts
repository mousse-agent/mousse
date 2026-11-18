/**
 * `message_parent`: a thread messages its parent while it works. A subagent's message reaches its parent thread as a
 * note from it; a thread a personal bot started reaches that bot (`BotToolHost.jobs.message`, whose delivery is in
 * tests/bots/botJobs.test.ts). Only a thread with a parent lists it, and the same text again within the repeat window
 * is refused unless it is a retry of the same request.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Thread } from '../../src/shared/types'
import type { BotAppToolDeps } from '../../src/mms/run/mcp/appTools'
import { AGENT_QUEUE_MAX_PER_SENDER } from '../../src/mms/run/mcp/appTools/thread'
import type { AgentNotePayload } from '../../src/mms/run/types'
import { appToolRegistry, appTurn, denied, fakeAppToolHost } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

const NOW = '2026-11-18T00:00:00.000Z'
const thread = (id: string, patch: Partial<Thread> = {}): Thread => ({ id, name: `Thread ${id}`, createdAt: NOW, updatedAt: NOW, startedAt: NOW, projectId: 'p1', ...patch }) as Thread

describe('message_parent', () => {
  let fx: DelegationFixture | undefined
  afterEach(() => {
    fx?.dispose()
    fx = undefined
  })

  /** `parent` runs with a read-only subagent; `job` is a thread bot `b1` started; `plain` is a thread nobody started. */
  const world = async (message?: NonNullable<NonNullable<BotAppToolDeps['host']['jobs']>['message']>) => {
    fx = delegationFixture()
    const f = fx
    const parentRun = await f.runningRun('parent')
    const child = await f.delegate(parentRun.runId, 'c1', { title: 'Reader' })
    f.engine.markStarting(child.childRunId)
    const childRun = f.engine.markRunning(child.childRunId)
    const jobRun = await f.runningRun('job')
    const plainRun = await f.runningRun('plain')
    const threads = new Map<string, Thread>([
      ['parent', thread('parent', { name: 'Lead' })],
      [child.childThreadId, thread(child.childThreadId, { name: 'Reader', lineage: { parentThreadId: 'parent', rootThreadId: 'parent', relationship: 'subagent' } })],
      ['job', thread('job', { name: 'Fix login', createdByThreadId: 'home', startedByBot: { botId: 'b1', name: 'Alpha' } })],
      ['plain', thread('plain', { createdByThreadId: 'parent' })]
    ])
    const fake = fakeAppToolHost({ threadMeta: (id) => threads.get(id), readOnlyThread: (id) => id === child.childThreadId, steerStrategyOf: () => 'interrupt_restart', showAgentAction: vi.fn() })
    const deps = { host: { activationOf: () => undefined, ...(message ? { jobs: { open: vi.fn(), message } } : {}) } } as unknown as BotAppToolDeps
    const { registry, turns, request } = appToolRegistry(f.engine, fake.host, { bots: () => deps })
    const runs: Record<string, string> = { parent: parentRun.runId, [child.childThreadId]: childRun.runId, job: jobRun.runId, plain: plainRun.runId }
    for (const [threadId, runId] of Object.entries(runs)) turns.register(appTurn({ threadId, runId, subagent: threadId === child.childThreadId }))
    const call = (from: string, args: Record<string, unknown>) => registry.call('message_parent', args, request({ threadId: from, runId: runs[from] }))
    const notes = (threadId: string) => f.engine.inbox.listForThread(threadId).filter((row) => (row.payload as { kind?: string }).kind === 'agent_note')
    return { registry, call, notes, child: child.childThreadId }
  }

  it('a read-only subagent\'s message reaches its parent as a note from it; the same text again is refused, a retry replays', async () => {
    const { registry, call, notes, child } = await world()
    expect(registry.listForThread(child).map((tool) => tool.name)).toContain('message_parent')
    const sent = JSON.parse((await call(child, { content: 'Blocked: which branch?', clientRequestId: 'r1' })).text)
    expect(sent).toMatchObject({ threadId: 'parent', intent: 'note', attention: 'needed', replayed: false })
    expect(notes('parent').map((row) => row.payload)).toEqual([expect.objectContaining({ senderThreadId: child, from: 'subagent', senderAccess: 'read_only', text: 'Blocked: which branch?' } satisfies Partial<AgentNotePayload>)])

    expect(JSON.parse((await call(child, { content: 'Blocked: which branch?', clientRequestId: 'r1' })).text)).toMatchObject({ replayed: true })
    expect(await denied(call(child, { content: 'Blocked: which branch?', clientRequestId: 'r2' }))).toMatchObject({ code: 'mousse_conflict', details: expect.objectContaining({ conflict: 'duplicate_message' }) })
    expect(notes('parent')).toHaveLength(1)
  })

  it('a thread with no parent does not list it, and a call is refused', async () => {
    const { registry, call } = await world(vi.fn())
    for (const id of ['parent', 'plain']) expect(registry.listForThread(id).map((tool) => tool.name)).not.toContain('message_parent')
    expect(await denied(call('plain', { content: 'Hello?' }))).toMatchObject({ message: expect.stringContaining('no parent') })
  })

  it('a thread a bot started messages that bot; the bot\'s refusal comes back as a conflict naming it', async () => {
    const message = vi.fn(async () => ({ bot: 'Alpha', replayed: false }))
    const { registry, call } = await world(message)
    expect(registry.listForThread('job').map((tool) => tool.name)).toContain('message_parent')
    const sent = JSON.parse((await call('job', { content: 'Found the cause: the token expires early.', clientRequestId: 'q1' })).text)
    expect(sent).toMatchObject({ to: 'bot', bot: 'Alpha', replayed: false })
    expect(message).toHaveBeenCalledWith('b1', 'job', { message: 'Found the cause: the token expires early.', title: 'Fix login', requestKey: 'message_parent:job:q1', maxWaiting: AGENT_QUEUE_MAX_PER_SENDER })

    message.mockRejectedValueOnce(Object.assign(new Error('Alpha is paused.'), { code: 'bot_paused' }))
    expect(await denied(call('job', { content: 'Another thing.' }))).toMatchObject({ code: 'mousse_conflict', message: 'Alpha is paused.', details: expect.objectContaining({ conflict: 'bot_paused' }) })
  })
})
