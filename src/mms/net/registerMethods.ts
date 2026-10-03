import { isIP } from 'node:net'
import { NET_LOCAL_CAPABILITY, NET_LOCAL_METHODS, type NetLocalMethod } from '../../shared/net/local'
import { isId, NODE_CAPABILITIES, NET_ERRORS, NetError } from '../../shared/net'
import { DomainHandlerRegistry, DomainRpcError, domainObject } from '../protocol/domainRegistry'

export interface NetLocalService {
  request(method: NetLocalMethod, params: Record<string, unknown>): unknown | Promise<unknown>
}
const keys: Record<NetLocalMethod, readonly string[]> = {
  'net.init': ['name', 'listen', 'host', 'port'], 'net.status': [], 'net.doctor': [],
  'bridge.invite': ['ttlMs', 'name', 'caps'], 'bridge.join': ['invite', 'name'],
  'bridge.nodes': [], 'bridge.revoke': ['node'], 'bridge.rename': ['node', 'name']
}
function validate(method: NetLocalMethod, value: unknown): Record<string, unknown> {
  const params = domainObject(value ?? {}, ['profileId', ...keys[method]])
  if (params.name !== undefined && (typeof params.name !== 'string' || !params.name.trim() || Array.from(params.name).length > 256)) throw new DomainRpcError('invalid_params', 'Name must contain 1–256 characters')
  if (params.listen !== undefined && typeof params.listen !== 'boolean') throw new DomainRpcError('invalid_params', 'listen must be boolean')
  if (params.host !== undefined && (typeof params.host !== 'string' || !isIP(params.host))) throw new DomainRpcError('invalid_params', 'Listener host must be an IP address')
  if (params.port !== undefined && (!Number.isInteger(params.port) || Number(params.port) < 0 || Number(params.port) > 65535)) throw new DomainRpcError('invalid_params', 'Listener port must be 0–65535')
  if ((params.host !== undefined || params.port !== undefined) && params.listen !== true) throw new DomainRpcError('invalid_params', 'host and port require listen')
  if (params.ttlMs !== undefined && (!Number.isSafeInteger(params.ttlMs) || Number(params.ttlMs) < 1 || Number(params.ttlMs) > 7 * 86400_000)) throw new DomainRpcError('invalid_params', 'Invite lifetime is outside its bounds')
  if (params.caps !== undefined && (!Array.isArray(params.caps) || !params.caps.length || params.caps.some(cap => !(NODE_CAPABILITIES as readonly unknown[]).includes(cap)) || new Set(params.caps).size !== params.caps.length)) throw new DomainRpcError('invalid_params', 'Invalid node capabilities')
  if (['bridge.revoke', 'bridge.rename'].includes(method) && !isId('node', params.node)) throw new DomainRpcError('invalid_params', 'A node identity is required')
  if (method === 'bridge.rename' && params.name === undefined) throw new DomainRpcError('invalid_params', 'A node name is required')
  if (method === 'bridge.join' && (typeof params.invite !== 'string' || !params.invite.startsWith('mj1_') || params.invite.length > 16 * 1024)) throw new DomainRpcError('invalid_params', 'A node invite is required')
  return params
}

/** Local owner IPC only. Remote peers cannot invoke this registry through Bridge. */
export function registerNetMethods(registry: DomainHandlerRegistry, forProfile: (id: string) => NetLocalService | Promise<NetLocalService>): void {
  for (const method of NET_LOCAL_METHODS) registry.register({
    method, scope: 'profile', capability: NET_LOCAL_CAPABILITY, requiredCapabilities: [NET_LOCAL_CAPABILITY],
    validate: params => validate(method, params),
    async handle(_context, params, binding) {
      try { return await (await forProfile(binding!.profileId)).request(method, params) }
      catch (error) {
        if (error instanceof NetError) throw new DomainRpcError(error.code, NET_ERRORS[error.code].message, { retryable: NET_ERRORS[error.code].retryable })
        throw error
      }
    }
  })
}
