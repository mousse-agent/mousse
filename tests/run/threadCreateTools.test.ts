/**
 * `thread_create` through the registry's central check (docs/run-engine/SPEC.md §15.1): the access level and
 * project list, the arguments it refuses before the host is asked, bot and plan callers, the per-run cap
 * with a replay past it, and what the creator may do with the thread afterwards.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentAccessLevel, AgentAccessSettings } from '../../src/shared/settings'
import type { Thread } from '../../src/shared/types'
import { McpToolError, type AgentCreatedThread, type McpCallRequest } from '../../src/mms/run/mcp/appTools'
import { THREAD_CREATE_MAX_PER_RUN } from '../../src/mms/run/mcp/appTools/thread'
import { appToolRegistry, appTurn, fakeAppToolHost } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

const NOW = '2026-10-12T00:00:00.000Z'
const thread = (id: string, patch: Partial<Thread> = {}): Thread => ({ id, name: `Thread ${id}`, createdAt: NOW, updatedAt: NOW, startedAt: NOW, projectId: 'p1', ...patch }) as Thread
const profile = (patch: Partial<AgentAccessSettings> = {}): AgentAccessSettings => ({ level: 'manage', projectIds: [], answerApprovals: false, ...patch })

const created = (threadId: string, patch: Partial<AgentCreatedThread> = {}): AgentCreatedThread => ({
  threadId,
  projectId: 'p1',
  title: 'New Thread',
  workspace: 'project',
  model: null,
  permissionMode: 'full',
  replayed: false,
  ...patch
})

describe('thread_create (SPEC §15.1)', () => {
  let fx: DelegationFixture | undefined
  afterEach(() => {
    fx?.dispose()
    fx = undefined
  })

  /** `caller` holds a live run; `state.profile` is the setting as it is now, read at every call. */
  const world = async (initial: Partial<AgentAccessSettings> = {}, extraHost: Parameters<typeof fakeAppToolHost>[0] = {}) => {
    fx = delegationFixture()
    const callerRun = await fx.runningRun('caller')
    const state = { profile: profile(initial) }
    const threads = new Map<string, Thread>([['caller', thread('caller')]])
    const ledger = { start: vi.fn(() => 'inv'), commit: vi.fn(), failed: vi.fn() }
    let made = 0
    const fake = fakeAppToolHost({
      agentAccess: () => state.profile,
      threadMeta: (id) => threads.get(id),
      toolLedger: () => ledger,
      createThread: vi.fn(async () => created(`new-${(made += 1)}`)),
      earlierCreation: vi.fn(() => undefined),
      stopRun: vi.fn(async (_threadId, runId) => ({ status: 'accepted' as const, runId, sequence: 1, replayed: false })),
      showAgentAction: vi.fn(),
      ...extraHost
    })
    const { registry, turns, request } = appToolRegistry(fx.engine, fake.host)
    turns.register(appTurn({ threadId: 'caller', runId: callerRun.runId }))
    const as = (granted: AgentAccessLevel, extra: Partial<Parameters<typeof request>[0]> = {}): McpCallRequest =>
      request({ threadId: 'caller', runId: callerRun.runId, accessLevel: granted, ...extra })
    const call = (granted: AgentAccessLevel, args: Record<string, unknown> = { projectId: 'p1' }, extra: Partial<Parameters<typeof request>[0]> = {}) =>
      registry.call('thread_create', args, as(granted, extra))
    const denied = (promise: Promise<unknown>) => promise.then(() => undefined, (error: McpToolError) => error)
    return { fx, registry, state, threads, ledger, call, as, denied, callerRun, ...fake }
  }

  describe('who may create', () => {
    it.each(['lineage', 'read'] as const)('a credential granted %s is refused, with no ledger row and no host call', async (level) => {
      const { call, denied, ledger, host } = await world()
      const error = await denied(call(level))
      expect(error).toBeInstanceOf(McpToolError)
      expect(error!.code).toBe('mousse_scope_denied')
      expect(error!.message).toMatch(new RegExp(`needs the "manage" agent access level \\(yours is "${level}"\\)`))
      expect(ledger.start).not.toHaveBeenCalled()
      expect(host.createThread).not.toHaveBeenCalled()
    })

    it('a manage credential under a profile that was lowered is refused at once; raising the profile does not lift a smaller grant', async () => {
      const { call, denied, state, host } = await world()
      expect((await call('manage')).isError).toBeUndefined()
      state.profile = profile({ level: 'read' })
      expect((await denied(call('manage')))!.message).toMatch(/yours is "read"/)
      state.profile = profile({ level: 'manage' })
      expect((await denied(call('read')))!.code).toBe('mousse_scope_denied')
      expect(host.createThread).toHaveBeenCalledTimes(1)
    })

    it('needs a project the profile allows: another project is refused, and so is a list that leaves it out', async () => {
      const { call, denied, state, host } = await world({ projectIds: ['p1'] })
      expect((await call('manage', { projectId: 'p1' })).isError).toBeUndefined()
      const error = await denied(call('manage', { projectId: 'p2' }))
      expect(error!.code).toBe('mousse_scope_denied')
      expect(host.createThread).toHaveBeenCalledTimes(1)
      // The list changes under a running credential: the next call sees it.
      state.profile = profile({ projectIds: ['p2'] })
      expect((await denied(call('manage', { projectId: 'p1' })))!.code).toBe('mousse_scope_denied')
      expect((await call('manage', { projectId: 'p2' })).isError).toBeUndefined()
      expect(host.createThread).toHaveBeenCalledTimes(2)
    })

    it('is listed for manage only, and hidden once the profile is lowered', async () => {
      const { registry, state } = await world()
      const listed = (granted: AgentAccessLevel) => registry.listForThread('caller', 'default', granted).map((tool) => tool.name).includes('thread_create')
      expect([listed('lineage'), listed('read'), listed('manage')]).toEqual([false, false, true])
      state.profile = profile({ level: 'read' })
      expect(listed('manage')).toBe(false)
    })

    it('a bot\'s thread is refused even when its credential says manage', async () => {
      const { call, denied, host, ledger } = await world({}, { botRole: () => 'activation' })
      const error = await denied(call('manage'))
      expect(error!.code).toBe('mousse_scope_denied')
      expect(error!.message).toMatch(/bot/)
      expect(host.createThread).not.toHaveBeenCalled()
      // It failed in the handler, so the ledger says so; nothing was made.
      expect(ledger.commit).not.toHaveBeenCalled()
    })

    it('a plan ceiling that somehow holds manage still cannot start a thread', async () => {
      const { call, denied, host } = await world()
      expect((await denied(call('manage', { projectId: 'p1' }, { modeCeiling: 'plan' })))!.code).toBe('mousse_ceiling_exceeded')
      expect(host.createThread).not.toHaveBeenCalled()
    })
  })

  describe('what it refuses before the host is asked', () => {
    it('existing_worktree names the limit and creates nothing', async () => {
      const { call, host } = await world()
      const result = await call('manage', { projectId: 'p1', workspace: 'existing_worktree' })
      expect(result).toMatchObject({ isError: true, text: expect.stringContaining('existing_worktree') })
      expect(result.text).toContain('No thread was created')
      expect(host.createThread).not.toHaveBeenCalled()
    })

    it.each([
      [{}, /projectId/],
      [{ projectId: 'p1', workspace: 'somewhere' }, /workspace/],
      [{ projectId: 'p1', instanceId: 'claude' }, /instanceId needs model/],
      [{ projectId: 'p1', model: ' ' }, /model must be/],
      [{ projectId: 'p1', title: 5 }, /title must be a string/],
      [{ projectId: 'p1', title: 'x'.repeat(201) }, /title must be at most/],
      [{ projectId: 'p1', firstMessage: '   ' }, /firstMessage must be/],
      [{ projectId: 'p1', mode: 'plan' }, /mode is the mode of firstMessage/],
      [{ projectId: 'p1', firstMessage: 'x', mode: 'build' }, /mode must be agent or plan/]
    ])('%o is an error result', async (args, message) => {
      const { call, host } = await world()
      const result = await call('manage', args as Record<string, unknown>)
      expect(result.isError).toBe(true)
      expect(result.text).toMatch(message)
      expect(host.createThread).not.toHaveBeenCalled()
    })

    it('a host without thread creation says so', async () => {
      const { call } = await world({}, { createThread: undefined })
      expect(await call('manage')).toMatchObject({ isError: true, text: 'thread_create is not available in this host.' })
    })
  })

  describe('what the host is asked for', () => {
    it('the normalized launch, the caller as the actor with this call, the caller\'s granted level and a key scoped to the caller thread', async () => {
      const { call, host, callerRun } = await world()
      const result = await call('manage', {
        projectId: 'p1', title: '  Fix the build  ', workspace: 'new_worktree', instanceId: ' claude ', model: 'sonnet', firstMessage: 'Please fix it', mode: 'plan'
      }, { toolCallId: 'mcp:create-1' })
      expect(JSON.parse(result.text)).toMatchObject({ threadId: 'new-1', replayed: false })
      expect(host.createThread).toHaveBeenLastCalledWith(
        { projectId: 'p1', title: 'Fix the build', workspace: 'new_worktree', instanceId: 'claude', model: 'sonnet', firstMessage: 'Please fix it', mode: 'plan' },
        { clientRequestId: 'thread_create:caller:mcp:create-1', actor: { kind: 'agent', threadId: 'caller', runId: callerRun.runId, toolCallId: 'mcp:create-1' }, accessLevel: 'manage' }
      )
      // Defaults: the project's folder, no title, no message.
      await call('manage', { projectId: 'p1', clientRequestId: 'again' })
      expect(host.createThread).toHaveBeenLastCalledWith(
        { projectId: 'p1', workspace: 'project' },
        expect.objectContaining({ clientRequestId: 'thread_create:caller:again' })
      )
      // A first message defaults to an agent turn.
      await call('manage', { projectId: 'p1', firstMessage: 'go' })
      expect(host.createThread).toHaveBeenLastCalledWith({ projectId: 'p1', workspace: 'project', firstMessage: 'go', mode: 'agent' }, expect.anything())
    })

    it('adds the transcript row only for the call that created the thread, never for a replay', async () => {
      const { call, host, callerRun } = await world({}, {
        createThread: vi.fn()
          .mockResolvedValueOnce(created('t1'))
          .mockResolvedValueOnce(created('t1', { replayed: true }))
      })
      await call('manage', { projectId: 'p1', clientRequestId: 'k' })
      await call('manage', { projectId: 'p1', clientRequestId: 'k' })
      expect(host.showAgentAction).toHaveBeenCalledTimes(1)
      expect(host.showAgentAction).toHaveBeenCalledWith({ threadId: 't1' }, expect.objectContaining({ threadId: 'caller', runId: callerRun.runId }), 'created this thread')
    })

    it('a refusal of the host reaches the caller as an error and frees its place under the cap', async () => {
      const { call, host } = await world({}, {
        createThread: vi.fn()
          .mockRejectedValueOnce(Object.assign(new Error('too many in a row'), { code: 'agent_hops_exceeded' }))
          .mockResolvedValue(created('t1'))
      })
      const error = await call('manage', { projectId: 'p1', firstMessage: 'go' }).then(() => undefined, (thrown: McpToolError) => thrown)
      expect(error).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'agent_hops_exceeded' } })
      for (let index = 0; index < THREAD_CREATE_MAX_PER_RUN; index += 1) expect((await call('manage')).isError).toBeUndefined()
      expect(host.createThread).toHaveBeenCalledTimes(THREAD_CREATE_MAX_PER_RUN + 1)
    })
  })

  describe('the cap per run', () => {
    it(`a run may create ${THREAD_CREATE_MAX_PER_RUN} threads; the next is refused and asks the host for nothing`, async () => {
      const { call, host } = await world()
      for (let index = 0; index < THREAD_CREATE_MAX_PER_RUN; index += 1) expect((await call('manage')).isError, `${index}`).toBeUndefined()
      const refused = await call('manage')
      expect(refused).toMatchObject({ isError: true, text: expect.stringContaining(`limited to ${THREAD_CREATE_MAX_PER_RUN} threads per run`) })
      expect(host.createThread).toHaveBeenCalledTimes(THREAD_CREATE_MAX_PER_RUN)
    })

    it('a retry of a creation already made is answered with its thread at the cap; a new one is still refused', async () => {
      const earlier = created('first')
      const { call, host } = await world({}, { earlierCreation: vi.fn((key: string) => (key === 'thread_create:caller:k-0' ? earlier : undefined)) })
      for (let index = 0; index < THREAD_CREATE_MAX_PER_RUN; index += 1) await call('manage', { projectId: 'p1', clientRequestId: `k-${index}` })
      const retry = await call('manage', { projectId: 'p1', clientRequestId: 'k-0' })
      expect(JSON.parse(retry.text)).toMatchObject({ threadId: 'first', replayed: true })
      expect((await call('manage', { projectId: 'p1', clientRequestId: 'k-new' })).isError).toBe(true)
      expect(host.createThread).toHaveBeenCalledTimes(THREAD_CREATE_MAX_PER_RUN)
    })

    it('a replayed creation does not use up a place', async () => {
      const { call, host } = await world({}, { createThread: vi.fn(async () => created('same', { replayed: true })) })
      for (let index = 0; index < THREAD_CREATE_MAX_PER_RUN + 3; index += 1) expect((await call('manage', { projectId: 'p1', clientRequestId: 'k' })).isError).toBeUndefined()
      expect(host.createThread).toHaveBeenCalledTimes(THREAD_CREATE_MAX_PER_RUN + 3)
    })
  })

  describe('the creator and the thread it launched', () => {
    it('reads, waits on and interrupts it at lineage, with the profile set back; sending and steering it still need manage', async () => {
      const { call, registry, as, state, threads, fx, host } = await world()
      const made = JSON.parse((await call('manage')).text) as AgentCreatedThread
      // What the host stored on the thread: launched by the caller's thread, in the caller's project.
      threads.set(made.threadId, thread(made.threadId, { createdByThreadId: 'caller' }))
      const targetRun = await fx.runningRun(made.threadId)
      state.profile = profile({ level: 'lineage' })
      const lineage = as('manage')
      const denied = (promise: Promise<unknown>) => promise.then(() => undefined, (error: McpToolError) => error)

      expect(JSON.parse((await registry.call('thread_read', { threadId: made.threadId }, lineage)).text)).toMatchObject({ threadId: made.threadId, scope: 'launched' })
      expect(JSON.parse((await registry.call('thread_wait', { threadId: made.threadId, runId: targetRun.runId, timeoutMs: 5 }, lineage)).text).status).toBe('timeout')
      // thread_wait is listed at every level, so the creator sees it once it is back at lineage.
      expect(registry.listForThread('caller', 'default', 'manage').map((tool) => tool.name)).toContain('thread_wait')
      expect((await registry.call('thread_interrupt', { threadId: made.threadId, runId: targetRun.runId }, lineage)).isError).toBeUndefined()
      expect(host.stopRun).toHaveBeenCalledTimes(1)
      for (const [name, args] of [
        ['thread_send', { threadId: made.threadId, content: 'x' }],
        ['thread_steer', { threadId: made.threadId, runId: targetRun.runId, text: 'x' }]
      ] as const)
        expect((await denied(registry.call(name, { ...args }, lineage)))!.code, name).toBe('mousse_scope_denied')
    })

    it('another thread\'s creation is not the caller\'s to wait on at lineage', async () => {
      const { registry, as, threads, fx } = await world()
      threads.set('other', thread('other', { createdByThreadId: 'someone-else' }))
      const run = await fx.runningRun('other')
      const error = await registry.call('thread_wait', { threadId: 'other', runId: run.runId, timeoutMs: 5 }, as('lineage')).then(() => undefined, (thrown: McpToolError) => thrown)
      expect(error!.code).toBe('mousse_scope_denied')
    })
  })
})
