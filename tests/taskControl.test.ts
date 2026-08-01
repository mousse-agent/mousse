import { describe, expect, it } from 'vitest'
import { TaskQueue } from '../src/mms/tasks/TaskQueue'
import { TaskControlTools } from '../src/mms/tasks/TaskControlTools'
import { buildOrchestratorSystemPrompt } from '../src/mms/orchestrator/systemPrompt'

describe('TaskQueue validated operations', () => {
  it('creates unassigned tasks as first-class entries', () => {
    const queue = new TaskQueue()
    const task = queue.createTask({ description: 'Draft plan outline' })
    expect(task.agentId).toBeUndefined()
    expect(task.status).toBe('pending')
    expect(queue.list()).toHaveLength(1)
  })

  it('edits description/status/progress/summary without requiring agentId', () => {
    const queue = new TaskQueue()
    const task = queue.createTask({ description: 'Unassigned work' })
    expect(task.agentId).toBeUndefined()

    const updated = queue.update(task.id, {
      description: 'Refined work item',
      status: 'in_progress',
      progress: 40,
      message: 'Halfway through research',
      summary: 'Research notes drafted'
    })

    expect(updated).toMatchObject({
      id: task.id,
      description: 'Refined work item',
      status: 'in_progress',
      progress: 40,
      progressMessage: 'Halfway through research',
      summary: 'Research notes drafted'
    })
    expect(updated?.agentId).toBeUndefined()
  })

  it('rejects invalid status values', () => {
    const queue = new TaskQueue()
    const task = queue.create('Something')
    expect(() =>
      queue.update(task.id, { status: 'done' as unknown as 'completed' })
    ).toThrow(/Invalid task status/)
    expect(() => queue.updateStatus(task.id, 'bogus' as 'failed')).toThrow(/Invalid task status/)
  })

  it('rejects empty descriptions', () => {
    const queue = new TaskQueue()
    expect(() => queue.createTask({ description: '   ' })).toThrow(/required/i)
    const task = queue.create('ok')
    expect(() => queue.update(task.id, { description: '' })).toThrow(/empty/i)
  })

  it('preserves linkAgent / lifecycle status updates for assigned tasks', () => {
    const queue = new TaskQueue()
    const task = queue.create('Linked later')
    queue.linkAgent(task.id, 'agent-1')
    queue.updateStatus(task.id, 'in_progress')
    queue.updateProgress(task.id, { progress: 90, summary: 'Almost done' })

    const linked = queue.get(task.id)!
    expect(linked.agentId).toBe('agent-1')
    expect(linked.status).toBe('in_progress')
    expect(linked.progress).toBe(90)
    expect(linked.summary).toBe('Almost done')
  })
})

describe('TaskControlTools', () => {
  it('exposes list_tasks, create_task, and update_task', () => {
    const tools = new TaskControlTools(new TaskQueue())
    expect(tools.getToolDefinitions().map((t) => t.name)).toEqual([
      'list_tasks',
      'create_task',
      'update_task'
    ])
    expect(tools.isTaskTool('create_task')).toBe(true)
    expect(tools.isTaskTool('bash')).toBe(false)
  })

  it('creates and edits an unassigned task through tools', async () => {
    const queue = new TaskQueue()
    const tools = new TaskControlTools(queue)

    const created = await tools.execute('create_task', {
      description: 'Track plan steps'
    })
    expect(created.isError).toBe(false)
    const task = JSON.parse(created.text) as { id: string; agentId?: string }
    expect(task.agentId).toBeUndefined()

    const updated = await tools.execute('update_task', {
      id: task.id,
      status: 'completed',
      progress: 100,
      summary: 'All steps done'
    })
    expect(updated.isError).toBe(false)
    expect(JSON.parse(updated.text)).toMatchObject({
      id: task.id,
      status: 'completed',
      progress: 100,
      summary: 'All steps done'
    })

    const listed = await tools.execute('list_tasks', {})
    expect(listed.isError).toBe(false)
    expect(JSON.parse(listed.text)).toHaveLength(1)
  })

  it('returns errors for invalid updates without throwing', async () => {
    const tools = new TaskControlTools(new TaskQueue())
    const missing = await tools.execute('update_task', { id: 'nope', status: 'pending' })
    expect(missing.isError).toBe(true)

    const created = await tools.execute('create_task', { description: 'x' })
    const id = JSON.parse(created.text).id as string
    const badStatus = await tools.execute('update_task', { id, status: 'not-a-status' })
    expect(badStatus.isError).toBe(true)
    expect(badStatus.text).toMatch(/Invalid task status/)
  })
})

describe('task tools in every chat mode (prompt surface)', () => {
  it('mentions task queue tools in agent, plan, build, and skill prompts', () => {
    const modes = [
      buildOrchestratorSystemPrompt({ mode: 'agent' }),
      buildOrchestratorSystemPrompt({ mode: 'plan' }),
      buildOrchestratorSystemPrompt({ mode: 'build' }),
      buildOrchestratorSystemPrompt({ mode: { type: 'skill', skillId: 'reviewer' } })
    ] as const

    for (const prompt of modes) {
      expect(prompt).toContain('list_tasks')
      expect(prompt).toContain('create_task')
      expect(prompt).toContain('update_task')
      expect(prompt).toContain('unassigned')
    }
  })

  it('omits task queue tools from subagent prompts', () => {
    const sub = buildOrchestratorSystemPrompt({ mode: 'build', subagent: true })
    expect(sub).not.toContain('create_task')
    expect(sub).not.toContain('list_tasks')
  })
})

describe('TaskControlTools availability for plan/build/agent wiring', () => {
  it('stable tool names match definitions used by LlmClient in every mode', () => {
    const tools = new TaskControlTools(new TaskQueue())
    const names = tools.getToolDefinitions().map((t) => t.name)
    // LlmClient injects the same definitions for plan, build, agent, and skill when not subagent.
    expect(names).toContain('list_tasks')
    expect(names).toContain('create_task')
    expect(names).toContain('update_task')
    expect(tools.isTaskTool('list_tasks')).toBe(true)
    expect(tools.isTaskTool('update_task')).toBe(true)
  })
})
