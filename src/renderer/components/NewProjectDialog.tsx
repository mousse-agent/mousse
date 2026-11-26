import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { create } from 'zustand'
import { AlertTriangle, Folder, FolderOpen, FolderPlus, GitFork, GitHub, Laptop, Lock, Monitor, X } from '../lib/icons'
import { useCommandOverlay } from '../commands/commandRegistry'
import { useAppStore } from '../stores/appStore'
import { useComputers, UNKNOWN_COMPUTER_NAME } from '../lib/computers'
import { openRemoteProject, remoteErrorMessage } from '../lib/remoteComputers'
import { refreshGitHubRepositories, useSourceControl } from '../lib/sourceControl'
import { openSettingsSection } from '../lib/settingsNavigation'
import { listProjectAndStartThread } from '../lib/threadActions'
import { runWithToast } from '../lib/actionToast'
import { readableError } from '../lib/errorText'
import { qualifyId } from '../../shared/threadRef'
import type { Project } from '../../shared/types'
import { showToast } from './ui/Toast'
import { Select, type SelectOption } from './ui/Select'
import { Spinner } from './ui/Spinner'
import { newProjectRows, projectFolders, sameFolder, usualParent, withExisting, withRepositories, type NewProjectRow } from './newProjectLogic'
import { shortPath } from './newThreadPickerLogic'
import './newProjectDialog.css'

const THIS_COMPUTER = 'self'

/**
 * What New project is doing, kept outside the dialog: a clone goes on after Esc hides the dialog, and opening it again
 * shows it still running. `error` is the last failure while the dialog was open.
 */
const useProjectTask = create<{ label: string | null; error: string }>(() => ({ label: null, error: '' }))

/** A project New project added: a thread opens in it while the dialog is open; once hidden, a toast offers one. */
async function finish(project: Project): Promise<void> {
  const app = useAppStore.getState()
  if (app.newProjectOpen) {
    app.setNewProjectOpen(false)
    await runWithToast('start a thread', () => listProjectAndStartThread(project), { retry: true })
    return
  }
  if (!app.projects.some((entry) => entry.id === project.id)) app.setProjects([...app.projects, project])
  showToast({
    title: project.name,
    message: 'Project ready',
    tone: 'success',
    action: { label: 'New thread', run: () => void runWithToast('start a thread', () => listProjectAndStartThread(project)) }
  })
}

function fail(error: unknown): void {
  const message = readableError(error, 'Something went wrong')
  if (useAppStore.getState().newProjectOpen) useProjectTask.setState({ error: message })
  else showToast({ title: 'Could not add the project', message, tone: 'error' })
}

/** Runs one add at a time; `label` shows in the dialog while it runs, or none for the system's folder picker. */
async function runTask(label: string | null, work: () => Promise<Project | null>): Promise<void> {
  if (useProjectTask.getState().label) return
  useProjectTask.setState({ label, error: '' })
  let project: Project | null
  try {
    project = await work()
  } catch (error) {
    useProjectTask.setState({ label: null })
    fail(error)
    return
  }
  useProjectTask.setState({ label: null })
  if (project) await finish(project)
}

/** The full row of a project the service just listed; the summary a clone answers with until the list arrives. */
function listedProject(summary: { id: string; name: string; path: string }): Project {
  return useAppStore.getState().projects.find((project) => project.id === summary.id) ?? { ...summary, createdAt: new Date().toISOString(), order: 0 }
}

/**
 * New project, from the title bar's Add project: one field takes a GitHub repository to clone, a folder to add, or a
 * name for a new empty project, with the system's folder picker one row away. On another computer it adds a folder
 * that is already there, by its path. The new project opens with a new thread.
 */
export function NewProjectDialog() {
  const open = useAppStore((state) => state.newProjectOpen)
  useCommandOverlay('palette', open)
  return open ? <NewProjectPanel /> : null
}

function NewProjectPanel() {
  const projects = useAppStore((state) => state.projects)
  const chosenParent = useAppStore((state) => state.newProjectParent)
  const close = () => useAppStore.getState().setNewProjectOpen(false)
  const { byNode } = useComputers()
  const task = useProjectTask()
  const [query, setQuery] = useState('')
  const [computer, setComputer] = useState(THIS_COMPUTER)
  const [hint, setHint] = useState<'clone' | 'new' | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const github = useSourceControl((state) => state.github)
  const repositories = useSourceControl((state) => state.repositories)

  const remote = computer !== THIS_COMPUTER
  const computerName = remote ? byNode[computer]?.name ?? UNKNOWN_COMPUTER_NAME : 'This computer'
  const parent = chosenParent ?? usualParent(projects.filter((project) => !project.node).map((project) => project.path))
  const groups = useMemo(() => {
    if (remote) return newProjectRows(query, { remote: true, computer: computerName, folders: projectFolders(projects.filter((project) => project.node === computer).map((project) => project.path)) })
    const local = projects.filter((project) => !project.node)
    const connected = github ? github.state === 'connected' : null
    const rows = withRepositories(newProjectRows(query, { remote: false, parent }), query, { repositories, parent, cloning: hint === 'clone', connected })
    return withExisting(rows, (path) => local.find((project) => sameFolder(project.path, path)))
  }, [query, remote, computer, computerName, projects, parent, github, repositories, hint])
  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups])
  const active = Math.min(activeIndex, Math.max(rows.length - 1, 0))

  // The computer menu: this computer and the others this one knows.
  const computerOptions = useMemo((): SelectOption[] => {
    const others = Object.values(byNode)
    if (others.length === 0) return []
    return [{ value: THIS_COMPUTER, label: 'This computer' }, ...others.map((entry) => ({ value: entry.node, label: entry.name }))]
  }, [byNode])

  useEffect(() => {
    inputRef.current?.focus()
    useProjectTask.setState({ error: '' })
    // The account's repositories: shown from memory at once, read again behind them when old.
    void refreshGitHubRepositories()
  }, [])

  useEffect(() => {
    document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [active, listId])

  // The field keeps the keyboard through a clone and after a failure, so Esc hides and typing goes on.
  useEffect(() => {
    if (!task.label) inputRef.current?.focus()
  }, [task.label])

  const edit = (text: string) => {
    setQuery(text)
    setActiveIndex(0)
    if (task.error) useProjectTask.setState({ error: '' })
  }

  const chooseParent = async (): Promise<string | null> => {
    const picked = await window.mousse.projects.chooseFolder()
    if (picked) useAppStore.getState().setNewProjectParent(picked)
    return picked
  }

  /** Where a clone or a new project goes: the known folder, or one chosen now. */
  const destinationFor = async (row: { name: string; destination: string | null }): Promise<string | null> => {
    if (row.destination) return row.destination
    const picked = await chooseParent()
    return picked ? newProjectRows(row.name, { remote: false, parent: picked }).flatMap((group) => group.rows).find((entry) => entry.kind === 'create')?.destination ?? null : null
  }

  const choose = async (row: NewProjectRow) => {
    switch (row.kind) {
      case 'open-folder':
        return runTask(null, () => window.mousse.projects.open())
      case 'clone-hint':
      case 'new-hint':
        setHint(row.kind === 'clone-hint' ? 'clone' : 'new')
        inputRef.current?.focus()
        return
      case 'suggest':
        edit(row.path)
        inputRef.current?.focus()
        return
      case 'not-github':
        return
      case 'connect-github':
        close()
        openSettingsSection('source-control')
        return
      case 'existing': {
        const project = projects.find((entry) => entry.id === row.projectId)
        if (project) await finish(project)
        return
      }
      case 'clone': {
        const destination = await destinationFor(row)
        if (!destination) return
        return runTask(`Cloning ${row.repository}…`, async () => {
          const { project } = await window.mousse.github.cloneRepository({ repository: row.repository, destination })
          return listedProject(project)
        })
      }
      case 'create': {
        const destination = await destinationFor(row)
        if (!destination) return
        return runTask(`Making ${row.name}…`, () => window.mousse.projects.open({ path: destination, create: true }))
      }
      case 'add-path':
        if (!remote) return runTask(`Adding ${row.path}…`, () => window.mousse.projects.open({ path: row.path }))
        return runTask(`Adding ${row.path} on ${computerName}…`, async () => {
          const node = byNode[computer]?.node
          if (!node) throw new Error(`${computerName} is not connected`)
          let opened: Awaited<ReturnType<typeof openRemoteProject>>
          try {
            opened = await openRemoteProject(node, row.path)
          } catch (error) {
            throw new Error(remoteErrorMessage(error, computerName))
          }
          if (!opened.ok) throw new Error(opened.error)
          return { ...opened.project, id: qualifyId(computer, opened.project.id), node: computer }
        })
    }
  }

  const onKeyDown = (event: ReactKeyboardEvent) => {
    // The computer menu takes its own Escape first. While something runs, Esc only hides the dialog; the work goes on.
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.target !== inputRef.current || task.label) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (rows.length > 0) setActiveIndex((active + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length)
    } else if (event.key === 'Enter' && rows[active]) {
      event.preventDefault()
      void choose(rows[active]!)
    } else if (event.key === 'Tab' && !event.shiftKey && rows[active]?.kind === 'suggest') {
      event.preventDefault()
      void choose(rows[active]!)
    }
  }

  const placeholder = remote
    ? `Folder path on ${computerName}…`
    : hint === 'clone' ? 'Paste a GitHub URL or owner/name…'
      : hint === 'new' ? 'Name the new project…'
        : 'Paste a GitHub URL or folder path, or name a new project…'

  let position = 0
  return (
    <div className="thread-search-overlay new-project-overlay" onClick={close} role="presentation">
      <div
        className="thread-search-dialog new-project-dialog"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label="New project"
      >
        <div className="thread-search-input-row">
          <FolderPlus size={16} strokeWidth={2} className="thread-search-icon" aria-hidden="true" />
          <input
            ref={inputRef}
            className="thread-search-input"
            value={query}
            placeholder={placeholder}
            readOnly={task.label !== null}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={rows.length > 0 && !task.label ? `${listId}-${active}` : undefined}
            onChange={(event) => edit(event.target.value)}
          />
          {computerOptions.length > 0 && (
            <Select
              value={computer}
              onChange={(next) => {
                setComputer(next)
                edit('')
                setHint(null)
                inputRef.current?.focus()
              }}
              options={computerOptions}
              size="small"
              variant="menu"
              ariaLabel="Computer"
              disabled={task.label !== null}
              className="new-project-computers"
            />
          )}
          <button type="button" className="thread-search-close" onClick={close} aria-label="Close">
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        {task.error && <div className="new-project-error" role="alert">{task.error}</div>}

        <div className="thread-search-results new-project-results" id={listId} role="listbox" aria-label="New project">
          {task.label ? (
            <div className="new-project-busy" role="status">
              <span className="new-project-row-icon"><Spinner size={15} /></span>
              <span className="palette-result-text">
                <span className="thread-search-result-title">{task.label}</span>
                <span className="thread-search-result-meta">Esc keeps it going in the background</span>
              </span>
            </div>
          ) : rows.length === 0 ? (
            <div className="thread-search-empty">
              {remote ? `Type the folder’s full path on ${computerName}` : 'Not a GitHub repository, a folder path or a project name'}
            </div>
          ) : groups.map((group) => (
            <div key={group.label} className="thread-search-group" role="group" aria-label={group.label}>
              <div className="thread-search-group-label" aria-hidden="true">{group.label}</div>
              {group.rows.map((row) => {
                const index = position++
                const view = rowView(row, remote, computerName)
                const isActive = index === active
                return (
                  <div key={`${row.kind}-${index}`} className="new-project-row">
                    <button
                      type="button"
                      id={`${listId}-${index}`}
                      role="option"
                      tabIndex={-1}
                      aria-selected={isActive}
                      aria-disabled={row.kind === 'not-github' || undefined}
                      className={`thread-search-result palette-result${isActive ? ' active' : ''}${row.kind === 'not-github' ? ' new-project-row-muted' : ''}`}
                      onMouseMove={() => { if (!isActive) setActiveIndex(index) }}
                      onClick={() => void choose(row)}
                    >
                      <span className="new-project-row-icon" aria-hidden="true">{view.icon}</span>
                      <span className="palette-result-text">
                        <span className="thread-search-result-title">{view.title}</span>
                        {view.meta && <span className="thread-search-result-meta">{view.meta}</span>}
                      </span>
                      {view.end && <span className="palette-result-end"><span className="palette-result-category">{view.end}</span></span>}
                    </button>
                    {((row.kind === 'clone' && (!row.owned || isActive)) || row.kind === 'create') && (
                      <button type="button" className="new-project-change" tabIndex={-1} onClick={() => void chooseParent()}>
                        {row.destination ? 'Change' : 'Choose folder'}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        <div className="thread-search-footer">
          <span className="thread-search-hint"><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span className="thread-search-hint"><kbd>↵</kbd> choose</span>
          {remote && <span className="thread-search-hint"><kbd>⇥</kbd> fill</span>}
          <span className="thread-search-hint"><kbd>esc</kbd> {task.label ? 'hide' : 'close'}</span>
        </div>
      </div>
    </div>
  )
}

function rowView(row: NewProjectRow, remote: boolean, computer: string): { icon: ReactNode; title: string; meta?: string; end?: ReactNode } {
  // A home folder reads as ~, as on the New thread picker's cards.
  const into = (destination: string | null) => (destination ? `into ${shortPath(destination)}` : 'Choose where it goes first')
  switch (row.kind) {
    case 'open-folder':
      return { icon: <FolderOpen size={15} strokeWidth={2} />, title: 'Open a folder…', end: 'Browse' }
    case 'clone-hint':
      return { icon: <GitFork size={15} strokeWidth={2} />, title: 'Clone a repository…', end: 'GitHub' }
    case 'new-hint':
      return { icon: <FolderPlus size={15} strokeWidth={2} />, title: 'New empty project…', end: 'Folder + Git' }
    case 'clone':
      if (row.owned) return { icon: <GitHub size={15} strokeWidth={2} />, title: row.repository, meta: into(row.destination), ...(row.owned.private ? { end: <Lock size={13} strokeWidth={2} aria-label="Private" /> } : {}) }
      return { icon: <GitFork size={15} strokeWidth={2} />, title: `Clone ${row.repository}`, meta: into(row.destination) }
    case 'connect-github':
      return { icon: <GitHub size={15} strokeWidth={2} />, title: 'Connect GitHub…', meta: 'To list your repositories', end: 'Settings' }
    case 'create':
      return { icon: <FolderPlus size={15} strokeWidth={2} />, title: `New empty project “${row.name}”`, meta: into(row.destination) }
    case 'add-path':
      return { icon: remote ? <Monitor size={15} strokeWidth={2} /> : <Laptop size={15} strokeWidth={2} />, title: `Add ${row.path}`, meta: remote ? `On ${computer}` : undefined }
    case 'suggest':
      return { icon: <Folder size={15} strokeWidth={2} />, title: row.path }
    case 'not-github':
      return { icon: <AlertTriangle size={15} strokeWidth={2} />, title: 'Only GitHub repositories can be cloned' }
    case 'existing':
      return { icon: <Folder size={15} strokeWidth={2} />, title: `Open “${row.name}”`, meta: `Already a project · ${shortPath(row.path)}` }
  }
}
