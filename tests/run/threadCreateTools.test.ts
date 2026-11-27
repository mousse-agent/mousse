/**
 * `thread_create` through the registry's central check (docs/run-engine/SPEC.md §15.1): the arguments it refuses
 * before the host is asked, bot and plan callers, that a run has no count of threads it creates, and what the creator
 * may do with the thread afterwards.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Thread } from '../../src/shared/types'
import type { AgentCreatedThread, McpCallRequest } from '../../src/mms/run/mcp/appTools'
import { appToolRegistry, appTurn, denied as refusalIn, fakeAppToolHost } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

const NOW = '2026-10-12T00:00:00.000Z'
const thread = (id: string, patch: Partial<Thread> = {}): Thread => ({ id, name: `Thread ${id}`, createdAt: NOW, updatedAt: NOW, startedAt: NOW, projectId: 'p1', ...patch }) as Thread

const created = (threadId: string, patch: Partial<AgentCreatedThread> = {}): AgentCreatedThread => ({
  threadId,
  projectId: 'p1',
  title: 'New Thread',
  workspace: 'project',
  runsIn: 'project_folder',
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

  /** `caller` holds a live run. */
  const world = async (extraHost: Parameters<typeof fakeAppToolHost>[0] = {}) => {
    fx = delegationFixture()
    const callerRun = await fx.runningRun('caller')
    const threads = new Map<string, Thread>([['caller', thread('caller')]])
    const ledger = { start: vi.fn(() => 'inv'), commit: vi.fn(), failed: vi.fn() }
    let made = 0
    const fake = fakeAppToolHost({
      threadMeta: (id) => threads.get(id),
      toolLedger: () => ledger,
      createThread: vi.fn(async () => created(`new-${(made += 1)}`)),
      noteOnThread: vi.fn(),
      stopRun: vi.fn(async (_threadId, runId) => ({ status: 'accepted' as const, runId, sequence: 1, replayed: false })),
      showAgentAction: vi.fn(),
      ...extraHost
    })
    const { registry, turns, request } = appToolRegistry(fx.engine, fake.host)
    turns.register(appTurn({ threadId: 'caller', runId: callerRun.runId }))
    const as = (extra: Partial<Parameters<typeof request>[0]> = {}): McpCallRequest =>
      request({ threadId: 'caller', runId: callerRun.runId, ...extra })
    const call = (args: Record<string, unknown> = { projectId: 'p1' }, extra: Partial<Parameters<typeof request>[0]> = {}) =>
      registry.call('thread_create', args, as(extra))
    const denied = refusalIn
    return { fx, registry, threads, ledger, call, as, denied, callerRun, ...fake }
  }

  describe('who may create', () => {
    it('a bot\'s thread is refused', async () => {
      const { call, denied, host, ledger } = await world({ botRole: () => 'activation' })
      const error = await denied(call())
      expect(error!.code).toBe('mousse_scope_denied')
      expect(error!.message).toMatch(/bot/)
      expect(host.createThread).not.toHaveBeenCalled()
      // It failed in the handler, so the ledger says so; nothing was made.
      expect(ledger.commit).not.toHaveBeenCalled()
    })
  })

  describe('what it refuses before the host is asked', () => {
    it('existing_worktree names the limit and creates nothing', async () => {
      const { call, host } = await world()
      const result = await call({ projectId: 'p1', workspace: 'existing_worktree' })
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
      [{ projectId: 'p1', firstMessage: '   ' }, /firstMessage must be/]
    ])('%o is an error result', async (args, message) => {
      const { call, host } = await world()
      const result = await call(args as Record<string, unknown>)
      expect(result.isError).toBe(true)
      expect(result.text).toMatch(message)
      expect(host.createThread).not.toHaveBeenCalled()
    })

    it('a host without thread creation says so', async () => {
      const { call } = await world({ createThread: undefined })
      expect(await refusalIn(call())).toMatchObject({ message: 'thread_create is not available in this host.' })
    })
  })

  describe('what the host is asked for', () => {
    it('the normalized launch, the caller as the actor with this call, and a key scoped to the caller thread', async () => {
      const { call, host, callerRun } = await world()
      const result = await call({
        projectId: 'p1', title: '  Fix the build  ', workspace: 'new_worktree', instanceId: ' claude ', model: 'sonnet', firstMessage: 'Please fix it'
      }, { toolCallId: 'mcp:create-1' })
      expect(JSON.parse(result.text)).toMatchObject({ threadId: 'new-1', link: 'mousse://thread/new-1', replayed: false })
      expect(host.createThread).toHaveBeenLastCalledWith(
        { projectId: 'p1', title: 'Fix the build', workspace: 'new_worktree', instanceId: 'claude', model: 'sonnet', firstMessage: 'Please fix it' },
        { clientRequestId: 'thread_create:caller:mcp:create-1', actor: { kind: 'agent', threadId: 'caller', runId: callerRun.runId, toolCallId: 'mcp:create-1' } }
      )
      // Defaults: the project's folder, no title, no message.
      await call({ projectId: 'p1', clientRequestId: 'again' })
      expect(host.createThread).toHaveBeenLastCalledWith(
        { projectId: 'p1', workspace: 'project' },
        expect.objectContaining({ clientRequestId: 'thread_create:caller:again' })
      )
      // A first message defaults to an agent turn.
      await call({ projectId: 'p1', firstMessage: 'go' })
      expect(host.createThread).toHaveBeenLastCalledWith({ projectId: 'p1', workspace: 'project', firstMessage: 'go' }, expect.anything())
    })

    it('adds the transcript row only for the call that created the thread, never for a replay', async () => {
      const { call, host, callerRun } = await world({
        createThread: vi.fn()
          .mockResolvedValueOnce(created('th1'))
          .mockResolvedValueOnce(created('th1', { replayed: true }))
      })
      await call({ projectId: 'p1', clientRequestId: 'k' })
      await call({ projectId: 'p1', clientRequestId: 'k' })
      expect(host.showAgentAction).toHaveBeenCalledTimes(1)
      expect(host.showAgentAction).toHaveBeenCalledWith({ threadId: 'th1' }, expect.objectContaining({ threadId: 'caller', runId: callerRun.runId }), 'created this thread')
    })

    it('a refusal of the host reaches the caller as an error', async () => {
      const { call } = await world({
        createThread: vi.fn()
          .mockRejectedValueOnce(Object.assign(new Error('too many in a row'), { code: 'agent_hops_exceeded' }))
          .mockResolvedValue(created('th1'))
      })
      const error = await refusalIn(call({ projectId: 'p1', firstMessage: 'go' }))
      expect(error).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'agent_hops_exceeded' }, refused: { code: 'conflict', retry: 'never' } })
    })

    it('a creation tells the creator thread which model, mode and place the agent chose, once, and a replay says nothing more', async () => {
      const { call, host } = await world({
        createThread: vi.fn()
          .mockResolvedValueOnce(created('th1', { title: 'Audit', model: { instanceId: 'claude', model: 'sonnet' }, permissionMode: 'ask', runsIn: 'own_worktree' }))
          .mockResolvedValueOnce(created('th1', { replayed: true }))
      })
      await call({ projectId: 'p1', clientRequestId: 'k' })
      await call({ projectId: 'p1', clientRequestId: 'k' })
      expect(host.noteOnThread).toHaveBeenCalledTimes(1)
      // The note names the new thread as a field, which the transcript draws as a chip; the text stays for the model.
      expect(host.noteOnThread).toHaveBeenCalledWith('caller', 'Created thread «Audit» (th1) in project p1: claude / sonnet, ask mode, a worktree of its own.', { threadId: 'th1', summary: 'claude / sonnet, ask mode, a worktree of its own' })
    })

    it('has no count per run: one run creates 20 threads and none is refused', async () => {
      const { call, host } = await world()
      for (let index = 0; index < 20; index += 1) expect((await call({ projectId: 'p1', clientRequestId: `k-${index}` })).isError, `${index}`).toBeUndefined()
      expect(host.createThread).toHaveBeenCalledTimes(20)
    })
  })

  describe('the creator and the thread it launched', () => {
    it('reads, waits on and interrupts it', async () => {
      const { call, registry, as, threads, fx, host } = await world()
      const made = JSON.parse((await call()).text) as AgentCreatedThread
      // What the host stored on the thread: launched by the caller's thread, in the caller's project.
      threads.set(made.threadId, thread(made.threadId, { createdByThreadId: 'caller' }))
      const targetRun = await fx.runningRun(made.threadId)

      expect(JSON.parse((await registry.call('thread_read', { threadId: made.threadId }, as())).text)).toMatchObject({ threadId: made.threadId })
      expect(JSON.parse((await registry.call('thread_wait', { threadId: made.threadId, runId: targetRun.runId, timeoutMs: 5 }, as())).text).status).toBe('timeout')
      expect((await registry.call('thread_interrupt', { threadId: made.threadId, runId: targetRun.runId }, as())).isError).toBeUndefined()
      expect(host.stopRun).toHaveBeenCalledTimes(1)
    })
  })
})
