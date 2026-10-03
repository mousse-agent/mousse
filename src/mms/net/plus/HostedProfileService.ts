import { createHash, randomUUID, randomBytes } from 'node:crypto'
import type { FileKeyStore } from '../identity/FileKeyStore'
import { NetError, type Signed, type NodeId, type UserId } from '../../../shared/net'
import { canonicalJson } from '../sync/codec'
import { canonicalAudience } from './wire/protocol'
import type {
  PlusConfiguration,
  PlusStatus,
  ChallengeStatement,
  RegistrationResult
} from './contracts'
const SECRET = 'plus/connector'
interface Stored {
  configuration: PlusConfiguration
  registration?: RegistrationResult['registration']
  connectorToken?: string
  deferredRoute?: Stored['pending']
  managedSpaceRoutes?: Record<string, { user: UserId; expiresAt: number }>
  pending?: {
    ticket?: string
    purpose: ChallengeStatement['purpose']
    intent: unknown
    body: Record<string, unknown>
  }
}
export interface HostedProfileOptions {
  keys: FileKeyStore
  identity(): {
    user: UserId
    node: NodeId
    isAuthority: boolean
    rootKey: string
    roster: Signed
    delegation: Signed
  }
  signal: AbortSignal
  fetch?: typeof fetch
  now?(): number
}
export function checkedPlusConfiguration(input: PlusConfiguration): PlusConfiguration {
  let api: URL
  try {
    api = new URL(input.apiOrigin)
  } catch {
    throw new NetError('bad_request')
  }
  if (
    api.pathname !== '/' ||
    api.search ||
    api.hash ||
    api.username ||
    api.password ||
    !['http:', 'https:'].includes(api.protocol) ||
    (api.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname))
  )
    throw new NetError('bad_request')
  if (
    Object.keys(input).sort().join(',') !==
      'accountId,apiOrigin,audience,gatewayId,installationId' ||
    ['accountId', 'gatewayId', 'installationId'].some(
      (key) =>
        typeof input[key as keyof PlusConfiguration] !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(input[key as keyof PlusConfiguration])
    )
  )
    throw new NetError('bad_request')
  const audience = canonicalAudience(input.audience)
  const relay = new URL(audience)
  if (api.protocol === 'https:' && relay.protocol !== 'wss:')
    throw new NetError('bad_request', 'Hosted production relay requires outer TLS.')
  return { ...input, apiOrigin: api.origin, audience }
}
/** All secrets stay in a protected profile keystore. Account bearer is one-shot input only. */
export class HostedProfileService {
  constructor(private readonly options: HostedProfileOptions) {
    options.signal.addEventListener(
      'abort',
      () => {
        this.login = undefined
      },
      { once: true }
    )
  }
  private login?: {
    id: string
    pollToken: string
    verifier: string
    codeChallenge: string
    configuration: Omit<PlusConfiguration, 'accountId'>
    approvalOrigin: string
    expiresAt: number
    bindRoot: boolean
  }
  private async loginHttp<T>(
    configuration: Omit<PlusConfiguration, 'accountId'>,
    path: string,
    body?: unknown,
    pollToken?: string
  ): Promise<T> {
    this.guard()
    let response: Response
    try {
      response = await (this.options.fetch ?? fetch)(configuration.apiOrigin + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(pollToken ? { 'x-net-poll': pollToken } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.any([this.options.signal, AbortSignal.timeout(10000)])
      })
    } catch {
      throw new NetError(this.options.signal.aborted ? 'cancelled' : 'route_unreachable')
    }
    const reader = response.body?.getReader(),
      parts: Uint8Array[] = []
    let size = 0
    if (reader)
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.length
          if (size > 128 * 1024) {
            await reader.cancel()
            throw new NetError('too_large')
          }
          parts.push(value)
        }
      } finally {
        reader.releaseLock()
      }
    this.guard()
    if (!response.ok) throw new NetError('forbidden')
    try {
      return JSON.parse(Buffer.concat(parts).toString('utf8')) as T
    } catch {
      throw new NetError('bad_request')
    }
  }
  async discover(apiOrigin: string): Promise<Omit<PlusConfiguration, 'accountId'>> {
    const api = new URL(apiOrigin),
      relay = new URL('/v1/net/relay', api)
    relay.protocol = api.protocol === 'https:' ? 'wss:' : 'ws:'
    const initial = checkedPlusConfiguration({
      apiOrigin,
      audience: relay.toString(),
      installationId: 'discovery',
      gatewayId: 'discovery',
      accountId: '00000000-0000-0000-0000-000000000000'
    })
    const config = await this.loginHttp<{
      installationId: string
      gatewayId: string
      relayAudience: string
    }>(initial, '/v1/net/config')
    const { accountId: _account, ...selected } = checkedPlusConfiguration({
      ...initial,
      installationId: config.installationId,
      gatewayId: config.gatewayId,
      audience: config.relayAudience
    })
    return selected
  }
  async beginLogin(
    configuration: Omit<PlusConfiguration, 'accountId'>,
    deviceName: string,
    bindRoot: boolean
  ): Promise<{
    id: string
    userCode: string
    verificationUri: string
    expiresAt: number
    pollIntervalMs: number
  }> {
    this.guard()
    configuration = (({ accountId: _account, ...rest }) => rest)(
      checkedPlusConfiguration({
        ...configuration,
        accountId: '00000000-0000-0000-0000-000000000000'
      })
    )
    const identity = this.options.identity()
    if (bindRoot && (!identity.isAuthority || this.options.keys.rootKey() !== identity.rootKey))
      throw new NetError('forbidden')
    if (this.login && this.login.expiresAt > this.now()) throw new NetError('conflict')
    const config = await this.loginHttp<{
      installationId: string
      gatewayId: string
      relayAudience: string
      approvalOrigin?: string
    }>(configuration, '/v1/net/config')
    if (
      config.installationId !== configuration.installationId ||
      config.gatewayId !== configuration.gatewayId ||
      config.relayAudience !== configuration.audience
    )
      throw new NetError('forbidden')
    const verifier = randomBytes(32).toString('base64url'),
      codeChallenge = createHash('sha256').update(verifier).digest('base64url')
    const claims = {
      audience: configuration.audience,
      installationId: configuration.installationId,
      userId: identity.user,
      rootKey: identity.rootKey,
      nodeId: identity.node,
      signKey: this.options.keys.nodeKeys().sign,
      deviceName,
      codeChallenge,
      nonce: randomBytes(32).toString('base64url')
    }
    const proof = Buffer.from(
      this.options.keys.signAsNode(
        canonicalJson({ domain: 'mousse-plus/native-login/v1', ...claims })
      )
    ).toString('base64url')
    const transaction = await this.loginHttp<{
      id: string
      pollToken: string
      userCode: string
      verificationUri: string
      expiresAt: number
      pollIntervalMs: number
    }>(configuration, '/v1/net/login', { ...claims, proof })
    const uri = new URL(transaction.verificationUri)
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(transaction.id) ||
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
      !['http:', 'https:'].includes(uri.protocol) ||
      (uri.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(uri.hostname)) ||
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
      configuration,
      approvalOrigin: config.approvalOrigin ?? configuration.apiOrigin,
      expiresAt: transaction.expiresAt,
      bindRoot
    }
    return {
      id: transaction.id,
      userCode: transaction.userCode,
      verificationUri: transaction.verificationUri,
      expiresAt: transaction.expiresAt,
      pollIntervalMs: transaction.pollIntervalMs
    }
  }
  async finishLogin(id: string): Promise<PlusStatus> {
    const transaction = this.login
    if (!transaction || transaction.id !== id || transaction.expiresAt <= this.now())
      throw new NetError('forbidden')
    this.guard()
    const polled = await this.loginHttp<{ status: string }>(
      transaction.configuration,
      `/v1/net/login/${id}`,
      undefined,
      transaction.pollToken
    )
    if (polled.status === 'pending')
      throw new NetError('peer_offline', 'Approve the sign-in in your browser first.')
    if (!['approved', 'exchanged'].includes(polled.status)) {
      this.login = undefined
      throw new NetError('forbidden')
    }
    const proof = Buffer.from(
      this.options.keys.signAsNode(
        canonicalJson({
          domain: 'mousse-plus/native-exchange/v1',
          id,
          audience: transaction.configuration.audience,
          installationId: transaction.configuration.installationId,
          codeChallenge: transaction.codeChallenge
        })
      )
    ).toString('base64url')
    const grant = await this.loginHttp<{
      accessToken: string
      accountId: string
      expiresAt: number
    }>(transaction.configuration, `/v1/net/login/${id}/exchange`, {
      pollToken: transaction.pollToken,
      codeVerifier: transaction.verifier,
      proof
    })
    this.login = undefined
    if (
      typeof grant.accessToken !== 'string' ||
      !grant.accessToken.startsWith('nl_') ||
      grant.accessToken.length > 16384 ||
      !Number.isSafeInteger(grant.expiresAt) ||
      grant.expiresAt <= this.now()
    )
      throw new NetError('forbidden')
    const selected = { ...transaction.configuration, accountId: grant.accountId }
    if (transaction.bindRoot) await this.bind(selected, grant.accessToken)
    else this.configure(selected)
    return this.connect(grant.accessToken)
  }
  private guard(): void {
    if (this.options.signal.aborted) throw new NetError('cancelled')
    if (this.options.keys.state() !== 'unlocked' || !this.options.keys.encryptedAtRest())
      throw new NetError('keystore_locked')
  }
  private read(): Stored | undefined {
    this.guard()
    const bytes = this.options.keys.getSecret(SECRET)
    if (!bytes) return
    try {
      return JSON.parse(Buffer.from(bytes).toString()) as Stored
    } catch {
      throw new NetError('storage_corrupt')
    }
  }
  private save(stored: Stored): void {
    this.guard()
    this.options.keys.putSecret(SECRET, canonicalJson(stored))
  }
  status(): PlusStatus {
    const stored = this.read()
    return stored
      ? {
          configured: true,
          connected: !!stored.registration && stored.registration.expiresAt > this.now(),
          accountId: stored.configuration.accountId,
          audience: stored.configuration.audience,
          ...(stored.registration
            ? {
                registrationId: stored.registration.id,
                generation: stored.registration.generation,
                expiresAt: stored.registration.expiresAt
              }
            : {})
        }
      : { configured: false, connected: false }
  }
  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
  private async post<T>(
    configuration: PlusConfiguration,
    path: string,
    token: string,
    body: unknown
  ): Promise<T> {
    this.guard()
    if (!token || token.length > 16384 || /[\r\n]/.test(token)) throw new NetError('bad_request')
    let response: Response
    try {
      response = await (this.options.fetch ?? fetch)(configuration.apiOrigin + path, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([this.options.signal, AbortSignal.timeout(10000)]),
        redirect: 'error'
      })
    } catch {
      throw new NetError(this.options.signal.aborted ? 'cancelled' : 'outcome_uncertain')
    }
    this.guard()
    const reader = response.body?.getReader(),
      parts: Uint8Array[] = []
    let size = 0
    if (reader)
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.length
          if (size > 128 * 1024) {
            await reader.cancel()
            throw new NetError('too_large')
          }
          parts.push(value)
        }
      } finally {
        reader.releaseLock()
      }
    this.guard()
    const text = Buffer.concat(parts).toString('utf8')
    if (!response.ok)
      throw new NetError(
        response.status === 401 || response.status === 403
          ? 'forbidden'
          : response.status === 409
            ? 'conflict'
            : 'route_unreachable'
      )
    try {
      return JSON.parse(text) as T
    } catch {
      throw new NetError('bad_request')
    }
  }
  private async signed(
    configuration: PlusConfiguration,
    purpose: ChallengeStatement['purpose'],
    intent: unknown,
    token: string
  ): Promise<Record<string, unknown>> {
    const identity = this.options.identity(),
      operationId = randomUUID()
    if (
      purpose === 'bind' &&
      (!identity.isAuthority || this.options.keys.rootKey() !== identity.rootKey)
    )
      throw new NetError(
        'forbidden',
        'Account binding requires this profile’s unlocked root authority.'
      )
    const statement = await this.post<ChallengeStatement>(
      configuration,
      '/v1/net/challenges',
      token,
      {
        operationId,
        purpose,
        userId: identity.user,
        rootKey: identity.rootKey,
        ...(purpose === 'bind' ? {} : { nodeId: identity.node }),
        intent,
        ...(['renew', 'route', 'rendezvous'].includes(purpose) && this.read()?.registration
          ? { registrationId: this.read()!.registration!.id }
          : {})
      }
    )
    const keys = [
      'v',
      'domain',
      'installationId',
      'audience',
      'challengeId',
      'nonce',
      'accountId',
      'userId',
      'rootKey',
      'nodeId',
      'purpose',
      'operationId',
      'intentHash',
      'issuedAt',
      'expiresAt'
    ]
    if (
      Object.keys(statement).some((key) => !keys.includes(key)) ||
      keys.some((key) => !Object.hasOwn(statement, key)) ||
      statement.v !== 1 ||
      statement.domain !== 'mousse-plus/net-control/v1' ||
      statement.installationId !== configuration.installationId ||
      statement.audience !== configuration.audience ||
      statement.accountId !== configuration.accountId ||
      statement.userId !== identity.user ||
      statement.rootKey !== identity.rootKey ||
      statement.nodeId !== (purpose === 'bind' ? null : identity.node) ||
      statement.purpose !== purpose ||
      statement.operationId !== operationId ||
      statement.intentHash !==
        createHash('sha256').update(canonicalJson(intent)).digest('base64url') ||
      !Number.isSafeInteger(statement.issuedAt) ||
      !Number.isSafeInteger(statement.expiresAt) ||
      statement.issuedAt > this.now() + 30000 ||
      statement.expiresAt <= this.now() ||
      statement.expiresAt - statement.issuedAt > 5 * 60000 ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(statement.challengeId) ||
      !/^[A-Za-z0-9_-]{43}$/.test(statement.nonce)
    )
      throw new NetError(
        'forbidden',
        'The hosted challenge does not match the selected account, service, identity and intent.'
      )
    this.guard()
    const proof = Buffer.from(
      purpose === 'bind'
        ? this.options.keys.signAsRoot(canonicalJson(statement))
        : this.options.keys.signAsNode(canonicalJson(statement))
    ).toString('base64url')
    return {
      operationId,
      challengeId: statement.challengeId,
      proof,
      ...(intent as Record<string, unknown>)
    }
  }
  async bind(configuration: PlusConfiguration, accountToken: string): Promise<PlusStatus> {
    configuration = checkedPlusConfiguration(configuration)
    const prior = this.read()
    if (
      prior &&
      !Buffer.from(canonicalJson(prior.configuration)).equals(canonicalJson(configuration))
    )
      throw new NetError('conflict', 'Disconnect the selected hosted account before changing it.')
    const intent = { roster: this.options.identity().roster }
    const stored: Stored = prior ?? { configuration }
    const body =
      stored.pending?.purpose === 'bind'
        ? stored.pending.body
        : await this.signed(configuration, 'bind', intent, accountToken)
    if (stored.pending && stored.pending.purpose !== 'bind') throw new NetError('outcome_uncertain')
    stored.pending = { purpose: 'bind', intent, body }
    this.save(stored)
    await this.post(configuration, '/v1/net/bindings', accountToken, body)
    delete stored.pending
    this.save(stored)
    return this.status()
  }
  async connect(accountToken: string): Promise<PlusStatus> {
    const stored = this.read()
    if (!stored) throw new NetError('not_enrolled')
    if (stored.pending && stored.pending.purpose !== 'register')
      throw new NetError('outcome_uncertain')
    const identity = this.options.identity(),
      intent = {
        roster: identity.roster,
        delegation: identity.delegation,
        connectorId: randomUUID(),
        gatewayId: stored.configuration.gatewayId
      }
    const body =
      stored.pending?.body ??
      (await this.signed(stored.configuration, 'register', intent, accountToken))
    stored.pending = { purpose: 'register', intent, body }
    this.save(stored)
    const result = await this.post<RegistrationResult>(
      stored.configuration,
      '/v1/net/registrations',
      accountToken,
      body
    )
    if (
      result.relayAudience !== stored.configuration.audience ||
      result.registration.accountId !== stored.configuration.accountId ||
      result.registration.userId !== identity.user ||
      result.registration.nodeId !== identity.node ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(result.registration.id) ||
      !Number.isSafeInteger(result.registration.generation) ||
      result.registration.generation < 1 ||
      !Number.isSafeInteger(result.registration.expiresAt) ||
      result.registration.expiresAt <= this.now() ||
      typeof result.connectorToken !== 'string' ||
      result.connectorToken.length < 32 ||
      result.connectorToken.length > 16384
    )
      throw new NetError('forbidden')
    stored.registration = result.registration
    stored.connectorToken = result.connectorToken
    delete stored.pending
    this.save(stored)
    return this.status()
  }
  async renew(): Promise<PlusStatus> {
    const stored = this.read()
    if (!stored?.registration || !stored.connectorToken) throw new NetError('not_enrolled')
    if (stored.pending?.purpose === 'route') {
      stored.deferredRoute ??= stored.pending
      delete stored.pending
      this.save(stored)
    }
    if (stored.pending && stored.pending.purpose !== 'renew')
      throw new NetError('outcome_uncertain')
    const identity = this.options.identity(),
      intent = {
        registrationId: stored.registration.id,
        generation: stored.registration.generation,
        roster: identity.roster,
        delegation: identity.delegation
      }
    const body =
      stored.pending?.body ??
      (await this.signed(stored.configuration, 'renew', intent, stored.connectorToken))
    stored.pending = { purpose: 'renew', intent, body }
    this.save(stored)
    const registration = await this.post<RegistrationResult['registration']>(
      stored.configuration,
      `/v1/net/registrations/${stored.registration.id}/renew`,
      stored.connectorToken,
      { ...body, connectorToken: stored.connectorToken }
    )
    if (
      registration.id !== stored.registration.id ||
      !Number.isSafeInteger(registration.generation) ||
      registration.generation < stored.registration.generation ||
      registration.generation > stored.registration.generation + 1 ||
      registration.accountId !== stored.configuration.accountId ||
      registration.userId !== identity.user ||
      registration.nodeId !== identity.node ||
      !Number.isSafeInteger(registration.expiresAt) ||
      registration.expiresAt <= this.now()
    )
      throw new NetError('forbidden')
    stored.registration = registration
    delete stored.pending
    if (
      stored.deferredRoute &&
      (stored.deferredRoute.intent as { generation: number; expiresAt: number }).generation ===
        registration.generation &&
      (stored.deferredRoute.intent as { expiresAt: number }).expiresAt > this.now()
    )
      stored.pending = stored.deferredRoute
    delete stored.deferredRoute
    this.save(stored)
    return this.status()
  }
  configure(configuration: PlusConfiguration): PlusStatus {
    configuration = checkedPlusConfiguration(configuration)
    const prior = this.read()
    if (
      prior &&
      !Buffer.from(canonicalJson(prior.configuration)).equals(canonicalJson(configuration))
    )
      throw new NetError('conflict')
    if (!prior) this.save({ configuration })
    return this.status()
  }
  async rendezvous(
    expiresAt: number,
    purpose: 'enrollment' | 'space'
  ): Promise<{ transport: 'plus-relay'; relay: string; ticket: string; expiresAt: number }> {
    const stored = this.read()
    if (!stored?.registration || !stored.connectorToken) throw new NetError('not_enrolled')
    if (stored.pending && stored.pending.purpose !== 'rendezvous')
      throw new NetError('outcome_uncertain')
    if (stored.pending && (stored.pending.intent as { purpose?: string }).purpose !== purpose)
      throw new NetError('outcome_uncertain')
    const ticket = stored.pending?.ticket ?? randomBytes(32).toString('base64url'),
      intent = stored.pending?.intent ?? {
        registrationId: stored.registration.id,
        generation: stored.registration.generation,
                ticketHash: createHash('sha256')
          .update(Buffer.from(ticket, 'base64url'))
          .digest('base64url'),
        expiresAt,
        recoveryUntil: expiresAt,
        purpose
      }
    const body =
      stored.pending?.body ??
      (await this.signed(stored.configuration, 'rendezvous', intent, stored.connectorToken))
    stored.pending = { purpose: 'rendezvous', intent, body, ticket }
    this.save(stored)
    await this.post(stored.configuration, '/v1/net/rendezvous', stored.connectorToken, {
      ...body,
      connectorToken: stored.connectorToken
    })
    delete stored.pending
    this.save(stored)
    return {
      transport: 'plus-relay',
      relay: stored.configuration.audience,
      ticket,
      expiresAt: Number((intent as { expiresAt: number }).expiresAt)
    }
  }
  async allow(source: NodeId, ttlMs: number, revoke = false): Promise<void> {
    const stored = this.read()
    if (!stored?.registration || !stored.connectorToken) throw new NetError('not_enrolled')
    if (stored.pending && stored.pending.purpose !== 'route')
      throw new NetError('outcome_uncertain')
    const intent = stored.pending?.intent ?? {
      registrationId: stored.registration.id,
      generation: stored.registration.generation,
      source,
      expiresAt: this.now() + ttlMs,
      revoke
    }
    const body =
      stored.pending?.body ??
      (await this.signed(stored.configuration, 'route', intent, stored.connectorToken))
    stored.pending = { purpose: 'route', intent, body }
    this.save(stored)
    await this.post(stored.configuration, '/v1/net/routes', stored.connectorToken, {
      ...body,
      connectorToken: stored.connectorToken
    })
    delete stored.pending
    this.save(stored)
  }
  managedSpaceRoutes(): Array<{ node: NodeId; user: UserId; expiresAt: number }> {
    const stored = this.read()
    return Object.entries(stored?.managedSpaceRoutes ?? {}).map(([node, row]) => ({
      node: node as NodeId,
      ...row
    }))
  }
  rememberSpaceRoute(node: NodeId, user: UserId): void {
    const stored = this.read()
    if (!stored?.registration) throw new NetError('not_enrolled')
    stored.managedSpaceRoutes ??= {}
    if (!stored.managedSpaceRoutes[node] && Object.keys(stored.managedSpaceRoutes).length >= 128)
      throw new NetError('too_large')
    stored.managedSpaceRoutes[node] ??= { user, expiresAt: 0 }
    if (stored.managedSpaceRoutes[node].user !== user) throw new NetError('conflict')
    this.save(stored)
  }
  async reconcileSpaceRoutes(authorized: (user: UserId, node: NodeId) => boolean): Promise<void> {
    const pending = this.read()?.pending
    if (pending?.purpose === 'route') {
      const original = pending.intent as { source: NodeId; expiresAt: number; revoke: boolean }
      await this.allow(
        original.source,
        Math.max(1, original.expiresAt - this.now()),
        original.revoke
      )
    }
    for (const row of this.managedSpaceRoutes()) {
      const allowed = authorized(row.user, row.node)
      if (allowed && row.expiresAt > this.now() + 60000) continue
      await this.allow(row.node, 120000, !allowed)
      const stored = this.read()!
      if (allowed) stored.managedSpaceRoutes![row.node].expiresAt = this.now() + 120000
      else delete stored.managedSpaceRoutes![row.node]
      this.save(stored)
    }
  }
  async revoke(): Promise<void> {
    const stored = this.read()
    if (!stored?.registration || !stored.connectorToken) return
    await this.post(
      stored.configuration,
      `/v1/net/registrations/${stored.registration.id}/revoke`,
      stored.connectorToken,
      { generation: stored.registration.generation }
    )
    this.clear()
  }
  registration(audience: string): { registrationId: string; generation: number } {
    const stored = this.read()
    if (
      !stored?.registration ||
      stored.configuration.audience !== canonicalAudience(audience) ||
      stored.registration.expiresAt <= this.now()
    )
      throw new NetError('forbidden')
    return { registrationId: stored.registration.id, generation: stored.registration.generation }
  }
  configuration(): PlusConfiguration | undefined {
    return this.read()?.configuration
  }
  clear(): void {
    this.guard()
    this.options.keys.deleteSecret(SECRET)
  }
}
