import { Type, type Tool } from '@earendil-works/pi-ai'
import { TASK_STATUSES, type TaskStatus } from '../../shared/types'
import type { TaskQueue } from './TaskQueue'

const STATUS_HINT = TASK_STATUSES.join(', ')

/**
 * Orchestrator-facing task tools. Available in every chat mode (agent, plan, build, skill).
 * Unassigned tasks (no agentId) are first-class — assignment is optional.
 */
export class TaskControlTools {
  constructor(private tasks: TaskQueue) {}

  getToolDefinitions(): Tool[] {
    return [
      {
        name: 'list_tasks',
        description:
          'List all tasks in the current thread queue (pending, in progress, completed, etc.).',
        parameters: Type.Object({})
      },
      {
        name: 'create_task',
        description:
          'Create a task in the thread queue. agentId is optional — unassigned tasks are valid and editable.',
        parameters: Type.Object({
          description: Type.String({ description: 'What the task is about.' }),
          status: Type.Optional(
            Type.String({
              description: `Initial status. One of: ${STATUS_HINT}. Defaults to pending.`
            })
          ),
          agentId: Type.Optional(
            Type.String({
              description: 'Optional linked agent id. Omit to leave the task unassigned.'
            })
          )
        })
      },
      {
        name: 'update_task',
        description:
          'Update an existing task by id. Works for tasks with or without an assigned agent. Provide only fields to change.',
        parameters: Type.Object({
          id: Type.String({ description: 'Task id from list_tasks or create_task.' }),
          description: Type.Optional(Type.String({ description: 'New task description.' })),
          status: Type.Optional(
            Type.String({
              description: `New status. One of: ${STATUS_HINT}.`
            })
          ),
          progress: Type.Optional(
            Type.Number({ description: 'Completion percentage 0–100.' })
          ),
          message: Type.Optional(
            Type.String({ description: 'Short progress or failure message.' })
          ),
          summary: Type.Optional(
            Type.String({ description: 'Final or intermediate summary text.' })
          )
        })
      }
    ]
  }

  isTaskTool(name: string): boolean {
    return this.getToolDefinitions().some((tool) => tool.name === name)
  }

  async execute(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ text: string; isError: boolean }> {
    try {
      switch (name) {
        case 'list_tasks': {
          return { text: JSON.stringify(this.tasks.list(), null, 2), isError: false }
        }
        case 'create_task': {
          const description = String(args.description ?? '')
          const agentId =
            typeof args.agentId === 'string' && args.agentId.trim()
              ? args.agentId.trim()
              : undefined
          let status: TaskStatus | undefined
          if (args.status !== undefined) {
            status = String(args.status) as TaskStatus
          }
          const task = this.tasks.createTask({ description, agentId, status })
          return { text: JSON.stringify(task, null, 2), isError: false }
        }
        case 'update_task': {
          const id = String(args.id ?? '').trim()
          if (!id) {
            return { text: 'Task id is required.', isError: true }
          }
          const patch: {
            description?: string
            status?: TaskStatus
            progress?: number
            message?: string
            summary?: string
          } = {}
          if (args.description !== undefined) patch.description = String(args.description)
          if (args.status !== undefined) patch.status = String(args.status) as TaskStatus
          if (args.progress !== undefined) patch.progress = Number(args.progress)
          if (args.message !== undefined) patch.message = String(args.message)
          if (args.summary !== undefined) patch.summary = String(args.summary)

          if (
            patch.description === undefined &&
            patch.status === undefined &&
            patch.progress === undefined &&
            patch.message === undefined &&
            patch.summary === undefined
          ) {
            return {
              text: 'Provide at least one field to update (description, status, progress, message, summary).',
              isError: true
            }
          }

          const task = this.tasks.update(id, patch)
          if (!task) {
            return { text: `Task not found: ${id}`, isError: true }
          }
          return { text: JSON.stringify(task, null, 2), isError: false }
        }
        default:
          return { text: `Unknown task tool: ${name}`, isError: true }
      }
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), isError: true }
    }
  }
}
