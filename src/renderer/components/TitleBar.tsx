import { useEffect, useState } from 'react'
import { Minus, Square, X, Copy, Settings, PanelLeft, Gauge, RefreshCw } from 'lucide-react'
import type { ProvidersUsageResponse } from '../../shared/providerAuth'
import { IconButton } from './IconButton'
import { useAppStore } from '../stores/appStore'
import logoIcon from '../assets/mousse_logo_icon.svg'

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

export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const [usage, setUsage] = useState<ProvidersUsageResponse | null>(null)
  const [usageLoading, setUsageLoading] = useState(false)
  const appInfo = useAppStore((s) => s.appInfo)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const threadsSidebarOpen = useAppStore((s) => s.threadsSidebarOpen)
  const setThreadsSidebarOpen = useAppStore((s) => s.setThreadsSidebarOpen)
  const isMac = appInfo?.platform === 'darwin' || window.mousse.platform === 'darwin'

  useEffect(() => {
    window.mousse.window.isMaximized().then(setIsMaximized)
    return window.mousse.window.onMaximizedChange(setIsMaximized)
  }, [])

  useEffect(() => {
    const openUsage = () => setUsageOpen(true)
    window.addEventListener('mousse:open-usage', openUsage)
    return () => window.removeEventListener('mousse:open-usage', openUsage)
  }, [])

  const loadUsage = async () => {
    setUsageLoading(true)
    try { setUsage(await window.mousse.providers.getUsage()) } finally { setUsageLoading(false) }
  }
  useEffect(() => {
    if (!usageOpen) return
    void loadUsage()
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setUsageOpen(false) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [usageOpen])

  return (
    <>
    <header className="titlebar">
      {/* Double-click maximize is handled natively by -webkit-app-region: drag.
          Do not also call maximize() here — that toggles and undoes the OS maximize. */}
      <div className="titlebar-drag">
        <div className="titlebar-left">
          <div className="titlebar-brand">
            <button
              type="button"
              className="titlebar-sidebar-toggle"
              aria-label={threadsSidebarOpen ? 'Close threads sidebar' : 'Open threads sidebar'}
              title={threadsSidebarOpen ? 'Close threads sidebar' : 'Open threads sidebar'}
              onClick={() => setThreadsSidebarOpen(!threadsSidebarOpen)}
            >
              <PanelLeft size={22} strokeWidth={2} />
            </button>
            <img
              className="titlebar-logo-icon"
              src={logoIcon}
              alt=""
              aria-hidden="true"
              draggable={false}
            />
            <span
              className={`titlebar-title${threadsSidebarOpen ? ' titlebar-title-visible' : ''}`}
            >
              Mousse
            </span>
          </div>
        </div>
      </div>
      <div className="titlebar-controls">
        <IconButton
          icon={Gauge}
          label="Subscription usage"
          variant="titlebar"
          className="titlebar-usage-btn"
          onClick={() => setUsageOpen(true)}
        />
        <IconButton
          icon={Settings}
          label="Settings"
          variant="titlebar"
          className="titlebar-settings-btn"
          onClick={() => setSettingsOpen(true)}
        />
        {!isMac && (
          <>
            <IconButton
              icon={Minus}
              label="Minimize"
              variant="titlebar"
              onClick={() => window.mousse.window.minimize()}
            />
            <IconButton
              icon={isMaximized ? Copy : Square}
              label={isMaximized ? 'Restore' : 'Maximize'}
              variant="titlebar"
              onClick={() => window.mousse.window.maximize()}
            />
            <IconButton
              icon={X}
              label="Close"
              variant="titlebar"
              className="titlebar-close"
              onClick={() => window.mousse.window.close()}
            />
          </>
        )}
      </div>
    </header>
    {usageOpen && <div className="usage-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setUsageOpen(false) }}>
      <section className="usage-dialog" role="dialog" aria-modal="true" aria-labelledby="usage-title">
        <div className="usage-heading"><h2 id="usage-title">Subscription usage</h2><button type="button" onClick={() => void loadUsage()} disabled={usageLoading} aria-label="Refresh usage"><RefreshCw className={usageLoading ? 'icon-spin' : ''} size={18} /></button></div>
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
      </section>
    </div>}
    </>
  )
}
