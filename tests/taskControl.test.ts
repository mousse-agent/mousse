import { describe, expect, it } from 'vitest'
import { TaskQueue } from '../src/mms/tasks/TaskQueue'
import { TaskControlTools } from '../src/mms/tasks/TaskControlTools'

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
  it('exposes task_list, task_create, and task_update', () => {
    const tools = new TaskControlTools(new TaskQueue())
    expect(tools.getToolDefinitions().map((t) => t.name)).toEqual([
      'task_list',
      'task_create',
      'task_update'
    ])
    for (const name of ['task_list', 'task_create', 'task_update']) expect(tools.isTaskTool(name)).toBe(true)
    expect(tools.isTaskTool('bash')).toBe(false)
  })

  it('creates and edits an unassigned task through tools', async () => {
    const queue = new TaskQueue()
    const tools = new TaskControlTools(queue)

    const created = await tools.execute('task_create', {
      description: 'Track plan steps'
    })
    expect(created.isError).toBe(false)
    const task = JSON.parse(created.text) as { id: string; agentId?: string }
    expect(task.agentId).toBeUndefined()

    const updated = await tools.execute('task_update', {
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

    const listed = await tools.execute('task_list', {})
    expect(listed.isError).toBe(false)
    expect(JSON.parse(listed.text)).toHaveLength(1)
  })

  it('returns errors for invalid updates without throwing', async () => {
    const tools = new TaskControlTools(new TaskQueue())
    const missing = await tools.execute('task_update', { id: 'nope', status: 'pending' })
    expect(missing.isError).toBe(true)

    const created = await tools.execute('task_create', { description: 'x' })
    const id = JSON.parse(created.text).id as string
    const badStatus = await tools.execute('task_update', { id, status: 'not-a-status' })
    expect(badStatus.isError).toBe(true)
    expect(badStatus.text).toMatch(/Invalid task status/)
  })
})
