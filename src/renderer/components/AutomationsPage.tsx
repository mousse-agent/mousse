import { useEffect, useRef } from 'react'
import { useAppStore } from '../stores/appStore'
import { AutomationsInbox } from './automations/inbox/AutomationsInbox'
import { inboxPageClosed, inboxPageOpened, useInboxShowsThread, useInboxStore } from './automations/inbox/inboxStore'
import '../styles/automations-page.css'

/**
 * The Automations rail page: the Runs list in the Chats sidebar's place, and beside it the open run's thread (the
 * workspace, laid out by the App) or the page's own pane (Manage, Edit details, the drafts).
 */
export function AutomationsPage() {
  const open = useAppStore((s) => s.scheduledOpen)
  const profileId = useAppStore((s) => s.profileId)
  const showsThread = useInboxShowsThread()
  const pageRef = useRef<HTMLDivElement>(null)
  // The page takes focus when it opens, so its page-scoped keys (⌘N, j/k) work at once; a click inside keeps it there.
  useEffect(() => {
    if (open && !pageRef.current?.contains(document.activeElement)) pageRef.current?.focus({ preventScroll: true })
  }, [open])
  // Chats gets its thread back when the page closes, if the page opened a run's thread over it.
  useEffect(() => {
    if (!open) return
    inboxPageOpened()
    return inboxPageClosed
  }, [open])
  // Another profile: another inbox.
  useEffect(() => {
    useInboxStore.setState({ index: null, inbox: null, counts: null, loadedAt: 0, filter: {}, openRunId: null, pane: 'run', editJobId: null, manageExpanded: null, composing: null })
  }, [profileId])
  return (
    <div ref={pageRef} className="automations-page" hidden={!open} tabIndex={-1} data-automations-workspace="" data-view="inbox" data-thread={showsThread || undefined}>
      <div className="automations-page-body">
        <AutomationsInbox key={profileId} active={open} />
      </div>
    </div>
  )
}
