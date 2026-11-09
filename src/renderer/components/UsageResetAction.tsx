import { useRef, type ReactNode } from 'react'
import { RotateCcwArrow } from '../lib/icons'
import { resetEffect, resetTypeLabel } from '../lib/subscriptionUsage'
import type { UsageResets } from '../../shared/providerAuth'
import { Collapse } from './ui/Collapse'

/** Where using a limit reset stands for one card: asking, running, done, or why it did not. */
export interface ResetFlow {
  providerId: string
  phase: 'confirm' | 'working' | 'done' | 'failed'
  message?: string
}

/** The credit a reset uses: the one that expires first (the rest last longer); none when the provider lists none. */
export function soonestCredit(resets: UsageResets | undefined): NonNullable<UsageResets['credits']>[number] | undefined {
  const dated = (resets?.credits ?? []).map((credit) => ({ credit, at: credit.expiresAt ? Date.parse(credit.expiresAt) : Number.POSITIVE_INFINITY }))
  return dated.sort((a, b) => (Number.isNaN(a.at) ? Infinity : a.at) - (Number.isNaN(b.at) ? Infinity : b.at))[0]?.credit
}

/**
 * What a reset resets, for the question: "all Codex limits", "the 5-hour limit" for a reset of one
 * window, or "all limits" when the provider does not say.
 */
export function resetScope(resets: UsageResets | undefined): string {
  const type = soonestCredit(resets)?.type
  const label = type ? resetTypeLabel(type) : ''
  if (!label) return 'all limits'
  return /limits$/i.test(label) ? `all ${label}` : `the ${label} limit`
}

/**
 * The card header's reset button: a small icon, there while resets are left. `hint` tints it when a
 * limit is running low, the moment a reset helps most.
 */
export function UsageResetButton({ resets, hint, onStart }: { resets: UsageResets | undefined; hint: boolean; onStart: () => void }) {
  const left = resets && Number.isInteger(resets.available) ? resets.available : 0
  if (left <= 0) return null
  return <button
    type="button"
    className={`usage-settings-btn usage-reset-btn${hint ? ' is-hint' : ''}`}
    data-testid="usage-reset-button"
    aria-label={`Use a reset · ${left} left`}
    title={`Use a reset · ${left} left`}
    onClick={onStart}
  >
    <RotateCcwArrow size={14} aria-hidden="true" />
  </button>
}

/** One state of the row, stacked in place over the others: the shown one fades in as the last fades out. */
function Layer({ on, className, children }: { on: boolean; className?: string; children: ReactNode }) {
  return <span className={`usage-reset-layer${className ? ' ' + className : ''}`} data-on={on || undefined} aria-hidden={!on || undefined} inert={!on || undefined}>{children}</span>
}

/**
 * The card's one reset row, under its bars, while a reset is asked for or used: the question with
 * Reset now and Cancel, then "Resetting…", then what happened, in a few words.
 *
 * The row grows in and out with the shared Collapse (its content also blurs in and out), and keeps the
 * last state it showed while it closes. The states share one place and one height: each change
 * crossfades, and the buttons fade out on done while keeping their room.
 */
export function UsageResetConfirm({ resets, flow, onConfirm, onCancel }: { resets: UsageResets | undefined; flow: ResetFlow | null; onConfirm: () => void; onCancel: () => void }) {
  const last = useRef<ResetFlow | null>(flow)
  if (flow) last.current = flow
  const shown = flow ?? last.current
  const phase = shown?.phase ?? 'confirm'
  const left = Math.max(0, (resets?.available ?? 1) - 1)
  const working = phase === 'working'
  const done = phase === 'done'
  const asking = !working && !done
  return <Collapse open={!!flow} className="usage-reset-panel">
    <div className="usage-reset-row" data-testid="usage-reset-row" data-phase={phase}>
      <div className="usage-reset-content">
        <span className="usage-reset-text">
          <Layer on={asking}>
            {`Reset ${resetScope(resets)} to 100%? ${left} will be left.`}
            {phase === 'failed' && shown?.message && <span className="settings-status-bad" role="alert" data-testid="usage-reset-problem"> {shown.message}</span>}
          </Layer>
          <Layer on={working}>Resetting…</Layer>
          <Layer on={done} className="is-done"><span role="status">{done ? shown?.message ?? resetEffect(soonestCredit(resets)?.type).done : null}</span></Layer>
        </span>
        <Layer on={!done} className="usage-reset-actions">
          <button type="button" className="usage-text-btn" disabled={!asking} onClick={onCancel}>Cancel</button>
          <button type="button" className="usage-reset-now" data-testid="usage-reset-now" disabled={!asking} aria-busy={working || undefined} onClick={onConfirm}>Reset now</button>
        </Layer>
      </div>
    </div>
  </Collapse>
}
