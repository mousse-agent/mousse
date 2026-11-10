import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ExpiryIcon, ExpiryMenu } from './ExpiryMenu'
import { expiryDurationLabel, expiryShortLabel } from '../../shared/threadExpiry'
import { Check, ChevronDown, Folder, FolderPlus, GitBranch, Incognito, Laptop, Search, Server } from '../lib/icons'
import type { NodeId } from '../../shared/net'
import type { GitScope, Project } from '../../shared/types'
import { useMenuKeyboard } from '../hooks/useMenuKeyboard'
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'
import type { Device } from '../lib/netDevices'
import { workspaceWithProject, type ComposerWorkspace } from '../lib/newThread'
import { folderKey } from '../lib/activeProject'
import { useGitStatus, type GitStatusView } from '../stores/gitStatusStore'
import { LOCAL_RUN_ON_ID, buildRunOnOptions, canPickComputer, runOnLabel } from './sideCard/deviceMenu'
import { RemoteProjectDialog } from './RemoteProjectDialog'
import { ProjectIcon } from './ProjectIcon'
import { branchSearchAria, localBranchNames } from './sideCard/gitSectionLogic'
import '../styles/composer-workspace.css'

/** What the settings row needs to offer other computers. Without it, or with no other computer, it reads "This computer". */
export interface ComposerDeviceProps {
  /** This computer's name. */
  localName: string
  /** The user's devices; phones and disconnected ones are left out of the menu. */
  devices: readonly Device[]
  /** Computers that stopped sharing their threads with this one: named in the menu, not offered. */
  notSharing?: ReadonlySet<string>
  /** Called when the Run on menu opens, so the list is fresh. */
  onRefresh: () => void
  /** Picks where the chat runs; undefined is this computer. */
  onSelect: (node: NodeId | undefined) => void
  /** Asks the picked computer to open a folder as a project; resolves with its refusal, if any. */
  onOpenRemoteProject: (path: string) => Promise<string | undefined>
}

/** A trigger and its floating menu: focus moves into the menu on open and back on close; a click outside closes it. */
function useAnchoredMenu(disabled: boolean, itemCount: number, onOpen?: () => void) {
  const [menuOpen, setMenuOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const initialFocusRef = useRef(0)
  const menuId = useId()
  const open = menuOpen && !disabled
  const menuStyle = useFloatingPosition({ open, anchorRef: triggerRef, contentRef: menuRef, placement: 'below-start', deps: [itemCount] })
  const close = () => {
    setMenuOpen(false)
    triggerRef.current?.focus()
  }
  const menuKeyDown = useMenuKeyboard(menuRef, close)
  const show = (index: number) => {
    initialFocusRef.current = index
    onOpen?.()
    setMenuOpen(true)
  }

  useEffect(() => {
    if (!open) return
    if (menuStyle.visibility === 'visible') itemRefs.current[initialFocusRef.current]?.focus()
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open, menuStyle.visibility])

  /** Arrow keys on the trigger open the menu on the selected item (Down) or the last one (Up). */
  const triggerKeyDown = (selectedIndex: number) => (event: ReactKeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    show(event.key === 'ArrowUp' ? itemCount - 1 : selectedIndex)
  }
  const triggerProps = {
    ref: triggerRef,
    'aria-haspopup': 'menu' as const,
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined
  }
  return { open, show, close, menuRef, menuId, menuStyle, menuKeyDown, itemRefs, triggerKeyDown, triggerProps }
}

/** Above a new thread's composer: the project it starts in. */
export function ComposerProjectPicker({ projects, workspace, disabled, device, onChange, onOpenProject, onError }: {
  projects: Project[]
  workspace: ComposerWorkspace
  disabled: boolean
  device?: ComposerDeviceProps
  onChange: (workspace: ComposerWorkspace) => void
  onOpenProject: () => Promise<void>
  onError: (message: string) => void
}) {
  const [opening, setOpening] = useState(false)
  const [remoteDialog, setRemoteDialog] = useState(false)
  const project = projects.find((entry) => entry.id === workspace.projectId)
  const choices = [
    { id: '', name: 'No project' },
    ...(workspace.projectId && !project ? [{ id: workspace.projectId, name: 'Unavailable project' }] : []),
    ...projects
  ]
  const selectedIndex = Math.max(0, choices.findIndex((entry) => entry.id === (workspace.projectId ?? '')))
  const menu = useAnchoredMenu(disabled || opening, choices.length + 1)

  return (
    <div className="new-thread-row new-thread-row-above">
      <button
        {...menu.triggerProps}
        type="button"
        className={`new-thread-chip new-thread-project${menu.open ? ' open' : ''}`}
        title={project?.path ?? 'Project'}
        aria-label="Project"
        data-project-id={workspace.projectId ?? ''}
        disabled={disabled || opening}
        onClick={() => menu.open ? menu.close() : menu.show(selectedIndex)}
        onKeyDown={menu.triggerKeyDown(selectedIndex)}
      >
        <ProjectIcon project={project} size={14} fallback={<Folder size={14} aria-hidden="true" />} />
        <span>{project?.name ?? (workspace.projectId ? 'Unavailable project' : 'No project')}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {menu.open && (
        <FloatingPortal>
          <div
            ref={menu.menuRef}
            id={menu.menuId}
            className="composer-workspace-menu scrollbar-ultra-thin"
            role="menu"
            aria-label="Select project"
            style={menu.menuStyle}
            onKeyDown={menu.menuKeyDown}
          >
            {choices.map((entry, index) => (
              <button
                key={entry.id}
                ref={(element) => { menu.itemRefs.current[index] = element }}
                type="button"
                role="menuitemradio"
                tabIndex={-1}
                aria-checked={entry.id === (workspace.projectId ?? '')}
                className="composer-workspace-menu-item"
                data-project-id={entry.id}
                title={'path' in entry ? entry.path : undefined}
                onClick={() => {
                  onChange(workspaceWithProject(workspace, entry.id || undefined, projects))
                  menu.close()
                }}
              >
                <ProjectIcon project={'path' in entry ? entry : undefined} fallback={<Folder size={16} aria-hidden="true" />} />
                <span>{entry.name}</span>
                {entry.id === (workspace.projectId ?? '') && <Check size={14} className="composer-workspace-menu-check" aria-hidden="true" />}
              </button>
            ))}
            <div className="composer-workspace-menu-separator" role="separator" />
            <button
              ref={(element) => { menu.itemRefs.current[choices.length] = element }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="composer-workspace-menu-item"
              data-project-id="__open_project__"
              onClick={() => {
                menu.close()
                if (workspace.node && device) {
                  setRemoteDialog(true)
                  return
                }
                setOpening(true)
                void onOpenProject().catch((error) => onError(error instanceof Error ? error.message : String(error)))
                  .finally(() => setOpening(false))
              }}
            >
              <FolderPlus size={16} aria-hidden="true" />
              <span>Add project</span>
            </button>
          </div>
        </FloatingPortal>
      )}
      {remoteDialog && device && workspace.node && (
        <RemoteProjectDialog
          deviceName={runOnLabel(device.localName, device.devices, workspace.node)}
          recents={projects.map((entry) => entry.path)}
          onSubmit={device.onOpenRemoteProject}
          onClose={() => setRemoteDialog(false)}
        />
      )}
    </div>
  )
}

/**
 * Below a new thread's composer: where it runs (computer, then checkout or worktree) on the left;
 * Private and when it deletes itself on the right.
 */
export function ComposerThreadSettings({ workspace, disabled, device, onChange, onPrivateChange, onExpiryChange }: {
  workspace: ComposerWorkspace
  disabled: boolean
  device?: ComposerDeviceProps
  onChange: (workspace: ComposerWorkspace) => void
  /** Turns Private on or off for the new chat (`Thread.localOnly`). Without it the toggle is not shown. */
  onPrivateChange?: (localOnly: boolean) => void
  /** Picks when the new chat deletes itself (`ms` after it is created, or null for never). Without it the menu is not shown. */
  onExpiryChange?: (ms: number | null, stopsRun: boolean) => void
}) {
  const git = useProjectGit(workspace.projectId)
  const repo = projectRepoState(workspace.projectId, git)
  // A folder without Git works in place: no worktree and no base branch go out with the new thread.
  useEffect(() => {
    if (repo === 'no' && (workspace.worktreeEnabled || workspace.baseBranch)) onChange(workspaceWithMode(workspace, false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, workspace.worktreeEnabled, workspace.baseBranch])
  return (
    <div className="new-thread-row new-thread-row-below" role="group" aria-label="New thread settings">
      <div className="new-thread-row-group new-thread-row-start">
        {/* The computer is always named; it is a menu only when there is another one to pick. */}
        {device && !workspace.localOnly && canPickComputer(device.devices, workspace.node)
          ? <ComposerDeviceButton device={device} node={workspace.node} disabled={disabled} />
          : (
            <div className="new-thread-chip new-thread-chip-static" role="note" aria-label="Runs on this computer" title={workspace.localOnly ? 'Private threads run on this computer only' : undefined}>
              <Laptop size={14} aria-hidden="true" />
              <span>This computer</span>
            </div>
          )}
        {/* Branches and worktrees are of a Git project: shown once its folder is known to be a repository. */}
        {repo === 'yes' && <ComposerWorkspaceMenu workspace={workspace} git={git} disabled={disabled} onChange={onChange} />}
      </div>
      <div className="new-thread-row-group new-thread-row-end">
        {onPrivateChange && (
          <button
            type="button"
            className={`new-thread-chip new-thread-icon new-thread-private${workspace.localOnly ? ' active' : ''}`}
            title={workspace.localOnly ? 'Private: stays on this computer' : 'Make private: keep this thread on this computer, away from your other devices'}
            aria-label="Make private"
            aria-pressed={Boolean(workspace.localOnly)}
            disabled={disabled}
            onClick={() => onPrivateChange(!workspace.localOnly)}
          >
            <Incognito size={15} aria-hidden="true" />
          </button>
        )}
        {onExpiryChange && !workspace.node && (
          <ExpiryMenu
            triggerClassName={`new-thread-chip new-thread-icon new-thread-expiry${workspace.expiryMs !== undefined ? ' active' : ''}`}
            triggerTitle={workspace.expiryMs !== undefined ? `Deletes itself ${expiryDurationLabel(workspace.expiryMs)} after it starts` : 'Delete this thread after a while'}
            trigger={<><ExpiryIcon />{workspace.expiryMs !== undefined && <span className="new-thread-expiry-label">{expiryShortLabel(workspace.expiryMs)}</span>}</>}
            selectedMs={workspace.expiryMs}
            hasExpiry={false}
            stopsRun={workspace.expiryStopsRun === true}
            disabled={disabled}
            onPick={onExpiryChange}
          />
        )}
      </div>
    </div>
  )
}

/** The project folder's Git state from the shared store (the side card reads the same entry); nothing without a project. */
function useProjectGit(projectId: string | undefined): GitStatusView {
  const scope: GitScope = { projectId: projectId ?? null, workspaceThreadId: null }
  return useGitStatus(projectId ? folderKey(scope) : null, scope)
}

/** Whether the project's folder is a Git repository: unknown until its first read finishes, or when that read failed. */
export function projectRepoState(projectId: string | undefined, git: Pick<GitStatusView, 'loaded' | 'status' | 'error'>): 'yes' | 'no' | 'unknown' {
  if (!projectId) return 'no'
  if (!git.loaded || git.error || !git.status) return 'unknown'
  return git.status.isRepo ? 'yes' : 'no'
}

/**
 * The text on the workspace button: the branch it works on. The checkout's own branch (`main`), or for a new worktree
 * the branch it starts from (`main (new)`). A detached checkout reads `HEAD`, as Git calls it.
 */
export function workspaceChoiceLabel(worktree: boolean, current: string | null, baseBranch?: string): string {
  const base = baseBranch ?? current ?? 'HEAD'
  return worktree ? `${base} (new)` : current ?? 'HEAD'
}

/**
 * The draft after picking a branch. The checkout's own branch keeps the mode; another one can only be the start of a
 * new worktree (the project folder never switches branch for a thread), so it turns the worktree on.
 */
export function workspaceWithBranch(workspace: ComposerWorkspace, branch: string, current: string | null): ComposerWorkspace {
  const { baseBranch: _previous, ...rest } = workspace
  return branch === current ? rest : { ...rest, worktreeEnabled: true, baseBranch: branch }
}

/** The draft after picking a mode: the current checkout is always on its own branch. */
export function workspaceWithMode(workspace: ComposerWorkspace, worktree: boolean): ComposerWorkspace {
  const { baseBranch, ...rest } = workspace
  return worktree ? { ...rest, worktreeEnabled: true, ...(baseBranch ? { baseBranch } : {}) } : { ...rest, worktreeEnabled: false }
}

/**
 * Where the new thread works in its project: a branch list (with a filter) to start from, then the mode: a new worktree
 * on a new branch, or the project folder as it is. Picking a branch keeps the menu open; picking a mode closes it.
 */
function ComposerWorkspaceMenu({ workspace, git, disabled, onChange }: {
  workspace: ComposerWorkspace
  git: GitStatusView
  disabled: boolean
  onChange: (workspace: ComposerWorkspace) => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const info = git.branches
  const current = info?.current ?? null
  const worktree = Boolean(workspace.projectId && workspace.worktreeEnabled)
  const base = workspace.baseBranch ?? current
  const selected = worktree ? base : current
  const needle = query.trim().toLowerCase()
  const branches = localBranchNames(info).filter((name) => !needle || name.toLowerCase().includes(needle))
  // Read again on open, the folder may have changed branch since; the filter starts empty.
  const menu = useAnchoredMenu(disabled, branches.length + 2, () => {
    void git.refresh()
    setQuery('')
  })
  // Until the branches are read, a muted placeholder holds the place of the name.
  const label = info ? workspaceChoiceLabel(worktree, current, workspace.baseBranch) : null

  useEffect(() => {
    if (!menu.open || menu.menuStyle.visibility !== 'visible') return
    if (info) searchRef.current?.focus()
    else menu.itemRefs.current[0]?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu.open, menu.menuStyle.visibility, Boolean(info)])
  useEffect(() => {
    setActive(Math.max(0, branches.findIndex((name) => name === selected)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu.open, needle, info])

  const pickBranch = (name: string) => onChange(workspaceWithBranch(workspace, name, current))
  const modes = [
    { worktree: true, label: 'New worktree', title: base ? `A new worktree on a new branch from ${base}` : 'A new worktree on a new branch' },
    { worktree: false, label: 'Current checkout', title: current ? `Work in the project folder on ${current}` : 'Work in the project folder' }
  ]

  return (
    <>
      <button
        {...menu.triggerProps}
        aria-haspopup="dialog"
        type="button"
        className={`new-thread-chip new-thread-workspace${menu.open ? ' open' : ''}`}
        title={worktree ? modes[0].title : modes[1].title}
        aria-label={`Where to work: ${label ?? 'reading branch'}`}
        data-worktree={worktree ? 'true' : 'false'}
        disabled={disabled}
        onClick={() => menu.open ? menu.close() : menu.show(-1)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          menu.show(-1)
        }}
      >
        <GitBranch size={14} aria-hidden="true" />
        {label === null ? <span className="new-thread-branch-placeholder" aria-hidden="true" /> : <span>{label}</span>}
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {menu.open && (
        <FloatingPortal>
          <div
            ref={menu.menuRef}
            id={menu.menuId}
            className="composer-workspace-menu new-thread-branch-menu"
            role="dialog"
            aria-label="Where to work"
            style={menu.menuStyle}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              event.stopPropagation()
              menu.close()
            }}
          >
            {info && (
              <>
                <label className="new-thread-branch-search">
                  <Search size={13} aria-hidden="true" />
                  <input
                    ref={searchRef}
                    type="text"
                    value={query}
                    placeholder="Find a branch"
                    aria-label="Find a branch"
                    {...branchSearchAria(listId, active, branches.length)}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        event.preventDefault()
                        if (branches.length === 0) return
                        const step = event.key === 'ArrowDown' ? 1 : -1
                        setActive((index) => (index + step + branches.length) % branches.length)
                      } else if (event.key === 'Enter') {
                        event.preventDefault()
                        const name = branches[active]
                        if (name) pickBranch(name)
                      }
                    }}
                  />
                </label>
                <div id={listId} className="new-thread-branch-list scrollbar-ultra-thin" role="listbox" aria-label="Branches">
                  {branches.length === 0
                    ? <p className="new-thread-branch-empty">No matching branches</p>
                    : branches.map((name, index) => (
                      <button
                        key={name}
                        id={`${listId}-${index}`}
                        type="button"
                        role="option"
                        tabIndex={-1}
                        aria-selected={name === selected}
                        data-active={index === active}
                        data-branch={name}
                        className="composer-workspace-menu-item new-thread-branch-option"
                        title={name === current ? `${name}: the project folder's branch` : name}
                        onMouseMove={() => setActive(index)}
                        onClick={() => {
                          pickBranch(name)
                          searchRef.current?.focus()
                        }}
                      >
                        <span>{name}</span>
                        {name === selected && <Check size={14} className="composer-workspace-menu-check" aria-hidden="true" />}
                      </button>
                    ))}
                </div>
                <div className="composer-workspace-menu-separator" role="separator" />
              </>
            )}
            <div role="radiogroup" aria-label="Mode">
              {modes.map((mode, index) => (
                <button
                  key={mode.label}
                  ref={(element) => { menu.itemRefs.current[index] = element }}
                  type="button"
                  role="radio"
                  aria-checked={mode.worktree === worktree}
                  className="composer-workspace-menu-item"
                  data-worktree={mode.worktree ? 'true' : 'false'}
                  title={mode.title}
                  onClick={() => {
                    onChange(workspaceWithMode(workspace, mode.worktree))
                    menu.close()
                  }}
                >
                  <span>{mode.label}</span>
                  {mode.worktree === worktree && <Check size={14} className="composer-workspace-menu-check" aria-hidden="true" />}
                </button>
              ))}
            </div>
          </div>
        </FloatingPortal>
      )}
    </>
  )
}

/** The computer item: names where the chat runs, and opens the Run on menu. */
function ComposerDeviceButton({ device, node, disabled }: { device: ComposerDeviceProps; node: NodeId | undefined; disabled: boolean }) {
  const run = buildRunOnOptions({ localName: device.localName, devices: device.devices, node, notSharing: device.notSharing })
  const label = runOnLabel(device.localName, device.devices, node)
  const selectedIndex = Math.max(0, run.findIndex((option) => option.active))
  const menu = useAnchoredMenu(disabled, run.length, device.onRefresh)

  const Icon = node ? Server : Laptop
  return (
    <>
      <button
        {...menu.triggerProps}
        type="button"
        className={`new-thread-chip new-thread-device${menu.open ? ' open' : ''}`}
        title={`Run on ${label}`}
        aria-label="Run on"
        data-node={node ?? ''}
        disabled={disabled}
        onClick={() => menu.open ? menu.close() : menu.show(selectedIndex)}
        onKeyDown={menu.triggerKeyDown(selectedIndex)}
      >
        <Icon size={14} aria-hidden="true" />
        <span>{label}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {menu.open && (
        <FloatingPortal>
          <div
            ref={menu.menuRef}
            id={menu.menuId}
            className="composer-workspace-menu composer-workspace-device-menu scrollbar-ultra-thin"
            role="menu"
            aria-label="Run on"
            style={menu.menuStyle}
            onKeyDown={menu.menuKeyDown}
          >
            <div className="composer-workspace-menu-label" aria-hidden="true">Run on</div>
            {run.map((option, index) => {
              const RowIcon = option.id === LOCAL_RUN_ON_ID ? Laptop : Server
              return (
                <button
                  key={option.id}
                  ref={(element) => { menu.itemRefs.current[index] = element }}
                  type="button"
                  role="menuitemradio"
                  tabIndex={-1}
                  aria-checked={option.active}
                  className="composer-workspace-menu-item"
                  data-node={option.id === LOCAL_RUN_ON_ID ? '' : option.id}
                  disabled={option.disabled}
                  title={option.reason}
                  onClick={() => {
                    device.onSelect(option.id === LOCAL_RUN_ON_ID ? undefined : option.id as NodeId)
                    menu.close()
                  }}
                >
                  <RowIcon size={16} aria-hidden="true" />
                  <span>{option.name}</span>
                  {option.active && <Check size={14} className="composer-workspace-menu-check" aria-hidden="true" />}
                </button>
              )
            })}
          </div>
        </FloatingPortal>
      )}
    </>
  )
}
