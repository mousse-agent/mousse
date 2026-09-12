import { useCallback } from 'react'
import { ArrowLeft, Workflow } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { AutomationsWorkspace } from './AutomationsWorkspace'
import { confirmNavigation } from '../services/navigationGuards'
import '../styles/scheduled-panel.css'

export function ScheduledPage() {
  const scheduledOpen = useAppStore((s) => s.scheduledOpen)
  const setScheduledOpen = useAppStore((s) => s.setScheduledOpen)

  const closeScheduled = useCallback(async () => {
    if (await confirmNavigation()) setScheduledOpen(false)
  }, [setScheduledOpen])

  return (
    <div className="scheduled-page overlay-page" hidden={!scheduledOpen}>
      <header className="scheduled-page-header overlay-page-drag-header">
        <button type="button" className="scheduled-page-back-btn" onClick={() => void closeScheduled()}>
          <ArrowLeft size={16} strokeWidth={2} />
          Back
        </button>
        <div className="scheduled-page-title">
          <span className="scheduled-page-title-icon">
            <Workflow size={15} strokeWidth={2} aria-hidden="true" />
          </span>
          <h1>Automations</h1>
        </div>
      </header>
      <div className="scheduled-page-body">
        <AutomationsWorkspace active={scheduledOpen} />
      </div>
    </div>
  )
}
