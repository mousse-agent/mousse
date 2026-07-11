import { Bot, Globe, Terminal, FolderOpen, GitBranch, FileText, type LucideIcon } from 'lucide-react'
import { useEffect } from 'react'
import type { MainView } from '../../shared/types'
import { useActiveProjectPath } from '../hooks/useActiveProjectPath'
import { useAppStore } from '../stores/appStore'

const MAIN_VIEWS: Array<{
  id: MainView
  label: string
  icon: LucideIcon
  hiddenUntilUsed?: boolean
}> = [
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'browser', label: 'Browser', icon: Globe },
  { id: 'terminal', label: 'Terminal', icon: Terminal },
  { id: 'files', label: 'Files', icon: FolderOpen },
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'documents', label: 'Documents', icon: FileText, hiddenUntilUsed: true }
]

export function MainViewTabs() {
  const mainView = useAppStore((s) => s.mainView)
  const setMainView = useAppStore((s) => s.setMainView)
  const documentsTabVisible = useAppStore((s) => s.documentsTabVisible)
  const selectedProject = useActiveProjectPath()

  const visibleViews = MAIN_VIEWS.filter((view) => {
    if (view.hiddenUntilUsed && !documentsTabVisible) return false
    if (!selectedProject && (view.id === 'git' || view.id === 'files')) return false
    return true
  })

  useEffect(() => {
    if ((mainView === 'git' || mainView === 'files') && !selectedProject) {
      setMainView('agents')
    }
  }, [mainView, selectedProject, setMainView])

  return (
    <nav className="main-view-tabs" aria-label="Main area view">
      {visibleViews.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          className={`main-view-tab${mainView === id ? ' active' : ''}`}
          aria-current={mainView === id ? 'page' : undefined}
          aria-label={label}
          title={label}
          onClick={() => setMainView(id)}
        >
          <Icon size={14} strokeWidth={2} className="main-view-tab-icon" />
          <span className="main-view-tab-label">{label}</span>
        </button>
      ))}
    </nav>
  )
}
