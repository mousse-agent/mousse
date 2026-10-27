import { useCallback, useEffect, useRef, useState } from 'react'
import { summarizeCleanupReport, type StorageCleanupPlanItem, type StorageCleanupReport } from '../../../shared/storage'
import { parseCleanupPlan, parseCleanupReport } from '../../../shared/storageReply'
import { Sparkles } from '../../lib/icons'
import { CLEANUP_COPY, STORAGE_RULE_LABELS } from '../../lib/storageCopy'
import { itemSize, orderReportItems, summarizePlan } from '../../lib/storageCleanup'
import { SettingsGroup, SettingsRow } from '../settings/SettingsRow'
import { Modal } from '../ui/Modal'

export type CleanupPhase = 'idle' | 'planning' | 'confirm' | 'running'

export interface StorageCleanupViewProps {
  report: StorageCleanupReport | null | undefined
  phase: CleanupPhase
  plan: readonly StorageCleanupPlanItem[] | undefined
  error: string
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
    {summary.remove > 0 && <p className="settings-muted">{CLEANUP_COPY.worktreeNote}{summary.emptiesTrash ? ` ${CLEANUP_COPY.trashWarning}` : ''}</p>}
    {removals.length > 0 && <ul className="storage-result-list" aria-label="Would be removed" data-testid="storage-plan-removals">
      {removals.map((item, index) => <li key={`r${index}`}>
        <span className="storage-result-main">{STORAGE_RULE_LABELS[item.rule]}: {item.label}</span>
        <span className="settings-muted">{[item.reason, itemSize(item)].filter(Boolean).join(' · ')}</span>
      </li>)}
    </ul>}
    {kept.length > 0 && <details className="storage-plan-kept" data-testid="storage-plan-kept">
      <summary>Show {kept.length} kept {kept.length === 1 ? 'item' : 'items'}</summary>
      <ul className="storage-result-list">
        {kept.map((item, index) => <li key={`k${index}`}>
          <span className="storage-result-main">{STORAGE_RULE_LABELS[item.rule]}: {item.label}</span>
          <span className="settings-muted">{item.reason}</span>
        </li>)}
      </ul>
    </details>}
  </div>
}

/** The Cleanup group: the button, the last run's sentence and its list of results. */
export function StorageCleanupView(props: StorageCleanupViewProps) {
  const { report, phase, plan, hasRule } = props
  const busy = phase === 'planning' || phase === 'running'
  const summary = plan ? summarizePlan(plan) : undefined
  const items = report ? orderReportItems(report.items) : []
  const footer = phase === 'confirm' || phase === 'running'
    ? <>
        <button type="button" className="settings-btn" disabled={phase === 'running'} onClick={props.onCancel} data-testid="storage-cleanup-cancel">{summary && summary.remove === 0 ? 'Close' : 'Cancel'}</button>
        {summary && summary.remove > 0 && <button type="button" className="settings-btn danger" disabled={phase === 'running'} onClick={props.onConfirm} data-testid="storage-cleanup-confirm">
          {phase === 'running' ? 'Cleaning up…' : `Remove ${summary.remove} ${summary.remove === 1 ? 'item' : 'items'}`}
        </button>}
      </>
    : undefined
  return <SettingsGroup title="Cleanup" icon={Sparkles} id="storage-cleanup" description={CLEANUP_COPY.idle}>
    <SettingsRow
      data-testid="storage-cleanup-now"
      title="Run the cleanup rules"
      description={hasRule ? undefined : CLEANUP_COPY.noRule}
      control={<button type="button" className="settings-btn" data-testid="storage-cleanup-button" disabled={!hasRule || busy} onClick={props.onStart}>
        {phase === 'planning' ? 'Checking…' : phase === 'running' ? 'Cleaning up…' : 'Clean up now'}
      </button>}
    />
    {props.error && phase !== 'confirm' && <p className="storage-error" role="alert" data-testid="storage-cleanup-error">{props.error}</p>}
    <div className="storage-last-run" data-testid="storage-last-run">
      {report === undefined && <p className="settings-muted">Loading the last run…</p>}
      {report === null && <p className="settings-muted">Cleanup has not run yet.</p>}
      {report && <>
        <p data-testid="storage-last-run-summary"><strong>Last run {new Date(report.completedAt).toLocaleString()}</strong>{' '}<span className="settings-muted">({report.trigger === 'manual' ? 'Clean up now' : 'scheduled'})</span></p>
        <p data-testid="storage-last-run-sentence">{summarizeCleanupReport(report)}</p>
        {report.suspended && <p className="settings-muted">{report.suspended}</p>}
        {report.clockNote && <p className="settings-muted">{report.clockNote}</p>}
        {items.length > 0 && <details className="storage-last-run-list">
          <summary>Show results</summary>
          <ul className="storage-result-list" data-testid="storage-report-list">
            {items.map((item, index) => <li key={index} data-outcome={item.outcome}>
              <span className="storage-result-main"><strong>{item.outcome === 'removed' ? 'Removed' : item.outcome === 'failed' ? 'Failed' : 'Kept'}</strong> {STORAGE_RULE_LABELS[item.rule]}: {item.label}</span>
              <span className="settings-muted">{[item.reason, itemSize(item)].filter(Boolean).join(' · ')}</span>
            </li>)}
          </ul>
          {report.omittedCount > 0 && <p className="settings-muted" data-testid="storage-report-omitted">{report.omittedCount} more {report.omittedCount === 1 ? 'result' : 'results'}</p>}
        </details>}
      </>}
    </div>
    <Modal open={phase === 'confirm' || phase === 'running'} title="Clean up now?" onClose={props.onCancel} footer={footer}>
      {props.error && <p className="storage-error" role="alert">{props.error}</p>}
      {plan && <CleanupPlanView plan={plan} />}
    </Modal>
  </SettingsGroup>
}

/** Plan, confirm, run: nothing is deleted before the person has seen the plan and agreed. */
export function StorageCleanupSection({ hasRule, onDone }: { hasRule: boolean; onDone: () => void }) {
  const [report, setReport] = useState<StorageCleanupReport | null>()
  const [phase, setPhase] = useState<CleanupPhase>('idle')
  const [plan, setPlan] = useState<StorageCleanupPlanItem[]>()
  const [error, setError] = useState('')
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    void (async () => {
      try {
        const reply = await window.mousse.storage.cleanupLastReport()
        if (mounted.current) setReport(reply.report === null ? null : parseCleanupReport(reply.report))
      } catch {
        if (mounted.current) { setReport(null); setError('The last cleanup report could not be read.') }
      }
    })()
    return () => { mounted.current = false }
  }, [])

  const start = useCallback(async () => {
    setError(''); setPhase('planning')
    try {
      const reply = await window.mousse.storage.cleanupPlan()
      const parsed = parseCleanupPlan(reply.plan)
      if (!mounted.current) return
      setPlan(parsed); setPhase('confirm')
    } catch (cause) {
      if (!mounted.current) return
      setPhase('idle')
      setError(`Could not check what to clean up. ${(cause as { message?: string } | null)?.message ?? ''}`.trim())
    }
  }, [])
  const confirm = useCallback(async () => {
    setError(''); setPhase('running')
    try {
      const reply = await window.mousse.storage.cleanupRun()
      const parsed = parseCleanupReport(reply.report)
      if (!mounted.current) return
      setReport(parsed); setPlan(undefined); setPhase('idle')
      onDone()
    } catch (cause) {
      if (!mounted.current) return
      setPlan(undefined); setPhase('idle')
      setError(`Cleanup did not finish. ${(cause as { message?: string } | null)?.message ?? ''}`.trim())
      // Part of it may have run: show what the daemon recorded.
      try {
        const last = await window.mousse.storage.cleanupLastReport()
        if (mounted.current && last.report) setReport(parseCleanupReport(last.report))
      } catch { /* The error above already says the run did not finish. */ }
      onDone()
    }
  }, [onDone])
  // A run in progress cannot be dismissed; Escape or a click outside leaves it going.
  const cancel = useCallback(() => setPhase((current) => current === 'running' ? current : 'idle'), [])

  return <StorageCleanupView report={report} phase={phase} plan={plan} error={error} hasRule={hasRule} onStart={() => void start()} onConfirm={() => void confirm()} onCancel={cancel} />
}
