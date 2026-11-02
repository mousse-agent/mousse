import { generateKeyPairSync, randomBytes } from 'node:crypto'
import type { NodeId, UserId } from '../../../shared/net'
import { NetError } from '../../../shared/net'
import type { NetLocalMethod, PlusConfiguration, PlusStatus } from '../../../shared/net/local'
import type { HostedNet, HostedNetHost, HostedNetModule, HostedRelayTransports } from '../hosted'
import { hostedNotConfigured } from '../hosted'
import type { RelayRendezvous } from '../relay/protocol'
import { HostedProfileService, type PlusEnrollmentRequest } from './HostedProfileService'
import {
  enrollmentJoinUrl,
  enrollmentMatchCode,
  openRequestSeal,
  sealInviteForOffer,
  sealInviteForRequest
} from './enrollmentSeal'
import { joinTarget, MousseIdJoin, type JoinGrant } from './MousseIdJoin'
import { rawPublicKey } from '../identity/crypto'
import { createHostedRelayTransports } from './relayTransports'
import { DEFAULT_DIRECT_PATH, type DirectPathConfig } from '../transports/phoneWebRtc'

/**
 * The longest wait between registration renewals. A registration lasts 10 minutes (60 seconds on
 * older Mousse ID) and is renewed at a third of the time left, so it always outlasts the relay's
 * next admission renewal.
 */
const RENEW_MAX_MS = 5 * 60_000

/** The shortest wait a Space-peer route can impose between renewal passes, so a failing pass cannot spin. */
const RENEW_MIN_MS = 20_000

/**
 * Space-peer route approvals last 2 minutes and are refreshed once less than a minute is left, but
 * only by the renewal pass. This is how long before an approval gets that low the next pass must run.
 */
const ROUTE_REFRESH_LEAD_MS = 60_000

/**
 * How long to wait before the next renewal pass: a third of the registration lease (at most
 * RENEW_MAX_MS), or sooner when a Space-peer route approval needs refreshing first. A computer
 * without a lease passes every 20 seconds.
 */
export function renewalDelayMs(
  leaseExpiresAt: number | undefined,
  routes: ReadonlyArray<{ expiresAt: number }>,
  now: number
): number {
  let delay =
    leaseExpiresAt === undefined
      ? RENEW_MIN_MS
      : Math.min(RENEW_MAX_MS, Math.max(1000, (leaseExpiresAt - now) / 3))
  for (const route of routes)
    delay = Math.min(delay, Math.max(RENEW_MIN_MS, route.expiresAt - ROUTE_REFRESH_LEAD_MS - now))
  return delay
}

/** How often a signed-in authority checks Mousse ID for phones asking to join. */
const PLUS_ENROLLMENT_POLL_MS = 15000
/** How often a joining computer asks Mousse ID whether its request was approved. */
const JOIN_POLL_MS = 2000
/** How often a signed-in computer reads Mousse ID's direct-path configuration again. */
const DIRECT_PATH_REFRESH_MS = 10 * 60_000

/** The Mousse ID module: account sign-in, the hosted relay lease and phone enrollment. */
export const mousseIdNetModule: HostedNetModule = {
  create: (host) => new HostedNetController(host)
}

interface JoinRun {
  id: string
  settled: boolean
  status?: PlusStatus
  error?: unknown
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new NetError('cancelled'))
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop)
      resolve()
    }, ms)
    const stop = () => {
      clearTimeout(timer)
      reject(new NetError('cancelled'))
    }
    signal.addEventListener('abort', stop, { once: true })
  })
}

export class HostedNetController implements HostedNet {
  readonly transports: HostedRelayTransports
  private hostedProfile?: HostedProfileService
  private hostedConsentFenced = false
  private plusAbortBound = false
  private plusRenewal?: ReturnType<typeof setTimeout>
  private plusRenewalDueAt = 0
  private enrollmentList: PlusEnrollmentRequest[] = []
  private enrollmentPoll?: ReturnType<typeof setTimeout>
  private enrollmentAbortBound = false
  /** Computer requests already approved (or tried) once; a failed one is not retried every poll. */
  private computerRequestsTried = new Set<string>()
  private direct: DirectPathConfig = DEFAULT_DIRECT_PATH
  private directReadAt?: number
  private joinClient?: MousseIdJoin
  /** The join sign-in whose approval arrived: joining runs in the background while `finish` is polled. */
  private joining?: JoinRun

  constructor(private readonly host: HostedNetHost) {
    this.transports = createHostedRelayTransports(() => this.service())
  }

  status(): PlusStatus {
    const state = this.host.loadedRuntime()
    return !this.host.signal.aborted &&
      state &&
      state.identity.self() &&
      state.keys.state() === 'unlocked' &&
      state.keys.encryptedAtRest()
      ? this.service().status()
      : hostedNotConfigured()
  }

  connected(): boolean {
    return this.service().status().connected
  }

  directPath(): DirectPathConfig {
    return this.direct
  }

  /**
   * Reads Mousse ID's direct-path configuration (the WebRTC kill switch and STUN servers) when
   * it is older than ten minutes or `force` is set. An unreachable service keeps the last value.
   */
  private async refreshDirectPath(force = false): Promise<void> {
    const now = this.host.clock.monotonic()
    if (
      !force &&
      this.directReadAt !== undefined &&
      now - this.directReadAt < DIRECT_PATH_REFRESH_MS
    )
      return
    let next: DirectPathConfig
    try {
      next = await this.service().directPath()
    } catch {
      return
    }
    this.directReadAt = now
    if (next.webrtc === this.direct.webrtc && next.stun.join(' ') === this.direct.stun.join(' '))
      return
    this.direct = next
    this.host.directPathChanged()
  }

  consentFenced(): boolean {
    return this.hostedConsentFenced
  }

  cancelLogin(): { cancelled: true } {
    this.hostedProfile?.cancelLogin()
    this.joinClient?.cancel()
    return { cancelled: true }
  }

  private join(): MousseIdJoin {
    return (this.joinClient ??= new MousseIdJoin({
      signal: this.host.signal,
      now: () => this.host.clock.now()
    }))
  }

  handlesJoin(id: string): boolean {
    return this.joining?.id === id || !!this.joinClient?.pending(id)
  }

  /**
   * Sign-in on a computer with no network identity. Approval in the browser is the only step:
   * the computer then joins the account's existing network (its owner adds it without a code),
   * or, on an account with no computers yet, creates the network.
   */
  async joinSignIn(method: NetLocalMethod, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'net.plus.discover':
        return this.join().discover(String(params.apiOrigin))
      case 'net.plus.login.begin':
        this.joining = undefined
        return this.join().begin(
          params.configuration as Omit<PlusConfiguration, 'accountId'>,
          String(params.deviceName)
        )
      case 'net.plus.login.finish': {
        const id = String(params.id),
          running = this.joining
        if (running?.id !== id) {
          const entry: JoinRun = { id, settled: false }
          const grant = await this.join().finish(id)
          this.joining = entry
          void this.completeJoin(grant)
            .then(
              (status) => {
                entry.status = status
              },
              (error) => {
                entry.error = error
              }
            )
            .finally(() => {
              entry.settled = true
              this.host.emit()
            })
        } else if (running.settled) {
          this.joining = undefined
          if (running.error) throw running.error
          return running.status
        }
        throw new NetError('peer_offline', 'Adding this computer to your devices.')
      }
      default:
        throw new NetError('bad_request')
    }
  }

  private async completeJoin(grant: JoinGrant): Promise<PlusStatus> {
    const client = this.join(),
      deviceName = grant.deviceName,
      target = joinTarget(await client.inventory(grant)),
      account = grant.email ? { email: grant.email } : {}
    if (target) {
      if (!target.online) throw new NetError('authority_offline')
      const { transportFingerprint } = await this.host.serial(() => this.host.prepareJoin())
      const box = generateKeyPairSync('x25519').privateKey,
        request = await client.requestToJoin(grant, {
          target: target.node,
          deviceName,
          boxPublicKey: rawPublicKey(box),
          transportFingerprint
        })
      let sealed: string | undefined
      while (!(sealed = await client.readRequest(grant, request.id))) {
        if (this.host.clock.now() + JOIN_POLL_MS >= Math.min(request.expiresAt, grant.expiresAt))
          throw new NetError('authority_offline')
        await abortableDelay(JOIN_POLL_MS, this.host.signal)
      }
      const invite = openRequestSeal(
        sealed,
        box.export({ type: 'pkcs8', format: 'der' }).subarray(-32),
        request.id
      )
      await this.host.serial(() => this.host.joinWithInvite(invite, deviceName))
    } else await this.host.serial(() => this.host.createIdentity(deviceName))
    return this.host.serial(async () => {
      this.assertTransportCapacity()
      const status = await this.service().useGrant(grant.configuration, grant.accessToken, !target, account)
      await this.useHostedRelay()
      return status
    })
  }

  async request(method: NetLocalMethod, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'net.plus.discover':
        return this.service().discover(String(params.apiOrigin))
      case 'net.plus.login.begin':
        return this.service().beginLogin(
          params.configuration as Omit<PlusConfiguration, 'accountId'>,
          String(params.deviceName),
          params.bindRoot === true
        )
      case 'net.plus.configure':
        return this.service().configure(params.configuration as PlusConfiguration)
      case 'net.plus.login.finish': {
        this.assertTransportCapacity()
        const status = await this.service().finishLogin(String(params.id))
        await this.useHostedRelay()
        return status
      }
      case 'net.plus.renew': {
        await this.fenceUnauthorizedSpaceRoutes()
        const status = await this.service().renew()
        await this.reconcileSpaceRoutes()
        await this.host.restartTransports()
        this.armRenewal()
        return status
      }
      case 'net.plus.allow':
        await this.service().allow(
          params.node as NodeId,
          Number(params.ttlMs),
          params.revoke === true
        )
        return { approved: params.revoke !== true }
      case 'net.plus.bind':
        return this.service().bind(
          params.configuration as PlusConfiguration,
          String(params.accountToken)
        )
      case 'net.plus.connect': {
        this.assertTransportCapacity()
        const status = await this.service().connect(String(params.accountToken))
        await this.useHostedRelay()
        return status
      }
      case 'net.plus.disconnect': {
        this.host.saveHostedTransport(undefined)
        await this.host.activate()
        if (this.plusRenewal) clearTimeout(this.plusRenewal)
        this.plusRenewal = undefined
        this.stopEnrollmentPoll()
        // The relay lease expires on its own; a backend that no longer knows it
        // must not stop this computer from signing out.
        await this.service()
          .revoke()
          .catch(() => undefined)
        this.service().clear()
        return hostedNotConfigured()
      }
      case 'net.plus.enrollment.approve': {
        const id = String(params.id),
          request =
            this.enrollmentList.find((row) => row.id === id) ??
            (await this.refreshEnrollmentRequests()).find((row) => row.id === id)
        if (!request || request.expiresAt <= this.host.clock.now())
          throw new NetError('invite_invalid', 'This phone request has expired or was withdrawn.')
        const invite = await this.approveRequest(request)
        this.setEnrollmentRequests(this.enrollmentList.filter((row) => row.id !== id))
        return { approved: true, ...invite }
      }
      case 'net.plus.enrollment.deny': {
        const id = String(params.id)
        await this.service().denyEnrollmentRequest(id)
        this.setEnrollmentRequests(this.enrollmentList.filter((row) => row.id !== id))
        return { denied: true }
      }
      case 'net.plus.enrollment.offer': {
        if (!this.service().status().connected) throw new NetError('not_enrolled')
        // The QR code is for a phone ("Add phone"), so the authority records the device as one.
        const invite = await this.host.issueRendezvousInvite({
            kind: 'phone',
            ...(params.name === undefined ? {} : { name: String(params.name) })
          }),
          key = randomBytes(32)
        try {
          const offer = await this.service().enrollmentOffer(sealInviteForOffer(invite.text, key))
          return {
            offerId: offer.id,
            url: enrollmentJoinUrl(offer.apiOrigin, offer.id, key),
            inviteId: invite.invite,
            expiresAt: Math.min(offer.expiresAt, invite.expiresAt)
          }
        } catch (error) {
          this.host.revokeUnsentInvite(invite.invite, error)
          throw error
        } finally {
          key.fill(0)
        }
      }
      default:
        throw new NetError('bad_request')
    }
  }

  /** After sign-in: the hosted relay replaces any earlier one and the transports restart. */
  private async useHostedRelay(): Promise<void> {
    this.host.saveHostedTransport(
      this.host.validateTransport({
        id: 'plus-relay',
        enabled: true,
        settings: { address: this.service().configuration()!.audience }
      })
    )
    await this.host.restartTransports()
    this.armRenewal()
    await this.refreshDirectPath(true)
  }

  private assertTransportCapacity(): void {
    if (this.host.transportRows().filter((row) => row.id !== 'plus-relay').length >= 8)
      throw new NetError('too_large')
  }

  private hostedRelayEnabled(): boolean {
    return this.host.transportRows().some((row) => row.id === 'plus-relay' && row.enabled)
  }

  async recoverLease(): Promise<void> {
    const state = this.host.loadedRuntime()
    if (
      !this.hostedRelayEnabled() ||
      state?.keys.state() !== 'unlocked' ||
      !state.keys.encryptedAtRest()
    )
      return
    try {
      await this.fenceUnauthorizedSpaceRoutes()
      await this.service().renew()
      await this.reconcileSpaceRoutes()
    } catch (error) {
      this.host.fail(error)
      this.host.emit()
    }
    await this.refreshDirectPath(true)
  }

  private async fenceUnauthorizedSpaceRoutes(): Promise<void> {
    if (
      this.service()
        .managedSpaceRoutes()
        .some(
          (row) =>
            !this.host.featureEnabled('netSpaces') ||
            !this.host.hostedSpacePeerAuthorized(row.user, row.node)
        )
    ) {
      this.hostedConsentFenced = true
      await this.host.suspendHostedTransport()
    }
  }

  private async reconcileSpaceRoutes(): Promise<void> {
    const hosted = this.service(),
      authorized = (user: UserId, node: NodeId) =>
        this.host.featureEnabled('netSpaces') && this.host.hostedSpacePeerAuthorized(user, node)
    try {
      await this.fenceUnauthorizedSpaceRoutes()
      await hosted.reconcileSpaceRoutes(authorized)
      if (this.hostedConsentFenced) {
        this.hostedConsentFenced = false
        await this.host.reactivateIfRunning()
      }
    } finally {
      this.rescheduleRenewal()
    }
  }

  /**
   * A pending renewal timer was timed from the routes that existed when it was armed. A route added
   * or refreshed since then (a peer joining a Space, say) may need its approval refreshed sooner, so
   * time the wait again, but never later than the time already set: repeated reconciliation must
   * not keep postponing the registration renewal. Does nothing while no timer is pending, such as
   * during a renewal pass.
   */
  private rescheduleRenewal(): void {
    if (!this.plusRenewal) return
    const dueAt = this.plusRenewalDueAt
    clearTimeout(this.plusRenewal)
    this.plusRenewal = undefined
    this.armRenewal(dueAt)
  }

  membershipChanged(): void {
    const state = this.host.loadedRuntime()
    if (
      this.host.signal.aborted ||
      !this.host.enabled() ||
      !state?.identity.self() ||
      state.keys.state() !== 'unlocked' ||
      !state.keys.encryptedAtRest()
    )
      return
    void this.host
      .serial(async () => {
        if (!this.service().status().connected) return
        await this.reconcileSpaceRoutes()
      })
      .catch((error) => {
        this.host.fail(error)
        this.armRenewal()
        this.host.emit()
      })
  }

  async spaceJoined(node: NodeId, user: UserId): Promise<void> {
    if (!this.host.hostedListening()) return
    await this.host.serial(async () => {
      this.service().rememberSpaceRoute(node, user)
      await this.reconcileSpaceRoutes()
    })
  }

  async prepareSpaceRendezvous(
    expiresAt: number,
    uses: number
  ): Promise<RelayRendezvous | undefined> {
    if (!this.host.hostedListening()) return
    if (uses !== 1)
      throw new NetError(
        'bad_request',
        'Hosted Space invitations admit one exact source device; create separate invitations for each participant.'
      )
    return this.host.serial(() =>
      this.service().rendezvous(Math.min(expiresAt, Date.now() + 599000), 'space')
    )
  }

  resumeRenewal(): void {
    if (!this.hostedRelayEnabled()) return
    this.armRenewal()
  }

  rosterChanged(): void {
    if (this.host.signal.aborted || !this.hostedRelayEnabled()) return
    try {
      if (!this.service().status().registrationId) return
    } catch {
      // Locked or not enrolled: the next renewal after unlock carries the roster.
      return
    }
    if (this.plusRenewal) clearTimeout(this.plusRenewal)
    this.plusRenewal = undefined
    this.armRenewal(this.host.clock.now())
  }

  private armRenewal(notAfter?: number): void {
    if (this.host.signal.aborted) return
    this.armEnrollmentPoll(1000)
    if (this.plusRenewal) return
    const status = this.service().status()
    if (!status.configured || !status.registrationId) return
    const now = this.host.clock.now(),
      delay = Math.max(
        0,
        Math.min(
          renewalDelayMs(
            status.connected ? status.expiresAt! : undefined,
            this.service().managedSpaceRoutes(),
            now
          ),
          notAfter === undefined ? Infinity : notAfter - now
        )
      )
    this.plusRenewalDueAt = now + delay
    this.plusRenewal = setTimeout(() => {
      this.plusRenewal = undefined
      if (this.host.signal.aborted) return
      void this.host
        .serial(async () => {
          try {
            await this.fenceUnauthorizedSpaceRoutes()
            await this.service().renew()
            await this.reconcileSpaceRoutes()
            await this.refreshDirectPath()
          } finally {
            this.armRenewal()
          }
        })
        .catch((error) => {
          this.host.fail(error)
          this.host.emit()
        })
    }, delay)
    this.plusRenewal.unref?.()
    if (!this.plusAbortBound) {
      this.plusAbortBound = true
      this.host.signal.addEventListener(
        'abort',
        () => {
          if (this.plusRenewal) clearTimeout(this.plusRenewal)
          this.plusRenewal = undefined
        },
        { once: true }
      )
    }
  }

  private enrollmentEligible(): boolean {
    try {
      const state = this.host.loadedRuntime()
      return (
        !this.host.closed() &&
        !this.host.signal.aborted &&
        !!state?.identity.self()?.isAuthority &&
        state.keys.state() === 'unlocked' &&
        state.keys.encryptedAtRest() &&
        this.service().status().connected
      )
    } catch {
      return false
    }
  }

  private setEnrollmentRequests(next: PlusEnrollmentRequest[]): void {
    const changed =
      next.length !== this.enrollmentList.length ||
      next.some((row, index) => row.id !== this.enrollmentList[index]?.id)
    this.enrollmentList = next
    if (changed) this.host.emit()
  }

  /** With `approveComputers` (the poll, outside the serial queue) computer requests are approved. */
  private async refreshEnrollmentRequests(approveComputers = false): Promise<PlusEnrollmentRequest[]> {
    if (!this.enrollmentEligible()) {
      this.setEnrollmentRequests([])
      return []
    }
    const requests = await this.service().enrollmentRequests()
    // A computer asks only after signing in to this same account, which is the consent: it is
    // added without a question. Phones are still shown with their match code.
    for (const request of requests)
      if (approveComputers && request.kind === 'computer' && !this.computerRequestsTried.has(request.id)) {
        this.computerRequestsTried.add(request.id)
        await this.host
          .serial(() => this.approveRequest(request))
          .catch((error) => {
            this.host.fail(error)
            this.host.emit()
          })
      }
    this.setEnrollmentRequests(requests.filter((row) => row.kind !== 'computer'))
    return this.enrollmentList
  }

  /** Sends the device an invite sealed to its key, pinned to the transport key it asked with. */
  private async approveRequest(
    request: PlusEnrollmentRequest
  ): Promise<{ inviteId: string; expiresAt: number }> {
    const invite = await this.host.issueRendezvousInvite({
      name: request.deviceName,
      joinerTransportFingerprint: request.transportFingerprint,
      kind: request.kind
    })
    try {
      await this.service().approveEnrollmentRequest(
        request.id,
        sealInviteForRequest(invite.text, request.boxPublicKey, request.id)
      )
    } catch (error) {
      this.host.revokeUnsentInvite(invite.invite, error)
      throw error
    }
    return { inviteId: invite.invite, expiresAt: invite.expiresAt }
  }

  private armEnrollmentPoll(delayMs = PLUS_ENROLLMENT_POLL_MS): void {
    if (this.enrollmentPoll || !this.enrollmentEligible()) return
    this.enrollmentPoll = setTimeout(() => {
      this.enrollmentPoll = undefined
      void this.refreshEnrollmentRequests(true)
        .catch(() => {
          // Mousse ID may be unreachable or predate the mailbox; keep the last list and retry.
        })
        .finally(() => this.armEnrollmentPoll())
    }, delayMs)
    this.enrollmentPoll.unref?.()
    if (!this.enrollmentAbortBound) {
      this.enrollmentAbortBound = true
      this.host.signal.addEventListener('abort', () => this.stopEnrollmentPoll(), {
        once: true
      })
    }
  }

  private stopEnrollmentPoll(): void {
    if (this.enrollmentPoll) clearTimeout(this.enrollmentPoll)
    this.enrollmentPoll = undefined
    this.enrollmentList = []
  }

  enrollmentRequests(): {
    requests: Array<PlusEnrollmentRequest & { matchCode: string }>
  } {
    if (!this.enrollmentEligible()) return { requests: [] }
    this.armEnrollmentPoll(0)
    const now = this.host.clock.now()
    return {
      requests: this.enrollmentList
        .filter((row) => row.expiresAt > now)
        .map((row) => ({
          ...row,
          matchCode: enrollmentMatchCode(row.boxPublicKey, row.transportFingerprint)
        }))
    }
  }

  private service(): HostedProfileService {
    const rt = this.host.requireEnrolled()
    return (this.hostedProfile ??= new HostedProfileService({
      keys: rt.keys,
      now: () => this.host.clock.now(),
      signal: this.host.signal,
      identity: () => {
        const self = rt.identity.self()!,
          hello = rt.enrollment.localHello()
        return {
          ...self,
          rootKey: rt.identity.pinnedRootKey(self.user)!,
          roster: hello.roster!,
          delegation: hello.delegation!
        }
      }
    }))
  }
}
