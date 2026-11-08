import type { KeyboardEvent, Ref } from 'react'
import type { LucideIcon } from '../../lib/icons'

export interface PillTab<T extends string> {
  id: T
  label: string
  icon: LucideIcon
}

/**
 * The pill tab bar: icon tabs in one rounded container, the open one raised, as the sidebar's Projects ·
 * Threads · Chats. Its look and motion live with the
 * sidebar's (threads-sidebar.css, compact-shell.css, polish.css, sidebar-view-motion.css). Inside a `pill-tabs`
 * size container 240–319px wide, only the open tab shows its word, and the word widens into a newly opened tab.
 * Left and Right move between tabs (wrapping), Home and End to the ends; the tab moved to opens and takes focus.
 */
export function PillTabs<T extends string>({ tabs, value, onSelect, ariaLabel, idPrefix, tabsRef, className }: {
  tabs: readonly PillTab<T>[]
  value: T
  /** Opens a tab; may ask first (a promise), focus follows the keyboard either way. */
  onSelect: (id: T) => void | Promise<void>
  ariaLabel: string
  /** Tabs are `${idPrefix}-${id}-tab` and control `${idPrefix}-${id}-panel`. */
  idPrefix: string
  tabsRef?: Ref<HTMLDivElement>
  className?: string
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const index = tabs.findIndex((tab) => tab.id === value)
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    void onSelect(tabs[next].id)
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }

  return (
    <div ref={tabsRef} className={`threads-sidebar-tabs${className ? ` ${className}` : ''}`} role="tablist" aria-label={ariaLabel} onKeyDown={onKeyDown}>
      {tabs.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="tab"
          id={`${idPrefix}-${id}-tab`}
          tabIndex={value === id ? 0 : -1}
          aria-selected={value === id}
          aria-controls={`${idPrefix}-${id}-panel`}
          title={label}
          aria-label={label}
          className={`threads-sidebar-tab${value === id ? ' active' : ''}`}
          onClick={() => void onSelect(id)}
        >
          <Icon size={15} strokeWidth={1.8} aria-hidden="true" />
          <span className="threads-sidebar-tab-label">{label}</span>
        </button>
      ))}
    </div>
  )
}
