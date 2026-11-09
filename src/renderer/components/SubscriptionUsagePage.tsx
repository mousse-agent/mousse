import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, ArrowLeft, ExternalLink, RefreshCw } from '../lib/icons'
import { useComputers } from '../lib/computers'
import {
  ALL_COMPUTERS, THIS_COMPUTER, resetsLabel, totalResets, formatResetLine, orderUsageWindows, remainingNow, rememberedUsageComputer, rememberUsageComputer, resetTooltip, shortUsageNote,
  usageReadAtLabel, usageReadingTime, usageRows, usageSelection, type ComputerUsage, resetEffect, resetOutcomeText
} from '../lib/subscriptionUsage'
import { useAppStore } from '../stores/appStore'
import { localDeviceName } from './sideCard/deviceMenu'
import { SettingsGroup } from './settings/SettingsRow'
import { DelayedLoader } from './ui/DelayedLoader'
import { Select } from './ui/Select'
import { needsProxyKey, ProxyKeyNote, UsageSettingsButton, type SaveProxyKey } from './UsageProxyControls'
import type { ProvidersUsageResponse, ProviderUsage, ProviderUsageWindow, UseLimitResetResponse } from '../../shared/providerAuth'
import { UsageBar } from './UsageBar'
import { activeAccountsLabel, UsageAccountsView } from './UsageAccountsView'
import { UsageResetsChip } from './UsageResetsChip'
import { soonestCredit, UsageResetButton, UsageResetConfirm, type ResetFlow } from './UsageResetAction'
import { UsageRowMenu, type UsageRowActions } from './UsageRowMenu'
import { Modal } from './ui/Modal'
import { showToast } from './ui/Toast'
import { readHiddenUsage, writeHiddenUsage } from '../lib/usageHidden'
import { DEVICE_SCOPE, onProviderSignInChanged } from '../lib/providerSnapshots'
import { usageInstanceId } from '../lib/usageSections'
import { AttentionRow, OtherUsageRow, UsageCardSkeleton, UsageCollapsibleSection, UsageRowSkeleton, UsageRowSlot } from './UsageSections'
import { motionAllowed } from './ui/Collapse'
import { orderAttention, rememberedSectionOpen, rememberSectionOpen, slotSection, usageSection } from '../lib/usageSections'
import { applyAccount, applyFailure, applyPreview, applyProvider, entriesResponse, loadingIds as entriesLoading, refreshEntries, removeEntry, startEntries, type UsageEntry } from '../lib/progressiveUsage'
import { openProvider } from '../lib/settingsNavigation'
import '../styles/settings.css'
import '../styles/usage.css'

/** How often an open Usage page reads the limits again. */
export const USAGE_REFRESH_MS = 5 * 60_000

/**
 * One limit window: its label and the share left on one line, a bar filled to what is left (it drains
 * as the limit is used, and takes on a little red as it nears empty), and when it resets under the
 * bar. An unknown share leaves the bar empty; a reset that has passed reads as 100% left.
 */
function UsageBarRow({ entry, now }: { entry: ProviderUsageWindow; now: number }) {
  const remaining = remainingNow(entry, now)
  const passed = remaining === 100 && entry.resetsAt !== undefined && Date.parse(entry.resetsAt) <= now
  const reset = passed ? undefined : formatResetLine(entry.resetsAt, now)
  return <div className="usage-window" data-testid="usage-window" data-remaining={remaining ?? 'unknown'}>
    <div className="usage-window-head">
      <span className="usage-window-label">{entry.label}</span>
      <span className={`usage-window-used${remaining === 0 ? ' is-empty' : ''}`}>{remaining === undefined ? <span className="settings-muted">Unknown</span> : <>{remaining}% <span className="settings-muted">left</span></>}</span>
    </div>
    <UsageBar remaining={remaining} label={entry.label} />
    {reset && <div className="usage-window-reset settings-muted" title={resetTooltip(entry.resetsAt, now)}>{reset}</div>}
  </div>
}

/** The provider's own note, in a few words, with the detail on hover. When the windows were taken is in the header. */
function UsageNote({ provider }: { provider: ProviderUsage }) {
  const note = shortUsageNote(provider.message)
  if (!note) return provider.windows.length === 0 && !provider.credit ? <p className="usage-message settings-muted">No usage reported.</p> : null
  return <p className={`usage-message${provider.status === 'error' ? ' settings-status-bad' : ' settings-muted'}`} data-testid="usage-note" title={note.detail}>{note.text}</p>
}

/** "As of 14:05" in the header, only for windows reported earlier than this reading. */
function UsageReadAt({ provider, now }: { provider: ProviderUsage; now: number }) {
  const label = usageReadAtLabel(provider.readAt, now)
  if (!label) return null
  return <span className="usage-provider-read-at settings-muted" data-testid="usage-read-at" title={`Reported ${new Date(provider.readAt!).toLocaleString()}`}>{label}</span>
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
  onBack: () => void
  onRefresh: () => void
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
}

export function SubscriptionUsageView({ usage, loading, failed, now, computers, selected, onSelect, remote, onBack, onRefresh, onManage, onSaveProxyKey, onClearProxyKey, loadingIds, onReconnect, hidden, rowActions, disableAsk, onDisableAnswer, onUseReset }: SubscriptionUsageViewProps) {
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
        onRefresh()
        return
      }
      setResetFlow({ providerId: provider.id, phase: 'done', message: resetEffect(credit?.type ?? 'codexRateLimits').done })
      onRefresh()
      setTimeout(() => setResetFlow((current) => (current?.providerId === provider.id && current.phase === 'done' ? null : current)), 2500)
    } catch {
      setResetFlow({ providerId: provider.id, phase: 'failed', message: "Couldn't use the reset" })
      // The reset may still have been used (a timeout): read the limits again before anyone tries again.
      onRefresh()
    } finally {
      resetRunning.current = false
    }
  }
  const [otherOpen, setOtherOpen] = useState<boolean | undefined>(() => rememberedSectionOpen('other'))
  const [attentionOpen, setAttentionOpen] = useState<boolean>(() => rememberedSectionOpen('attention') ?? false)
  const readAt = usage ? usageReadingTime(usage.fetchedAt) : undefined
  const picked = computers ? usageSelection(selected ?? ALL_COMPUTERS, [THIS_COMPUTER, ...computers.others.map((other) => other.id)]) : THIS_COMPUTER
  const readings: ComputerUsage[] = usage ? [{ id: THIS_COMPUTER, name: computers?.selfName ?? '', providers: usage.providers }, ...(computers ? remote ?? [] : [])] : []
  const rows = usage ? usageRows(readings, picked) : []
  const pickedOther = picked !== ALL_COMPUTERS && picked !== THIS_COMPUTER
  // Three sections: working plans as cards; credit balances, API keys and no-data rows in Other usage;
  // signed out, failing and no-subscription rows in Needs attention. A provider still on its way waits
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
  const menuFor = (row: { provider: ProviderUsage; computerName?: string }) =>
    rowActions && !row.computerName ? <UsageRowMenu provider={row.provider} hidden={isHidden(row)} actions={rowActions} /> : undefined
  const otherShown = otherOpen ?? subscriptions.length === 0
  const toggleOther = () => { const next = !otherShown; setOtherOpen(next); rememberSectionOpen('other', next) }
  const toggleAttention = () => { const next = !attentionOpen; setAttentionOpen(next); rememberSectionOpen('attention', next) }
  const revealAttention = () => {
    setAttentionOpen(true)
    rememberSectionOpen('attention', true)
    document.getElementById('usage-attention')?.scrollIntoView({ block: 'nearest', behavior: motionAllowed() ? 'smooth' : 'auto' })
  }
  return <section className="subscription-usage-page settings-scope" aria-labelledby="usage-title">
    <header className="rail-page-header usage-heading">
      <button type="button" className="settings-icon-btn" onClick={onBack} aria-label="Back" title="Back"><ArrowLeft size={14} aria-hidden="true" /></button>
      <h1 id="usage-title">Subscription usage</h1>
      {computers && <Select
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
      {attention.length > 0 && <button type="button" className="usage-attention-chip" data-testid="usage-attention-chip" onClick={revealAttention} title="Needs attention" aria-label={`${attention.length} need attention`}>
        <AlertTriangle size={12} aria-hidden="true" />{attention.length}
      </button>}
      <button type="button" className="settings-icon-btn" data-testid="usage-refresh" onClick={onRefresh} disabled={loading} aria-busy={loading || undefined} aria-label="Refresh usage" title="Refresh">
        <RefreshCw size={14} aria-hidden="true" className={loading ? 'icon-spin' : undefined} />
      </button>
    </header>
    <div className="subscription-usage-page-body">
      <div className="usage-content">
        {failed && <p className="usage-error" role="alert" data-testid="usage-error">
          <span>
            <span className="settings-status-bad">Couldn&apos;t refresh usage.</span>
            {usage && <span className="settings-muted" data-testid="usage-stale"> {readAt ? `Showing usage from ${readAt}.` : 'Showing earlier usage.'}</span>}
          </span>
          <button type="button" className="settings-btn" data-testid="usage-retry" onClick={onRefresh} disabled={loading}>Retry</button>
        </p>}
        {!usage && loading && <DelayedLoader label="Loading usage" className="usage-loader" data-testid="usage-loading" />}
        {usage && rows.length === 0 && !loading && <p className="settings-muted usage-empty" data-testid="usage-empty">{pickedOther ? 'No usage shared yet.' : 'No subscription providers are connected.'}</p>}
        {subscriptions.map(({ key, provider, computerName, loading: waiting }) => {
          // Proxy controls act on this computer's Claude only.
          const local = !computerName || computerName === computers?.selfName
          // Several sign-ins (a proxy): a summary strip and a table instead of one bar per window.
          const multi = provider.accounts && provider.accounts.length > 1 ? provider.accounts : undefined
          return <SettingsGroup
          key={key}
          // A proxy is named in the gear's tooltip, not in the title.
          title={provider.source && !provider.proxy ? `${provider.label} · ${provider.source}` : provider.label}
          titleAction={provider.plan || multi || resetsLabel(provider.resets) || (provider.proxy && onSaveProxyKey && onClearProxyKey && local)
            ? <>
                {provider.plan && <span className="usage-provider-plan settings-muted" data-testid="usage-provider-plan">{provider.plan}</span>}
                {multi && provider.proxy && <span className="usage-provider-plan settings-muted" data-testid="usage-provider-source">via CLI API proxy</span>}
                {!multi && <UsageResetsChip resets={provider.resets} now={now} />}
                {!multi && onUseReset && local && provider.id.startsWith('codex') && <UsageResetButton
                  resets={provider.resets}
                  hint={provider.windows.some((window) => (remainingNow(window, now) ?? 100) < 20)}
                  onStart={() => setResetFlow({ providerId: provider.id, phase: 'confirm' })}
                />}
                {provider.proxy && onSaveProxyKey && onClearProxyKey && local && <UsageSettingsButton provider={provider} onSave={onSaveProxyKey} onClear={onClearProxyKey} onSaved={onRefresh} />}
              </>
            : undefined}
          className="usage-provider usage-enter"
          action={computerName || provider.manageUrl || provider.readAt || multi
            ? <span className="usage-provider-actions">
                <UsageReadAt provider={provider} now={now} />
                {multi && totalResets(multi) > 0 && <span className="usage-provider-active settings-muted" data-testid="usage-resets-total">{totalResets(multi)} reset{totalResets(multi) === 1 ? '' : 's'} across accounts</span>}
                {multi && <span className="usage-provider-active settings-muted" data-testid="usage-accounts-active">{activeAccountsLabel(multi)}</span>}
                {computerName && <span className="usage-provider-computer settings-muted" data-testid="usage-provider-computer">{computerName}</span>}
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
            ? <ProxyKeyNote provider={provider} onSave={onSaveProxyKey} onSaved={onRefresh} />
            : !multi && !waiting && <UsageNote provider={provider} />}
          {!multi && onUseReset && local && provider.id.startsWith('codex') && <UsageResetConfirm
            resets={provider.resets}
            flow={resetFlow?.providerId === provider.id ? resetFlow : null}
            onConfirm={() => void runReset(provider)}
            onCancel={() => setResetFlow(null)}
          />}
        </SettingsGroup>
        })}
        {others.length > 0 && <UsageCollapsibleSection id="usage-other" title="Other usage" count={others.length} open={otherShown} onToggle={toggleOther}>
          {others.map((row) => <UsageRowSlot key={row.key} hidden={isHidden(row)} loading={row.loading}>
            {row.loading ? <UsageRowSkeleton provider={row.provider} /> : <OtherUsageRow provider={row.provider} {...(row.computerName ? { computerName: row.computerName } : {})} menu={menuFor(row)} />}
          </UsageRowSlot>)}
        </UsageCollapsibleSection>}
        {attention.length > 0 && <UsageCollapsibleSection id="usage-attention" title="Needs attention" count={attention.length} open={attentionOpen} onToggle={toggleAttention} dimmed>
          {attention.map((row) => <UsageRowSlot key={row.key} hidden={isHidden(row)} loading={row.loading}>
            {row.loading ? <UsageRowSkeleton provider={row.provider} /> : <AttentionRow provider={row.provider} {...(row.computerName ? { computerName: row.computerName } : {})} {...(onReconnect ? { onReconnect } : {})} menu={menuFor(row)} />}
          </UsageRowSlot>)}
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
      </div>
    </div>
  </section>
}

export function SubscriptionUsagePage({ onClose }: { onClose: () => void }) {
  // One computer: no picker. With others, a picker defaults to All computers and is kept for the session.
  const byNode = useComputers().byNode
  const others = Object.values(byNode).filter((computer) => computer.online).map((computer) => ({ id: computer.node, name: computer.name }))
  const linked = Object.keys(byNode).length > 0
  const selfName = useAppStore((state) => localDeviceName(state.appInfo?.deviceName))
  const [picked, setPicked] = useState(rememberedUsageComputer)
  const effective = usageSelection(picked, [THIS_COMPUTER, ...others.map((other) => other.id)])
  useEffect(() => {
    // The picked computer went away: back to All computers, also for the rest of the session.
    if (linked && effective !== picked) { setPicked(effective); rememberUsageComputer(effective) }
  }, [effective, linked, picked])
  const [entries, setEntries] = useState<UsageEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const mounted = useRef(true)
  const generation = useRef(0)
  const loadUsage = useCallback(async () => {
    setLoading(true)
    const run = ++generation.current
    const update = (change: (shown: UsageEntry[]) => UsageEntry[]) => {
      if (mounted.current && generation.current === run) setEntries((shown) => (shown ? change(shown) : shown))
    }
    const providers = window.mousse.providers
    try {
      // Every provider at once, each with its last reading; then each one as its own read answers.
      const { slots } = await providers.usageSlots()
      if (!mounted.current || generation.current !== run) return
      setEntries((shown) => (shown ? refreshEntries(shown, slots) : startEntries(slots)))
      setFailed(false)
      await Promise.all(slots.map(async (slot) => {
        try {
          if (slot.id === 'claude-subscription') {
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
        }
      }))
    } catch {
      // The list itself failed: the page keeps what it shows and says so.
      if (mounted.current && generation.current === run) setFailed(true)
    } finally {
      if (mounted.current && generation.current === run) { setLoading(false); setNow(Date.now()) }
    }
  }, [])
  const usage: ProvidersUsageResponse | null = entries ? entriesResponse(entries, now) : null
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
    await window.mousse.providers.instances.setEnabled(usageInstanceId(provider.id), DEVICE_SCOPE, false)
    void loadUsage()
  }
  const rowActions: UsageRowActions = {
    onHide: (provider) => {
      changeHidden((next) => next.add(provider.id))
      showToast({ message: 'Hidden', key: 'usage-hidden', action: { label: 'Undo', run: () => changeHidden((next) => next.delete(provider.id)) } })
    },
    onUnhide: (provider) => changeHidden((next) => next.delete(provider.id)),
    onDisable: (provider) => setDisableAsk(provider)
  }
  useEffect(() => {
    mounted.current = true
    void loadUsage()
    // Limits move while the page is open: read them again every few minutes.
    const timer = setInterval(() => void loadUsage(), USAGE_REFRESH_MS)
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
    onSelect={(value) => { setPicked(value); rememberUsageComputer(value) }}
    onBack={onClose}
    onRefresh={() => void loadUsage()}
    onManage={(url) => void window.mousse.providers.openLoginUrl(url)}
    onSaveProxyKey={(providerId, key) => window.mousse.providers.setUsageProxyKey(providerId, key)}
    onClearProxyKey={(providerId) => window.mousse.providers.clearUsageProxyKey(providerId)}
    loadingIds={entries ? entriesLoading(entries) : undefined}
    onReconnect={(instanceId) => { onClose(); openProvider(instanceId) }}
    hidden={hidden}
    rowActions={rowActions}
    onUseReset={(providerId, creditId) => window.mousse.providers.useLimitReset({ providerId, ...(creditId ? { creditId } : {}) })}
    disableAsk={disableAsk}
    onDisableAnswer={(confirmed) => (confirmed && disableAsk ? void disable(disableAsk) : setDisableAsk(null))}
  />
}
