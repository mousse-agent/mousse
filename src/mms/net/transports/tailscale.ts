import type { Duplex } from 'node:stream'
import { isIP } from 'node:net'
import type { Clock, InboundInfo, Listener, Transport, TransportAddon, TransportStatus } from '../contracts'
import type { Route } from '../../../shared/net/identity'
import { NetError } from '../../../shared/net/errors'
import { DirectTransport } from './direct'
import { runBinary } from './runtime/process'
import { systemClock } from '../clock'

export interface TailscaleSettings { binary?: string; port?: number; enabled?: boolean }
/** Uses an already authenticated tailnet. Never logs in, changes ACLs or enables Funnel. */
export class TailscaleTransport implements Transport {
  readonly id = 'tailscale'
  readonly traits = { canListen: true, canDial: true, readsPlaintext: false, needsAccount: true }
  private direct?: DirectTransport
  private statusValue: TransportStatus = { state: 'disabled', routes: [] }
  private off?: () => void
  private readonly listeners = new Set<(status: TransportStatus) => void>()
  constructor(private readonly settings: TailscaleSettings = {}, private readonly clock: Clock = systemClock) {}
  async provision(): Promise<void> {
    if (this.direct) return
    this.changed({ state: 'provisioning', routes: [] })
    try {
      const status = JSON.parse(await runBinary(this.settings.binary ?? 'tailscale', ['status', '--json'])) as { BackendState?: string; Self?: { TailscaleIPs?: unknown[]; DNSName?: unknown } }
      const addresses = status.Self?.TailscaleIPs
      const address = addresses?.find(value => typeof value === 'string' && isIP(value) === 4)
      if (status.BackendState !== 'Running' || typeof address !== 'string') throw new Error()
      this.direct = new DirectTransport({ enabled: this.settings.enabled ?? true, host: address, port: this.settings.port ?? 0, clock: this.clock })
      this.off = this.direct.onStatus(current => this.changed({ ...current, routes: current.routes.map(route => ({ ...route, transport: 'direct', priority: 10 })) }))
      await this.direct.provision()
    } catch { this.changed({ state: 'failed', routes: [], detail: 'Install Tailscale and sign into your tailnet, then retry setup.', lastError: { code: 'route_unreachable', message: 'Tailscale is unavailable or not connected.' } }); throw new NetError('route_unreachable', 'Tailscale is unavailable or not connected.') }
  }
  async listen(accept: (stream: Duplex, info: InboundInfo) => void): Promise<Listener> { if (!this.direct) throw new NetError('route_unreachable'); return this.direct.listen((raw, info) => accept(raw, { ...info, transport: this.id })) }
  markAuthenticated(raw: Duplex): void { this.direct?.markAuthenticated(raw) }
  async dial(route: Route, signal: AbortSignal): Promise<Duplex> { if (!this.direct) throw new NetError('route_unreachable'); return this.direct.dial({ ...route, transport: 'direct' }, signal) }
  status(): TransportStatus { return structuredClone(this.statusValue) }
  onStatus(listener: (status: TransportStatus) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private changed(status: TransportStatus): void { this.statusValue = status; for (const listener of this.listeners) listener(this.status()) }
  async teardown(): Promise<void> { this.off?.(); this.off = undefined; await this.direct?.teardown(); this.direct = undefined; this.changed({ state: 'disabled', routes: [] }) }
}

export const tailscaleAddon: TransportAddon = {
  manifest: { id: 'tailscale', kind: 'transport', displayName: 'Tailscale', traits: { canListen: true, canDial: true, readsPlaintext: false, needsAccount: true }, settingsSchema: { type: 'object', additionalProperties: false, properties: { binary: { type: 'string', minLength: 1, maxLength: 4096 }, port: { type: 'integer', minimum: 0, maximum: 65535 }, enabled: { type: 'boolean' } } }, setupSteps: [{ title: 'Connect Tailscale', detail: 'Install Tailscale and sign in to your tailnet. Mousse uses its private address and does not enable Funnel.', command: 'tailscale up' }] },
  create: (settings, context) => new TailscaleTransport(settings as TailscaleSettings, context.clock)
}
