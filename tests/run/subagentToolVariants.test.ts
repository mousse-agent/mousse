/**
 * `task_status`, `task_cancel`, `list_subagents` and `continue_subagent` as variants of `thread_wait`, `thread_stop`,
 * `thread_list` and `thread_send` (docs/plans/tool-api.md §2.1, S7d3): neither name is listed, a call under either runs
 * the old tool with its own authority and request key, and a call that names a thread is the new tool's, with its rules.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeChildToolDenial } from '../../src/mms/harness/vendors/claude/childPolicy'
import { canonicalToolCall, grantHoldsCall } from '../../src/shared/toolAliases'
import { appToolRegistry, appTurn, denied, fakeAppToolHost } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

describe('the subagent tools as variants of the thread tools', () => {
  let fx: DelegationFixture | undefined
  afterEach(() => {
    fx?.dispose()
    fx = undefined
  })

  const world = async () => {
    fx = delegationFixture()
    const callerRun = await fx.runningRun('caller')
    const targetRun = await fx.runningRun('target')
    const ledger = { start: vi.fn(() => 'inv'), commit: vi.fn(), failed: vi.fn() }
    const fake = fakeAppToolHost({
      threadMeta: (id) => ({ id, name: id, createdAt: '', updatedAt: '', startedAt: '', projectId: 'p1' }) as never,
      toolLedger: () => ledger,
      stopRun: vi.fn(async () => ({ status: 'accepted' as const, runId: targetRun.runId, sequence: 1, replayed: false }))
    })
    const { registry, turns, request } = appToolRegistry(fx.engine, fake.host)
    turns.register(appTurn({ threadId: 'caller', runId: callerRun.runId }))
    const call = (name: string, args: Record<string, unknown>, toolCallId?: string) =>
      registry.call(name, args, request({ threadId: 'caller', runId: callerRun.runId, ...(toolCallId ? { toolCallId } : {}) }))
    return { call, registry, fake, ledger, targetRun }
  }

  it('lists neither old name; the new tools take the subagent', () => {
    fx = delegationFixture()
    const { registry } = appToolRegistry(fx.engine, fakeAppToolHost().host)
    const listed = registry.listForThread('caller')
    const names = listed.map((tool) => tool.name)
    for (const old of ['task_status', 'task_cancel', 'list_subagents', 'continue_subagent']) expect(names).not.toContain(old)
    for (const name of ['thread_wait', 'thread_stop', 'thread_send'])
      expect(Object.keys((listed.find((tool) => tool.name === name)!.inputSchema as { properties: object }).properties)).toContain('subagent')
  })

  it('a read-only subagent lists thread_stop, as it listed task_cancel, and the tools its old variants read', () => {
    fx = delegationFixture()
    const { registry } = appToolRegistry(fx.engine, fakeAppToolHost().host)
    const names = registry.listFor({ threadId: 'caller', readOnly: true }).map((tool) => tool.name)
    for (const name of ['thread_stop', 'thread_wait', 'thread_list', 'thread_send']) expect(names).toContain(name)
  })

  it('runs the old tool under either name, recorded under the new one', async () => {
    const { call, fake, ledger } = await world()
    for (const name of ['task_cancel', 'thread_stop']) expect((await call(name, { subagent: 'API reviewer' }, 'mcp:stop-1')).isError).toBeFalsy()
    // Both reach the host with one request id, so the second replays the first's receipt (`continueSubagent.test.ts`).
    expect(vi.mocked(fake.delegation.taskCancel).mock.calls).toEqual([
      [{ subagent: 'API reviewer' }, { toolCallId: 'mcp:stop-1' }],
      [{ subagent: 'API reviewer' }, { toolCallId: 'mcp:stop-1' }]
    ])
    for (const name of ['task_status', 'thread_wait']) await call(name, { delegationId: 'd1' })
    expect(fake.delegation.taskStatus).toHaveBeenLastCalledWith({ delegationId: 'd1' })
    for (const name of ['list_subagents', 'thread_list']) await call(name, name === 'thread_list' ? { scope: 'family' } : {})
    expect(fake.delegation.listSubagents).toHaveBeenCalledTimes(2)
    expect(fake.host.stopRun).not.toHaveBeenCalled()
    expect(ledger.start.mock.calls.map(([row]) => (row as { name: string }).name)).toEqual(['thread_stop', 'thread_stop', 'thread_wait', 'thread_wait', 'thread_list', 'thread_list'])
  })

  it('an old and a new follow-up under one clientRequestId are one request', async () => {
    const { call, fake } = await world()
    await call('continue_subagent', { subagent: 'API reviewer', prompt: 'Round two' }, 'mcp:follow-1')
    await call('thread_send', { subagent: 'API reviewer', content: 'Round two' }, 'mcp:follow-1')
    // The host keeps one follow-up per call id (`continueSubagent`'s receipt): both calls give it the same one.
    expect(fake.delegation.continueSubagent).toHaveBeenCalledTimes(2)
    for (const [input, key] of vi.mocked(fake.delegation.continueSubagent).mock.calls) {
      expect(input).toEqual({ subagent: 'API reviewer', prompt: 'Round two' })
      expect(key).toEqual({ toolCallId: 'mcp:follow-1' })
    }
  })

  it('list_delegations is thread_read view "delegations": its old name returns its bare list, the new one the thread\'s view of it', async () => {
    const { call, fake } = await world()
    const row = { delegationId: 'd1', childThreadId: 'child', title: 'API reviewer', status: 'completed', wake: 'always', childRunStatus: 'completed', createdAt: 'now' }
    vi.mocked(fake.delegation.listDelegations).mockReturnValue([row] as never)
    expect(JSON.parse((await call('list_delegations', {})).text)).toEqual([row])
    const view = await call('thread_read', { view: 'delegations' })
    expect(JSON.parse(view.text)).toMatchObject({ threadId: 'caller', view: 'delegations', delegations: [row] })
    expect(fake.delegation.listDelegations).toHaveBeenCalledTimes(2)
    // Another thread's delegations are not this view's: it reads the caller's own.
    expect((await denied(call('thread_read', { threadId: 'target', view: 'delegations' })))?.message).toContain('leave out threadId')
    expect(fake.delegation.listDelegations).toHaveBeenCalledTimes(2)
  })

  it('recall_subagent is a follow-up to a named subagent under either name: one request per clientRequestId', async () => {
    const { call, fake, registry } = await world()
    // The old name is thread_send in the one form thread_send publishes: `subagent` names which subagent, `content` the task.
    const recall = canonicalToolCall('recall_subagent', { agent: 'API reviewer', task: 'Round two' })
    expect(recall).toEqual({ name: 'thread_send', args: { subagent: 'API reviewer', content: 'Round two', intent: 'work' } })
    const published = Object.keys((registry.listForThread('caller').find((tool) => tool.name === 'thread_send')!.inputSchema as { properties: object }).properties)
    expect(published).toEqual(expect.arrayContaining(Object.keys(recall.args)))
    expect(grantHoldsCall('recall_subagent', 'thread_send', { subagent: 'API reviewer', content: 'Round two' })).toBe(true)
    vi.mocked(fake.delegation.named.recall).mockResolvedValue({ name: 'API reviewer', delegationId: 'd2' } as never)
    const old = await call('recall_subagent', { agent: 'API reviewer', task: 'Round two' }, 'mcp:recall-1')
    expect(JSON.parse(old.text)).toEqual({ name: 'API reviewer', delegationId: 'd2' })
    // The retry takes the form thread_send publishes (`subagent`, the subagent's title): it is the follow-up
    // continue_subagent starts, under the same call key, which the host keeps as one request (continueSubagent.test.ts).
    vi.mocked(fake.delegation.continueSubagent).mockResolvedValue({ name: 'API reviewer', delegationId: 'd2', replayed: true } as never)
    expect(JSON.parse((await call('thread_send', { subagent: 'API reviewer', content: 'Round two' }, 'mcp:recall-1')).text)).toMatchObject({ delegationId: 'd2' })
    expect(vi.mocked(fake.delegation.named.recall).mock.calls.map(([input, key]) => [input.agent, input.task, key])).toEqual([['API reviewer', 'Round two', { toolCallId: 'mcp:recall-1' }]])
    expect(vi.mocked(fake.delegation.continueSubagent).mock.calls.map(([input, key]) => [input, key])).toEqual([[expect.objectContaining({ subagent: 'API reviewer', prompt: 'Round two' }), { toolCallId: 'mcp:recall-1' }]])
    expect(grantHoldsCall('recall_subagent', 'thread_send', { threadId: 'target', content: 'x' })).toBe(false)
    expect(grantHoldsCall('list_delegations', 'thread_read', { view: 'events' })).toBe(false)
  })

  it('a call that names a thread is the new tool\'s: stopping a thread that is not yours needs its run, and stops nothing without it', async () => {
    const { call, fake, targetRun } = await world()
    // An old name cannot carry the old tool's authority to a thread it names: task_cancel with a threadId is thread_stop.
    for (const [name, args] of [['task_cancel', { threadId: 'target', subagent: 'x' }], ['thread_stop', { threadId: 'target' }]] as const) {
      const refusal = await denied(call(name, args))
      expect(refusal?.message).toContain('runId')
    }
    expect(fake.delegation.taskCancel).not.toHaveBeenCalled()
    expect(fake.host.stopRun).not.toHaveBeenCalled()
    // With the run it read, the Stop is the new tool's, as before.
    expect((await call('thread_stop', { threadId: 'target', runId: targetRun.runId })).isError).toBeFalsy()
    expect(fake.host.stopRun).toHaveBeenCalledTimes(1)
  })

  it('a grant of an old name holds only its variant', () => {
    expect(grantHoldsCall('task_cancel', 'thread_stop', { subagent: 'x' })).toBe(true)
    expect(grantHoldsCall('task_cancel', 'thread_stop', { threadId: 'target', runId: 'r' })).toBe(false)
    expect(grantHoldsCall('task_status', 'thread_wait', { threadId: 'target' })).toBe(false)
    expect(grantHoldsCall('list_subagents', 'thread_list', {})).toBe(false)
    expect(grantHoldsCall('continue_subagent', 'thread_send', { threadId: 'target', content: 'x' })).toBe(false)
    expect(grantHoldsCall('continue_subagent', 'thread_send', { subagent: 'x', content: 'x', intent: 'note' })).toBe(false)
  })

  it('a read-only Claude child keeps what the old tools allowed it, and no more', () => {
    const child = { readOnly: true } as Parameters<typeof claudeChildToolDenial>[0]
    const verdict = (tool: string, args: Record<string, unknown> = {}) => claudeChildToolDenial(child, `mcp__mousse__${tool}`, args) === undefined
    expect(verdict('task_cancel', { subagent: 'x' })).toBe(true)
    expect(verdict('thread_stop', { subagent: 'x' })).toBe(true)
    expect(verdict('continue_subagent', { subagent: 'x', prompt: 'p' })).toBe(true)
    expect(verdict('thread_send', { subagent: 'x', content: 'p' })).toBe(true)
    expect(verdict('thread_stop', { threadId: 'target', runId: 'r' })).toBe(false)
    expect(verdict('task_cancel', { threadId: 'target', runId: 'r' })).toBe(false)
  })
})
