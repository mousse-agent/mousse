import type { CSSProperties } from 'react'
import {
  accountActive, accountHue, formatCountdown, remainingNow, resetTooltip, summarizeAccounts, type UsageLimitSummary
} from '../lib/subscriptionUsage'
import type { UsageAccount } from '../../shared/providerAuth'
import { UsageBar } from './UsageBar'

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
function SummaryColumn({ summary, now }: { summary: UsageLimitSummary; now: number }) {
  const minutes = minutesUntil(summary.resetsAt, now)
  return <div className="usage-summary-col" data-testid="usage-summary-col" data-remaining={summary.remaining ?? 'unknown'} title={resetTooltip(summary.resetsAt, now)}>
    <span className="usage-summary-label settings-muted">{summary.label}</span>
    <span className="usage-summary-value">
      {summary.remaining === undefined ? <span className="settings-muted">Unknown</span> : <>{summary.remaining}% <span className="settings-muted">left</span></>}
    </span>
    <UsageBar remaining={summary.remaining} label={summary.heading} size="summary" />
    {minutes !== undefined && <span className="usage-summary-reset settings-muted">next reset in {formatCountdown(minutes)}</span>}
  </div>
}

/** One account's share left of one limit: the number, a short countdown, a thin bar; "—" when the account has no such limit. */
function LimitCell({ account, summary, now }: { account: UsageAccount; summary: UsageLimitSummary; now: number }) {
  const window = account.windows.find((entry) => entry.id === summary.id)
  if (!window) return <div className="usage-table-cell is-missing settings-muted" role="cell" data-label={summary.heading}>—</div>
  const remaining = remainingNow(window, now)
  const minutes = remaining === 100 ? undefined : minutesUntil(window.resetsAt, now)
  return <div className="usage-table-cell" role="cell" data-label={summary.heading} data-testid="usage-table-cell" data-remaining={remaining ?? 'unknown'} title={resetTooltip(window.resetsAt, now)}>
    <span className="usage-table-cell-top">
      <span className="usage-table-cell-value">{remaining === undefined ? '—' : `${remaining}%`}</span>
      {minutes !== undefined && <span className="usage-table-cell-reset settings-muted">{formatCountdown(minutes, { short: true })}</span>}
    </span>
    <UsageBar remaining={remaining} label={`${account.label} ${summary.heading}`} size="cell" />
  </div>
}

function AccountName({ account }: { account: UsageAccount }) {
  const initial = account.label.trim().charAt(0).toUpperCase() || '?'
  const active = accountActive(account)
  return <div className={`usage-table-account${active ? '' : ' is-inactive'}`} role="rowheader">
    <span className="usage-avatar" aria-hidden="true" style={{ '--usage-avatar-hue': accountHue(account.id) } as CSSProperties}>{initial}</span>
    <span className="usage-table-account-name" title={account.label}>{account.label}</span>
  </div>
}

/**
 * A provider read through several accounts: a summary strip (each limit's average left across the
 * active accounts and its soonest reset), then a table of every account by limit. An account that
 * cannot be read says why across its limit columns.
 */
export function UsageAccountsView({ accounts, now }: { accounts: readonly UsageAccount[]; now: number }) {
  const summaries = summarizeAccounts(accounts, now)
  const columns = { '--usage-limit-columns': Math.max(1, summaries.length) } as CSSProperties
  return <div className="usage-multi" data-testid="usage-accounts">
    {summaries.length > 0 && <div className="usage-summary" data-testid="usage-summary">
      {summaries.map((summary) => <SummaryColumn key={summary.id} summary={summary} now={now} />)}
    </div>}
    <div className="usage-table" role="table" aria-label="Limits by account" style={columns}>
      <div className="usage-table-row is-head" role="row">
        <span className="usage-table-heading" role="columnheader">Account</span>
        {summaries.map((summary) => <span key={summary.id} className="usage-table-heading" role="columnheader">{summary.heading}</span>)}
      </div>
      {accounts.map((account) => <div key={account.id} className="usage-table-row" role="row" data-testid="usage-account">
        <AccountName account={account} />
        {accountActive(account)
          ? summaries.map((summary) => <LimitCell key={summary.id} account={account} summary={summary} now={now} />)
          : <div className={`usage-table-problem${accountProblemIsInfo(account.problem) ? ' is-info' : ''}`} role="cell" data-testid="usage-account-problem">{accountProblemText(account.problem)}</div>}
      </div>)}
    </div>
  </div>
}
