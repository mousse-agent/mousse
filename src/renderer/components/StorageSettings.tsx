import { useCallback, useEffect, useRef, useState } from 'react'
import { errorDiagnostic, knownAppError, normalizeAppError, parseErrorInfo, type AppErrorShape } from '../../shared/errors'
import type { TaskLifecycleRecord, TrashRetentionPolicy } from '../../shared/resourceLifecycle'
import { Select } from './ui/Select'
import { Trash2 } from '../lib/icons'
import { trashCount } from '../lib/trashInventory'
import { SettingsGroup, SettingsRow } from './settings/SettingsRow'
import '../styles/storage.css'

const PRESET_DAYS = [7, 30, 90]

export function StorageSettings() {
  const [records, setRecords] = useState<TaskLifecycleRecord[]>([])
  const [policy, setPolicy] = useState<TrashRetentionPolicy>()
  const [suspended, setSuspended] = useState(false)
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

  const inTrash = trashCount(records)
  const selectValue = !policy ? '' : policy.automaticPurge ? String(policy.graceDays) : 'never'
  const customDays = policy?.automaticPurge && !PRESET_DAYS.includes(policy.graceDays) ? policy.graceDays : undefined
  const autoPaused = Boolean(policy?.automaticPurge && suspended)

  return <section className="settings-section storage-settings">
    <SettingsGroup title="Trash" icon={Trash2}>
      <SettingsRow
        data-testid="storage-auto-empty"
        title="Empty trash automatically"
        htmlFor="storage-auto-empty-select"
        description={autoPaused ? 'Paused after a system clock change.' : trashDescription(inTrash)}
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
    </SettingsGroup>
    {error && <p className="storage-error" role="alert">{error}</p>}
  </section>
}

const UNPUBLISHED_NOTE = 'Unpublished work is never deleted automatically.'

/** Where trash is reviewed now: the sidebar. */
export function trashDescription(count: number): string {
  if (count === 0) return `No threads in trash. ${UNPUBLISHED_NOTE}`
  return `${count} ${count === 1 ? 'thread' : 'threads'} in trash · restore or delete them from Recently deleted in the sidebar. ${UNPUBLISHED_NOTE}`
}
