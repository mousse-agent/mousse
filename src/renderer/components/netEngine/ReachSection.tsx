import { useEffect, useState, type FormEvent } from 'react'
import { Globe, X } from '../../lib/icons'
import {
  RELAY_REASON_TEXT,
  type NetEngineReach,
  type NetEngineRelay,
  type NetEngineRelays,
  type NetEngineStatus
} from '../../../shared/netEngine/local'
import type { PlatformRequestMethod } from '../../../shared/platform'
import { Modal } from '../ui/Modal'
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
 * second offline); the others show in the next invitation. Under them, this computer's own relays (Phase 3 §B.9).
 */
export function ReachSection({ status, onChanged }: { status: NetEngineStatus; onChanged: () => void }) {
  const reach = status.reach
  if (!reach && !status.relays) return null
  return (
    <SettingsGroup
      anchor="devices-engine-reach"
      title="Reach"
      icon={Globe}
      className="devices-group engine-reach"
      description={
        reach?.unbound?.length ? (
          <span className="settings-status-warn" title={reach.unbound.join(', ')}>
            Some addresses aren't up yet.
          </span>
        ) : undefined
      }
    >
      {reach && <RouteRows status={status} reach={reach} onChanged={onChanged} />}
      {status.relays && <OwnRelayRows relays={status.relays} onChanged={onChanged} />}
    </SettingsGroup>
  )
}

/** LAN, Tailnet, Port forward and Tunnel (protocol 1.1). */
function RouteRows({
  status,
  reach,
  onChanged
}: {
  status: NetEngineStatus
  reach: NetEngineReach
  onChanged: () => void
}) {
  const { busy, error, call } = useDaemonCall()
  const [test, setTest] = useState<TestState>()
  const [forward, setForward] = useState('')
  const [forwardTo, setForwardTo] = useState('')
  const [tunnel, setTunnel] = useState('')
  const publicNow = reach.public[0] ?? ''
  const tunnelNow = reach.tunnels[0] ?? ''
  useEffect(() => setForward(publicNow ? routeText(publicNow) : ''), [publicNow])
  useEffect(() => setForwardTo(reach.forwardTo ?? ''), [reach.forwardTo])
  useEffect(() => setTunnel(tunnelNow ? tunnelUrl(tunnelNow) : ''), [tunnelNow])

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
    <>
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
    </>
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

/** When the next registration starts, as the row says it: the time of day, to the second. */
const clock = (at: number): string =>
  new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** When the old relay key stops, as the row says it. */
const until = (at: number): string =>
  new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })

/** One own relay's state, one short line, with the reason as its tooltip. */
export function relayLine(relay: NetEngineRelay, now = Date.now()): { line: string; detail?: string; warn?: boolean } {
  const reason = relay.reason ? (RELAY_REASON_TEXT[relay.reason] ?? relay.reason) : undefined
  switch (relay.state) {
    case 'registered':
      return { line: 'Connected' }
    case 'connecting':
      return { line: 'Connecting…' }
    case 'retrying':
      return {
        line: relay.retryAt !== undefined && relay.retryAt > now ? `Retrying at ${clock(relay.retryAt)}` : 'Retrying…',
        detail: reason,
        warn: true
      }
    case 'refused':
      return {
        line: 'The relay refused this computer',
        detail: `${reason ? `${reason} ` : ''}Add it again with a new link from mousse-relay enroll.`,
        warn: true
      }
  }
}

/**
 * Your own relay (Phase 3 §B.9): paste the link `mousse-relay init` or `enroll` printed; each relay shows its
 * state, how many paired devices it lists, New relay key and Remove.
 */
function OwnRelayRows({ relays, onChanged }: { relays: NetEngineRelays; onChanged: () => void }) {
  const { busy, error, setError, call } = useDaemonCall()
  const [link, setLink] = useState('')
  const [removing, setRemoving] = useState<NetEngineRelay>()
  const run = async (method: PlatformRequestMethod, params: unknown): Promise<boolean> => {
    const done = !!(await call(method, params))
    if (done) onChanged()
    return done
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (await run('netEngine.relay.enroll', { link: link.trim() })) setLink('')
  }
  return (
    <>
      <SettingsRow
        title="Your own relay"
        description={
          relays.available ? (
            <form className="engine-reach-form" onSubmit={(event) => void submit(event)}>
              <input
                className="settings-input"
                value={link}
                placeholder="mousse-relay://…"
                aria-label="Relay link"
                title="Paste the link mousse-relay init or mousse-relay enroll printed."
                onChange={(event) => {
                  setLink(event.target.value)
                  setError('')
                }}
              />
              <button type="submit" className="settings-btn" disabled={busy || !link.trim()}>
                Add
              </button>
            </form>
          ) : (
            <span className="settings-muted" title="Relays need this computer's keystore.">
              Not available on this computer
            </span>
          )
        }
      />
      {relays.list.map((relay) => {
        const state = relayLine(relay)
        return (
          <SettingsRow
            key={relay.id}
            indent
            title={relay.endpoint}
            description={
              <span className="engine-row-line">
                <span className={state.warn ? 'settings-status-warn' : undefined} title={state.detail}>
                  {state.line}
                </span>
                {relay.state === 'registered' && (
                  <>
                    {' · '}
                    <span
                      className="settings-muted"
                      title="Paired devices this relay lets through to this computer"
                    >
                      {relay.callers} of {relay.callersMax} devices
                    </span>
                  </>
                )}
                {relay.rotatingUntil !== undefined && (
                  <>
                    {' · '}
                    <span
                      className="settings-muted"
                      title="The old key keeps working until then, so offline devices catch up."
                    >
                      Rotating until {until(relay.rotatingUntil)}
                    </span>
                  </>
                )}
              </span>
            }
            control={
              <span className="engine-reach-control">
                <button
                  type="button"
                  className="settings-btn"
                  disabled={busy || relay.state !== 'registered'}
                  title="Register with a new key; the old one keeps working for a while."
                  onClick={() => void run('netEngine.relay.rotate', { relay: relay.id })}
                >
                  New relay key
                </button>
                <button
                  type="button"
                  className="settings-icon-btn"
                  aria-label={`Remove relay ${relay.endpoint}`}
                  disabled={busy}
                  onClick={() => setRemoving(relay)}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </span>
            }
          />
        )
      })}
      {error && (
        <p role="alert" className="chat-error devices-error">
          {error}
        </p>
      )}
      {removing && (
        <Modal open title={`Remove relay ${removing.endpoint}?`} onClose={() => setRemoving(undefined)}>
          <p
            className="settings-muted"
            title="Adding it again needs a new link from mousse-relay enroll."
          >
            Devices can no longer reach this computer through it.
          </p>
          <div className="devices-dialog-actions">
            <button type="button" className="settings-btn" onClick={() => setRemoving(undefined)}>
              Cancel
            </button>
            <button
              type="button"
              className="settings-btn danger-fill"
              disabled={busy}
              onClick={() => {
                const relay = removing.id
                setRemoving(undefined)
                void run('netEngine.relay.remove', { relay })
              }}
            >
              Remove
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}