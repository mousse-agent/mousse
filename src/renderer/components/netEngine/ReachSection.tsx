import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
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
import { SettingsAdvanced, SettingsGroup, SettingsRow, Switch } from '../settings/SettingsRow'
import { useDaemonCall } from '../devices/useDaemonCall'
import { CopyButton } from '../settings/IconButtons'
import { CloudflareReachRow } from './CloudflareSetup'

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
 * invitation. Under them, this computer's own relays (Phase 3 §B.9). `moreWays` adds rows at the end of More ways
 * and `trailing` at the end of the group (the old relay, for old pairings); either one shows the group while the
 * engine is off.
 */
export function ReachSection({
  status,
  onChanged,
  onSendLink,
  onCloudflareSetup,
  moreWays,
  trailing
}: {
  status: NetEngineStatus
  onChanged: () => void
  onSendLink: () => void
  onCloudflareSetup: () => void
  moreWays?: ReactNode
  trailing?: ReactNode
}) {
  const reach = status.on ? status.reach : undefined
  const relays = status.on ? status.relays : undefined
  if (!reach && !relays && !moreWays && !trailing) return null
  return (
    <SettingsGroup
      anchor="devices-engine-reach"
      title="Reach this computer"
      icon={Globe}
      className="devices-group engine-reach"
      description={
        reach?.unbound?.length ? (
          <span className="settings-status-warn" title={reach.unbound.join(', ')}>
            Some ways in aren't ready yet.
          </span>
        ) : undefined
      }
    >
      {reach ? (
        <RouteRows
          status={status}
          reach={reach}
          onChanged={onChanged}
          onSendLink={onSendLink}
          moreWays={moreWays}
        />
      ) : (
        moreWays && <SettingsAdvanced label="More ways">{moreWays}</SettingsAdvanced>
      )}
      {status.on && status.cloudflare && (
        <CloudflareReachRow connection={status.cloudflare} onSetup={onCloudflareSetup} />
      )}
      {relays && <OwnRelayRows relays={relays} onChanged={onChanged} />}
      {trailing}
    </SettingsGroup>
  )
}

/** Same network and Tailscale, then Port forward and your own tunnel under More ways (protocol 1.1). */
function RouteRows({
  status,
  reach,
  onChanged,
  onSendLink,
  moreWays
}: {
  status: NetEngineStatus
  reach: NetEngineReach
  onChanged: () => void
  onSendLink: () => void
  moreWays?: ReactNode
}) {
  const { busy, error, call } = useDaemonCall()
  const [test, setTest] = useState<TestState>()
  const [forward, setForward] = useState('')
  const [forwardTo, setForwardTo] = useState('')
  const [tunnel, setTunnel] = useState('')
  const publicNow = reach.public[0] ?? ''
  const tunnelNow = reach.tunnels[0] ?? ''
  const tunnelOrigin = reach.wsPort ? `http://127.0.0.1:${reach.wsPort}` : undefined
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

  return (
    <>
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
        title="Use an existing tunnel"
        description={
          tunnelOrigin && (
            <span className="engine-row-line">
              Local origin <code>{tunnelOrigin}</code>
              <CopyButton text={tunnelOrigin} label="Copy local origin" />
            </span>
          )
        }
        control={
          tunnelNow && status.sendLink && (
            <button
              type="button"
              className="settings-btn"
              disabled={busy}
              onClick={onSendLink}
            >
              Send pairing link
            </button>
          )
        }
      >
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
      </SettingsRow>
      {moreWays}
      </SettingsAdvanced>
      {error && (
        <p role="alert" className="chat-error devices-error">
          {error}
        </p>
      )}
    </>
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
  new Date(at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })

/** New relay key waits while the relay holds as many keys as it allows, until `chainFullUntil` passes. */
const chainFull = (relay: NetEngineRelay): boolean =>
  !!relay.chainFull && (relay.chainFullUntil === undefined || relay.chainFullUntil > Date.now())

/** When the old relay key stops, as the row says it. */
const until = (at: number): string =>
  new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })

/** The tooltip for a registration that ended for a reason with no words here. */
export const RELAY_ENDED = 'The connection to the relay ended.'

/** One own relay's state, one short line, with the reason as its tooltip. */
export function relayLine(
  relay: NetEngineRelay,
  now = Date.now()
): { line: string; detail?: string; warn?: boolean } {
  // A reason with no words here gets a fixed line: the helper's own text never shows.
  const reason = relay.reason ? (RELAY_REASON_TEXT[relay.reason] ?? RELAY_ENDED) : undefined
  switch (relay.state) {
    case 'registered':
      return { line: 'Connected' }
    case 'connecting':
      return { line: 'Connecting…' }
    case 'retrying':
      return {
        line:
          relay.retryAt !== undefined && relay.retryAt > now
            ? `Retrying at ${clock(relay.retryAt)}`
            : 'Retrying…',
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
  // "Retrying at <time>" turns to "Retrying…" once that time passes, without waiting for the next status.
  const [, setTick] = useState(0)
  // So does "Try again after <time>" once New relay key can be used again.
  const nextRetry = Math.min(
    ...relays.list.flatMap((relay) => [
      ...(relay.state === 'retrying' && relay.retryAt !== undefined && relay.retryAt > Date.now()
        ? [relay.retryAt]
        : []),
      ...(relay.chainFullUntil !== undefined && relay.chainFullUntil > Date.now()
        ? [relay.chainFullUntil]
        : [])
    ])
  )
  useEffect(() => {
    if (!Number.isFinite(nextRetry)) return
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(0, nextRetry - Date.now()) + 50)
    return () => clearTimeout(timer)
  }, [nextRetry])
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
                <span
                  className={state.warn ? 'settings-status-warn' : undefined}
                  title={state.detail}
                >
                  {state.line}
                </span>
                {relay.state === 'registered' && (
                  <>
                    {' · '}
                    <span
                      className="settings-muted"
                      title="Paired devices this relay lets through to this computer"
                    >
                      {relay.callersMax === undefined
                        ? `${relay.callers} devices`
                        : `${relay.callers} of ${relay.callersMax} devices`}
                    </span>
                  </>
                )}
                {relay.cancelling ? (
                  <>
                    {' · '}
                    <span className="settings-muted" title="The current key stays.">
                      Cancelling…
                    </span>
                  </>
                ) : relay.newKeyPending ? (
                  <>
                    {' · '}
                    <span
                      className="settings-muted"
                      title="The relay hasn't taken the new key yet. The current key keeps working."
                    >
                      New key pending
                    </span>{' '}
                    <button
                      type="button"
                      className="settings-btn"
                      disabled={busy}
                      title="Keep the current key."
                      onClick={() =>
                        void run('netEngine.relay.rotate', { relay: relay.id, cancel: true })
                      }
                    >
                      Cancel
                    </button>
                  </>
                ) : chainFull(relay) ? (
                  <>
                    {' · '}
                    <span
                      className="settings-muted"
                      title="The relay holds as many keys as it allows until the oldest one leaves."
                    >
                      {relay.chainFullUntil === undefined
                        ? 'Too many key changes. Try again later'
                        : `Too many key changes. Try again after ${until(relay.chainFullUntil)}`}
                    </span>
                  </>
                ) : (
                  relay.rotatingUntil !== undefined && (
                    <>
                      {' · '}
                      <span
                        className="settings-muted"
                        title="The old key keeps working until then, so offline devices catch up."
                      >
                        Rotating until {until(relay.rotatingUntil)}
                      </span>
                    </>
                  )
                )}
              </span>
            }
            control={
              <span className="engine-reach-control">
                <button
                  type="button"
                  className="settings-btn"
                  disabled={
                    busy || relay.state !== 'registered' || relay.newKeyPending || chainFull(relay)
                  }
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
        <Modal
          open
          title={`Remove relay ${removing.endpoint}?`}
          onClose={() => setRemoving(undefined)}
        >
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
