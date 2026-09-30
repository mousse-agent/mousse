import { useCallback, useEffect, useRef, useState } from 'react'
import { normalizeAppError } from '../../shared/errors'
import type { LifecyclePurgePreview, TaskLifecycleRecord, TrashRetentionPolicy } from '../../shared/resourceLifecycle'

export function StorageSettings() {
  const [records, setRecords] = useState<TaskLifecycleRecord[]>([])
  const [taskNames, setTaskNames] = useState<Record<string, string>>({})
  const [policy, setPolicy] = useState<TrashRetentionPolicy>({ schemaVersion: 1, graceDays: 30, automaticPurge: false })
  const [savedPolicy, setSavedPolicy] = useState<TrashRetentionPolicy>()
  const [suspended, setSuspended] = useState(false)
  const [preview, setPreview] = useState<LifecyclePurgePreview>()
  const [discard, setDiscard] = useState(false)
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
      setRecords(result.lifecycles)
      setTaskNames(result.taskNames ?? {})
      setSavedPolicy(result.trashPolicy)
      if (!dirty.current) setPolicy(result.trashPolicy)
      setSweepReason(result.trashSweepStatus.reason ?? '')
      setSuspended(result.trashSweepStatus.suspended)
    }).finally(() => { if (inFlight.current === request) inFlight.current = null })
    inFlight.current = request
    return request
  }, [])
  const showError = useCallback((cause: unknown) => {
    if (mounted.current) setError(normalizeAppError(cause, 'storage_request_failed').message)
  }, [])
  useEffect(() => {
    mounted.current = true
    const refresh = () => {
      if (!document.hidden && !busyRef.current) void reload().catch(showError)
    }
    refresh()
    const timer = window.setInterval(refresh, 5000)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      mounted.current = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [reload, showError])
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
  return <section className="settings-section">
    <h2>Storage and trash</h2>
    <p>Trash remains restorable for review. Undo has its own retention window. Retained conversations and Git history reachable from other branches are separate from reclaimable checkout files.</p>
    <div className="settings-row">
      <label>Trash grace period (days) <input className="settings-input" style={{ width: 90 }} aria-label="Trash grace period in days" type="number" min={1} max={3650} value={policy.graceDays} disabled={busy} onChange={(event) => { dirty.current = true; setPolicy({ ...policy, graceDays: Number(event.target.value) }) }} /></label>
      <label><input type="checkbox" checked={policy.automaticPurge} disabled={busy} onChange={(event) => { dirty.current = true; setPolicy({ ...policy, automaticPurge: event.target.checked }) }} /> Automatically purge eligible trash after the grace period</label>
      <button className="settings-inline-btn" disabled={busy} onClick={() => void run(() => window.mousse.threads.configureTrash(policy), true)}>Save trash policy</button>
    </div>
    <p>Automatic cleanup retains unpublished results and any files that need a human discard decision. Permanent deletion cannot be undone once it starts.</p>
    {error && <p role="alert">{error}</p>}
    {savedPolicy && <p role="status">Automatic cleanup: {!savedPolicy.automaticPurge ? 'off' : suspended ? 'suspended' : 'enabled'}.</p>}
    {sweepReason && <p role="status">{sweepReason}</p>}
    {records.filter((record) => !record.parentTaskId && record.state !== 'purged').map((record) => <div key={record.taskId} data-task-id={record.taskId} className="settings-row" style={{ display: 'block', marginBlock: 12 }}>
      <strong>{taskNames[record.taskId] ?? 'Task with unavailable title'}</strong>  /  {record.state}
      <div style={{ color: 'var(--text-secondary)', fontSize: 11, marginTop: 4 }}>Task ID: {record.taskId}</div>
      {record.state === 'trashed' && savedPolicy && <TrashDates record={record} graceDays={savedPolicy.graceDays} />}
      {record.blockedReason && <p role="status">{record.blockedReason}</p>}
      {record.purge && <p>{record.purge.items.filter((item) => item.status === 'removed').length} / {record.purge.items.length} resources removed. Restore is unavailable because permanent deletion has started.</p>}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        {record.state === 'active' && <button className="settings-inline-btn" disabled={busy} onClick={() => void run(() => window.mousse.threads.delete(record.taskId))}>Move to trash</button>}
        {record.state === 'trashed' && <button className="settings-inline-btn" disabled={busy} onClick={() => void run(() => window.mousse.threads.restore(record.taskId))}>Restore idle task</button>}
        {record.state === 'trashed' && <button className="settings-inline-btn" disabled={busy} onClick={() => void run(async () => { const result = await window.mousse.threads.purge(record.taskId, { preview: true }); setPreview(result.preview); setDiscard(false) })}>Review permanent deletion</button>}
        {record.state === 'purge-started' && <button className="settings-inline-btn" disabled={busy} onClick={() => void run(() => window.mousse.threads.purge(record.taskId, { operationId: record.purge!.operationId }))}>Retry cleanup</button>}
      </div>
    </div>)}
    {preview && <div role="dialog" aria-label="Permanent deletion preview" style={{ border: '1px solid currentColor', padding: 16, marginTop: 16 }}>
      <h3>Review permanent deletion: {taskNames[preview.taskId] ?? preview.taskId}</h3>
      <p>{preview.items.length} exclusive resources; {(preview.exclusiveBytes / 1024 / 1024).toFixed(2)} MiB of checkout and owned files. This excludes shared Git object storage.</p>
      <div style={{ maxHeight: 260, overflow: 'auto' }}>
        {preview.items.map((item) => <div key={item.id} style={{ marginBlock: 8, overflowWrap: 'anywhere' }}>{item.kind}: {item.identity}{item.discardRequired && <strong>  -  Discard required: {item.reason ?? 'unpublished content'}</strong>}{item.discardRequired && item.content && <details><summary>Files included in discard</summary>{item.content.filter((entry) => entry.kind !== 'directory').map((entry) => <div key={entry.path}>{entry.path} ({entry.bytes} bytes)</div>)}</details>}</div>)}
        {preview.retained.map((item) => <p key={item.identity}>Retained: {item.identity}  -  {item.reason}</p>)}
        {preview.blockers.map((reason) => <p key={reason} role="alert">Blocked: {reason}</p>)}
      </div>
      {preview.items.some((item) => item.discardRequired) && <label><input type="checkbox" checked={discard} onChange={(event) => setDiscard(event.target.checked)} /> I explicitly discard the listed unpublished results and sole-copy files.</label>}
      <p>Starting deletion permanently removes the listed content. You cannot restore or cancel after this boundary.</p>
      <button className="settings-inline-btn" disabled={busy} onClick={() => setPreview(undefined)}>Cancel</button>{' '}
      <button className="settings-inline-btn" disabled={busy || preview.blockers.length > 0 || preview.items.some((item) => item.discardRequired) && !discard} onClick={() => void run(async () => { await window.mousse.threads.purge(preview.taskId, { operationId: crypto.randomUUID(), expectedGeneration: preview.generation, previewDigest: preview.digest, discard }); setPreview(undefined) })}>Permanently delete</button>
    </div>}
  </section>
}

function TrashDates({ record, graceDays }: { record: TaskLifecycleRecord; graceDays: number }) {
  // Same timestamp fallback as ResourcePurgeService.sweep; this is presentation only.
  const trashedAt = record.trashedAt ?? record.operations.filter((operation) => operation.kind === 'trash' && operation.phase === 'completed').at(-1)?.completedAt ?? record.createdAt
  const time = Date.parse(trashedAt)
  if (!Number.isFinite(time)) return <p>Cleanup eligibility date is unavailable.</p>
  const eligibleAt = new Date(time + graceDays * 86_400_000)
  return <p>Moved to trash: <time dateTime={trashedAt}>{new Date(time).toLocaleString()}</time>. Grace period ends: <time dateTime={eligibleAt.toISOString()}>{eligibleAt.toLocaleString()}</time>. Cleanup also requires all blockers to be cleared.</p>
}
