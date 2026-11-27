/**
 * Thread addresses (docs/plans/tool-api.md §1.2 "Addressing"): the `thread` argument of the thread tools names a target
 * by id, by `self`/`parent`/`child:`/`sibling:`/`bot:`, by `children`/`descendants`, or by a bare title inside the family.
 * An address only names a target, and a retry reaches what its first call recorded, never a new holder of the name.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Thread } from '../../src/shared/types'
import { CommandRejection } from '../../src/mms/run/db/RunStoreError'
import { botReachOf } from '../../src/mms/run/mcp/appTools/registry'
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
  const family = async (extra: Parameters<typeof appToolRegistry>[2] = {}) => {
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
    const fake = fakeAppToolHost({
      threadMeta: (id) => threads.get(id),
      listThreads: () => [...threads.values()],
      showAgentAction: vi.fn(),
      sendToThread: vi.fn(async () => ({ runId: 'run:sent', sequence: 1, queued: false, replayed: false }))
    })
    const { registry, turns, request } = appToolRegistry(f.engine, fake.host, extra)
    const runs: Record<string, string> = { parent: parentRun.runId, [reader.childThreadId]: readerRun.runId, [writer.childThreadId]: writerRun.runId }
    for (const [threadId, runId] of Object.entries(runs)) turns.register(appTurn({ threadId, runId, subagent: threadId !== 'parent' }))
    const send = (from: string, args: Record<string, unknown>, toolCallId?: string) =>
      registry.call('thread_send', args, request({ threadId: from, runId: runs[from], ...(toolCallId ? { toolCallId } : {}) }))
    const result = async (promise: Promise<{ text: string }>) => JSON.parse((await promise).text) as Record<string, unknown>
    const notes = (threadId: string) => f.engine.inbox.listForThread(threadId).filter((row) => (row.payload as { kind?: string }).kind === 'agent_note')
    const call = (tool: string, from: string, args: Record<string, unknown>, options: { toolCallId?: string; signal?: AbortSignal } = {}) =>
      registry.call(tool, args, request({ threadId: from, runId: runs[from], ...options }))
    return { f, parentRun, threads, send, call, result, notes, delegation: fake.delegation, reader: reader.childThreadId, writer: writer.childThreadId, nested: nested.childThreadId }
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
    expect(await denied(send('parent', { threadId: writer, content: 'use v2', intent: 'note' }, 'mcp:k1'))).toMatchObject({ code: 'conflict', details: { conflict: 'client_request_id_conflict' } })
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

  // Sol's review of #2060: what a refusal may name, what a key may be reused for, and what a fan-out reports.

  it('a thread the caller can\'t read by id is never matched by title, listed as a candidate, or named in a refused row', async () => {
    const { call, send, result, threads, reader, writer, nested } = await family()
    // Writer is private; Reader is not, so it can't read Writer by id.
    threads.set(writer, { ...threads.get(writer)!, localOnly: true })
    const unknown = await send(reader, { thread: 'Nobody', content: 'hi', intent: 'note' })
    expect(unknown.text).not.toContain(writer)
    // "Writer" is now only Reader's own subagent: not ambiguous, and nothing about the private sibling shows.
    expect(await result(send(reader, { thread: 'Writer', content: 'hi', intent: 'note' }))).toMatchObject({ threadId: nested })
    const waited = await call('thread_wait', 'parent', { thread: 'children', timeoutMs: 1 })
    expect(waited.text).not.toContain(writer)
    const rows = (JSON.parse(waited.text) as { results: Array<Record<string, unknown>> }).results
    expect(rows.map((row) => row.threadId)).toEqual([reader, undefined])
    expect(rows[1]).toMatchObject({ refused: { code: 'scope_denied' } })
  })

  it('a key first used with an id is refused for a wider set, and reused in other words for the same thread it replays', async () => {
    const { send, result, notes, reader, writer } = await family()
    await result(send('parent', { threadId: reader, content: 'use v2', intent: 'note' }, 'mcp:k'))
    expect(await denied(send('parent', { thread: 'children', content: 'use v2', intent: 'note' }, 'mcp:k'))).toMatchObject({ code: 'conflict', details: { conflict: 'client_request_id_conflict' } })
    expect(await result(send('parent', { thread: 'child:Reader', content: 'use v2', intent: 'note' }, 'mcp:k'))).toMatchObject({ threadId: reader, replayed: true })
    expect(notes(reader)).toHaveLength(1)
    expect(notes(writer)).toEqual([])
  })

  it('bot: from an ordinary thread reads only the thread record, never the bots\' store', async () => {
    const activationOf = vi.fn(() => undefined)
    const list = vi.fn(() => [])
    const { send, threads } = await family({ bots: () => ({ host: { activationOf, bots: { list } } }) as never })
    expect(await denied(send('parent', { thread: 'bot:Pip', content: 'hi', intent: 'note' }))).toMatchObject({ code: 'unknown_address' })
    threads.set('parent', { ...threads.get('parent')!, startedByBot: { botId: 'bot-pip', name: 'Pip' } })
    expect(await denied(send('parent', { thread: 'bot:Pip', content: 'hi', intent: 'note' }))).toMatchObject({ refused: { code: 'unavailable' } })
    expect(activationOf).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
  })

  it('which bots bot: may name follows the turn: a bot turn needs bot_send, and a bot\'s subagent names none', () => {
    const bot = (tools: string[], role = 'activation') => appTurn({ threadId: 't', runId: 'r', bot: { appTools: new Set(tools), role } as never }) as never
    expect(botReachOf(appTurn({ threadId: 't', runId: 'r' }) as never)).toBe('own')
    expect(botReachOf(bot(['bot_send']))).toBe('others')
    expect(botReachOf(bot(['bot_list']))).toBe('none')
    expect(botReachOf(bot([]))).toBe('none')
    expect(botReachOf(bot(['bot_send'], 'subagent'))).toBe('none')
  })

  it('a cancelled fan-out sends nothing more: the targets it did not reach are not_sent', async () => {
    const { call, delegation, reader, writer } = await family()
    const stop = new AbortController()
    vi.mocked(delegation.continueSubagent).mockImplementation(async (input) => {
      stop.abort()
      return { delegationId: 'd2', input }
    })
    const sent = JSON.parse((await call('thread_send', 'parent', { thread: 'children', content: 'next step' }, { signal: stop.signal })).text) as { results: Array<Record<string, unknown>> }
    expect(delegation.continueSubagent).toHaveBeenCalledTimes(1)
    expect(sent.results.map((row) => [row.threadId, row.status])).toEqual([[reader, undefined], [writer, 'not_sent']])
  })

  it('stopping descendants reports every recorded thread, the ones below a subagent as stopped with it', async () => {
    const { call, delegation, reader, writer, nested } = await family()
    const stopped = JSON.parse((await call('thread_stop', 'parent', { thread: 'descendants' })).text) as { results: Array<Record<string, unknown>> }
    expect(delegation.taskCancel).toHaveBeenCalledTimes(2)
    expect(stopped.results.map((row) => row.threadId)).toEqual([reader, writer, nested])
    expect(stopped.results[2]).toMatchObject({ status: 'stopped' })
  })

  // S6b: the family as a list (docs/plans/tool-api.md §1.2 "Family", "Paging").

  it('thread_list scope family lists the caller first, then the family it can read, in pages bound to it and the query', async () => {
    const { call, result, threads, delegation, reader, writer, nested } = await family()
    vi.mocked(delegation.listSubagents).mockReturnValue([{ title: 'Writer', childThreadId: nested, state: 'running', latestDelegationId: 'd-nested' }] as never)
    const rows = (page: Record<string, unknown>) => (page.items as Array<{ thread: string; relation: string; parentThread?: string }>).map(({ thread, relation, parentThread }) => [thread, relation, parentThread])
    const whole = await result(call('thread_list', reader, { scope: 'family' }))
    expect(rows(whole)).toEqual([[reader, 'self', undefined], ['parent', 'parent', undefined], [writer, 'sibling', 'parent'], [nested, 'child', reader]])
    // A row of the caller's own subagent carries what list_subagents says of it.
    expect((whole.items as unknown[])[3]).toMatchObject({ title: 'Writer', state: 'running', latestDelegationId: 'd-nested' })
    expect(whole).toMatchObject({ nextCursor: null, complete: true })
    const first = await result(call('thread_list', reader, { scope: 'family', limit: 2 }))
    expect(rows(first).map(([id]) => id)).toEqual([reader, 'parent'])
    expect(first).toMatchObject({ complete: false, nextCursor: expect.any(String) })
    const second = await result(call('thread_list', reader, { scope: 'family', limit: 2, cursor: first.nextCursor }))
    expect(rows(second).map(([id]) => id)).toEqual([writer, nested])
    expect(second).toMatchObject({ nextCursor: null, complete: true })
    // Another thread, or another query, can't continue it.
    expect(await denied(call('thread_list', writer, { scope: 'family', limit: 2, cursor: first.nextCursor }))).toMatchObject({ code: 'cursor_mismatch' })
    expect(await denied(call('thread_list', reader, { scope: 'family', limit: 2, includeArchived: true, cursor: first.nextCursor }))).toMatchObject({ code: 'cursor_mismatch' })
    // A sibling made private is on no page, even one a cursor from before continues.
    threads.set(writer, { ...threads.get(writer)!, localOnly: true })
    expect(rows(await result(call('thread_list', reader, { scope: 'family', limit: 2, cursor: first.nextCursor }))).map(([id]) => id)).toEqual([nested])
    expect(rows(await result(call('thread_list', reader, { scope: 'family' }))).map(([id]) => id)).not.toContain(writer)
    // Called by its old name, the listing is list_subagents' rows, as it always was.
    expect(JSON.parse((await call('list_subagents', reader, {})).text)).toEqual([{ title: 'Writer', childThreadId: nested, state: 'running', latestDelegationId: 'd-nested' }])
  })

})
