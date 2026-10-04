import { useCallback, useEffect, useRef, useState } from 'react'
import { errorDiagnostic, knownAppError, normalizeAppError, parseErrorInfo, type AppErrorShape } from '../../shared/errors'
import type { TrashRetentionPolicy } from '../../shared/resourceLifecycle'

export function StorageSettings() {
  const [policy, setPolicy] = useState<TrashRetentionPolicy>({ schemaVersion: 1, graceDays: 30, automaticPurge: false })
  const [savedPolicy, setSavedPolicy] = useState<TrashRetentionPolicy>()
  const [suspended, setSuspended] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sweepReason, setSweepReason] = useState('')
  const mounted = useRef(true)
  const dirty = useRef(false)
  const busyRef = useRef(false)
  const inFlight = useRef<Promise<void> | null>(null)
  const reload = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current
    const request = window.mousse.threads.inventory().then((result) => {
      if (!mounted.current) return
      setSavedPolicy(result.trashPolicy)
      if (!dirty.current) setPolicy(result.trashPolicy)
      setSweepReason(result.trashSweepStatus.reason ?? '')
      setSuspended(result.trashSweepStatus.suspended)
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
    if (mounted.current) setError('Unable to refresh storage inventory. Please try again.')
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
  const run = async (work: () => Promise<unknown>, savePolicy = false) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true); setError('')
    try {
      // Finish any older snapshot before the mutation; refresh afterwards.
      await inFlight.current?.catch(() => {})
      await work()
      if (savePolicy) dirty.current = false
      await reload()
    } catch (cause) {
      showError(cause)
      await reload().catch(() => {})
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return <section className="settings-section storage-settings">
    <h2>Storage and trash</h2>
    <p className="settings-section-desc">Configure global trash retention and automatic cleanup.</p>
    <div className="storage-policy">
      <h3>Trash retention</h3>
      <label className="storage-grace-field"><span>Grace period <span className="storage-muted">(days)</span></span><input className="settings-input" aria-label="Trash grace period in days" type="number" min={1} max={3650} value={policy.graceDays} disabled={busy} onChange={(event) => { dirty.current = true; setPolicy({ ...policy, graceDays: Number(event.target.value) }) }} /></label>
      <label className="storage-checkbox"><input type="checkbox" checked={policy.automaticPurge} disabled={busy} onChange={(event) => { dirty.current = true; setPolicy({ ...policy, automaticPurge: event.target.checked }) }} /><span>Automatically purge eligible trash after the grace period</span></label>
      <button className="settings-inline-btn" disabled={busy} onClick={() => void run(() => window.mousse.threads.configureTrash(policy), true)}>Save trash policy</button>
    </div>
    <p>Trash remains restorable for review. Undo has its own retention window. Retained conversations and Git history reachable from other branches are separate from reclaimable checkout files.</p>
    <p>Automatic cleanup retains unpublished results and any files that need a human discard decision. Permanent deletion cannot be undone once it starts.</p>
    {error && <p role="alert">{error}</p>}
    {savedPolicy && <p role="status">Automatic cleanup: {!savedPolicy.automaticPurge ? 'off' : suspended ? 'suspended' : 'enabled'}.</p>}
    {sweepReason && <p role="status">{sweepReason}</p>}
  </section>
}
