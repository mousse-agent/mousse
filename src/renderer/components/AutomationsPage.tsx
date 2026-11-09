import { useEffect, useRef } from 'react'
import { useAppStore } from '../stores/appStore'
import { AutomationsList } from './automations/AutomationsList'
import { AutomationsInbox } from './automations/mock/AutomationsInbox'
import { isMockOn, useInboxMock } from './automations/mock/store'
import '../styles/automations-page.css'

/** The Automations rail page: the composer, then what runs on its own, in one list. */
export function AutomationsPage() {
  const open = useAppStore((s) => s.scheduledOpen)
  const profileId = useAppStore((s) => s.profileId)
  // UI mock-up of the Runs inbox (localStorage `mousse.automationsMock`); static data, not wired to the daemon.
  const mock = isMockOn(useInboxMock((s) => s.mode))
  const pageRef = useRef<HTMLDivElement>(null)
  // The page takes focus when it opens, so its page-scoped keys (⌘N) work at once; a click inside keeps it there.
  useEffect(() => {
    if (open && !pageRef.current?.contains(document.activeElement)) pageRef.current?.focus({ preventScroll: true })
  }, [open])
  return (
    <div ref={pageRef} className="automations-page" hidden={!open} tabIndex={-1} data-automations-workspace="" data-view={mock ? 'inbox' : 'list'}>
      <div className="automations-page-body">
        {mock ? <AutomationsInbox key={profileId} active={open} /> : <AutomationsList key={profileId} active={open} />}
      </div>
    </div>
  )
}
