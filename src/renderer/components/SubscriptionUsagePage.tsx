import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ExternalLink, RefreshCw } from '../lib/icons'
import { useComputers } from '../lib/computers'
import {
  ALL_COMPUTERS, THIS_COMPUTER, formatResetLine, orderUsageWindows, remainingNow, rememberedUsageComputer, rememberUsageComputer, resetTooltip, shortUsageNote,
  usageReadAtLabel, usageReadingTime, usageRows, usageSelection, type ComputerUsage
} from '../lib/subscriptionUsage'
import { useAppStore } from '../stores/appStore'
import { localDeviceName } from './sideCard/deviceMenu'
import { SettingsGroup } from './settings/SettingsRow'
import { DelayedLoader } from './ui/DelayedLoader'
import { Select } from './ui/Select'
import { needsProxyKey, ProxyKeyNote, UsageSettingsButton, type SaveProxyKey } from './UsageProxyControls'
import type { ProvidersUsageResponse, ProviderUsage, ProviderUsageWindow } from '../../shared/providerAuth'
import { UsageBar } from './UsageBar'
import { activeAccountsLabel, UsageAccountsView } from './UsageAccountsView'
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
      <span className="usage-window-used">{remaining === undefined ? <span className="settings-muted">Unknown</span> : <>{remaining}% <span className="settings-muted">left</span></>}</span>
    </div>
    <UsageBar remaining={remaining} label={entry.label} />
    {reset && <div className="usage-window-reset settings-muted" title={resetTooltip(entry.resetsAt, now)}>{reset}</div>}
  </div>
}

/** The provider's own note, in a few words, with the detail on hover. When the windows were taken is in the header. */
function UsageNote({ provider }: { provider: ProviderUsage }) {
  const note = shortUsageNote(provider.message)
  if (!note) return provider.windows.length === 0 ? <p className="usage-message settings-muted">No usage reported.</p> : null
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
}

export function SubscriptionUsageView({ usage, loading, failed, now, computers, selected, onSelect, remote, onBack, onRefresh, onManage, onSaveProxyKey, onClearProxyKey }: SubscriptionUsageViewProps) {
  const readAt = usage ? usageReadingTime(usage.fetchedAt) : undefined
  const picked = computers ? usageSelection(selected ?? ALL_COMPUTERS, [THIS_COMPUTER, ...computers.others.map((other) => other.id)]) : THIS_COMPUTER
  const readings: ComputerUsage[] = usage ? [{ id: THIS_COMPUTER, name: computers?.selfName ?? '', providers: usage.providers }, ...(computers ? remote ?? [] : [])] : []
  const rows = usage ? usageRows(readings, picked) : []
  const pickedOther = picked !== ALL_COMPUTERS && picked !== THIS_COMPUTER
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
        {usage && rows.length === 0 && <p className="settings-muted usage-empty" data-testid="usage-empty">{pickedOther ? 'No usage shared yet.' : 'No subscription providers are connected.'}</p>}
        {rows.map(({ key, provider, computerName }) => {
          // Proxy controls act on this computer's Claude only.
          const local = !computerName || computerName === computers?.selfName
          // Several sign-ins (a proxy): a summary strip and a table instead of one bar per window.
          const multi = provider.accounts && provider.accounts.length > 1 ? provider.accounts : undefined
          return <SettingsGroup
          key={key}
          // A proxy is named in the gear's tooltip, not in the title.
          title={provider.source && !provider.proxy ? `${provider.label} · ${provider.source}` : provider.label}
          titleAction={provider.plan || multi || (provider.proxy && onSaveProxyKey && onClearProxyKey && local)
            ? <>
                {provider.plan && <span className="usage-provider-plan settings-muted" data-testid="usage-provider-plan">{provider.plan}</span>}
                {multi && provider.proxy && <span className="usage-provider-plan settings-muted" data-testid="usage-provider-source">via CLI API proxy</span>}
                {provider.proxy && onSaveProxyKey && onClearProxyKey && local && <UsageSettingsButton provider={provider} onSave={onSaveProxyKey} onClear={onClearProxyKey} onSaved={onRefresh} />}
              </>
            : undefined}
          className="usage-provider"
          action={computerName || provider.manageUrl || provider.readAt || multi
            ? <span className="usage-provider-actions">
                <UsageReadAt provider={provider} now={now} />
                {multi && <span className="usage-provider-active settings-muted" data-testid="usage-accounts-active">{activeAccountsLabel(multi)}</span>}
                {computerName && <span className="usage-provider-computer settings-muted" data-testid="usage-provider-computer">{computerName}</span>}
                {provider.manageUrl && <button type="button" className="settings-icon-btn" onClick={() => onManage(provider.manageUrl!)} aria-label={`Open ${provider.label} usage page`} title="Open the provider's usage page">
                  <ExternalLink size={14} aria-hidden="true" />
                </button>}
              </span>
            : undefined}
        >
          {multi
            ? <UsageAccountsView accounts={multi} now={now} />
            : provider.windows.length > 0 && <div className="usage-windows">
                {orderUsageWindows(provider.windows).map((entry) => <UsageBarRow key={entry.id} entry={entry} now={now} />)}
              </div>}
          {needsProxyKey(provider) && onSaveProxyKey && local
            ? <ProxyKeyNote provider={provider} onSave={onSaveProxyKey} onSaved={onRefresh} />
            : !multi && <UsageNote provider={provider} />}
        </SettingsGroup>
        })}
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
  const [usage, setUsage] = useState<ProvidersUsageResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const mounted = useRef(true)
  const loadUsage = useCallback(async () => {
    setLoading(true)
    try {
      const next = await window.mousse.providers.getUsage()
      if (!mounted.current) return
      // A failed refresh keeps the last reading on screen, labelled with its time.
      setUsage(next); setFailed(false)
    } catch {
      if (mounted.current) setFailed(true)
    } finally {
      if (mounted.current) { setLoading(false); setNow(Date.now()) }
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    void loadUsage()
    // Limits move while the page is open: read them again every few minutes.
    const timer = setInterval(() => void loadUsage(), USAGE_REFRESH_MS)
    return () => { mounted.current = false; clearInterval(timer) }
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
  />
}
