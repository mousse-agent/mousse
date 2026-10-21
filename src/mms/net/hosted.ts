import type { InviteId, NodeId, UserId } from '../../shared/net'
import { NetError } from '../../shared/net'
import type { NetLocalMethod, PlusEnrollmentRequestView, PlusStatus } from '../../shared/net/local'
import type { NetFeatureFlags } from '../../shared/featureFlags'
import type { Clock, Transport, TransportAddon } from './contracts'
import type { NodeInviteInput } from './enrollment/service'
import type { RelayIdentity, RelayRendezvous } from './relay/protocol'
import type { TransportConfiguration } from './transports/registry'
import type { NetRuntime } from './NetService'

/**
 * The seam between core Net and the optional Mousse ID module (`./plus`). Core Net builds,
 * runs and passes its tests without the module: `net.plus.*` then reports "not configured"
 * or `profile_unsupported`, and hosted relay routes and invites are refused.
 */
export interface HostedNetModule {
  create(host: HostedNetHost): HostedNet
}

/** Hosted relay carriers for `ProfileTransports`. Lazy: nothing runs until a route needs it. */
export interface HostedRelayTransports {
  /** Listener for the signed-in account's relay registration. */
  addon(identity: () => RelayIdentity): TransportAddon
  /** Dial-only carrier that redeems a hosted rendezvous ticket from an invite. */
  rendezvousTransport(
    identity: () => RelayIdentity,
    audience: string,
    rendezvous: RelayRendezvous
  ): Transport
  /** A rendezvous ticket for an enrollment invite, through the signed-in account. */
  prepareRendezvous(expiresAt: number, purpose: 'enrollment' | 'space'): Promise<RelayRendezvous>
}

/** What NetService lends the module. Every call keeps core's own gates and ordering. */
export interface HostedNetHost {
  readonly clock: Clock
  readonly signal: AbortSignal
  /** The loaded runtime, if any, without loading or asserting anything. */
  loadedRuntime(): NetRuntime | undefined
  /** Throws `not_enrolled` / keystore errors like every other enrolled call. */
  requireEnrolled(): NetRuntime
  /** The service is stopped or disabled. */
  closed(): boolean
  /** Net is turned on for this profile. */
  enabled(): boolean
  featureEnabled(feature: keyof NetFeatureFlags): boolean
  /** The Spaces owner's consent for a hosted route to this peer. */
  hostedSpacePeerAuthorized(user: UserId, node: NodeId): boolean
  serial<T>(work: () => Promise<T>): Promise<T>
  emit(): void
  /** Records an error for `net.status`. */
  fail(error: unknown): void
  transportRows(): TransportConfiguration[]
  validateTransport(row: TransportConfiguration): TransportConfiguration
  /** Replaces (or, with undefined, removes) the hosted relay row and saves the configuration. */
  saveHostedTransport(row: TransportConfiguration | undefined): void
  activate(): Promise<void>
  /** Tears the transports down and starts them again from the saved configuration. */
  restartTransports(): Promise<void>
  /** Starts the transports again only when they are already running. */
  reactivateIfRunning(): Promise<void>
  suspendHostedTransport(): Promise<void>
  /** A hosted relay listener currently has routes. */
  hostedListening(): boolean
  relayIdentity(): RelayIdentity
  issueRendezvousInvite(
    input: NodeInviteInput
  ): Promise<{ text: string; invite: InviteId; expiresAt: number }>
  /** Drops an invite whose sealed copy never reached the service. */
  revokeUnsentInvite(invite: InviteId, error: unknown): void
}

/** The module's side, called by NetService at the points where hosted behavior joins core. */
export interface HostedNet {
  readonly transports: HostedRelayTransports
  /** `net.plus.status`; never throws. */
  status(): PlusStatus
  /** Signed in and holding a live relay lease. Throws when the profile is not enrolled. */
  connected(): boolean
  /** Hosted routes are held back until the Spaces owner consents to every hosted peer. */
  consentFenced(): boolean
  cancelLogin(): { cancelled: true }
  enrollmentRequests(): { requests: PlusEnrollmentRequestView[] }
  /** Every other `net.plus.*` method, already inside NetService's serial queue. */
  request(method: NetLocalMethod, params: Record<string, unknown>): Promise<unknown>
  /** Before transports start: renews a stored lease so the relay listener comes up signed in. */
  recoverLease(): Promise<void>
  /** After transports start: keeps the lease and the phone-request mailbox current. */
  resumeRenewal(): void
  /** A peer joined a Space through this computer; remember its hosted route. */
  spaceJoined(node: NodeId, user: UserId): Promise<void>
  prepareSpaceRendezvous(expiresAt: number, uses: number): Promise<RelayRendezvous | undefined>
  /** Space membership changed; re-check consent for hosted routes. */
  membershipChanged(): void
  /**
   * This user's roster changed (for example, a device was revoked). Sends it to Mousse ID now
   * instead of at the next scheduled renewal, so the hosted relay stops admitting revoked devices.
   */
  rosterChanged(): void
}

/** `net.plus.status` when the module is absent or the profile cannot use it yet. */
export function hostedNotConfigured(): PlusStatus {
  return { configured: false, connected: false }
}

export function hostedUnavailable(): NetError {
  return new NetError('profile_unsupported', 'Mousse ID is not part of this build.')
}
