/**
 * PR 4 4b2: a definition run's authority over its app-tool calls over MCP (the Mousse registry's
 * `tools/call`), the same trusted-dispatch checks the in-process loop applies.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { recordAuthorizedCall, withoutTransportFields, type DefinitionAuthority } from '../../src/mms/agentDefinitions/definitionGate'
import type { AgentRuntimePolicy, AgentRuntimeToolApprovalRequest } from '../../src/shared/agents/execution'
import { refused } from '../../src/mms/run/mcp/appTools/refusal'
import { appToolRegistry, appTurn, fakeAppToolHost } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

let fx: DelegationFixture | undefined
afterEach(() => {
  fx?.dispose()
  fx = undefined
})

function policy(overrides: Partial<AgentRuntimePolicy['approval']> = {}): AgentRuntimePolicy {
  return {
    profileId: 'default', threadId: 'thread-a', runId: 'r', definitionId: 'def-1', definitionRevision: 'rev-1', source: 'editor',
    workspace: { mode: 'thread_worktree', canonicalRoots: [process.cwd()] },
    script: { enabled: false, allowFilesystem: false, allowNetwork: false, executionMode: 'workspace', interpreters: [] },
    approval: { askUser: true, policy: 'inherit', unattendedBehavior: 'pause', ...overrides },
    memoryScope: 'off', includeCurrentThread: false, includeProjectInstructions: false, attachmentPolicy: 'none',
    fallbacks: { enabled: false, retryOn: [], allowHigherCost: false, retryCount: 0, backoffMs: 0 },
    fallbackModels: []
  }
}

async function setup(definition: DefinitionAuthority) {
  fx = delegationFixture()
  const run = await fx.runningRun('thread-a')
  const fake = fakeAppToolHost()
  const { registry, turns, request } = appToolRegistry(fx.engine, fake.host)
  turns.register(appTurn({ threadId: 'thread-a', runId: run.runId, definition }))
  return { registry, ctx: () => request({ threadId: 'thread-a', runId: run.runId }), ...fake }
}

const grants = (...ids: string[]) => ({ skills: [], mcpTools: [], builtinTools: ids.map((id) => ({ id, source: 'definition' as never })), denied: [] })

describe('app tools under a definition’s authority (MCP)', () => {
  it('a tool outside the grants never reaches its handler', async () => {
    const s = await setup({ policy: policy(), grants: grants('task_create') })
    expect(await s.registry.call('question_ask', { questions: [] }, s.ctx())).toEqual(refused('not_granted', 'Tool "question_ask" is not granted to this agent definition.'))
    expect(s.host.askUser).not.toHaveBeenCalled()
    expect((await s.registry.call('task_create', { description: 'fine' }, s.ctx())).isError).toBe(false)
  })

  it('askUser off refuses question_ask even when granted', async () => {
    const s = await setup({ policy: policy({ askUser: false }), grants: grants('question_ask') })
    expect(await s.registry.call('question_ask', { questions: [] }, s.ctx())).toMatchObject({ isError: true, text: expect.stringContaining('askUser') })
    expect(s.host.askUser).not.toHaveBeenCalled()
  })

  it('approval: the host is asked with the exact arguments; a stale digest is refused, an approved call runs', async () => {
    const asked: AgentRuntimeToolApprovalRequest[] = []
    let digest: (request: AgentRuntimeToolApprovalRequest) => string = () => 'stale'
    const s = await setup({ policy: policy({ policy: 'always' }), grants: grants('task_create'), approve: async (request) => (asked.push(request), { status: 'approved', digest: digest(request) }) })
    expect(await s.registry.call('task_create', { description: 'first' }, s.ctx())).toMatchObject({ isError: true, text: expect.stringContaining('stale') })
    digest = (request) => request.argumentDigest
    expect((await s.registry.call('task_create', { description: 'second' }, s.ctx())).isError).toBe(false)
    expect(asked.map((request) => request.arguments)).toEqual([{ description: 'first' }, { description: 'second' }])
  })

  /** A per-call (Pi) credential: the call carries the turn token, and its id is the MCP server's `mcp:<clientRequestId>`. */
  async function handoff(approve: DefinitionAuthority['approve']) {
    const definition: DefinitionAuthority = { policy: policy({ policy: 'always' }), grants: grants('task_create', 'task_list', 'thread_fork'), ...(approve ? { approve } : {}) }
    fx = delegationFixture()
    const run = await fx.runningRun('thread-a')
    const fake = fakeAppToolHost()
    const { registry, turns, request } = appToolRegistry(fx.engine, fake.host)
    turns.register(appTurn({ threadId: 'thread-a', runId: run.runId, turnToken: 'tt', definition }))
    const call = (name: string, args: Record<string, unknown>, callId: string, signal?: AbortSignal) =>
      registry.call(name, { ...args, _mousse_turn: 'tt' }, { ...request({ threadId: 'thread-a', runId: run.runId, binding: 'per_call', ...(signal ? { signal } : {}) }), toolCallId: `mcp:${callId}` })
    const record = (toolName: string, args: Record<string, unknown>, callId: string, turnToken = 'tt') => recordAuthorizedCall(definition, { turnToken, toolName, callId, args })
    return { call, record, ...fake }
  }

  it('a call the runtime’s gate authorized is revalidated at dispatch without asking again, once, and only with the same arguments', async () => {
    const asked: AgentRuntimeToolApprovalRequest[] = []
    const s = await handoff(async (request) => (asked.push(request), { status: 'denied', reason: 'asked again' }))
    s.record('task_create', { description: 'approved' }, 'call-1')
    expect((await s.call('task_create', { description: 'approved' }, 'call-1')).isError).toBe(false)
    expect(asked).toEqual([])
    // Taken once: the same id again goes through approval (denied here).
    expect(await s.call('task_create', { description: 'approved' }, 'call-1')).toEqual(refused('not_granted', 'asked again'))
    // Other arguments than the authorized ones: approval again.
    s.record('task_create', { description: 'approved' }, 'call-2')
    expect(await s.call('task_create', { description: 'changed' }, 'call-2')).toEqual(refused('not_granted', 'asked again'))
    expect(asked).toHaveLength(2)
  })

  it('an approval for one tool never authorizes another tool, or the same tool in another turn', async () => {
    const asked: string[] = []
    const s = await handoff(async (request) => (asked.push(request.toolName), { status: 'denied', reason: 'no creation approved' }))
    // `task_list` was approved at the gate; a caller sends `task_create` with the same id and arguments.
    s.record('task_list', { description: 'unapproved task' }, 'model-call-1')
    expect(await s.call('task_create', { description: 'unapproved task' }, 'model-call-1')).toEqual(refused('not_granted', 'no creation approved'))
    expect(s.tasks.list()).toHaveLength(0)
    // An authorization recorded under another turn's token does not cover this turn.
    s.record('task_create', { description: 'other turn' }, 'model-call-2', 'an-earlier-turn')
    expect(await s.call('task_create', { description: 'other turn' }, 'model-call-2')).toEqual(refused('not_granted', 'no creation approved'))
    expect(s.tasks.list()).toHaveLength(0)
    expect(asked).toEqual(['task_create', 'task_create'])
  })

  it('transport fields are not part of the call: a model-supplied clientRequestId does not make the registry ask again', async () => {
    const asked: string[] = []
    const s = await handoff(async (request) => (asked.push(request.toolName), { status: 'denied', reason: 'asked again' }))
    // The gate saw the model's `clientRequestId`; the extension overwrote it and the MCP server stripped it.
    s.record('task_create', withoutTransportFields({ description: 'with an id', clientRequestId: 'model-id' }), 'model-call-3')
    expect((await s.call('task_create', { description: 'with an id' }, 'model-call-3')).isError).toBe(false)
    expect(asked).toEqual([])
  })

  it('a handed-over call whose MCP request was cancelled does not run', async () => {
    const s = await handoff(async () => ({ status: 'denied', reason: 'asked again' }))
    s.record('task_create', { description: 'cancelled task' }, 'model-call-4')
    const aborted = new AbortController()
    aborted.abort()
    expect(await s.call('task_create', { description: 'cancelled task' }, 'model-call-4', aborted.signal)).toMatchObject({ isError: true, text: expect.stringContaining('cancelled') })
    expect(s.tasks.list()).toHaveLength(0)
  })
})
