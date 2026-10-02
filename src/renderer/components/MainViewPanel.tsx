import { AgentsPanel } from './AgentsPanel'
import { ProjectTerminalPanel } from './ProjectTerminalPanel'
import { BrowserPanel } from './BrowserPanel'
import { FilesPanel } from './FilesPanel'
import { GitPanel } from './GitPanel'
import { DocumentPanel } from './DocumentPanel'
import { KeepMounted, KeepMountedStack } from './KeepMounted'
import { useAppStore } from '../stores/appStore'

export function MainViewPanel() {
  const mainView = useAppStore((s) => s.mainView)
  const mainAreaOpen = useAppStore((s) => s.mainAreaOpen)

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
        <BrowserPanel active={mainView === 'browser' && mainAreaOpen} />
      </KeepMounted>
      {mainView !== 'files' && mainView !== 'terminal' && mainView !== 'agents' && mainView !== 'browser' && (
        <div className="keep-mounted-pane">{transientPanel}</div>
      )}
    </KeepMountedStack>
  )
}
