import type { CSSProperties } from 'react'
import {
  accountActive, accountHue, formatCountdown, remainingNow, resetTooltip, summarizeAccounts, type UsageLimitSummary, type UsageResetGain
} from '../lib/subscriptionUsage'
import type { UsageAccount } from '../../shared/providerAuth'
import { UsageBar } from './UsageBar'
import { UsageResetsChip } from './UsageResetsChip'

/** "3 of 4 accounts active", for the card's header. */
export function activeAccountsLabel(accounts: readonly UsageAccount[]): string {
  return `${accounts.filter(accountActive).length} of ${accounts.length} accounts active`
}

/** Problems that are a sign-in's setting, not a failure: they read muted. */
export function accountProblemIsInfo(problem: string | undefined): boolean {
  return problem === 'Disabled in proxy' || problem === 'API key · no plan limits'
}

/** What an account with no limits says, tersely, with what to do where there is something to do. */
export function accountProblemText(problem: string | undefined): string {
  if (problem === 'Sign-in expired') return 'Sign-in expired · Reconnect in proxy'
  return problem ?? 'No limits reported'
}

function minutesUntil(resetsAt: string | undefined, now: number): number | undefined {
  if (!resetsAt) return undefined
  const at = Date.parse(resetsAt)
  return Number.isNaN(at) || at <= now ? undefined : Math.floor((at - now) / 60_000)
}

/** One limit across the accounts: what is left on average, a bar, and the soonest reset. */
/** Who resets at the next reset that matters: "mitra@… → 100% at Tue 21:40", one per line. */
function gainTooltip(gain: UsageResetGain): string {
  return gain.accounts.map((account) => {
    const at = new Date(account.at)
    return `${account.label} → 100% at ${at.toLocaleDateString([], { weekday: 'short' })} ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`
  }).join('\n')
}

function SummaryColumn({ summary, now }: { summary: UsageLimitSummary; now: number }) {
  const gain = summary.gain
  const minutes = minutesUntil(gain?.at, now)
  return <div className="usage-summary-col" data-testid="usage-summary-col" data-remaining={summary.remaining ?? 'unknown'} title={gain ? gainTooltip(gain) : undefined}>
    <span className="usage-summary-label settings-muted">{summary.label}</span>
    <span className="usage-summary-value">
      {summary.remaining === undefined ? <span className="settings-muted">Unknown</span> : <>{summary.remaining}% <span className="settings-muted">left</span></>}
    </span>
    <UsageBar remaining={summary.remaining} label={summary.heading} size="summary" />
    {gain && minutes !== undefined
      ? <span className="usage-summary-reset settings-muted" data-testid="usage-summary-gain"><span className="usage-summary-gain">+{gain.percent}%</span> in {formatCountdown(minutes)}</span>
      : <span className="usage-summary-reset settings-muted" data-testid="usage-summary-gain">no change soon</span>}
  </div>
}

/** One account's share left of one limit: the number, a short countdown, a thin bar; "—" when the account has no such limit. */
/** A sign-in's cell while its usage is still on the way. */
function PendingCell({ summary }: { summary: Pick<UsageLimitSummary, 'id' | 'heading'> }) {
  return <div className="usage-table-cell" role="cell" data-label={summary.heading} data-testid="usage-table-cell-loading" aria-busy="true">
    <span className="usage-skeleton usage-skeleton-value" aria-hidden="true" />
    <span className="usage-skeleton usage-skeleton-cellbar" aria-hidden="true" />
  </div>
}

/** The columns a table shows before any sign-in's usage arrived. */
const FIRST_COLUMNS: ReadonlyArray<Pick<UsageLimitSummary, 'id' | 'heading'>> = [{ id: 'five_hour', heading: '5-hour' }, { id: 'seven_day', heading: 'Weekly' }]

function LimitCell({ account, summary, now }: { account: UsageAccount; summary: UsageLimitSummary; now: number }) {
  const window = account.windows.find((entry) => entry.id === summary.id)
  if (!window) return <div className="usage-table-cell is-missing settings-muted" role="cell" data-label={summary.heading}>—</div>
  const remaining = remainingNow(window, now)
  const minutes = remaining === 100 ? undefined : minutesUntil(window.resetsAt, now)
  return <div className="usage-table-cell" role="cell" data-label={summary.heading} data-testid="usage-table-cell" data-remaining={remaining ?? 'unknown'} title={resetTooltip(window.resetsAt, now)}>
    <span className="usage-table-cell-top">
      <span className="usage-table-cell-value">{remaining === undefined ? '—' : `${remaining}%`}</span>
      {minutes !== undefined && <span className="usage-table-cell-reset settings-muted">{formatCountdown(minutes)}</span>}
    </span>
    <UsageBar remaining={remaining} label={`${account.label} ${summary.heading}`} size="cell" />
  </div>
}

function AccountName({ account, now }: { account: UsageAccount; now: number }) {
  const initial = account.label.trim().charAt(0).toUpperCase() || '?'
  const active = accountActive(account)
  return <div className={`usage-table-account${active ? '' : ' is-inactive'}`} role="rowheader">
    <span className="usage-avatar" aria-hidden="true" style={{ '--usage-avatar-hue': accountHue(account.id) } as CSSProperties}>{initial}</span>
    <span className="usage-table-account-name" title={account.label}>{account.label}</span>
    <UsageResetsChip resets={account.resets} now={now} />
  </div>
}

/**
 * A provider read through several accounts: a summary strip (each limit's average left across the
 * active accounts and its soonest reset), then a table of every account by limit. An account that
 * cannot be read says why across its limit columns.
 */
export function UsageAccountsView({ accounts, now }: { accounts: readonly UsageAccount[]; now: number }) {
  const summaries = summarizeAccounts(accounts, now)
  // Sign-ins still being read: their cells wait as skeletons, under the usual columns until one arrives.
  const pendingAny = accounts.some((account) => account.pending && account.windows.length === 0)
  const columns: ReadonlyArray<Pick<UsageLimitSummary, 'id' | 'heading'>> = summaries.length ? summaries : pendingAny ? FIRST_COLUMNS : []
  const grid = { '--usage-limit-columns': Math.max(1, columns.length) } as CSSProperties
  return <div className="usage-multi" data-testid="usage-accounts">
    {summaries.length > 0
      ? <div className="usage-summary" data-testid="usage-summary">
          {summaries.map((summary) => <SummaryColumn key={summary.id} summary={summary} now={now} />)}
        </div>
      : pendingAny && <div className="usage-summary" data-testid="usage-summary-loading" aria-busy="true">
          {columns.map((column) => <div key={column.id} className="usage-summary-col" aria-hidden="true">
            <span className="usage-skeleton usage-skeleton-label" />
            <span className="usage-skeleton usage-skeleton-big" />
            <span className="usage-skeleton usage-skeleton-bar" />
          </div>)}
        </div>}
    <div className="usage-table" role="table" aria-label="Limits by account" style={grid}>
      <div className="usage-table-row is-head" role="row">
        <span className="usage-table-heading" role="columnheader">Account</span>
        {columns.map((column) => <span key={column.id} className="usage-table-heading" role="columnheader">{column.heading}</span>)}
      </div>
      {accounts.map((account) => <div key={account.id} className="usage-table-row" role="row" data-testid="usage-account">
        <AccountName account={account} now={now} />
        {account.pending && account.windows.length === 0
          ? columns.map((column) => <PendingCell key={column.id} summary={column} />)
          : accountActive(account)
          ? summaries.map((summary) => <LimitCell key={summary.id} account={account} summary={summary} now={now} />)
          : <div className={`usage-table-problem${accountProblemIsInfo(account.problem) ? ' is-info' : ''}`} role="cell" data-testid="usage-account-problem">{accountProblemText(account.problem)}</div>}
      </div>)}
    </div>
  </div>
}
