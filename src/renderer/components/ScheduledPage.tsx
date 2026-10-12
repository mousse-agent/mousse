import { useAppStore } from '../stores/appStore'
import { AutomationsWorkspace } from './AutomationsWorkspace'
import '../styles/scheduled-panel.css'

export function ScheduledPage() {
  const scheduledOpen = useAppStore((s) => s.scheduledOpen)
  return (
    <div className="scheduled-page" hidden={!scheduledOpen}>
      <header className="rail-page-header">
        <h1>Automations</h1>
      </header>
      <div className="scheduled-page-body">
        <AutomationsWorkspace active={scheduledOpen} />
      </div>
    </div>
  )
}
