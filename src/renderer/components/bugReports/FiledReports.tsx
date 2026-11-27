import { useCallback, useEffect, useMemo, useState } from 'react'
import { reportsFixedBy, type FiledBugReportView } from '../../../shared/bugReports'
import { bugReportsClient } from '../../services/bugReportsClient'
import { useUpdateStore } from '../../stores/updateStore'
import { ArrowUpRight } from '../../lib/icons'
import { Modal } from '../ui/Modal'
import '../../styles/bugReports.css'

/** The reports this person filed from here, with their issues' state; null while loading. */
export function useFiledReports(active = true): { reports: FiledBugReportView[] | null; error: string | null; reload: () => void } {
  const [reports, setReports] = useState<FiledBugReportView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [round, setRound] = useState(0)
  useEffect(() => {
    if (!active) return
    let live = true
    bugReportsClient().list().then((list) => { if (live) { setReports(list); setError(null) } }, (failure: unknown) => {
      if (live) { setReports([]); setError(failure instanceof Error ? failure.message : 'Your reports could not be read.') }
    })
    return () => { live = false }
  }, [active, round])
  return { reports, error, reload: useCallback(() => setRound((n) => n + 1), []) }
}

const shortDate = (iso: string): string => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
}

/** A report's state in one word. */
export function reportState(report: FiledBugReportView): { label: string; key: string } {
  if (report.revokedAt) return { label: 'Revoked', key: 'revoked' }
  if (report.state === 'pending') return { label: 'Not on GitHub yet', key: 'pending' }
  if (report.state === 'open') return { label: 'Open', key: 'open' }
  if (report.state === 'closed') return report.stateReason === 'not_planned' ? { label: 'Closed', key: 'closed' } : { label: 'Fixed', key: 'fixed' }
  return { label: 'Unknown', key: 'unknown' }
}

const NO_PULL_REQUESTS: number[] = []

/**
 * "This update fixes your bugs:" at the top of the offered update's notes: one row per report this person filed that a
 * pull request in the update closes. Nothing shows when none apply.
 */
export function FixedReports() {
  const pullRequests = useUpdateStore((s) => s.pullRequests ?? NO_PULL_REQUESTS)
  const { reports } = useFiledReports(pullRequests.length > 0)
  const fixed = useMemo(() => (reports ? reportsFixedBy(reports, pullRequests) : []), [reports, pullRequests])
  if (fixed.length === 0) return null
  return (
    <section className="bug-report-fixed" aria-label="This update fixes your bugs">
      <h4>This update fixes your bugs:</h4>
      <ul className="bug-report-rows">
        {fixed.map((report) => (
          <li key={report.number} className="bug-report-row">
            <a className="bug-report-row-title" href={report.url} target="_blank" rel="noopener noreferrer" title={report.title}>{report.title}</a>
            <span className="bug-report-row-meta">#{report.number}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * Settings → General → Your reports: every report filed from this computer (anonymous ones too), with its state and
 * date, a link, and Revoke, which asks first and then closes the issue (or takes back a +1).
 */
export function FiledReportsList() {
  const { reports, error, reload } = useFiledReports()
  const [confirm, setConfirm] = useState<FiledBugReportView | null>(null)
  const [busy, setBusy] = useState(false)
  const [revokeError, setRevokeError] = useState<string | null>(null)

  const revoke = async () => {
    if (confirm?.number === undefined) return
    setBusy(true)
    setRevokeError(null)
    try {
      await bugReportsClient().revoke(confirm.number)
      setConfirm(null)
      reload()
    } catch (failure) {
      setRevokeError(failure instanceof Error ? failure.message : 'The report could not be revoked.')
    } finally {
      setBusy(false)
    }
  }

  if (reports === null) return <p className="bug-report-empty">Loading…</p>
  return (
    <>
      {error && <p role="alert" className="bug-report-error">{error}</p>}
      {reports.length === 0
        ? <p className="bug-report-empty">No reports yet.</p>
        : (
          <ul className="bug-report-rows" aria-label="Your reports">
            {reports.map((report) => {
              const state = reportState(report)
              const found = report.number !== undefined
              const open = found ? `Open #${report.number} on GitHub` : 'Search for it on GitHub'
              return (
                <li key={found ? report.number : `${report.signature}-${report.filedAt}`} className="bug-report-row">
                  <a className="bug-report-row-title" href={report.url} target="_blank" rel="noopener noreferrer" title={found ? `${report.title} · #${report.number}` : report.title}>{report.title}</a>
                  <span className="bug-report-state" data-state={state.key} title={found ? undefined : 'Sent from GitHub’s page. It shows here once GitHub has the issue.'}>{state.label}</span>
                  <span className="bug-report-row-meta" title={new Date(report.filedAt).toLocaleString()}>{shortDate(report.filedAt)}</span>
                  <a className="settings-icon-btn" href={report.url} target="_blank" rel="noopener noreferrer" title={open} aria-label={open}><ArrowUpRight size={14} /></a>
                  {found && !report.revokedAt && (
                    <button type="button" className="bug-report-action" onClick={() => { setRevokeError(null); setConfirm(report) }}>Revoke</button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      <Modal open={confirm !== null} title="Revoke this report?" onClose={() => { if (!busy) setConfirm(null) }} closeDisabled={busy} footer={<>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void revoke()}>{busy ? 'Revoking…' : 'Revoke'}</button>
      </>}>
        {confirm && <>
          <p><strong>{confirm.title}</strong> · #{confirm.number}</p>
          <p className="bug-report-muted">{confirm.existing
            ? 'Your +1 is taken back. The issue stays open for the person who filed it.'
            : 'The issue is closed on GitHub as not planned, with a note that you withdrew it.'}</p>
          {revokeError && <p role="alert" className="bug-report-error">{revokeError}</p>}
        </>}
      </Modal>
    </>
  )
}
