import { describe, expect, it } from 'vitest'
import { recordAuthorizedCall, type DefinitionAuthority } from '../../src/mms/agentDefinitions/definitionGate'
import { ToolRegistry, type MousseTool } from '../../src/mms/run/mcp/appTools/registry'
import { AppToolTurns } from '../../src/mms/run/mcp/appTools/turns'
import type { AgentRuntimePolicy, AgentRuntimeToolApprovalRequest } from '../../src/shared/agents/execution'
import { appTurn } from './appToolsFixture'

// PR 4 4d-rpc: a definition's app tool over the Mousse MCP server re-checks that its run is still
// the thread's active run after the approval wait, right before the handler runs, as the
// in-process path does.

const policy: AgentRuntimePolicy = {
  profileId: 'default', threadId: 't1', runId: 'r1', definitionId: 'def-1', definitionRevision: 'rev-1', source: 'editor',
  workspace: { mode: 'thread_worktree', canonicalRoots: [process.cwd()] },
  script: { enabled: false, allowFilesystem: false, allowNetwork: false, executionMode: 'workspace', interpreters: [] },
  approval: { askUser: true, policy: 'always', unattendedBehavior: 'pause' },
  memoryScope: 'off', includeCurrentThread: false, includeProjectInstructions: false, attachmentPolicy: 'none',
  fallbacks: { enabled: false, retryOn: [], allowHigherCost: false, retryCount: 0, backoffMs: 0 },
  fallbackModels: []
}

function world(onApproval: (state: { active: string | null; current: boolean }) => void) {
  const state = { active: 'r1' as string | null, current: true }
  const ran: unknown[] = []
  const definition: DefinitionAuthority = {
    policy,
    grants: { skills: [], mcpTools: [], builtinTools: [{ id: 'create_task', source: 'definition' as never }], denied: [] },
    approve: async (request: AgentRuntimeToolApprovalRequest) => {
      onApproval(state)
      return { status: 'approved', digest: request.argumentDigest }
    }
  }
  const turns = new AppToolTurns()
  turns.register(appTurn({ threadId: 't1', runId: 'r1', turnToken: 'tt', definition }))
  const registry = new ToolRegistry({ activeRunId: () => state.active, turns })
  registry.register({ name: 'create_task', description: 'Create a task', inputSchema: {}, access: 'actsAsCaller', class: 'mutation', handler: async (args) => (ran.push(args), { text: 'created' }) } as unknown as MousseTool)
  const call = () => registry.call('create_task', { description: 'a task', _mousse_turn: 'tt' }, {
    credential: { threadId: 't1', runId: 'r1', provider: 'claude', modeCeiling: 'default', binding: 'rotate', current: () => state.current },
    toolCallId: 'call-1',
    signal: new AbortController().signal
  } as never)
  return { call, ran, turns }
}

describe('a definition app tool over MCP re-checks its run after the approval', () => {
  it('runs when its run is still active after the approval', async () => {
    const { call, ran } = world(() => {})
    expect(await call()).toMatchObject({ text: 'created' })
    expect(ran).toEqual([{ description: 'a task' }])
  })

  it.each([
    ['the run ended', (state: { active: string | null }) => { state.active = null }],
    ['another run became active', (state: { active: string | null }) => { state.active = 'r2' }],
    ['the credential was replaced', (state: { current: boolean }) => { state.current = false }]
  ] as const)('is not run when %s while the approval waited', async (_what, change) => {
    const { call, ran } = world(change as (state: { active: string | null; current: boolean }) => void)
    await expect(call()).rejects.toMatchObject({ code: 'mousse_caller_not_live' })
    expect(ran).toEqual([])
  })

  it('a call the runtime’s gate already authorized (per call, as Pi RPC hands it over) is re-checked too', async () => {
    const state = { active: 'r1' as string | null }
    const ran: unknown[] = []
    const definition: DefinitionAuthority = {
      policy,
      grants: { skills: [], mcpTools: [], builtinTools: [{ id: 'create_task', source: 'definition' as never }], denied: [] },
      approve: async () => { throw new Error('the gate already asked; the registry must not ask again') }
    }
    const turns = new AppToolTurns()
    turns.register(appTurn({ threadId: 't1', runId: 'r1', turnToken: 'tt', definition }))
    const registry = new ToolRegistry({ activeRunId: () => state.active, turns })
    // The run stops being the thread's active run after the registry's first liveness check, as it
    // can while the call travels from the gate to the registry.
    registry.register({ name: 'create_task', description: 'Create a task', inputSchema: {}, access: 'actsAsCaller', class: 'mutation', available: () => { state.active = 'r2'; return true }, handler: async (args) => (ran.push(args), { text: 'created' }) } as unknown as MousseTool)
    recordAuthorizedCall(definition, { turnToken: 'tt', toolName: 'create_task', callId: 'call-1', args: { description: 'a task' } })
    await expect(registry.call('create_task', { description: 'a task', _mousse_turn: 'tt' }, {
      credential: { threadId: 't1', runId: 'r1', provider: 'pi', modeCeiling: 'default', binding: 'per_call', current: () => true },
      toolCallId: 'mcp:call-1',
      signal: new AbortController().signal
    } as never)).rejects.toMatchObject({ code: 'mousse_caller_not_live' })
    expect(ran).toEqual([])
  })
})
