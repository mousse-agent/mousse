/**
 * `thread_send`, `thread_wait`, `thread_interrupt` and `thread_steer` through the registry's central check
 * (docs/run-engine/SPEC.md §15.1): the access level and project list, what the target's state allows, the
 * per-run send cap, idempotency across a replaced caller run, and `thread_wait` over a real Run Engine.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentAccessLevel, AgentAccessSettings } from '../../src/shared/settings'
import type { Thread } from '../../src/shared/types'
import { McpToolError, type AgentRunCommandResult, type AgentSendResult, type McpCallRequest } from '../../src/mms/run/mcp/appTools'
import { THREAD_SEND_MAX_PER_RUN } from '../../src/mms/run/mcp/appTools/thread'
import type { RunPause } from '../../src/mms/run/types'
import { appToolRegistry, appTurn, fakeAppToolHost } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

const NOW = '2026-10-12T00:00:00.000Z'
const thread = (id: string, patch: Partial<Thread> = {}): Thread => ({ id, name: `Thread ${id}`, createdAt: NOW, updatedAt: NOW, startedAt: NOW, projectId: 'p1', ...patch }) as Thread
const profile = (patch: Partial<AgentAccessSettings> = {}): AgentAccessSettings => ({ level: 'manage', projectIds: [], answerApprovals: false, ...patch })
const PAUSE: RunPause = { reason: 'usage_limit', until: '2026-10-12T05:00:00.000Z', estimated: true, count: 1, autoResume: false }
const refusal = (code: string, message = code) => Object.assign(new Error(message), { code })

describe('tools that act on other threads (SPEC §15.1)', () => {
  let fx: DelegationFixture | undefined
  afterEach(() => {
    fx?.dispose()
    fx = undefined
  })

  /**
   * `caller` and `target` hold live runs; `elsewhere` (another project) and `loose` (no project) are known to
   * the host. `state.profile` is the setting as it is now, read at every call. The host records what the tools
   * asked of it and answers as a healthy thread owner would.
   */
  const world = async (initial: Partial<AgentAccessSettings> = {}) => {
    fx = delegationFixture()
    const callerRun = await fx.runningRun('caller')
    const targetRun = await fx.runningRun('target')
    const state = { profile: profile(initial) }
    const threads = new Map<string, Thread>([
      ['caller', thread('caller')],
      ['target', thread('target')],
      ['elsewhere', thread('elsewhere', { projectId: 'p2' })],
      ['loose', thread('loose', { projectId: undefined })]
    ])
    const ledger = { start: vi.fn(() => 'inv'), commit: vi.fn(), failed: vi.fn() }
    const sent: Array<{ threadId: string; input: { content: string; mode: string }; options: { clientRequestId: string; actor: unknown } }> = []
    const answers: { send: () => Promise<AgentSendResult>; stop: () => Promise<AgentRunCommandResult>; steer: () => Promise<AgentRunCommandResult> } = {
      send: async () => ({ runId: `run:sent:${sent.length}`, sequence: 10, queued: false, replayed: false }),
      stop: async () => ({ status: 'accepted', runId: targetRun.runId, sequence: 11, replayed: false }),
      steer: async () => ({ status: 'accepted', runId: targetRun.runId, sequence: 12, replayed: false })
    }
    const fake = fakeAppToolHost({
      agentAccess: () => state.profile,
      threadMeta: (id) => threads.get(id),
      toolLedger: () => ledger,
      sendToThread: vi.fn(async (threadId, input, options) => {
        sent.push({ threadId, input, options })
        return answers.send()
      }),
      stopRun: vi.fn(async () => answers.stop()),
      steerRun: vi.fn(async () => answers.steer()),
      showAgentAction: vi.fn()
    })
    const { registry, turns, request } = appToolRegistry(fx.engine, fake.host)
    turns.register(appTurn({ threadId: 'caller', runId: callerRun.runId }))
    turns.register(appTurn({ threadId: 'target', runId: targetRun.runId }))
    const runs: Record<string, string> = { caller: callerRun.runId, target: targetRun.runId }
    /** A call as `caller`, whose credential was granted `granted` under `modeCeiling`. */
    const as = (granted: AgentAccessLevel, extra: Partial<Parameters<typeof request>[0]> = {}): McpCallRequest =>
      request({ threadId: 'caller', runId: runs.caller, accessLevel: granted, ...extra })
    const call = (granted: AgentAccessLevel, name: string, args: Record<string, unknown> = {}, extra: Partial<Parameters<typeof request>[0]> = {}) =>
      registry.call(name, args, as(granted, extra))
    const denied = (promise: Promise<unknown>) => promise.then(() => undefined, (error: McpToolError) => error)
    const result = async (promise: Promise<{ text: string }>) => JSON.parse((await promise).text)
    return { fx, registry, turns, request, state, threads, ledger, sent, answers, runs, call, as, denied, result, callerRun, targetRun, ...fake }
  }

  const ACTING: Array<[string, Record<string, unknown>]> = [
    ['thread_send', { threadId: 'target', content: 'hello' }],
    ['thread_steer', { threadId: 'target', runId: 'any', text: 'more' }],
    ['thread_interrupt', { threadId: 'target', runId: 'any' }]
  ]

  describe('the access level', () => {
    it.each(['lineage', 'read'] as const)('a credential granted %s is refused every tool that changes another thread, with no ledger row and no host call', async (level) => {
      const { call, denied, ledger, host } = await world({ level: 'manage' })
      for (const [name, args] of ACTING) {
        const error = await denied(call(level, name, { ...args }))
        expect(error, name).toBeInstanceOf(McpToolError)
        expect(error!.code, name).toBe('mousse_scope_denied')
        expect(error!.message, name).toMatch(new RegExp(`needs the "manage" agent access level \\(yours is "${level}"\\)`))
      }
      expect(ledger.start).not.toHaveBeenCalled()
      expect(host.sendToThread).not.toHaveBeenCalled()
      expect(host.stopRun).not.toHaveBeenCalled()
      expect(host.steerRun).not.toHaveBeenCalled()
    })

    it('a manage credential under a profile that was lowered is refused at once, and only up to what the credential was granted', async () => {
      const { call, denied, state, host } = await world({ level: 'manage' })
      expect((await call('manage', 'thread_send', { threadId: 'target', content: 'hi' })).isError).toBeUndefined()
      state.profile = profile({ level: 'read' })
      for (const [name, args] of ACTING) expect((await denied(call('manage', name, { ...args })))!.code, name).toBe('mousse_scope_denied')
      state.profile = profile({ level: 'lineage' })
      expect((await denied(call('manage', 'thread_send', { threadId: 'target', content: 'hi' })))!.message).toMatch(/yours is "lineage"/)
      // Raised again, the profile does not lift a credential that was granted less.
      state.profile = profile({ level: 'manage' })
      expect((await denied(call('read', 'thread_send', { threadId: 'target', content: 'hi' })))!.code).toBe('mousse_scope_denied')
      expect(host.sendToThread).toHaveBeenCalledTimes(1)
    })

    it('a manage credential reaches the host with the caller as the actor, the call id, and a key scoped to the caller thread', async () => {
      const { call, host, runs } = await world()
      await call('manage', 'thread_send', { threadId: 'target', content: 'hello', mode: 'plan' }, { toolCallId: 'mcp:send-1' })
      expect(host.sendToThread).toHaveBeenLastCalledWith('target', { content: 'hello', mode: 'plan' }, {
        clientRequestId: 'thread_send:caller:mcp:send-1',
        actor: { kind: 'agent', threadId: 'caller', runId: runs.caller, toolCallId: 'mcp:send-1' }
      })
      await call('manage', 'thread_steer', { threadId: 'target', runId: runs.target, text: 'also this' }, { toolCallId: 'mcp:steer-1' })
      expect(host.steerRun).toHaveBeenLastCalledWith('target', runs.target, 'also this', expect.objectContaining({ clientRequestId: 'thread_steer:caller:mcp:steer-1' }))
      await call('manage', 'thread_interrupt', { threadId: 'target', runId: runs.target }, { toolCallId: 'mcp:stop-1' })
      expect(host.stopRun).toHaveBeenLastCalledWith('target', runs.target, expect.objectContaining({ clientRequestId: 'thread_interrupt:caller:mcp:stop-1' }))
    })

    it('thread_wait needs read: a lineage credential is refused an unrelated thread, read and manage may wait', async () => {
      const { call, denied, targetRun } = await world()
      const error = await denied(call('lineage', 'thread_wait', { threadId: 'target', runId: targetRun.runId, timeoutMs: 5 }))
      expect(error!.code).toBe('mousse_scope_denied')
      expect(error!.message).toMatch(/needs the "read" agent access level/)
      for (const level of ['read', 'manage'] as const)
        expect(JSON.parse((await call(level, 'thread_wait', { threadId: 'target', runId: targetRun.runId, timeoutMs: 5 })).text).status).toBe('timeout')
    })

    it('tools/list shows each caller only what its level can use', async () => {
      const { registry, state } = await world()
      const names = (granted: AgentAccessLevel) => registry.listForThread('caller', 'default', granted).map((tool) => tool.name).filter((name) => /^thread_(send|wait|steer|interrupt)$/.test(name)).sort()
      // A tool a caller may use on a thread it launched is listed at every level.
      expect(names('lineage')).toEqual(['thread_interrupt'])
      expect(names('read')).toEqual(['thread_interrupt', 'thread_wait'])
      expect(names('manage')).toEqual(['thread_interrupt', 'thread_send', 'thread_steer', 'thread_wait'])
      state.profile = profile({ level: 'read' })
      expect(names('manage')).toEqual(['thread_interrupt', 'thread_wait'])
    })

    it('a plan-ceiling caller is held at read, so it cannot send, steer or stop another thread', async () => {
      const { call, denied, host } = await world()
      // What a plan turn is granted: at most read, whatever the profile says.
      for (const [name, args] of ACTING) expect((await denied(call('read', name, { ...args }, { modeCeiling: 'plan' })))!.code, name).toBe('mousse_scope_denied')
      expect(host.sendToThread).not.toHaveBeenCalled()
    })

    it('a plan ceiling that somehow holds manage still cannot send an agent turn', async () => {
      const { call, denied, host } = await world()
      expect((await denied(call('manage', 'thread_send', { threadId: 'target', content: 'x' }, { modeCeiling: 'plan' })))!.code).toBe('mousse_ceiling_exceeded')
      expect((await call('manage', 'thread_send', { threadId: 'target', content: 'x', mode: 'plan' }, { modeCeiling: 'plan' })).isError).toBeUndefined()
      expect(host.sendToThread).toHaveBeenCalledTimes(1)
    })

    it('a channel or bot thread\'s caller is held at lineage, whatever the profile says, and is refused all four', async () => {
      const { call, denied, host, ledger } = await world({ level: 'manage' })
      // The grant such a thread's turns carry (`Thread.accessCeiling`, the bot wall) is lineage.
      for (const [name, args] of [...ACTING, ['thread_wait', { threadId: 'target', runId: 'any' }] as [string, Record<string, unknown>]])
        expect((await denied(call('lineage', name, { ...args })))!.code, name).toBe('mousse_scope_denied')
      expect(ledger.start).not.toHaveBeenCalled()
      expect(host.sendToThread).not.toHaveBeenCalled()
    })
  })

  describe('the project list', () => {
    it('allows the listed projects only, for all four tools; a thread without a project needs an empty list', async () => {
      const { call, denied, state, host, targetRun } = await world({ projectIds: ['p1'] })
      for (const [name, args] of [
        ['thread_send', { threadId: 'target', content: 'hi' }],
        ['thread_steer', { threadId: 'target', runId: targetRun.runId, text: 'x' }],
        ['thread_interrupt', { threadId: 'target', runId: targetRun.runId }],
        ['thread_wait', { threadId: 'target', runId: targetRun.runId, timeoutMs: 5 }]
      ] as const) {
        expect((await call('manage', name, { ...args })).isError, name).toBeUndefined()
        for (const outside of ['elsewhere', 'loose']) {
          const error = await denied(call('manage', name, { ...args, threadId: outside }))
          expect(error!.code, `${name} ${outside}`).toBe('mousse_scope_denied')
        }
      }
      expect(host.sendToThread).toHaveBeenCalledTimes(1)
      state.profile = profile({ projectIds: [] })
      expect((await call('manage', 'thread_send', { threadId: 'loose', content: 'hi' })).isError).toBeUndefined()
      expect((await call('manage', 'thread_send', { threadId: 'elsewhere', content: 'hi' })).isError).toBeUndefined()
    })

    it('removing the project from the list refuses the next call of the same running credential', async () => {
      const { call, denied, state, host } = await world({ projectIds: ['p1'] })
      expect((await call('manage', 'thread_send', { threadId: 'target', content: 'one' })).isError).toBeUndefined()
      state.profile = profile({ projectIds: ['p2'] })
      expect((await denied(call('manage', 'thread_send', { threadId: 'target', content: 'two' })))!.code).toBe('mousse_scope_denied')
      expect(host.sendToThread).toHaveBeenCalledTimes(1)
    })

    it('a thread the caller launched may be stopped from outside the list, and at lineage; nobody else\'s may', async () => {
      const { call, denied, threads, host, targetRun } = await world({ level: 'lineage', projectIds: ['p1'] })
      threads.set('target', thread('target', { projectId: 'p2', createdByThreadId: 'caller' }))
      expect((await call('lineage', 'thread_interrupt', { threadId: 'target', runId: targetRun.runId })).isError).toBeUndefined()
      expect(host.stopRun).toHaveBeenCalledTimes(1)
      // Launching gives no right to send or steer below manage.
      expect((await denied(call('lineage', 'thread_send', { threadId: 'target', content: 'x' })))!.code).toBe('mousse_scope_denied')
      threads.set('target', thread('target', { projectId: 'p2', createdByThreadId: 'someone-else' }))
      expect((await denied(call('lineage', 'thread_interrupt', { threadId: 'target', runId: targetRun.runId })))!.code).toBe('mousse_scope_denied')
      expect(host.stopRun).toHaveBeenCalledTimes(1)
    })
  })

  describe('thread_send', () => {
    it('refuses the caller\'s own thread and points to queue_enqueue, without a host call', async () => {
      const { call, host } = await world()
      const result = await call('manage', 'thread_send', { threadId: 'caller', content: 'x' })
      expect(result).toMatchObject({ isError: true, text: expect.stringContaining('queue_enqueue') })
      expect(host.sendToThread).not.toHaveBeenCalled()
    })

    it('refuses a subagent, whose parent reaches it with continue_subagent', async () => {
      const { call, denied, fx, callerRun, threads, host } = await world()
      const child = await fx.delegate(callerRun.runId, 'call-1')
      threads.set(child.childThreadId, thread(child.childThreadId))
      const error = await denied(call('manage', 'thread_send', { threadId: child.childThreadId, content: 'x' }))
      expect(error!.code).toBe('mousse_scope_denied')
      expect(error!.message).toContain('continue_subagent')
      expect(host.sendToThread).not.toHaveBeenCalled()
    })

    it('refuses an archived thread as a conflict, and a trashed or unknown one like any thread the caller may not reach', async () => {
      const { call, denied, threads, host } = await world()
      threads.set('target', thread('target', { settledAt: NOW }))
      const archived = await denied(call('manage', 'thread_send', { threadId: 'target', content: 'x' }))
      expect(archived).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'thread_archived', threadId: 'target' } })
      for (const name of ['thread_steer', 'thread_interrupt']) {
        const error = await denied(call('manage', name, { threadId: 'target', runId: 'any', text: 'x' }))
        expect(error!.details, name).toMatchObject({ conflict: 'thread_archived' })
      }
      threads.delete('target')
      expect((await denied(call('manage', 'thread_send', { threadId: 'target', content: 'x' })))!.code).toBe('mousse_scope_denied')
      expect(host.sendToThread).not.toHaveBeenCalled()
    })

    it.each([
      ['questions_pending', /waiting for the user to answer a question or an approval/],
      ['thread_paused', /paused by a usage limit.*thread_interrupt/],
      ['merge_back_pending', /merge-back/]
    ])('a thread the engine refuses because of its state (%s) is a mousse_conflict that says why', async (code, message) => {
      const { call, denied, answers } = await world()
      answers.send = async () => { throw refusal(code, 'A merge-back from fork f waits for this thread\'s next turn.') }
      const error = await denied(call('manage', 'thread_send', { threadId: 'target', content: 'x' }))
      expect(error).toMatchObject({ code: 'mousse_conflict', details: { conflict: code } })
      expect(error!.message).toMatch(message)
    })

    it('any other failure is a tool error, not a conflict', async () => {
      const { call, answers } = await world()
      answers.send = async () => { throw new Error('Thread deleted: target') }
      expect(await call('manage', 'thread_send', { threadId: 'target', content: 'x' })).toMatchObject({ isError: true, text: expect.stringContaining('Thread deleted') })
    })

    it('shows the transcript row once, for the call that made the send and not for its replay', async () => {
      const { call, answers, host } = await world()
      expect(JSON.parse((await call('manage', 'thread_send', { threadId: 'target', content: 'x' })).text)).toMatchObject({ threadId: 'target', queued: false, replayed: false })
      expect(host.showAgentAction).toHaveBeenCalledTimes(1)
      expect(host.showAgentAction).toHaveBeenLastCalledWith({ threadId: 'target' }, expect.objectContaining({ kind: 'agent', threadId: 'caller' }), expect.stringContaining('sent a message'))
      answers.send = async () => ({ runId: 'run:first', sequence: 10, queued: true, replayed: true })
      expect(JSON.parse((await call('manage', 'thread_send', { threadId: 'target', content: 'x' }, { toolCallId: 'mcp:again' })).text)).toMatchObject({ runId: 'run:first', queued: true, replayed: true })
      expect(host.showAgentAction).toHaveBeenCalledTimes(1)
    })

    it('a retry with the same clientRequestId reaches the host with the same key after the caller\'s run was replaced and its credential re-minted', async () => {
      const { call, fx, host, turns, runs, callerRun, sent } = await world()
      await call('manage', 'thread_send', { threadId: 'target', content: 'x', clientRequestId: 'retry-1' }, { toolCallId: 'mcp:first' })
      // The run ends, the provider starts a continuation run, and the credential is minted again.
      fx.finish(callerRun.runId, 'done')
      const next = await fx.runningRun('caller')
      turns.register(appTurn({ threadId: 'caller', runId: next.runId }))
      runs.caller = next.runId
      await call('manage', 'thread_send', { threadId: 'target', content: 'x', clientRequestId: 'retry-1' }, { toolCallId: 'mcp:second' })
      expect(host.sendToThread).toHaveBeenCalledTimes(2)
      expect(sent.map((entry) => entry.options.clientRequestId)).toEqual(['thread_send:caller:retry-1', 'thread_send:caller:retry-1'])
      expect(sent.map((entry) => (entry.options.actor as { runId: string }).runId)).toEqual([callerRun.runId, next.runId])
      // Another thread's key is its own.
      expect(sent[0].options.clientRequestId).not.toBe('thread_send:target:retry-1')
    })

    it(`is capped at ${THREAD_SEND_MAX_PER_RUN} messages per caller run: a loop of sends is cut off, retries and failures do not count, another run starts fresh`, async () => {
      const { call, answers, host, sent, fx, turns, runs, callerRun } = await world()
      for (let index = 0; index < THREAD_SEND_MAX_PER_RUN; index += 1)
        expect((await call('manage', 'thread_send', { threadId: 'target', content: `m${index}` })).isError, `send ${index}`).toBeUndefined()
      const over = await call('manage', 'thread_send', { threadId: 'target', content: 'one too many' })
      expect(over).toMatchObject({ isError: true, text: expect.stringContaining(`limited to ${THREAD_SEND_MAX_PER_RUN}`) })
      expect(host.sendToThread).toHaveBeenCalledTimes(THREAD_SEND_MAX_PER_RUN)
      expect(sent).toHaveLength(THREAD_SEND_MAX_PER_RUN)

      // A new run of the same thread has its own count (a new turn, not the loop of the old one).
      fx.finish(callerRun.runId, 'done')
      const next = await fx.runningRun('caller')
      turns.register(appTurn({ threadId: 'caller', runId: next.runId }))
      runs.caller = next.runId
      // Replays and refused sends are not sends: they leave the budget alone.
      answers.send = async () => ({ runId: 'run:first', sequence: 10, queued: false, replayed: true })
      for (let index = 0; index < THREAD_SEND_MAX_PER_RUN + 5; index += 1) await call('manage', 'thread_send', { threadId: 'target', content: 'retry' })
      answers.send = async () => { throw refusal('questions_pending') }
      for (let index = 0; index < THREAD_SEND_MAX_PER_RUN + 5; index += 1) await call('manage', 'thread_send', { threadId: 'target', content: 'busy' }).catch(() => undefined)
      answers.send = async () => ({ runId: 'run:fresh', sequence: 10, queued: false, replayed: false })
      for (let index = 0; index < THREAD_SEND_MAX_PER_RUN; index += 1)
        expect((await call('manage', 'thread_send', { threadId: 'target', content: `n${index}` })).isError, `fresh ${index}`).toBeUndefined()
      expect((await call('manage', 'thread_send', { threadId: 'target', content: 'over again' })).isError).toBe(true)
    })

    it('validates its input before it reaches the host', async () => {
      const { call, host } = await world()
      for (const args of [{ threadId: 'target' }, { threadId: 'target', content: '   ' }, { threadId: 'target', content: 'x', mode: 'build' }, { content: 'x' }] as Array<Record<string, unknown>>)
        expect((await call('manage', 'thread_send', args).catch((error) => ({ isError: true, error }))).isError, JSON.stringify(args)).toBe(true)
      expect(host.sendToThread).not.toHaveBeenCalled()
    })

    it('says it is not available in a host that cannot send', async () => {
      const { registry, request, host, runs } = await world()
      delete (host as { sendToThread?: unknown }).sendToThread
      const outcome = await registry.call('thread_send', { threadId: 'target', content: 'x' }, request({ threadId: 'caller', runId: runs.caller, accessLevel: 'manage' }))
      expect(outcome).toMatchObject({ isError: true, text: expect.stringContaining('not available in this host') })
    })
  })

  describe('thread_interrupt and thread_steer', () => {
    it('a run that is no longer the active one is a conflict naming the run that is, and nothing else changes', async () => {
      const { call, denied, answers, host, targetRun } = await world()
      answers.stop = async () => ({ status: 'ignored', reason: 'run_not_active', runId: targetRun.runId, activeRunId: 'run:newer', runStatus: 'completed' })
      answers.steer = answers.stop
      for (const [name, args] of [
        ['thread_interrupt', { threadId: 'target', runId: targetRun.runId }],
        ['thread_steer', { threadId: 'target', runId: targetRun.runId, text: 'x' }]
      ] as const) {
        const error = await denied(call('manage', name, { ...args }))
        expect(error, name).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'run_not_active', expectedRunId: targetRun.runId, activeRunId: 'run:newer' } })
      }
      expect(host.showAgentAction).not.toHaveBeenCalled()
    })

    it('a paused run is stopped by thread_interrupt; thread_steer is told it has no live turn', async () => {
      const { call, denied, answers, host, targetRun } = await world()
      answers.stop = async () => ({ status: 'accepted', runId: targetRun.runId, sequence: 13, replayed: false })
      expect(JSON.parse((await call('manage', 'thread_interrupt', { threadId: 'target', runId: targetRun.runId })).text)).toMatchObject({ runId: targetRun.runId, replayed: false })
      expect(host.showAgentAction).toHaveBeenCalledWith({ threadId: 'target' }, expect.anything(), `stopped run ${targetRun.runId}`)
      answers.steer = async () => ({ status: 'ignored', reason: 'run_not_active', runId: targetRun.runId, activeRunId: null, runStatus: 'paused' })
      const error = await denied(call('manage', 'thread_steer', { threadId: 'target', runId: targetRun.runId, text: 'x' }))
      expect(error).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'run_paused', expectedRunId: targetRun.runId } })
      expect(error!.message).toMatch(/paused by a usage limit.*thread_interrupt/)
    })

    it('a steer into a run under a looser permission mode than the caller\'s is a conflict with both modes', async () => {
      const { call, denied, answers, targetRun } = await world()
      answers.steer = async () => ({ status: 'ceiling_exceeded', callerMode: 'ask', targetMode: 'full' })
      const error = await denied(call('manage', 'thread_steer', { threadId: 'target', runId: targetRun.runId, text: 'x' }))
      expect(error).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'ceiling_exceeded', callerMode: 'ask', targetMode: 'full' } })
    })

    it('shows the transcript row for a steer that was accepted, and not for its replay', async () => {
      const { call, answers, host, targetRun } = await world()
      await call('manage', 'thread_steer', { threadId: 'target', runId: targetRun.runId, text: 'x' })
      answers.steer = async () => ({ status: 'accepted', runId: targetRun.runId, sequence: 12, replayed: true })
      await call('manage', 'thread_steer', { threadId: 'target', runId: targetRun.runId, text: 'x' })
      expect(host.showAgentAction).toHaveBeenCalledTimes(1)
    })

    it('requires the run and the text', async () => {
      const { call, host } = await world()
      for (const [name, args] of [['thread_interrupt', { threadId: 'target' }], ['thread_steer', { threadId: 'target', runId: 'r' }], ['thread_steer', { threadId: 'target', runId: 'r', text: ' ' }]] as const)
        expect((await call('manage', name, { ...args }).catch((error) => ({ isError: true, error }))).isError, name).toBe(true)
      expect(host.stopRun).not.toHaveBeenCalled()
      expect(host.steerRun).not.toHaveBeenCalled()
    })

    it('refuses the caller\'s own thread', async () => {
      const { call, host, runs } = await world()
      expect((await call('manage', 'thread_interrupt', { threadId: 'caller', runId: runs.caller })).isError).toBe(true)
      expect((await call('manage', 'thread_steer', { threadId: 'caller', runId: runs.caller, text: 'x' })).isError).toBe(true)
      expect(host.stopRun).not.toHaveBeenCalled()
      expect(host.steerRun).not.toHaveBeenCalled()
    })
  })

  describe('thread_wait', () => {
    it('returns the text of the run it waited for, never another run\'s, even when a later run finished first', async () => {
      const { call, result, fx, targetRun } = await world()
      fx.finish(targetRun.runId, 'answer of A')
      const b = await fx.runningRun('target')
      fx.finish(b.runId, 'answer of B')
      const waitedA = await result(call('manage', 'thread_wait', { threadId: 'target', runId: targetRun.runId }))
      expect(waitedA).toMatchObject({ status: 'finished', run: { runId: targetRun.runId, status: 'completed' }, resultText: 'answer of A' })
      expect((await result(call('manage', 'thread_wait', { threadId: 'target', runId: b.runId }))).resultText).toBe('answer of B')
    })

    it('waits for the run to finish and resolves the moment it does', async () => {
      const { call, result, fx, targetRun } = await world()
      const waiting = result(call('manage', 'thread_wait', { threadId: 'target', runId: targetRun.runId }))
      await new Promise((resolve) => setTimeout(resolve, 20))
      fx.finish(targetRun.runId, 'late answer')
      expect(await waiting).toMatchObject({ status: 'finished', resultText: 'late answer' })
    })

    it('without a run id it waits for the one that is active now, and says idle when there is none', async () => {
      const { call, result, fx, targetRun } = await world()
      const waiting = result(call('manage', 'thread_wait', { threadId: 'target' }))
      await new Promise((resolve) => setTimeout(resolve, 10))
      fx.finish(targetRun.runId, 'the active one')
      expect(await waiting).toMatchObject({ status: 'finished', run: { runId: targetRun.runId }, resultText: 'the active one' })
      expect(await result(call('manage', 'thread_wait', { threadId: 'target' }))).toEqual({ status: 'idle', threadId: 'target' })
    })

    it('a run that left no text is finished without resultText', async () => {
      const { call, result, fx, targetRun } = await world()
      fx.engine.markTerminal(targetRun.runId, 'failed', { error: 'the model failed' })
      const waited = await result(call('manage', 'thread_wait', { threadId: 'target', runId: targetRun.runId }))
      expect(waited).toMatchObject({ status: 'finished', run: { status: 'failed', error: 'the model failed' } })
      expect(waited.resultText).toBeUndefined()
    })

    it('a run that ends between the check and the listener is still seen: the listener is in place before the run is read', async () => {
      const { call, result, fx, targetRun } = await world()
      const read = fx.engine.getRun.bind(fx.engine)
      let first = true
      // The run ends right after the handler looks at it, before it waits: its record still says running.
      vi.spyOn(fx.engine, 'getRun').mockImplementation((runId: string) => {
        const seen = read(runId)
        if (first && runId === targetRun.runId) {
          first = false
          fx.finish(targetRun.runId, 'ended in the gap')
        }
        return seen
      })
      const waited = await Promise.race([
        result(call('manage', 'thread_wait', { threadId: 'target', runId: targetRun.runId, timeoutMs: 2_000 })),
        new Promise((resolve) => setTimeout(() => resolve('hung'), 1_500))
      ])
      expect(waited).toMatchObject({ status: 'finished', resultText: 'ended in the gap' })
    })

    it('times out with a call-again hint, never interrupts the run, and leaves no listener behind', async () => {
      const { call, result, fx, targetRun } = await world()
      const listeners = (fx.store as unknown as { eventListeners: Set<unknown> }).eventListeners
      const before = listeners.size
      const started = Date.now()
      const waited = await result(call('manage', 'thread_wait', { threadId: 'target', runId: targetRun.runId, timeoutMs: 30 }))
      expect(Date.now() - started).toBeGreaterThanOrEqual(25)
      expect(waited).toEqual({ status: 'timeout', threadId: 'target', run: { runId: targetRun.runId, status: 'running' }, hint: 'The run is still going; call thread_wait again.' })
      expect(fx.engine.getRun(targetRun.runId)).toMatchObject({ status: 'running' })
      expect(fx.engine.getRun(targetRun.runId)?.outcome?.stopRequested).toBeUndefined()
      expect(listeners.size).toBe(before)
    })

    it('ends when the caller\'s own run ends (its signal aborts), and removes its listener', async () => {
      const { call, result, fx, targetRun } = await world()
      const listeners = (fx.store as unknown as { eventListeners: Set<unknown> }).eventListeners
      const before = listeners.size
      const controller = new AbortController()
      const waiting = result(call('manage', 'thread_wait', { threadId: 'target', runId: targetRun.runId, timeoutMs: 60_000 }, { signal: controller.signal }))
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(listeners.size).toBe(before + 1)
      controller.abort()
      expect(await waiting).toEqual({ status: 'caller_ended', threadId: 'target' })
      expect(listeners.size).toBe(before)
      // Already ended when the wait starts: nothing is waited for.
      expect(await result(call('manage', 'thread_wait', { threadId: 'target', runId: targetRun.runId }, { signal: controller.signal }))).toEqual({ status: 'caller_ended', threadId: 'target' })
      expect(listeners.size).toBe(before)
    })

    it('reports a paused run at once instead of holding the call for hours, and says how to go on', async () => {
      const { call, result, fx, targetRun } = await world()
      fx.engine.pauseRun({ runId: targetRun.runId, pause: PAUSE })
      const waited = await result(call('manage', 'thread_wait', { threadId: 'target', runId: targetRun.runId, timeoutMs: 60_000 }))
      expect(waited).toMatchObject({ status: 'paused', run: { runId: targetRun.runId, status: 'paused' }, pause: { reason: 'usage_limit', until: PAUSE.until } })
      expect(waited.hint).toMatch(/thread_interrupt/)
      // Without a run id the paused run is the one waited on; a wait that began before the pause ends with it.
      expect((await result(call('manage', 'thread_wait', { threadId: 'target' }))).status).toBe('paused')
    })

    it('a wait that is running when the run pauses ends with paused', async () => {
      const { call, result, fx, targetRun } = await world()
      const waiting = result(call('manage', 'thread_wait', { threadId: 'target', runId: targetRun.runId, timeoutMs: 60_000 }))
      await new Promise((resolve) => setTimeout(resolve, 10))
      fx.engine.pauseRun({ runId: targetRun.runId, pause: PAUSE })
      expect((await waiting).status).toBe('paused')
    })

    it('refuses a run of another thread, the caller\'s own thread and a bad timeout', async () => {
      const { call, denied, runs, fx } = await world()
      const other = await fx.runningRun('elsewhere')
      expect((await denied(call('manage', 'thread_wait', { threadId: 'target', runId: other.runId })))).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'run_not_found' } })
      expect((await call('manage', 'thread_wait', { threadId: 'caller', runId: runs.caller })).isError).toBe(true)
      for (const timeoutMs of [0, -5, 300_001, 1.5, '10'])
        expect((await call('manage', 'thread_wait', { threadId: 'target', timeoutMs }).catch((error) => ({ isError: true, error }))).isError, String(timeoutMs)).toBe(true)
    })

    it('shows the final text of a descendant or a launched thread at lineage, and never of an ancestor, a sibling or through read', async () => {
      const { fx, registry, request, turns, state, threads, callerRun, runs } = await world({ level: 'read' })
      const a = await fx.delegate(callerRun.runId, 'call-a')
      const b = await fx.delegate(callerRun.runId, 'call-b')
      for (const child of [a, b]) threads.set(child.childThreadId, thread(child.childThreadId))
      fx.finish(a.childRunId, 'result of child a')
      fx.finish(b.childRunId, 'result of child b')
      const wait = async (who: { threadId: string; runId: string }, target: string, runId: string, level: AgentAccessLevel = 'lineage') =>
        JSON.parse((await registry.call('thread_wait', { threadId: target, runId, timeoutMs: 20 }, request({ ...who, accessLevel: level }))).text)
      // The caller reads its own subagent's text (a descendant).
      expect(await wait({ threadId: 'caller', runId: runs.caller }, a.childThreadId, a.childRunId, 'read')).toMatchObject({ resultText: 'result of child a' })
      // A launched thread is the caller's, at any level.
      threads.set('target', thread('target', { createdByThreadId: 'caller' }))
      fx.finish(runs.target, 'launched answer')
      expect(await wait({ threadId: 'caller', runId: runs.caller }, 'target', runs.target, 'read')).toMatchObject({ resultText: 'launched answer' })
      // Through read alone another thread's text is not shown, nor its error.
      threads.set('target', thread('target'))
      const viaRead = await wait({ threadId: 'caller', runId: runs.caller }, 'target', runs.target, 'read')
      expect(viaRead).toMatchObject({ status: 'finished', run: { status: 'completed' } })
      expect(viaRead.resultText).toBeUndefined()
      // A sibling reads its sibling's lifecycle but not its text; the text stays with the manager.
      const next = await fx.runningRun(a.childThreadId)
      turns.register(appTurn({ threadId: a.childThreadId, runId: next.runId }))
      const sibling = await wait({ threadId: a.childThreadId, runId: next.runId }, b.childThreadId, b.childRunId, 'read')
      expect(sibling).toMatchObject({ status: 'finished' })
      expect(sibling.resultText).toBeUndefined()
      state.profile = profile({ level: 'manage' })
      expect((await wait({ threadId: a.childThreadId, runId: next.runId }, b.childThreadId, b.childRunId, 'manage')).resultText).toBe('result of child b')
    })
  })

  describe('thread_read keeps a run\'s final text from those who may not have it', () => {
    it('events of an ancestor or sibling carry no run.result; a descendant\'s and the manager\'s do', async () => {
      const { fx, registry, request, turns, state, threads, callerRun, runs } = await world({ level: 'read' })
      const a = await fx.delegate(callerRun.runId, 'call-a')
      const b = await fx.delegate(callerRun.runId, 'call-b')
      for (const child of [a, b]) threads.set(child.childThreadId, thread(child.childThreadId))
      fx.finish(b.childRunId, 'result of child b')
      fx.finish(runs.caller, 'parent text')
      fx.engine.markStarting(a.childRunId)
      fx.engine.markRunning(a.childRunId)
      turns.register(appTurn({ threadId: a.childThreadId, runId: a.childRunId }))
      const read = async (granted: AgentAccessLevel, who: { threadId: string; runId: string }, threadId: string) =>
        JSON.stringify(JSON.parse((await registry.call('thread_read', { threadId }, request({ ...who, accessLevel: granted }))).text).events)
      // A child reading its parent (ancestor) and its sibling.
      expect(await read('lineage', { threadId: a.childThreadId, runId: a.childRunId }, 'caller')).not.toContain('parent text')
      expect(await read('read', { threadId: a.childThreadId, runId: a.childRunId }, b.childThreadId)).not.toContain('result of child b')
      // The parent reading its descendant.
      const parentRun = (await fx.runningRun('caller'))
      turns.register(appTurn({ threadId: 'caller', runId: parentRun.runId }))
      expect(await read('lineage', { threadId: 'caller', runId: parentRun.runId }, b.childThreadId)).toContain('result of child b')
      state.profile = profile({ level: 'manage' })
      expect(await read('manage', { threadId: a.childThreadId, runId: a.childRunId }, b.childThreadId)).toContain('result of child b')
    })
  })
})
