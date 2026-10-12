import { describe, expect, it, vi } from 'vitest'
import { AgentRegistry } from '../src/mms/agents/AgentRegistry'
import type { MacroEngine } from '../src/mms/macros/MacroEngine'
import {
  buildCompleteTaskFailureWake,
  buildCompleteTaskSuccessWake,
  OrchestratorService
} from '../src/mms/orchestrator/OrchestratorService'
import { TaskQueue } from '../src/mms/tasks/TaskQueue'
import { HeadlessAgentRunner } from '../src/mms/terminals/HeadlessAgentRunner'
import { PtyManager } from '../src/mms/terminals/PtyManager'
import type { WorktreeManager } from '../src/mms/worktree/WorktreeManager'
import { getDefaultSettings } from '../src/shared/settings'

/**
 * The bounded readiness-correction loop (progress-file completion, one retry for uncommitted or
 * empty work) is retired with the progress-file protocol (SPEC §14.5). A legacy agent's
 * `complete_task` is now validated once: ready, or failed with the reason.
 */
function legacyAgent(inspection: { ready: boolean; reason?: string; commit?: string; changedFiles?: string[] }, declaredFiles?: string[]) {
  const agents = new AgentRegistry()
  const tasks = new TaskQueue()
  const validateAgentReadiness = vi.fn(async () => inspection)
  const orchestrator = new OrchestratorService(
    agents, tasks, { validateAgentReadiness } as unknown as WorktreeManager, new PtyManager(), new HeadlessAgentRunner(),
    { listProviders: () => [] } as unknown as MacroEngine, { get: () => getDefaultSettings() } as never, {} as never
  )
  const agent = agents.create({ cliType: 'mousse', worktreePath: '/wt', branch: 'mousse/agent-x', executionMode: 'gui', status: 'running', task: 'Fix it', declaredFiles })
  tasks.updateStatus(tasks.create(agent.task, agent.id).id, 'in_progress')
  const complete = () => (orchestrator as unknown as { completeMousseAgent: (id: string, merge: boolean, summary: string) => Promise<void> }).completeMousseAgent(agent.id, true, 'Done')
  return { agents, tasks, agent, complete, validateAgentReadiness }
}

describe('readiness recovery helpers', () => {
  it('fails an uncommitted completion at once instead of asking for a correction', async () => {
    const reason = 'Agent left uncommitted changes: subagent-lab/package.json'
    const f = legacyAgent({ ready: false, reason })
    await f.complete()
    expect(f.validateAgentReadiness).toHaveBeenCalledTimes(1)
    expect(f.agents.get(f.agent.id)?.status).toBe('failed')
    expect(f.tasks.findByAgentId(f.agent.id)?.progressMessage).toBe(reason)
  })

  it('marks a validated branch ready for merge', async () => {
    const f = legacyAgent({ ready: true, commit: 'abc123', changedFiles: ['src/a.ts'] }, ['src/a.ts'])
    await f.complete()
    expect(f.agents.get(f.agent.id)?.status).toBe('ready')
    expect(f.tasks.findByAgentId(f.agent.id)).toMatchObject({ status: 'completed', summary: 'Done' })
  })

  it('fails a branch that changed files outside its declaration', async () => {
    const f = legacyAgent({ ready: true, commit: 'abc123', changedFiles: ['src/a.ts', 'src/b.ts'] }, ['src/a.ts'])
    await f.complete()
    expect(f.agents.get(f.agent.id)?.status).toBe('failed')
    expect(f.tasks.findByAgentId(f.agent.id)?.progressMessage).toMatch(/outside its discovery declaration: src\/b.ts/)
  })
})

describe('complete_task wake messages', () => {
  it('wakes the parent after successful merges so multi-wave plans continue', () => {
    const logs = [
      '[mousse] Stopped agent cec4da46',
      '[merge] Merged mousse/agent/cec4da46-4c4c-4b13-958b-816cf97ef862',
      '[mousse] Closed GUI agent cec4da46',
      '[mousse] Stopped agent 72a089bb',
      '[merge] Merged mousse/agent/72a089bb-32d9-4234-a2ac-91c4410219b1',
      '[mousse] Closed GUI agent 72a089bb'
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
