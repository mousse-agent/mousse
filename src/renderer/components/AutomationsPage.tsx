import { useEffect, useRef } from 'react'
import { useAppStore } from '../stores/appStore'
import { AutomationsList } from './automations/AutomationsList'
import '../styles/automations-page.css'

/** The Automations rail page: the composer, then what runs on its own, in one list. */
export function AutomationsPage() {
  const open = useAppStore((s) => s.scheduledOpen)
  const profileId = useAppStore((s) => s.profileId)
  const pageRef = useRef<HTMLDivElement>(null)
  // The page takes focus when it opens, so its page-scoped keys (⌘N) work at once; a click inside keeps it there.
  useEffect(() => {
    if (open && !pageRef.current?.contains(document.activeElement)) pageRef.current?.focus({ preventScroll: true })
  }, [open])
  return (
    <div ref={pageRef} className="automations-page" hidden={!open} tabIndex={-1} data-automations-workspace="" data-view="list">
      <div className="automations-page-body">
        <AutomationsList key={profileId} active={open} />
      </div>
    </div>
  )
}
