import { useEffect, useMemo, useRef, useState } from 'react'
import type { BotTaskItem } from '../../../shared/bots/personal/chat'
import type { TaskStatus } from '../../../shared/types'
import { RowTodo } from '../../lib/icons'
import { scaleMotionMs } from '../../lib/motion'
import { TodoChecklist, todoProgress, type TodoEntry, type TodoStatus } from '../todo/TodoChecklist'
import './botTasks.css'

/** How long the popover takes to fade out at Normal speed; keep in step with botTasks.css. */
const CLOSE_MS = 120

/** A task's status as a row's: a task whose agent was lost reads as stopped. */
function rowStatus(status: TaskStatus): TodoStatus {
  return status === 'interrupted' ? 'cancelled' : status
}

/** A bot's checklist (`create_task`, `update_task`) as to-do rows. */
export function botTaskEntries(tasks: readonly BotTaskItem[] | undefined): TodoEntry[] {
  return (tasks ?? []).map((task) => ({ id: task.id, text: task.text, status: rowStatus(task.status), ...(task.note ? { note: task.note } : {}) }))
}

/**
 * The bot's checklist in its chat header: how far it is, and the list in a small popover. Shown only while the bot
 * keeps one. Escape or a click elsewhere closes it.
 */
export function BotTasksButton({ tasks }: { tasks: readonly BotTaskItem[] | undefined }) {
  const entries = useMemo(() => botTaskEntries(tasks), [tasks])
  const [open, setOpen] = useState(false)
  // Mounted while it shows or fades out; `shown` turns on a frame after mounting so it fades in.
  const [mounted, setMounted] = useState(false)
  const [shown, setShown] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (open) {
      setMounted(true)
      const frame = requestAnimationFrame(() => setShown(true))
      return () => cancelAnimationFrame(frame)
    }
    setShown(false)
    const timer = setTimeout(() => setMounted(false), scaleMotionMs(CLOSE_MS))
    return () => clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  // A list that empties closes the popover.
  useEffect(() => { if (!entries.length) setOpen(false) }, [entries.length])

  if (!entries.length && !mounted) return null
  const done = entries.filter((entry) => entry.status === 'completed').length
  const progress = todoProgress(entries)
  return (
    <div className="bot-tasks-root" ref={root} onKeyDown={(event) => {
      if (event.key !== 'Escape' || !open) return
      event.stopPropagation()
      setOpen(false)
      button.current?.focus()
    }}>
      <button
        ref={button}
        type="button"
        className={`bot-header-tasks${open ? ' is-open' : ''}`}
        aria-label={`Checklist, ${progress}`}
        title={`Checklist · ${progress}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <RowTodo size={15} aria-hidden="true" />
        <span className="bot-header-tasks-count">{done}/{entries.length}</span>
      </button>
      {mounted && (
        <div className="bot-tasks-popover" role="dialog" aria-label="Checklist" data-shown={shown} inert={!open || undefined}>
          <div className="bot-tasks-popover-head">
            <span>Checklist</span>
            <span className="bot-tasks-popover-progress">{progress}</span>
          </div>
          <TodoChecklist entries={entries} className="bot-tasks-list" />
        </div>
      )}
    </div>
  )
}
