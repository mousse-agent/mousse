/**
 * `queue_list`, `queue_enqueue`, `queue_edit`, `queue_remove`, `queue_reorder` and `queue_promote_to_steer` through the
 * registry's central check (docs/run-engine/SPEC §15.1): the access level and project list, what the caller must
 * name (the queue revision, the run), what each tool asks of its host, how a refusal reaches the agent, and what a
 * reader below manage may see of a queue. The queue itself is covered end to end in `queueEditDaemon.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentAccessLevel, AgentAccessSettings } from '../../src/shared/settings'
import type { QueuedMessage, Thread } from '../../src/shared/types'
import { DomainRpcError } from '../../src/mms/protocol/domainRegistry'
import { QueueAccessError, QueueConflictError } from '../../src/mms/queue/ThreadMessageQueue'
import { McpToolError, type AgentQueueCommand, type AgentQueueResult, type McpCallRequest } from '../../src/mms/run/mcp/appTools'
import { appToolRegistry, appTurn, fakeAppToolHost } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

const NOW = '2026-10-27T00:00:00.000Z'
const thread = (id: string, patch: Partial<Thread> = {}): Thread => ({ id, name: `Thread ${id}`, createdAt: NOW, updatedAt: NOW, startedAt: NOW, projectId: 'p1', ...patch }) as Thread
const profile = (patch: Partial<AgentAccessSettings> = {}): AgentAccessSettings => ({ level: 'manage', projectIds: [], answerApprovals: false, ...patch })
const SECRET = 'the staging password is hunter2'
const item = (id: string, patch: Partial<QueuedMessage> = {}): QueuedMessage => ({
  id, threadId: 'target', content: SECRET, enqueuedAt: NOW, order: 0, intent: 'normal', state: 'pending', source: 'gui',
  images: [{ data: 'c2VjcmV0LWltYWdl', mimeType: 'image/png' }], inboxIds: ['inbox-1'], ...patch
})

/** One command per tool, as the agent would send it, and the command the host must be given. */
const TOOLS: Array<{ tool: string; args: Record<string, unknown>; command: AgentQueueCommand }> = [
  { tool: 'queue_enqueue', args: { content: 'hello', expectedRevision: 'rev-1' }, command: { op: 'enqueue', content: 'hello', mode: 'agent', expectedRevision: 'rev-1' } },
  { tool: 'queue_edit', args: { itemId: 'i1', content: 'new', expectedRevision: 'rev-1' }, command: { op: 'edit', itemId: 'i1', content: 'new', expectedRevision: 'rev-1' } },
  { tool: 'queue_remove', args: { itemId: 'i1', expectedRevision: 'rev-1' }, command: { op: 'remove', itemId: 'i1', expectedRevision: 'rev-1' } },
  { tool: 'queue_reorder', args: { orderedIds: ['i2', 'i1'], expectedRevision: 'rev-1' }, command: { op: 'reorder', orderedIds: ['i2', 'i1'], expectedRevision: 'rev-1' } },
  { tool: 'queue_promote_to_steer', args: { itemId: 'i1', expectedRevision: 'rev-1', expectedRunId: 'run-x' }, command: { op: 'promote', itemId: 'i1', expectedRevision: 'rev-1', expectedRunId: 'run-x' } }
]

describe('the queue tools (SPEC §15.1)', () => {
  let fx: DelegationFixture | undefined
  afterEach(() => {
    fx?.dispose()
    fx = undefined
  })

  const world = async (initial: Partial<AgentAccessSettings> = {}, extraHost: Parameters<typeof fakeAppToolHost>[0] = {}) => {
    fx = delegationFixture()
    const callerRun = await fx.runningRun('caller')
    const state = { profile: profile(initial) }
    const threads = new Map<string, Thread>([
      ['caller', thread('caller')],
      ['target', thread('target')],
      ['elsewhere', thread('elsewhere', { projectId: 'p2' })]
    ])
    const ledger = { start: vi.fn(() => 'inv'), commit: vi.fn(), failed: vi.fn() }
    const answer: { result: () => AgentQueueResult | never } = {
      result: () => ({ outcome: 'edited', itemId: 'i1', revision: 'rev-2', replayed: false, effectsSettled: true, recorded: true })
    }
    const queue: { items: QueuedMessage[]; claimed: QueuedMessage[] } = { items: [item('i1'), item('i2', { order: 1, content: 'second' })], claimed: [] }
    const fake = fakeAppToolHost({
      agentAccess: () => state.profile,
      threadMeta: (id) => threads.get(id),
      toolLedger: () => ledger,
      showAgentAction: vi.fn(),
      queueSnapshot: vi.fn(() => ({ ...queue, revision: 'rev-1', open: true })),
      queueCommand: vi.fn((_threadId: string, _command: AgentQueueCommand) => answer.result()),
      ...extraHost
    })
    const { registry, turns, request } = appToolRegistry(fx.engine, fake.host)
    turns.register(appTurn({ threadId: 'caller', runId: callerRun.runId }))
    const as = (granted: AgentAccessLevel, extra: Partial<Parameters<typeof request>[0]> = {}): McpCallRequest =>
      request({ threadId: 'caller', runId: callerRun.runId, accessLevel: granted, ...extra })
    const call = (granted: AgentAccessLevel, name: string, args: Record<string, unknown> = {}, extra: Partial<Parameters<typeof request>[0]> = {}) =>
      registry.call(name, args, as(granted, extra))
    const denied = (promise: Promise<unknown>) => promise.then(() => undefined, (error: McpToolError) => error)
    return { fx, registry, state, threads, ledger, answer, queue, call, denied, callerRun, ...fake }
  }

  describe('on the caller\'s own thread, at every level', () => {
    it.each(['lineage', 'read', 'manage'] as const)('each tool reaches its host as a command of the caller, scoped to the caller\'s thread (%s)', async (level) => {
      const { call, host, callerRun } = await world({ level })
      for (const { tool, args, command } of TOOLS) {
        const result = await call(level, tool, { ...args, clientRequestId: `req-${tool}` })
        expect(result.isError, tool).toBeUndefined()
        expect(host.queueCommand, tool).toHaveBeenLastCalledWith('caller', command, {
          clientRequestId: `${tool}:caller:req-${tool}`,
          actor: { kind: 'agent', threadId: 'caller', runId: callerRun.runId, toolCallId: expect.stringMatching(/^mcp:/) },
          level
        })
      }
    })

    it('a call without a clientRequestId is keyed by its own call id: two calls are two commands, a retry that names its key is one', async () => {
      const { call, host } = await world()
      await call('lineage', 'queue_remove', { itemId: 'i1', expectedRevision: 'rev-1' })
      await call('lineage', 'queue_remove', { itemId: 'i1', expectedRevision: 'rev-1' })
      const keys = vi.mocked(host.queueCommand!).mock.calls.map((entry) => entry[2].clientRequestId)
      expect(new Set(keys).size).toBe(2)
      expect(keys.every((key) => /^queue_remove:caller:mcp:/.test(key))).toBe(true)
    })

    it('no queue tool is refused a lineage credential for its own thread, and a plan ceiling cannot ask for an agent turn', async () => {
      const { call, denied, host } = await world()
      const ceiling = { modeCeiling: 'plan' as const }
      for (const [tool, args] of [['queue_enqueue', { content: 'x', mode: 'agent' }], ['queue_edit', { itemId: 'i1', mode: 'agent', expectedRevision: 'rev-1' }]] as const)
        expect((await denied(call('manage', tool, { ...args }, ceiling)))!.code, tool).toBe('mousse_ceiling_exceeded')
      expect(host.queueCommand).not.toHaveBeenCalled()
      // Its default under a plan ceiling is a plan turn.
      await call('manage', 'queue_enqueue', { content: 'x' }, ceiling)
      expect(host.queueCommand).toHaveBeenLastCalledWith('caller', { op: 'enqueue', content: 'x', mode: 'plan' }, expect.anything())
    })
  })

  describe('on another thread', () => {
    it.each(['lineage', 'read'] as const)('a credential granted %s is refused every queue tool, with no ledger row and no host call', async (level) => {
      const { call, denied, ledger, host } = await world({ level: 'manage' })
      for (const { tool, args } of TOOLS) {
        const error = await denied(call(level, tool, { ...args, threadId: 'target' }))
        expect(error, tool).toBeInstanceOf(McpToolError)
        expect(error!.code, tool).toBe('mousse_scope_denied')
      }
      expect(ledger.start).not.toHaveBeenCalled()
      expect(host.queueCommand).not.toHaveBeenCalled()
    })

    it('manage reaches a thread of an allowed project and not one outside the project list, whatever it names', async () => {
      const { call, denied, state, host } = await world({ level: 'manage', projectIds: ['p1'] })
      for (const { tool, args, command } of TOOLS) {
        expect((await call('manage', tool, { ...args, threadId: 'target' })).isError, tool).toBeUndefined()
        expect(host.queueCommand, tool).toHaveBeenLastCalledWith('target', command, expect.objectContaining({ level: 'manage' }))
        expect((await denied(call('manage', tool, { ...args, threadId: 'elsewhere' })))!.code, tool).toBe('mousse_scope_denied')
      }
      // Lowered while the credential is live: the next call is refused.
      state.profile = profile({ level: 'read' })
      expect((await denied(call('manage', 'queue_remove', { itemId: 'i1', expectedRevision: 'rev-1', threadId: 'target' })))!.message).toMatch(/yours is "read"/)
    })

    it('an unknown thread is refused as one the caller may not reach, never as missing', async () => {
      const { call, denied } = await world()
      const error = await denied(call('manage', 'queue_remove', { itemId: 'i1', expectedRevision: 'rev-1', threadId: 'nowhere' }))
      expect(error!.code).toBe('mousse_scope_denied')
      expect(error!.message).toMatch(/not available to this credential/)
    })

    it('does not queue into a subagent, does not change a subagent of another thread, and reaches the subagents below the caller', async () => {
      const { call, denied, fx, threads, host, callerRun } = await world()
      const owner = await fx.runningRun('owner')
      const foreign = await fx.delegate(owner.runId, 'call-foreign')
      const own = await fx.delegate(callerRun.runId, 'call-own')
      for (const id of [foreign.childThreadId, own.childThreadId]) threads.set(id, thread(id))
      // A message to any subagent would run without its parent hearing the result: its parent uses continue_subagent.
      for (const child of [foreign, own])
        expect((await denied(call('manage', 'queue_enqueue', { threadId: child.childThreadId, content: 'x', expectedRevision: 'rev-1' })))!.code).toBe('mousse_scope_denied')
      for (const { tool, args } of TOOLS.slice(1)) {
        const error = await denied(call('manage', tool, { ...args, threadId: foreign.childThreadId }))
        expect(error, tool).toMatchObject({ code: 'mousse_scope_denied' })
        expect(error!.message, tool).toMatch(/subagent of another thread/)
      }
      expect(host.queueCommand).not.toHaveBeenCalled()
      for (const { tool, args } of TOOLS.slice(1)) expect((await call('manage', tool, { ...args, threadId: own.childThreadId })).isError, tool).toBeUndefined()
    })

    it('a personal bot\'s thread takes no queue change from another thread: its owner and its bot engine drive it', async () => {
      const { call, denied, host } = await world({}, { botRole: (id: string) => (id === 'target' ? 'activation' : undefined) })
      for (const { tool, args } of TOOLS) {
        const error = await denied(call('manage', tool, { ...args, threadId: 'target' }))
        expect(error, tool).toMatchObject({ code: 'mousse_scope_denied', message: expect.stringContaining('belongs to a bot') })
      }
      expect(host.queueCommand).not.toHaveBeenCalled()
      // The caller's own thread is its own, whatever it is.
      expect((await call('manage', 'queue_remove', { itemId: 'i1', expectedRevision: 'rev-1' })).isError).toBeUndefined()
    })

    it('an archived thread takes no new message, edit or steer, but its queue can be tidied (remove, reorder)', async () => {
      const { call, denied, threads, host } = await world()
      threads.set('target', thread('target', { settledAt: NOW }))
      for (const { tool, args } of TOOLS.filter((entry) => ['queue_enqueue', 'queue_edit', 'queue_promote_to_steer'].includes(entry.tool))) {
        const error = await denied(call('manage', tool, { ...args, threadId: 'target' }))
        expect(error, tool).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'thread_archived' } })
      }
      expect(host.queueCommand).not.toHaveBeenCalled()
      for (const { tool, args } of TOOLS.filter((entry) => ['queue_remove', 'queue_reorder'].includes(entry.tool)))
        expect((await call('manage', tool, { ...args, threadId: 'target' })).isError, tool).toBeUndefined()
    })
  })

  describe('what the agent must name', () => {
    it('every change to an existing message names the queue revision it read, and a promotion the run; so does an enqueue on another thread', async () => {
      const { call, host } = await world()
      for (const { tool, args } of TOOLS.slice(1)) {
        const { expectedRevision: _revision, ...without } = args
        const result = await call('manage', tool, { ...without, clientRequestId: 'k' })
        expect(result.isError, tool).toBe(true)
        expect(result.text, tool).toMatch(/expectedRevision is required/)
      }
      const promote = await call('manage', 'queue_promote_to_steer', { itemId: 'i1', expectedRevision: 'rev-1' })
      expect(promote).toMatchObject({ isError: true, text: expect.stringMatching(/expectedRunId/) })
      const own = await call('manage', 'queue_enqueue', { content: 'x' })
      expect(own.isError).toBeUndefined()
      const other = await call('manage', 'queue_enqueue', { content: 'x', threadId: 'target' })
      expect(other).toMatchObject({ isError: true, text: expect.stringMatching(/expectedRevision is required to queue a message on another thread/) })
      expect(host.queueCommand).toHaveBeenCalledTimes(1)
    })

    it('edit needs text or a mode, and the rest of the arguments are checked before the host is asked', async () => {
      const { call, host } = await world()
      for (const args of [
        { itemId: 'i1', expectedRevision: 'rev-1' },
        { itemId: 'i1', content: '  ', expectedRevision: 'rev-1' },
        { itemId: 'i1', mode: 'root', expectedRevision: 'rev-1' },
        { content: 'x', expectedRevision: 'rev-1' }
      ]) expect((await call('manage', 'queue_edit', args)).isError, JSON.stringify(args)).toBe(true)
      expect((await call('manage', 'queue_reorder', { orderedIds: ['a', 1], expectedRevision: 'rev-1' })).isError).toBe(true)
      expect((await call('manage', 'queue_enqueue', { content: ' ' })).isError).toBe(true)
      expect(host.queueCommand).not.toHaveBeenCalled()
    })
  })

  describe('how a refusal reaches the agent', () => {
    it('a stale queue or run is a conflict with the ids to read again; a limit of its access is a scope denial; a cap is a conflict', async () => {
      const { call, denied, answer } = await world()
      const args = { itemId: 'i1', content: 'x', expectedRevision: 'rev-1' }
      answer.result = () => { throw new QueueConflictError('revision_mismatch', 'The queue changed since you read it.', { expectedRevision: 'rev-1', revision: 'rev-9' }) }
      expect(await denied(call('manage', 'queue_edit', args))).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'revision_mismatch', expectedRevision: 'rev-1', revision: 'rev-9' } })
      answer.result = () => { throw new QueueConflictError('ceiling_exceeded', 'Too loose.', { callerMode: 'ask', targetMode: 'full' }) }
      expect(await denied(call('manage', 'queue_promote_to_steer', { itemId: 'i1', expectedRevision: 'rev-1', expectedRunId: 'r' }))).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'ceiling_exceeded', callerMode: 'ask', targetMode: 'full' } })
      answer.result = () => { throw new QueueAccessError('Editing a message a person queued needs manage.') }
      expect(await denied(call('lineage', 'queue_edit', args))).toMatchObject({ code: 'mousse_scope_denied', message: expect.stringContaining('needs manage') })
      answer.result = () => { throw new DomainRpcError('agent_queue_full', 'full') }
      expect(await denied(call('manage', 'queue_edit', args))).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'agent_queue_full' } })
      answer.result = () => { throw new DomainRpcError('agent_hops_exceeded', 'hops') }
      expect(await denied(call('manage', 'queue_enqueue', { content: 'x', threadId: 'target', expectedRevision: 'rev-1' }))).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'agent_hops_exceeded' } })
      // Anything else is a plain error result the agent can read.
      answer.result = () => { throw new Error('Queued message content is required.') }
      expect(await call('manage', 'queue_edit', args)).toMatchObject({ isError: true, text: 'Queued message content is required.' })
    })

    it('the transcript row of a change is added by the call that made it and only when an event recorded it, never for a replay', async () => {
      const { call, answer, host } = await world()
      const args = { itemId: 'i1', content: 'x', expectedRevision: 'rev-1', threadId: 'target' }
      await call('manage', 'queue_edit', args)
      expect(host.showAgentAction).toHaveBeenCalledTimes(1)
      expect(host.showAgentAction).toHaveBeenLastCalledWith({ threadId: 'target' }, expect.objectContaining({ kind: 'agent', threadId: 'caller' }), 'edited queued message i1')
      answer.result = () => ({ outcome: 'edited', itemId: 'i1', revision: 'rev-2', replayed: true, effectsSettled: true, recorded: true })
      await call('manage', 'queue_edit', args)
      answer.result = () => ({ outcome: 'edited', itemId: 'i1', revision: 'rev-2', replayed: false, effectsSettled: true })
      await call('manage', 'queue_edit', args)
      expect(host.showAgentAction).toHaveBeenCalledTimes(1)
    })

    it('a result carries the queue item without image data, and whether the effects have settled', async () => {
      const { call, answer } = await world()
      answer.result = () => ({ outcome: 'enqueued', itemId: 'i9', revision: 'rev-3', replayed: false, effectsSettled: false, item: item('i9', { threadId: 'caller' }) })
      const result = JSON.parse((await call('lineage', 'queue_enqueue', { content: 'x' })).text) as { item: Record<string, unknown>; effectsSettled: boolean; revision: string }
      expect(result).toMatchObject({ effectsSettled: false, revision: 'rev-3', item: { id: 'i9', content: SECRET, images: [{ mimeType: 'image/png' }] } })
      expect(JSON.stringify(result)).not.toContain('c2VjcmV0LWltYWdl')
      expect(result.item.inboxIds).toBeUndefined()
    })

    it('a host without queue commands says so instead of failing', async () => {
      const { call } = await world({}, { queueCommand: undefined, queueSnapshot: undefined })
      for (const { tool, args } of TOOLS) expect(await call('manage', tool, { ...args }), tool).toMatchObject({ isError: true, text: `${tool} is not available in this host.` })
      expect(await call('manage', 'queue_list')).toMatchObject({ isError: true, text: 'queue_list is not available in this host.' })
    })
  })

  describe('queue_list', () => {
    const read = async (call: Awaited<ReturnType<typeof world>>['call'], granted: AgentAccessLevel, args: Record<string, unknown> = {}, extra: Parameters<Awaited<ReturnType<typeof world>>['call']>[3] = {}) =>
      JSON.parse((await call(granted, 'queue_list', args, extra)).text) as { threadId: string; items: Array<Record<string, unknown>>; claimed: Array<Record<string, unknown>>; revision: string; open: boolean; blockedReason?: string }

    it('the caller\'s own queue and a manager\'s view carry the text and name the images; nothing carries image data or bookkeeping', async () => {
      const { call, queue } = await world()
      queue.claimed = [item('c1', { state: 'claimed', content: 'already running' })]
      for (const [granted, args] of [['lineage', {}], ['manage', { threadId: 'target' }]] as const) {
        const listed = await read(call, granted, args)
        expect(listed.items.map((entry) => entry.content), granted).toEqual([SECRET, 'second'])
        expect(listed.claimed.map((entry) => entry.content), granted).toEqual(['already running'])
        expect(listed.items[0].images).toEqual([{ mimeType: 'image/png' }])
        const text = JSON.stringify(listed)
        expect(text).not.toContain('c2VjcmV0LWltYWdl')
        expect(text).not.toContain('inbox-1')
        expect(listed.revision).toBe('rev-1')
      }
    })

    it('another thread\'s queue through read, and a thread below or beside the caller, gets order, state, mode and size, never text or images', async () => {
      const { call, fx, threads, queue, callerRun } = await world({ level: 'read' })
      queue.items = [item('i1', { mode: 'plan', origin: { kind: 'agent', threadId: 'x', runId: 'r', hops: 2 } }), item('i2', { order: 1, content: 'second', origin: { kind: 'schedule', jobId: 'job', occurrenceKey: 'k', jobName: 'Nightly secret job' } })]
      const own = await fx.delegate(callerRun.runId, 'call-own')
      threads.set(own.childThreadId, thread(own.childThreadId))
      for (const args of [{ threadId: 'target' }, { threadId: own.childThreadId }]) {
        const listed = await read(call, 'read', args)
        const text = JSON.stringify(listed)
        for (const hidden of [SECRET, 'second', 'c2VjcmV0LWltYWdl', 'inbox-1', 'Nightly secret job']) expect(text, JSON.stringify(args)).not.toContain(hidden)
        expect(listed.items[0]).toEqual({
          id: 'i1', order: 0, intent: 'normal', state: 'pending', mode: 'plan', enqueuedAt: NOW, source: 'gui',
          contentLength: SECRET.length, hasImages: true, origin: { kind: 'agent', threadId: 'x', runId: 'r', hops: 2 }
        })
        expect(listed.items[1].origin).toEqual({ kind: 'schedule' })
      }
    })

    it('says when the queue is not open, and a lineage credential cannot list another thread\'s queue at all', async () => {
      const { call, denied, host } = await world()
      vi.mocked(host.queueSnapshot!).mockReturnValueOnce({ items: [], claimed: [], revision: 'rev-0', open: false, blockedReason: 'merge_back_pending' })
      expect(await read(call, 'lineage')).toMatchObject({ open: false, blockedReason: 'merge_back_pending' })
      expect((await denied(call('lineage', 'queue_list', { threadId: 'target' })))!.code).toBe('mousse_scope_denied')
    })

    it('stays a tool a read-only subagent may call, and the writing tools stay closed to it', async () => {
      const { call, denied, host } = await world({}, { readOnlyThread: () => true })
      expect((await call('lineage', 'queue_list')).isError).toBeUndefined()
      for (const { tool, args } of TOOLS) expect((await denied(call('manage', tool, { ...args })))!.code, tool).toBe('mousse_read_only')
      expect(host.queueCommand).not.toHaveBeenCalled()
    })
  })
})
