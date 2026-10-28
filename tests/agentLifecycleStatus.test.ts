import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRegistry } from '../src/mms/agents/AgentRegistry'
import {
  buildCompleteTaskFailureWake,
  buildCompleteTaskSuccessWake,
  OrchestratorService,
  requiresMergeCandidateToFinalize,
  shouldFinalizeAgent
} from '../src/mms/orchestrator/OrchestratorService'
import { LEGACY_AGENT_PROGRESS_FILE, MOUSSE_CONTROL_FILE_PATHS } from '../src/mms/worktree/controlFiles'
import { TaskQueue } from '../src/mms/tasks/TaskQueue'
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
const originalMousseHome = process.env.MOUSSE_HOME

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
  if (originalMousseHome === undefined) delete process.env.MOUSSE_HOME
  else process.env.MOUSSE_HOME = originalMousseHome
})

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mousse-lifecycle-'))
  process.env.MOUSSE_HOME = join(root, '.home')
  execFileSync('git', ['init'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'tests@mousse.local'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Mousse Tests'], { cwd: root })
  writeFileSync(join(root, 'README.md'), '# Test repository\n')
  execFileSync('git', ['add', 'README.md'], { cwd: root })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: root })
  tempRoots.push(root)
  return root
}

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
  it('marks stop-without-merge as cancelled and keeps the worktree', async () => {
    const root = makeTempRoot()
    const { orchestrator, agents, tasks, worktrees } = createOrchestrator(root)
    await worktrees.init()
    const wt = await worktrees.createWorktree('11111111-1111-1111-1111-111111111111')
    const { agent } = seedRunningGuiAgent(agents, tasks, {
      worktreePath: wt.path,
      branch: wt.branch
    })

    const logs = await orchestrator.stopAgent(agent.id, false)

    expect(agents.get(agent.id)?.status).toBe('cancelled')
    expect(tasks.findByAgentId(agent.id)?.status).toBe('cancelled')
    expect(logs.some((line) => line.includes('cancelled'))).toBe(true)
    expect(existsSync(wt.path)).toBe(true)
    expect(shouldFinalizeAgent('cancelled', false)).toBe(false)
  })
})

describe('legacy agent settlement', () => {
  // The delegation batch and its timer-driven parent wake are gone (SPEC §14.5): delegated work is
  // a child thread whose completion is a stored inbox row. Settling a legacy agent changes its
  // status and wakes nothing.
  it('settles legacy agents, headless ones included, without a batch wake', async () => {
    const root = makeTempRoot()
    const { orchestrator, agents, tasks } = createOrchestrator(root)
    expect(isDelegationSettledStatus('ready')).toBe(true)
    expect(isDelegationSettledStatus('failed')).toBe(true)
    expect(isDelegationSettledStatus('cancelled')).toBe(true)
    expect(isDelegationSettledStatus('interrupted')).toBe(true)
    const first = seedRunningGuiAgent(agents, tasks, { worktreePath: '/batch-1', branch: 'mousse/agent-batch001', executionMode: 'headless' })
    const second = seedRunningGuiAgent(agents, tasks, { worktreePath: '/batch-2', branch: 'mousse/agent-batch002' })
    const sendSpy = vi.spyOn(orchestrator, 'send').mockResolvedValue({ message: 'ok', actions: [] })

    // No headless process can exist any more, so stopping a headless agent only sets its state.
    const firstLogs = await orchestrator.stopAgent(first.agent.id, false)
    await orchestrator.stopAgent(second.agent.id, false)

    expect(firstLogs.some((line) => line.startsWith('[headless]'))).toBe(false)
    expect(agents.get(first.agent.id)?.status).toBe('cancelled')
    expect(agents.get(second.agent.id)?.status).toBe('cancelled')
    expect(sendSpy).not.toHaveBeenCalled()
    sendSpy.mockRestore()
  })

  it('never resumes a cancelled agent', () => {
    const root = makeTempRoot()
    const { orchestrator, agents, tasks } = createOrchestrator(root)
    const { agent } = seedRunningGuiAgent(agents, tasks)
    agents.updateStatus(agent.id, 'cancelled')
    expect(agents.updateStatus(agent.id, 'running')?.status ?? agents.get(agent.id)?.status).toBe('cancelled')
    expect(orchestrator.getActiveAgents()).toEqual([])
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

    // A validated agent worktree can be explicitly cleaned up.
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

describe('legacy progress file', () => {
  it('stays a recognised control file so pre-Phase-4 worktrees still reconstruct', () => {
    expect(LEGACY_AGENT_PROGRESS_FILE).toBe('.mousse/task-progress.json')
    expect(MOUSSE_CONTROL_FILE_PATHS).toContain(LEGACY_AGENT_PROGRESS_FILE)
    expect(MOUSSE_CONTROL_FILE_PATHS).not.toContain('src/task-progress.json')
  })
})

describe('complete_task wake messages', () => {
  it('wakes the parent after successful merges so multi-wave plans continue', () => {
    const logs = [
      '[merge] Merged mousse/agent/cec4da46-4c4c-4b13-958b-816cf97ef862',
      '[merge] Merged mousse/agent/72a089bb-32d9-4234-a2ac-91c4410219b1'
    ]
    const ids = ['cec4da46-4c4c-4b13-958b-816cf97ef862', '72a089bb-32d9-4234-a2ac-91c4410219b1']

    expect(buildCompleteTaskFailureWake(ids, logs)).toBeUndefined()
    const wake = buildCompleteTaskSuccessWake(ids, logs)
    expect(wake).toMatch(/Integration finished/)
    expect(wake).toMatch(/Continue the user plan/)
    expect(wake).toContain('[merge] Merged mousse/agent/cec4da46-4c4c-4b13-958b-816cf97ef862')
  })

  it('does not emit a success wake when merges failed', () => {
    const logs = ['[merge] Failed for mousse/agent/x: dirty index']
    const ids = ['x']
    expect(buildCompleteTaskSuccessWake(ids, logs)).toBeUndefined()
    expect(buildCompleteTaskFailureWake(ids, logs)).toMatch(/was not merged/)
  })
})
