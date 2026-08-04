import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRegistry } from '../src/mms/agents/AgentRegistry'
import { MacroEngine } from '../src/mms/macros/MacroEngine'
import {
  buildCompleteTaskFailureWake,
  extractAssignmentFilePaths,
  isActionFailureLog,
  OrchestratorService,
  requiresMergeCandidateToFinalize,
  shouldFinalizeAgent,
  validateDelegationBatch,
  validateSubagentAssignment
} from '../src/mms/orchestrator/OrchestratorService'
import { buildOrchestratorSystemPrompt } from '../src/mms/orchestrator/systemPrompt'
import { TaskProgressMonitor, taskProgressInstructions } from '../src/mms/tasks/TaskProgressMonitor'
import { TaskQueue } from '../src/mms/tasks/TaskQueue'
import { HeadlessAgentRunner } from '../src/mms/terminals/HeadlessAgentRunner'
import { PtyManager } from '../src/mms/terminals/PtyManager'
import { WorktreeManager } from '../src/mms/worktree/WorktreeManager'
import {
  isDelegationSettledStatus,
  isTerminalAgentStatus,
  normalizeAgentStatus,
  normalizeTaskStatus,
  type Agent,
  type Task
} from '../src/shared/types'
import { getDefaultSettings } from '../src/shared/settings'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mousse-lifecycle-'))
  tempRoots.push(root)
  return root
}

describe('agent id resolution', () => {
  it('accepts unique UI prefixes but rejects ambiguous prefixes', () => {
    const agents = new AgentRegistry()
    const create = (id: string) => agents.create({
      cliType: 'mousse',
      worktreePath: `/tmp/${id}`,
      branch: `mousse/${id}`,
      executionMode: 'gui',
      status: 'ready',
      task: id
    }, id)
    const first = create('12345678-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    create('87654321-bbbb-4bbb-8bbb-bbbbbbbbbbbb')

    expect(agents.resolve(first.id)).toBe(first)
    expect(agents.resolve('12345678')).toBe(first)
    expect(agents.resolve('1234')).toBeUndefined()

    create('12345678-cccc-4ccc-8ccc-cccccccccccc')
    expect(agents.resolve('12345678')).toBeUndefined()
  })
})

function createOrchestrator(root: string): {
  orchestrator: OrchestratorService
  agents: AgentRegistry
  tasks: TaskQueue
  worktrees: WorktreeManager
} {
  const agents = new AgentRegistry()
  const tasks = new TaskQueue()
  const worktrees = new WorktreeManager(root)
  const ptyManager = new PtyManager()
  const headlessRunner = new HeadlessAgentRunner()
  const macros = {
    listProviders: () => ['mousse', 'codex'],
    isHeadlessEnabled: () => false,
    getHeadlessShellCommand: () => 'echo',
    getCliCommand: () => 'echo',
    runPtyMacro: async () => ({ log: [] as string[] })
  } as unknown as MacroEngine
  const settingsStore = {
    getSettings: () => getDefaultSettings()
  }
  const providerAuth = {
    getConnectedProviders: () => []
  }

  const orchestrator = new OrchestratorService(
    agents,
    tasks,
    worktrees,
    ptyManager,
    headlessRunner,
    macros,
    settingsStore as never,
    providerAuth as never
  )
  return { orchestrator, agents, tasks, worktrees }
}

function seedRunningGuiAgent(
  agents: AgentRegistry,
  tasks: TaskQueue,
  overrides: Partial<Agent> = {}
): { agent: Agent; task: Task } {
  const agent = agents.create({
    cliType: 'mousse',
    worktreePath: overrides.worktreePath ?? '/tmp/wt',
    branch: overrides.branch ?? 'mousse/agent-abcd1234',
    executionMode: 'gui',
    status: 'running',
    task: 'Implement the feature',
    ...overrides
  })
  const task = tasks.create(agent.task, agent.id)
  tasks.updateStatus(task.id, 'in_progress')
  return { agent, task }
}

describe('status normalization and terminal helpers', () => {
  it('preserves legacy completed/failed/running and maps unknown to failed', () => {
    expect(normalizeAgentStatus('completed')).toBe('completed')
    expect(normalizeAgentStatus('failed')).toBe('failed')
    expect(normalizeAgentStatus('running')).toBe('running')
    expect(normalizeAgentStatus('cancelled')).toBe('cancelled')
    expect(normalizeAgentStatus('interrupted')).toBe('interrupted')
    expect(normalizeAgentStatus('not-a-status')).toBe('failed')
    expect(normalizeAgentStatus(undefined)).toBe('failed')

    expect(normalizeTaskStatus('completed')).toBe('completed')
    expect(normalizeTaskStatus('in_progress')).toBe('in_progress')
    expect(normalizeTaskStatus('cancelled')).toBe('cancelled')
    expect(normalizeTaskStatus('weird')).toBe('failed')
  })

  it('loads agents and tasks with normalized statuses', () => {
    const agents = new AgentRegistry()
    const tasks = new TaskQueue()
    agents.load([
      {
        id: 'a1',
        cliType: 'mousse',
        worktreePath: '/wt',
        branch: 'b',
        executionMode: 'gui',
        status: 'running' as Agent['status'],
        task: 't',
        createdAt: new Date().toISOString()
      },
      {
        id: 'a2',
        cliType: 'mousse',
        worktreePath: '/wt2',
        branch: 'b2',
        executionMode: 'gui',
        status: 'bogus' as Agent['status'],
        task: 't2',
        createdAt: new Date().toISOString()
      }
    ])
    tasks.load([
      {
        id: 't1',
        status: 'completed',
        description: 'done',
        createdAt: new Date().toISOString()
      },
      {
        id: 't2',
        status: 'nope' as Task['status'],
        description: 'bad',
        createdAt: new Date().toISOString()
      }
    ])

    expect(agents.get('a1')?.status).toBe('running')
    expect(agents.get('a2')?.status).toBe('failed')
    expect(tasks.get('t1')?.status).toBe('completed')
    expect(tasks.get('t2')?.status).toBe('failed')
  })

  it('classifies terminal and delegation-settled statuses', () => {
    expect(isTerminalAgentStatus('completed')).toBe(true)
    expect(isTerminalAgentStatus('cancelled')).toBe(true)
    expect(isTerminalAgentStatus('interrupted')).toBe(true)
    expect(isTerminalAgentStatus('ready')).toBe(false)
    expect(isDelegationSettledStatus('ready')).toBe(true)
    expect(isDelegationSettledStatus('cancelled')).toBe(true)
    expect(isDelegationSettledStatus('running')).toBe(false)
    expect(requiresMergeCandidateToFinalize('cancelled')).toBe(true)
    expect(requiresMergeCandidateToFinalize('ready')).toBe(false)
  })
})

describe('cancellation vs completed', () => {
  it('exposes manual stop controls in both agent views', () => {
    const panel = readFileSync(
      new URL('../src/renderer/components/AgentsPanel.tsx', import.meta.url),
      'utf8'
    )
    const tasksView = readFileSync(
      new URL('../src/renderer/components/AgentsTasksView.tsx', import.meta.url),
      'utf8'
    )
    const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')

    expect(panel).toMatch(/mousse\.agents\.stop\(agentId\)/)
    expect(tasksView).toMatch(/Stop agent \(worktree retained\)/)
    expect(preload).toMatch(/agents:stop/)
  })

  it('marks stop-without-merge as cancelled and keeps the worktree', async () => {
    const root = makeTempRoot()
    const { orchestrator, agents, tasks, worktrees } = createOrchestrator(root)
    await worktrees.init()
    const wt = await worktrees.createWorktree('11111111-1111-1111-1111-111111111111')
    const { agent } = seedRunningGuiAgent(agents, tasks, {
      worktreePath: wt.path,
      branch: wt.branch
    })
    const repoMarker = join(root, 'repo-marker.txt')
    const worktreeMarker = join(wt.path, 'unfinished-work.txt')
    writeFileSync(repoMarker, 'primary repo must survive')
    writeFileSync(worktreeMarker, 'unfinished agent work must survive')

    const logs = await orchestrator.stopAgent(agent.id, false)

    expect(agents.get(agent.id)?.status).toBe('cancelled')
    expect(tasks.findByAgentId(agent.id)?.status).toBe('cancelled')
    expect(logs.some((line) => line.includes('cancelled'))).toBe(true)
    expect(existsSync(wt.path)).toBe(true)
    expect(readFileSync(repoMarker, 'utf8')).toBe('primary repo must survive')
    expect(readFileSync(worktreeMarker, 'utf8')).toBe('unfinished agent work must survive')
    expect(shouldFinalizeAgent('cancelled', false)).toBe(false)
  })
})

describe('GUI failure propagation', () => {
  it('marks agent and task failed with the exact reason and does not remove the worktree', async () => {
    const root = makeTempRoot()
    const { orchestrator, agents, tasks, worktrees } = createOrchestrator(root)
    await worktrees.init()
    const wt = await worktrees.createWorktree('22222222-2222-2222-2222-222222222222')
    const { agent } = seedRunningGuiAgent(agents, tasks, {
      worktreePath: wt.path,
      branch: wt.branch
    })

    orchestrator.reportGuiAgentFailure(agent.id, 'Provider rate limit exceeded')

    expect(agents.get(agent.id)?.status).toBe('failed')
    const task = tasks.findByAgentId(agent.id)
    expect(task?.status).toBe('failed')
    expect(task?.progressMessage).toBe('Provider rate limit exceeded')
    expect(existsSync(wt.path)).toBe(true)
    // Second report is a no-op for terminal agents.
    orchestrator.reportGuiAgentFailure(agent.id, 'another reason')
    expect(task?.progressMessage).toBe('Provider rate limit exceeded')
  })

  it('returns failed GUI agent and task to running when retrying a durable checkpoint', () => {
    const root = makeTempRoot()
    const { orchestrator, agents, tasks } = createOrchestrator(root)
    const worktreePath = join(root, '.mousse-worktrees', 'agent-retry123')
    mkdirSync(worktreePath, { recursive: true })
    const { agent } = seedRunningGuiAgent(agents, tasks, {
      worktreePath,
      branch: 'mousse/agent-retry123'
    })

    orchestrator.restoreMousseAgentSessions([
      {
        version: 1,
        agentId: agent.id,
        worktreePath,
        task: agent.task,
        assignment: {},
        messages: [],
        history: [],
        runState: 'failed',
        lastError: 'Token safety budget reached',
        updatedAt: new Date().toISOString()
      }
    ])
    expect(agents.get(agent.id)?.status).toBe('failed')
    const internals = orchestrator as unknown as {
      mousseAgents: { retry: (agentId: string) => void }
    }
    const retry = vi.spyOn(internals.mousseAgents, 'retry').mockImplementation(() => {})

    orchestrator.retryMousseAgent(agent.id)

    expect(retry).toHaveBeenCalledWith(agent.id)
    expect(agents.get(agent.id)?.status).toBe('running')
    expect(tasks.findByAgentId(agent.id)?.status).toBe('in_progress')
    expect(tasks.findByAgentId(agent.id)?.progressMessage).toBe('Task started')
  })
})

describe('startup reconciliation', () => {
  it('routes a restored running Mousse session to interrupted, not failed', () => {
    const root = makeTempRoot()
    const { orchestrator, agents, tasks } = createOrchestrator(root)
    const { agent } = seedRunningGuiAgent(agents, tasks)

    const events = orchestrator.restoreMousseAgentSessions([
      {
        version: 1,
        agentId: agent.id,
        worktreePath: agent.worktreePath,
        task: agent.task,
        assignment: {},
        messages: [],
        history: [],
        runState: 'running',
        updatedAt: new Date().toISOString()
      }
    ])

    expect(events).toHaveLength(1)
    expect(events[0]?.state).toBe('interrupted')
    expect(agents.get(agent.id)?.status).toBe('interrupted')
    expect(tasks.findByAgentId(agent.id)?.status).toBe('interrupted')
  })

  it('persists an idle GUI session as interrupted when its registry was still active', () => {
    const root = makeTempRoot()
    const { orchestrator, agents, tasks } = createOrchestrator(root)
    const { agent } = seedRunningGuiAgent(agents, tasks)
    orchestrator.restoreMousseAgentSessions([
      {
        version: 1,
        agentId: agent.id,
        worktreePath: agent.worktreePath,
        task: agent.task,
        assignment: {},
        messages: [],
        history: [],
        runState: 'idle',
        updatedAt: new Date().toISOString()
      }
    ])

    orchestrator.restoreAgentProgress()

    expect(agents.get(agent.id)?.status).toBe('interrupted')
    expect(tasks.findByAgentId(agent.id)?.status).toBe('interrupted')
    expect(orchestrator.exportMousseAgentSessions()[0]?.runState).toBe('interrupted')
  })

  it('interrupts persisted GUI running agents that have no live session', () => {
    const root = makeTempRoot()
    const { orchestrator, agents, tasks } = createOrchestrator(root)
    const { agent } = seedRunningGuiAgent(agents, tasks, {
      worktreePath: join(root, 'missing-wt'),
      branch: 'mousse/agent-deadbeef'
    })

    orchestrator.restoreAgentProgress()

    expect(agents.get(agent.id)?.status).toBe('interrupted')
    expect(tasks.findByAgentId(agent.id)?.status).toBe('interrupted')
    expect(tasks.findByAgentId(agent.id)?.progressMessage).toMatch(/not restored/i)
  })

  it('does not interrupt ready or failed agents on restore', () => {
    const root = makeTempRoot()
    const { orchestrator, agents, tasks } = createOrchestrator(root)
    const ready = agents.create({
      cliType: 'mousse',
      worktreePath: '/wt-ready',
      branch: 'b-ready',
      executionMode: 'gui',
      status: 'ready',
      task: 'ready task'
    })
    const readyTask = tasks.create(ready.task, ready.id)
    tasks.updateStatus(readyTask.id, 'completed')

    const failed = agents.create({
      cliType: 'mousse',
      worktreePath: '/wt-failed',
      branch: 'b-failed',
      executionMode: 'gui',
      status: 'failed',
      task: 'failed task'
    })
    const failedTask = tasks.create(failed.task, failed.id)
    tasks.updateStatus(failedTask.id, 'failed')

    orchestrator.restoreAgentProgress()

    expect(agents.get(ready.id)?.status).toBe('ready')
    expect(agents.get(failed.id)?.status).toBe('failed')
  })
})

describe('delegation batch settlement', () => {
  it('wakes when all batch agents are ready/failed/cancelled/interrupted', async () => {
    const root = makeTempRoot()
    const { orchestrator, agents, tasks } = createOrchestrator(root)

    const a1 = agents.create({
      cliType: 'mousse',
      worktreePath: '/a1',
      branch: 'b1',
      executionMode: 'gui',
      status: 'ready',
      task: 't1'
    })
    tasks.create('t1', a1.id)
    tasks.updateStatus(tasks.findByAgentId(a1.id)!.id, 'completed')

    const a2 = agents.create({
      cliType: 'mousse',
      worktreePath: '/a2',
      branch: 'b2',
      executionMode: 'gui',
      status: 'failed',
      task: 't2'
    })
    tasks.create('t2', a2.id)
    tasks.updateStatus(tasks.findByAgentId(a2.id)!.id, 'failed')

    // Access private batches via reportGuiAgentFailure path after seeding a live batch.
    // Use handle path: create a third running agent, fail it, and ensure settled statuses qualify.
    expect(isDelegationSettledStatus('ready')).toBe(true)
    expect(isDelegationSettledStatus('failed')).toBe(true)
    expect(isDelegationSettledStatus('cancelled')).toBe(true)
    expect(isDelegationSettledStatus('interrupted')).toBe(true)

    // Drive a real batch: seed two running agents, then settle both via public APIs.
    const { orchestrator: orch2, agents: agents2, tasks: tasks2 } = createOrchestrator(root)
    const first = seedRunningGuiAgent(agents2, tasks2, {
      worktreePath: '/batch-1',
      branch: 'mousse/agent-batch001'
    })
    const second = seedRunningGuiAgent(agents2, tasks2, {
      worktreePath: '/batch-2',
      branch: 'mousse/agent-batch002'
    })

    // Manually insert a batch the same way spawnAgents does.
    const batch = new Set([first.agent.id, second.agent.id]);
    (orch2 as unknown as { delegationBatches: Set<Set<string>> }).delegationBatches.add(batch)

    const sendSpy = vi.spyOn(orch2, 'send').mockResolvedValue({ message: 'ok', actions: [] })

    orch2.reportGuiAgentFailure(first.agent.id, 'first failed')
    await orch2.stopAgent(second.agent.id, false)

    // Allow the wake timer to fire.
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(agents2.get(first.agent.id)?.status).toBe('failed')
    expect(agents2.get(second.agent.id)?.status).toBe('cancelled')
    expect(sendSpy).toHaveBeenCalled()
    const wakeContent = String(sendSpy.mock.calls[0]?.[0]?.content ?? sendSpy.mock.calls[0]?.[0] ?? '')
    expect(wakeContent).toMatch(/delegation batch have finished/i)
    // The wake must expose exact ids because complete_task intentionally rejects
    // ambiguous display prefixes.
    expect(wakeContent).toContain(first.agent.id)
    expect(wakeContent).toContain(second.agent.id)
    sendSpy.mockRestore()
  })
})

describe('complete_task failure follow-up', () => {
  it('classifies merge conflicts and ordinary merge failures as action failures', () => {
    expect(isActionFailureLog('[merge] Conflict for mousse/agent-123: package.json')).toBe(true)
    expect(isActionFailureLog('[merge] Failed for mousse/agent-123: local changes')).toBe(true)
    expect(isActionFailureLog('[merge] Merged mousse/agent-123')).toBe(false)
  })

  it('builds a main-agent wake with conflict details and the exact target id', () => {
    const wake = buildCompleteTaskFailureWake(
      ['12345678-1234-1234-1234-123456789abc'],
      [
        '[mousse] Stopped agent 12345678',
        '[merge] Conflict for mousse/agent-12345678: package.json',
        '[merge] Details: CONFLICT (content): Merge conflict in package.json'
      ]
    )

    expect(wake).toContain('[Automatic complete_task update]')
    expect(wake).toContain('12345678-1234-1234-1234-123456789abc')
    expect(wake).toContain('package.json')
    expect(wake).toMatch(/resolve the listed conflicts/i)
    expect(wake).toMatch(/retry complete_task/i)
    expect(wake).toMatch(/mark the task done/i)
    expect(wake).toMatch(/close the agent GUI subtab/i)
  })

  it('wakes for a dirty-worktree merge rejection without calling it a conflict', () => {
    const wake = buildCompleteTaskFailureWake(
      ['agent-id'],
      ['[merge] Failed for mousse/agent: local changes would be overwritten by merge']
    )

    expect(wake).toMatch(/preserve existing local changes/i)
    expect(wake).not.toMatch(/resolve the listed conflicts/i)
  })

  it('does not schedule a follow-up for a successful merge', () => {
    expect(buildCompleteTaskFailureWake(['agent-id'], ['[merge] Merged mousse/agent'])).toBeUndefined()
  })
})

describe('prompt consistency', () => {
  it('requires a single readiness mechanism and forbids subagent spawn/complete_task', () => {
    const sub = buildOrchestratorSystemPrompt({ mode: 'build', subagent: true })
    expect(sub).toContain('Do NOT spawn agents')
    expect(sub).toContain('exactly one')
    expect(sub).toContain('task progress protocol')
    expect(sub).toMatch(/status "failed"/i)
    expect(sub).toMatch(/meaningful phase/i)
    expect(sub).not.toContain('"type": "spawn_agents"')
    expect(sub).not.toContain('"type": "complete_task"')

    const main = buildOrchestratorSystemPrompt({ mode: 'agent' })
    expect(main).toMatch(/Recovery after a failed merge/i)
    expect(main).toMatch(/stage the resolutions with `git add`/i)
    expect(main).toMatch(/marks the task completed/i)
    expect(main).toMatch(/closes the agent's GUI subtab/i)
    expect(main).toMatch(/manual merge was already committed/i)
    expect(main).toMatch(/Never claim integration succeeded until its tool result/i)

    const progress = taskProgressInstructions('/tmp/wt/.mousse/task-progress.json')
    expect(progress).toContain('only readiness signal')
    expect(progress).toContain('Do not emit spawn_agents or complete_task')
    expect(progress).toContain('meaningful phase')
    expect(progress).toContain('"failed"')
  })

  it('instructs the orchestrator about plan body/path, non-overlap, and focused validation', () => {
    const agent = buildOrchestratorSystemPrompt({ mode: 'agent' })
    expect(agent).toMatch(/plan\/spec body|readable filesystem path/i)
    expect(agent).toMatch(/non-overlapping file ownership/i)
    expect(agent).toMatch(/focused validation/i)
    expect(agent).toMatch(/bounded tasks/i)
  })
})

describe('assignment validation', () => {
  it('requires plan body or path when a task refers to a plan', () => {
    expect(
      validateSubagentAssignment({
        cliType: 'mousse',
        task: 'Implement the plan for auth'
      })
    ).toMatch(/plan\/spec/)

    expect(
      validateSubagentAssignment({
        cliType: 'mousse',
        task: 'Implement the plan in docs/auth-plan.md for the login form'
      })
    ).toBeUndefined()
    expect(
      validateSubagentAssignment({
        cliType: 'mousse',
        task: String.raw`Implement the plan at C:\workspace\docs\auth-plan.md for the login form`
      })
    ).toBeUndefined()

    const embedded = [
      'Implement the plan:',
      '# Auth plan',
      '1. Add login form',
      '2. Wire submit handler',
      'Acceptance criteria: form validates email',
      'Step 3: add tests for the form'
    ].join('\n')
    expect(validateSubagentAssignment({ cliType: 'mousse', task: embedded })).toBeUndefined()
  })

  it('rejects unbounded full-suite tasks without focus', () => {
    expect(
      validateSubagentAssignment({
        cliType: 'mousse',
        task: 'Run the full test suite'
      })
    ).toMatch(/unbounded|full-suite|focused/i)

    expect(
      validateSubagentAssignment({
        cliType: 'mousse',
        task: 'After editing src/login.ts, run focused tests for the login form'
      })
    ).toBeUndefined()
  })

  it('detects overlapping file ownership across a batch', () => {
    expect(extractAssignmentFilePaths('Edit src/a.ts and src/b.ts')).toEqual([
      'src/a.ts',
      'src/b.ts'
    ])

    expect(
      validateDelegationBatch([
        { cliType: 'mousse', task: 'Update src/auth/login.ts form' },
        { cliType: 'mousse', task: 'Refactor src/auth/login.ts validation' }
      ])
    ).toMatch(/Overlapping file ownership/)

    expect(
      validateDelegationBatch([
        { cliType: 'mousse', task: 'Update src/auth/login.ts form' },
        { cliType: 'mousse', task: 'Update src/auth/session.ts helpers' }
      ])
    ).toBeUndefined()
  })
})

describe('orphan worktree detection', () => {
  it('reports ghost non-git directories without deleting them', async () => {
    const root = makeTempRoot()
    const manager = new WorktreeManager(root)
    await manager.init()

    const ghostPath = join(root, '.mousse-worktrees', 'agent-deadbeef')
    mkdirSync(ghostPath, { recursive: true })
    writeFileSync(join(ghostPath, 'notes.txt'), 'progress only')

    const typoPath = join(root, '.mousse-worktrees', 'progres-only-typo')
    mkdirSync(typoPath, { recursive: true })

    const report = await manager.scanOrphanWorktrees([])

    expect(report.ghostDirectories.some((entry) => entry.path === ghostPath)).toBe(true)
    expect(report.ghostDirectories.some((entry) => entry.path === typoPath)).toBe(true)
    expect(existsSync(ghostPath)).toBe(true)
    expect(existsSync(typoPath)).toBe(true)

    const refused = await manager.cleanupValidatedAgentWorktree({
      path: join(root, 'src'),
      branch: 'main'
    })
    expect(refused.success).toBe(false)
    expect(refused.error).toMatch(/not a validated agent worktree/i)
  })

  it('removes only validated agent worktrees on explicit cleanup', async () => {
    const root = makeTempRoot()
    const manager = new WorktreeManager(root)
    await manager.init()

    // Non-repo mode creates plain directories.
    const wt = await manager.createWorktree('33333333-3333-3333-3333-333333333333')
    expect(existsSync(wt.path)).toBe(true)
    expect(manager.isValidatedAgentWorktreePath(wt.path)).toBe(true)

    const ghost = join(root, '.mousse-worktrees', 'random-folder')
    mkdirSync(ghost, { recursive: true })

    const results = await manager.cleanupValidatedAgentWorktrees([wt])
    expect(results[0]?.success).toBe(true)
    expect(existsSync(wt.path)).toBe(false)
    expect(existsSync(ghost)).toBe(true)
  })
})

describe('TaskProgressMonitor status set', () => {
  it('still accepts working/completed/failed progress updates', () => {
    const root = makeTempRoot()
    const monitor = new TaskProgressMonitor()
    const updates: Array<{ status: string }> = []
    const path = monitor.start('agent-x', root, (update) => updates.push(update))
    expect(path).toContain('task-progress.json')
    expect(updates[0]?.status).toBe('working')
    monitor.stopAll()
  })
})
