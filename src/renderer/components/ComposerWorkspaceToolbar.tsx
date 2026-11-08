import { useEffect, useId, useRef, useState } from 'react'
import { ExpiryIcon, ExpiryMenu } from './ExpiryMenu'
import { expiryDurationLabel, expiryShortLabel } from '../../shared/threadExpiry'
import { Check, ChevronDown, Folder, FolderPlus, Laptop, Lock, Server } from '../lib/icons'
import type { NodeId } from '../../shared/net'
import type { Project } from '../../shared/types'
import { useMenuKeyboard } from '../hooks/useMenuKeyboard'
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'
import type { Device } from '../lib/netDevices'
import { workspaceWithProject, type ComposerWorkspace } from '../lib/newThread'
import { LOCAL_RUN_ON_ID, buildRunOnOptions, canPickComputer, runOnLabel } from './sideCard/deviceMenu'
import { RemoteProjectDialog } from './RemoteProjectDialog'
import { Segmented, type SegmentedOption } from './settings/SettingsRow'
import { ProjectIcon } from './ProjectIcon'
import '../styles/composer-workspace.css'

/** Where a new thread in a project works: the project's own checkout or a new worktree. */
const WORKSPACE_OPTIONS: ReadonlyArray<SegmentedOption<'local' | 'worktree'>> = [
  { value: 'local', label: 'Local', title: 'Current checkout' },
  { value: 'worktree', label: 'Worktree', title: 'New worktree' }
]

/** What the toolbar needs to offer other computers. Without it, or with no other computer, the row reads "This computer". */
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

export function ComposerWorkspaceToolbar({ projects, workspace, disabled, device, onChange, onPrivateChange, onExpiryChange, onOpenProject, onError }: {
  projects: Project[]
  workspace: ComposerWorkspace
  disabled: boolean
  device?: ComposerDeviceProps
  onChange: (workspace: ComposerWorkspace) => void
  /** Turns Private on or off for the new chat (`Thread.localOnly`). Without it the toggle is not shown. */
  onPrivateChange?: (localOnly: boolean) => void
  /** Picks when the new chat deletes itself (`ms` after it is created, or null for never). Without it the menu is not shown. */
  onExpiryChange?: (ms: number | null, stopsRun: boolean) => void
  onOpenProject: () => Promise<void>
  onError: (message: string) => void
}) {
  const [opening, setOpening] = useState(false)
  const [remoteDialog, setRemoteDialog] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const initialFocusRef = useRef(0)
  const menuId = useId()
  const project = projects.find((entry) => entry.id === workspace.projectId)
  const choices = [
    { id: '', name: 'No project' },
    ...(workspace.projectId && !project ? [{ id: workspace.projectId, name: 'Unavailable project' }] : []),
    ...projects
  ]
  const selectedIndex = choices.findIndex((entry) => entry.id === (workspace.projectId ?? ''))
  const open = menuOpen && !disabled && !opening
  const menuStyle = useFloatingPosition({
    open, anchorRef: triggerRef, contentRef: menuRef, placement: 'below-start', deps: [projects.length]
  })
  const closeMenu = () => {
    setMenuOpen(false)
    triggerRef.current?.focus()
  }
  const menuKeyDown = useMenuKeyboard(menuRef, closeMenu)
  const openMenu = (index = selectedIndex) => {
    initialFocusRef.current = index
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
    return () => {
      document.removeEventListener('pointerdown', outside)
    }
  }, [open, menuStyle.visibility])

  const worktreeEnabled = Boolean(workspace.projectId && workspace.worktreeEnabled)
  return (
    <div className="composer-workspace-toolbar" role="group" aria-label="New thread workspace">
      <button
        ref={triggerRef}
        type="button"
        className={`composer-workspace-project${open ? ' open' : ''}`}
        title={project?.path}
        aria-label="Project"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-project-id={workspace.projectId ?? ''}
        disabled={disabled || opening}
        onClick={() => open ? closeMenu() : openMenu()}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            openMenu(event.key === 'ArrowUp' ? choices.length : selectedIndex)
          }
        }}
      >
        <ProjectIcon project={project} fallback={<Folder size={16} aria-hidden="true" />} />
        <span>{project?.name ?? (workspace.projectId ? 'Unavailable project' : 'No project')}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <FloatingPortal>
          <div
            ref={menuRef}
            id={menuId}
            className="composer-workspace-menu scrollbar-ultra-thin"
            role="menu"
            aria-label="Select project"
            style={menuStyle}
            onKeyDown={menuKeyDown}
          >
            {choices.map((entry, index) => (
              <button
                key={entry.id}
                ref={(element) => { itemRefs.current[index] = element }}
                type="button"
                role="menuitemradio"
                tabIndex={-1}
                aria-checked={entry.id === (workspace.projectId ?? '')}
                className="composer-workspace-menu-item"
                data-project-id={entry.id}
                title={'path' in entry ? entry.path : undefined}
                onClick={() => {
                  onChange(workspaceWithProject(workspace, entry.id || undefined))
                  closeMenu()
                }}
              >
                <ProjectIcon project={'path' in entry ? entry : undefined} fallback={<Folder size={16} aria-hidden="true" />} />
                <span>{entry.name}</span>
                {entry.id === (workspace.projectId ?? '') && <Check size={14} className="composer-workspace-menu-check" aria-hidden="true" />}
              </button>
            ))}
            <div className="composer-workspace-menu-separator" role="separator" />
            <button
              ref={(element) => { itemRefs.current[choices.length] = element }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="composer-workspace-menu-item"
              data-project-id="__open_project__"
              onClick={() => {
                closeMenu()
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
      {/* The computer is always named; it is a menu only when there is another one to pick. */}
      {device && !workspace.localOnly && canPickComputer(device.devices, workspace.node)
        ? <ComposerDeviceButton device={device} node={workspace.node} disabled={disabled || opening} />
        : (
          <div className="composer-workspace-device-static" role="note" aria-label="Runs on this computer" title={workspace.localOnly ? 'Private threads run on this computer only' : undefined}>
            <Laptop size={16} aria-hidden="true" />
            <span>This computer</span>
          </div>
        )}
      {remoteDialog && device && workspace.node && (
        <RemoteProjectDialog
          deviceName={runOnLabel(device.localName, device.devices, workspace.node)}
          recents={projects.map((entry) => entry.path)}
          onSubmit={device.onOpenRemoteProject}
          onClose={() => setRemoteDialog(false)}
        />
      )}
      {/* A worktree is of a project: with no project picked there is nothing to choose. */}
      {workspace.projectId && (
        <div className="composer-workspace-worktree">
          <Segmented
            value={worktreeEnabled ? 'worktree' : 'local'}
            options={WORKSPACE_OPTIONS}
            ariaLabel="Where to work"
            disabled={disabled || opening}
            onChange={(choice) => onChange({ ...workspace, worktreeEnabled: choice === 'worktree' })}
          />
        </div>
      )}
      {onPrivateChange && (
        <button
          type="button"
          className={`composer-icon-btn composer-workspace-private${workspace.localOnly ? ' active' : ''}`}
          title={workspace.localOnly
            ? 'Private: this thread stays on this computer'
            : 'Make private: keep this thread on this computer, away from your other devices'}
          aria-label="Private thread"
          aria-pressed={Boolean(workspace.localOnly)}
          disabled={disabled || opening}
          onClick={() => onPrivateChange(!workspace.localOnly)}
        >
          <Lock size={16} strokeWidth={1.8} aria-hidden="true" />
        </button>
      )}
      {onExpiryChange && !workspace.node && (
        <ExpiryMenu
          triggerClassName={`composer-icon-btn composer-workspace-expiry${workspace.expiryMs !== undefined ? ' active' : ''}`}
          triggerTitle={workspace.expiryMs !== undefined ? `Deletes itself ${expiryDurationLabel(workspace.expiryMs)} after it starts` : 'Delete this thread after a while'}
          trigger={<><ExpiryIcon />{workspace.expiryMs !== undefined && <span className="composer-workspace-expiry-label">{expiryShortLabel(workspace.expiryMs)}</span>}</>}
          selectedMs={workspace.expiryMs}
          hasExpiry={false}
          stopsRun={workspace.expiryStopsRun === true}
          disabled={disabled || opening}
          onPick={onExpiryChange}
        />
      )}
    </div>
  )
}

/** The computer item: names where the chat runs, and opens the Run on menu. */
function ComposerDeviceButton({ device, node, disabled }: { device: ComposerDeviceProps; node: NodeId | undefined; disabled: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const initialFocusRef = useRef(0)
  const menuId = useId()
  const run = buildRunOnOptions({ localName: device.localName, devices: device.devices, node, notSharing: device.notSharing })
  const label = runOnLabel(device.localName, device.devices, node)
  const selectedIndex = Math.max(0, run.findIndex((option) => option.active))
  const open = menuOpen && !disabled
  const menuStyle = useFloatingPosition({
    open, anchorRef: triggerRef, contentRef: menuRef, placement: 'below-start', deps: [run.length]
  })
  const closeMenu = () => {
    setMenuOpen(false)
    triggerRef.current?.focus()
  }
  const menuKeyDown = useMenuKeyboard(menuRef, closeMenu)
  const openMenu = (index = selectedIndex) => {
    initialFocusRef.current = index
    device.onRefresh()
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

  const Icon = node ? Server : Laptop
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`composer-workspace-device-btn${open ? ' open' : ''}`}
        title={`Run on ${label}`}
        aria-label="Run on"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-node={node ?? ''}
        disabled={disabled}
        onClick={() => open ? closeMenu() : openMenu()}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            openMenu(event.key === 'ArrowUp' ? run.length - 1 : selectedIndex)
          }
        }}
      >
        <Icon size={16} aria-hidden="true" />
        <span>{label}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <FloatingPortal>
          <div
            ref={menuRef}
            id={menuId}
            className="composer-workspace-menu composer-workspace-device-menu scrollbar-ultra-thin"
            role="menu"
            aria-label="Run on"
            style={menuStyle}
            onKeyDown={menuKeyDown}
          >
            <div className="composer-workspace-menu-label" aria-hidden="true">Run on</div>
            {run.map((option, index) => {
              const RowIcon = option.id === LOCAL_RUN_ON_ID ? Laptop : Server
              return (
                <button
                  key={option.id}
                  ref={(element) => { itemRefs.current[index] = element }}
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
                    closeMenu()
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
