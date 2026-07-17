import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import type { Task, TaskStatus } from '../../shared/types'

export class TaskQueue extends EventEmitter {
  private tasks = new Map<string, Task>()
  private persistFn?: () => void

  setPersistCallback(fn: () => void): void {
    this.persistFn = fn
  }

  private persist(): void {
    this.persistFn?.()
  }

  load(tasks: Task[]): void {
    this.tasks.clear()
    for (const task of tasks) {
      this.tasks.set(task.id, task)
    }
  }

  create(description: string, agentId?: string): Task {
    const task: Task = {
      id: uuidv4(),
      description,
      agentId,
      status: 'pending',
      createdAt: new Date().toISOString()
    }
    this.tasks.set(task.id, task)
    this.emit('updated', this.list())
    this.persist()
    return task
  }

  list(): Task[] {
    return Array.from(this.tasks.values())
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id)
  }

  updateStatus(id: string, status: TaskStatus): Task | undefined {
    const task = this.tasks.get(id)
    if (!task) return undefined
    task.status = status
    this.emit('updated', this.list())
    this.persist()
    return task
  }

  linkAgent(id: string, agentId: string): Task | undefined {
    const task = this.tasks.get(id)
    if (!task) return undefined
    task.agentId = agentId
    this.emit('updated', this.list())
    this.persist()
    return task
  }

  updateProgress(
    id: string,
    update: { progress?: number; message?: string; summary?: string }
  ): Task | undefined {
    const task = this.tasks.get(id)
    if (!task) return undefined
    if (update.progress !== undefined) task.progress = Math.max(0, Math.min(100, update.progress))
    if (update.message !== undefined) task.progressMessage = update.message
    if (update.summary !== undefined) task.summary = update.summary
    this.emit('updated', this.list())
    this.persist()
    return task
  }

  findByAgentId(agentId: string): Task | undefined {
    return this.list().find((t) => t.agentId === agentId)
  }

  clear(): void {
    this.tasks.clear()
    this.emit('updated', this.list())
  }
}
