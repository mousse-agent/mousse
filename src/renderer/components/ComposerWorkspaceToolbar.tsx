import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, Folder, FolderPlus, GitBranch, Laptop, Server } from '../lib/icons'
import type { NodeId } from '../../shared/net'
import type { Project } from '../../shared/types'
import { useMenuKeyboard } from '../hooks/useMenuKeyboard'
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'
import type { Device } from '../lib/netDevices'
import type { ComposerWorkspace } from '../lib/newThread'
import { LOCAL_RUN_ON_ID, buildRunOnOptions, canPickComputer, runOnLabel } from './sideCard/deviceMenu'
import { RemoteProjectDialog } from './RemoteProjectDialog'
import '../styles/composer-workspace.css'

/** What the toolbar needs to offer other computers. Without it the computer is plain text. */
export interface ComposerDeviceProps {
  /** This computer's name. */
  localName: string
  /** The user's devices; phones and disconnected ones are left out of the menu. */
  devices: Device[]
  /** Called when the Run on menu opens, so the list is fresh. */
  onRefresh: () => void
  /** Picks where the chat runs; undefined is this computer. */
  onSelect: (node: NodeId | undefined) => void
  /** Asks the picked computer to open a folder as a project; resolves with its refusal, if any. */
  onOpenRemoteProject: (path: string) => Promise<string | undefined>
}

export function ComposerWorkspaceToolbar({ projects, workspace, disabled, device, onChange, onOpenProject, onError }: {
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
    <div className="composer-workspace-toolbar" role="group" aria-label="New chat workspace">
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
        <Folder size={16} aria-hidden="true" />
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
                  onChange({
                    projectId: entry.id || undefined,
                    worktreeEnabled: Boolean(entry.id && workspace.worktreeEnabled),
                    ...(workspace.node ? { node: workspace.node } : {})
                  })
                  closeMenu()
                }}
              >
                <Folder size={16} aria-hidden="true" />
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
              <span>Open project…</span>
            </button>
          </div>
        </FloatingPortal>
      )}
      {device && canPickComputer(device.devices, workspace.node)
        ? <ComposerDeviceButton device={device} node={workspace.node} disabled={disabled || opening} />
        : <span className="composer-workspace-device"><Laptop size={16} aria-hidden="true" />{device?.localName ?? 'This computer'}</span>}
      {remoteDialog && device && workspace.node && (
        <RemoteProjectDialog
          deviceName={runOnLabel(device.localName, device.devices, workspace.node)}
          recents={projects.map((entry) => entry.path)}
          onSubmit={device.onOpenRemoteProject}
          onClose={() => setRemoteDialog(false)}
        />
      )}
      <button
        type="button"
        className={`composer-icon-btn composer-workspace-worktree${worktreeEnabled ? ' active' : ''}`}
        title={!workspace.projectId ? 'Select a project to start in a worktree' : `Worktree: ${worktreeEnabled ? 'On' : 'Off'}`}
        aria-label="Start in a worktree"
        aria-pressed={worktreeEnabled}
        disabled={disabled || opening || !workspace.projectId}
        onClick={() => onChange({ ...workspace, worktreeEnabled: !worktreeEnabled })}
      >
        <GitBranch size={16} strokeWidth={1.8} aria-hidden="true" />
      </button>
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
  const run = buildRunOnOptions({ localName: device.localName, devices: device.devices, node })
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
