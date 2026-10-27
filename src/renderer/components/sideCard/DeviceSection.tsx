import { useEffect, useRef, useState } from 'react'
import type { NodeId } from '../../../shared/net'
import { FloatingPortal } from '../../lib/floatingLayer'
import { ChevronDown, Folder, FolderPlus, Laptop, Server } from '../../lib/icons'
import { useRemoteProjects, useRunOnDevices } from '../../hooks/useRunOnDevices'
import { workspaceOnDevice } from '../../lib/remoteComputers'
import { composerWorkspaceFor, isComposerWorkspaceLocked, isNewEmptyThread } from '../../lib/newThread'
import { useAppStore } from '../../stores/appStore'
import {
  LOCAL_RUN_ON_ID,
  buildDeviceMenu,
  hasDeviceChoices,
  localDeviceName,
  runOnLabel,
  workspaceDraftForChoice,
  type WorkspaceChoice
} from './deviceMenu'
import { OpenInEditor } from './EditorMenuButton'
import { SideCardMenuRow } from './SideCardMenuRow'
import { SideCardSection, type SideCardSectionContext } from './SideCardSection'
import { useSideCardMenu } from './useSideCardMenu'
import './deviceSection.css'

const WORKSPACE_ICONS = { checkout: Folder, worktree: FolderPlus } as const

const rowIcon = (Icon: typeof Laptop) => <Icon size={14} aria-hidden="true" />

/**
 * Name of the computer the thread runs on. Plain text once the thread has
 * started, while a send is in flight, or when there is nothing to pick; on a
 * new, empty thread it opens a menu to pick where it runs (this computer or a
 * connected one, as in the composer toolbar) and whether it starts in a new
 * worktree. A thread that has started cannot move to another computer, so it
 * only names the one it runs on. Below it, a local thread's folder opens in an editor.
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
      <OpenInEditor />
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
  const { devices, refresh } = useRunOnDevices()
  const localProjects = useAppStore((s) => s.projects)
  const remoteProjects = useRemoteProjects(workspace.node)
  const shownProjects = workspace.node ? remoteProjects.projects : localProjects
  const triggerRef = useRef<HTMLButtonElement>(null)
  const model = buildDeviceMenu({ localName: name, devices, workspace })
  const label = runOnLabel(name, devices, workspace.node)
  // Nothing to pick without a project or another device, and nothing can change mid-send.
  const interactive = !locked && hasDeviceChoices(model)
  const open = menuOpen && interactive
  const { menuRef, menuId, menuStyle, closeAndFocus, menuKeyDown, triggerKeyDown } = useSideCardMenu({
    open,
    setOpen,
    anchorRef: triggerRef,
    focusRef: triggerRef,
    sizeKey: model.runOn.length
  })

  // The list is read again each time the menu opens.
  useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  const chooseDevice = (id: string) => {
    closeAndFocus()
    const node = id === LOCAL_RUN_ON_ID ? undefined : id as NodeId
    if (node === workspace.node) return
    // The project carries over only when the picked computer has one at the same path.
    void workspaceOnDevice(workspace, shownProjects, localProjects, node).then(
      (next) => setComposerWorkspaceDraft(threadId, next),
      () => undefined
    )
  }

  const chooseWorkspace = (choice: WorkspaceChoice) => {
    setComposerWorkspaceDraft(threadId, workspaceDraftForChoice(workspace, choice))
    closeAndFocus()
  }

  if (!interactive) return <DeviceName name={label} />

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
        onKeyDown={triggerKeyDown}
      >
        <span className="side-card-device-label">{label}</span>
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
            {model.runOn.length > 0 && (
              <div role="group" aria-labelledby={`${menuId}-run-on`}>
                <div id={`${menuId}-run-on`} className="side-card-device-group-label">Run on</div>
                {model.runOn.map((option) => (
                  <SideCardMenuRow
                    key={option.id}
                    icon={rowIcon(option.id === 'local' ? Laptop : Server)}
                    label={option.name}
                    active={option.active}
                    disabled={option.disabled}
                    reason={option.reason}
                    onSelect={() => chooseDevice(option.id)}
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
                <SideCardMenuRow
                  key={option.id}
                  icon={rowIcon(WORKSPACE_ICONS[option.id])}
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
