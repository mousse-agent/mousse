import { useCallback, useEffect, useRef, useState } from 'react'
import { errorDiagnostic, knownAppError, normalizeAppError, parseErrorInfo, type AppErrorShape } from '../../shared/errors'
import type { LifecyclePurgeItem, LifecyclePurgePreview, LifecycleState, TaskLifecycleRecord, TrashRetentionPolicy } from '../../shared/resourceLifecycle'
import { Modal } from './ui/Modal'
import { Select } from './ui/Select'
import { ArchiveRestore, RotateCcw, Trash2 } from '../lib/icons'
import { SettingsGroup, SettingsRow } from './settings/SettingsRow'
import '../styles/storage.css'

const PRESET_DAYS = [7, 30, 90]
/** Threads that are not in (or on their way into) the trash. */
const LIVE_STATES: ReadonlySet<LifecycleState> = new Set(['active', 'draining'])

export function StorageSettings() {
  const [records, setRecords] = useState<TaskLifecycleRecord[]>([])
  const [taskNames, setTaskNames] = useState<Record<string, string>>({})
  const [policy, setPolicy] = useState<TrashRetentionPolicy>()
  const [suspended, setSuspended] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [preview, setPreview] = useState<LifecyclePurgePreview>()
  const [discard, setDiscard] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const busyRef = useRef(false)
  const inFlight = useRef<Promise<void> | null>(null)
  const reload = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current
    const request = window.mousse.threads.inventory().then((result) => {
      if (!mounted.current) return
      setRecords(result.lifecycles)
      setTaskNames(result.taskNames ?? {})
      setPolicy(result.trashPolicy)
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
  const savePolicy = (next: TrashRetentionPolicy) => void run(async () => {
    setPolicy(next)
    await window.mousse.threads.configureTrash(next)
  })
  const choosePolicy = (value: string) => {
    if (!policy) return
    savePolicy(value === 'never' ? { ...policy, automaticPurge: false } : { ...policy, automaticPurge: true, graceDays: Number(value) })
  }
  const closeReview = useCallback(() => { setReviewOpen(false); setPreview(undefined); setDiscard(false) }, [])

  const roots = records.filter((record) => !record.parentTaskId && record.state !== 'purged')
  const inTrash = roots.filter((record) => !LIVE_STATES.has(record.state))
  const live = roots.filter((record) => LIVE_STATES.has(record.state))
  const unfinished = inTrash.filter((record) => record.state === 'purge-started').length
  const selectValue = !policy ? '' : policy.automaticPurge ? String(policy.graceDays) : 'never'
  const customDays = policy?.automaticPurge && !PRESET_DAYS.includes(policy.graceDays) ? policy.graceDays : undefined
  const autoPaused = Boolean(policy?.automaticPurge && suspended)
  const name = (taskId: string) => taskNames[taskId] ?? 'Untitled thread'

  const threadRow = (record: TaskLifecycleRecord) => (
    <SettingsRow
      key={record.taskId}
      data-testid="storage-thread-row"
      data-task-id={record.taskId}
      title={name(record.taskId)}
      description={threadStatus(record, policy)}
      control={<span className="settings-icon-actions">
        {record.state === 'active' && <button type="button" className="settings-icon-btn danger" title="Move to trash" aria-label="Move to trash" disabled={busy} onClick={() => void run(() => window.mousse.threads.delete(record.taskId))}><Trash2 size={14} /></button>}
        {record.state === 'trashed' && <button type="button" className="settings-icon-btn primary" title="Restore" aria-label="Restore" disabled={busy} onClick={() => void run(() => window.mousse.threads.restore(record.taskId))}><ArchiveRestore size={14} /></button>}
        {record.state === 'trashed' && <button type="button" className="settings-icon-btn danger" title="Delete…" aria-label="Delete…" disabled={busy} onClick={() => void run(async () => { const result = await window.mousse.threads.purge(record.taskId, { preview: true }); setPreview(result.preview); setDiscard(false) })}><Trash2 size={14} /></button>}
        {record.state === 'purge-started' && <button type="button" className="settings-icon-btn primary" title="Retry deletion" aria-label="Retry deletion" disabled={busy} onClick={() => void run(() => window.mousse.threads.purge(record.taskId, { operationId: record.purge!.operationId }))}><RotateCcw size={14} /></button>}
      </span>}
    />
  )

  const needsDiscard = preview?.items.some((item) => item.discardRequired) ?? false
  const footer = preview
    ? <>
        <button type="button" className="settings-btn" disabled={busy} onClick={() => setPreview(undefined)}>Back</button>
        <button
          type="button"
          className="settings-btn danger"
          data-testid="storage-delete-permanently"
          disabled={busy || preview.blockers.length > 0 || needsDiscard && !discard}
          onClick={() => void run(async () => { await window.mousse.threads.purge(preview.taskId, { operationId: crypto.randomUUID(), expectedGeneration: preview.generation, previewDigest: preview.digest, discard }); setPreview(undefined) })}
        >Delete permanently</button>
      </>
    : undefined

  return <section className="settings-section storage-settings">
    <SettingsGroup title="Trash" icon={Trash2}>
      <SettingsRow
        data-testid="storage-auto-empty"
        title="Empty trash automatically"
        htmlFor="storage-auto-empty-select"
        description={autoPaused ? 'Paused after a system clock change.' : 'Unpublished work is never deleted automatically.'}
        control={<>
          {autoPaused && policy && <button type="button" className="settings-btn" disabled={busy} onClick={() => savePolicy(policy)}>Resume</button>}
          <Select
            id="storage-auto-empty-select"
            data-testid="storage-auto-empty-select"
            value={selectValue}
            disabled={busy || !policy}
            placeholder="Loading…"
            onChange={choosePolicy}
            options={[
              { value: 'never', label: 'Never' },
              ...PRESET_DAYS.map((days) => ({ value: String(days), label: `After ${days} days` })),
              ...(customDays !== undefined ? [{ value: String(customDays), label: `After ${customDays} ${customDays === 1 ? 'day' : 'days'}` }] : [])
            ]}
          />
        </>}
      />
      <SettingsRow
        data-testid="storage-review-trash"
        title="Review trash"
        description={trashSummary(inTrash.length, unfinished)}
        control={<button type="button" className="settings-btn" data-testid="storage-review-trash-button" onClick={() => setReviewOpen(true)}>Review…</button>}
      />
    </SettingsGroup>
    {error && !reviewOpen && <p className="storage-error" role="alert">{error}</p>}

    <Modal open={reviewOpen} title={preview ? `Delete “${name(preview.taskId)}”` : 'Trash'} onClose={closeReview} footer={footer}>
      <div className="storage-dialog" data-testid="storage-trash-dialog">
        {error && <p className="storage-error" role="alert">{error}</p>}
        {preview
          ? <DeletionPreview preview={preview} discard={discard} onDiscardChange={setDiscard} />
          : <>
              <SettingsGroup title="In trash">
                {inTrash.length ? inTrash.map(threadRow) : <p className="settings-muted storage-empty">Trash is empty.</p>}
              </SettingsGroup>
              {live.length > 0 && <SettingsGroup title="Other threads">{live.map(threadRow)}</SettingsGroup>}
            </>}
      </div>
    </Modal>
  </section>
}

function DeletionPreview({ preview, discard, onDiscardChange }: { preview: LifecyclePurgePreview; discard: boolean; onDiscardChange: (next: boolean) => void }) {
  const needsDiscard = preview.items.some((item) => item.discardRequired)
  return <section className="storage-preview" aria-label="Permanent deletion preview" data-testid="storage-deletion-preview">
    <p className="settings-muted">
      {preview.items.length} {preview.items.length === 1 ? 'item' : 'items'} · {formatBytes(preview.exclusiveBytes)} freed. Shared Git history is kept.
    </p>
    {preview.blockers.map((reason) => <p key={reason} className="storage-error" role="alert">Can’t delete: {reason}</p>)}
    {needsDiscard && <label className="storage-discard">
      <input type="checkbox" checked={discard} onChange={(event) => onDiscardChange(event.target.checked)} />
      <span>Discard the unpublished results and only-copy files listed below.</span>
    </label>}
    <p className="settings-muted">Deletion can’t be undone or cancelled once it starts.</p>
    <SettingsGroup>
      {[...preview.items].sort((a, b) => Number(Boolean(b.discardRequired)) - Number(Boolean(a.discardRequired))).map((item) => <SettingsRow
        key={item.id}
        title={<span className="storage-identity">{item.identity}</span>}
        description={item.discardRequired ? `${KIND_LABELS[item.kind]} · Unpublished: ${item.reason ?? 'may contain unpublished work'}` : KIND_LABELS[item.kind]}
      >
        {item.discardRequired && item.content && <details className="storage-files">
          <summary>Files to discard</summary>
          {item.content.filter((entry) => entry.kind !== 'directory').map((entry) => <div key={entry.path} className="settings-muted storage-identity">{entry.path} ({formatBytes(entry.bytes)})</div>)}
        </details>}
      </SettingsRow>)}
      {preview.retained.map((item) => <SettingsRow key={item.identity} title={<span className="storage-identity">{item.identity}</span>} description={`Kept · ${item.reason}`} />)}
    </SettingsGroup>
  </section>
}

const KIND_LABELS: Record<LifecyclePurgeItem['kind'], string> = { worktree: 'Worktree', ref: 'Branch', path: 'Files', 'scheduled-row': 'Scheduled task' }

function trashSummary(count: number, unfinished: number): string {
  if (!count) return 'Trash is empty'
  const threads = `${count} ${count === 1 ? 'thread' : 'threads'}`
  return unfinished ? `${threads} · ${unfinished} unfinished ${unfinished === 1 ? 'deletion' : 'deletions'}` : threads
}

function threadStatus(record: TaskLifecycleRecord, policy: TrashRetentionPolicy | undefined): string | undefined {
  switch (record.state) {
    case 'active': return undefined
    case 'draining': return 'Stopping…'
    case 'trash-moving': return 'Moving to trash…'
    case 'restore-moving': return 'Restoring…'
    case 'purge-started': {
      const items = record.purge?.items ?? []
      return `Deletion started · ${items.filter((item) => item.status === 'removed').length} of ${items.length} removed · can’t be restored`
    }
    case 'blocked': return record.blockedReason ?? 'Blocked'
    case 'trashed': {
      if (record.blockedReason) return record.blockedReason
      // Same timestamp fallback as ResourcePurgeService.sweep; this is presentation only.
      const trashedAt = record.trashedAt ?? record.operations.filter((operation) => operation.kind === 'trash' && operation.phase === 'completed').at(-1)?.completedAt ?? record.createdAt
      const time = Date.parse(trashedAt)
      if (!Number.isFinite(time)) return undefined
      const trashed = `Trashed ${new Date(time).toLocaleDateString()}`
      return policy?.automaticPurge ? `${trashed} · deleted after ${new Date(time + policy.graceDays * 86_400_000).toLocaleDateString()}` : trashed
    }
    default: return undefined
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}
