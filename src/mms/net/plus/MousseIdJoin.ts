import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { NetError, type NodeId } from '../../../shared/net'
import type { PlusConfiguration } from '../../../shared/net/local'
import { canonicalJson } from '../sync/codec'
import { rawPublicKey } from '../identity/crypto'
import { checkedPlusConfiguration } from './HostedProfileService'

/** An approved join sign-in: a Mousse ID account grant held only in memory. */
export interface JoinGrant {
  configuration: PlusConfiguration
  accessToken: string
  expiresAt: number
  /** The name this computer signed in with, which it also joins with. */
  deviceName: string
  email?: string
}

/** The computer that owns the account's network and can let this one join it. */
export interface JoinTarget {
  node: NodeId
  name: string
  online: boolean
}

interface InventoryBinding {
  userId?: unknown
  revokedAt?: unknown
  conflict?: unknown
  consentAt?: unknown
  frontier?: { authorityNode?: unknown; nodes?: unknown }
}
interface InventoryRegistration {
  nodeId?: unknown
  userId?: unknown
  kind?: unknown
  online?: unknown
  revokedAt?: unknown
  deviceName?: unknown
}

/**
 * The computer to join from Mousse ID's inventory: the authority of the account's network with the
 * most devices, the oldest one on a tie. Undefined when the account has no network yet.
 */
export function joinTarget(inventory: unknown): JoinTarget | undefined {
  const row = (inventory && typeof inventory === 'object' ? inventory : {}) as {
    bindings?: unknown
    registrations?: unknown
  }
  const bindings = (Array.isArray(row.bindings) ? row.bindings : []) as InventoryBinding[]
  const registrations = (
    Array.isArray(row.registrations) ? row.registrations : []
  ) as InventoryRegistration[]
  const networks = bindings
    .filter((binding) => binding.revokedAt === null && binding.conflict !== true)
    .map((binding) => {
      const authority = binding.frontier?.authorityNode
      const registration = registrations.find(
        (item) =>
          item.nodeId === authority &&
          item.userId === binding.userId &&
          item.revokedAt === null &&
          (item.kind === undefined || item.kind === 'computer')
      )
      return {
        registration,
        devices: Array.isArray(binding.frontier?.nodes) ? binding.frontier.nodes.length : 0,
        since: typeof binding.consentAt === 'number' ? binding.consentAt : Infinity
      }
    })
    .filter((network) => typeof network.registration?.nodeId === 'string')
    .sort((a, b) => b.devices - a.devices || a.since - b.since)
  const chosen = networks[0]?.registration
  if (!chosen) return undefined
  return {
    node: chosen.nodeId as NodeId,
    name: typeof chosen.deviceName === 'string' && chosen.deviceName ? chosen.deviceName : 'your other computer',
    online: chosen.online === true
  }
}

const ID = /^[A-Za-z0-9_-]{1,128}$/

/**
 * Mousse ID calls for a computer that has no network identity yet (contract: join sign-in). The
 * sign-in is proved with a throwaway key held in memory, and the grant it returns may read the
 * account's inventory, ask one of its computers to let this one join, and then bind or register.
 */
export class MousseIdJoin {
  private login?: {
    id: string
    pollToken: string
    verifier: string
    codeChallenge: string
    key: KeyObject
    deviceName: string
    configuration: Omit<PlusConfiguration, 'accountId'>
    expiresAt: number
  }

  constructor(
    private readonly options: {
      signal: AbortSignal
      fetch?: typeof fetch
      now?(): number
    }
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /** The sign-in this computer started, while it can still be approved. */
  pending(id?: string): boolean {
    return !!this.login && this.login.expiresAt > this.now() && (id === undefined || this.login.id === id)
  }

  cancel(): void {
    this.login = undefined
  }

  private async http<T>(
    configuration: Omit<PlusConfiguration, 'accountId'>,
    method: 'GET' | 'POST',
    path: string,
    options: { body?: unknown; bearer?: string; pollToken?: string } = {}
  ): Promise<T> {
    if (this.options.signal.aborted) throw new NetError('cancelled')
    let response: Response
    try {
      response = await (this.options.fetch ?? fetch)(configuration.apiOrigin + path, {
        method,
        headers: {
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
          ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
          ...(options.pollToken ? { 'x-net-poll': options.pollToken } : {})
        },
        ...(method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}),
        redirect: 'error',
        signal: AbortSignal.any([this.options.signal, AbortSignal.timeout(10000)])
      })
    } catch {
      throw new NetError(this.options.signal.aborted ? 'cancelled' : 'route_unreachable')
    }
    const text = await response.text().catch(() => '')
    if (text.length > 128 * 1024) throw new NetError('too_large')
    if (!response.ok) {
      if (path.startsWith('/v1/net/enrollment-requests') && (response.status === 404 || response.status === 410))
        throw new NetError('invite_invalid')
      throw new NetError(
        response.status === 409 ? 'conflict' : response.status === 429 ? 'rate_limited' : 'forbidden'
      )
    }
    try {
      return JSON.parse(text) as T
    } catch {
      throw new NetError('bad_request')
    }
  }

  /** The service's configuration for sign-in, read without a network identity. */
  async discover(apiOrigin: string): Promise<Omit<PlusConfiguration, 'accountId'>> {
    const api = new URL(apiOrigin),
      relay = new URL('/v1/net/relay', api)
    relay.protocol = api.protocol === 'https:' ? 'wss:' : 'ws:'
    const { accountId: _account, ...initial } = checkedPlusConfiguration({
      apiOrigin,
      audience: relay.toString(),
      installationId: 'discovery',
      gatewayId: 'discovery',
      accountId: '00000000-0000-0000-0000-000000000000'
    })
    const config = await this.http<{ installationId: string; gatewayId: string; relayAudience: string }>(
      initial,
      'GET',
      '/v1/net/config'
    )
    const { accountId: _selected, ...selected } = checkedPlusConfiguration({
      ...initial,
      accountId: '00000000-0000-0000-0000-000000000000',
      installationId: config.installationId,
      gatewayId: config.gatewayId,
      audience: config.relayAudience
    })
    return selected
  }

  async begin(
    configuration: Omit<PlusConfiguration, 'accountId'>,
    deviceName: string
  ): Promise<{ id: string; userCode: string; verificationUri: string; expiresAt: number; pollIntervalMs: number }> {
    configuration = (({ accountId: _account, ...rest }) => rest)(
      checkedPlusConfiguration({ ...configuration, accountId: '00000000-0000-0000-0000-000000000000' })
    )
    if (this.pending()) throw new NetError('conflict')
    const config = await this.http<{
      installationId: string
      gatewayId: string
      relayAudience: string
      approvalOrigin?: string
    }>(configuration, 'GET', '/v1/net/config')
    if (
      config.installationId !== configuration.installationId ||
      config.gatewayId !== configuration.gatewayId ||
      config.relayAudience !== configuration.audience
    )
      throw new NetError('forbidden')
    const { privateKey: key } = generateKeyPairSync('ed25519'),
      verifier = randomBytes(32).toString('base64url'),
      codeChallenge = createHash('sha256').update(verifier).digest('base64url'),
      claims = {
        audience: configuration.audience,
        installationId: configuration.installationId,
        signKey: rawPublicKey(key),
        deviceName,
        codeChallenge,
        nonce: randomBytes(32).toString('base64url')
      },
      proof = sign(null, canonicalJson({ domain: 'mousse-plus/native-login/v1', ...claims }), key).toString(
        'base64url'
      )
    const transaction = await this.http<{
      id: string
      pollToken: string
      userCode: string
      verificationUri: string
      expiresAt: number
      pollIntervalMs: number
    }>(configuration, 'POST', '/v1/net/login', { body: { ...claims, proof } })
    const uri = new URL(transaction.verificationUri)
    if (
      !ID.test(transaction.id) ||
      typeof transaction.pollToken !== 'string' ||
      transaction.pollToken.length < 32 ||
      transaction.pollToken.length > 1024 ||
      !Number.isSafeInteger(transaction.expiresAt) ||
      transaction.expiresAt <= this.now() ||
      transaction.expiresAt > this.now() + 15 * 60000 ||
      uri.origin !== (config.approvalOrigin ?? configuration.apiOrigin) ||
      uri.username ||
      uri.password ||
      uri.hash ||
      !Number.isSafeInteger(transaction.pollIntervalMs) ||
      transaction.pollIntervalMs < 1000 ||
      transaction.pollIntervalMs > 30000
    )
      throw new NetError('forbidden')
    this.login = {
      id: transaction.id,
      pollToken: transaction.pollToken,
      verifier,
      codeChallenge,
      key,
      deviceName,
      configuration,
      expiresAt: transaction.expiresAt
    }
    return {
      id: transaction.id,
      userCode: transaction.userCode,
      verificationUri: transaction.verificationUri,
      expiresAt: transaction.expiresAt,
      pollIntervalMs: transaction.pollIntervalMs
    }
  }

  /** The account grant once the browser approved; `peer_offline` until then. */
  async finish(id: string): Promise<JoinGrant> {
    const login = this.login
    if (!login || login.id !== id || login.expiresAt <= this.now()) throw new NetError('forbidden')
    const polled = await this.http<{ status: string }>(login.configuration, 'GET', `/v1/net/login/${id}`, {
      pollToken: login.pollToken
    })
    if (polled.status === 'pending')
      throw new NetError('peer_offline', 'Approve the sign-in in your browser first.')
    if (!['approved', 'exchanged'].includes(polled.status)) {
      this.login = undefined
      throw new NetError('forbidden')
    }
    const proof = sign(
      null,
      canonicalJson({
        domain: 'mousse-plus/native-exchange/v1',
        id,
        audience: login.configuration.audience,
        installationId: login.configuration.installationId,
        codeChallenge: login.codeChallenge
      }),
      login.key
    ).toString('base64url')
    const grant = await this.http<{ accessToken: string; accountId: string; expiresAt: number; email?: unknown }>(
      login.configuration,
      'POST',
      `/v1/net/login/${id}/exchange`,
      { body: { pollToken: login.pollToken, codeVerifier: login.verifier, proof } }
    )
    this.login = undefined
    if (
      typeof grant.accessToken !== 'string' ||
      !grant.accessToken.startsWith('nl_') ||
      grant.accessToken.length > 16384 ||
      !Number.isSafeInteger(grant.expiresAt) ||
      grant.expiresAt <= this.now()
    )
      throw new NetError('forbidden')
    const email =
      typeof grant.email === 'string' && grant.email.length <= 320 && !/[\u0000-\u001f\u007f]/.test(grant.email)
        ? grant.email
        : undefined
    return {
      configuration: checkedPlusConfiguration({ ...login.configuration, accountId: grant.accountId }),
      accessToken: grant.accessToken,
      expiresAt: grant.expiresAt,
      deviceName: login.deviceName,
      ...(email ? { email } : {})
    }
  }

  inventory(grant: JoinGrant): Promise<unknown> {
    return this.http(grant.configuration, 'GET', '/v1/net/inventory', { bearer: grant.accessToken })
  }

  /** Asks `target` to let this computer join; the reply is sealed to `boxPublicKey`. */
  async requestToJoin(
    grant: JoinGrant,
    input: { target: NodeId; deviceName: string; boxPublicKey: string; transportFingerprint: string }
  ): Promise<{ id: string; expiresAt: number }> {
    const created = await this.http<{ id?: unknown; expiresAt?: unknown }>(
      grant.configuration,
      'POST',
      '/v1/net/enrollment-requests',
      {
        bearer: grant.accessToken,
        body: {
          targetNodeId: input.target,
          deviceName: input.deviceName,
          kind: 'computer',
          boxPublicKey: input.boxPublicKey,
          transportFingerprint: input.transportFingerprint
        }
      }
    )
    if (typeof created.id !== 'string' || !ID.test(created.id) || !Number.isSafeInteger(created.expiresAt))
      throw new NetError('bad_request')
    return { id: created.id, expiresAt: created.expiresAt as number }
  }

  /** The sealed invite once the target approved; undefined while it has not decided. */
  async readRequest(grant: JoinGrant, id: string): Promise<string | undefined> {
    const row = await this.http<{ status?: unknown; sealedInvite?: unknown }>(
      grant.configuration,
      'GET',
      `/v1/net/enrollment-requests/${id}`,
      { bearer: grant.accessToken }
    )
    if (row.status === 'pending') return undefined
    if ((row.status === 'approved' || row.status === 'delivered') && typeof row.sealedInvite === 'string')
      return row.sealedInvite
    throw new NetError('invite_invalid')
  }
}
