import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Globe } from '../../lib/icons'
import type { NetEngineReach, NetEngineStatus } from '../../../shared/netEngine/local'
import { classifyIp, parseRoute, routeText } from '../../../shared/netEngine/routes'
import { SettingsAdvanced, SettingsGroup, SettingsRow, Switch } from '../settings/SettingsRow'
import { useDaemonCall } from '../devices/useDaemonCall'

/** What Test says when the helper could not reach its own route (1b §1.5). */
export const TEST_FAILED = "Couldn't confirm from this network"
export const TEST_FAILED_DETAIL =
  "Many routers don't loop a port forward back inside, so this can fail even when it works from outside. Saving still works."

type TestState = { route: string; busy: true } | { route: string; ok: boolean; ms?: number }

/** This computer's routes of one class among what it advertises (`status.routes`). */
function advertised(status: NetEngineStatus, cls: 'lan' | 'tailnet'): string | undefined {
  return (status.routes ?? []).find((route) => {
    const parsed = parseRoute(route)
    return parsed?.kind === 'tcp' && parsed.literal && classifyIp(parsed.host) === cls
  })
}

/**
 * Settings → Reach this computer (1b §1.5): how other computers reach this one. Same network and Tailscale are
 * switches; a port forward and your own tunnel sit under More ways and each take an address. Each has Test. A
 * change that needs new listeners restarts the helper (about a second offline); the others show in the next
 * invitation. `moreWays` adds rows at the end of More ways and `trailing` at the end of the group; either one
 * shows the group while the engine is off.
 */
export function ReachSection({
  status,
  onChanged,
  moreWays,
  trailing
}: {
  status: NetEngineStatus
  onChanged: () => void
  moreWays?: ReactNode
  trailing?: ReactNode
}) {
  const reach = status.on ? status.reach : undefined
  const { busy, error, call } = useDaemonCall()
  const [test, setTest] = useState<TestState>()
  const [forward, setForward] = useState('')
  const [forwardTo, setForwardTo] = useState('')
  const [tunnel, setTunnel] = useState('')
  const publicNow = reach?.public[0] ?? ''
  const tunnelNow = reach?.tunnels[0] ?? ''
  useEffect(() => setForward(publicNow ? routeText(publicNow) : ''), [publicNow])
  useEffect(() => setForwardTo(reach?.forwardTo ?? ''), [reach?.forwardTo])
  useEffect(() => setTunnel(tunnelNow ? tunnelUrl(tunnelNow) : ''), [tunnelNow])
  if (!reach)
    return moreWays || trailing ? (
      <SettingsGroup
        anchor="devices-engine-reach"
        title="Reach this computer"
        icon={Globe}
        className="devices-group engine-reach"
      >
        {moreWays && <SettingsAdvanced label="More ways">{moreWays}</SettingsAdvanced>}
        {trailing}
      </SettingsGroup>
    ) : null

  const save = async (change: Partial<NetEngineReach>) => {
    setTest(undefined)
    if (await call('netEngine.routes.config', change)) onChanged()
  }
  const runTest = async (route: string) => {
    setTest({ route, busy: true })
    const answer = await call<{ ok: boolean; ms?: number }>('netEngine.routes.test', { route })
    setTest(answer ? { route, ok: answer.value.ok, ms: answer.value.ms } : undefined)
  }
  const testButton = (route: string | undefined) =>
    route ? (
      <button
        type="button"
        className="settings-btn"
        disabled={busy}
        title={`Reach ${routeText(route)} from here`}
        onClick={() => void runTest(route)}
      >
        Test
      </button>
    ) : null
  const result = (route: string | undefined) => {
    if (!route || test?.route !== route) return null
    if ('busy' in test) return <span className="settings-muted">Testing…</span>
    return test.ok ? (
      <span role="status">Reached{test.ms !== undefined ? ` in ${test.ms} ms` : ''}</span>
    ) : (
      <span role="status" className="settings-status-warn" title={TEST_FAILED_DETAIL}>
        {TEST_FAILED}
      </span>
    )
  }

  const lan = advertised(status, 'lan'),
    tailnet = advertised(status, 'tailnet')
  const submitForward = (event: FormEvent) => {
    event.preventDefault()
    const value = forward.trim()
    void save({
      public: value ? [value] : [],
      ...(!reach.lan ? { forwardTo: value ? forwardTo.trim() : '' } : {})
    })
  }
  const submitTunnel = (event: FormEvent) => {
    event.preventDefault()
    const value = tunnel.trim()
    void save({ tunnels: value ? [value] : [] })
  }

  return (
    <SettingsGroup
      anchor="devices-engine-reach"
      title="Reach this computer"
      icon={Globe}
      className="devices-group engine-reach"
      description={
        reach.unbound?.length ? (
          <span className="settings-status-warn" title={reach.unbound.join(', ')}>
            Some ways in aren't ready yet.
          </span>
        ) : undefined
      }
    >
      <SettingsRow
        title="Same Wi-Fi or network"
        description={
          <span title="Computers on the same Wi-Fi or network find this one by themselves.">
            {lan ? routeText(lan) : 'This network'} {result(lan)}
          </span>
        }
        control={
          <span className="engine-reach-control">
            {reach.lan && testButton(lan)}
            <Switch
              checked={reach.lan}
              label="Same Wi-Fi or network"
              disabled={busy}
              onChange={(next) => void save({ lan: next })}
            />
          </span>
        }
      />
      <SettingsRow
        title="Tailscale"
        description={
          <span title="Your computers signed in to the same Tailscale can reach this one.">
            {tailnet ? routeText(tailnet) : 'Off'} {result(tailnet)}
          </span>
        }
        control={
          <span className="engine-reach-control">
            {reach.tailnet && testButton(tailnet)}
            <Switch
              checked={reach.tailnet}
              label="Tailscale"
              disabled={busy}
              onChange={(next) => void save({ tailnet: next })}
            />
          </span>
        }
      />
      <SettingsAdvanced label="More ways">
      <SettingsRow
        title="Port forward"
        description={
          <form className="engine-reach-form" onSubmit={submitForward}>
            <input
              className="settings-input"
              value={forward}
              placeholder="203.0.113.7:47100"
              aria-label="Public address and port"
              title={
                reach.port !== undefined
                  ? `Over the internet: set your router to send ${reach.port} to this computer, then type your public address here.`
                  : 'Over the internet: set your router to send connections to this computer, then type your public address here.'
              }
              onChange={(event) => setForward(event.target.value)}
            />
            {!reach.lan && (
              <input
                className="settings-input"
                value={forwardTo}
                placeholder="192.168.1.20"
                aria-label="Forwarded to"
                title={`Port forward also opens this computer on your network at ${forwardTo || 'this address'}.`}
                onChange={(event) => setForwardTo(event.target.value)}
              />
            )}
            <button
              type="submit"
              className="settings-btn"
              disabled={busy || forward.trim() === (publicNow ? routeText(publicNow) : '')}
            >
              Save
            </button>
            {testButton(publicNow || undefined)}
            {result(publicNow || undefined)}
          </form>
        }
      />
      <SettingsRow
        title="Your own tunnel"
        description={
          <form className="engine-reach-form" onSubmit={submitTunnel}>
            <input
              className="settings-input"
              value={tunnel}
              placeholder="https://name.example.com"
              aria-label="Tunnel address"
              title="Over the internet: the https:// address of a tunnel you run, such as Cloudflare"
              onChange={(event) => setTunnel(event.target.value)}
            />
            <button
              type="submit"
              className="settings-btn"
              disabled={busy || tunnel.trim() === (tunnelNow ? tunnelUrl(tunnelNow) : '')}
            >
              Save
            </button>
            {testButton(tunnelNow || undefined)}
            {result(tunnelNow || undefined)}
          </form>
        }
      />
      {moreWays}
      </SettingsAdvanced>
      {trailing}
      {error && (
        <p role="alert" className="chat-error devices-error">
          {error}
        </p>
      )}
    </SettingsGroup>
  )
}

/** A stored tunnel route as its owner typed it: `wss://x/mousse-net/1` reads `https://x`. */
export function tunnelUrl(route: string): string {
  const match = /^wss:\/\/([^/]+)(\/.*)?$/.exec(route)
  if (!match) return route
  const path = (match[2] ?? '').replace(/\/mousse-net\/1$/, '')
  return `https://${match[1]}${path}`
}
