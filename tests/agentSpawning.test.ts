import { describe, expect, it } from 'vitest'
import { AgentRegistry } from '../src/mms/agents/AgentRegistry'
import {
  buildSpawnAgentsFailureWake,
  extractAssignmentInputFilePaths,
  filesOutsideDeclaration,
  isRecoverableReadinessFailure,
  isSpawnAgentsFailureLog,
  resolveSpawnRepositoryPath,
  shouldFinalizeAgent
} from '../src/mms/orchestrator/OrchestratorService'
import { getToolCallDisplay } from '../src/shared/toolCallDisplay'

describe('agent spawning', () => {
  it('allows one bounded correction for files outside the discovery declaration', () => {
    const error = 'Agent changed files outside its discovery declaration: .gitignore, frames/a.jpg.'
    expect(isRecoverableReadinessFailure(error, false, 0)).toBe(true)
    expect(isRecoverableReadinessFailure(error, false, 1)).toBe(false)
  })

  it('extracts repository input assets from delegated task text', () => {
    expect(extractAssignmentInputFilePaths(
      'Analyze reference/clip.mp4 and write reference/reference-analysis/report.md only.'
    )).toEqual(['reference/clip.mp4', 'reference/reference-analysis/report.md'])
  })

  it('rejects completion changes outside the discovery declaration', () => {
    expect(filesOutsideDeclaration(
      ['src/allowed.ts', 'tests/unapproved.test.ts'],
      ['src\\allowed.ts']
    )).toEqual(['tests/unapproved.test.ts'])
  })

  it('uses the owning thread repository instead of the packaged daemon launch root', () => {
    const installRoot = 'C:\\Users\\test\\AppData\\Local\\Programs\\Mousse'
    const projectRoot = 'C:\\Users\\test\\Documents\\Projects\\launch-new'

    expect(resolveSpawnRepositoryPath(projectRoot, installRoot)).toBe(projectRoot)
    expect(resolveSpawnRepositoryPath(null, installRoot)).toBe(installRoot)
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

  it('does not mistake successful spawn logs that discuss failures for failed acknowledgements', () => {
    const logs = [
      '[discovery] Declared 2 edit file(s): Fix failed orchestration/thread binding error handling',
      '[agent] Spawned Mousse GUI agent abcdef12'
    ]

    expect(logs.filter(isSpawnAgentsFailureLog)).toEqual([])
    expect(buildSpawnAgentsFailureWake(logs)).toBeUndefined()
  })

  it('reports only explicitly failed reservations in mixed or interleaved spawn results', () => {
    const logs = [
      '[agent] Spawned Mousse GUI agent success1',
      '[spawn-failure agent=failed-agent task=failed-task stage=discovery] mousse: connection closed',
      '[discovery] Declared 1 edit file(s): error recovery implementation',
      '[agent] Spawned Mousse GUI agent success2'
    ]

    const wake = buildSpawnAgentsFailureWake(logs)
    expect(wake).toContain('1 delegated task was not started')
    expect(wake).toContain('agent=failed-agent task=failed-task')
    expect(wake).not.toContain('success1')
    expect(wake).not.toContain('success2')
    expect(wake).toContain('do not respawn agents that started successfully')
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
