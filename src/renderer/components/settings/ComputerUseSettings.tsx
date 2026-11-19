import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ComputerUseStatus } from '../../../shared/computerUse'
import { normalizeAgentAccessSettings, type MousseSettings, type MousseSettingsUpdate } from '../../../shared/settings'
import { Copy, Monitor, RefreshCw } from '../../lib/icons'
import { Turning } from '../../lib/turning'
import { showToast } from '../ui/Toast'
import { SettingsGroup, SettingsRow, Switch } from './SettingsRow'
import '../../styles/computerUse.css'

/** Why Mousse finds or installs Cua Driver instead of shipping it, for the status row's tooltip. */
export const CUA_DRIVER_WHY = 'Cua Driver (MIT) is found or installed, not bundled: it is about 65 MB per platform, updates often, and on macOS its own signed app keeps the Accessibility and Screen Recording grants. Mousse runs it with its usage telemetry off.'

/** The status word, in plain words. */
export function driverStateText(status: ComputerUseStatus | null): string {
  if (!status) return 'Checking…'
  if (status.state === 'installing') return 'Installing…'
  if (status.state === 'found') return 'Installed'
  if (status.state === 'broken') return "Didn't start"
  return 'Not installed'
}

/** Where the driver came from, in a few words. */
function sourceText(status: ComputerUseStatus): string | undefined {
  if (status.source === 'chosen') return 'chosen by you'
  if (status.source === 'path') return 'on the PATH'
  if (status.source === 'default') return 'installer folder'
  return undefined
}

interface Client {
  status(refresh?: boolean): Promise<ComputerUseStatus>
  install(): Promise<ComputerUseStatus>
}

function useClient(): Client | null {
  return useMemo(() => {
    const transport = window.mousse?.platformRequest
    if (!transport) return null
    return {
      status: (refresh) => transport.request<ComputerUseStatus>('computerUse.status', refresh ? { refresh: true } : {}),
      install: () => transport.request<ComputerUseStatus>('computerUse.install', {})
    }
  }, [])
}

/**
 * Settings → Computer use: whether agents may see and operate apps on this computer (on by default for threads; a bot
 * needs "use the computer"), and Cua Driver's state, with Install, Check again and a chosen driver.
 */
export function ComputerUseSettings({ settings, onUpdate }: { settings: MousseSettings; onUpdate: (partial: MousseSettingsUpdate) => Promise<void> }) {
  const access = normalizeAgentAccessSettings(settings.agentAccess)
  const client = useClient()
  const [status, setStatus] = useState<ComputerUseStatus | null>(null)
  const [busy, setBusy] = useState<'check' | 'install' | null>(null)

  const load = useCallback(async (refresh: boolean) => {
    if (!client) return
    try {
      setStatus(await client.status(refresh))
    } catch (error) {
      showToast({ key: 'computer-use', tone: 'error', message: "Couldn't check Cua Driver.", detail: error instanceof Error ? error.message : undefined })
    }
  }, [client])

  // Looks again whenever the chosen driver changes.
  useEffect(() => { void load(true) }, [load, access.computerDriver])

  // Always the whole setting: a partial write must not drop the approvals switch or the computer list.
  const save = (next: Partial<typeof access>) => onUpdate({ agentAccess: { ...access, ...next } })

  const check = async () => {
    setBusy('check')
    try { await load(true) } finally { setBusy(null) }
  }
  const install = async () => {
    if (!client) return
    setBusy('install')
    setStatus((current) => (current ? { ...current, state: 'installing', error: undefined } : current))
    try {
      const next = await client.install()
      setStatus(next)
      if (next.state === 'found') showToast({ key: 'computer-use', message: `Cua Driver ${next.version ?? ''} installed.`.replace('  ', ' ') })
    } catch (error) {
      showToast({ key: 'computer-use', tone: 'error', message: "Couldn't install Cua Driver.", detail: error instanceof Error ? error.message : undefined })
      await load(true)
    } finally {
      setBusy(null)
    }
  }
  const choose = async () => {
    const path = await window.mousse?.computerUse?.chooseDriver()
    if (path) await save({ computerDriver: path })
  }
  const copyCommand = async () => {
    if (!status?.installCommand) return
    try {
      await navigator.clipboard.writeText(status.installCommand)
      showToast({ key: 'computer-use', message: 'Install command copied.' })
    } catch {
      showToast({ key: 'computer-use', tone: 'error', message: "Couldn't copy the command." })
    }
  }

  const state = status?.state
  const tone = state === 'found' ? 'ok' : state === 'broken' ? 'bad' : state === 'missing' ? 'warn' : 'muted'
  const needsInstall = state === 'missing' || state === 'broken'
  const installing = state === 'installing' || busy === 'install'
  const source = status ? sourceText(status) : undefined

  return (
    <section id="computer" className="settings-section">
      <SettingsGroup title="Cua Driver" icon={Monitor}>
        <SettingsRow
          title={<span title={CUA_DRIVER_WHY}>Cua Driver</span>}
          anchor="computer-driver"
          className="cu-driver-row"
          description={
            <span className="cu-status" data-testid="computer-driver-status" aria-live="polite">
              <span className={`cu-state cu-state-${tone}`}>{installing ? 'Installing…' : driverStateText(status)}</span>
              {status?.version && <span className="cu-pill">v{status.version}</span>}
              {source && state === 'found' && <span className="cu-quiet">{source}</span>}
            </span>
          }
          control={
            <span className="cu-actions">
              <button
                type="button"
                className="settings-icon-btn cu-icon-btn"
                title="Check again"
                aria-label="Check again"
                disabled={busy !== null || installing}
                onClick={() => void check()}
              >
                {busy === 'check' ? <Turning className="icon-spin"><RefreshCw size={15} /></Turning> : <RefreshCw size={15} />}
              </button>
              {(needsInstall || installing) && status?.installable && (
                <button type="button" className="cu-btn cu-btn-primary" disabled={installing} onClick={() => void install()}>
                  {installing ? 'Installing…' : state === 'broken' ? 'Reinstall' : 'Install'}
                </button>
              )}
            </span>
          }
        />
        <div className={`cu-panel${status?.path || status?.error || (needsInstall && status?.installCommand) ? ' open' : ''}`} aria-hidden={!(status?.path || status?.error)}>
          <div className="cu-panel-inner">
            {status?.path && <code className="cu-path" title={status.path}>{status.path}</code>}
            {status?.error && <p className="cu-error settings-status-bad">{status.error}</p>}
            {needsInstall && status?.installCommand && !installing && (
              <p className="cu-command">
                <span className="cu-quiet">Or run</span>
                <code title={status.installCommand}>{status.installCommand}</code>
                <button type="button" className="settings-icon-btn cu-icon-btn" title="Copy" aria-label="Copy the install command" onClick={() => void copyCommand()}>
                  <Copy size={14} />
                </button>
              </p>
            )}
          </div>
        </div>
        <SettingsRow
          title="Driver"
          anchor="computer-driver-path"
          description={access.computerDriver ? <span title={access.computerDriver}>Your choice</span> : 'Found automatically'}
          control={
            <span className="cu-actions">
              {access.computerDriver && (
                <button type="button" className="cu-btn" onClick={() => void save({ computerDriver: '' })}>Automatic</button>
              )}
              <button type="button" className="cu-btn" onClick={() => void choose()}>Choose…</button>
            </span>
          }
        />
      </SettingsGroup>
      <SettingsGroup title="Agents">
        <SettingsRow
          title="Agents can use this computer"
          anchor="computer-agents"
          htmlFor="computer-agents"
          description={<span title={'Threads get it by default. A bot needs "Use the computer" in its About, and the threads it starts get it only while it has that.'}>Threads by default; bots when allowed.</span>}
          control={<Switch id="computer-agents" label="Agents can use this computer" checked={access.computerUse} onChange={(computerUse) => void save({ computerUse })} />}
        />
      </SettingsGroup>
    </section>
  )
}
