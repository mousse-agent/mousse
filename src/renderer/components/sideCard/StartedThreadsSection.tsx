import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useSubagents } from '../../hooks/useSubagents'
import { useComputers } from '../../lib/computers'
import { openThread } from '../../lib/openThread'
import { useAppStore } from '../../stores/appStore'
import { ComputerBadgeView } from '../ComputerBadge'
import { useThreadRefMenu } from '../ThreadRefMenu'
import { launchedThreadsOf, type LaunchedThread } from './lineageLogic'
import { SideCardSection, type SideCardSectionContext } from './SideCardSection'
import './lineage.css'

interface StartedThreadRowProps {
  thread: LaunchedThread
  computer?: { name: string; online: boolean }
  onOpen: (threadId: string) => void
}

function StartedThreadRow({ thread, computer, onOpen }: StartedThreadRowProps) {
  const name = thread.name.trim() || 'New Thread'
  const refMenu = useThreadRefMenu(thread.id)
  return (
    <li className="lineage-item">
      {refMenu.menu}
      <button type="button" className="lineage-row" title={name} {...refMenu.bind} onClick={() => onOpen(thread.id)}>
        <span className="lineage-text">
          <span className="lineage-name">{name}</span>
          {computer && (
            <ComputerBadgeView name={computer.name} state={computer.online ? 'online' : 'offline'} offline="Offline" withName className="lineage-computer" />
          )}
        </span>
        {thread.hidden && <span className="lineage-status" title="Not in your sidebar">Hidden</span>}
      </button>
    </li>
  )
}

/** The threads an agent in this thread started with thread_create, each opening its thread. Renders nothing for none. */
export function StartedThreadsList({ threads, computerOf, onOpen }: { threads: readonly LaunchedThread[]; computerOf: (node: string) => { name: string; online: boolean } | undefined; onOpen: (threadId: string) => void }) {
  if (threads.length === 0) return null
  return (
    <ul className="lineage-list">
      {threads.map((thread) => (
        <StartedThreadRow key={thread.id} thread={thread} computer={thread.node ? computerOf(thread.node) : undefined} onOpen={onOpen} />
      ))}
    </ul>
  )
}

/**
 * Started threads: the threads an agent in the selected thread started with `thread_create`, here or on another
 * computer. A thread an agent starts is out of the sidebar unless it was started as independent, so this is where the
 * person finds it. Its remote subagents are Nest's, not listed again. Nothing shows while there are none.
 */
export function StartedThreadsSection({ threadId }: SideCardSectionContext) {
  const subagents = useSubagents(threadId)
  const launched = useAppStore(useShallow((state) => (threadId ? launchedThreadsOf(state.threads, threadId) : [])))
  const { byNode } = useComputers(launched.some((thread) => thread.node))
  const threads = useMemo(() => {
    const subagentRefs = new Set(subagents.map((subagent) => subagent.computer?.ref).filter(Boolean))
    return launched.filter((thread) => !subagentRefs.has(thread.id))
  }, [launched, subagents])
  if (threads.length === 0) return null
  return (
    <SideCardSection title="Started threads" threadId={threadId}>
      <StartedThreadsList threads={threads} computerOf={(node) => byNode[node]} onOpen={(id) => void openThread(id)} />
    </SideCardSection>
  )
}
