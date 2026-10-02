import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, Folder, FolderPlus, GitBranch, Laptop } from 'lucide-react'
import type { Project } from '../../shared/types'
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'
import '../styles/composer-workspace.css'

export function ComposerWorkspaceToolbar({ projects, workspace, disabled, onChange, onOpenProject, onError }: {
  projects: Project[]
  workspace: { projectId?: string; worktreeEnabled: boolean }
  disabled: boolean
  onChange: (workspace: { projectId?: string; worktreeEnabled: boolean }) => void
  onOpenProject: () => Promise<void>
  onError: (message: string) => void
}) {
  const [opening, setOpening] = useState(false)
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
            onKeyDown={(event) => {
              const index = itemRefs.current.indexOf(document.activeElement as HTMLButtonElement)
              const count = choices.length + 1
              let next: number | undefined
              if (event.key === 'ArrowDown') next = (index + 1) % count
              if (event.key === 'ArrowUp') next = (index - 1 + count) % count
              if (event.key === 'Home') next = 0
              if (event.key === 'End') next = count - 1
              if (next !== undefined) {
                event.preventDefault()
                itemRefs.current[next]?.focus()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                closeMenu()
              } else if (event.key === 'Tab') closeMenu()
            }}
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
                  onChange({ projectId: entry.id || undefined, worktreeEnabled: Boolean(entry.id && workspace.worktreeEnabled) })
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
      <span className="composer-workspace-device"><Laptop size={16} aria-hidden="true" />This computer</span>
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
