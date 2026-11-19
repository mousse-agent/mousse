import { BOT_TASKS_SHOWN, type BotTaskItem } from '../../../shared/bots/personal/chat'
import type { Task } from '../../../shared/types'

const TASK_TEXT_CHARS = 300
const TASK_NOTE_CHARS = 200

function clip(text: string, chars: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > chars ? `${line.slice(0, chars - 1)}…` : line
}

/**
 * A bot's checklist as its summary carries it: the tasks of each thread in turn (its chat's first), each once, the newest
 * `BOT_TASKS_SHOWN` kept in order. A thread whose list can't be read adds nothing.
 */
export function botTaskItems(threadIds: readonly string[], read: (threadId: string) => Task[]): BotTaskItem[] {
  const seen = new Set<string>()
  const items: BotTaskItem[] = []
  for (const threadId of new Set(threadIds)) {
    let tasks: Task[]
    try {
      tasks = read(threadId)
    } catch {
      continue
    }
    for (const task of tasks) {
      if (seen.has(task.id) || !task.description?.trim()) continue
      seen.add(task.id)
      const note = task.progressMessage?.trim()
      items.push({ id: task.id, text: clip(task.description, TASK_TEXT_CHARS), status: task.status, ...(note ? { note: clip(note, TASK_NOTE_CHARS) } : {}) })
    }
  }
  return items.length > BOT_TASKS_SHOWN ? items.slice(-BOT_TASKS_SHOWN) : items
}
