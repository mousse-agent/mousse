import { useEffect, useState, type FormEvent } from 'react'
import { Globe } from '../../lib/icons'
import type { NetEngineReach, NetEngineStatus } from '../../../shared/netEngine/local'
import { classifyIp, parseRoute, routeText } from '../../../shared/netEngine/routes'
import { SettingsGroup, SettingsRow, Switch } from '../settings/SettingsRow'
import { CopyButton } from '../settings/IconButtons'
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
 * Settings → Reach (1b §1.5): how other computers reach this one. LAN and Tailnet are switches; a port forward and
 * a tunnel each take an address. Each has Test. A change that needs new listeners restarts the helper (about a
 * second offline); the others show in the next invitation.
 */
export function ReachSection({ status, onChanged }: { status: NetEngineStatus; onChanged: () => void }) {
  const reach = status.reach
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
  if (!reach) return null

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
  const local = reach.wsPort !== undefined ? `http://127.0.0.1:${reach.wsPort}` : undefined

  return (
    <SettingsGroup
      anchor="devices-engine-reach"
      title="Reach"
      icon={Globe}
      className="devices-group engine-reach"
      description={
        reach.unbound?.length ? (
          <span className="settings-status-warn" title={reach.unbound.join(', ')}>
            Some addresses aren't up yet.
          </span>
        ) : undefined
      }
    >
      <SettingsRow
        title="LAN"
        description={
          <span title="Computers on this network find this one by itself.">
            {lan ? routeText(lan) : 'This network'} {result(lan)}
          </span>
        }
        control={
          <span className="engine-reach-control">
            {reach.lan && testButton(lan)}
            <Switch
              checked={reach.lan}
              label="LAN"
              disabled={busy}
              onChange={(next) => void save({ lan: next })}
            />
          </span>
        }
      />
      <SettingsRow
        title="Tailnet"
        description={
          <span title="Paired computers on your tailnet can reach this one at its tailnet address.">
            {tailnet ? routeText(tailnet) : 'Off'} {result(tailnet)}
          </span>
        }
        control={
          <span className="engine-reach-control">
            {reach.tailnet && testButton(tailnet)}
            <Switch
              checked={reach.tailnet}
              label="Tailnet"
              disabled={busy}
              onChange={(next) => void save({ tailnet: next })}
            />
          </span>
        }
      />
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
                  ? `Forward this port on your router to this computer: ${reach.port}`
                  : 'Forward a port on your router to this computer.'
              }
              onChange={(event) => setForward(event.target.value)}
            />
            {!reach.lan && (
              <input
                className="settings-input"
                value={forwardTo}
                placeholder="192.168.1.20"
                aria-label="Forwarded to"
                title={`Port forward also opens this computer on your LAN at ${forwardTo || 'this address'}.`}
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
        title="Tunnel"
        description={
          <form className="engine-reach-form" onSubmit={submitTunnel}>
            <input
              className="settings-input"
              value={tunnel}
              placeholder="https://name.example.com"
              aria-label="Tunnel URL"
              title={local ? `Point your tunnel at ${local}` : 'Your tunnel’s public https:// address.'}
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
      {local && (
        <div className="engine-reach-tunnel" aria-label="Tunnel commands">
          <TunnelCommand text={`cloudflared tunnel --url ${local}`} />
          <TunnelCommand text={`tailscale funnel ${reach.wsPort}`} />
        </div>
      )}
      {error && (
        <p role="alert" className="chat-error devices-error">
          {error}
        </p>
      )}
    </SettingsGroup>
  )
}

function TunnelCommand({ text }: { text: string }) {
  return (
    <span className="engine-reach-command">
      <code>{text}</code>
      <CopyButton text={text} label="Copy command" />
    </span>
  )
}

/** A stored tunnel route as its owner typed it: `wss://x/mousse-net/1` reads `https://x`. */
export function tunnelUrl(route: string): string {
  const match = /^wss:\/\/([^/]+)(\/.*)?$/.exec(route)
  if (!match) return route
  const path = (match[2] ?? '').replace(/\/mousse-net\/1$/, '')
  return `https://${match[1]}${path}`
}
