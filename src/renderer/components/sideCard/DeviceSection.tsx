import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { focusInitialMenuItem, useMenuKeyboard } from '../../hooks/useMenuKeyboard'
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss'
import { FloatingPortal, useFloatingPosition } from '../../lib/floatingLayer'
import { Check, ChevronDown, Folder, FolderPlus, Laptop, Server } from '../../lib/icons'
import { readDevices, type Device } from '../../lib/netDevices'
import { composerWorkspaceFor, isComposerWorkspaceLocked, isNewEmptyThread } from '../../lib/newThread'
import { useAppStore } from '../../stores/appStore'
import {
  buildDeviceMenu,
  hasDeviceChoices,
  localDeviceName,
  menuRowLabel,
  workspaceDraftForChoice,
  type WorkspaceChoice
} from './deviceMenu'
import { SideCardSection, type SideCardSectionContext } from './SideCardSection'
import './deviceSection.css'

const WORKSPACE_ICONS = { checkout: Folder, worktree: FolderPlus } as const

/**
 * Name of the computer the thread runs on. Plain text once the thread has
 * started, while a send is in flight, or when there is nothing to pick; on a
 * new, empty thread it opens a menu to pick where it runs and whether it
 * starts in a new worktree.
 */
export function DeviceSection({ threadId }: SideCardSectionContext) {
  const name = useAppStore((s) => localDeviceName(s.appInfo?.deviceName))
  const isNew = useAppStore((s) => isNewEmptyThread(
    s.activeThreadId,
    s.threads.find((thread) => thread.id === s.activeThreadId),
    s.messages.length
  ))
  const locked = useAppStore(isComposerWorkspaceLocked)
  return (
    <SideCardSection title="Device" threadId={threadId}>
      {isNew
        ? <DeviceMenuButton threadId={threadId} name={name} locked={locked} />
        : <DeviceName name={name} />}
    </SideCardSection>
  )
}

function DeviceName({ name }: { name: string }) {
  return <p className="side-card-device-name" title={name}>{name}</p>
}

function DeviceMenuButton({ threadId, name, locked }: { threadId: string | null; name: string; locked: boolean }) {
  const draft = useAppStore((s) => s.composerWorkspaceDrafts[s.activeThreadId ?? '__blank__'])
  const thread = useAppStore((s) => s.threads.find((entry) => entry.id === s.activeThreadId))
  const setComposerWorkspaceDraft = useAppStore((s) => s.setComposerWorkspaceDraft)
  const workspace = composerWorkspaceFor(draft, thread)

  const [menuOpen, setOpen] = useState(false)
  const [devices, setDevices] = useState<Device[]>([])
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const model = buildDeviceMenu({ localName: name, devices, workspace })
  // Nothing to pick without a project or another device, and nothing can change mid-send.
  const interactive = !locked && hasDeviceChoices(model)
  const open = menuOpen && interactive
  const menuStyle = useFloatingPosition({
    open,
    anchorRef: triggerRef,
    contentRef: menuRef,
    placement: 'below-start',
    deps: [model.runOn?.length ?? 0]
  })

  const close = useCallback(() => setOpen(false), [])
  const dismissRefs = useMemo(() => [triggerRef, menuRef], [])
  useOutsideDismiss(open, dismissRefs, close)

  // Devices are read when the menu opens, not in the background.
  useEffect(() => {
    if (!open) return
    let active = true
    readDevices(false).then(
      ({ nodes }) => { if (active) setDevices(nodes) },
      () => { if (active) setDevices([]) }
    )
    return () => { active = false }
  }, [open])

  useEffect(() => {
    if (open && menuStyle.visibility === 'visible') focusInitialMenuItem(menuRef.current)
  }, [open, menuStyle.visibility])

  // Escape closes through the window-level path above when focus is outside
  // the menu; the button gets focus back either way.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') triggerRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const closeAndFocus = useCallback(() => {
    setOpen(false)
    triggerRef.current?.focus()
  }, [])
  const menuKeyDown = useMenuKeyboard(menuRef, closeAndFocus)
  const chooseWorkspace = (choice: WorkspaceChoice) => {
    setComposerWorkspaceDraft(threadId, workspaceDraftForChoice(workspace, choice))
    closeAndFocus()
  }

  if (!interactive) return <DeviceName name={name} />

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`side-card-device-button${open ? ' open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span className="side-card-device-label">{name}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <FloatingPortal>
          <div
            ref={menuRef}
            id={menuId}
            className="side-card-device-menu"
            role="menu"
            aria-label="Run on and workspace"
            style={menuStyle}
            onKeyDown={menuKeyDown}
          >
            {model.runOn && (
              <div role="group" aria-labelledby={`${menuId}-run-on`}>
                <div id={`${menuId}-run-on`} className="side-card-device-group-label">Run on</div>
                {model.runOn.map((option) => (
                  <MenuRow
                    key={option.id}
                    icon={option.id === 'local' ? Laptop : Server}
                    label={option.name}
                    active={option.active}
                    disabled={option.disabled}
                    reason={option.reason}
                    onSelect={closeAndFocus}
                  />
                ))}
                {model.runOnNote && (
                  <div className="side-card-device-note" aria-hidden="true">{model.runOnNote}</div>
                )}
              </div>
            )}
            <div role="group" aria-labelledby={`${menuId}-workspace`}>
              <div id={`${menuId}-workspace`} className="side-card-device-group-label">Workspace</div>
              {model.workspace.map((option) => (
                <MenuRow
                  key={option.id}
                  icon={WORKSPACE_ICONS[option.id]}
                  label={option.label}
                  active={option.active}
                  disabled={option.disabled}
                  reason={option.reason}
                  workspaceChoice={option.id}
                  onSelect={() => chooseWorkspace(option.id)}
                />
              ))}
            </div>
          </div>
        </FloatingPortal>
      )}
    </>
  )
}

/**
 * A radio row. A disabled row stays focusable so keyboard users can reach it and
 * hear why; activating it does nothing.
 */
function MenuRow({ icon: Icon, label, active, disabled, reason, workspaceChoice, onSelect }: {
  icon: typeof Laptop
  label: string
  active: boolean
  disabled: boolean
  reason?: string
  workspaceChoice?: WorkspaceChoice
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      tabIndex={-1}
      aria-checked={active}
      aria-disabled={disabled || undefined}
      aria-label={disabled ? menuRowLabel(label, reason) : undefined}
      title={disabled ? reason : undefined}
      className="side-card-device-item"
      data-workspace-choice={workspaceChoice}
      onClick={disabled ? undefined : onSelect}
    >
      <Icon size={14} aria-hidden="true" />
      <span className="side-card-device-item-label">{label}</span>
      {active && <Check size={13} className="side-card-device-check" aria-hidden="true" />}
    </button>
  )
}
