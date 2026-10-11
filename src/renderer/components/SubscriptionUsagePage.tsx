import { useEffect, useState } from 'react'
import { ArrowLeft, RefreshCw } from '../lib/icons'
import type { ProvidersUsageResponse } from '../../shared/providerAuth'

function formatUsageReset(resetsAt?: string): string {
  if (!resetsAt) return 'Reset unknown'
  const date = new Date(resetsAt)
  if (Number.isNaN(date.getTime())) return 'Reset unknown'
  const now = Date.now()
  const deltaMs = date.getTime() - now
  if (deltaMs <= 0) return 'Resets soon'

  const totalMinutes = Math.floor(deltaMs / 60_000)
  if (totalMinutes < 1) return 'Resets soon'
  if (totalMinutes < 60) return `Resets in ${totalMinutes}m`
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const mins = totalMinutes % 60
  if (days === 0) return `Resets in ${hours}h ${mins}m`
  return `Resets in ${days}d ${hours}h ${mins}m`
}

export function SubscriptionUsagePage({ onClose }: { onClose: () => void }) {
  const [usage, setUsage] = useState<ProvidersUsageResponse | null>(null)
  const [usageLoading, setUsageLoading] = useState(false)
  const [error, setError] = useState('')
  const loadUsage = async () => {
    setUsageLoading(true)
    setError('')
    try { setUsage(await window.mousse.providers.getUsage()) }
    catch { setError('Unable to load subscription usage. Please try again.') }
    finally { setUsageLoading(false) }
  }
  useEffect(() => { void loadUsage() }, [])
  return <section className="subscription-usage-page" aria-labelledby="usage-title">
    <header className="usage-heading">
      <button type="button" onClick={onClose} aria-label="Back"><ArrowLeft size={16} /></button>
      <h2 id="usage-title">Subscription usage</h2>
      <button type="button" onClick={() => void loadUsage()} disabled={usageLoading} aria-label="Refresh usage"><RefreshCw className={usageLoading ? 'icon-spin' : ''} size={16} /></button>
    </header>
    <div className="subscription-usage-page-body">
      {error && <p role="alert">{error}</p>}
        {usageLoading && !usage ? <p>Loading usage…</p> : usage?.providers.length === 0 ? <p>No supported subscription providers are connected.</p> : usage?.providers.map(provider => <div className="usage-provider" key={provider.id}>
          <strong>{provider.label}</strong>
          {provider.windows.map(window => {
            const remaining = Math.max(0, Math.min(100, Math.round(window.remainingPercent)))
            const tone = remaining >= 50 ? 'healthy' : remaining >= 20 ? 'warn' : 'low'
            return (
              <div className="usage-window" key={window.id}>
                <div className="usage-window-top">
                  <span className="usage-window-label">{window.label}</span>
                  <span className={`usage-window-remaining usage-tone-${tone}`}>{remaining}% left</span>
                </div>
                <div
                  className="usage-bar"
                  role="progressbar"
                  aria-valuenow={remaining}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${provider.label} ${window.label} usage`}
                >
                  <div className={`usage-bar-fill usage-tone-${tone}`} style={{ width: `${remaining}%` }} />
                </div>
                <span className="usage-window-reset">{formatUsageReset(window.resetsAt)}</span>
              </div>
            )
          })}
          {provider.message && <p className="usage-message">{provider.message}</p>}
        </div>)}
    </div>
  </section>
}
