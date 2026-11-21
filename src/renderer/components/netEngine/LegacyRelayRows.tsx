import type { NetAddonActionResult } from '../../../shared/net/local'
import type { PlatformRequestMethod } from '../../../shared/platform'
import { bindSettings } from '../../lib/netDevices'
import { SettingsRow, Switch } from '../settings/SettingsRow'
import type { LegacyNet } from './legacyRows'

/*
 * The old networking's relays and its ways in that are still on, in the engine's Reach group. They keep serving
 * devices paired before the engine; nothing new is set up here. Delete once the engine relay ships (Phase 3).
 */

type Run = (method: PlatformRequestMethod, params: unknown) => Promise<unknown>

const live = (net: LegacyNet, id: string) => net.status?.transports?.find((t) => t.id === id)
const savedAddress = (net: LegacyNet, id: string): string => {
  const saved = net.saved[id] as { address?: unknown } | undefined
  return typeof saved?.address === 'string' ? saved.address : (live(net, id)?.routes[0]?.address ?? '')
}

const relaysOf = (net: LegacyNet) =>
  net.manifests.filter(
    (manifest) =>
      (manifest.id === 'relay' || manifest.id === 'plus-relay') &&
      (!!live(net, manifest.id)?.enabled || !!savedAddress(net, manifest.id))
  )

/** An old relay is on or set up: the Relay rows show. */
export const legacyRelaysSet = (net: LegacyNet): boolean => relaysOf(net).length > 0

/** A relay row for each old relay that is on or has an address saved: only where one was set up before. */
export function LegacyRelayRows({ net, busy, run }: { net: LegacyNet; busy: boolean; run: Run }) {
  const relays = relaysOf(net)
  return (
    <>
      {relays.map((manifest) => {
        const on = !!live(net, manifest.id)?.enabled
        const address = savedAddress(net, manifest.id)
        const plus = manifest.id === 'plus-relay'
        const label = plus ? 'Mousse relay' : 'Relay'
        return (
          <SettingsRow
            key={manifest.id}
            title={label}
            description={
              <span title="Devices paired before this version can reach this computer through it.">
                {plus ? (on ? 'On' : 'Off') : address || (on ? 'On' : 'Off')}
              </span>
            }
            control={
              <Switch
                checked={on}
                label={label}
                disabled={busy || (!on && !plus && !address)}
                onChange={(next) =>
                  void run('net.transport.configure', {
                    id: manifest.id,
                    enabled: next,
                    ...(plus ? {} : { settings: { address } })
                  })
                }
              />
            }
          />
        )
      })}
    </>
  )
}

const OLD_WAYS: Record<string, { title: string; off?: Record<string, unknown> }> = {
  direct: { title: 'Older devices on this network', off: {} },
  tailscale: { title: 'Older devices over Tailscale' },
  cloudflared: { title: 'Older devices over Cloudflare', off: { mode: 'quick' } },
  ssh: { title: 'Older devices over SSH' }
}

/** One of the old networking's ways in is on today. */
export const legacyAddonsOn = (net: LegacyNet): boolean =>
  Object.keys(OLD_WAYS).some((id) => live(net, id)?.enabled)

/** The old networking's ways in that are on today: each can only be turned off here. */
export function LegacyAddonRows({ net, busy, run }: { net: LegacyNet; busy: boolean; run: Run }) {
  const on = Object.keys(OLD_WAYS).filter((id) => live(net, id)?.enabled)
  return (
    <>
      {on.map((id) => (
        <SettingsRow
          key={id}
          title={OLD_WAYS[id]!.title}
          description={
            <span title="Set up before this version. It keeps devices paired then connected.">On</span>
          }
          control={
            <button
              type="button"
              className="settings-btn"
              disabled={busy}
              onClick={() =>
                void run('net.transport.configure', {
                  id,
                  enabled: false,
                  ...(OLD_WAYS[id]!.off ? { settings: OLD_WAYS[id]!.off } : {})
                })
              }
            >
              Turn off
            </button>
          }
        />
      ))}
    </>
  )
}

/**
 * Tailscale Serve, while a change made before this version is still applied: it stays undoable. Turning it off
 * puts the old Tailscale way in back as it was without Serve.
 */
export function LegacyServeRow({
  net,
  busy,
  run,
  onError
}: {
  net: LegacyNet
  busy: boolean
  run: Run
  onError: (message: string) => void
}) {
  if (net.records.tailscale?.action !== 'serve') return null
  const served = net.records.tailscale.record as { state?: string }
  const turnOff = async () => {
    const result = (await run('net.transport.action.undo', {
      id: 'tailscale',
      action: 'serve'
    })) as NetAddonActionResult | undefined
    if (!result) return
    if (!result.ok) {
      onError(result.message)
      return
    }
    if (net.status?.enabled)
      await run('net.transport.configure', {
        id: 'tailscale',
        enabled: !!live(net, 'tailscale')?.enabled,
        settings: bindSettings(net.saved.tailscale)
      })
  }
  return (
    <SettingsRow
      title="Tailscale Serve"
      anchor="devices-tailscale-serve"
      description={
        <span title="Set up before this version: Tailscale passes connections on to this computer.">
          {served.state === 'pending' ? 'Not confirmed · turn it off to clear it' : 'Still on from before'}
        </span>
      }
      control={
        <button type="button" className="settings-btn" disabled={busy} onClick={() => void turnOff()}>
          Turn off Serve
        </button>
      }
    />
  )
}
