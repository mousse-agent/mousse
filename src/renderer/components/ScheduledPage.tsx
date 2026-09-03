import { useCallback } from 'react'
import { ArrowLeft, Clock } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { ScheduledPanel } from './ScheduledPanel'
import '../styles/scheduled-panel.css'

export function ScheduledPage() {
  const scheduledOpen = useAppStore((s) => s.scheduledOpen)
  const setScheduledOpen = useAppStore((s) => s.setScheduledOpen)

  const closeScheduled = useCallback(() => {
    setScheduledOpen(false)
  }, [setScheduledOpen])

  return (
    <div className="scheduled-page overlay-page" hidden={!scheduledOpen}>
      <header className="scheduled-page-header overlay-page-drag-header">
        <button type="button" className="scheduled-page-back-btn" onClick={closeScheduled}>
          <ArrowLeft size={16} strokeWidth={2} />
          Back
        </button>
        <div className="scheduled-page-title">
          <span className="scheduled-page-title-icon">
            <Clock size={15} strokeWidth={2} aria-hidden="true" />
          </span>
          <h1>Scheduled</h1>
        </div>
      </header>
      <div className="scheduled-page-body">
        <ScheduledPanel />
      </div>
    </div>
  )
}
