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

  return (
    <KeepMountedStack>
      <KeepMounted active={mainView === 'agents'} className="keep-mounted-pane">
        <AgentsPanel />
      </KeepMounted>
      <KeepMounted active={mainView === 'browser'} className="keep-mounted-pane">
        <BrowserPanel />
      </KeepMounted>
      <KeepMounted active={mainView === 'terminal'} className="keep-mounted-pane">
        <ProjectTerminalPanel />
      </KeepMounted>
      <KeepMounted active={mainView === 'files'} className="keep-mounted-pane">
        <FilesPanel />
      </KeepMounted>
      <KeepMounted active={mainView === 'git'} className="keep-mounted-pane">
        <GitPanel />
      </KeepMounted>
      <KeepMounted active={mainView === 'documents'} className="keep-mounted-pane">
        <DocumentPanel />
      </KeepMounted>
    </KeepMountedStack>
  )
}
