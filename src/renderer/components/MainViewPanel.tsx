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

export function MainViewPanel() {
  const selectedView = useAppStore((s) => s.mainView)
  const mainAreaOpen = useAppStore((s) => s.mainAreaOpen)
  const overlayOpen = useAppStore((s) => s.settingsOpen || s.scheduledOpen || s.usageOpen)
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
      {/* Editors and xterm retain unsaved/model state while another action tab is active. */}
      <KeepMounted active={mainView === 'files'} className="keep-mounted-pane">
        <FilesPanel />
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
