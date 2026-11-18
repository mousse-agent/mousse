import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { Project } from '../../../shared/types'
import type { BotLook } from '../../../shared/bots/personal/look'
import { Archive, Bot, Check, ChevronRight, EyeOff, Folder, X } from '../../lib/icons'
import { FloatingPortal, useFloatingPosition } from '../../lib/floatingLayer'
import { focusInitialMenuItem, menuItems, nextMenuIndex, useMenuKeyboard } from '../../hooks/useMenuKeyboard'
import { filterSuggestions, orderOptions, SHOW_LABELS, type FilterOption, type FilterSuggestion, type ThreadShow } from '../../lib/threadFilter'
import { useThreadFilterStore } from '../../stores/threadFilterStore'
import { useBotsStore } from '../../stores/botsStore'
import { ProjectIcon } from '../ProjectIcon'
import { BotFace } from '../bots/face/BotFace'
import '../../styles/thread-filter.css'

export interface ProjectOption extends FilterOption {
  project: Project
  /** The project's hue (`projectHueColor`), for its folder when it has no icon of its own. */
  color?: string
}

export interface BotOption extends FilterOption {
  look: BotLook
}

/** Three lines, shorter each: the filter button's glyph. */
function FilterLines() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M4 7h16M7 12h10M10 17h4" />
    </svg>
  )
}

export function ProjectMark({ option, size = 14 }: { option: ProjectOption; size?: number }) {
  return (
    <span className="thread-filter-mark" style={option.color ? { color: option.color } : undefined}>
      <ProjectIcon project={option.project} size={size} fallback={<Folder size={size} strokeWidth={1.8} aria-hidden="true" />} />
    </span>
  )
}

/** A bot's real face, drawn once and still (a saved picture of it when there is one). */
export function BotMark({ option }: { option: BotOption }) {
  return <span className="thread-filter-mark thread-filter-face"><BotFace look={option.look} state="idle" size={16} view="head" still /></span>
}

const SHOWS: readonly ThreadShow[] = ['mine', 'bots', 'all']

/**
 * The Threads sidebar's filter row, under its tabs: a "Search threads…" field and a filter button, with the active
 * filters as chips below them (`lib/threadFilter.ts`, `threadFilterStore`).
 *
 * - Typing narrows the list by title, project and bot, and suggests the matching projects and bots above it; picking
 *   one (click, or Enter on the highlighted one) makes it a filter.
 * - The button opens a short menu: Show, "Project ›" and "Bot ›" (each a small searchable list beside it), and Archived.
 *   In the Projects tab the menu lists the projects instead, ticked; unticking one leaves it out of the tree.
 */
export function ThreadFilterBar({ view, projects, bots }: { view: 'projects' | 'threads'; projects: readonly ProjectOption[]; bots: readonly BotOption[] }) {
  const filter = useThreadFilterStore()
  const fieldId = useId()
  const [menuOpen, setMenuOpen] = useState(false)
  const [active, setActive] = useState(0)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const fieldRef = useRef<HTMLInputElement>(null)

  // The bots are read once something here needs them.
  const needBots = menuOpen || filter.query.trim() !== '' || filter.botId !== null
  useEffect(() => {
    if (needBots && !useBotsStore.getState().loaded) void useBotsStore.getState().refresh()
  }, [needBots])

  const suggestions = useMemo(() => filterSuggestions(filter.query, filter, projects, bots), [filter, projects, bots])
  useEffect(() => setActive(0), [filter.query])
  const projectOption = projects.find((option) => option.id === filter.projectId)
  const botOption = bots.find((option) => option.id === filter.botId)

  const pick = (suggestion: FilterSuggestion) => {
    if (suggestion.kind === 'project') filter.setProject(suggestion.id)
    else filter.setBot(suggestion.id)
    filter.setQuery('')
    fieldRef.current?.focus()
  }

  const onFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!suggestions.length) return
      event.preventDefault()
      setActive((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length)
    } else if (event.key === 'Enter' && suggestions[active]) {
      event.preventDefault()
      pick(suggestions[active])
    } else if (event.key === 'Escape' && filter.query) {
      event.preventDefault()
      event.stopPropagation()
      filter.setQuery('')
    }
  }

  const hiddenCount = view === 'projects' ? filter.hiddenProjects.filter((id) => projects.some((option) => option.id === id)).length : 0
  const chips: { key: string; icon: ReactNode; label: string; title: string; clear(): void }[] = [
    ...(filter.botId !== null ? [{
      key: 'bot', icon: botOption ? <BotMark option={botOption} /> : <Bot size={13} aria-hidden="true" />,
      label: botOption?.name ?? 'Bot', title: 'Bot', clear: () => filter.setBot(null)
    }] : []),
    ...(filter.projectId !== null ? [{
      key: 'project', icon: projectOption ? <ProjectMark option={projectOption} size={13} /> : <Folder size={13} aria-hidden="true" />,
      label: projectOption?.name ?? 'Project', title: 'Project', clear: () => filter.setProject(null)
    }] : []),
    ...(filter.show !== 'mine' && filter.botId === null ? [{
      key: 'show', icon: <Bot size={13} aria-hidden="true" />, label: filter.show === 'all' ? 'All threads' : SHOW_LABELS[filter.show], title: 'Show', clear: () => filter.setShow('mine')
    }] : []),
    ...(filter.archived ? [{ key: 'archived', icon: <Archive size={13} aria-hidden="true" />, label: 'Archived', title: 'Archived', clear: () => filter.setArchived(false) }] : []),
    ...(hiddenCount > 0 ? [{
      key: 'hidden', icon: <EyeOff size={13} aria-hidden="true" />, label: `${hiddenCount} hidden`, title: 'Hidden projects', clear: filter.clearHiddenProjects
    }] : [])
  ]
  const menuSet = filter.show !== 'mine' || filter.archived || filter.projectId !== null || filter.botId !== null || hiddenCount > 0

  return (
    <div className="thread-filter">
      <div className="thread-filter-row">
        <input
          ref={fieldRef}
          id={fieldId}
          className="thread-filter-field"
          type="text"
          placeholder="Search threads…"
          aria-label="Search threads"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={suggestions.length > 0}
          aria-controls={suggestions.length ? `${fieldId}-suggestions` : undefined}
          aria-activedescendant={suggestions.length ? `${fieldId}-suggestion-${active}` : undefined}
          spellCheck={false}
          autoComplete="off"
          value={filter.query}
          onChange={(event) => filter.setQuery(event.target.value)}
          onKeyDown={onFieldKeyDown}
        />
        <button
          ref={buttonRef}
          type="button"
          className={`thread-filter-button${menuSet ? ' set' : ''}`}
          aria-label="Filter threads"
          title="Filter"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <FilterLines />
        </button>
      </div>

      {suggestions.length > 0 && (
        <div className="thread-filter-suggestions" id={`${fieldId}-suggestions`} role="listbox" aria-label="Filter by">
          {suggestions.map((suggestion, index) => {
            const project = suggestion.kind === 'project' ? projects.find((option) => option.id === suggestion.id) : undefined
            const bot = suggestion.kind === 'bot' ? bots.find((option) => option.id === suggestion.id) : undefined
            return (
              <div
                key={`${suggestion.kind}:${suggestion.id}`}
                id={`${fieldId}-suggestion-${index}`}
                className={`thread-filter-suggestion${index === active ? ' active' : ''}`}
                role="option"
                aria-selected={index === active}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(suggestion)}
              >
                {project ? <ProjectMark option={project} /> : bot ? <BotMark option={bot} /> : null}
                <span className="thread-filter-suggestion-kind">{suggestion.kind === 'project' ? 'Project:' : 'Bot:'}</span>
                <span className="thread-filter-suggestion-name">{suggestion.name}</span>
                {index === active && <span className="thread-filter-suggestion-enter" aria-hidden="true">↵</span>}
              </div>
            )
          })}
        </div>
      )}

      {chips.length > 0 && (
        <div className="thread-filter-chips" role="list" aria-label="Filters">
          {chips.map((chip) => (
            <span key={chip.key} className="thread-filter-chip" role="listitem" title={chip.title}>
              {chip.icon}
              <span className="thread-filter-chip-label">{chip.label}</span>
              <button type="button" className="thread-filter-chip-clear" aria-label={`Clear ${chip.title.toLowerCase()} filter: ${chip.label}`} onClick={() => { chip.clear(); fieldRef.current?.focus() }}>
                <X size={11} strokeWidth={2.2} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}

      {menuOpen && (
        <FilterMenu
          view={view}
          anchorRef={buttonRef}
          projects={projects}
          bots={bots}
          projectOption={projectOption}
          botOption={botOption}
          onClose={(refocus) => {
            setMenuOpen(false)
            if (refocus) buttonRef.current?.focus()
          }}
        />
      )}
    </div>
  )
}

function FilterMenu({ view, anchorRef, projects, bots, projectOption, botOption, onClose }: {
  view: 'projects' | 'threads'
  anchorRef: React.RefObject<HTMLButtonElement | null>
  projects: readonly ProjectOption[]
  bots: readonly BotOption[]
  projectOption?: ProjectOption
  botOption?: BotOption
  onClose(refocus: boolean): void
}) {
  const filter = useThreadFilterStore()
  const menuRef = useRef<HTMLDivElement>(null)
  const [sub, setSub] = useState<'project' | 'bot' | null>(null)
  const style = useFloatingPosition({ open: true, anchorRef, contentRef: menuRef, placement: 'below-end', gap: 6, deps: [view, projects.length] })
  const onMenuKeyDown = useMenuKeyboard(menuRef, () => onClose(true))

  // The menu is placed (and made visible) by useFloatingPosition after it mounts; a hidden item cannot take focus, so wait a frame.
  useEffect(() => {
    const frame = requestAnimationFrame(() => focusInitialMenuItem(menuRef.current))
    return () => cancelAnimationFrame(frame)
  }, [])
  useEffect(() => {
    const away = (event: MouseEvent) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return
      onClose(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [anchorRef, onClose])

  const hidden = new Set(filter.hiddenProjects)
  const closeSub = () => {
    setSub(null)
    menuRef.current?.querySelector<HTMLElement>('[aria-expanded="true"][data-sub]')?.focus()
  }
  const subTrigger = (kind: 'project' | 'bot', label: string, value: string) => (
    <div className="threads-context-submenu-anchor" role="none">
      <button
        type="button"
        role="menuitem"
        data-sub={kind}
        className="threads-context-menu-item thread-filter-menu-item"
        aria-haspopup="menu"
        aria-expanded={sub === kind}
        onClick={() => setSub(sub === kind ? null : kind)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault()
            setSub(kind)
          } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') setSub(null)
        }}
      >
        <span className="thread-filter-check" aria-hidden="true" />
        <span>{label}</span>
        <span className="thread-filter-menu-value">{value}</span>
        <ChevronRight className="threads-context-submenu-chevron" aria-hidden="true" />
      </button>
      {sub === kind && (
        <FilterSubList
          label={label}
          anyLabel={kind === 'project' ? 'All projects' : 'Any bot'}
          options={kind === 'project' ? projects : bots}
          selected={kind === 'project' ? filter.projectId : filter.botId}
          mark={(option) => (kind === 'project' ? <ProjectMark option={option as ProjectOption} /> : <BotMark option={option as BotOption} />)}
          onPick={(id) => {
            if (kind === 'project') filter.setProject(id)
            else filter.setBot(id)
            onClose(true)
          }}
          onBack={closeSub}
        />
      )}
    </div>
  )

  return (
    <FloatingPortal>
      <div
        ref={menuRef}
        className="threads-context-menu thread-filter-menu"
        role="menu"
        aria-label="Filter threads"
        style={style}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onClose(true)
            return
          }
          onMenuKeyDown(event)
        }}
      >
        <div className="thread-filter-menu-label" role="presentation">Show</div>
        {SHOWS.map((show) => (
          <button
            key={show}
            type="button"
            role="menuitemradio"
            aria-checked={filter.show === show}
            className="threads-context-menu-item thread-filter-menu-item"
            disabled={filter.botId !== null}
            title={filter.botId !== null ? 'A bot is chosen: its threads show' : undefined}
            onClick={() => filter.setShow(show)}
          >
            <span className="thread-filter-check" aria-hidden="true">{filter.show === show && <Check size={14} strokeWidth={2.2} />}</span>
            <span>{SHOW_LABELS[show]}</span>
          </button>
        ))}
        <div className="threads-context-menu-separator thread-filter-menu-separator" role="separator" />
        {view === 'projects' ? (
          <>
            <div className="thread-filter-menu-label" role="presentation">Projects</div>
            <div className="thread-filter-menu-projects">
              {projects.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={!hidden.has(option.id)}
                  className="threads-context-menu-item thread-filter-menu-item"
                  onClick={() => filter.setProjectHidden(option.id, !hidden.has(option.id))}
                >
                  <span className="thread-filter-check" aria-hidden="true">{!hidden.has(option.id) && <Check size={14} strokeWidth={2.2} />}</span>
                  <ProjectMark option={option} />
                  <span className="thread-filter-option-name">{option.name}</span>
                </button>
              ))}
            </div>
          </>
        ) : subTrigger('project', 'Project', projectOption?.name ?? 'All')}
        {subTrigger('bot', 'Bot', botOption?.name ?? 'Any')}
        <div className="threads-context-menu-separator thread-filter-menu-separator" role="separator" />
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={filter.archived}
          className="threads-context-menu-item thread-filter-menu-item"
          onClick={() => filter.setArchived(!filter.archived)}
        >
          <span className="thread-filter-check" aria-hidden="true">{filter.archived && <Check size={14} strokeWidth={2.2} />}</span>
          <span>Archived</span>
        </button>
      </div>
    </FloatingPortal>
  )
}

/**
 * "Project ›" and "Bot ›": a search line, then "Recent" (the few used last) and the rest by name; it scrolls. Arrows
 * move from the search line into the list and back; Escape or the left arrow go back to the menu.
 */
function FilterSubList({ label, anyLabel, options, selected, mark, onPick, onBack }: {
  label: string
  anyLabel: string
  options: readonly FilterOption[]
  selected: string | null
  mark(option: FilterOption): ReactNode
  onPick(id: string | null): void
  onBack(): void
}) {
  const [search, setSearch] = useState('')
  const [flip, setFlip] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const { recent, rest } = useMemo(() => orderOptions(options, search), [options, search])

  useLayoutEffect(() => {
    const list = listRef.current
    if (list) setFlip(list.getBoundingClientRect().right > window.innerWidth - 8)
    inputRef.current?.focus()
  }, [])

  const item = (option: FilterOption) => (
    <button
      key={option.id}
      type="button"
      role="menuitemradio"
      aria-checked={selected === option.id}
      className="threads-context-menu-item thread-filter-menu-item"
      onClick={() => onPick(option.id)}
    >
      <span className="thread-filter-check" aria-hidden="true">{selected === option.id && <Check size={14} strokeWidth={2.2} />}</span>
      {mark(option)}
      <span className="thread-filter-option-name">{option.name}</span>
    </button>
  )

  return (
    <div
      ref={listRef}
      className={`threads-context-menu threads-context-submenu thread-filter-sublist${flip ? ' flip' : ''}`}
      role="menu"
      aria-label={label}
      data-submenu=""
      onKeyDown={(event) => {
        event.stopPropagation()
        const fromInput = event.target === inputRef.current
        if (event.key === 'Escape' || (event.key === 'ArrowLeft' && !fromInput)) {
          event.preventDefault()
          onBack()
          return
        }
        const items = menuItems(listRef.current)
        if (fromInput) {
          if (event.key === 'ArrowDown' && items.length) {
            event.preventDefault()
            items[0].focus()
          } else if (event.key === 'Enter' && search.trim() && items[1]) {
            // The first match, past "All projects" / "Any bot".
            event.preventDefault()
            items[1].click()
          }
          return
        }
        const index = items.indexOf(document.activeElement as HTMLElement)
        if (event.key === 'ArrowUp' && index === 0) {
          event.preventDefault()
          inputRef.current?.focus()
          return
        }
        const next = nextMenuIndex(event.key, index, items.length)
        if (next !== undefined) {
          event.preventDefault()
          items[next]?.focus()
        }
      }}
    >
      <input
        ref={inputRef}
        className="thread-filter-sublist-search"
        type="text"
        placeholder={`Search ${label === 'Project' ? 'projects' : 'bots'}…`}
        aria-label={`Search ${label === 'Project' ? 'projects' : 'bots'}`}
        spellCheck={false}
        autoComplete="off"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className="thread-filter-sublist-items">
        <button
          type="button"
          role="menuitemradio"
          aria-checked={selected === null}
          className="threads-context-menu-item thread-filter-menu-item"
          onClick={() => onPick(null)}
        >
          <span className="thread-filter-check" aria-hidden="true">{selected === null && <Check size={14} strokeWidth={2.2} />}</span>
          <span>{anyLabel}</span>
        </button>
        {recent.length > 0 && <div className="thread-filter-menu-label" role="presentation">Recent</div>}
        {recent.map(item)}
        {recent.length > 0 && rest.length > 0 && <div className="threads-context-menu-separator thread-filter-menu-separator" role="separator" />}
        {rest.map(item)}
        {!recent.length && !rest.length && <div className="thread-filter-sublist-empty">No matches</div>}
      </div>
    </div>
  )
}
