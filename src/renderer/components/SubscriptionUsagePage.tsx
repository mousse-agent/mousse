import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ExternalLink, RefreshCw } from '../lib/icons'
import { useComputers } from '../lib/computers'
import { remainingPercent, usageReadingTime, usageTone, usageWindowLine, type UsageTone } from '../lib/subscriptionUsage'
import { useAppStore } from '../stores/appStore'
import { localDeviceName } from './sideCard/deviceMenu'
import { SettingsGroup } from './settings/SettingsRow'
import { DelayedLoader } from './ui/DelayedLoader'
import type { ProvidersUsageResponse, ProviderUsageWindow } from '../../shared/providerAuth'
import '../styles/settings.css'
import '../styles/usage.css'

const RING = 16
const RING_STROKE = 2.5
const RING_RADIUS = (RING - RING_STROKE) / 2
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/** A small ring for the share of a window that is left. The text beside it carries the number. */
export function UsageRing({ remaining, tone }: { remaining: number; tone: UsageTone }) {
  const length = (remaining / 100) * RING_CIRCUMFERENCE
  return <svg className={`usage-ring is-${tone}`} width={RING} height={RING} viewBox={`0 0 ${RING} ${RING}`} aria-hidden="true" data-testid="usage-ring">
    <circle className="usage-ring-track" cx={RING / 2} cy={RING / 2} r={RING_RADIUS} strokeWidth={RING_STROKE} />
    <circle
      className="usage-ring-arc"
      cx={RING / 2}
      cy={RING / 2}
      r={RING_RADIUS}
      strokeWidth={RING_STROKE}
      strokeDasharray={`${length} ${RING_CIRCUMFERENCE - length}`}
      transform={`rotate(-90 ${RING / 2} ${RING / 2})`}
    />
  </svg>
}

/** One window: a ring only for a known share above zero; zero and unknown are words alone. */
function UsageWindowRow({ entry, now }: { entry: ProviderUsageWindow; now: number }) {
  const remaining = remainingPercent(entry)
  const tone = remaining === undefined ? undefined : usageTone(remaining)
  const resetsAt = entry.resetsAt && !Number.isNaN(Date.parse(entry.resetsAt)) ? new Date(entry.resetsAt).toLocaleString() : undefined
  return <div className="usage-window" data-testid="usage-window" data-remaining={remaining ?? 'unknown'} title={resetsAt ? `Resets ${resetsAt}` : undefined}>
    <span className="usage-ring-slot">{remaining !== undefined && remaining > 0 && <UsageRing remaining={remaining} tone={tone!} />}</span>
    <span className={`usage-window-line${tone && tone !== 'ok' ? ` is-${tone}` : ''}`}>{usageWindowLine(entry, now)}</span>
  </div>
}

export interface SubscriptionUsageViewProps {
  /** The last reading, kept after a failed refresh. Null before the first one arrives. */
  usage: ProvidersUsageResponse | null
  loading: boolean
  /** The last read failed. */
  failed: boolean
  now: number
  /** Named only when the person has other computers, since usage is this computer's. */
  computerName?: string
  onBack: () => void
  onRefresh: () => void
  onManage: (url: string) => void
}

export function SubscriptionUsageView({ usage, loading, failed, now, computerName, onBack, onRefresh, onManage }: SubscriptionUsageViewProps) {
  const readAt = usage ? usageReadingTime(usage.fetchedAt) : undefined
  return <section className="subscription-usage-page settings-scope" aria-labelledby="usage-title">
    <header className="rail-page-header usage-heading">
      <button type="button" className="settings-icon-btn" onClick={onBack} aria-label="Back" title="Back"><ArrowLeft size={14} aria-hidden="true" /></button>
      <h1 id="usage-title">Subscription usage{computerName ? <span className="usage-computer"> on {computerName}</span> : null}</h1>
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
        {usage?.providers.length === 0 && <p className="settings-muted usage-empty" data-testid="usage-empty">No subscription providers are connected.</p>}
        {usage?.providers.map((provider) => <SettingsGroup
          key={provider.id}
          title={provider.label}
          className="usage-provider"
          action={provider.manageUrl
            ? <button type="button" className="settings-icon-btn" onClick={() => onManage(provider.manageUrl!)} aria-label={`Open ${provider.label} usage page`} title="Open the provider's usage page">
                <ExternalLink size={14} aria-hidden="true" />
              </button>
            : undefined}
        >
          {provider.windows.map((entry) => <UsageWindowRow key={entry.id} entry={entry} now={now} />)}
          {provider.message && <p className={`usage-message${provider.status === 'error' ? ' settings-status-bad' : ' settings-muted'}`}>{provider.message}</p>}
          {provider.windows.length === 0 && !provider.message && <p className="usage-message settings-muted">No usage reported.</p>}
        </SettingsGroup>)}
      </div>
    </div>
  </section>
}

export function SubscriptionUsagePage({ onClose }: { onClose: () => void }) {
  // Usage is this computer's, also while the thread in view runs on another one; with others around, it says so.
  const others = Object.keys(useComputers().byNode).length > 0
  const computerName = useAppStore((state) => localDeviceName(state.appInfo?.deviceName))
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
    return () => { mounted.current = false }
  }, [loadUsage])
  return <SubscriptionUsageView
    usage={usage}
    loading={loading}
    failed={failed}
    now={now}
    computerName={others ? computerName : undefined}
    onBack={onClose}
    onRefresh={() => void loadUsage()}
    onManage={(url) => void window.mousse.providers.openLoginUrl(url)}
  />
}
