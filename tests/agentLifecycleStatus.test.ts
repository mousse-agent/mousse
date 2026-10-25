import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRegistry } from '../src/mms/agents/AgentRegistry'
import { MacroEngine } from '../src/mms/macros/MacroEngine'
import {
  buildCompleteTaskFailureWake,
  buildCompleteTaskSuccessWake,
  OrchestratorService,
  requiresMergeCandidateToFinalize,
  shouldFinalizeAgent
} from '../src/mms/orchestrator/OrchestratorService'
import { buildOrchestratorSystemPrompt, DELEGATION_PROMPT } from '../src/mms/orchestrator/systemPrompt'
import { LEGACY_AGENT_PROGRESS_FILE, MOUSSE_CONTROL_FILE_PATHS } from '../src/mms/worktree/controlFiles'
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
  headlessRunner: HeadlessAgentRunner
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
  return { orchestrator, agents, tasks, worktrees, headlessRunner }
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

describe('legacy agent failure propagation', () => {
  it('marks agent and task failed with the exit reason and does not remove the worktree', async () => {
    const root = makeTempRoot()
    const { agents, tasks, worktrees, headlessRunner } = createOrchestrator(root)
    await worktrees.init()
    const wt = await worktrees.createWorktree('22222222-2222-2222-2222-222222222222')
    const { agent } = seedRunningGuiAgent(agents, tasks, {
      worktreePath: wt.path,
      branch: wt.branch,
      executionMode: 'headless'
    })

    headlessRunner.emit('exit', { agentId: agent.id, exitCode: 7 })

    expect(agents.get(agent.id)?.status).toBe('failed')
    const task = tasks.findByAgentId(agent.id)
    expect(task?.status).toBe('failed')
    expect(task?.progressMessage).toBe('Headless agent exited with code 7.')
    expect(existsSync(wt.path)).toBe(true)
    // A second exit is a no-op for terminal agents.
    headlessRunner.emit('exit', { agentId: agent.id, exitCode: 9 })
    expect(task?.progressMessage).toBe('Headless agent exited with code 7.')
  })
})

describe('headless agent exit handling', () => {
  function seedHeadless(agents: AgentRegistry, tasks: TaskQueue, worktreePath: string): Agent {
    const agent = agents.create({
      cliType: 'codex',
      worktreePath,
      branch: 'mousse/agent-headless1',
      executionMode: 'headless',
      status: 'running',
      task: 'Headless work'
    })
    tasks.updateStatus(tasks.create(agent.task, agent.id).id, 'in_progress')
    return agent
  }

  // SPEC §14.5 retired the progress-file protocol: an exit is terminal and the file is not read.
  it('leaves an agent that exits 0 interrupted with its worktree retained, ignoring any progress file', () => {
    const root = makeTempRoot()
    const { agents, tasks, headlessRunner } = createOrchestrator(root)
    const agent = seedHeadless(agents, tasks, root)
    mkdirSync(join(root, '.mousse'), { recursive: true })
    writeFileSync(join(root, LEGACY_AGENT_PROGRESS_FILE), JSON.stringify({ status: 'completed', summary: 'done' }))

    headlessRunner.emit('exit', { agentId: agent.id, exitCode: 0 })

    expect(agents.get(agent.id)?.status).toBe('interrupted')
    expect(tasks.findByAgentId(agent.id)?.status).toBe('interrupted')
    expect(tasks.findByAgentId(agent.id)?.progressMessage).toBe('Headless agent exited; its worktree is retained for inspection.')
    expect(existsSync(root)).toBe(true)
  })

  it('ignores an exit without a code', () => {
    const root = makeTempRoot()
    const { agents, tasks, headlessRunner } = createOrchestrator(root)
    const agent = seedHeadless(agents, tasks, root)
    headlessRunner.emit('exit', { agentId: agent.id, exitCode: null })
    expect(agents.get(agent.id)?.status).toBe('running')
  })

  it('still fails on a non-zero exit and ignores settled agents', () => {
    const root = makeTempRoot()
    const { agents, tasks, headlessRunner } = createOrchestrator(root)
    const agent = seedHeadless(agents, tasks, root)
    headlessRunner.emit('exit', { agentId: agent.id, exitCode: 3 })
    expect(tasks.findByAgentId(agent.id)?.progressMessage).toBe('Headless agent exited with code 3.')

    const ready = seedHeadless(agents, tasks, root)
    agents.updateStatus(ready.id, 'ready')
    headlessRunner.emit('exit', { agentId: ready.id, exitCode: 0 })
    expect(agents.get(ready.id)?.status).toBe('ready')
  })
})

describe('legacy agent settlement', () => {
  // The delegation batch and its timer-driven parent wake are gone (SPEC §14.5): delegated work is
  // a child thread whose completion is a stored inbox row. Settling a legacy agent changes its
  // status and wakes nothing.
  it('settles failed and cancelled legacy agents without a batch wake', async () => {
    const root = makeTempRoot()
    const { orchestrator, agents, tasks, headlessRunner } = createOrchestrator(root)
    expect(isDelegationSettledStatus('ready')).toBe(true)
    expect(isDelegationSettledStatus('failed')).toBe(true)
    expect(isDelegationSettledStatus('cancelled')).toBe(true)
    expect(isDelegationSettledStatus('interrupted')).toBe(true)
    const first = seedRunningGuiAgent(agents, tasks, { worktreePath: '/batch-1', branch: 'mousse/agent-batch001', executionMode: 'headless' })
    const second = seedRunningGuiAgent(agents, tasks, { worktreePath: '/batch-2', branch: 'mousse/agent-batch002' })
    const sendSpy = vi.spyOn(orchestrator, 'send').mockResolvedValue({ message: 'ok', actions: [] })

    headlessRunner.emit('exit', { agentId: first.agent.id, exitCode: 1 })
    await orchestrator.stopAgent(second.agent.id, false)

    expect(agents.get(first.agent.id)?.status).toBe('failed')
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

describe('prompt consistency', () => {
  it('has subagents report through their final reply, without a progress file or orchestration JSON', () => {
    const sub = buildOrchestratorSystemPrompt({ mode: 'build', subagent: true })
    expect(sub).toContain('Do NOT emit complete_task')
    expect(sub).toContain('Your final reply is your result')
    expect(sub).toMatch(/On failure, say why/i)
    expect(sub).not.toMatch(/task progress protocol|progress file/i)
    expect(sub).not.toContain('spawn_agents')
    expect(sub).not.toContain('"type": "complete_task"')
  })

  it('tells the delegating model to include the plan, acceptance criteria and focused validation', () => {
    expect(DELEGATION_PROMPT).toMatch(/plan\/spec body or a readable path/i)
    expect(DELEGATION_PROMPT).toMatch(/acceptance criteria/i)
    expect(DELEGATION_PROMPT).toMatch(/focused validation/i)
    expect(DELEGATION_PROMPT).toMatch(/do not wait or poll/i)
  })
})

describe('delegation guidance', () => {
  // spawn_agents (cliType assignments) is retired (SPEC §14.5); delegation is delegate_task.
  it('describes delegation as delegate_task child threads', () => {
    expect(DELEGATION_PROMPT).toContain('delegate_task')
    expect(DELEGATION_PROMPT).toContain('child thread')
  })

  it('defaults delegated children to the current connected model', () => {
    expect(DELEGATION_PROMPT).toContain('provider and model default to yours')
    expect(DELEGATION_PROMPT).toContain('explicitly requests an override')
    expect(DELEGATION_PROMPT).toContain('Never copy example or guessed model identifiers')
  })

  it('reserves the shared workspace for read-only roles and isolates writers', () => {
    expect(DELEGATION_PROMPT).toMatch(/"shared" is only for read-only roles \(role "research" or "review"\)/)
    expect(DELEGATION_PROMPT).toMatch(/"isolated" gives the child its own worktree/)
  })

  it('requires an explicit integration of isolated results', () => {
    expect(DELEGATION_PROMPT).toMatch(/integrate_delegation/)
    expect(DELEGATION_PROMPT).toMatch(/Never claim integration from completion alone/)
  })

  it('keeps the agent-mode prompt free of spawn instructions', () => {
    const agent = buildOrchestratorSystemPrompt({ mode: 'agent' })
    expect(agent).not.toContain('spawn_agents')
    expect(agent).not.toContain('cliType')
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
