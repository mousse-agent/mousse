import { useInboxShowsThread } from './automations/inbox/inboxStore'
import { ProjectTerminalPanel } from './ProjectTerminalPanel'
import { BrowserPanel } from './BrowserPanel'
import { FilesPanel } from './FilesPanel'
import { ChangesPanel } from './changes/ChangesPanel'
import { PullRequestPanel } from './PullRequestPanel'
import { DocumentPanel } from './DocumentPanel'
import { KeepMounted, KeepMountedStack } from './KeepMounted'
import { useAppStore } from '../stores/appStore'
import { surfaceTabItems } from '../lib/surfaces'
import { OpenSurfacePicker } from './OpenSurfaceMenu'
import { ComputerSurfaceNote } from './ComputerSurfaceNote'

/**
 * The panel area's tabs. `open` is false while the panel is closed: it then stays mounted, faded out, for terminals
 * and browser guests, so every other tab draws nothing until it opens again.
 */
export function MainViewPanel({ open = true }: { open?: boolean }) {
  const selectedView = useAppStore((s) => s.mainView)
  const mainAreaOpen = useAppStore((s) => s.mainAreaOpen) && open
  // The Automations page covers the panel, except while it shows a run's thread (the panel then serves that thread).
  const inboxThread = useInboxShowsThread()
  const overlayOpen = useAppStore((s) => s.settingsOpen || s.usageOpen || (s.scheduledOpen && !inboxThread))
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const opened = useAppStore((s) => s.openedSurfaceKinds)
  const terminals = useAppStore((s) => s.projectTerminalTabs)
  const browsers = useAppStore((s) => s.browserTabs)
  const documentTabs = useAppStore((s) => s.documentTabs)
  const documentsTabVisible = useAppStore((s) => s.documentsTabVisible)
  const documents = documentsTabVisible ? documentTabs : []
  const items = surfaceTabItems({
    opened,
    terminals: terminals.filter((tab) => tab.ownerThreadId === activeThreadId || tab.ownerThreadId === null),
    browsers: browsers.filter((tab) => tab.ownerThreadId === activeThreadId || tab.ownerThreadId === null),
    documents
  })
  // A thread without surfaces shows the picker, but every thread's terminals and
  // browser guests stay mounted: an agent's tab must load and attach while hidden.
  const empty = items.length === 0
  const mainView = empty ? null : selectedView

  const transientPanel = (() => {
    if (!mainAreaOpen || overlayOpen) return null
    if (empty) return <OpenSurfacePicker />
    switch (mainView) {
      case 'git': return <ChangesPanel />
      case 'pullRequest': return <PullRequestPanel />
      case 'documents': return <DocumentPanel />
      default: return null
    }
  })()

  return (
    <KeepMountedStack>
      {/* xterm keeps its scrollback while another tab shows. The Files tab keeps open files and their edits, but its
          tree and editor unmount until it shows again; they come back with their open folders, scroll and selection. */}
      <KeepMounted active={mainView === 'files'} className="keep-mounted-pane">
        <FilesPanel showing={mainView === 'files' && mainAreaOpen && !overlayOpen} />
      </KeepMounted>
      <KeepMounted active={mainView === 'terminal'} className="keep-mounted-pane">
        <ProjectTerminalPanel />
      </KeepMounted>
      <KeepMounted active={mainView === 'browser'} preserveLayout className="keep-mounted-pane">
        <BrowserPanel active={mainView === 'browser' && mainAreaOpen && !overlayOpen} />
      </KeepMounted>
      {mainView !== 'files' && mainView !== 'terminal' && mainView !== 'browser' && (
        <div className="keep-mounted-pane">{transientPanel}</div>
      )}
      {!empty && <ComputerSurfaceNote />}
    </KeepMountedStack>
  )
}
