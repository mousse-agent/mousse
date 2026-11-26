import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { UsageHistorySection } from './UsageHistorySection'
import { UsageTabs, readUsageTab, rememberUsageTab, type UsageTab } from './UsageTabs'
import { UsageLimitTrends } from './UsageLimitTrends'
import { paceRemaining } from '../lib/usagePace'
import type { LimitTrend, LimitTrendRange } from '../../shared/limitTrends'
import { AlertTriangle, ExternalLink, RefreshCw } from '../lib/icons'
import { useComputers } from '../lib/computers'
import {
  ALL_COMPUTERS, THIS_COMPUTER, resetsLabel, totalResets, formatResetLine, orderUsageWindows, remainingNow, rememberedUsageComputer, rememberUsageComputer, resetTooltip, shortUsageNote,
  usageLevel, usageReadAtLabel, usageReadingTime, usageRows, usageRunningLow, usageSelection, type ComputerUsage, resetEffect, resetOutcomeText
} from '../lib/subscriptionUsage'
import { useAppStore } from '../stores/appStore'
import { localDeviceName } from './sideCard/deviceMenu'
import { SettingsGroup } from './settings/SettingsRow'
import { DelayedLoader } from './ui/DelayedLoader'
import { Select } from './ui/Select'
import { CLAUDE_USAGE_ID } from './bots/botUsageRing'
import { needsProxyKey, ProxyKeyNote, UsageSettingsButton, type SaveProxyKey } from './UsageProxyControls'
import type { ProvidersUsageResponse, ProviderUsage, ProviderUsageWindow, UsageSlot, UseLimitResetResponse } from '../../shared/providerAuth'
import { UsageBar } from './UsageBar'
import { providerLogo, usageProviderTitle } from '../lib/usageProviderName'
import { activeAccountsLabel, UsageAccountsView } from './UsageAccountsView'
import { UsageResetsChip } from './UsageResetsChip'
import { soonestCredit, UsageResetButton, UsageResetConfirm, type ResetFlow } from './UsageResetAction'
import type { UsageRowActions } from './UsageRowMenu'
import { Modal } from './ui/Modal'
import { showToast } from './ui/Toast'
import { readHiddenUsage, writeHiddenUsage } from '../lib/usageHidden'
import { onProviderSignInChanged } from '../lib/providerSnapshots'
import { usageInstanceId } from '../lib/usageSections'
import { UsageCardSkeleton, UsageCollapsibleSection, UsageListRow, UsageRefreshButton } from './UsageSections'
import { motionAllowed } from './ui/Collapse'
import { orderAttention, rememberedSectionOpen, rememberSectionOpen, slotSection, usageSection } from '../lib/usageSections'
import { applyAccount, applyFailure, applyPreview, applyProvider, entriesResponse, keepCached, loadingIds as entriesLoading, recentlyRead, refreshEntries, removeEntry, startEntries, type UsageEntry } from '../lib/progressiveUsage'
import { openProvider } from '../lib/settingsNavigation'
import '../styles/settings.css'
import '../styles/usage.css'

/** How often an open Usage page reads the limits again. */
export const USAGE_REFRESH_MS = 5 * 60_000

/**
 * One limit window: its label and the share left on one line, a bar filled to what is left (it drains
 * as the limit is used; it and the share take their level's colour), and when it resets under the
 * bar. An unknown share leaves the bar empty; a reset that has passed reads as 100% left.
 */
function UsageBarRow({ entry, now }: { entry: ProviderUsageWindow; now: number }) {
  const remaining = remainingNow(entry, now)
  const passed = remaining === 100 && entry.resetsAt !== undefined && Date.parse(entry.resetsAt) <= now
  const reset = passed ? undefined : formatResetLine(entry.resetsAt, now)
  const pace = paceRemaining(entry, now)
  return <div className="usage-window" data-testid="usage-window" data-remaining={remaining ?? 'unknown'}>
    <div className="usage-window-head">
      <span className="usage-window-label">{entry.label}</span>
      <span className="usage-window-used usage-level-text" {...(remaining === undefined ? {} : { 'data-usage-level': usageLevel(remaining) })}>{remaining === undefined ? <span className="settings-muted">Unknown</span> : <>{remaining}% <span className="settings-muted">left</span></>}</span>
    </div>
    <div className="usage-window-bar" title={pace === undefined ? undefined : paceTitle(remaining, pace)}>
      <UsageBar remaining={remaining} label={entry.label} {...(pace === undefined ? {} : { pace })} />
    </div>
    {reset && <div className="usage-window-reset settings-muted" title={resetTooltip(entry.resetsAt, now)}>{reset}</div>}
  </div>
}

/** The provider's own note, in a few words, with the detail on hover. When the windows were taken is in the header. */
function UsageNote({ provider }: { provider: ProviderUsage }) {
  const note = shortUsageNote(provider.message)
  if (!note) return provider.windows.length === 0 && !provider.credit ? <p className="usage-message settings-muted">No usage reported.</p> : null
  return <p className={`usage-message${provider.status === 'error' ? ' settings-status-bad' : ' settings-muted'}`} data-testid="usage-note" title={note.detail}>{note.text}</p>
}

/** The tick in words, for the bar's tooltip: ahead of pace is using it faster than evenly. */
function paceTitle(remaining: number | undefined, pace: number): string {
  const even = `Even pace: ${Math.round(pace)}% left by now`
  if (remaining === undefined) return even
  const gap = Math.round(pace - remaining)
  return `${even} · ${gap === 0 ? 'on pace' : gap > 0 ? `${gap} points ahead of pace` : `${-gap} points behind pace`}`
}

/** "As of 14:05" in the header, only for windows reported earlier than this reading. */
function UsageReadAt({ provider, now }: { provider: ProviderUsage; now: number }) {
  const label = usageReadAtLabel(provider.readAt, now)
  if (!label) return null
  return <span className="usage-provider-read-at settings-muted" data-testid="usage-read-at" title={`Reported ${new Date(provider.readAt!).toLocaleString()}`}>{label}</span>
}

interface UsageProviderCardProps {
  provider: ProviderUsage
  /** Another computer's reading: its name. */
  computerName?: string
  /** Its fresh usage is still on the way. */
  waiting: boolean
  /** This computer's reading: proxy controls act on it. */
  local: boolean
  now: number
  /** It can use one of its limit resets here. */
  canReset: boolean
  /** The reset flow, when it is this card's. */
  flow: ResetFlow | null
  /** Reads this provider again, alone. */
  onRefresh: (providerId: string) => void
  /** Shows its own Refresh button (this computer's reading). */
  refreshable: boolean
  /** Its own read is running. */
  refreshing: boolean
  onManage: (url: string) => void
  onSaveProxyKey?: SaveProxyKey
  onClearProxyKey?: (providerId: string) => Promise<void>
  onStartReset: (providerId: string) => void
  onConfirmReset: (provider: ProviderUsage) => void
  onCancelReset: () => void
}

/**
 * One working plan's card: its limit windows, or its accounts' table. Memoized on its props, so one
 * provider's answer during a refresh re-renders that card only.
 */
const UsageProviderCard = memo(function UsageProviderCard({ provider, computerName, waiting, local, now, canReset, flow, onRefresh, refreshable, refreshing, onManage, onSaveProxyKey, onClearProxyKey, onStartReset, onConfirmReset, onCancelReset }: UsageProviderCardProps) {
  // Several sign-ins (a proxy): a summary strip and a table instead of one bar per window.
  const multi = provider.accounts && provider.accounts.length > 1 ? provider.accounts : undefined
  const refreshThis = () => onRefresh(provider.id)
  return <SettingsGroup
    // A proxy is named in the gear's tooltip, not in the title.
    title={provider.source && !provider.proxy ? `${usageProviderTitle(provider)} · ${provider.source}` : usageProviderTitle(provider)}
    icon={providerLogo(provider.id)}
    titleAction={provider.plan || multi || resetsLabel(provider.resets) || (provider.proxy && onSaveProxyKey && onClearProxyKey && local)
      ? <>
          {provider.plan && <span className="usage-provider-plan settings-muted" data-testid="usage-provider-plan">{provider.plan}</span>}
          {multi && provider.proxy && <span className="usage-provider-plan settings-muted" data-testid="usage-provider-source">via CLI API proxy</span>}
          {!multi && <UsageResetsChip resets={provider.resets} now={now} />}
          {!multi && canReset && <UsageResetButton
            resets={provider.resets}
            hint={provider.windows.some((window) => usageRunningLow(remainingNow(window, now) ?? 100))}
            onStart={() => onStartReset(provider.id)}
          />}
          {provider.proxy && onSaveProxyKey && onClearProxyKey && local && <UsageSettingsButton provider={provider} onSave={onSaveProxyKey} onClear={onClearProxyKey} onSaved={refreshThis} />}
        </>
      : undefined}
    className="usage-provider usage-enter"
    action={computerName || provider.manageUrl || provider.readAt || multi || refreshable
      ? <span className="usage-provider-actions">
          <UsageReadAt provider={provider} now={now} />
          {multi && totalResets(multi) > 0 && <span className="usage-provider-active settings-muted" data-testid="usage-resets-total">{totalResets(multi)} reset{totalResets(multi) === 1 ? '' : 's'} across accounts</span>}
          {multi && <span className="usage-provider-active settings-muted" data-testid="usage-accounts-active">{activeAccountsLabel(multi)}</span>}
          {computerName && <span className="usage-provider-computer settings-muted" data-testid="usage-provider-computer">{computerName}</span>}
          {refreshable && <UsageRefreshButton provider={provider} refreshing={refreshing} onRefresh={onRefresh} />}
          {provider.manageUrl && <button type="button" className="settings-icon-btn" onClick={() => onManage(provider.manageUrl!)} aria-label={`Open ${provider.label} usage page`} title="Open the provider's usage page">
            <ExternalLink size={14} aria-hidden="true" />
          </button>}
        </span>
      : undefined}
  >
    {waiting && !multi && <UsageCardSkeleton />}
    {multi
      ? <UsageAccountsView accounts={multi} now={now} />
      : provider.windows.length > 0 && <div className="usage-windows">
          {orderUsageWindows(provider.windows).map((entry) => <UsageBarRow key={entry.id} entry={entry} now={now} />)}
        </div>}
    {needsProxyKey(provider) && onSaveProxyKey && local
      ? <ProxyKeyNote provider={provider} onSave={onSaveProxyKey} onSaved={refreshThis} />
      : !multi && !waiting && <UsageNote provider={provider} />}
    {!multi && canReset && <UsageResetConfirm
      resets={provider.resets}
      flow={flow}
      onConfirm={() => onConfirmReset(provider)}
      onCancel={onCancelReset}
    />}
  </SettingsGroup>
})

/**
 * Claude's usage is shown only as its CLI API proxy reads it: without the proxy's numbers it has no row or card,
 * except the card that asks for the proxy's key, which is how those numbers start.
 */
export function hiddenClaude(provider: ProviderUsage): boolean {
  if (provider.id !== CLAUDE_USAGE_ID || needsProxyKey(provider)) return false
  return !provider.proxy || (provider.windows.length === 0 && !provider.accounts?.length)
}

export interface SubscriptionUsageViewProps {
  /** The last reading, kept after a failed refresh. Null before the first one arrives. */
  usage: ProvidersUsageResponse | null
  loading: boolean
  /** The last read failed. */
  failed: boolean
  now: number
  /** The computer picker, only when the person has other computers: this one's name and the others. */
  computers?: { selfName: string; others: ReadonlyArray<{ id: string; name: string }> }
  /** The picked computer (default All computers) and how to change it. */
  selected?: string
  onSelect?: (value: string) => void
  /** Other computers' readings, by node id, when they share them. */
  remote?: readonly ComputerUsage[]
  /** Reads every provider again (Refresh all, Retry). */
  onRefresh: () => void
  /** Reads one of this computer's providers again from its Refresh button or after a reset. */
  onRefreshProvider?: (providerId: string) => void
  /** Providers whose own read is running. */
  refreshingIds?: ReadonlySet<string>
  onManage: (url: string) => void
  /** Saves or removes the key of the CLI API proxy a provider's usage is read through. */
  onSaveProxyKey?: SaveProxyKey
  onClearProxyKey?: (providerId: string) => Promise<void>
  /** Providers whose usage has not arrived yet: drawn as skeletons in the section their slot suggests. */
  loadingIds?: ReadonlySet<string>
  /** Opens a provider's settings (an instance id), for Reconnect. */
  onReconnect?: (instanceId: string) => void
  /** Uses one of a provider's limit resets (Codex); the chip asks first. */
  onUseReset?: (providerId: string, creditId: string | undefined) => Promise<UseLimitResetResponse>
  /** Providers hidden from this page (Other usage and Needs attention rows), and what their "…" menu does. */
  hidden?: ReadonlySet<string>
  rowActions?: UsageRowActions
  /** The provider Disable is asking about, and the answer. */
  disableAsk?: ProviderUsage | null
  onDisableAnswer?: (confirmed: boolean) => void
  /** Usage history over time. With it the page has two tabs: History shows it, Limits the limits. */
  history?: ReactNode
  /** The 5-hour and weekly limits over time, at the top of the Limits tab. */
  limitTrends?: ReactNode
  tab?: UsageTab
  onTab?: (tab: UsageTab) => void
}

export function SubscriptionUsageView({ usage, loading, failed, now, computers, selected, onSelect, remote, onRefresh, onRefreshProvider, refreshingIds, onManage, onSaveProxyKey, onClearProxyKey, loadingIds, onReconnect, hidden, rowActions, disableAsk, onDisableAnswer, onUseReset, history, limitTrends, tab = 'history', onTab }: SubscriptionUsageViewProps) {
  // One provider read again when the page can, else all of them.
  const refreshOne = useCallback((providerId: string) => (onRefreshProvider ? onRefreshProvider(providerId) : onRefresh()), [onRefreshProvider, onRefresh])
  const [showHidden, setShowHidden] = useState(false)
  // Using a limit reset, for one card at a time: asked from its header button, answered in its own row.
  const [resetFlow, setResetFlow] = useState<ResetFlow | null>(null)
  // One reset at a time: a second Reset now while one is out uses nothing (each call spends a credit).
  const resetRunning = useRef(false)
  const runReset = async (provider: ProviderUsage) => {
    if (!onUseReset || resetRunning.current) return
    resetRunning.current = true
    const credit = soonestCredit(provider.resets)
    setResetFlow({ providerId: provider.id, phase: 'working' })
    try {
      const { outcome } = await onUseReset(provider.id, credit?.id)
      const failed = resetOutcomeText(outcome)
      if (failed) {
        setResetFlow({ providerId: provider.id, phase: 'failed', message: failed })
        refreshOne(provider.id)
        return
      }
      setResetFlow({ providerId: provider.id, phase: 'done', message: resetEffect(credit?.type ?? 'codexRateLimits').done })
      refreshOne(provider.id)
      setTimeout(() => setResetFlow((current) => (current?.providerId === provider.id && current.phase === 'done' ? null : current)), 2500)
    } catch {
      setResetFlow({ providerId: provider.id, phase: 'failed', message: "Couldn't use the reset" })
      // The reset may still have been used (a timeout): read the limits again before anyone tries again.
      refreshOne(provider.id)
    } finally {
      resetRunning.current = false
    }
  }
  // The cards' reset callbacks keep their identity, so a card re-renders only when its own props change.
  const runResetRef = useRef(runReset)
  runResetRef.current = runReset
  const confirmReset = useCallback((provider: ProviderUsage) => void runResetRef.current(provider), [])
  const startReset = useCallback((providerId: string) => setResetFlow({ providerId, phase: 'confirm' }), [])
  const cancelReset = useCallback(() => setResetFlow(null), [])
  const [otherOpen, setOtherOpen] = useState<boolean | undefined>(() => rememberedSectionOpen('other'))
  const [attentionOpen, setAttentionOpen] = useState<boolean>(() => rememberedSectionOpen('attention') ?? false)
  const readAt = usage ? usageReadingTime(usage.fetchedAt) : undefined
  const picked = computers ? usageSelection(selected ?? ALL_COMPUTERS, [THIS_COMPUTER, ...computers.others.map((other) => other.id)]) : THIS_COMPUTER
  const readings: ComputerUsage[] = usage ? [{ id: THIS_COMPUTER, name: computers?.selfName ?? '', providers: usage.providers }, ...(computers ? remote ?? [] : [])] : []
  // A provider still on its way keeps its placeholder: whether Claude has the proxy's numbers is known only once read.
  const rows = usage ? usageRows(readings, picked).filter((row) => !hiddenClaude(row.provider) || !!loadingIds?.has(row.provider.id)) : []
  const pickedOther = picked !== ALL_COMPUTERS && picked !== THIS_COMPUTER
  const localRow = (row: { provider: ProviderUsage; computerName?: string }) =>
    !pickedOther && (!row.computerName || row.computerName === computers?.selfName) &&
    !!usage?.providers.some((provider) => provider.id === row.provider.id)
  // Three sections: working plans as cards; credit balances, API keys, no-data and no-subscription rows in
  // Other usage; signed out and failing rows in Needs attention. A provider still on its way waits
  // where its slot suggests.
  const placed = rows.map((row) => ({ ...row, loading: !!loadingIds?.has(row.provider.id) }))
    .map((row) => ({ ...row, section: row.loading ? slotSection(row.provider) : usageSection(row.provider) }))
  const subscriptions = placed.filter((row) => row.section === 'subscription')
  // Rows hidden from the page wait behind the footer's Show; shown, they stay dimmed.
  const isHidden = (row: { provider: ProviderUsage; computerName?: string }) => !row.computerName && !!hidden?.has(row.provider.id)
  const listed = placed.filter((row) => row.section !== 'subscription')
  const hiddenCount = listed.filter(isHidden).length
  const visible = (row: (typeof listed)[number]) => showHidden || !isHidden(row)
  const others = listed.filter((row) => row.section === 'other' && visible(row))
  const attention = orderAttention(listed.filter((row) => row.section === 'attention' && visible(row)))
  const listRow = (kind: 'other' | 'attention', row: (typeof listed)[number]) => <UsageListRow
    key={row.key}
    kind={kind}
    provider={row.provider}
    {...(row.computerName ? { computerName: row.computerName } : {})}
    loading={row.loading}
    hidden={isHidden(row)}
    {...(rowActions ? { actions: rowActions } : {})}
    {...(onReconnect ? { onReconnect } : {})}
    {...(onRefreshProvider && localRow(row) ? { onRefresh: refreshOne, refreshing: !!refreshingIds?.has(row.provider.id) } : {})}
  />
  const otherShown = otherOpen ?? subscriptions.length === 0
  const toggleOther = () => { const next = !otherShown; setOtherOpen(next); rememberSectionOpen('other', next) }
  const toggleAttention = () => { const next = !attentionOpen; setAttentionOpen(next); rememberSectionOpen('attention', next) }
  // With history, the limits are one of the page's tabs; without it they are the whole page.
  const showLimits = !history || tab === 'limits'
  const revealAttention = () => {
    setAttentionOpen(true)
    rememberSectionOpen('attention', true)
    onTab?.('limits')
    // On another tab the section is drawn first, then scrolled to.
    requestAnimationFrame(() => document.getElementById('usage-attention')?.scrollIntoView({ block: 'nearest', behavior: motionAllowed() ? 'smooth' : 'auto' }))
  }
  return <section className="subscription-usage-page settings-scope" aria-label="Usage">
    <header className={`rail-page-header usage-heading${history ? ' has-tabs' : ''}`}>
      <div className="usage-heading-start">
        {computers && showLimits && <Select
          className="usage-computer-select"
          variant="menu"
          size="small"
          ariaLabel="Computer"
          data-testid="usage-computer"
          value={picked}
          onChange={(value) => onSelect?.(value)}
          options={[
            { value: ALL_COMPUTERS, label: 'All computers' },
            { value: THIS_COMPUTER, label: `${computers.selfName} · this computer` },
            ...computers.others.map((other) => ({ value: other.id, label: other.name }))
          ]}
        />}
      </div>
      {history && <UsageTabs tab={tab} onTab={(next) => onTab?.(next)} />}
      <div className="usage-heading-end">
        {attention.length > 0 && <button type="button" className="usage-attention-chip" data-testid="usage-attention-chip" onClick={revealAttention} title="Needs attention" aria-label={`${attention.length} need attention`}>
          <AlertTriangle size={12} aria-hidden="true" />{attention.length}
        </button>}
        {/* Before the first reading there is nothing to refresh: only the loader shows. */}
        {showLimits && !pickedOther && (usage || !loading) && <button type="button" className="settings-btn" data-testid="usage-refresh" onClick={onRefresh} disabled={loading} aria-busy={loading || undefined}>
          <RefreshCw size={14} aria-hidden="true" className={loading ? 'icon-spin' : undefined} />
          Refresh all
        </button>}
      </div>
    </header>
    <div className="subscription-usage-page-body">
      <div className={`usage-content${history ? ' has-history' : ''}`}>
        {/* Kept while Limits shows, so coming back draws the last reading at once. */}
        {history && <div id="usage-history-panel" role="tabpanel" aria-labelledby="usage-history-tab" hidden={tab === 'limits'}>{history}</div>}
        {showLimits && <div id="usage-limits-panel" {...(history ? { role: 'tabpanel', 'aria-labelledby': 'usage-limits-tab', className: 'usage-limits' } : {})}>
          {history && limitTrends}
          {failed && <p className="usage-error" role="alert" data-testid="usage-error">
            <span>
              <span className="settings-status-bad">Couldn&apos;t refresh usage.</span>
              {usage && <span className="settings-muted" data-testid="usage-stale"> {readAt ? `Showing usage from ${readAt}.` : 'Showing earlier usage.'}</span>}
            </span>
            <button type="button" className="settings-btn" data-testid="usage-retry" onClick={onRefresh} disabled={loading}>Retry</button>
          </p>}
          {!usage && loading && <DelayedLoader label="Loading usage" className="usage-loader" data-testid="usage-loading" />}
          {usage && rows.length === 0 && !loading && <p className="settings-muted usage-empty" data-testid="usage-empty">{pickedOther ? 'No usage shared yet.' : 'No subscription providers are connected.'}</p>}
          {subscriptions.map((row) => {
            const { key, provider, computerName, loading: waiting } = row
            // Proxy controls act on this computer's Claude only.
            const local = localRow(row)
            return <UsageProviderCard
              key={key}
              provider={provider}
              {...(computerName ? { computerName } : {})}
              waiting={waiting}
              local={local}
              now={now}
              canReset={!!onUseReset && local && !!provider.resettable}
              flow={resetFlow?.providerId === provider.id ? resetFlow : null}
              onRefresh={refreshOne}
              refreshable={!!onRefreshProvider && local}
              refreshing={!!refreshingIds?.has(provider.id)}
              onManage={onManage}
              {...(onSaveProxyKey ? { onSaveProxyKey } : {})}
              {...(onClearProxyKey ? { onClearProxyKey } : {})}
              onStartReset={startReset}
              onConfirmReset={confirmReset}
              onCancelReset={cancelReset}
            />
          })}
          {others.length > 0 && <UsageCollapsibleSection id="usage-other" title="Other usage" count={others.length} open={otherShown} onToggle={toggleOther}>
            {others.map((row) => listRow('other', row))}
          </UsageCollapsibleSection>}
          {attention.length > 0 && <UsageCollapsibleSection id="usage-attention" title="Needs attention" count={attention.length} open={attentionOpen} onToggle={toggleAttention} dimmed>
            {attention.map((row) => listRow('attention', row))}
          </UsageCollapsibleSection>}
          {disableAsk && onDisableAnswer && <Modal
            open
            title={`Disable ${disableAsk.label}?`}
            hideTitle
            className="git-discard-dialog"
            onClose={() => onDisableAnswer(false)}
            footer={<>
              <button type="button" className="btn" onClick={() => onDisableAnswer(false)}>Cancel</button>
              <button type="button" className="btn btn-danger" data-testid="usage-disable-confirm" onClick={() => onDisableAnswer(true)}>Disable</button>
            </>}
          >
            <p className="git-discard-lead">Disable {disableAsk.label}?</p>
            <p className="git-discard-detail">It won&apos;t be offered for new threads. You can turn it back on in Settings.</p>
          </Modal>}
          {hiddenCount > 0 && <p className="usage-hidden-footer settings-muted" data-testid="usage-hidden-footer">
            {hiddenCount} hidden · <button type="button" className="usage-text-btn" data-testid="usage-hidden-toggle" onClick={() => setShowHidden((value) => !value)}>{showHidden ? 'Hide' : 'Show'}</button>
          </p>}
        </div>}
      </div>
    </div>
  </section>
}

// What the page asks of the app, defined once so the cards and rows they reach keep their props.
const manageUsage = (url: string) => void window.mousse.providers.openLoginUrl(url)
const saveProxyKey: SaveProxyKey = (providerId, key) => window.mousse.providers.setUsageProxyKey(providerId, key)
const clearProxyKey = (providerId: string) => window.mousse.providers.clearUsageProxyKey(providerId)
const useReset = (providerId: string, creditId: string | undefined) => window.mousse.providers.useLimitReset({ providerId, ...(creditId ? { creditId } : {}) })

export function SubscriptionUsagePage({ onClose }: { onClose: () => void }) {
  // One computer: no picker. With others, a picker defaults to All computers and is kept for the session.
  const byNode = useComputers().byNode
  const others = Object.values(byNode).filter((computer) => computer.online).map((computer) => ({ id: computer.node, name: computer.name }))
  const linked = Object.keys(byNode).length > 0
  const selfName = useAppStore((state) => localDeviceName(state.appInfo?.deviceName))
  const [picked, setPicked] = useState(rememberedUsageComputer)
  const [tab, setTab] = useState<UsageTab>(readUsageTab)
  const changeTab = useCallback((next: UsageTab) => { setTab(next); rememberUsageTab(next) }, [])
  const pickComputer = useCallback((value: string) => { setPicked(value); rememberUsageComputer(value) }, [])
  const effective = usageSelection(picked, [THIS_COMPUTER, ...others.map((other) => other.id)])
  useEffect(() => {
    // The picked computer went away: back to All computers, also for the rest of the session.
    if (linked && effective !== picked) { setPicked(effective); rememberUsageComputer(effective) }
  }, [effective, linked, picked])
  const [entries, setEntries] = useState<UsageEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  // The providers whose own read is running, for their cards' spinning Refresh.
  const [reading, setReading] = useState<ReadonlySet<string>>(() => new Set())
  const [failed, setFailed] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const mounted = useRef(true)
  // The limits' trends, this computer's own readings: read when Limits shows, after each read of the usage.
  const [trendRange, setTrendRange] = useState<LimitTrendRange>('7d')
  // Null until the first answer, so an empty chart is never shown before the readings are known.
  const [trends, setTrends] = useState<LimitTrend[] | null>(null)
  // A read of the usage keeps new limit readings: the trends are read again once none is running.
  const busy = loading || reading.size > 0
  useEffect(() => {
    if (tab !== 'limits' || busy) return
    let current = true
    void window.mousse.providers.limitTrends?.(trendRange)
      .then((reply) => { if (current) setTrends(Array.isArray(reply?.trends) ? reply.trends : []) })
      .catch(() => undefined)
    return () => { current = false }
  }, [tab, trendRange, busy])
  // Each provider's read belongs to the latest run that asked for it: a newer read of the same provider
  // (Refresh all, or its own Refresh) makes an older one's answer stale; other providers' reads carry on.
  const generation = useRef(0)
  const listRun = useRef(0)
  const runs = useRef(new Map<string, number>())
  const entriesRef = useRef(entries)
  entriesRef.current = entries
  const markReading = useCallback((ids: readonly string[], on: boolean) => setReading((current) => {
    const next = new Set(current)
    for (const id of ids) { if (on) next.add(id); else next.delete(id) }
    return next
  }), [])
  /** One provider's progressive read, as run \`run\`; its answers land only while that run is its latest. */
  const readSlot = useCallback(async (slot: UsageSlot, run: number) => {
    const latest = () => mounted.current && runs.current.get(slot.id) === run
    const update = (change: (shown: UsageEntry[]) => UsageEntry[]) => {
      if (latest()) setEntries((shown) => (shown ? change(shown) : shown))
    }
    const providers = window.mousse.providers
    try {
      if (slot.previewAccounts) {
        // Several proxy sign-ins: listed first, then filled in one by one.
        const { provider: preview } = await providers.getUsageFor({ providerId: slot.id, preview: true })
        if (preview?.accounts?.length) {
          update((shown) => applyPreview(shown, preview))
          await Promise.all(preview.accounts.filter((account) => account.pending).map(async (account) => {
            const { account: read } = await providers.getUsageFor({ providerId: slot.id, accountId: account.id }).catch(() => ({ account: undefined }))
            update((shown) => applyAccount(shown, slot.id, read ?? { id: account.id, label: account.label, windows: [], problem: 'Not reachable' }))
          }))
          return
        }
      }
      const { provider } = await providers.getUsageFor({ providerId: slot.id })
      update((shown) => (provider ? applyProvider(shown, provider) : removeEntry(shown, slot.id)))
    } catch {
      update((shown) => applyFailure(shown, slot.id))
    } finally {
      if (runs.current.get(slot.id) === run) {
        runs.current.delete(slot.id)
        if (mounted.current) markReading([slot.id], false)
      }
    }
  }, [markReading])
  /**
   * Every provider: the list at once, each with its last reading, then each one as its own read answers.
   * Automatic refresh keeps readings from the last ten minutes, including background reads.
   */
  const loadUsage = useCallback(async ({ skipRecent = false }: { skipRecent?: boolean } = {}) => {
    setLoading(true)
    const run = ++generation.current
    listRun.current = run
    try {
      const { slots } = await window.mousse.providers.usageSlots()
      if (!mounted.current || listRun.current !== run) return
      const at = Date.now()
      const recent = skipRecent ? slots.filter((slot) => !runs.current.has(slot.id) && recentlyRead(slot, at)) : []
      const kept = new Set(recent.map((slot) => slot.id))
      const toRead = slots.filter((slot) => !kept.has(slot.id) && (!skipRecent || !runs.current.has(slot.id)))
      for (const slot of toRead) runs.current.set(slot.id, run)
      setEntries((shown) => keepCached(shown ? refreshEntries(shown, slots) : startEntries(slots), recent))
      markReading(toRead.map((slot) => slot.id), true)
      setFailed(false)
      await Promise.all(toRead.map((slot) => readSlot(slot, run)))
    } catch {
      // The list itself failed: the page keeps what it shows and says so.
      if (mounted.current && listRun.current === run) setFailed(true)
    } finally {
      if (mounted.current && listRun.current === run) { setLoading(false); setNow(Date.now()) }
    }
  }, [markReading, readSlot])
  /** One provider read again, alone. */
  const refreshProvider = useCallback(async (providerId: string) => {
    const slot = entriesRef.current?.find((entry) => entry.slot.id === providerId)?.slot
    if (!slot) return
    const run = ++generation.current
    runs.current.set(providerId, run)
    markReading([providerId], true)
    await readSlot(slot, run)
    if (mounted.current) setNow(Date.now())
  }, [markReading, readSlot])
  // Kept between renders, with each provider's own object, so the cards and rows that did not change skip re-rendering.
  const usage: ProvidersUsageResponse | null = useMemo(() => (entries ? entriesResponse(entries, now) : null), [entries, now])
  const loadingIds = useMemo(() => (entries ? entriesLoading(entries) : undefined), [entries])
  const profileId = useAppStore((state) => state.profileId)
  const [hidden, setHidden] = useState<Set<string>>(() => readHiddenUsage(profileId))
  useEffect(() => setHidden(readHiddenUsage(profileId)), [profileId])
  const changeHidden = useCallback((change: (next: Set<string>) => void) => {
    setHidden((current) => {
      const next = new Set(current)
      change(next)
      writeHiddenUsage(profileId, next)
      return next
    })
  }, [profileId])
  const [disableAsk, setDisableAsk] = useState<ProviderUsage | null>(null)
  const disable = async (provider: ProviderUsage) => {
    setDisableAsk(null)
    // The same switch as Settings → Providers: off on this computer; existing threads stay as they are.
    await window.mousse.providers.instances.setEnabled(usageInstanceId(provider), false)
    void loadUsage()
  }
  const rowActions = useMemo<UsageRowActions>(() => ({
    onHide: (provider) => {
      changeHidden((next) => next.add(provider.id))
      showToast({ message: 'Hidden', key: 'usage-hidden', action: { label: 'Undo', run: () => changeHidden((next) => next.delete(provider.id)) } })
    },
    onUnhide: (provider) => changeHidden((next) => next.delete(provider.id)),
    onDisable: (provider) => setDisableAsk(provider)
  }), [changeHidden])
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const refresh = useCallback(() => void loadUsage(), [loadUsage])
  const refreshOne = useCallback((providerId: string) => void refreshProvider(providerId), [refreshProvider])
  const reconnect = useCallback((instanceId: string) => { closeRef.current(); openProvider(instanceId) }, [])
  useEffect(() => {
    mounted.current = true
    const refreshStale = () => void loadUsage({ skipRecent: true })
    refreshStale()
    const timer = setInterval(refreshStale, USAGE_REFRESH_MS)
    // A provider signed in, out or to another account: read again. The event names no provider, so the
    // whole progressive read runs; every row keeps what it shows until its own fresh reading replaces it.
    const stopListening = onProviderSignInChanged(() => void loadUsage())
    return () => { mounted.current = false; clearInterval(timer); stopListening() }
  }, [loadUsage])
  return <SubscriptionUsageView
    usage={usage}
    loading={loading}
    failed={failed}
    now={now}
    computers={linked ? { selfName, others } : undefined}
    selected={effective}
    onSelect={pickComputer}
    onRefresh={refresh}
    onRefreshProvider={refreshOne}
    refreshingIds={reading}
    onManage={manageUsage}
    onSaveProxyKey={saveProxyKey}
    onClearProxyKey={clearProxyKey}
    loadingIds={loadingIds}
    onReconnect={reconnect}
    hidden={hidden}
    rowActions={rowActions}
    onUseReset={useReset}
    disableAsk={disableAsk}
    onDisableAnswer={(confirmed) => (confirmed && disableAsk ? void disable(disableAsk) : setDisableAsk(null))}
    history={<UsageHistorySection
      {...(linked ? { devices: { selfName, others }, device: effective, onDevice: pickComputer } : {})}
    />}
    // Another computer's limits have no trends here: the readings stay on each computer.
    limitTrends={trends && (effective === THIS_COMPUTER || effective === ALL_COMPUTERS)
      ? <UsageLimitTrends trends={trends} range={trendRange} onRange={setTrendRange} localOnly={linked && effective === ALL_COMPUTERS} />
      : null}
    tab={tab}
    onTab={changeTab}
  />
}
