import { isIP } from 'node:net'
import {
  NET_LOCAL_CAPABILITY,
  NET_LOCAL_METHODS,
  type NetLocalMethod
} from '../../shared/net/local'
import {
  EDITOR_TUNNEL_LOCAL_METHODS,
  type EditorTunnelLocalMethod
} from '../../shared/net/editorProxy'
import { isId, NODE_CAPABILITIES, NET_ERRORS, NetError } from '../../shared/net'
import { isJoinVia } from '../../shared/net/via'
import { AppError } from '../../shared/errors'
import { isPermissionMode } from '../../shared/permissionMode'
import { DomainHandlerRegistry, DomainRpcError, domainObject } from '../protocol/domainRegistry'

export interface NetLocalService {
  request(method: NetLocalMethod, params: Record<string, unknown>): unknown | Promise<unknown>
}
const keys: Record<NetLocalMethod, readonly string[]> = {
  'net.plus.discover': ['apiOrigin'],
  'net.plus.login.begin': ['configuration', 'deviceName', 'bindRoot'],
  'net.plus.login.finish': ['id'],
  'net.plus.configure': ['configuration'],
  'net.plus.renew': [],
  'net.plus.allow': ['node', 'ttlMs', 'revoke'],
  'net.plus.status': [],
  'net.plus.bind': ['configuration', 'accountToken'],
  'net.plus.connect': ['accountToken'],
  'net.plus.disconnect': [],
  'net.plus.login.cancel': [],
  'net.plus.enrollment.requests': [],
  'net.plus.enrollment.approve': ['id'],
  'net.plus.enrollment.deny': ['id'],
  'net.plus.enrollment.offer': ['name'],
  'net.transport.list': [],
  'net.transport.configure': ['id', 'enabled', 'settings'],
  'net.transport.action.describe': ['id', 'action', 'settings'],
  'net.transport.action.apply': ['id', 'action', 'settings'],
  'net.transport.action.undo': ['id', 'action', 'settings'],
  'net.routes': [],
  'net.ssh.check': ['host'],
  'net.ssh.trust': ['host', 'fingerprint', 'acknowledgeChanged'],
  'net.ssh.plan': ['host', 'name', 'port'],
  'net.ssh.list': [],
  'net.ssh.setup.begin': ['host', 'name', 'port'],
  'net.ssh.setup.status': ['id'],
  'net.ssh.setup.cancel': ['id'],
  'net.ssh.setup.retry': ['id'],
  'net.ssh.undo': ['id'],
  'net.ssh.update': ['id'],
  'net.ssh.rename': ['id', 'endpoint'],
  'net.ssh.approve': ['node', 'endpoint'],
  'net.ssh.target': ['node'],
  'net.editor.ssh.status': [],
  'net.editor.ssh.prepare': [],
  'net.editor.ssh.enable': [],
  'net.editor.ssh.disable': [],
  'net.editor.ssh.ack': [],
  'net.editor.alias': [],
  'net.editor.probe': ['node'],
  'net.init': ['name', 'listen', 'host', 'port', 'passphrase'],
  'net.disable': [],
  'net.status': [],
  'net.doctor': [],
  'net.protect': ['passphrase'],
  'net.unlock': ['passphrase'],
  'net.authority.transfer': ['node'],
  'net.authority.status': [],
  'net.recovery.export': ['passphrase'],
  'net.recovery.import': ['file', 'passphrase', 'becomeAuthority'],
  'bridge.invite': ['ttlMs', 'name', 'caps'],
  'bridge.join': ['invite', 'name', 'passphrase', 'via'],
  'bridge.nodes': [],
  'bridge.revoke': ['node'],
  'bridge.rename': ['node', 'name'],
  'bridge.setCaps': ['node', 'caps'],
  'bridge.setKind': ['node', 'kind'],
  'bridge.policy': ['node', 'blocked', 'maxPermissionMode', 'terminal', 'editor'],
  'bridge.workOnThreads': ['enabled']
}
const SSH_ID = /^[A-Za-z0-9_-]{1,64}$/u
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/u
/** Bounded shapes for the remote machine methods; the host and name get their full checks in the bootstrap. */
function validateSsh(method: NetLocalMethod, params: Record<string, unknown>): void {
  const bad = (message: string): never => {
    throw new DomainRpcError('invalid_params', message)
  }
  const text = (value: unknown, limit: number) =>
    typeof value === 'string' && value.length > 0 && value.length <= limit
  if (['net.ssh.check', 'net.ssh.trust', 'net.ssh.plan', 'net.ssh.setup.begin'].includes(method)) {
    if (!text(params.host, 253)) bad('A host is required')
  }
  if (['net.ssh.plan', 'net.ssh.setup.begin'].includes(method)) {
    if (!text(params.name, 256)) bad('A device name is required')
    if (
      params.port !== undefined &&
      (!Number.isInteger(params.port) || Number(params.port) < 1 || Number(params.port) > 65535)
    )
      bad('The daemon port must be 1–65535')
  }
  if (method === 'net.ssh.trust') {
    if (typeof params.fingerprint !== 'string' || !FINGERPRINT.test(params.fingerprint))
      bad('A SHA256 host key fingerprint is required')
    if (params.acknowledgeChanged !== undefined && typeof params.acknowledgeChanged !== 'boolean')
      bad('acknowledgeChanged must be boolean')
  }
  if (
    [
      'net.ssh.setup.status',
      'net.ssh.setup.cancel',
      'net.ssh.setup.retry',
      'net.ssh.undo',
      'net.ssh.update',
      'net.ssh.rename'
    ].includes(method) &&
    (typeof params.id !== 'string' || !SSH_ID.test(params.id))
  )
    bad('A remote machine record id is required')
  if (['net.ssh.rename', 'net.ssh.approve'].includes(method) && !text(params.endpoint, 253))
    bad('An SSH endpoint is required')
  if (['net.ssh.approve', 'net.ssh.target'].includes(method) && !isId('node', params.node))
    bad('A node identity is required')
}

function validate(method: NetLocalMethod, value: unknown): Record<string, unknown> {
  const params = domainObject(value ?? {}, ['profileId', ...keys[method]])
  if (
    method === 'net.plus.discover' &&
    (typeof params.apiOrigin !== 'string' || params.apiOrigin.length > 4096)
  )
    throw new DomainRpcError('invalid_params', 'A bounded hosted account origin is required')
  if (
    method === 'net.plus.login.begin' &&
    (typeof params.deviceName !== 'string' ||
      !params.deviceName.length ||
      params.deviceName.length > 64 ||
      typeof params.bindRoot !== 'boolean')
  )
    throw new DomainRpcError(
      'invalid_params',
      'A device name and explicit binding selection are required'
    )
  if (
    method === 'net.plus.login.finish' &&
    (typeof params.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(params.id))
  )
    throw new DomainRpcError('invalid_params', 'A pending login identity is required')
  if (
    ['net.plus.enrollment.approve', 'net.plus.enrollment.deny'].includes(method) &&
    (typeof params.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(params.id))
  )
    throw new DomainRpcError('invalid_params', 'An enrollment request identity is required')
  if (
    ['net.plus.login.begin', 'net.plus.configure'].includes(method) &&
    (!params.configuration ||
      typeof params.configuration !== 'object' ||
      Array.isArray(params.configuration))
  )
    throw new DomainRpcError('invalid_params', 'A hosted configuration is required')
  if (
    method === 'net.plus.allow' &&
    (!isId('node', params.node) ||
      !Number.isSafeInteger(params.ttlMs) ||
      Number(params.ttlMs) < 1 ||
      Number(params.ttlMs) > 86400000 ||
      (params.revoke !== undefined && typeof params.revoke !== 'boolean'))
  )
    throw new DomainRpcError('invalid_params', 'A node and bounded route permission are required')
  if (
    ['net.plus.bind', 'net.plus.connect'].includes(method) &&
    (typeof params.accountToken !== 'string' ||
      !params.accountToken.length ||
      params.accountToken.length > 16384 ||
      /[\r\n]/.test(params.accountToken))
  )
    throw new DomainRpcError('invalid_params', 'A bounded account credential is required')
  if (
    method === 'net.plus.bind' &&
    (!params.configuration ||
      typeof params.configuration !== 'object' ||
      Array.isArray(params.configuration))
  )
    throw new DomainRpcError('invalid_params', 'A hosted configuration is required')
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
  if (
    method === 'net.init' &&
    params.host !== undefined &&
    (typeof params.host !== 'string' || !isIP(params.host))
  )
    throw new DomainRpcError('invalid_params', 'Listener host must be an IP address')
  if (
    method === 'net.init' &&
    params.port !== undefined &&
    (!Number.isInteger(params.port) || Number(params.port) < 0 || Number(params.port) > 65535)
  )
    throw new DomainRpcError('invalid_params', 'Listener port must be 0–65535')
  if (
    method === 'net.init' &&
    (params.host !== undefined || params.port !== undefined) &&
    params.listen !== true
  )
    throw new DomainRpcError('invalid_params', 'host and port require listen')
  if (method.startsWith('net.ssh.')) validateSsh(method, params)
  if (params.via !== undefined && (method !== 'bridge.join' || !isJoinVia(params.via)))
    throw new DomainRpcError('invalid_params', 'via must be ws://127.0.0.1:<port>/mousse-net')
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
    [
      'bridge.revoke',
      'bridge.rename',
      'bridge.setCaps',
      'bridge.setKind',
      'bridge.policy',
      'net.editor.probe',
      'net.authority.transfer'
    ].includes(method) &&
    !isId('node', params.node)
  )
    throw new DomainRpcError('invalid_params', 'A node identity is required')
  if (method === 'bridge.setKind' && params.kind !== 'computer' && params.kind !== 'phone')
    throw new DomainRpcError('invalid_params', 'kind must be computer or phone')
  if (method === 'bridge.setCaps' && params.caps === undefined)
    throw new DomainRpcError('invalid_params', 'A capability list is required')
  if (
    method === 'bridge.workOnThreads' &&
    params.enabled !== undefined &&
    typeof params.enabled !== 'boolean'
  )
    throw new DomainRpcError('invalid_params', 'enabled must be boolean')
  if (method === 'bridge.policy') {
    if (
      params.blocked === undefined &&
      params.maxPermissionMode === undefined &&
      params.terminal === undefined &&
      params.editor === undefined
    )
      throw new DomainRpcError('invalid_params', 'Choose a limit to change')
    if (params.blocked !== undefined && typeof params.blocked !== 'boolean')
      throw new DomainRpcError('invalid_params', 'blocked must be boolean')
    if (params.terminal !== undefined && typeof params.terminal !== 'boolean')
      throw new DomainRpcError('invalid_params', 'terminal must be boolean')
    if (params.editor !== undefined && typeof params.editor !== 'boolean')
      throw new DomainRpcError('invalid_params', 'editor must be boolean')
    if (params.maxPermissionMode !== undefined && !isPermissionMode(params.maxPermissionMode))
      throw new DomainRpcError('invalid_params', 'Unknown permission mode')
  }
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
      // Switching a transport off may omit settings: the saved ones are kept.
      (params.settings === undefined
        ? params.enabled !== false
        : !params.settings ||
          typeof params.settings !== 'object' ||
          Array.isArray(params.settings) ||
          Buffer.byteLength(JSON.stringify(params.settings)) > 16 * 1024))
  )
    throw new DomainRpcError('invalid_params', 'A bounded transport configuration is required')
  if (
    method.startsWith('net.transport.action.') &&
    (typeof params.id !== 'string' ||
      !/^[a-z][a-z0-9.-]{0,63}$/.test(params.id) ||
      typeof params.action !== 'string' ||
      !/^[a-z][a-z0-9-]{0,31}$/.test(params.action) ||
      // Undo may leave the settings out and use the stored ones.
      (params.settings === undefined
        ? method !== 'net.transport.action.undo'
        : !params.settings ||
          typeof params.settings !== 'object' ||
          Array.isArray(params.settings) ||
          Buffer.byteLength(JSON.stringify(params.settings)) > 16 * 1024))
  )
    throw new DomainRpcError('invalid_params', 'A bounded add-on action request is required')
  return params
}

/** The service that holds the editor tunnels of one profile's local connections. */
export interface EditorTunnelLocalService {
  editorTunnelRequest(
    method: EditorTunnelLocalMethod,
    params: Record<string, unknown>,
    connection: { id: string; lifetime?: AbortSignal }
  ): unknown | Promise<unknown>
  editorTunnelConnectionClosed(connection: string): void
}
const tunnelKeys: Record<EditorTunnelLocalMethod, readonly string[]> = {
  'net.editor.tunnel.open': ['node'],
  'net.editor.tunnel.read': ['tunnel', 'waitMs'],
  'net.editor.tunnel.write': ['tunnel', 'data'],
  'net.editor.tunnel.end': ['tunnel'],
  'net.editor.tunnel.close': ['tunnel']
}

/**
 * The four methods `mousse-cli net ssh-proxy` uses to carry an editor's SSH over a tunnel. They need the
 * connection (a tunnel belongs to the one that opened it), so they are not part of `registerNetMethods`.
 * A routed call from another computer never gets here: the router only forwards the methods it lists.
 */
export function registerEditorTunnelMethods(
  registry: DomainHandlerRegistry,
  forProfile: (id: string) => EditorTunnelLocalService | Promise<EditorTunnelLocalService>
): void {
  // Weak, so a profile service that was stopped and rebuilt is not kept alive by this list.
  const known = new Set<WeakRef<EditorTunnelLocalService>>()
  registry.onConnectionClosed((id) => {
    for (const ref of [...known]) {
      const service = ref.deref()
      if (service) service.editorTunnelConnectionClosed(id)
      else known.delete(ref)
    }
  })
  // A connection's tunnels also end with its lifetime signal, which aborts when its profile binding changes.
  for (const method of EDITOR_TUNNEL_LOCAL_METHODS)
    registry.register({
      method,
      scope: 'profile',
      capability: NET_LOCAL_CAPABILITY,
      requiredCapabilities: [NET_LOCAL_CAPABILITY],
      validate: (params) => {
        try {
          const value = domainObject(params ?? {}, ['profileId', ...tunnelKeys[method]])
          if (method === 'net.editor.tunnel.open' && !isId('node', value.node))
            throw new DomainRpcError('invalid_params', 'A node identity is required')
          if (method !== 'net.editor.tunnel.open' && typeof value.tunnel !== 'string')
            throw new DomainRpcError('invalid_params', 'A tunnel is required')
          if (
            method === 'net.editor.tunnel.write' &&
            (typeof value.data !== 'string' || value.data.length > 64 * 1024)
          )
            throw new DomainRpcError('invalid_params', 'Bytes are required')
          if (
            method === 'net.editor.tunnel.read' &&
            value.waitMs !== undefined &&
            (!Number.isSafeInteger(value.waitMs) || Number(value.waitMs) < 0)
          )
            throw new DomainRpcError('invalid_params', 'waitMs must be a number of milliseconds')
          return value
        } catch (error) {
          if (error instanceof DomainRpcError) throw publicError('bad_request')
          throw error
        }
      },
      async handle(context, params, binding) {
        const connection = context.connection
        // Only a program of this computer, with the owner's token. A routed call carries the other computer.
        if (!connection || connection.bridgeCaller || connection.clientType === 'bridge')
          throw publicError('forbidden')
        try {
          const service = await forProfile(binding!.profileId)
          if (![...known].some((ref) => ref.deref() === service)) known.add(new WeakRef(service))
          return await service.editorTunnelRequest(method, params, {
            id: connection.id,
            ...(connection.lifetime ? { lifetime: connection.lifetime } : {})
          })
        } catch (error) {
          if (error instanceof NetError) throw publicError(error.code, error)
          throw error
        }
      }
    })
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
