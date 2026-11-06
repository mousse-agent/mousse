import { useEffect, useLayoutEffect, useRef, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { X } from '../../lib/icons'
import '../../styles/tab-bar.css'

// Ids are file paths, so they are matched by value rather than in a selector.
function tabElement(strip: HTMLElement | null, id: string): HTMLElement | undefined {
  return [...(strip?.querySelectorAll<HTMLElement>('[data-tab-id]') ?? [])].find((element) => element.dataset.tabId === id)
}

function focusTab(strip: HTMLElement | null, id: string): void {
  tabElement(strip, id)?.querySelector<HTMLButtonElement>('[role="tab"]')?.focus()
}

export interface TabItem {
  id: string
  /** What the tab shows; `name` is used when omitted. */
  label?: ReactNode
  /** Plain name, read in the close button's label. */
  name: string
  title?: string
  icon?: ReactNode
}

/**
 * A strip of closable tabs. Each tab is a select button with a sibling close button; the selected tab has a filled
 * background. Arrow keys, Home and End move between tabs and select them, Delete closes the focused one. When a tab
 * with focus in it closes, focus moves to the tab selected next, or to the strip when none is left. `onClose` may
 * refuse (a file with unsaved edits) by resolving `false`: the tab stays and so does focus.
 */
export function TabBar({ label, tabs, activeId, onSelect, onClose, onDragStart, className }: {
  label: string
  tabs: TabItem[]
  activeId: string | null
  onSelect: (id: string) => void
  /** Resolve `false` when the tab stays open. */
  onClose: (id: string) => void | boolean | Promise<boolean | void>
  onDragStart?: (id: string, event: DragEvent<HTMLButtonElement>) => void
  className?: string
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const closing = useRef<string | null>(null)

  const requestClose = (id: string) => {
    closing.current = tabElement(listRef.current, id)?.contains(document.activeElement) ? id : null
    void Promise.resolve(onClose(id)).then((closed) => {
      // A refused close leaves the tab open; forget it so a later change does not move focus.
      if (closed === false && closing.current === id) closing.current = null
    }, () => {
      if (closing.current === id) closing.current = null
    })
  }

  useLayoutEffect(() => {
    const id = closing.current
    if (!id || tabs.some((tab) => tab.id === id)) return
    closing.current = null
    if (activeId && tabs.some((tab) => tab.id === activeId)) focusTab(listRef.current, activeId)
    else listRef.current?.focus()
  }, [activeId, tabs])

  // Keep the selected tab in view by scrolling the strip only; scrollIntoView would also move clipped ancestors.
  useEffect(() => {
    const strip = listRef.current
    const tab = activeId ? tabElement(strip, activeId) : undefined
    if (!strip || !tab) return
    const outer = strip.getBoundingClientRect()
    const inner = tab.getBoundingClientRect()
    if (inner.left < outer.left) strip.scrollLeft -= outer.left - inner.left
    else if (inner.right > outer.right) strip.scrollLeft += inner.right - outer.right
  }, [activeId])

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = tabs.length - 1
    const target = event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : null
    if (target !== null) {
      event.preventDefault()
      const id = tabs[target].id
      onSelect(id)
      focusTab(listRef.current, id)
    } else if (event.key === 'Delete') {
      event.preventDefault()
      requestClose(tabs[index].id)
    }
  }

  // The selected tab takes the strip's one tab stop; with none selected, the first tab does.
  const tabStop = tabs.some((tab) => tab.id === activeId) ? activeId : tabs[0]?.id
  return (
    <div ref={listRef} className={`ui-tabs${className ? ` ${className}` : ''}`} role="tablist" aria-label={label} tabIndex={-1}>
      {tabs.map((tab, index) => {
        const active = tab.id === activeId
        return <div key={tab.id} className={`ui-tab${active ? ' active' : ''}`} data-tab-id={tab.id} role="presentation">
          <button
            type="button"
            role="tab"
            className="ui-tab-select"
            aria-selected={active}
            tabIndex={tab.id === tabStop ? 0 : -1}
            title={tab.title ?? tab.name}
            draggable={Boolean(onDragStart)}
            onDragStart={onDragStart ? (event) => onDragStart(tab.id, event) : undefined}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {tab.icon}
            <span className="ui-tab-label">{tab.label ?? tab.name}</span>
          </button>
          <button
            type="button"
            className="ui-tab-close"
            tabIndex={-1}
            aria-label={`Close ${tab.name}`}
            title="Close (Delete)"
            onClick={() => requestClose(tab.id)}
          >
            <X size={12} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      })}
    </div>
  )
}
