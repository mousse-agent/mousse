import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { formatBinding } from '../../shared/commands'
import { Search, X } from '../lib/icons'
import { currentContext, isCommandRegistered, useCommandBindings, useCommandOverlay, useCommandRegistry } from '../commands/commandRegistry'
import { chooseCommandPaletteItem, dismissPalette } from '../commands/paletteActions'
import {
  buildPaletteGroups,
  eligibleCommands,
  flattenGroups,
  paletteKeyAction,
  type PaletteItem
} from '../commands/paletteItems'
import { useComputers } from '../lib/computers'
import { useAppStore } from '../stores/appStore'
import '../styles/thread-search.css'

export interface PaletteListItem {
  key: string
  title: string
  detail?: string
  /** A formatted shortcut shown at the row's end. */
  shortcut?: string
}

export interface PaletteListGroup<T extends PaletteListItem = PaletteListItem> {
  label: string
  items: T[]
}

interface PaletteListProps<T extends PaletteListItem> {
  groups: readonly PaletteListGroup<T>[]
  /** Position of the highlighted row counting across all groups. */
  activeIndex: number
  /** Prefix of the row ids, so the input can point at the highlighted row. */
  listId: string
  emptyLabel: string
  onActivate: (index: number) => void
  onChoose: (item: T) => void
}

export const paletteOptionId = (listId: string, index: number): string => `${listId}-option-${index}`

/** Grouped rows with one highlighted by background. Takes plain groups so other pickers can reuse it. */
export function PaletteList<T extends PaletteListItem>({
  groups,
  activeIndex,
  listId,
  emptyLabel,
  onActivate,
  onChoose
}: PaletteListProps<T>) {
  let position = 0
  return (
    <div className="thread-search-results" id={listId} role="listbox" aria-label="Results">
      {groups.length === 0 && <div className="thread-search-empty">{emptyLabel}</div>}
      {groups.map((group) => (
        <div key={group.label} className="thread-search-group" role="group" aria-label={group.label}>
          <div className="thread-search-group-label" aria-hidden="true">{group.label}</div>
          {group.items.map((item) => {
            const index = position++
            const active = index === activeIndex
            return (
              <button
                key={item.key}
                id={paletteOptionId(listId, index)}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={active}
                className={`thread-search-result palette-result${active ? ' active' : ''}`}
                onMouseMove={() => { if (!active) onActivate(index) }}
                onClick={() => onChoose(item)}
              >
                <span className="palette-result-text">
                  <span className="thread-search-result-title">{item.title}</span>
                  {item.detail && <span className="thread-search-result-meta">{item.detail}</span>}
                </span>
                {item.shortcut && <kbd className="palette-result-shortcut">{item.shortcut}</kbd>}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

const LIST_ID = 'command-palette-list'

function PaletteDialog() {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const handlers = useCommandRegistry((state) => state.handlers)
  const threads = useAppStore((state) => state.threads)
  const projects = useAppStore((state) => state.projects)
  const activeThreadId = useAppStore((state) => state.activeThreadId)
  const turnStates = useAppStore((state) => state.turnStates)
  const mainAreaOpen = useAppStore((state) => state.mainAreaOpen)
  const sidebarMode = useAppStore((state) => state.sidebarMode)
  const platform = useAppStore((state) => state.appInfo?.platform) ?? ''
  const bindings = useCommandBindings()

  const commands = useMemo(
    () => eligibleCommands(currentContext('palette'), isCommandRegistered),
    // The context and the handlers' `enabled` read the store when called; these are what they depend on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [handlers, activeThreadId, turnStates, mainAreaOpen, sidebarMode]
  )
  // The names of the computers that rows are on; a window of one computer reads none.
  const { byNode: computers } = useComputers(threads.some((thread) => thread.node) || projects.some((project) => project.node))
  const groups = useMemo(() => {
    return buildPaletteGroups({ query, commands, threads, projects, computers }).map((group) => ({
      label: group.label,
      items: group.items.map((item) => {
        const binding = item.kind === 'command' ? bindings[item.id] : null
        return { ...item, shortcut: binding ? formatBinding(binding, platform) : undefined }
      })
    }))
  }, [query, commands, threads, projects, computers, bindings, platform])
  const rows = useMemo(() => flattenGroups(groups) as (PaletteItem & { shortcut?: string })[], [groups])
  const active = Math.min(activeIndex, Math.max(rows.length - 1, 0))

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    document.getElementById(paletteOptionId(LIST_ID, active))?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  // Escape closes from anywhere in the palette, and nothing else sees the key.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (paletteKeyAction(event, 0, 0)?.type !== 'close') return
      event.preventDefault()
      event.stopPropagation()
      dismissPalette()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const action = paletteKeyAction(event.nativeEvent, active, rows.length)
    if (!action) return
    event.preventDefault()
    if (action.type === 'move') setActiveIndex(action.index)
    else if (action.type === 'choose') chooseCommandPaletteItem(rows[active]!)
    else dismissPalette()
  }

  return (
    <div className="thread-search-overlay" onClick={() => dismissPalette()} role="presentation">
      <div
        className="thread-search-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className="thread-search-input-row">
          <Search size={16} strokeWidth={2} className="thread-search-icon" aria-hidden="true" />
          <input
            ref={inputRef}
            className="thread-search-input"
            value={query}
            placeholder="Search commands, threads, and projects…"
            role="combobox"
            aria-expanded="true"
            aria-controls={LIST_ID}
            aria-autocomplete="list"
            aria-activedescendant={rows.length > 0 ? paletteOptionId(LIST_ID, active) : undefined}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={onInputKeyDown}
          />
          <button type="button" className="thread-search-close" onClick={() => dismissPalette()} aria-label="Close">
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        <PaletteList
          groups={groups}
          activeIndex={active}
          listId={LIST_ID}
          emptyLabel="No results"
          onActivate={setActiveIndex}
          onChoose={chooseCommandPaletteItem}
        />

        <div className="thread-search-footer">
          <span className="thread-search-hint">
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span className="thread-search-hint">
            <kbd>↵</kbd> run or open
          </span>
          <span className="thread-search-hint">
            <kbd>&gt;</kbd> commands only
          </span>
          <span className="thread-search-hint">
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  )
}

/** The Ctrl/Cmd+K palette. Mounted once; its state lives in `appStore.paletteOpen`. */
export function CommandPalette() {
  const open = useAppStore((state) => state.paletteOpen)
  useCommandOverlay('palette', open)
  return open ? <PaletteDialog /> : null
}
