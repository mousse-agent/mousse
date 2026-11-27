/**
 * `thread_create`'s two kinds (docs/plans/tool-api.md §2.1, #2004): who may start each, the old names of the subagent
 * kind, a retry under either name, and what an older call that names no kind starts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentThreadRequest, ToolOutcome } from '../../src/mms/run/mcp/appTools'
import { appToolRegistry, appTurn, denied, fakeAppToolHost } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

describe('thread_create kinds', () => {
  let fx: DelegationFixture | undefined
  afterEach(() => {
    fx?.dispose()
    fx = undefined
  })

  /** An agent's turn in thread `parent` of project `home`, with a fake owner that records what it was asked to start. */
  const setup = async (options: { readOnly?: boolean } = {}) => {
    fx = delegationFixture()
    const run = await fx.runningRun('parent')
    const createThread = vi.fn(async (request: AgentThreadRequest) => ({
      threadId: 'started', title: request.title ?? 'New Thread', projectId: request.projectId, runsIn: 'project_folder' as const, permissionMode: 'ask' as const, replayed: false
    }))
    const fake = fakeAppToolHost({ createThread, threadMeta: (id) => ({ id, name: id, projectId: 'home' }) as never, ...(options.readOnly ? { readOnlyThread: () => true } : {}) })
    const { registry, turns, request } = appToolRegistry(fx.engine, fake.host)
    turns.register(appTurn({ threadId: 'parent', runId: run.runId }))
    const call = (name: string, args: Record<string, unknown>, toolCallId = `mcp:${Math.random()}`): Promise<ToolOutcome> =>
      registry.call(name, args, request({ threadId: 'parent', runId: run.runId, toolCallId }))
    return { call, createThread, delegateTask: fake.delegation.delegateTask, engine: fx.engine }
  }
  const subagent = { prompt: 'Read the logs', title: 'Log reader', workspace: 'shared' }
  const lacks = (outcome: ToolOutcome) => (JSON.parse(outcome.text) as { refused: { lacks?: string } }).refused.lacks

  it('kind subagent is held by a read-only child; kind thread needs threads.start, which it lacks', async () => {
    const { call, createThread, delegateTask } = await setup({ readOnly: true })
    expect((await call('thread_create', { kind: 'subagent', ...subagent })).isError).toBeUndefined()
    expect(delegateTask).toHaveBeenCalledTimes(1)
    const thread = await call('thread_create', { kind: 'thread', projectId: 'other', title: 'Release notes' })
    expect((await denied(Promise.resolve(thread)))?.code).toBe('mousse_read_only')
    expect(lacks(thread)).toBe('threads.start')
    expect(createThread).not.toHaveBeenCalled()
  })

  it('an agent\'s kind thread starts a shown thread in a project; its hidden is refused, with nothing started', async () => {
    const { call, createThread } = await setup()
    expect((await call('thread_create', { kind: 'thread', projectId: 'other', title: 'Release notes' })).isError).toBeUndefined()
    expect(createThread).toHaveBeenCalledWith(expect.not.objectContaining({ hidden: expect.anything() }), expect.anything())
    const hidden = await denied(call('thread_create', { kind: 'thread', projectId: 'other', title: 'Background', hidden: true }))
    expect(hidden?.message).toMatch(/hidden is for a personal bot's thread/)
    expect(hidden?.message).toMatch(/kind "subagent"/)
    expect(createThread).toHaveBeenCalledTimes(1)
    // A kind is required of a new caller, and an argument of the other kind is a mistake about the kind.
    expect((await denied(call('thread_create', { kind: 'helper', projectId: 'other' })))?.message).toMatch(/kind must be "subagent" or "thread"/)
    expect((await denied(call('thread_create', { kind: 'subagent', ...subagent, projectId: 'other' })))?.message).toMatch(/projectId is for kind "thread"/)
  })

  it('delegate_task and create_subagent are the subagent kind, and a retry under the old name and the new one is the same request', async () => {
    const { call, delegateTask, createThread } = await setup()
    await call('delegate_task', subagent, 'mcp:same')
    await call('thread_create', { kind: 'subagent', ...subagent }, 'mcp:same')
    // The same input under the same call id: the owner's request key (`delegation:<parent>:<run>:<call id>`) is one.
    expect(delegateTask.mock.calls[0]).toEqual(delegateTask.mock.calls[1])
    expect(delegateTask.mock.calls[0]![1]).toEqual({ toolCallId: 'mcp:same' })
    // An old name is its variant and no other: delegate_task never starts a thread.
    await call('delegate_task', { ...subagent, kind: 'thread', title: 'Second reader' })
    expect(delegateTask).toHaveBeenCalledTimes(3)
    // create_subagent keeps its reader default: in the caller's folder, read-only.
    await call('create_subagent', { name: 'Auditor', task: 'Audit the config' })
    expect(delegateTask).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Auditor', prompt: 'Audit the config', workspace: 'shared', readOnly: true, role: 'research', wake: 'always' }), expect.anything())
    expect(createThread).not.toHaveBeenCalled()
  })

  it('an older call with no kind starts the thread it always did, its hidden one shown, under the same request key', async () => {
    const { call, createThread, delegateTask } = await setup()
    await call('thread_create', { projectId: 'home', title: 'Docs pass', firstMessage: 'Tidy the docs' })
    expect(createThread).toHaveBeenCalledTimes(1)
    // A hidden thread in its own project, with a first message: the same thread as before (its permissions, its workspace,
    // the chain's hold on its first message), never a subagent. The service never hides an agent's thread (#2004).
    const quiet = await call('thread_create', { projectId: 'home', firstMessage: 'Check the flaky test', workspace: 'new_worktree', hidden: true }, 'mcp:quiet')
    expect(quiet.isError).toBeUndefined()
    expect(JSON.parse(quiet.text).note).toMatch(/kind "subagent"/)
    expect(createThread).toHaveBeenCalledTimes(2)
    expect(createThread).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: 'home', workspace: 'new_worktree', firstMessage: 'Check the flaky test' }), expect.objectContaining({ clientRequestId: 'thread_create:parent:mcp:quiet' }))
    // A retry is the same request: the key names the call, not the run.
    await call('thread_create', { projectId: 'home', firstMessage: 'Check the flaky test', workspace: 'new_worktree', hidden: true }, 'mcp:quiet')
    expect(createThread).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ clientRequestId: 'thread_create:parent:mcp:quiet' }))
    expect(delegateTask).not.toHaveBeenCalled()
  })
})
