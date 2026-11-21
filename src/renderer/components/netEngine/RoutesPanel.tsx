import { useState, type FormEvent } from 'react'
import type { NetEngineDevice } from '../../../shared/netEngine/local'
import type { PlatformRequestMethod } from '../../../shared/platform'
import { parseRoute, routeText } from '../../../shared/netEngine/routes'
import { RowMenu } from '../integrations/RowMenu'
import { SettingsRow } from '../settings/SettingsRow'
import { classOf, deviceRoutes, ROUTE_KIND } from './engineRows'
import { SshAddSteps } from './SshAddSteps'

type Adding = 'tailnet' | 'ssh' | 'address'

const STATE_WORDS = { 'in use': 'In use', available: 'Available', failed: 'Failed' } as const

/**
 * A device's routes in its open row: each with its kind, address and state, the one in use first. Add route gives
 * it a fallback (Tailscale, SSH, or a port forward or tunnel); adding one allows it, and it is tried when the
 * route in use drops. A route the owner added can be removed from its menu.
 */
export function RoutesPanel({
  device,
  busy,
  action,
  onChanged
}: {
  device: NetEngineDevice
  busy: boolean
  /** Runs a daemon call; answers undefined when it failed (the section shows the error). */
  action: (method: PlatformRequestMethod, params: unknown) => Promise<unknown>
  onChanged: () => void
}) {
  const [adding, setAdding] = useState<Adding>()
  const [text, setText] = useState('')
  const routes = deviceRoutes(device)
  // Tailscale addresses it offered (they wait for Use), to pick from.
  const tailnetOffered = (device.offered ?? []).filter((route) => classOf(route) === 'tailnet')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const address = withPort(text.trim(), device)
    if (await action('netEngine.address.add', { node: device.node, address })) {
      setText('')
      setAdding(undefined)
    }
  }

  return (
    <div className="engine-routes" role="group" aria-label={`Routes to ${device.name}`}>
      {routes.map((route) => (
        <SettingsRow
          key={route.key}
          indent
          data-route-state={route.state}
          title={ROUTE_KIND[route.cls]}
          description={
            <span className="engine-row-line">
              {route.address && (
                <>
                  <span title={route.full}>{route.address}</span>
                  {' · '}
                </>
              )}
              <span
                className={route.state === 'failed' ? 'settings-status-warn' : route.state === 'in use' ? 'engine-route-live' : undefined}
                title={route.reason}
              >
                {STATE_WORDS[route.state]}
              </span>
            </span>
          }
          control={
            route.remove ? (
              <RowMenu
                label={`Actions for ${ROUTE_KIND[route.cls]} ${route.address ?? ''}`.trim()}
                disabled={busy}
                items={[
                  {
                    label: 'Remove route',
                    danger: true,
                    action: 'engine-route-remove',
                    onSelect: () => void action(route.remove!.method, route.remove!.params)
                  }
                ]}
              />
            ) : undefined
          }
        />
      ))}

      {!adding ? (
        <SettingsRow
          indent
          title={
            <button
              type="button"
              className="settings-btn"
              disabled={busy}
              title="A fallback is tried when the route in use drops."
              onClick={() => setAdding('tailnet')}
            >
              Add route
            </button>
          }
        />
      ) : (
        <div className="engine-route-add" role="group" aria-label="Add route">
          <div className="engine-route-kinds" role="radiogroup" aria-label="Kind">
            {(
              [
                ['tailnet', 'Tailscale'],
                ['ssh', 'SSH'],
                ['address', 'Port forward or tunnel']
              ] as const
            ).map(([kind, label]) => (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={adding === kind}
                className={`settings-btn${adding === kind ? ' engine-route-kind-on' : ''}`}
                onClick={() => {
                  setAdding(kind)
                  setText('')
                }}
              >
                {label}
              </button>
            ))}
            <button type="button" className="settings-btn" onClick={() => setAdding(undefined)}>
              Cancel
            </button>
          </div>
          {adding === 'ssh' ? (
            <SshAddSteps
              onDone={() => {
                setAdding(undefined)
                onChanged()
              }}
            />
          ) : (
            <form className="engine-paste" onSubmit={(event) => void submit(event)}>
              <input
                className="settings-input"
                value={text}
                autoFocus
                list={adding === 'tailnet' && tailnetOffered.length ? `tailnet-${device.node}` : undefined}
                placeholder={adding === 'tailnet' ? '100.101.7.2:47100' : '203.0.113.7:47100 or https://…'}
                aria-label={adding === 'tailnet' ? 'Tailscale address' : 'Address'}
                title={
                  adding === 'tailnet'
                    ? `${device.name}'s Tailscale address, as Tailscale shows it.`
                    : `Your router's public address for ${device.name}, or its tunnel's https:// address.`
                }
                onChange={(event) => setText(event.target.value)}
              />
              {adding === 'tailnet' && !!tailnetOffered.length && (
                <datalist id={`tailnet-${device.node}`}>
                  {tailnetOffered.map((route) => (
                    <option key={route} value={routeText(route)} />
                  ))}
                </datalist>
              )}
              <button
                type="submit"
                className="settings-btn primary"
                disabled={busy || !text.trim()}
                title="Adding it allows it."
              >
                Add
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * An address typed without a port gets the port of one already known for the device (its other routes listen on
 * the same one); a URL or an address with a port is left as it is.
 */
export function withPort(text: string, device: NetEngineDevice): string {
  if (/^[a-z]+:\/\//i.test(text) || /:\d+$/.test(text) || text.includes(']:')) return text
  const known = [...(device.addresses ?? []), ...(device.offered ?? [])]
    .map((route) => parseRoute(route))
    .find((route) => route?.kind === 'tcp')
  if (!known) return text
  return text.includes(':') ? `[${text}]:${known.port}` : `${text}:${known.port}`
}
