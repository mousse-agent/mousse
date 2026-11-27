import { useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../stores/appStore'
import { threadTodoEntries, todoMessages, todoProgress, type TodoEntry } from '../../lib/todoList'
import { Collapse } from '../ui/Collapse'
import { TodoChecklist } from '../todo/TodoChecklist'
import { SideCardSection, type SideCardSectionContext } from './SideCardSection'
import './todoSection.css'

/**
 * The thread's to-do list as its runtime keeps it (Claude Code's tasks or to-dos, Codex's plan) and as its agent keeps it
 * with `task_create`, updated as the turn writes it. Shown only while the thread has one, collapsed to how far it is
 * until opened; it opens and closes with the card's collapse motion.
 */
export function TodoSection({ threadId }: SideCardSectionContext) {
  // Only the messages that touch the list: a streamed reply elsewhere leaves the section alone.
  const messages = useAppStore(useShallow((state) => todoMessages(state.messages)))
  const tasks = useAppStore((state) => state.tasks)
  const entries = useMemo(() => threadTodoEntries(messages, tasks), [messages, tasks])
  // The list stays drawn while the section closes.
  const shownRef = useRef<TodoEntry[]>(entries)
  if (entries.length) shownRef.current = entries
  const shown = shownRef.current
  return (
    <Collapse open={entries.length > 0} className="side-card-todos">
      <SideCardSection title="To-dos" threadId={threadId} defaultCollapsed collapsedNote={shown.length ? todoProgress(shown) : null}>
        <TodoChecklist entries={shown} />
      </SideCardSection>
    </Collapse>
  )
}
