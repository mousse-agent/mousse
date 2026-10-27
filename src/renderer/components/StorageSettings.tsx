import { useCallback, useEffect, useRef, useState } from 'react'
import { errorDiagnostic, knownAppError, normalizeAppError, parseErrorInfo, type AppErrorShape } from '../../shared/errors'
import type { TaskLifecycleRecord, TrashRetentionPolicy } from '../../shared/resourceLifecycle'
import { storagePolicyHasRule, type StoragePolicy } from '../../shared/storage'
import { parseStoragePolicy, parseStoragePolicyReply } from '../../shared/storageReply'
import { trashCount } from '../lib/trashInventory'
import { setStorageReviewPending } from '../lib/storageReview'
import { RecommendedRulesNotice, recommendedPolicy } from './storage/RecommendedRules'
import { StorageCleanupSection } from './storage/StorageCleanupSection'
import { StoragePolicyRows } from './storage/StoragePolicyRows'
import { StorageUsageSection } from './storage/StorageUsageSection'
import '../styles/storage.css'

export function StorageSettings() {
  const [records, setRecords] = useState<TaskLifecycleRecord[]>([])
  const [trash, setTrash] = useState<TrashRetentionPolicy>()
  const [trashPaused, setTrashPaused] = useState(false)
  const [policy, setPolicy] = useState<StoragePolicy>()
  const [storagePaused, setStoragePaused] = useState(false)
  const [reviewRecommended, setReviewRecommended] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [usageKey, setUsageKey] = useState(0)
  const mounted = useRef(true)
  const busyRef = useRef(false)
  const inFlight = useRef<Promise<void> | null>(null)
  const reload = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current
    const request = Promise.all([window.mousse.threads.inventory(), window.mousse.storage.policy()]).then(([inventory, stored]) => {
      // A reply that does not look like a policy is refused before it reaches a control.
      const reply = parseStoragePolicyReply(stored)
      if (!mounted.current) return
      setRecords(inventory.lifecycles)
      setTrash(reply.trash)
      setTrashPaused(reply.trashSweepStatus.suspended)
      setPolicy(reply.policy)
      setStoragePaused(reply.clockSuspended)
      setReviewRecommended(reply.reviewRecommended)
      setStorageReviewPending(reply.reviewRecommended)
    }).finally(() => { if (inFlight.current === request) inFlight.current = null })
    inFlight.current = request
    return request
  }, [])
  const showError = useCallback((cause: unknown) => {
    const shape = cause as Partial<AppErrorShape> | null
    const descriptor = shape && typeof shape.code === 'string' && typeof shape.message === 'string' && parseErrorInfo(shape.errorInfo)
      ? knownAppError(shape as AppErrorShape)
      : normalizeAppError(cause, 'storage_request_failed')
    console.error('Storage request failed', errorDiagnostic(descriptor, 'storage.request'))
    if (mounted.current) setError(descriptor.message)
  }, [])
  const showRefreshError = useCallback((cause: unknown) => {
    console.error('Storage refresh failed', errorDiagnostic(normalizeAppError(cause, 'storage_refresh_failed'), 'storage.inventory'))
    if (mounted.current) setError('Unable to refresh storage. Please try again.')
  }, [])
  useEffect(() => {
    mounted.current = true
    const refresh = () => {
      if (!document.hidden && !busyRef.current) void reload().catch(showRefreshError)
    }
    refresh()
    const timer = window.setInterval(refresh, 5000)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      mounted.current = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [reload, showRefreshError])
  const run = async (work: () => Promise<unknown>) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true); setError('')
    try {
      // Finish any older snapshot before the mutation; refresh afterwards.
      await inFlight.current?.catch(() => {})
      await work()
      await reload()
    } catch (cause) {
      showError(cause)
      await reload().catch(() => {})
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const saveTrash = (next: TrashRetentionPolicy) => void run(async () => {
    setTrash(next)
    await window.mousse.threads.configureTrash(next)
  })
  // Saving also lifts a clock pause on the time-based rules, so Resume is the same call with the same values.
  const savePolicy = (next: StoragePolicy) => void run(async () => {
    setPolicy(next)
    const saved = await window.mousse.storage.configure(next)
    if (mounted.current) setPolicy(parseStoragePolicy(saved.policy))
  })

  // Dismissing leaves every rule as it is; turning the recommended rules on is an ordinary save.
  const dismissReview = () => void run(async () => { await window.mousse.storage.reviewDismiss() })
  const hasRule = Boolean(policy && trash && storagePolicyHasRule(policy, trash))

  return <section className="settings-section storage-settings">
    {reviewRecommended && policy && <RecommendedRulesNotice busy={busy} onTurnOn={() => savePolicy(recommendedPolicy(policy))} onDismiss={dismissReview} />}
    <StoragePolicyRows
      trash={trash}
      policy={policy}
      trashPaused={Boolean(trash?.automaticPurge && trashPaused)}
      storagePaused={storagePaused}
      busy={busy}
      trashCount={trashCount(records)}
      onTrash={saveTrash}
      onPolicy={savePolicy}
      onResumeTrash={() => { if (trash) saveTrash(trash) }}
      onResumeStorage={() => { if (policy) savePolicy(policy) }}
    />
    {error && <p className="storage-error" role="alert">{error}</p>}

    <StorageUsageSection refreshKey={usageKey} />
    <StorageCleanupSection hasRule={hasRule} onDone={() => { setUsageKey((key) => key + 1); void reload().catch(showRefreshError) }} />
  </section>
}
