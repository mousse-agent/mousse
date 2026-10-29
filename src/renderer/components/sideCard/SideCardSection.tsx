import { useId, type ReactNode } from 'react'
import { ChevronRight } from '../../lib/icons'
import { useAppStore } from '../../stores/appStore'

/** What every side card section receives. Add shared fields here rather than per section. */
export interface SideCardSectionContext {
  /** Selected thread, or null before one exists. */
  threadId: string | null
  /** Project the selected thread belongs to; null for standalone threads. */
  projectId: string | null
}

interface SideCardSectionProps {
  title: string
  threadId: string | null
  /** A control at the end of the heading row (Lineage's Stop all). */
  action?: ReactNode
  /**
   * The key the user's collapse or expand choice is kept under, so it lasts across threads and launches.
   * Defaults to the title. A section may use another key for a state whose default differs (Git without a repository).
   */
  collapseKey?: string
  /** Whether the section starts collapsed until the user chooses otherwise. */
  defaultCollapsed?: boolean
  /** A quiet word after the title while collapsed, saying what is inside (Git's "Not a repository"). */
  collapsedNote?: string | null
  children: ReactNode
}

/** The user's choice for a section, or the default when there is none (or the saved value is unreadable). */
export function sideCardSectionCollapsed(saved: Record<string, unknown> | null | undefined, key: string, defaultCollapsed: boolean): boolean {
  const choice = saved && typeof saved === 'object' ? saved[key] : undefined
  return typeof choice === 'boolean' ? choice : defaultCollapsed
}

/** Shared spacing and a collapsible heading for one block of the thread side card. */
export function SideCardSection({ title, threadId, action, collapseKey = title, defaultCollapsed = false, collapsedNote = null, children }: SideCardSectionProps) {
  const collapsed = useAppStore((state) => sideCardSectionCollapsed(state.sideCardCollapsed, collapseKey, defaultCollapsed))
  const bodyId = useId()
  const toggle = () => useAppStore.getState().setSideCardSectionCollapsed(collapseKey, !collapsed)
  return (
    <section className="side-card-section" data-thread-id={threadId ?? undefined} data-collapsed={collapsed}>
      <div className="side-card-section-head">
        <h3 className="side-card-section-title">
          <button
            type="button"
            className="side-card-section-toggle"
            aria-expanded={!collapsed}
            aria-controls={collapsed ? undefined : bodyId}
            onClick={toggle}
          >
            <span className="side-card-section-name">{title}</span>
            {collapsed && collapsedNote && <span className="side-card-section-note">{collapsedNote}</span>}
            <ChevronRight className="side-card-section-chevron" size={11} strokeWidth={2} aria-hidden="true" />
          </button>
        </h3>
        {!collapsed && action}
      </div>
      {!collapsed && <div id={bodyId} className="side-card-section-body">{children}</div>}
    </section>
  )
}
