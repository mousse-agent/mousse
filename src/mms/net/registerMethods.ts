import { isIP } from 'node:net'
import {
  NET_LOCAL_CAPABILITY,
  NET_LOCAL_METHODS,
  type NetLocalMethod
} from '../../shared/net/local'
import { isId, NODE_CAPABILITIES, NET_ERRORS, NetError } from '../../shared/net'
import { AppError } from '../../shared/errors'
import { DomainHandlerRegistry, DomainRpcError, domainObject } from '../protocol/domainRegistry'

export interface NetLocalService {
  request(method: NetLocalMethod, params: Record<string, unknown>): unknown | Promise<unknown>
}
const keys: Record<NetLocalMethod, readonly string[]> = {
  'net.transport.list': [],
  'net.transport.configure': ['id', 'enabled', 'settings'],
  'net.init': ['name', 'listen', 'host', 'port'],
  'net.status': [],
  'net.doctor': [],
  'net.protect': ['passphrase'],
  'net.unlock': ['passphrase'],
  'net.authority.transfer': ['node'],
  'net.authority.status': [],
  'net.recovery.export': ['passphrase'],
  'net.recovery.import': ['file', 'passphrase', 'becomeAuthority'],
  'bridge.invite': ['ttlMs', 'name', 'caps'],
  'bridge.join': ['invite', 'name', 'passphrase'],
  'bridge.nodes': [],
  'bridge.revoke': ['node'],
  'bridge.rename': ['node', 'name']
}
function validate(method: NetLocalMethod, value: unknown): Record<string, unknown> {
  const params = domainObject(value ?? {}, ['profileId', ...keys[method]])
  if (
    ['net.unlock', 'net.recovery.export', 'net.recovery.import'].includes(method) &&
    params.passphrase === undefined
  )
    throw new DomainRpcError('invalid_params', 'A passphrase is required')
  if (
    params.passphrase !== undefined &&
    (typeof params.passphrase !== 'string' ||
      !params.passphrase.length ||
      Buffer.byteLength(params.passphrase) > 4096 ||
      Buffer.from(params.passphrase, 'utf8').toString('utf8') !== params.passphrase)
  )
    throw new DomainRpcError('invalid_params', 'Passphrase is outside its bounds')
  if (
    params.name !== undefined &&
    (typeof params.name !== 'string' || !params.name.trim() || Array.from(params.name).length > 256)
  )
    throw new DomainRpcError('invalid_params', 'Name must contain 1–256 characters')
  if (params.listen !== undefined && typeof params.listen !== 'boolean')
    throw new DomainRpcError('invalid_params', 'listen must be boolean')
  if (params.host !== undefined && (typeof params.host !== 'string' || !isIP(params.host)))
    throw new DomainRpcError('invalid_params', 'Listener host must be an IP address')
  if (
    params.port !== undefined &&
    (!Number.isInteger(params.port) || Number(params.port) < 0 || Number(params.port) > 65535)
  )
    throw new DomainRpcError('invalid_params', 'Listener port must be 0–65535')
  if ((params.host !== undefined || params.port !== undefined) && params.listen !== true)
    throw new DomainRpcError('invalid_params', 'host and port require listen')
  if (
    params.ttlMs !== undefined &&
    (!Number.isSafeInteger(params.ttlMs) ||
      Number(params.ttlMs) < 1 ||
      Number(params.ttlMs) > 7 * 86400_000)
  )
    throw new DomainRpcError('invalid_params', 'Invite lifetime is outside its bounds')
  if (
    params.caps !== undefined &&
    (!Array.isArray(params.caps) ||
      !params.caps.length ||
      params.caps.some((cap) => !(NODE_CAPABILITIES as readonly unknown[]).includes(cap)) ||
      new Set(params.caps).size !== params.caps.length)
  )
    throw new DomainRpcError('invalid_params', 'Invalid node capabilities')
  if (
    ['bridge.revoke', 'bridge.rename', 'net.authority.transfer'].includes(method) &&
    !isId('node', params.node)
  )
    throw new DomainRpcError('invalid_params', 'A node identity is required')
  if (
    method === 'net.recovery.import' &&
    (params.becomeAuthority !== true ||
      typeof params.file !== 'string' ||
      !/^[A-Za-z0-9_-]+$/.test(params.file) ||
      params.file.length > 22000)
  )
    throw new DomainRpcError(
      'invalid_params',
      'A bounded recovery file and explicit authority selection are required'
    )
  if (method === 'bridge.rename' && params.name === undefined)
    throw new DomainRpcError('invalid_params', 'A node name is required')
  if (
    method === 'bridge.join' &&
    (typeof params.invite !== 'string' ||
      !params.invite.startsWith('mj1_') ||
      params.invite.length > 64 * 1024)
  )
    throw new DomainRpcError('invalid_params', 'A node invite is required')
  if (
    method === 'net.transport.configure' &&
    (typeof params.id !== 'string' ||
      !/^[a-z][a-z0-9.-]{0,63}$/.test(params.id) ||
      typeof params.enabled !== 'boolean' ||
      !params.settings ||
      typeof params.settings !== 'object' ||
      Array.isArray(params.settings) ||
      Buffer.byteLength(JSON.stringify(params.settings)) > 16 * 1024)
  )
    throw new DomainRpcError('invalid_params', 'A bounded transport configuration is required')
  return params
}

function publicError(code: keyof typeof NET_ERRORS, cause?: unknown): AppError {
  const entry = NET_ERRORS[code]
  return new AppError(
    {
      code,
      message: entry.message,
      errorInfo: { category: entry.category, retryable: entry.retryable }
    },
    cause
  )
}

/** Local owner IPC only. Remote peers cannot invoke this registry through Bridge. */
export function registerNetMethods(
  registry: DomainHandlerRegistry,
  forProfile: (id: string) => NetLocalService | Promise<NetLocalService>
): void {
  for (const method of NET_LOCAL_METHODS)
    registry.register({
      method,
      scope: 'profile',
      capability: NET_LOCAL_CAPABILITY,
      requiredCapabilities: [NET_LOCAL_CAPABILITY],
      validate: (params) => {
        try {
          if (
            method === 'bridge.join' &&
            params &&
            typeof params === 'object' &&
            typeof (params as Record<string, unknown>).invite === 'string' &&
            ((params as Record<string, unknown>).invite as string).length > 64 * 1024
          )
            throw publicError('too_large')
          return validate(method, params)
        } catch (error) {
          if (error instanceof DomainRpcError) throw publicError('bad_request')
          throw error
        }
      },
      async handle(_context, params, binding) {
        try {
          return await (await forProfile(binding!.profileId)).request(method, params)
        } catch (error) {
          if (error instanceof NetError) throw publicError(error.code, error)
          throw error
        }
      }
    })
}
