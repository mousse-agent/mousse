import { useEffect, useRef, useState } from 'react'
import type { NodeId } from '../../../shared/net'
import { FloatingPortal } from '../../lib/floatingLayer'
import { ChevronDown, Folder, FolderPlus, Laptop, Server } from '../../lib/icons'
import { useRunOnDevices } from '../../hooks/useRunOnDevices'
import { workspaceOnDevice } from '../../lib/remoteComputers'
import { UNKNOWN_COMPUTER_NAME, offlineLabel, threadComputerState, useComputer } from '../../lib/computers'
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
 * Name of the computer the thread runs on ("This computer" locally, the other
 * computer's name, and whether it is offline, for a thread that runs there). Plain
 * text once the thread has started, while a send is in flight, or when there is
 * nothing to pick; on a new, empty thread it opens a menu to pick where it runs (this
 * computer or a connected one, as in the composer toolbar) and whether it starts in a
 * new worktree. A thread that has started cannot move to another computer, so it
 * only names the one it runs on. Below it, a thread's folder opens in an editor on
 * this computer; for a thread of another computer the item says where it would open.
 */
export function DeviceSection({ threadId }: SideCardSectionContext) {
  const name = useAppStore((s) => localDeviceName(s.appInfo?.deviceName))
  const thread = useAppStore((s) => s.threads.find((entry) => entry.id === s.activeThreadId))
  const isNew = useAppStore((s) => isNewEmptyThread(
    s.activeThreadId,
    s.threads.find((entry) => entry.id === s.activeThreadId),
    s.messages.length
  ))
  const locked = useAppStore(isComposerWorkspaceLocked)
  const computer = useComputer(thread?.node)
  return (
    <SideCardSection title="Computer" threadId={threadId}>
      {isNew
        ? <DeviceMenuButton threadId={threadId} name={name} locked={locked} />
        : thread?.node
          ? <ComputerName name={computer?.name ?? UNKNOWN_COMPUTER_NAME} state={threadComputerState(thread, computer)} detail={offlineLabel(computer, Date.now())} />
          : <DeviceName name={name} />}
      <OpenInEditor />
    </SideCardSection>
  )
}

function DeviceName({ name }: { name: string }) {
  return <p className="side-card-device-name" title={name}>{name}</p>
}

/** The other computer a thread runs on, with a note while it cannot be reached. */
function ComputerName({ name, state, detail }: { name: string; state: 'online' | 'offline' | 'not-shared'; detail: string }) {
  return (
    <>
      <p className="side-card-device-name" title={name}>{name}</p>
      {state === 'offline' && <p className="side-card-computer-note">{detail}</p>}
      {state === 'not-shared' && <p className="side-card-computer-note">{name} is not sharing its threads with this computer right now.</p>}
    </>
  )
}

function DeviceMenuButton({ threadId, name, locked }: { threadId: string | null; name: string; locked: boolean }) {
  const draft = useAppStore((s) => s.composerWorkspaceDrafts[s.activeThreadId ?? '__blank__'])
  const thread = useAppStore((s) => s.threads.find((entry) => entry.id === s.activeThreadId))
  const setComposerWorkspaceDraft = useAppStore((s) => s.setComposerWorkspaceDraft)
  const workspace = composerWorkspaceFor(draft, thread)

  const [menuOpen, setOpen] = useState(false)
  const { devices, notSharing, refresh } = useRunOnDevices()
  const localProjects = useAppStore((s) => s.projects)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const model = buildDeviceMenu({ localName: name, devices, workspace, notSharing })
  const label = runOnLabel(name, devices, workspace.node)
  // Nothing to pick without a project or another device, and nothing can change mid-send.
  const interactive = !locked && hasDeviceChoices(model)
  const open = menuOpen && interactive
  const { menuRef, menuId, menuStyle, closeAndFocus, menuKeyDown, triggerKeyDown } = useSideCardMenu({
    open,
    setOpen,
    anchorRef: triggerRef,
    focusRef: triggerRef,
    sizeKey: model.runOn?.length ?? 0
  })

  // The list is read again each time the menu opens.
  useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  const chooseDevice = (id: string) => {
    closeAndFocus()
    const node = id === LOCAL_RUN_ON_ID ? undefined : id as NodeId
    if (node === workspace.node) return
    // The project carries over only when the picked computer lists the same Git repository.
    setComposerWorkspaceDraft(threadId, workspaceOnDevice(workspace, localProjects, node))
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
            {model.runOn && (
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
