import { AgentsPanel } from './AgentsPanel'
import { ProjectTerminalPanel } from './ProjectTerminalPanel'
import { BrowserPanel } from './BrowserPanel'
import { FilesPanel } from './FilesPanel'
import { GitPanel } from './GitPanel'
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
  const hasAgents = useAppStore((s) => s.agents.length > 0)
  const opened = useAppStore((s) => s.openedSurfaceKinds)
  const terminals = useAppStore((s) => s.projectTerminalTabs)
  const browsers = useAppStore((s) => s.browserTabs)
  const documentTabs = useAppStore((s) => s.documentTabs)
  const documentsTabVisible = useAppStore((s) => s.documentsTabVisible)
  const documents = documentsTabVisible ? documentTabs : []
  const items = surfaceTabItems({
    hasAgents,
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
      <KeepMounted active={mainView === 'agents'} className="keep-mounted-pane">
        <AgentsPanel />
      </KeepMounted>
      <KeepMounted active={mainView === 'browser'} preserveLayout className="keep-mounted-pane">
        <BrowserPanel active={mainView === 'browser' && mainAreaOpen && !overlayOpen} />
      </KeepMounted>
      {mainView !== 'files' && mainView !== 'terminal' && mainView !== 'agents' && mainView !== 'browser' && (
        <div className="keep-mounted-pane">{transientPanel}</div>
      )}
    </KeepMountedStack>
  )
}
