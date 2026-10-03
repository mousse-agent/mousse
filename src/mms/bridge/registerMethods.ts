import { AppError } from '../../shared/errors'
import { NET_ERRORS, NetError } from '../../shared/net'
import { NET_LOCAL_CAPABILITY } from '../../shared/net/local'
import { BRIDGE_HUB_LOCAL_METHODS, BRIDGE_HUB_THREAD_EVENT } from '../../shared/bridge'
import { DomainHandlerRegistry } from '../protocol/domainRegistry'
import type { DomainConnectionContext, TrustedProfileBinding } from '../protocol/domainRegistry'
import type { BridgeProfileService } from './BridgeProfileService'
import { BridgeDisplayEmitter, executeBridgeHubLocal, validateBridgeHubLocal } from './hub'

interface Owner {
  profile: string
  epoch: number
  service: BridgeProfileService
  emitter: BridgeDisplayEmitter
  unwatch(): void
}
function publicError(error: unknown): AppError {
  const code = error instanceof NetError ? error.code : 'internal', entry = NET_ERRORS[code]
  return new AppError({ code, message: entry.message, errorInfo: { category: entry.category, retryable: entry.retryable } })
}

/** Trusted local profile methods, never a remote method-forwarding endpoint. */
export function registerBridgeMethods(registry: DomainHandlerRegistry, forProfile: (id: string) => BridgeProfileService | Promise<BridgeProfileService>): void {
  const owners = new Map<string, Owner>()
  const close = (id: string): Promise<void> => {
    const owner = owners.get(id)
    if (!owner) return Promise.resolve()
    owners.delete(id); owner.unwatch(); owner.emitter.close(); owner.service.hub.detachOwner(id)
    return owner.service.ownDrain(owner.emitter.drain()).then(() => undefined, () => undefined)
  }
  registry.onConnectionClosed(id => { void close(id) })
  registry.onProfileDisposed(profile => { for (const [id, owner] of owners) if (owner.profile === profile) void close(id) })
  async function events(connection: DomainConnectionContext | undefined, binding: TrustedProfileBinding, service: BridgeProfileService) {
    if (!connection?.emitConnectionEvent) throw new NetError('forbidden')
    const held = owners.get(connection.id)
    if (held && (held.profile !== binding.profileId || held.epoch !== binding.epoch || held.service !== service)) await close(connection.id)
    let owner = owners.get(connection.id)
    if (!owner) {
      if (owners.size >= 64) throw new NetError('rate_limited')
      const writer = connection.emitConnectionEvent
      const emitter = new BridgeDisplayEmitter({ emit: (part, signal) => writer(BRIDGE_HUB_THREAD_EVENT, part, signal),
        error: () => { if (owners.get(connection.id)?.emitter === emitter) void close(connection.id) } })
      owner = { profile: binding.profileId, epoch: binding.epoch, service, emitter, unwatch: service.onClose(() => close(connection.id)) }
      owners.set(connection.id, owner)
    }
    return { owner: connection.id, thread: (event: Parameters<BridgeDisplayEmitter['enqueue']>[0]) => owner!.emitter.enqueue(event),
      error: () => { if (owners.get(connection.id) === owner) void close(connection.id) } }
  }
  for (const method of BRIDGE_HUB_LOCAL_METHODS) registry.register({ method, scope: 'profile', capability: NET_LOCAL_CAPABILITY, requiredCapabilities: [NET_LOCAL_CAPABILITY],
    validate: value => { try { return validateBridgeHubLocal(method, value ?? {}) } catch (error) { throw publicError(error) } },
    handle: async (context, params, binding) => {
      try {
        const service = await forProfile(binding!.profileId)
        service.options.net.assertFeature('netBridge')
        const local = method === 'bridge.hub.attach' || method === 'bridge.hub.detach' ? await events(context.connection, binding!, service) : undefined
        return await executeBridgeHubLocal(service.hub, method, params, local)
      } catch (error) { throw publicError(error) }
    } })
}
