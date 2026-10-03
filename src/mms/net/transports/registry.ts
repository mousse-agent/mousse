import Ajv from 'ajv'
import type { Clock, Transport, TransportAddon, TransportManifest, TransportStatus } from '../contracts'
import { NetError } from '../../../shared/net/errors'

export interface TransportConfiguration { id: string; enabled: boolean; settings: unknown }
/** In-tree factories only. The profile owner persists these validated configurations. */
export class TransportRegistry {
  private readonly entries = new Map<string, { addon: TransportAddon; validate: ReturnType<Ajv['compile']> }>()
  private readonly active = new Map<string, Transport>()
  private readonly configurations = new Map<string, TransportConfiguration>()
  private pending: Promise<unknown> = Promise.resolve()
  constructor(private readonly context: { clock: Clock; profileDir: string }) {}
  register(addon: TransportAddon): void {
    const { manifest } = addon
    if (manifest.kind !== 'transport' || !/^[a-z][a-z0-9.-]{0,63}$/.test(manifest.id) || this.entries.has(manifest.id)) throw new NetError('conflict', 'Invalid or duplicate transport add-on.')
    const ajv = new Ajv({ strict: true, allErrors: false, useDefaults: false, coerceTypes: false, removeAdditional: false })
    const validate = ajv.compile(manifest.settingsSchema)
    this.entries.set(manifest.id, { addon, validate })
  }
  manifests(): TransportManifest[] { return [...this.entries.values()].map(({ addon }) => structuredClone(addon.manifest)) }
  validate(configuration: TransportConfiguration): TransportConfiguration {
    const entry = this.entries.get(configuration.id)
    if (!entry || typeof configuration.enabled !== 'boolean' || !entry.validate(configuration.settings)) throw new NetError('bad_request', 'Invalid transport settings.')
    return structuredClone(configuration)
  }
  configure(configuration: TransportConfiguration): Promise<Transport | undefined> {
    const checked = this.validate(configuration)
    const work = async () => {
      const prior = this.active.get(checked.id)
      if (prior) { this.active.delete(checked.id); await prior.teardown() }
      this.configurations.set(checked.id, checked)
      if (!checked.enabled) return undefined
      const transport = this.entries.get(checked.id)!.addon.create(structuredClone(checked.settings), this.context)
      if (transport.id !== checked.id) throw new NetError('internal', 'Transport factory returned the wrong identifier.')
      try { await transport.provision(); this.active.set(checked.id, transport); return transport }
      catch (error) { await transport.teardown().catch(() => {}); throw error }
    }
    const result = this.pending.then(work, work)
    this.pending = result.catch(() => {})
    return result
  }
  transports(): Transport[] { return [...this.active.values()] }
  configuration(): TransportConfiguration[] { return [...this.configurations.values()].map(value => structuredClone(value)) }
  statuses(): Array<{ id: string; status: TransportStatus }> { return [...this.configurations.values()].map(config => ({ id: config.id, status: this.active.get(config.id)?.status() ?? { state: config.enabled ? 'failed' : 'disabled', routes: [] } })) }
  async teardown(): Promise<void> { await this.pending; await Promise.allSettled([...this.active.values()].map(transport => transport.teardown())); this.active.clear() }
}
