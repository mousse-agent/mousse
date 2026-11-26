import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { create } from 'zustand'
import { AlertTriangle, ArrowUp, Check, Folder, FolderOpen, FolderPlus, GitFork, GitHub, Laptop, Lock, Monitor, X } from '../lib/icons'
import { useCommandOverlay } from '../commands/commandRegistry'
import { useAppStore } from '../stores/appStore'
import { useComputers, UNKNOWN_COMPUTER_NAME } from '../lib/computers'
import { openRemoteProject, remoteErrorMessage } from '../lib/remoteComputers'
import { noteGitHub, refreshGitHubRepositories, sourceControlClient, useComputerSourceControl, type BrowsedFolders } from '../lib/sourceControl'
import { openSettingsSection } from '../lib/settingsNavigation'
import { listProjectAndStartThread } from '../lib/threadActions'
import { runWithToast } from '../lib/actionToast'
import { readableError } from '../lib/errorText'
import { ensureQualified, qualifyId } from '../../shared/threadRef'
import type { Project } from '../../shared/types'
import type { SourceControlProviderStatus } from '../../shared/sourceControl'
import { showToast } from './ui/Toast'
import { Select, type SelectOption } from './ui/Select'
import { Spinner } from './ui/Spinner'
import { browseRows, joinFolder, newProjectRows, projectFolders, sameFolder, usualParent, withExisting, withRepositories, type NewProjectRow } from './newProjectLogic'
import { GitHubCode } from './GitHubCode'
import { shortPath } from './newThreadPickerLogic'
import './newProjectDialog.css'

const THIS_COMPUTER = 'self'

/**
 * What New project is doing, kept outside the dialog: a clone goes on after Esc hides the dialog, and opening it again
 * shows it still running. `error` is the last failure while the dialog was open.
 */
const useProjectTask = create<{ label: string | null; error: string }>(() => ({ label: null, error: '' }))

/** Where clones on another computer go, by computer: the folder last picked there by browsing. */
const useRemoteParents = create<Record<string, string>>(() => ({}))

type CloneRow = Extract<NewProjectRow, { kind: 'clone' }>

/** The folder browser of another computer: what it shows, and the clone that waits for a folder. */
interface Browser {
  view: BrowsedFolders | null
  loading: boolean
  error: string
  pending: CloneRow | null
  /** What the field held before browsing, back when it ends. */
  savedQuery: string
}

const PHASE_TEXT = { installing: 'Installing GitHub CLI…', starting: 'Starting sign-in…', code: 'Enter this code on GitHub', finishing: 'Finishing…' } as const

/** Plain words for a refusal from another computer: its own reason when it gave one. */
function remoteReason(error: unknown, computer: string): string {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown }
  if ((code === 'forbidden' || code === 'project_refused' || code === 'not_found') && typeof message === 'string' && message) return message
  return remoteErrorMessage(error, computer)
}

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
  const [browser, setBrowser] = useState<Browser | null>(null)

  const remote = computer !== THIS_COMPUTER
  // The computer whose GitHub account the dialog uses: this one (`''`) or the one picked.
  const account = remote ? computer : ''
  const { github, repositories } = useComputerSourceControl(account)
  const remoteParent = useRemoteParents((state) => state[computer])
  const computerName = remote ? byNode[computer]?.name ?? UNKNOWN_COMPUTER_NAME : 'This computer'
  const theirs = useMemo(() => projects.filter((project) => (remote ? project.node === computer : !project.node)), [projects, remote, computer])
  const parent = remote ? remoteParent ?? usualParent(theirs.map((project) => project.path)) : chosenParent ?? usualParent(theirs.map((project) => project.path))
  const groups = useMemo(() => {
    if (browser) return browser.view ? browseRows(browser.view, query, computerName) : []
    const base = remote
      ? newProjectRows(query, { remote: true, computer: computerName, folders: projectFolders(theirs.map((project) => project.path)), parent })
      : newProjectRows(query, { remote: false, parent })
    const connected = github ? github.state === 'connected' : null
    const rows = withRepositories(base, query, { repositories, parent, cloning: hint === 'clone', connected })
    return withExisting(rows, (path) => theirs.find((project) => sameFolder(project.path, path)))
  }, [browser, query, remote, computerName, theirs, parent, github, repositories, hint])
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
  }, [])

  // The account's repositories, of this computer or the one picked: shown from memory at once, read again behind them when old.
  useEffect(() => { void refreshGitHubRepositories({ computer: account }) }, [account])

  // While GitHub connects on the computer picked, follow it there; its one-time code shows here.
  const operationId = remote ? github?.operation?.id : undefined
  useEffect(() => {
    if (!operationId) return
    const timer = setInterval(() => {
      void sourceControlClient.status(false, account).then(
        (status) => noteGitHub(status.providers.find((provider) => provider.id === 'github'), account),
        () => undefined
      )
    }, 1_000)
    return () => {
      clearInterval(timer)
      void refreshGitHubRepositories({ computer: account, force: true })
    }
  }, [operationId, account])

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

  /** Connects GitHub on the computer picked: it installs GitHub CLI there when it can, and relays the sign-in's code here. */
  const connectThere = async () => {
    useProjectTask.setState({ error: '' })
    try {
      noteGitHub(await sourceControlClient.connect('github', computer), computer)
    } catch (error) {
      useProjectTask.setState({ error: remoteReason(error, computerName) })
    }
  }

  const cancelConnect = async () => {
    try {
      noteGitHub(await sourceControlClient.cancel('github', computer), computer)
    } catch (error) {
      useProjectTask.setState({ error: remoteReason(error, computerName) })
    }
  }

  const loadFolder = async (path?: string) => {
    setBrowser((current) => current && { ...current, loading: true, error: '' })
    try {
      const view = await sourceControlClient.browse(computer, path)
      setBrowser((current) => current && { ...current, view, loading: false })
      setQuery('')
      setActiveIndex(0)
    } catch (error) {
      // A folder picked before that is gone: start from the places there.
      if (path) return loadFolder()
      setBrowser((current) => current && { ...current, loading: false, error: remoteReason(error, computerName) })
    }
  }

  /** Browses the folders of the computer picked for where clones go; pending clones once one is picked. */
  const openBrowser = (pending: CloneRow | null) => {
    setBrowser({ view: null, loading: true, error: '', pending, savedQuery: query })
    useProjectTask.setState({ error: '' })
    void loadFolder(parent ?? undefined)
    inputRef.current?.focus()
  }

  const closeBrowser = (): Browser | null => {
    const was = browser
    setBrowser(null)
    setQuery(was?.savedQuery ?? '')
    setActiveIndex(0)
    return was
  }

  /** A clone on the computer picked, into a folder there, that becomes a project there. */
  const cloneThere = async (row: CloneRow) => {
    if (github && github.state !== 'connected') return connectThere()
    if (!row.destination) return openBrowser(row)
    const destination = row.destination
    return runTask(`Cloning ${row.repository} on ${computerName}…`, async () => {
      let cloned: Awaited<ReturnType<typeof sourceControlClient.clone>>
      try {
        cloned = await sourceControlClient.clone(computer, { repository: row.repository, path: destination })
      } catch (error) {
        throw new Error(remoteReason(error, computerName))
      }
      return { ...cloned.project, id: ensureQualified(computer, cloned.project.id), node: computer }
    })
  }

  const choose = async (row: NewProjectRow) => {
    switch (row.kind) {
      case 'browse-open':
        return loadFolder(row.path)
      case 'browse-use': {
        useRemoteParents.setState({ [computer]: row.path })
        const pending = closeBrowser()?.pending
        if (pending) return cloneThere({ ...pending, destination: joinFolder(row.path, pending.name) })
        return
      }
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
        if (remote) return connectThere()
        close()
        openSettingsSection('source-control')
        return
      case 'existing': {
        const project = projects.find((entry) => entry.id === row.projectId)
        if (project) await finish(project)
        return
      }
      case 'clone': {
        if (remote) return cloneThere(row)
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
      // Browsing folders, Esc goes back to the list.
      if (browser && !task.label) closeBrowser()
      else close()
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

  const placeholder = browser
    ? `Filter folders on ${computerName}…`
    : remote
    ? `Paste a GitHub URL, or a folder path on ${computerName}…`
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

        {(task.error || browser?.error) && <div className="new-project-error" role="alert">{task.error || browser?.error}</div>}

        <div className="thread-search-results new-project-results" id={listId} role="listbox" aria-label="New project">
          {task.label ? (
            <div className="new-project-busy" role="status">
              <span className="new-project-row-icon"><Spinner size={15} /></span>
              <span className="palette-result-text">
                <span className="thread-search-result-title">{task.label}</span>
                <span className="thread-search-result-meta">Esc keeps it going in the background</span>
              </span>
            </div>
          ) : remote && github?.operation ? (
            <ConnectingThere operation={github.operation} computer={computerName} onCancel={() => void cancelConnect()} />
          ) : browser && !browser.view ? (
            <div className="new-project-busy" role="status">
              <span className="new-project-row-icon">{browser.loading ? <Spinner size={15} /> : <Folder size={15} strokeWidth={2} />}</span>
              <span className="palette-result-text"><span className="thread-search-result-title">{`Folders on ${computerName}`}</span></span>
            </div>
          ) : rows.length === 0 ? (
            <div className="thread-search-empty">
              {browser ? 'No folders here' : remote ? `Paste a GitHub URL, or a folder’s full path on ${computerName}` : 'Not a GitHub repository, a folder path or a project name'}
            </div>
          ) : groups.map((group) => (
            <div key={group.label} className="thread-search-group" role="group" aria-label={group.label}>
              <div className="thread-search-group-label" aria-hidden="true">{group.label}</div>
              {group.rows.map((row) => {
                const index = position++
                const view = rowView(row, remote, computerName, github)
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
                      <button type="button" className="new-project-change" tabIndex={-1} onClick={() => (remote ? openBrowser(null) : void chooseParent())}>
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
          {remote && !browser && <span className="thread-search-hint"><kbd>⇥</kbd> fill</span>}
          <span className="thread-search-hint"><kbd>esc</kbd> {task.label ? 'hide' : browser ? 'back' : 'close'}</span>
        </div>
      </div>
    </div>
  )
}

/** GitHub connecting on another computer: where it is, the one-time code once that computer has it, and Cancel. */
function ConnectingThere({ operation, computer, onCancel }: { operation: NonNullable<SourceControlProviderStatus['operation']>; computer: string; onCancel: () => void }) {
  return (
    <div className="new-project-connect" role="status">
      <div className="new-project-busy">
        <span className="new-project-row-icon">{operation.phase === 'code' ? <GitHub size={15} strokeWidth={2} /> : <Spinner size={15} />}</span>
        <span className="palette-result-text">
          <span className="thread-search-result-title">{PHASE_TEXT[operation.phase]}</span>
          <span className="thread-search-result-meta">{`GitHub on ${computer}`}</span>
        </span>
        <button type="button" className="new-project-change" onClick={onCancel}>Cancel</button>
      </div>
      {operation.phase === 'code' && operation.code && <GitHubCode code={operation.code} url={operation.url} className="new-project-code" />}
    </div>
  )
}

function rowView(row: NewProjectRow, remote: boolean, computer: string, github: SourceControlProviderStatus | null): { icon: ReactNode; title: string; meta?: string; end?: ReactNode } {
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
    case 'connect-github': {
      if (!remote) return { icon: <GitHub size={15} strokeWidth={2} />, title: 'Connect GitHub…', meta: 'To list your repositories', end: 'Settings' }
      const install = github?.state === 'missing' ? github.install : undefined
      const meta = !install ? 'Its one-time code shows here' : install.automatic ? `Installs GitHub CLI there: ${install.command ?? ''}` : 'Install GitHub CLI there first'
      return { icon: <GitHub size={15} strokeWidth={2} />, title: `Connect GitHub on ${computer}…`, meta }
    }
    case 'browse-use':
      return { icon: <Check size={15} strokeWidth={2} />, title: 'Use this folder', meta: row.path }
    case 'browse-open':
      return row.up ? { icon: <ArrowUp size={15} strokeWidth={2} />, title: '..', meta: row.path } : { icon: <Folder size={15} strokeWidth={2} />, title: row.name }
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
