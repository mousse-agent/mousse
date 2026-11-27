import type { ChatMessage, Task } from '../../shared/types'

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'

/** One line of a to-do list, whichever runtime or tool kept it. */
export interface TodoEntry {
  id: string
  text: string
  status: TodoStatus
  /** A short note on it (a bot's last progress line). */
  note?: string
}

/** Any runtime's step status ("in_progress", Codex's "inProgress", a task's "interrupted") as a to-do status. */
export function todoStatus(raw: unknown): TodoStatus {
  const value = typeof raw === 'string' ? raw.toLowerCase().replace(/[\s-]/g, '_') : ''
  if (value === 'completed' || value === 'complete' || value === 'done') return 'completed'
  if (value === 'in_progress' || value === 'inprogress' || value === 'running' || value === 'active') return 'in_progress'
  if (value === 'failed' || value === 'error') return 'failed'
  if (value === 'cancelled' || value === 'canceled' || value === 'interrupted') return 'cancelled'
  return 'pending'
}

/** The steps a message's activity sets as the list, or undefined when it says nothing about the list. */
function listOf(message: ChatMessage): TodoEntry[] | undefined {
  const activity = message.activity
  // A subagent's own list is not the thread's, and a call that failed changed nothing.
  if (!activity || activity.parentId || activity.status === 'failed') return undefined
  if (activity.kind === 'todo') return activity.items.map((item, index) => ({ id: String(index), text: item.content, status: todoStatus(item.status) }))
  if (activity.kind === 'plan' && activity.steps?.length) return activity.steps.map((step, index) => ({ id: String(index), text: step.step, status: todoStatus(step.status) }))
  return undefined
}

/**
 * The message that set the thread's to-do list last: Claude's latest `TodoWrite`, or Codex's latest plan update. The
 * message itself, so a store selector keeps one reference until that message changes.
 */
export function latestTodoMessage(messages: readonly ChatMessage[]): ChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.activity && listOf(message)) return message
  }
  return undefined
}

/** The to-dos `latestTodoMessage` holds; empty when there is none or the list was cleared. */
export function todoEntriesOf(message: ChatMessage | undefined): TodoEntry[] {
  return (message && listOf(message)) ?? []
}

/** Claude Code's own task tools, which replace `TodoWrite` unless its tasks are switched off. */
const CLAUDE_TASK_CREATE = 'TaskCreate'
const CLAUDE_TASK_UPDATE = 'TaskUpdate'
/** The result of a `TaskCreate`, which names the new task's id; Claude Code reads it the same way. */
const CREATED = /^Task #(\S+) created successfully/

function rootActivity(message: ChatMessage) {
  const activity = message.activity
  return activity && !activity.parentId && activity.status !== 'failed' ? activity : undefined
}

function claudeTaskCall(message: ChatMessage): boolean {
  const name = rootActivity(message)?.toolName
  return name === CLAUDE_TASK_CREATE || name === CLAUDE_TASK_UPDATE
}

/** The messages that say anything about the thread's to-do list, in order (a store selector compares them one by one). */
export function todoMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => message.activity && (claudeTaskCall(message) || listOf(message)))
}

const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined

/**
 * Claude Code's task list as its `TaskCreate` and `TaskUpdate` calls leave it: a created task joins under the id its
 * result names (pending until then), an update changes its words or status, and `deleted` removes it.
 */
function claudeTaskList(messages: readonly ChatMessage[]): TodoEntry[] {
  const tasks = new Map<string, TodoEntry>()
  const pending = new Map<string, TodoEntry>()
  for (const message of messages) {
    const activity = rootActivity(message)
    if (!activity || activity.kind !== 'generic') continue
    const input = activity.input ?? {}
    if (activity.toolName === CLAUDE_TASK_CREATE) {
      const subject = text(input.subject)
      if (!subject) continue
      const id = text(activity.output)?.match(CREATED)?.[1]
      const entry: TodoEntry = { id: `claude:${id ?? activity.callId}`, text: subject, status: 'pending' }
      if (id) { if (!tasks.has(id)) tasks.set(id, entry) } else pending.set(activity.callId, entry)
    } else if (activity.toolName === CLAUDE_TASK_UPDATE) {
      const id = text(input.taskId)
      if (!id) continue
      if (input.status === 'deleted') { tasks.delete(id); continue }
      const was = tasks.get(id)
      tasks.set(id, { id: `claude:${id}`, text: text(input.subject) ?? was?.text ?? id, status: input.status ? todoStatus(input.status) : was?.status ?? 'pending' })
    }
  }
  return [...tasks.values(), ...pending.values()]
}

/**
 * The thread's to-do list: its runtime's own (Claude Code's tasks, else its latest `TodoWrite`, or Codex's latest plan),
 * then the tasks the agent keeps on the thread with Mousse's `task_create`.
 */
export function threadTodoEntries(messages: readonly ChatMessage[], tasks: readonly Task[] = []): TodoEntry[] {
  const claude = claudeTaskList(messages)
  const runtime = claude.length ? claude : todoEntriesOf(latestTodoMessage(messages))
  const kept = tasks
    .filter((task) => text(task.description))
    .map((task): TodoEntry => {
      const note = text(task.progressMessage)
      return { id: `task:${task.id}`, text: task.description.trim(), status: todoStatus(task.status), ...(note ? { note } : {}) }
    })
  return [...runtime, ...kept]
}

/** "2 of 5 done". */
export function todoProgress(entries: readonly TodoEntry[]): string {
  return `${entries.filter((entry) => entry.status === 'completed').length} of ${entries.length} done`
}
