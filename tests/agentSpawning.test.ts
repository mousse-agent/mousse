import { describe, expect, it } from 'vitest'
import { AgentRegistry } from '../src/mms/agents/AgentRegistry'
import { dispatchDelegationTool, parseActions, type DelegationToolHost } from '../src/mms/orchestrator/LlmClient'
import {
  filesOutsideDeclaration,
  shouldFinalizeAgent
} from '../src/mms/orchestrator/OrchestratorService'
import { getToolCallDisplay } from '../src/shared/toolCallDisplay'

/**
 * Phase 4 (docs/run-engine/SPEC.md §14.5) retired `spawn_agents`: delegation is the
 * `delegate_task` tool family and its named wrappers. The cases below that used to assert spawn
 * batch/progress-file helpers now assert the tool layer that replaced them.
 */
function fakeHost() {
  const calls: Array<{ tool: string; input: unknown; toolCallId?: string }> = []
  const record = (tool: string) => async (input: unknown, call?: { toolCallId: string }) => {
    calls.push({ tool, input, toolCallId: call?.toolCallId })
    return { tool }
  }
  const host: DelegationToolHost = {
    delegateTask: record('delegateTask'),
    taskStatus: record('taskStatus'),
    taskCancel: record('taskCancel'),
    listDelegations: () => ({ tool: 'listDelegations' }),
    integrateDelegation: record('integrateDelegation'),
    named: {
      create: record('named.create'),
      createBatch: record('named.createBatch'),
      recall: record('named.recall'),
      integrate: record('named.integrate'),
      list: () => ({ tool: 'named.list' })
    }
  }
  return { host, calls }
}

const call = (name: string, args: Record<string, unknown>, id = 'tool-call-1') =>
  ({ type: 'toolCall' as const, id, name, arguments: args })

describe('agent spawning', () => {
  it('routes delegate_task with the model tool call id so a retried call is the same request', async () => {
    const { host, calls } = fakeHost()
    await dispatchDelegationTool(host, call('delegate_task', { prompt: 'Fix the parser', workspace: 'isolated', role: 'implement' }, 'call-42'))
    expect(calls).toEqual([{ tool: 'delegateTask', toolCallId: 'call-42', input: { prompt: 'Fix the parser', workspace: 'isolated', role: 'implement', wake: undefined, provider: undefined, model: undefined } }])
  })

  it('rejects delegate_task without a prompt or a valid workspace before reaching the host', async () => {
    const { host, calls } = fakeHost()
    await expect(dispatchDelegationTool(host, call('delegate_task', { workspace: 'isolated' }))).rejects.toThrow('prompt')
    await expect(dispatchDelegationTool(host, call('delegate_task', { prompt: 'x', workspace: 'scratch' }))).rejects.toThrow('workspace')
    await expect(dispatchDelegationTool(host, call('delegate_task', { prompt: 'x', workspace: 'shared', wake: 'never' }))).rejects.toThrow('wake')
    await expect(dispatchDelegationTool(host, call('delegate_task', { prompt: 'x', workspace: 'isolated', provider: '' }))).rejects.toThrow('provider must be a non-empty string')
    await expect(dispatchDelegationTool(host, call('delegate_task', { prompt: 'x', workspace: 'isolated', model: 7 }))).rejects.toThrow('model must be a non-empty string')
    expect(calls).toEqual([])
  })

  it('passes provider and model overrides through to the host', async () => {
    const { host, calls } = fakeHost()
    await dispatchDelegationTool(host, call('delegate_task', { prompt: 'Implement the login form component', workspace: 'isolated', provider: 'openai', model: 'gpt-x' }))
    expect(calls[0].input).toMatchObject({ provider: 'openai', model: 'gpt-x', workspace: 'isolated' })
  })

  it('rejects completion changes outside the discovery declaration', () => {
    expect(filesOutsideDeclaration(
      ['src/allowed.ts', 'tests/unapproved.test.ts'],
      ['src\\allowed.ts']
    )).toEqual(['tests/unapproved.test.ts'])
  })

  it('keeps the named-agent tools as wrappers over the same host', async () => {
    const { host, calls } = fakeHost()
    await dispatchDelegationTool(host, call('create_subagent', { name: 'Reviewer', task: 'Review', access: 'read-only' }))
    await dispatchDelegationTool(host, call('recall_subagent', { agent: 'Reviewer', task: 'Again' }))
    await dispatchDelegationTool(host, call('integrate_subagent', { agent: 'Reviewer' }))
    expect(await dispatchDelegationTool(host, call('list_subagents', {}))).toEqual({ tool: 'named.list' })
    expect(calls.map((entry) => entry.tool)).toEqual(['named.create', 'named.recall', 'named.integrate'])
    await expect(dispatchDelegationTool(host, call('create_subagents', { agents: [{ name: 'x' }] }))).rejects.toThrow('names and tasks')
  })

  it('uses the reserved spawn id in the agent registry', () => {
    const registry = new AgentRegistry()
    const agent = registry.create(
      {
        cliType: 'mousse',
        worktreePath: '/tmp/worktree',
        branch: 'agent/reserved-id',
        executionMode: 'gui',
        status: 'running',
        task: 'Implement the fix'
      },
      'reserved-id'
    )

    expect(agent.id).toBe('reserved-id')
    expect(registry.get('reserved-id')).toBe(agent)
    expect(() =>
      registry.create(
        {
          cliType: 'mousse',
          worktreePath: '/tmp/other',
          branch: 'agent/duplicate',
          executionMode: 'gui',
          status: 'running',
          task: 'Duplicate'
        },
        'reserved-id'
      )
    ).toThrow('already exists')
  })

  it('can fill launch metadata into a persisted discovery placeholder', () => {
    const registry = new AgentRegistry()
    registry.create({
      cliType: 'mousse',
      worktreePath: '',
      branch: '',
      executionMode: 'gui',
      status: 'starting',
      startupPhase: 'discovery',
      task: 'Discover then implement'
    }, 'discovering-agent')

    registry.update('discovering-agent', {
      worktreePath: '/tmp/worktree',
      branch: 'agent/discovering-agent',
      declaredFiles: ['src/fix.ts'],
      startupPhase: 'launching'
    })

    expect(registry.get('discovering-agent')).toMatchObject({
      status: 'starting',
      worktreePath: '/tmp/worktree',
      declaredFiles: ['src/fix.ts'],
      startupPhase: 'launching'
    })
  })

  it('still finalizes a stale completed agent when its branch survived', () => {
    expect(shouldFinalizeAgent('completed', true)).toBe(true)
    expect(shouldFinalizeAgent('completed', false)).toBe(false)
    expect(shouldFinalizeAgent('ready')).toBe(true)
    expect(shouldFinalizeAgent('failed', true)).toBe(false)
    expect(shouldFinalizeAgent('cancelled', false)).toBe(false)
    expect(shouldFinalizeAgent('cancelled', true)).toBe(true)
    expect(shouldFinalizeAgent('interrupted', false)).toBe(false)
    expect(shouldFinalizeAgent('interrupted', true)).toBe(true)
  })

  it('no longer executes spawn_agents blocks; complete_task still parses and displays', () => {
    const reply = '```mousse-actions\n{"actions":[{"type":"spawn_agents","agents":[{"cliType":"mousse","task":"x"}]},{"type":"complete_task","agentIds":["a1"]}]}\n```'
    const actions = parseActions(reply)
    expect(actions).toEqual([{ type: 'complete_task', agentIds: ['a1'] }])
    const display = getToolCallDisplay(actions[0])
    expect(display.title).toBe('Completing active task')
    expect(display.status).toBe('processing')
  })
})
