import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentRegistry } from '../src/mms/agents/AgentRegistry'
import type { MacroEngine } from '../src/mms/macros/MacroEngine'
import { OrchestratorService } from '../src/mms/orchestrator/OrchestratorService'
import { TaskQueue } from '../src/mms/tasks/TaskQueue'
import { HeadlessAgentRunner } from '../src/mms/terminals/HeadlessAgentRunner'
import { PtyManager } from '../src/mms/terminals/PtyManager'
import { LEGACY_AGENT_PROGRESS_FILE } from '../src/mms/worktree/GitStateInspector'
import { WorktreeManager } from '../src/mms/worktree/WorktreeManager'
import { getDefaultSettings } from '../src/shared/settings'

const tempPaths: string[] = []

afterEach(() => {
  for (const path of tempPaths.splice(0)) rmSync(path, { recursive: true, force: true })
})

/**
 * The progress-file protocol and its monitor are retired (docs/run-engine/SPEC.md §14.5): a
 * child's completion is its run's terminal write. A progress file left by an older agent is
 * neither read nor rewritten when its session is restored.
 */
describe('legacy progress file on restoration', () => {
  it('restores a running legacy agent as interrupted and leaves a completed progress file untouched', () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'mousse-progress-'))
    tempPaths.push(worktreePath)
    const progressPath = join(worktreePath, LEGACY_AGENT_PROGRESS_FILE)
    mkdirSync(join(worktreePath, '.mousse'), { recursive: true })
    const completed = JSON.stringify({ status: 'completed', progress: 100, summary: 'Finished while Mousse was unavailable' })
    writeFileSync(progressPath, completed)

    const agents = new AgentRegistry()
    const tasks = new TaskQueue()
    const orchestrator = new OrchestratorService(
      agents, tasks, new WorktreeManager(worktreePath), new PtyManager(), new HeadlessAgentRunner(),
      { listProviders: () => [] } as unknown as MacroEngine, { get: () => getDefaultSettings() } as never, {} as never
    )
    const agent = agents.create({ cliType: 'mousse', worktreePath, branch: 'mousse/agent-legacy', executionMode: 'gui', status: 'running', task: 'Old work' })
    tasks.updateStatus(tasks.create(agent.task, agent.id).id, 'in_progress')

    orchestrator.restoreMousseAgentSessions([{
      version: 1, agentId: agent.id, worktreePath, task: agent.task, assignment: {}, messages: [], history: [],
      runState: 'running', updatedAt: new Date().toISOString()
    }])

    expect(agents.get(agent.id)?.status).toBe('interrupted')
    expect(tasks.findByAgentId(agent.id)?.status).toBe('interrupted')
    expect(readFileSync(progressPath, 'utf8')).toBe(completed)
  })
})
