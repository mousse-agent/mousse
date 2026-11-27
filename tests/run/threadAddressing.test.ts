/**
 * Thread addresses (docs/plans/tool-api.md §1.2 "Addressing"): the `thread` argument of the thread tools names a target
 * by id, by `self`/`parent`/`child:`/`sibling:`/`bot:`, by `children`/`descendants`, or by a bare title inside the family.
 * An address only names a target, and a retry reaches what its first call recorded, never a new holder of the name.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Thread } from '../../src/shared/types'
import { CommandRejection } from '../../src/mms/run/db/RunStoreError'
import { appToolRegistry, appTurn, denied, fakeAppToolHost } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

const NOW = '2026-11-27T00:00:00.000Z'
const thread = (id: string, name: string, patch: Partial<Thread> = {}): Thread => ({ id, name, createdAt: NOW, updatedAt: NOW, startedAt: NOW, projectId: 'p1', ...patch }) as Thread
const subagentOf = (parentThreadId: string) => ({ lineage: { parentThreadId, rootThreadId: 'parent', relationship: 'subagent' as const } })

describe('thread addresses', () => {
  let fx: DelegationFixture | undefined
  afterEach(() => {
    fx?.dispose()
    fx = undefined
  })

  /** `parent` has subagents Reader (running) and Writer; Reader has a subagent titled Writer too. */
  const family = async () => {
    fx = delegationFixture()
    const f = fx
    const parentRun = await f.runningRun('parent')
    const reader = await f.delegate(parentRun.runId, 'c1', { title: 'Reader' })
    const writer = await f.delegate(parentRun.runId, 'c2', { title: 'Writer' })
    f.engine.markStarting(reader.childRunId)
    const readerRun = f.engine.markRunning(reader.childRunId)
    f.engine.markStarting(writer.childRunId)
    const writerRun = f.engine.markRunning(writer.childRunId)
    const nested = await f.delegate(readerRun.runId, 'g1', { title: 'Writer' })
    const threads = new Map<string, Thread>([
      ['parent', thread('parent', 'Lead')],
      [reader.childThreadId, thread(reader.childThreadId, 'Reader', subagentOf('parent'))],
      [writer.childThreadId, thread(writer.childThreadId, 'Writer', subagentOf('parent'))],
      [nested.childThreadId, thread(nested.childThreadId, 'Writer', subagentOf(reader.childThreadId))]
    ])
    const fake = fakeAppToolHost({ threadMeta: (id) => threads.get(id), listThreads: () => [...threads.values()], showAgentAction: vi.fn() })
    const { registry, turns, request } = appToolRegistry(f.engine, fake.host)
    const runs: Record<string, string> = { parent: parentRun.runId, [reader.childThreadId]: readerRun.runId, [writer.childThreadId]: writerRun.runId }
    for (const [threadId, runId] of Object.entries(runs)) turns.register(appTurn({ threadId, runId, subagent: threadId !== 'parent' }))
    const send = (from: string, args: Record<string, unknown>, toolCallId?: string) =>
      registry.call('thread_send', args, request({ threadId: from, runId: runs[from], ...(toolCallId ? { toolCallId } : {}) }))
    const result = async (promise: Promise<{ text: string }>) => JSON.parse((await promise).text) as Record<string, unknown>
    const notes = (threadId: string) => f.engine.inbox.listForThread(threadId).filter((row) => (row.payload as { kind?: string }).kind === 'agent_note')
    return { f, parentRun, threads, send, result, notes, reader: reader.childThreadId, writer: writer.childThreadId, nested: nested.childThreadId }
  }

  it('a bare title that is both a child and a sibling is refused, with both candidates; child: and sibling: single one out', async () => {
    const { send, result, notes, reader, writer, nested } = await family()
    const refusal = await denied(send(reader, { thread: 'writer', content: 'hi', intent: 'note' }))
    expect(refusal).toMatchObject({ code: 'ambiguous_address' })
    expect((refusal!.details.candidates as Array<{ threadId: string; relation: string }>).map(({ threadId, relation }) => ({ threadId, relation })))
      .toEqual(expect.arrayContaining([{ threadId: writer, relation: 'sibling' }, { threadId: nested, relation: 'child' }]))
    expect(notes(writer)).toEqual([])
    expect(await result(send(reader, { thread: 'sibling:Writer', content: 'hi', intent: 'note' }))).toMatchObject({ threadId: writer })
    expect(await result(send(reader, { thread: 'child:writer', content: 'hi', intent: 'note' }))).toMatchObject({ threadId: nested })
  })

  it('child: names only the caller\'s own subagents; an unknown name lists what there is; a bare title never leaves the family', async () => {
    const { send, notes, reader, writer } = await family()
    // Writer is the parent's child, not Reader's: child:Writer from Reader names Reader's own subagent; from the parent's
    // side, child:Deep (nobody's title) is refused with the parent's own subagents as candidates.
    const refusal = await denied(send('parent', { thread: 'child:Deep', content: 'hi', intent: 'note' }))
    expect(refusal).toMatchObject({ code: 'unknown_address' })
    expect((refusal!.details.candidates as Array<{ threadId: string }>).map((row) => row.threadId)).toEqual([reader, writer])
    // Reader's subagent "Writer" is another parent's child: Writer (which has none) can't reach it with child:Writer.
    expect(await denied(send(writer, { thread: 'child:Writer', content: 'hi', intent: 'note' }))).toMatchObject({ code: 'unknown_address', message: expect.stringContaining('none') })
    // A title nobody in the family has is refused, not looked up elsewhere.
    expect(await denied(send(reader, { thread: 'Nobody', content: 'hi', intent: 'note' }))).toMatchObject({ code: 'unknown_address', message: expect.stringContaining('named by its id') })
    expect(notes(writer)).toEqual([])
  })

  it('an address grants nothing: work to a sibling by address is refused as it is by id', async () => {
    const { send, reader } = await family()
    expect(await denied(send(reader, { thread: 'sibling:Writer', content: 'do it' }))).toMatchObject({ code: 'mousse_scope_denied' })
  })

  it('a retry after a rename reaches the thread its first call recorded, not the new holder of the name', async () => {
    const { send, result, notes, threads, reader, writer } = await family()
    expect(await result(send('parent', { thread: 'child:Reader', content: 'use v2', intent: 'note' }, 'mcp:k1'))).toMatchObject({ threadId: reader })
    threads.set(reader, { ...threads.get(reader)!, name: 'Old reader' })
    threads.set(writer, { ...threads.get(writer)!, name: 'Reader' })
    expect(await result(send('parent', { thread: 'child:Reader', content: 'use v2', intent: 'note' }, 'mcp:k1'))).toMatchObject({ threadId: reader })
    expect(notes(writer)).toEqual([])
    expect(notes(reader)).toHaveLength(1)
    // A new key resolves the name again; the old key for another address is refused.
    expect(await result(send('parent', { thread: 'child:Reader', content: 'use v2', intent: 'note' }, 'mcp:k2'))).toMatchObject({ threadId: writer })
    expect(await denied(send('parent', { thread: 'child:Writer', content: 'use v2', intent: 'note' }, 'mcp:k1'))).toMatchObject({ code: 'conflict', details: { conflict: 'client_request_id_conflict' } })
  })

  it('children sends to each subagent, and a retry never widens the set it recorded', async () => {
    const { f, parentRun, send, result, notes, threads, reader, writer } = await family()
    const first = await result(send('parent', { thread: 'children', content: 'stop and report', intent: 'note' }, 'mcp:all'))
    expect((first.results as Array<{ threadId: string }>).map((row) => row.threadId)).toEqual([reader, writer])
    const late = await f.delegate(parentRun.runId, 'c3', { title: 'Late' })
    threads.set(late.childThreadId, thread(late.childThreadId, 'Late', subagentOf('parent')))
    const retry = await result(send('parent', { thread: 'children', content: 'stop and report', intent: 'note' }, 'mcp:all'))
    expect((retry.results as Array<{ threadId: string }>).map((row) => row.threadId)).toEqual([reader, writer])
    expect(notes(late.childThreadId)).toEqual([])
    expect(notes(reader)).toHaveLength(1)
  })

  it('bot: resolves only a bot the caller may reach', async () => {
    const { send, threads, reader } = await family()
    expect(await denied(send('parent', { thread: 'bot:Pip', content: 'hi', intent: 'note' }))).toMatchObject({ code: 'unknown_address', message: expect.stringContaining('you may reach none') })
    // A thread Pip started reaches Pip (and the tool then says it does not message bots yet).
    threads.set('parent', { ...threads.get('parent')!, startedByBot: { botId: 'bot-pip', name: 'Pip' } })
    expect(await denied(send('parent', { thread: 'bot:pip', content: 'hi', intent: 'note' }))).toMatchObject({ refused: { code: 'unavailable' } })
    expect(await denied(send(reader, { thread: 'bot:Pip', content: 'hi', intent: 'note' }))).toMatchObject({ code: 'unknown_address' })
  })

  it('a reserved word or prefix is refused as a new subagent\'s title', async () => {
    const { f, parentRun } = await family()
    for (const title of ['children', 'Parent', 'child:x', 'bot: Pip'])
      await expect(f.delegate(parentRun.runId, `r-${title}`, { title })).rejects.toSatisfy((error) => error instanceof CommandRejection && error.reason === 'reserved_title')
    // A word that only contains one is free.
    await expect(f.delegate(parentRun.runId, 'r-ok', { title: 'Parent reviewer' })).resolves.toMatchObject({ childThreadId: expect.any(String) })
  })
})
