/**
 * PR 4 4b2: a definition run's authority over its app-tool calls over MCP (the Mousse registry's
 * `tools/call`), the same trusted-dispatch checks the in-process loop applies.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { DefinitionAuthority } from '../../src/mms/agentDefinitions/definitionGate'
import type { AgentRuntimePolicy, AgentRuntimeToolApprovalRequest } from '../../src/shared/agents/execution'
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
    const s = await setup({ policy: policy(), grants: grants('create_task') })
    expect(await s.registry.call('ask_user', { questions: [] }, s.ctx())).toEqual({ text: 'Tool "ask_user" is not granted to this agent definition.', isError: true })
    expect(s.host.askUser).not.toHaveBeenCalled()
    expect((await s.registry.call('create_task', { description: 'fine' }, s.ctx())).isError).toBe(false)
  })

  it('askUser off refuses ask_user even when granted', async () => {
    const s = await setup({ policy: policy({ askUser: false }), grants: grants('ask_user') })
    expect(await s.registry.call('ask_user', { questions: [] }, s.ctx())).toMatchObject({ isError: true, text: expect.stringContaining('askUser') })
    expect(s.host.askUser).not.toHaveBeenCalled()
  })

  it('approval: the host is asked with the exact arguments; a stale digest is refused, an approved call runs', async () => {
    const asked: AgentRuntimeToolApprovalRequest[] = []
    let digest: (request: AgentRuntimeToolApprovalRequest) => string = () => 'stale'
    const s = await setup({ policy: policy({ policy: 'always' }), grants: grants('create_task'), approve: async (request) => (asked.push(request), { status: 'approved', digest: digest(request) }) })
    expect(await s.registry.call('create_task', { description: 'first' }, s.ctx())).toMatchObject({ isError: true, text: expect.stringContaining('stale') })
    digest = (request) => request.argumentDigest
    expect((await s.registry.call('create_task', { description: 'second' }, s.ctx())).isError).toBe(false)
    expect(asked.map((request) => request.arguments)).toEqual([{ description: 'first' }, { description: 'second' }])
  })
})
