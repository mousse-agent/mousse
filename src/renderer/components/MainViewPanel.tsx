import { AgentsWorkspace } from './AgentsWorkspace'
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

  // xterm owns its scrollback in the mounted Terminal instance. Keep this panel
  // alive across app-tab and thread switches; remounting it loses terminal history.
  const transientPanel = (() => {
    switch (mainView) {
      case 'browser': return <BrowserPanel />
      case 'files': return <FilesPanel />
      case 'git': return <GitPanel />
      case 'documents': return <DocumentPanel />
      default: return null
    }
  })()

  return (
    <KeepMountedStack>
      <KeepMounted active={mainView === 'terminal'} className="keep-mounted-pane">
        <ProjectTerminalPanel />
      </KeepMounted>
      <KeepMounted active={mainView === 'agents'} className="keep-mounted-pane">
        <AgentsWorkspace active={mainView === 'agents' && mainAreaOpen} />
      </KeepMounted>
      {mainView !== 'terminal' && mainView !== 'agents' && (
        <div className="keep-mounted-pane">{transientPanel}</div>
      )}
    </KeepMountedStack>
  )
}
