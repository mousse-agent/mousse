import { randomBytes } from 'node:crypto'
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
  sealInviteForOffer,
  sealInviteForRequest
} from './enrollmentSeal'
import { createHostedRelayTransports } from './relayTransports'
import { DEFAULT_DIRECT_PATH, type DirectPathConfig } from '../transports/phoneWebRtc'

/** How often a signed-in authority checks Mousse ID for phones asking to join. */
const PLUS_ENROLLMENT_POLL_MS = 15000
/** How often a signed-in computer reads Mousse ID's direct-path configuration again. */
const DIRECT_PATH_REFRESH_MS = 10 * 60_000

/** The Mousse ID module: account sign-in, the hosted relay lease and phone enrollment. */
export const mousseIdNetModule: HostedNetModule = {
  create: (host) => new HostedNetController(host)
}

export class HostedNetController implements HostedNet {
  readonly transports: HostedRelayTransports
  private hostedProfile?: HostedProfileService
  private hostedConsentFenced = false
  private plusAbortBound = false
  private plusRenewal?: ReturnType<typeof setTimeout>
  private enrollmentList: PlusEnrollmentRequest[] = []
  private enrollmentPoll?: ReturnType<typeof setTimeout>
  private enrollmentAbortBound = false
  private direct: DirectPathConfig = DEFAULT_DIRECT_PATH
  private directReadAt?: number

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
    return { cancelled: true }
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
        const invite = await this.host.issueRendezvousInvite({
          name: request.deviceName,
          joinerTransportFingerprint: request.transportFingerprint
        })
        try {
          await this.service().approveEnrollmentRequest(
            id,
            sealInviteForRequest(invite.text, request.boxPublicKey, id)
          )
        } catch (error) {
          this.host.revokeUnsentInvite(invite.invite, error)
          throw error
        }
        this.setEnrollmentRequests(this.enrollmentList.filter((row) => row.id !== id))
        return { approved: true, inviteId: invite.invite, expiresAt: invite.expiresAt }
      }
      case 'net.plus.enrollment.deny': {
        const id = String(params.id)
        await this.service().denyEnrollmentRequest(id)
        this.setEnrollmentRequests(this.enrollmentList.filter((row) => row.id !== id))
        return { denied: true }
      }
      case 'net.plus.enrollment.offer': {
        if (!this.service().status().connected) throw new NetError('not_enrolled')
        const invite = await this.host.issueRendezvousInvite(
            params.name === undefined ? {} : { name: String(params.name) }
          ),
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
    await this.fenceUnauthorizedSpaceRoutes()
    await hosted.reconcileSpaceRoutes(authorized)
    if (this.hostedConsentFenced) {
      this.hostedConsentFenced = false
      await this.host.reactivateIfRunning()
    }
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
    this.armRenewal(0)
  }

  private armRenewal(delayMs?: number): void {
    if (this.host.signal.aborted) return
    this.armEnrollmentPoll(1000)
    if (this.plusRenewal) return
    const status = this.service().status()
    if (!status.configured || !status.registrationId) return
    this.plusRenewal = setTimeout(
      () => {
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
      },
      delayMs ??
        (status.connected
          ? Math.min(20000, Math.max(1000, (status.expiresAt! - this.host.clock.now()) / 3))
          : 20000)
    )
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

  private async refreshEnrollmentRequests(): Promise<PlusEnrollmentRequest[]> {
    if (!this.enrollmentEligible()) {
      this.setEnrollmentRequests([])
      return []
    }
    this.setEnrollmentRequests(await this.service().enrollmentRequests())
    return this.enrollmentList
  }

  private armEnrollmentPoll(delayMs = PLUS_ENROLLMENT_POLL_MS): void {
    if (this.enrollmentPoll || !this.enrollmentEligible()) return
    this.enrollmentPoll = setTimeout(() => {
      this.enrollmentPoll = undefined
      void this.refreshEnrollmentRequests()
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
