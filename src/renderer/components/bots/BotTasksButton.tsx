import { useEffect, useMemo, useRef, useState } from 'react'
import type { BotTaskItem } from '../../../shared/bots/personal/chat'
import { RowTodo } from '../../lib/icons'
import { scaleMotionMs } from '../../lib/motion'
import { todoProgress, todoStatus, type TodoEntry } from '../../lib/todoList'
import { TodoChecklist } from '../todo/TodoChecklist'
import { useBotChecklistHidden } from './botChecklistSetting'
import './botTasks.css'

/** How long the popover takes to fade out at Normal speed; keep in step with botTasks.css. */
const CLOSE_MS = 120
/** How long hiding or showing the checklist takes at Normal speed; keep in step with botTasks.css. */
const REVEAL_MS = 200

/** A bot's checklist (`task_create`, `task_update`) as to-do rows. */
export function botTaskEntries(tasks: readonly BotTaskItem[] | undefined): TodoEntry[] {
  return (tasks ?? []).map((task) => ({ id: task.id, text: task.text, status: todoStatus(task.status), ...(task.note ? { note: task.note } : {}) }))
}

/**
 * The bot's checklist in its chat header: how far it is, and the list in a small popover. Shown only while the bot
 * keeps one and it is not hidden ("Hide checklist" in the bot's menus); hiding or showing it folds it in or out.
 * Escape or a click elsewhere closes the popover.
 */
export function BotTasksButton({ botId, tasks }: { botId: string; tasks: readonly BotTaskItem[] | undefined }) {
  const entries = useMemo(() => botTaskEntries(tasks), [tasks])
  const hidden = useBotChecklistHidden(botId)
  const [open, setOpen] = useState(false)
  // Kept while it shows or folds away; `revealed` turns on a frame after it mounts so it unfolds.
  const [present, setPresent] = useState(!hidden)
  const [revealed, setRevealed] = useState(!hidden)
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

  useEffect(() => {
    if (!hidden) {
      setPresent(true)
      const frame = requestAnimationFrame(() => setRevealed(true))
      return () => cancelAnimationFrame(frame)
    }
    setOpen(false)
    setRevealed(false)
    const timer = setTimeout(() => setPresent(false), scaleMotionMs(REVEAL_MS))
    return () => clearTimeout(timer)
  }, [hidden])

  if ((!entries.length && !mounted) || !present) return null
  const done = entries.filter((entry) => entry.status === 'completed').length
  const progress = todoProgress(entries)
  return (
    <div className="bot-tasks-root" ref={root} data-revealed={revealed} inert={!revealed || undefined} onKeyDown={(event) => {
      if (event.key !== 'Escape' || !open) return
      event.stopPropagation()
      setOpen(false)
      button.current?.focus()
    }}>
      <div className="bot-tasks-reveal"><button
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
      </button></div>
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
