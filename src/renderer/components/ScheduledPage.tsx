import { useCallback } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { useWindowDrag } from '../hooks/useWindowDrag'
import { ScheduledPanel } from './ScheduledPanel'
import '../styles/scheduled-panel.css'

export function ScheduledPage() {
  const scheduledOpen = useAppStore((s) => s.scheduledOpen)
  const setScheduledOpen = useAppStore((s) => s.setScheduledOpen)
  const windowDrag = useWindowDrag()

  const closeScheduled = useCallback(() => {
    setScheduledOpen(false)
  }, [setScheduledOpen])

  return (
    <div className="scheduled-page overlay-page" hidden={!scheduledOpen}>
      <header className="scheduled-page-header overlay-page-drag-header" {...windowDrag}>        <button type="button" className="scheduled-page-back-btn" onClick={closeScheduled}>
          <ArrowLeft size={16} />
          Back
        </button>
        <h1>Scheduled</h1>
      </header>
      <div className="scheduled-page-body">
        <ScheduledPanel />
      </div>
    </div>
  )
}
