import { useEffect, useState } from 'react'
import type { LifecyclePurgePreview, TaskLifecycleRecord, TrashRetentionPolicy } from '../../shared/resourceLifecycle'

export function StorageSettings() {
  const [records, setRecords] = useState<TaskLifecycleRecord[]>([])
  const [policy, setPolicy] = useState<TrashRetentionPolicy>({ schemaVersion: 1, graceDays: 30, automaticPurge: false })
  const [preview, setPreview] = useState<LifecyclePurgePreview>()
  const [discard, setDiscard] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const reload = async () => { const result = await window.mousse.threads.inventory(); setRecords(result.lifecycles); setPolicy(result.trashPolicy) }
  useEffect(() => { void reload().catch((error) => setError(String(error))) }, [])
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await work(); await reload() } catch (error) { setError(String(error)); await reload().catch(() => {}) } finally { setBusy(false) }
  }
  return <section className="settings-section">
    <h2>Storage and trash</h2>
    <p>Trash remains restorable for review. Undo has its own retention window. Retained conversations and Git history reachable from other branches are separate from reclaimable checkout files.</p>
    <div className="settings-row">
      <label>Trash grace period (days) <input aria-label="Trash grace period in days" type="number" min={1} max={3650} value={policy.graceDays} onChange={(event) => setPolicy({ ...policy, graceDays: Number(event.target.value) })} /></label>
      <label><input type="checkbox" checked={policy.automaticPurge} onChange={(event) => setPolicy({ ...policy, automaticPurge: event.target.checked })} /> Automatically purge eligible trash after the grace period</label>
      <button disabled={busy} onClick={() => void run(() => window.mousse.threads.configureTrash(policy))}>Save trash policy</button>
    </div>
    <p>Automatic cleanup retains unpublished results and any files that need a human discard decision. Permanent deletion cannot be undone once it starts.</p>
    {error && <p role="alert">{error}</p>}
    {records.filter((record) => !record.parentTaskId && record.state !== 'purged').map((record) => <div key={record.taskId} className="settings-row" style={{ display: 'block', marginBlock: 12 }}>
      <strong>{record.taskId}</strong> · {record.state}
      {record.blockedReason && <p role="status">{record.blockedReason}</p>}
      {record.purge && <p>{record.purge.items.filter((item) => item.status === 'removed').length} / {record.purge.items.length} resources removed. Restore is unavailable because permanent deletion has started.</p>}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        {record.state === 'active' && <button disabled={busy} onClick={() => void run(() => window.mousse.threads.delete(record.taskId))}>Move to trash</button>}
        {record.state === 'trashed' && <button disabled={busy} onClick={() => void run(() => window.mousse.threads.restore(record.taskId))}>Restore idle task</button>}
        {record.state === 'trashed' && <button disabled={busy} onClick={() => void run(async () => { const result = await window.mousse.threads.purge(record.taskId, { preview: true }); setPreview(result.preview); setDiscard(false) })}>Review permanent deletion</button>}
        {record.state === 'purge-started' && <button disabled={busy} onClick={() => void run(() => window.mousse.threads.purge(record.taskId, { operationId: record.purge!.operationId }))}>Retry cleanup</button>}
      </div>
    </div>)}
    {preview && <div role="dialog" aria-label="Permanent deletion preview" style={{ border: '1px solid currentColor', padding: 16, marginTop: 16 }}>
      <h3>Review permanent deletion</h3>
      <p>{preview.items.length} exclusive resources; {(preview.exclusiveBytes / 1024 / 1024).toFixed(2)} MiB of checkout and owned files. This excludes shared Git object storage.</p>
      <div style={{ maxHeight: 260, overflow: 'auto' }}>
        {preview.items.map((item) => <div key={item.id} style={{ marginBlock: 8, overflowWrap: 'anywhere' }}>{item.kind}: {item.identity}{item.discardRequired && <strong> — Discard required: {item.reason ?? 'unpublished content'}</strong>}{item.discardRequired && item.content && <details><summary>Files included in discard</summary>{item.content.filter((entry) => entry.kind !== 'directory').map((entry) => <div key={entry.path}>{entry.path} ({entry.bytes} bytes)</div>)}</details>}</div>)}
        {preview.retained.map((item) => <p key={item.identity}>Retained: {item.identity} — {item.reason}</p>)}
        {preview.blockers.map((reason) => <p key={reason} role="alert">Blocked: {reason}</p>)}
      </div>
      {preview.items.some((item) => item.discardRequired) && <label><input type="checkbox" checked={discard} onChange={(event) => setDiscard(event.target.checked)} /> I explicitly discard the listed unpublished results and sole-copy files.</label>}
      <p>Starting deletion permanently removes the listed content. You cannot restore or cancel after this boundary.</p>
      <button disabled={busy} onClick={() => setPreview(undefined)}>Cancel</button>{' '}
      <button disabled={busy || preview.blockers.length > 0 || preview.items.some((item) => item.discardRequired) && !discard} onClick={() => void run(async () => { await window.mousse.threads.purge(preview.taskId, { operationId: crypto.randomUUID(), expectedGeneration: preview.generation, previewDigest: preview.digest, discard }); setPreview(undefined) })}>Permanently delete</button>
    </div>}
  </section>
}
