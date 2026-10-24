import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss'
import { FloatingPortal, useFloatingPosition } from '../../lib/floatingLayer'
import { Check, ChevronDown, Folder, FolderPlus, Laptop, Server } from '../../lib/icons'
import { readDevices, type Device } from '../../lib/netDevices'
import { composerWorkspaceFor, isNewEmptyThread } from '../../lib/newThread'
import { useAppStore } from '../../stores/appStore'
import {
  buildDeviceMenu,
  localDeviceName,
  workspaceDraftForChoice,
  type WorkspaceChoice
} from './deviceMenu'
import { SideCardSection, type SideCardSectionContext } from './SideCardSection'
import './deviceSection.css'

const WORKSPACE_ICONS = { checkout: Folder, worktree: FolderPlus } as const

/**
 * Name of the computer the thread runs on. Plain text once the thread has
 * started; on a new, empty thread it opens a menu to pick where it runs and
 * whether it starts in a new worktree.
 */
export function DeviceSection({ threadId }: SideCardSectionContext) {
  const name = useAppStore((s) => localDeviceName(s.appInfo?.deviceName))
  const isNew = useAppStore((s) => isNewEmptyThread(
    s.activeThreadId,
    s.threads.find((thread) => thread.id === s.activeThreadId),
    s.messages.length
  ))
  return (
    <SideCardSection title="Device" threadId={threadId}>
      {isNew
        ? <DeviceMenuButton threadId={threadId} name={name} />
        : <p className="side-card-device-name" title={name}>{name}</p>}
    </SideCardSection>
  )
}

function DeviceMenuButton({ threadId, name }: { threadId: string | null; name: string }) {
  const draft = useAppStore((s) => s.composerWorkspaceDrafts[s.activeThreadId ?? '__blank__'])
  const thread = useAppStore((s) => s.threads.find((entry) => entry.id === s.activeThreadId))
  const setComposerWorkspaceDraft = useAppStore((s) => s.setComposerWorkspaceDraft)
  const workspace = composerWorkspaceFor(draft, thread)

  const [open, setOpen] = useState(false)
  const [devices, setDevices] = useState<Device[]>([])
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const model = buildDeviceMenu({ localName: name, devices, workspace })
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
    if (!open || menuStyle.visibility !== 'visible') return
    const items = enabledItems(menuRef.current)
    const checked = items.find((item) => item.getAttribute('aria-checked') === 'true')
    ;(checked ?? items[0])?.focus()
  }, [open, menuStyle.visibility])

  const closeAndFocus = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }
  const chooseWorkspace = (choice: WorkspaceChoice) => {
    setComposerWorkspaceDraft(threadId, workspaceDraftForChoice(workspace, choice))
    closeAndFocus()
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`side-card-device-button${open ? ' open' : ''}`}
        title={name}
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
            onKeyDown={(event) => {
              const items = enabledItems(menuRef.current)
              const index = items.indexOf(document.activeElement as HTMLButtonElement)
              let next: number | undefined
              if (event.key === 'ArrowDown') next = (index + 1) % items.length
              if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length
              if (event.key === 'Home') next = 0
              if (event.key === 'End') next = items.length - 1
              if (next !== undefined) {
                event.preventDefault()
                items[next]?.focus()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                closeAndFocus()
              } else if (event.key === 'Tab') close()
            }}
          >
            {model.runOn && (
              <div role="group" aria-labelledby={`${menuId}-run-on`}>
                <div id={`${menuId}-run-on`} className="side-card-device-group-label">Run on</div>
                {model.runOn.map((option) => {
                  const Icon = option.id === 'local' ? Laptop : Server
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="menuitemradio"
                      tabIndex={-1}
                      aria-checked={option.active}
                      disabled={option.disabled}
                      className="side-card-device-item"
                      onClick={closeAndFocus}
                    >
                      <Icon size={14} aria-hidden="true" />
                      <span className="side-card-device-item-label">{option.name}</span>
                      {option.hint && <span className="side-card-device-item-hint">{option.hint}</span>}
                      {option.active && <Check size={13} className="side-card-device-check" aria-hidden="true" />}
                    </button>
                  )
                })}
              </div>
            )}
            <div role="group" aria-labelledby={`${menuId}-workspace`}>
              <div id={`${menuId}-workspace`} className="side-card-device-group-label">Workspace</div>
              {model.workspace.map((option) => {
                const Icon = WORKSPACE_ICONS[option.id]
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="menuitemradio"
                    tabIndex={-1}
                    aria-checked={option.active}
                    disabled={option.disabled}
                    className="side-card-device-item"
                    data-workspace-choice={option.id}
                    onClick={() => chooseWorkspace(option.id)}
                  >
                    <Icon size={14} aria-hidden="true" />
                    <span className="side-card-device-item-label">{option.label}</span>
                    {option.hint && <span className="side-card-device-item-hint">{option.hint}</span>}
                    {option.active && <Check size={13} className="side-card-device-check" aria-hidden="true" />}
                  </button>
                )
              })}
            </div>
          </div>
        </FloatingPortal>
      )}
    </>
  )
}

function enabledItems(menu: HTMLElement | null): HTMLButtonElement[] {
  return menu ? Array.from(menu.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]:not(:disabled)')) : []
}
