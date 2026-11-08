import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { useAutomationCreate } from '../stores/automationCreateStore'
import { AutomationsList } from './automations/AutomationsList'
import { LibraryView } from './automations/LibraryView'
import '../styles/automations-page.css'

/**
 * The Automations rail page: what runs on its own, in one list. Its header's Library link opens the saved agents and
 * workflows full width, with Back.
 */
export function AutomationsPage() {
  const open = useAppStore((s) => s.scheduledOpen)
  const profileId = useAppStore((s) => s.profileId)
  const [view, setView] = useState<'list' | 'library'>('list')
  const pageRef = useRef<HTMLDivElement>(null)
  // Automate… and Repeat this… open the list, where the create row takes what they carry.
  const createRequest = useAutomationCreate((state) => state.request)
  useEffect(() => { if (createRequest) setView('list') }, [createRequest])
  // The page takes focus when it opens, so its page-scoped keys (⌘N) work at once; a click inside keeps it there.
  useEffect(() => {
    if (open && !pageRef.current?.contains(document.activeElement)) pageRef.current?.focus({ preventScroll: true })
  }, [open])
  return (
    <div ref={pageRef} className="automations-page" hidden={!open} tabIndex={-1} data-automations-workspace="" data-view={view}>
      <div className="automations-page-body">
        {view === 'library'
          ? <LibraryView active={open} onBack={() => setView('list')} />
          : <AutomationsList key={profileId} active={open} onOpenLibrary={() => setView('library')} />}
      </div>
    </div>
  )
}
