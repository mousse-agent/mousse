import { Circle, CircleCheck, CircleDotDashed, CircleX } from '../../lib/icons'
import type { TodoEntry, TodoStatus } from '../../lib/todoList'
import './todoChecklist.css'

const STATUS_LABEL: Record<TodoStatus, string> = {
  pending: 'To do',
  in_progress: 'In progress',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Stopped'
}

function StatusIcon({ status }: { status: TodoStatus }) {
  const props = { size: 13, strokeWidth: 2, className: 'todo-checklist-icon', 'aria-label': STATUS_LABEL[status] }
  if (status === 'completed') return <CircleCheck {...props} />
  if (status === 'in_progress') return <CircleDotDashed {...props} />
  if (status === 'failed' || status === 'cancelled') return <CircleX {...props} />
  return <Circle {...props} />
}

/** A to-do list: one quiet row per step, the one in progress filled. The full words and any note are in the tooltip. */
export function TodoChecklist({ entries, className }: { entries: readonly TodoEntry[]; className?: string }) {
  return (
    <ul className={`todo-checklist${className ? ` ${className}` : ''}`}>
      {entries.map((entry) => (
        <li
          key={entry.id}
          className="todo-checklist-row"
          data-status={entry.status}
          title={`${STATUS_LABEL[entry.status]}: ${entry.text}${entry.note ? `\n${entry.note}` : ''}`}
        >
          <StatusIcon status={entry.status} />
          <span className="todo-checklist-text">{entry.text}</span>
        </li>
      ))}
    </ul>
  )
}
