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
import type { SideCardSectionContext } from './SideCardSection'
import { useSideCardMenu } from './useSideCardMenu'
import './deviceSection.css'

const WORKSPACE_ICONS = { checkout: Folder, worktree: FolderPlus } as const

const rowIcon = (Icon: typeof Laptop) => <Icon size={14} aria-hidden="true" />

/**
 * The card's header: one row with the project and the computer the thread runs on, and at its end the editor and
 * file manager the folder opens in on this computer. The computer's name is plain text once the thread has started,
 * while a send is in flight, or when there is nothing to pick; on a new, empty thread it opens a menu to pick where
 * it runs (this computer or a connected one, as in the composer toolbar) and whether it starts in a new worktree.
 * A thread that has started cannot move to another computer, so it only names the one it runs on. For a thread of
 * another computer the editor button sits under the row, with what it needs from that computer.
 */
export function DeviceSection({ threadId, projectId }: SideCardSectionContext) {
  const name = useAppStore((s) => localDeviceName(s.appInfo?.deviceName))
  const thread = useAppStore((s) => s.threads.find((entry) => entry.id === s.activeThreadId))
  const isNew = useAppStore((s) => isNewEmptyThread(
    s.activeThreadId,
    s.threads.find((entry) => entry.id === s.activeThreadId),
    s.messages.length
  ))
  const locked = useAppStore(isComposerWorkspaceLocked)
  const project = useAppStore((s) => (projectId ? s.projects.find((entry) => entry.id === projectId)?.name ?? null : null))
  const computer = useComputer(thread?.node)
  const remote = Boolean(thread?.node) && !isNew
  const computerName = remote ? computer?.name ?? UNKNOWN_COMPUTER_NAME : name
  const state = remote && thread ? threadComputerState(thread, computer) : 'online'
  const Icon = remote ? Server : Laptop
  return (
    <section className="side-card-section side-card-header" data-thread-id={threadId ?? undefined} aria-label="Computer">
      <div className="side-card-header-row">
        <Icon className="side-card-header-icon" size={14} aria-hidden="true" />
        {isNew
          ? <DeviceMenuButton threadId={threadId} name={name} locked={locked} />
          : <HeaderName project={project} computer={computerName} remote={remote} />}
        {state !== 'online' && <span className="side-card-header-tag">{state === 'offline' ? 'offline' : 'not sharing'}</span>}
        {!remote && <OpenInEditor compact />}
      </div>
      {state === 'offline' && <p className="side-card-computer-note">{offlineLabel(computer, Date.now())}</p>}
      {state === 'not-shared' && <p className="side-card-computer-note">{computerName} is not sharing its threads with this computer right now.</p>}
      {remote && <OpenInEditor />}
    </section>
  )
}

/**
 * The project, and the computer when it is another one ("acme-web · Mac mini"). On this computer the laptop icon
 * says where, so the name is left to the tooltip; a thread without a project shows the computer instead.
 */
function HeaderName({ project, computer, remote }: { project: string | null; computer: string; remote: boolean }) {
  const title = project ? `${project} on ${computer}` : computer
  return (
    <p className="side-card-device-name side-card-header-name" title={title}>
      {project && <span className="side-card-header-project">{project}</span>}
      {(remote || !project) && <span className="side-card-header-computer">{project ? ` · ${computer}` : computer}</span>}
    </p>
  )
}

function DeviceName({ name }: { name: string }) {
  return <p className="side-card-device-name" title={name}>{name}</p>
}

function DeviceMenuButton({ threadId, name, locked }: { threadId: string | null; name: string; locked: boolean }) {
  const draft = useAppStore((s) => s.composerWorkspaceDrafts[s.activeThreadId ?? '__blank__'])
  const thread = useAppStore((s) => s.threads.find((entry) => entry.id === s.activeThreadId))
  const setComposerWorkspaceDraft = useAppStore((s) => s.setComposerWorkspaceDraft)
  const worktreeByDefault = useAppStore((s) => s.worktreeByDefault)
  const workspace = composerWorkspaceFor(draft, thread, worktreeByDefault)

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
