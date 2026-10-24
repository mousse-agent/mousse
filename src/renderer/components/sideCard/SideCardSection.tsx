import type { ReactNode } from 'react'

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
  children: ReactNode
}

/** Shared spacing and heading for one block of the thread side card. */
export function SideCardSection({ title, threadId, children }: SideCardSectionProps) {
  return (
    <section className="side-card-section" data-thread-id={threadId ?? undefined}>
      <h3 className="side-card-section-title">{title}</h3>
      {children}
    </section>
  )
}
