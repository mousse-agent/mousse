import { useEffect, useState } from 'react'
import { Clock } from '../lib/icons'
import { isThreadStarted } from '../../shared/threadTitle'
import { expiresAtAfter, expiresInLabel, isThreadExpired, threadExpiresAt } from '../../shared/threadExpiry'
import type { Thread } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { ExpiryMenu } from './ExpiryMenu'
import { SunglassesIcon } from './IncognitoGlasses'
import '../styles/private-threads.css'

interface ThreadModeBarViewProps {
  /** A started private thread; an empty one says so on its logo (EmptyThreadHeading). */
  localOnly: boolean
  /** When the thread deletes itself (its own expiry, or its root thread's for a subagent). */
  expiresAt?: string
  expiryStopsRun?: boolean
  /** The expiry can be changed here: a thread of this computer that is not a subagent. */
  editable: boolean
  now: number
  onExpiryChange: (expiresAt: string | null, stopsRun: boolean) => void
}

/**
 * Top of a private thread (`Thread.localOnly`) or one that deletes itself (`Thread.expiresAt`): a small pair
 * of sunglasses for a private thread, and when it is deleted, with a menu to extend or keep it.
 */
export function ThreadModeBarView({ localOnly, expiresAt, expiryStopsRun, editable, now, onExpiryChange }: ThreadModeBarViewProps) {
  if (!localOnly && !expiresAt) return null
  const expired = expiresAt !== undefined && Date.parse(expiresAt) <= now
  return (
    <div className="thread-mode-bar" role="status" data-mode={localOnly ? 'private' : 'expiring'}>
      {localOnly && (
        <span className="thread-mode-bar-part thread-mode-bar-private" role="img" aria-label="Incognito" title="Incognito · stays on this computer">
          <SunglassesIcon />
        </span>
      )}
      {expiresAt && (
        <span className="thread-mode-bar-part thread-mode-bar-expiry" data-expired={expired || undefined}>
          <Clock size={12} strokeWidth={2} aria-hidden="true" />
          <span className="thread-mode-bar-text" title={new Date(expiresAt).toLocaleString()}>
            {expired ? 'Expired · being deleted' : `Deletes ${expiresInLabel(expiresAt, now)}`}
            {!expired && expiryStopsRun && <span className="thread-mode-bar-detail"> · stops a running turn</span>}
          </span>
          {editable && !expired && (
            <ExpiryMenu
              triggerClassName="thread-mode-bar-button"
              triggerTitle="Change when this thread is deleted"
              trigger="Change"
              hasExpiry
              stopsRun={expiryStopsRun === true}
              onPick={(ms, stopsRun) => onExpiryChange(ms === null ? null : expiresAtAfter(ms, Date.now()), stopsRun)}
            />
          )}
        </span>
      )}
    </div>
  )
}

/** Shown above the selected thread when it is private or deletes itself. */
export function ThreadModeBar() {
  const thread = useAppStore((state) => state.threads.find((entry) => entry.id === state.activeThreadId))
  const threads = useAppStore((state) => state.threads)
  const upsertThread = useAppStore((state) => state.upsertThread)
  const [now, setNow] = useState(() => Date.now())
  const [error, setError] = useState<string | null>(null)
  const expiresAt = thread ? threadExpiresAt(thread, threads) : undefined
  // The remaining time is shown in minutes at best, so a tick a minute keeps it right.
  useEffect(() => {
    if (!expiresAt) return
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [expiresAt])
  if (!thread) return null
  const root: Thread | undefined = thread.lineage ? threads.find((entry) => entry.id === thread.lineage!.rootThreadId) : thread
  const editable = !thread.node && !thread.lineage && !isThreadExpired(thread, threads, now)
  return (
    <>
      <ThreadModeBarView
        localOnly={thread.localOnly === true && isThreadStarted(thread)}
        expiresAt={expiresAt}
        expiryStopsRun={(root ?? thread).expiryStopsRun === true}
        editable={editable}
        now={now}
        onExpiryChange={(next, stopsRun) => {
          setError(null)
          void window.mousse.threads.setExpiry(thread.id, next, stopsRun)
            .then((updated) => upsertThread(updated))
            .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
        }}
      />
      {error && <div className="thread-mode-bar thread-mode-bar-error" role="alert">{error}</div>}
    </>
  )
}
