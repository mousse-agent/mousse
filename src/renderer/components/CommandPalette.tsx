import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { formatBinding } from '../../shared/commands'
import type { ThreadSearchResult, ThreadSearchSkipped } from '../../shared/types'
import { Search, X } from '../lib/icons'
import { currentContext, isCommandRegistered, useCommandBindings, useCommandOverlay, useCommandRegistry } from '../commands/commandRegistry'
import { chooseCommandPaletteItem, dismissPalette } from '../commands/paletteActions'
import {
  buildPaletteGroups,
  categoryLabels,
  eligibleCommands,
  markMatches,
  messageQuery,
  paletteKeyAction,
  type PaletteItem
} from '../commands/paletteItems'
import { useComputers } from '../lib/computers'
import { readableError } from '../lib/errorText'
import { skippedLine, THREAD_SEARCH_DEBOUNCE_MS } from '../lib/threadSearchSkipped'
import { useAppStore } from '../stores/appStore'
import '../styles/thread-search.css'

export interface PaletteListItem {
  key: string
  title: string
  /** A second line under the title (a thread's project and computer). */
  detail?: string
  /** Muted text at the row's end, before the shortcut (a command's category). */
  trailing?: string
  /** A formatted shortcut shown at the row's end. */
  shortcut?: string
  /** `snippet`: an indented single line with `match` marked; `more`: an indented "+N more" line. */
  variant?: 'snippet' | 'more'
  match?: string
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
  /** Shown when there are no rows; nothing is shown when empty. */
  emptyLabel: string
  onActivate: (index: number) => void
  onChoose: (item: T) => void
}

export const paletteOptionId = (listId: string, index: number): string => `${listId}-option-${index}`

function Marked({ text, match }: { text: string; match?: string }) {
  if (!match) return <>{text}</>
  return (
    <>
      {markMatches(text, match).map((run, index) =>
        run.match ? <strong key={index} className="palette-match">{run.text}</strong> : run.text
      )}
    </>
  )
}

/**
 * The height that shows whole rows only: the bottom of the lowest row that fits in `available`, or
 * undefined when every row fits (or not even the first does). `bottoms` are the rows' bottom edges
 * from the top of the list, in order.
 */
export function wholeRowsHeight(bottoms: readonly number[], available: number): number | undefined {
  if (bottoms.length === 0 || bottoms[bottoms.length - 1]! <= available) return undefined
  let fit: number | undefined
  for (const bottom of bottoms) {
    if (bottom > available) break
    fit = bottom
  }
  return fit
}

/** Caps a scrolling list at its last whole row, so the row at the bottom edge is never cut to a sliver. */
function fitWholeRows(list: HTMLElement): void {
  list.style.maxHeight = ''
  const bottoms = [...list.querySelectorAll<HTMLElement>('[role="option"]')].map((row) => row.offsetTop + row.offsetHeight)
  const height = wholeRowsHeight(bottoms, list.clientHeight)
  if (height !== undefined) list.style.maxHeight = `${height}px`
}

/** Grouped rows with one highlighted by background. Takes plain groups so other pickers can reuse it. */
export function PaletteList<T extends PaletteListItem>({
  groups,
  activeIndex,
  listId,
  emptyLabel,
  onActivate,
  onChoose
}: PaletteListProps<T>) {
  const listRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    fitWholeRows(list)
    const refit = () => fitWholeRows(list)
    window.addEventListener('resize', refit)
    return () => window.removeEventListener('resize', refit)
  }, [groups])
  let position = 0
  return (
    <div ref={listRef} className="thread-search-results" id={listId} role="listbox" aria-label="Results">
      {groups.length === 0 && emptyLabel && <div className="thread-search-empty">{emptyLabel}</div>}
      {groups.map((group) => (
        <div key={group.label} className="thread-search-group" role="group" aria-label={group.label}>
          <div className="thread-search-group-label" aria-hidden="true">{group.label}</div>
          {group.items.map((item) => {
            const index = position++
            const active = index === activeIndex
            const variant = item.variant ? ` palette-result--${item.variant}` : ''
            return (
              <button
                key={item.key}
                id={paletteOptionId(listId, index)}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={active}
                className={`thread-search-result palette-result${variant}${active ? ' active' : ''}`}
                onMouseMove={() => { if (!active) onActivate(index) }}
                onClick={() => onChoose(item)}
              >
                {item.variant ? (
                  <span className="palette-result-snippet">
                    <Marked text={item.title} match={item.match} />
                  </span>
                ) : (
                  <span className="palette-result-text">
                    <span className="thread-search-result-title">{item.title}</span>
                    {item.detail && <span className="thread-search-result-meta">{item.detail}</span>}
                  </span>
                )}
                {(item.trailing || item.shortcut) && (
                  <span className="palette-result-end">
                    {item.trailing && <span className="palette-result-category">{item.trailing}</span>}
                    {item.shortcut && <kbd className="palette-result-shortcut">{item.shortcut}</kbd>}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

const LIST_ID = 'command-palette-list'
/** How many hits one message search asks for, across every thread. */
const MESSAGE_SEARCH_LIMIT = 40

type PaletteRow = PaletteListItem & { item: PaletteItem }

interface MessageSearch {
  results: ThreadSearchResult[]
  skipped?: ThreadSearchSkipped[]
}

/** The line a failed message search shows in the palette. */
export function searchFailureLine(error: unknown): string {
  return `Could not search · ${readableError(error, 'Try again.')}`
}

/**
 * Searches message text for `text` after typing pauses. The previous answer stays until the next one
 * arrives, so the list never blanks while a search runs; a null `text` clears it at once. A failed
 * search drops the old hits and says why in `error`.
 */
function useMessageSearch(text: string | null): { found: MessageSearch | null; pending: boolean; error: string } {
  const [found, setFound] = useState<MessageSearch | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!text) {
      setFound(null)
      setPending(false)
      setError('')
      return
    }
    // A newer query replaces this one: its answer is dropped, and the daemon ends the calls it made to other computers.
    let current = true
    setPending(true)
    const timer = setTimeout(() => {
      window.mousse.threads.search(text, MESSAGE_SEARCH_LIMIT).then(
        (answer) => {
          if (!current) return
          setFound({ results: answer.results, skipped: answer.skipped })
          setError('')
          setPending(false)
        },
        (failure: unknown) => {
          if (!current) return
          setFound(null)
          setError(searchFailureLine(failure))
          setPending(false)
        }
      )
    }, THREAD_SEARCH_DEBOUNCE_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [text])
  return { found, pending, error }
}

function PaletteDialog() {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const inputRef = useRef<HTMLInputElement>(null)
  const handlers = useCommandRegistry((state) => state.handlers)
  const threads = useAppStore((state) => state.threads)
  const projects = useAppStore((state) => state.projects)
  const activeThreadId = useAppStore((state) => state.activeThreadId)
  const turnStates = useAppStore((state) => state.turnStates)
  const mainAreaOpen = useAppStore((state) => state.mainAreaOpen)
  const sidebarMode = useAppStore((state) => state.sidebarMode)
  const mode = useAppStore((state) => state.paletteMode)
  const platform = useAppStore((state) => state.appInfo?.platform) ?? ''
  const bindings = useCommandBindings()
  const { found, pending, error: searchError } = useMessageSearch(messageQuery(query))

  const commands = useMemo(
    () => eligibleCommands(currentContext('palette'), isCommandRegistered),
    // The context and the handlers' `enabled` read the store when called; these are what they depend on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [handlers, activeThreadId, turnStates, mainAreaOpen, sidebarMode]
  )
  // The names of the computers that rows are on; a window of one computer reads none.
  const { byNode: computers } = useComputers(threads.some((thread) => thread.node) || projects.some((project) => project.node))
  const groups = useMemo(() => {
    const toRow = (item: PaletteItem): PaletteRow => {
      const row = { key: item.key, title: item.title, item }
      switch (item.kind) {
        case 'command': {
          const binding = bindings[item.id]
          return { ...row, shortcut: binding ? formatBinding(binding, platform) : undefined }
        }
        case 'message':
          return { ...row, variant: 'snippet', match: item.match }
        case 'more':
          return { ...row, variant: 'more' }
        default:
          return { ...row, detail: item.detail }
      }
    }
    const messages = found?.results
    const messagesCapped = (messages?.length ?? 0) >= MESSAGE_SEARCH_LIMIT
    return buildPaletteGroups({ query, commands, threads, projects, computers, messages, expanded, messagesCapped, mode }).map((group) => {
      const categories = categoryLabels(group.items)
      return {
        label: group.label,
        items: group.items.map((item, index) => ({ ...toRow(item), trailing: categories[index] }))
      }
    })
  }, [query, commands, threads, projects, computers, found, expanded, mode, bindings, platform])
  const rows = useMemo(() => groups.flatMap((group) => group.items), [groups])
  const active = Math.min(activeIndex, Math.max(rows.length - 1, 0))
  const skipped = messageQuery(query) ? skippedLine(found?.skipped) : ''

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

  // "+N more" shows the rest of that thread's hits in place; every other row closes the palette.
  const choose = (row: PaletteRow) => {
    const { item } = row
    if (item.kind === 'more') setExpanded((current) => new Set(current).add(item.threadId))
    else chooseCommandPaletteItem(item)
  }

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const action = paletteKeyAction(event.nativeEvent, active, rows.length)
    if (!action) return
    event.preventDefault()
    if (action.type === 'move') setActiveIndex(action.index)
    else if (action.type === 'choose') choose(rows[active]!)
    else dismissPalette()
  }

  return (
    <div className="thread-search-overlay" onClick={() => dismissPalette()} role="presentation">
      <div
        className="thread-search-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'messages' ? 'Search threads' : 'Command palette'}
      >
        <div className="thread-search-input-row">
          <Search size={16} strokeWidth={2} className="thread-search-icon" aria-hidden="true" />
          <input
            ref={inputRef}
            className="thread-search-input"
            value={query}
            placeholder={mode === 'messages' ? 'Search threads and messages…' : 'Search commands, threads, and messages…'}
            role="combobox"
            aria-expanded="true"
            aria-controls={LIST_ID}
            aria-autocomplete="list"
            aria-busy={pending}
            aria-activedescendant={rows.length > 0 ? paletteOptionId(LIST_ID, active) : undefined}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveIndex(0)
              setExpanded(new Set())
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
          // While message text is still being searched, an empty list is not yet "No results"; after a failed search the failure line says why.
          emptyLabel={pending || searchError ? '' : 'No results'}
          onActivate={setActiveIndex}
          onChoose={choose}
        />

        {searchError && <div className="thread-search-skipped" role="alert">{searchError}</div>}
        {!searchError && skipped && <div className="thread-search-skipped">{skipped}</div>}

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

/**
 * The Ctrl/Cmd+K palette, which is also thread and message search (Ctrl/Cmd+Shift+O opens it with
 * message hits first). Mounted once; its state lives in `appStore.paletteOpen` and `paletteMode`.
 */
export function CommandPalette() {
  const open = useAppStore((state) => state.paletteOpen)
  useCommandOverlay('palette', open)
  return open ? <PaletteDialog /> : null
}
