import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { FolderPlus, Laptop, Monitor, Search, Star, X } from '../lib/icons'
import { useCommandOverlay } from '../commands/commandRegistry'
import { useAppStore } from '../stores/appStore'
import { useComputers, UNKNOWN_COMPUTER_NAME } from '../lib/computers'
import { groupProjects } from '../lib/projectGroups'
import { projectHueColor, projectHues } from '../lib/projectHues'
import { projectInitials } from '../lib/projectInitials'
import { useThreadProjectColors } from '../lib/threadProjectColorsSetting'
import { lastUsedBy } from '../lib/threadFilter'
import { runWithToast } from '../lib/actionToast'
import { addProjectAndStartThread, createAndSelectNoProjectThread, createAndSelectProjectThread } from '../lib/threadActions'
import { botDayLabel } from './bots/messageGroups'
import { ProjectIcon } from './ProjectIcon'
import { Select, type SelectOption } from './ui/Select'
import { gridMove, initialIndex, pickerSections, shortPath, type GridDirection, type PickerCard } from './newThreadPickerLogic'
import './newThreadPicker.css'

/** Cards per row; the stylesheet lays the grid out in as many columns. */
const COLUMNS = 3
const ALL_COMPUTERS = 'all'
const THIS_COMPUTER = 'self'

const ARROWS: Record<string, GridDirection> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }

/**
 * The title bar's New thread: a grid of the projects of every computer, starred ones first, then by last use. Enter or a
 * click starts a thread in the highlighted project; the project last picked starts highlighted, so ✎ then Enter is the
 * old one-step new thread. A star is the project's pin, the same one the sidebar shows.
 */
export function NewThreadPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  useCommandOverlay('palette', open)
  return open ? <PickerDialog onClose={onClose} /> : null
}

function PickerDialog({ onClose }: { onClose: () => void }) {
  const projects = useAppStore((state) => state.projects)
  const threads = useAppStore((state) => state.threads)
  const platform = useAppStore((state) => state.appInfo?.platform) ?? ''
  const projectColors = useThreadProjectColors()
  const { byNode } = useComputers(projects.some((project) => project.node))
  const [query, setQuery] = useState('')
  const [computer, setComputer] = useState(ALL_COMPUTERS)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  const lastUsed = useMemo(() => lastUsedBy(threads, (thread) => thread.projectId), [threads])
  const computerName = (node: string) => byNode[node]?.name ?? UNKNOWN_COMPUTER_NAME
  const shown = useMemo(
    () => projects.filter((project) => computer === ALL_COMPUTERS || (computer === THIS_COMPUTER ? !project.node : project.node === computer)),
    [projects, computer]
  )
  // eslint-disable-next-line react-hooks/exhaustive-deps -- computerName reads byNode
  const sections = useMemo(() => pickerSections(shown, lastUsed, computerName, query), [shown, lastUsed, byNode, query])
  const cards = useMemo(() => [...sections.starred, ...sections.recent], [sections])

  // The highlight follows a project, not a place, so starring one keeps it highlighted as it moves up.
  const [activeId, setActiveId] = useState<string | null>(() => {
    const first = pickerSections(projects, lastUsed, computerName, '')
    const all = [...first.starred, ...first.recent]
    return all[initialIndex(all, useAppStore.getState().lastNewThreadProjectId)]?.project.id ?? null
  })
  const found = cards.findIndex((card) => card.project.id === activeId)
  const active = found >= 0 ? found : 0
  const activeCard = cards[active]

  // The hue of each project's group, as the Threads tab colours its rows; none with project colours off.
  const hueOf = useMemo(() => {
    if (projectColors === 'off') return new Map<string, number>()
    const { groups, groupOf } = groupProjects(projects)
    const byGroup = projectHues(groups.map((group) => ({ id: group.id, createdAt: group.project.createdAt })))
    return new Map(projects.map((project) => [project.id, byGroup.get(groupOf.get(project.id) ?? project.id) ?? 0]))
  }, [projects, projectColors])

  // The computer menu shows only when projects are on more than one computer.
  const computerOptions = useMemo((): SelectOption[] => {
    const nodes = [...new Set(projects.flatMap((project) => (project.node ? [project.node] : [])))]
    if (nodes.length === 0) return []
    return [
      { value: ALL_COMPUTERS, label: 'All computers' },
      ...(projects.some((project) => !project.node) ? [{ value: THIS_COMPUTER, label: 'This computer' }] : []),
      ...nodes.map((node) => ({ value: node, label: byNode[node]?.name ?? UNKNOWN_COMPUTER_NAME }))
    ]
  }, [projects, byNode])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (activeCard) document.getElementById(`${listId}-${activeCard.project.id}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeCard, listId])

  const start = (card: PickerCard) => {
    if (card.unavailable) return
    onClose()
    void runWithToast('start a thread', () => createAndSelectProjectThread(card.project.id), { retry: true })
  }

  const toggleStar = (card: PickerCard) => {
    const pinned = !card.starred
    void runWithToast(pinned ? 'star the project' : 'unstar the project', () => window.mousse.projects.pin(card.project.id, pinned), { retry: true })
  }

  const onKeyDown = (event: ReactKeyboardEvent) => {
    // The computer menu takes its own Escape first, so this one closes the picker and nothing else sees it.
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    // Only from the search field: the computer menu and the buttons keep their own keys.
    if (event.target !== inputRef.current) return
    const direction = ARROWS[event.key]
    // Left and right move the caret while there is text to move it through.
    if (direction && !((direction === 'left' || direction === 'right') && query)) {
      event.preventDefault()
      const next = cards[gridMove([sections.starred.length, sections.recent.length], active, direction, COLUMNS)]
      if (next) setActiveId(next.project.id)
    } else if (event.key === 'Enter' && activeCard) {
      event.preventDefault()
      start(activeCard)
    } else if (event.key.toLowerCase() === 'd' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && activeCard) {
      event.preventDefault()
      toggleStar(activeCard)
    }
  }

  const renderCard = (card: PickerCard) => {
    const { project } = card
    const isActive = card === activeCard
    const hue = hueOf.get(project.id)
    const when = card.unavailable ?? (card.lastUsed ? botDayLabel(card.lastUsed) : '')
    const ComputerIcon = project.node ? Monitor : Laptop
    return (
      <div
        key={project.id}
        className={`new-thread-picker-card${isActive ? ' active' : ''}${card.unavailable ? ' unavailable' : ''}`}
        onMouseMove={() => { if (!isActive) setActiveId(project.id) }}
      >
        <button
          type="button"
          id={`${listId}-${project.id}`}
          className="new-thread-picker-card-main"
          role="option"
          aria-selected={isActive}
          aria-disabled={card.unavailable ? true : undefined}
          tabIndex={-1}
          onClick={() => start(card)}
        >
          <span className="new-thread-picker-mark" style={hue ? { color: projectHueColor(hue) } : undefined} aria-hidden="true">
            <ProjectIcon project={project} size={18} fallback={projectInitials(project.name)} />
          </span>
          <span className="new-thread-picker-text">
            <span className="new-thread-picker-name">{project.name}</span>
            <span className="new-thread-picker-meta">
              <ComputerIcon size={12} strokeWidth={2} aria-hidden="true" />
              <span className="new-thread-picker-computer">{card.computer}</span>
              {when && <span className="new-thread-picker-when">· {when}</span>}
            </span>
            <span className="new-thread-picker-path" title={project.path}>{shortPath(project.path)}</span>
          </span>
        </button>
        <button
          type="button"
          className={`new-thread-picker-star${card.starred ? ' active' : ''}`}
          aria-label={card.starred ? `Unstar ${project.name}` : `Star ${project.name}`}
          aria-pressed={card.starred}
          title={card.starred ? 'Unstar' : 'Star · also pins it in the sidebar'}
          tabIndex={-1}
          onClick={() => toggleStar(card)}
        >
          <Star size={14} strokeWidth={2} fill={card.starred ? 'currentColor' : 'none'} />
        </button>
      </div>
    )
  }

  const section = (label: string, list: PickerCard[]) =>
    list.length > 0 && (
      <div className="new-thread-picker-section" role="group" aria-label={label}>
        <div className="thread-search-group-label" aria-hidden="true">{label}</div>
        <div className="new-thread-picker-grid">{list.map(renderCard)}</div>
      </div>
    )

  const mod = platform === 'darwin' ? '⌘' : 'Ctrl+'

  return (
    <div className="thread-search-overlay new-thread-picker-overlay" onClick={onClose} role="presentation">
      <div
        className="thread-search-dialog new-thread-picker"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label="New thread"
      >
        <div className="thread-search-input-row">
          <Search size={16} strokeWidth={2} className="thread-search-icon" aria-hidden="true" />
          <input
            ref={inputRef}
            className="thread-search-input"
            value={query}
            placeholder="Find a project…"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeCard ? `${listId}-${activeCard.project.id}` : undefined}
            onChange={(event) => setQuery(event.target.value)}
          />
          {computerOptions.length > 0 && (
            <Select
              value={computer}
              onChange={setComputer}
              options={computerOptions}
              size="small"
              variant="menu"
              ariaLabel="Computer"
              className="new-thread-picker-computers"
            />
          )}
          <button type="button" className="thread-search-close" onClick={onClose} aria-label="Close">
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        <div className="thread-search-results new-thread-picker-results" id={listId} role="listbox" aria-label="Projects">
          {cards.length === 0 && <div className="thread-search-empty">{projects.length === 0 ? 'No projects yet' : 'No matches'}</div>}
          {section('Starred', sections.starred)}
          {section(sections.starred.length > 0 ? 'Recent' : 'Projects', sections.recent)}
        </div>

        <div className="thread-search-footer new-thread-picker-footer">
          <button
            type="button"
            className="new-thread-picker-action"
            onClick={() => {
              onClose()
              void runWithToast('add the project', addProjectAndStartThread)
            }}
          >
            <FolderPlus size={14} strokeWidth={2} aria-hidden="true" />
            Add project
          </button>
          <button
            type="button"
            className="new-thread-picker-action"
            onClick={() => {
              onClose()
              void runWithToast('start a thread', createAndSelectNoProjectThread, { retry: true })
            }}
          >
            <span className="new-thread-picker-no-project" aria-hidden="true" />
            No project
          </button>
          <span className="new-thread-picker-hints">
            <span className="thread-search-hint"><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> navigate</span>
            <span className="thread-search-hint"><kbd>↵</kbd> start</span>
            <span className="thread-search-hint"><kbd>{mod}D</kbd> star</span>
            <span className="thread-search-hint"><kbd>esc</kbd> close</span>
          </span>
        </div>
      </div>
    </div>
  )
}
