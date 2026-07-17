import { describe, expect, it } from 'vitest'
import { AgentRegistry } from '../src/mms/agents/AgentRegistry'
import { shouldFinalizeAgent } from '../src/mms/orchestrator/OrchestratorService'
import { getToolCallDisplay } from '../src/shared/toolCallDisplay'

describe('agent spawning', () => {
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

  it('still finalizes a stale completed agent when its branch survived', () => {
    expect(shouldFinalizeAgent('completed', true)).toBe(true)
    expect(shouldFinalizeAgent('completed', false)).toBe(false)
    expect(shouldFinalizeAgent('ready')).toBe(true)
    expect(shouldFinalizeAgent('failed', true)).toBe(false)
  })

  it('does not report a spawn as successful before it executes', () => {
    const display = getToolCallDisplay({
      type: 'spawn_agents',
      agents: [{ cliType: 'mousse', task: 'Implement the fix' }]
    })

    expect(display.title).toBe('Spawning 1 agent')
    expect(display.status).toBe('processing')
    expect(display.summary).not.toContain('Started')
  })
})
