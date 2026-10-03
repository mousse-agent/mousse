import type { Duplex } from 'node:stream'
import { isIP } from 'node:net'
import type { Clock, Transport, TransportAddon, TransportManifest, TransportStatus, InboundInfo } from '../contracts'
import { NetError, type Route } from '../../../shared/net'
import { DirectTransport } from './direct'
import { TransportRegistry, type TransportConfiguration } from './registry'
import { tailscaleAddon } from './tailscale'
import { cloudflaredAddon } from './cloudflared'
import { RelayTransport, createRelayAddon } from './relay'
import { relayUrl, type RelayIdentity, type RelayRendezvous } from '../relay/protocol'

const directAddon: TransportAddon = {
  manifest: { id: 'direct', kind: 'transport', displayName: 'Direct WebSocket', traits: { canListen: true, canDial: true, readsPlaintext: false, needsAccount: false }, settingsSchema: { type: 'object', additionalProperties: false, properties: { host: { type: 'string', minLength: 1, maxLength: 253 }, advertiseHost: { type: 'string', minLength: 1, maxLength: 253 }, port: { type: 'integer', minimum: 0, maximum: 65535 } } }, setupSteps: [{ title: 'Listen on a reachable address', detail: 'Bind an explicit local address and allow the selected port through your firewall. Inner pinned TLS authenticates peers.' }] },
  create: (settings, context) => new DirectTransport({ ...(settings as { host?: string; advertiseHost?: string; port?: number }), enabled: true, clock: context.clock })
}
export interface ManagedTransportStatus { id: string; enabled: boolean; state: TransportStatus['state']; routes: Route[]; error?: import('../../../shared/net').NetErrorCode }

/** Profiles select listeners; verified remote endpoints remain dialable without local tunnel accounts/binaries. */
export class ProfileTransports {
  private readonly registry: TransportRegistry
  private readonly direct: DirectTransport
  private readonly sockets = new Set<Duplex>()
  private readonly dialRelays = new Set<RelayTransport>()
  private readonly errors = new Map<string, import('../../../shared/net').NetErrorCode>()
  private readonly off: Array<() => void> = []
  private readonly listeners = new Set<(status: TransportStatus) => void>()
  private stopping = false
  constructor(private readonly options: { clock: Clock; profileDir: string; identity(): RelayIdentity; onChanged?(): void; relayRendezvous?: RelayRendezvous; addons?: TransportAddon[] }) {
    this.registry = new TransportRegistry(options)
    for (const addon of [directAddon, tailscaleAddon, cloudflaredAddon, createRelayAddon(options.identity), ...(options.addons ?? [])]) this.registry.register(addon)
    this.direct = new DirectTransport({ clock: options.clock })
  }
  manifests(): TransportManifest[] { return this.registry.manifests() }
  validate(configuration: TransportConfiguration): TransportConfiguration {
    if (!configuration || typeof configuration !== 'object' || Object.keys(configuration).some(key => !['id', 'enabled', 'settings'].includes(key))) throw new NetError('bad_request')
    const checked = this.registry.validate(configuration)
    if (checked.id === 'direct') {
      const settings = checked.settings as { host?: string; advertiseHost?: string }
      if (settings.host !== undefined && !isIP(settings.host)) throw new NetError('bad_request')
      if (settings.advertiseHost !== undefined && !isIP(settings.advertiseHost)) throw new NetError('bad_request')
    }
    if (checked.id === 'relay') { const address = relayUrl((checked.settings as { address: string }).address); if (address.search) throw new NetError('bad_request') }
    if (checked.id === 'cloudflared') cloudflaredAddon.create(checked.settings, { clock: this.options.clock, profileDir: this.options.profileDir })
    return checked
  }
  async start(configurations: TransportConfiguration[], accept: (stream: Duplex, info: InboundInfo) => void): Promise<void> {
    if (configurations.length > 8 || new Set(configurations.map(row => row.id)).size !== configurations.length) throw new NetError('bad_request')
    const checked = configurations.map(row => this.validate(row))
    await this.direct.provision()
    for (const configuration of checked) {
      try {
        const transport = await this.registry.configure(configuration)
        if (!transport) continue
        this.off.push(transport.onStatus(status => { if (status.state === 'ready' && status.routes.length) this.errors.delete(configuration.id); this.changed() }))
        await transport.listen((raw, info) => {
          if (this.stopping) { raw.destroy(); return }
          this.sockets.add(raw); raw.once('close', () => this.sockets.delete(raw)); accept(raw, info)
        })
      } catch (error) { this.errors.set(configuration.id, error instanceof NetError ? error.code : 'route_unreachable') }
    }
    this.changed()
  }
  statuses(): ManagedTransportStatus[] {
    return this.registry.statuses().map(({ id, status }) => {
      const enabled = this.registry.configuration().find(row => row.id === id)!.enabled, error = this.errors.get(id) ?? status.lastError?.code
      return { id, enabled, state: error && !status.routes.length ? 'failed' : status.state, routes: status.routes, ...(error ? { error } : {}) }
    })
  }
  routes(): Route[] { return this.statuses().flatMap(row => row.routes) }
  /** RouteManager requires one transport per advertised family, including dial-only defaults. */
  transports(): Transport[] {
    return ['direct', 'cloudflared', 'relay'].map(id => ({ id,
      traits: { canListen: false, canDial: true, readsPlaintext: id !== 'direct', needsAccount: false },
      provision: async () => undefined, listen: async () => { throw new NetError('forbidden') },
      resolve: async (route: Route, signal: AbortSignal) => { if (route.transport !== 'relay') await this.direct.resolve({ ...route, transport: 'direct' }, signal) },
      dial: (route: Route, signal: AbortSignal) => this.dial(route, signal),
      status: () => ({ state: this.stopping ? 'disabled' : 'ready', routes: this.routes().filter(route => route.transport === id) }),
      onStatus: (listener: (status: TransportStatus) => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) },
      teardown: async () => undefined
    } as Transport))
  }
  async dial(route: Route, signal: AbortSignal): Promise<Duplex> {
    if (this.stopping) throw new NetError('cancelled')
    let raw: Duplex
    if (route.transport === 'relay') {
      const address = relayUrl(route.address); address.search = ''
      const relay = new RelayTransport({ settings: { address: address.toString() }, clock: this.options.clock, identity: this.options.identity, ...(this.options.relayRendezvous ? { enrollment: this.options.relayRendezvous } : {}) })
      this.dialRelays.add(relay)
      try { await relay.provision(); raw = await relay.dial(route, signal) }
      catch (error) { this.dialRelays.delete(relay); await relay.teardown(); throw error }
      raw.once('close', () => { this.dialRelays.delete(relay); void relay.teardown() })
    } else {
      if (route.transport === 'cloudflared') {
        const url = new URL(route.address)
        if (url.protocol !== 'wss:' || url.username || url.password || url.hash || url.pathname !== '/mousse-net' || url.search) throw new NetError('bad_request')
      } else if (route.transport !== 'direct') throw new NetError('route_unreachable')
      raw = await this.direct.dial({ ...route, transport: 'direct' }, signal)
    }
    this.sockets.add(raw); raw.once('close', () => this.sockets.delete(raw))
    return raw
  }
  async prepareEnrollmentRendezvous(expiresAt: number): Promise<RelayRendezvous | undefined> {
    const relay = this.registry.transports().find(transport => transport.id === 'relay')
    if (!relay || !relay.status().routes.length) return undefined
    return (relay as RelayTransport).prepareEnrollmentRendezvous({ expiresAt })
  }
  hasRelayListener(): boolean { return this.registry.transports().some(transport => transport.id === 'relay' && transport.status().routes.length > 0) }
  markAuthenticated(raw: Duplex): void {
    for (const transport of this.registry.transports()) if ('markAuthenticated' in transport && typeof transport.markAuthenticated === 'function') transport.markAuthenticated(raw)
  }
  private changed(): void {
    if (this.stopping) return
    this.options.onChanged?.()
    for (const listener of this.listeners) listener({ state: 'ready', routes: this.routes() })
  }
  async teardown(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    for (const off of this.off.splice(0)) off()
    for (const raw of this.sockets) raw.destroy()
    await Promise.allSettled([this.registry.teardown(), this.direct.teardown(), ...[...this.dialRelays].map(relay => relay.teardown())])
    this.dialRelays.clear(); this.sockets.clear(); this.listeners.clear()
  }
}
