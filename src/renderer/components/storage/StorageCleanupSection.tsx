import { useCallback, useEffect, useRef, useState } from 'react'
import { summarizeCleanupReport, type StorageCleanupPlanItem, type StorageCleanupPlanToken, type StorageCleanupReport } from '../../../shared/storage'
import { parseCleanupPlanReply, parseCleanupReport } from '../../../shared/storageReply'
import { Sparkles } from '../../lib/icons'
import { CLEANUP_COPY, ruleLabel } from '../../lib/storageCopy'
import { itemSize, orderReportItems, summarizePlan } from '../../lib/storageCleanup'
import { SettingsGroup, SettingsRow } from '../settings/SettingsRow'
import { Modal } from '../ui/Modal'

export type CleanupPhase = 'idle' | 'planning' | 'confirm' | 'running'

export interface StorageCleanupViewProps {
  /** Undefined while loading, null when cleanup has never run. */
  report: StorageCleanupReport | null | undefined
  /** The last report exists but could not be read. */
  reportUnreadable?: boolean
  phase: CleanupPhase
  plan: readonly StorageCleanupPlanItem[] | undefined
  /** The plan is older than the daemon will accept, so it has to be checked again. */
  expired?: boolean
  error: string
  /** A note that is not an error: the run is still going on in the background. */
  notice?: string
  /** False when no rule would act, so a run could only do nothing. */
  hasRule: boolean
  onStart: () => void
  onConfirm: () => void
  onCancel: () => void
}

/** The dry run, shown before anything is deleted. */
export function CleanupPlanView({ plan }: { plan: readonly StorageCleanupPlanItem[] }) {
  const summary = summarizePlan(plan)
  const removals = plan.filter((item) => item.action === 'remove')
  const kept = plan.filter((item) => item.action === 'keep')
  return <div className="storage-plan" data-testid="storage-cleanup-plan">
    <p className="storage-plan-summary" data-testid="storage-plan-summary">{summary.line}{summary.keep > 0 ? ` ${summary.keep} will be kept.` : ''}</p>
    {summary.remove > 0 && <p className="settings-muted">{CLEANUP_COPY.worktreeNote}{summary.emptiesTrash ? ` ${CLEANUP_COPY.trashWarning}` : ''} {CLEANUP_COPY.onlyListed}</p>}
    {removals.length > 0 && <ul className="storage-result-list" aria-label="Would be removed" data-testid="storage-plan-removals">
      {removals.map((item, index) => <li key={`r${index}`}>
        <span className="storage-result-main">{ruleLabel(item.rule, item.action)}: {item.label}</span>
        <span className="settings-muted">{[item.reason, itemSize(item)].filter(Boolean).join(' · ')}</span>
      </li>)}
    </ul>}
    {kept.length > 0 && <details className="storage-plan-kept" data-testid="storage-plan-kept">
      <summary>Show {kept.length} kept {kept.length === 1 ? 'item' : 'items'}</summary>
      <ul className="storage-result-list">
        {kept.map((item, index) => <li key={`k${index}`}>
          <span className="storage-result-main">{ruleLabel(item.rule, item.action)}: {item.label}</span>
          <span className="settings-muted">{[item.reason, itemSize(item)].filter(Boolean).join(' · ')}</span>
        </li>)}
      </ul>
    </details>}
  </div>
}

/** The Cleanup group: the button, the last run's sentence and its list of results. */
export function StorageCleanupView(props: StorageCleanupViewProps) {
  const { report, phase, plan, hasRule, expired } = props
  const busy = phase === 'planning' || phase === 'running'
  const summary = plan ? summarizePlan(plan) : undefined
  const items = report ? orderReportItems(report.items) : []
  const nothingToRemove = !summary || summary.remove === 0
  const footer = phase === 'confirm' || phase === 'running'
    ? <>
        <button type="button" className="settings-btn" disabled={phase === 'running'} onClick={props.onCancel} data-testid="storage-cleanup-cancel">{nothingToRemove ? 'Close' : 'Cancel'}</button>
        {expired
          ? <button type="button" className="settings-btn" onClick={props.onStart} data-testid="storage-cleanup-recheck">Check again</button>
          : !nothingToRemove && <button type="button" className="settings-btn danger" disabled={phase === 'running'} onClick={props.onConfirm} data-testid="storage-cleanup-confirm">
              {phase === 'running' ? 'Cleaning up…' : `Remove ${summary!.remove} ${summary!.remove === 1 ? 'item' : 'items'}`}
            </button>}
      </>
    : undefined
  return <SettingsGroup title="Cleanup" icon={Sparkles} id="storage-cleanup" description={CLEANUP_COPY.idle}>
    <SettingsRow
      data-testid="storage-cleanup-now"
      title="Run the cleanup rules"
      description={hasRule ? undefined : CLEANUP_COPY.noRule}
      control={<button type="button" className="settings-btn" data-testid="storage-cleanup-button" disabled={!hasRule || busy} aria-busy={busy || undefined} onClick={props.onStart}>
        {phase === 'planning' ? 'Checking…' : phase === 'running' ? 'Cleaning up…' : 'Clean up now'}
      </button>}
    />
    {props.error && phase !== 'confirm' && phase !== 'running' && <p className="storage-error" role="alert" data-testid="storage-cleanup-error">{props.error}</p>}
    {props.notice && <p className="settings-muted storage-notice" role="status" data-testid="storage-cleanup-notice">{props.notice}</p>}
    <div className="storage-last-run" data-testid="storage-last-run">
      {report === undefined && !props.reportUnreadable && <p className="settings-muted">Loading the last run…</p>}
      {report === null && !props.reportUnreadable && <p className="settings-muted">Cleanup has not run yet.</p>}
      {props.reportUnreadable && <p className="settings-muted" data-testid="storage-report-unreadable">The last cleanup report could not be read.</p>}
      {report && <>
        <p data-testid="storage-last-run-summary"><strong>Last run {new Date(report.completedAt).toLocaleString()}</strong>{' '}<span className="settings-muted">({report.trigger === 'manual' ? 'Clean up now' : 'scheduled'})</span></p>
        {/* A live region, so the result of a run is read out when the dialog closes and focus returns to the button. */}
        <p role="status" aria-live="polite" data-testid="storage-last-run-sentence">{summarizeCleanupReport(report)}</p>
        {report.suspended && <p className="settings-muted">{report.suspended}</p>}
        {report.clockNote && <p className="settings-muted">{report.clockNote}</p>}
        {items.length > 0 && <details className="storage-last-run-list">
          <summary>Show results</summary>
          <ul className="storage-result-list" data-testid="storage-report-list">
            {items.map((item, index) => <li key={index} data-outcome={item.outcome}>
              <span className="storage-result-main"><strong>{item.outcome === 'removed' ? 'Removed' : item.outcome === 'failed' ? 'Failed' : 'Kept'}</strong> {ruleLabel(item.rule, item.outcome)}: {item.label}</span>
              <span className="settings-muted">{[item.reason, itemSize(item)].filter(Boolean).join(' · ')}</span>
            </li>)}
          </ul>
          {report.omittedCount > 0 && <p className="settings-muted" data-testid="storage-report-omitted">{report.omittedCount} more {report.omittedCount === 1 ? 'result' : 'results'}</p>}
        </details>}
      </>}
    </div>
    <Modal open={phase === 'confirm' || phase === 'running'} title="Clean up now?" onClose={props.onCancel} footer={footer} closeDisabled={phase === 'running'}>
      {props.error && <p className="storage-error" role="alert">{props.error}</p>}
      {expired && <p className="storage-error" role="alert" data-testid="storage-plan-expired">{CLEANUP_COPY.expired}</p>}
      {phase === 'running' && <p className="settings-muted" role="status">Cleaning up. This cannot be closed until it finishes.</p>}
      {plan && <CleanupPlanView plan={plan} />}
    </Modal>
  </SettingsGroup>
}

const isTimeout = (cause: unknown): boolean => /time(d)? ?out/i.test(String((cause as { message?: unknown } | null)?.message ?? ''))
const REPORT_POLL_MS = 5_000
const REPORT_POLL_LIMIT_MS = 20 * 60_000

/** Plan, confirm, run: nothing is deleted before the person has seen the plan and agreed, and the run removes only what the plan listed. */
export function StorageCleanupSection({ hasRule, onDone }: { hasRule: boolean; onDone: () => void }) {
  const [report, setReport] = useState<StorageCleanupReport | null>()
  const [reportUnreadable, setReportUnreadable] = useState(false)
  const [phase, setPhase] = useState<CleanupPhase>('idle')
  const [plan, setPlan] = useState<StorageCleanupPlanItem[]>()
  const [token, setToken] = useState<StorageCleanupPlanToken>()
  const [expired, setExpired] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const mounted = useRef(true)
  const poll = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  useEffect(() => {
    mounted.current = true
    void (async () => {
      try {
        const reply = await window.mousse.storage.cleanupLastReport()
        if (mounted.current) setReport(reply.report === null ? null : parseCleanupReport(reply.report))
      } catch {
        if (mounted.current) { setReport(null); setReportUnreadable(true) }
      }
    })()
    return () => { mounted.current = false; if (poll.current) clearInterval(poll.current) }
  }, [])
  // A plan can be confirmed for a short while; after that the daemon refuses it, so the page says so first.
  useEffect(() => {
    setExpired(false)
    if (!token || phase !== 'confirm') return
    const left = token.expiresAt - Date.now()
    if (left <= 0) { setExpired(true); return }
    const timer = setTimeout(() => { if (mounted.current) setExpired(true) }, left)
    return () => clearTimeout(timer)
  }, [token, phase])

  const start = useCallback(async () => {
    setError(''); setNotice(''); setPhase('planning')
    try {
      const parsed = parseCleanupPlanReply(await window.mousse.storage.cleanupPlan())
      if (!mounted.current) return
      setPlan(parsed.plan); setToken(parsed.token); setPhase('confirm')
    } catch (cause) {
      if (!mounted.current) return
      setPhase('idle'); setPlan(undefined); setToken(undefined)
      setError(`Could not check what to clean up. ${(cause as { message?: string } | null)?.message ?? ''}`.trim())
    }
  }, [])
  const watchForReport = useCallback((since: number) => {
    if (poll.current) clearInterval(poll.current)
    const give = Date.now() + REPORT_POLL_LIMIT_MS
    poll.current = setInterval(() => {
      void (async () => {
        try {
          const last = await window.mousse.storage.cleanupLastReport()
          const parsed = last.report ? parseCleanupReport(last.report) : null
          if (parsed && Date.parse(parsed.startedAt) >= since - 1000) {
            if (poll.current) clearInterval(poll.current)
            if (!mounted.current) return
            setReport(parsed); setNotice(''); onDone()
          }
        } catch { /* The next poll tries again. */ }
        if (Date.now() > give && poll.current) { clearInterval(poll.current); if (mounted.current) setNotice('') }
      })()
    }, REPORT_POLL_MS)
  }, [onDone])
  const confirm = useCallback(async () => {
    if (!token) return
    const startedAt = Date.now()
    setError(''); setPhase('running')
    try {
      const parsed = parseCleanupReport((await window.mousse.storage.cleanupRun(token)).report)
      if (!mounted.current) return
      setReport(parsed); setPlan(undefined); setToken(undefined); setPhase('idle')
      onDone()
    } catch (cause) {
      if (!mounted.current) return
      setPlan(undefined); setToken(undefined); setPhase('idle')
      if (isTimeout(cause)) {
        // The daemon keeps going: this is not a failure, and the report appears when it finishes.
        setNotice('Cleanup is still running in the background. The result appears here when it finishes.')
        watchForReport(startedAt)
        return
      }
      setError(`Cleanup did not finish. ${(cause as { message?: string } | null)?.message ?? ''}`.trim())
      // Part of it may have run: show what the daemon recorded.
      try {
        const last = await window.mousse.storage.cleanupLastReport()
        if (mounted.current && last.report) setReport(parseCleanupReport(last.report))
      } catch { /* The error above already says the run did not finish. */ }
      onDone()
    }
  }, [token, onDone, watchForReport])
  // A run in progress cannot be dismissed; Escape or a click outside leaves it going.
  const cancel = useCallback(() => setPhase((current) => current === 'running' ? current : 'idle'), [])

  return <StorageCleanupView report={report} reportUnreadable={reportUnreadable} phase={phase} plan={plan} expired={expired} error={error} notice={notice} hasRule={hasRule} onStart={() => void start()} onConfirm={() => void confirm()} onCancel={cancel} />
}
