import { useState } from 'react'
import { useAppStore } from '../stores/appStore'
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
  return (
    <div className="automations-page" hidden={!open} data-automations-workspace="" data-view={view}>
      <div className="automations-page-body">
        {view === 'library'
          ? <LibraryView active={open} onBack={() => setView('list')} />
          : <AutomationsList key={profileId} active={open} onOpenLibrary={() => setView('library')} />}
      </div>
    </div>
  )
}
