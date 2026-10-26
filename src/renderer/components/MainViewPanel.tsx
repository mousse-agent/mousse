import { ProjectTerminalPanel } from './ProjectTerminalPanel'
import { BrowserPanel } from './BrowserPanel'
import { FilesPanel } from './FilesPanel'
import { GitPanel } from './GitPanel'
import { ReviewPanel } from './review/ReviewPanel'
import { DocumentPanel } from './DocumentPanel'
import { KeepMounted, KeepMountedStack } from './KeepMounted'
import { useAppStore } from '../stores/appStore'
import { surfaceTabItems } from '../lib/surfaces'
import { OpenSurfacePicker } from './OpenSurfaceMenu'

export function MainViewPanel() {
  const mainView = useAppStore((s) => s.mainView)
  const mainAreaOpen = useAppStore((s) => s.mainAreaOpen)
  const overlayOpen = useAppStore((s) => s.settingsOpen || s.scheduledOpen || s.channelsOpen)
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
  if (items.length === 0) {
    return (
      <div className="keep-mounted-pane">
        <OpenSurfacePicker />
      </div>
    )
  }

  const transientPanel = (() => {
    switch (mainView) {
      case 'git': return <GitPanel />
      case 'review': return <ReviewPanel />
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
    </KeepMountedStack>
  )
}
