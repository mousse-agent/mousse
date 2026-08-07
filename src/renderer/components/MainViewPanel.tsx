import { AgentsPanel } from './AgentsPanel'
import { ProjectTerminalPanel } from './ProjectTerminalPanel'
import { BrowserPanel } from './BrowserPanel'
import { FilesPanel } from './FilesPanel'
import { GitPanel } from './GitPanel'
import { DocumentPanel } from './DocumentPanel'
import { useAppStore } from '../stores/appStore'

export function MainViewPanel() {
  const mainView = useAppStore((s) => s.mainView)

  // Heavy panels own webviews, xterm instances, file watchers, and polling effects.
  // Mounting all six at startup kept those resources alive even while hidden.
  switch (mainView) {
    case 'browser':
      return <BrowserPanel />
    case 'terminal':
      return <ProjectTerminalPanel />
    case 'files':
      return <FilesPanel />
    case 'git':
      return <GitPanel />
    case 'documents':
      return <DocumentPanel />
    case 'agents':
    default:
      return <AgentsPanel />
  }
}
