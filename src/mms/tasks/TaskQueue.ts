import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import {
  normalizeTaskStatus,
  TASK_STATUSES,
  type Task,
  type TaskStatus
} from '../../shared/types'

export type TaskUpdatePatch = {
  description?: string
  status?: TaskStatus
  progress?: number
  /** Short progress / failure message. */
  message?: string
  summary?: string
  /** Optional link to a subagent; omit to leave unchanged. Pass null to unlink. */
  agentId?: string | null
}

export type TaskCreateInput = {
  description: string
  agentId?: string
  status?: TaskStatus
}

function isValidTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value)
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

/**
 * In-memory task list for the active thread.
 *
 * Mutations are synchronous on the Node main thread (serialized with the event loop),
 * so concurrent IPC / tool / lifecycle callers see consistent state without a mutex.
 * Linked-agent lifecycle automation continues to use {@link updateStatus} / {@link linkAgent}.
 */
export class TaskQueue extends EventEmitter {
  private tasks = new Map<string, Task>()
  private persistFn?: () => void

  setPersistCallback(fn: () => void): void {
    this.persistFn = fn
  }

  private persist(): void {
    this.persistFn?.()
  }

  private notify(): void {
    this.emit('updated', this.list())
    this.persist()
  }

  load(tasks: Task[]): void {
    this.tasks.clear()
    for (const task of tasks) {
      this.tasks.set(task.id, {
        ...task,
        status: normalizeTaskStatus(task.status)
      })
    }
  }

  create(description: string, agentId?: string): Task {
    return this.createTask({ description, agentId })
  }

  /**
   * Create a task. `agentId` is optional — unassigned tasks are first-class and editable.
   */
  createTask(input: TaskCreateInput): Task {
    const description = String(input.description ?? '').trim()
    if (!description) {
      throw new Error('Task description is required.')
    }
    if (input.status !== undefined && !isValidTaskStatus(input.status)) {
      throw new Error(
        `Invalid task status "${String(input.status)}". Expected one of: ${TASK_STATUSES.join(', ')}`
      )
    }
    const agentId =
      typeof input.agentId === 'string' && input.agentId.trim().length > 0
        ? input.agentId.trim()
        : undefined

    const task: Task = {
      id: uuidv4(),
      description,
      agentId,
      status: input.status ?? 'pending',
      createdAt: new Date().toISOString()
    }
    this.tasks.set(task.id, task)
    this.notify()
    return task
  }

  list(): Task[] {
    return Array.from(this.tasks.values())
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id)
  }

  updateStatus(id: string, status: TaskStatus): Task | undefined {
    if (!isValidTaskStatus(status)) {
      throw new Error(
        `Invalid task status "${String(status)}". Expected one of: ${TASK_STATUSES.join(', ')}`
      )
    }
    const task = this.tasks.get(id)
    if (!task) return undefined
    task.status = status
    this.notify()
    return task
  }

  linkAgent(id: string, agentId: string): Task | undefined {
    const task = this.tasks.get(id)
    if (!task) return undefined
    task.agentId = agentId
    this.notify()
    return task
  }

  updateProgress(
    id: string,
    update: { progress?: number; message?: string; summary?: string }
  ): Task | undefined {
    const task = this.tasks.get(id)
    if (!task) return undefined
    if (update.progress !== undefined) task.progress = clampProgress(update.progress)
    if (update.message !== undefined) task.progressMessage = update.message
    if (update.summary !== undefined) task.summary = update.summary
    this.notify()
    return task
  }

  /**
   * Validated partial update for tools and UI. Works for tasks with or without agentId.
   * Returns undefined when the task id is unknown.
   */
  update(id: string, patch: TaskUpdatePatch): Task | undefined {
    const task = this.tasks.get(id)
    if (!task) return undefined

    if (patch.description !== undefined) {
      const description = String(patch.description).trim()
      if (!description) {
        throw new Error('Task description cannot be empty.')
      }
      task.description = description
    }

    if (patch.status !== undefined) {
      if (!isValidTaskStatus(patch.status)) {
        throw new Error(
          `Invalid task status "${String(patch.status)}". Expected one of: ${TASK_STATUSES.join(', ')}`
        )
      }
      task.status = patch.status
    }

    if (patch.progress !== undefined) {
      task.progress = clampProgress(Number(patch.progress))
    }
    if (patch.message !== undefined) {
      task.progressMessage = String(patch.message)
    }
    if (patch.summary !== undefined) {
      task.summary = String(patch.summary)
    }
    if (patch.agentId !== undefined) {
      if (patch.agentId === null || patch.agentId === '') {
        delete task.agentId
      } else {
        task.agentId = String(patch.agentId)
      }
    }

    this.notify()
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
