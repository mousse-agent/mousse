import { createHash } from 'node:crypto'
import type { RelayRendezvous } from '../../net/relay/protocol'
import { canonicalAudience } from '../../net/plus/wire/protocol'
import type { IdentityService, SecureChannel } from '../../net/contracts'
import { decodeBase64, verifyDocument } from '../../net/identity/crypto'
import { canonicalJson, parseProtocolJson, encodeMessage } from '../../net/sync/codec'
import { invitationProof, invitationProofKey } from '../../net/enrollment/service'
import { NetError } from '../../../shared/net'
import type {
  NodeDelegation,
  Roster,
  Signed,
  SpaceDescriptor,
  SpaceInviteAuthorization,
  SpaceJoinRequestMessage
} from '../../../shared/net'
/** This P5 outer container carries verifiable credentials and a bearer secret.
 * Never put this container/token in a log or signed meta event. */
export interface SpaceInviteContainer {
  v: 1
  descriptor: Signed
  ownerRootKey: string
  ownerRoster: Signed
  authorization: Signed
  issuerRootKey: string
  issuerRoster: Signed
  token: string
  rendezvous?: Signed
}
export interface ParsedSpaceInvite {
  container: SpaceInviteContainer
  descriptor: SpaceDescriptor
  authorization: SpaceInviteAuthorization
  token: Uint8Array
}
export function encodeSpaceInvite(container: SpaceInviteContainer): string {
  const text = `sj1_${Buffer.from(canonicalJson(container)).toString('base64url')}`
  if (Buffer.byteLength(text) > 64 * 1024) throw new NetError('too_large')
  return text
}
export function parseSpaceInvite(text: string): ParsedSpaceInvite {
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 64 * 1024 || !text.startsWith('sj1_'))
      throw new NetError('invite_invalid')
    const container = parseProtocolJson(decodeBase64(text.slice(4))) as SpaceInviteContainer
    if (
      container.v !== 1 ||
      Object.keys(container)
        .filter((key) => key !== 'rendezvous')
        .sort()
        .join(',') !==
        'authorization,descriptor,issuerRootKey,issuerRoster,ownerRootKey,ownerRoster,token,v'
    )
      throw new NetError('invite_invalid')
    const descriptor = verifyDocument<SpaceDescriptor>(
        container.descriptor,
        container.ownerRootKey,
        'spaceDescriptor'
      ),
      ownerRoster = verifyDocument<Roster>(container.ownerRoster, container.ownerRootKey, 'roster')
    if (ownerRoster.owner !== descriptor.owner || ownerRoster.rootKey !== container.ownerRootKey)
      throw new NetError('invite_invalid')
    const host = ownerRoster.nodes
      .map((row) => verifyDocument<NodeDelegation>(row, container.ownerRootKey, 'nodeDelegation'))
      .filter(
        (row) =>
          row.subject === descriptor.hostNode &&
          row.keys.transport === descriptor.hostTransportKey &&
          row.issuedAt <= descriptor.issuedAt &&
          descriptor.issuedAt < row.expiresAt
      )
      .sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0]
    if (!host) throw new NetError('invite_invalid')
    const routes = verifyDocument<any>(descriptor.routes, host.keys.sign, 'routes')
    if (routes.node !== host.subject || !routes.routes.length) throw new NetError('invite_invalid')
    const raw = parseProtocolJson(
        decodeBase64(container.authorization.payload)
      ) as SpaceInviteAuthorization,
      issuerRoster = verifyDocument<Roster>(
        container.issuerRoster,
        container.issuerRootKey,
        'roster'
      ),
      delegation = verifyDocument<NodeDelegation>(
        raw.issuer.delegation,
        container.issuerRootKey,
        'nodeDelegation'
      ),
      authorization = verifyDocument<SpaceInviteAuthorization>(
        container.authorization,
        delegation.keys.sign,
        'inviteAuthorization'
      )
    if (
      issuerRoster.owner !== authorization.issuer.user ||
      issuerRoster.rootKey !== container.issuerRootKey ||
      delegation.owner !== issuerRoster.owner ||
      delegation.subject !== authorization.issuer.node ||
      authorization.space !== descriptor.space ||
      authorization.epoch !== descriptor.epoch ||
      authorization.issuedAt < delegation.issuedAt ||
      authorization.expiresAt > delegation.expiresAt ||
      authorization.expiresAt <= authorization.issuedAt ||
      authorization.expiresAt - authorization.issuedAt > 86400000 ||
      !issuerRoster.nodes.some(
        (row) =>
          row.payload === raw.issuer.delegation.payload && row.sig === raw.issuer.delegation.sig
      )
    )
      throw new NetError('invite_invalid')
    if (container.rendezvous) {
      const discovery = verifyDocument<SpaceRelayDiscovery>(
        container.rendezvous,
        delegation.keys.sign
      )
      const rv = discovery.rendezvous
      if (
        Object.keys(discovery).sort().join(',') !==
          'authorizationHash,descriptorHash,kind,node,rendezvous,v' ||
        discovery.v !== 1 ||
        discovery.kind !== 'spaceRelayDiscovery' ||
        discovery.node !== descriptor.hostNode ||
        authorization.issuer.node !== descriptor.hostNode ||
        discovery.authorizationHash !== spaceInviteDigest(container.authorization) ||
        discovery.descriptorHash !== spaceInviteDigest(container.descriptor) ||
        !rv ||
        Object.keys(rv).sort().join(',') !== 'expiresAt,relay,ticket,transport' ||
        rv.transport !== 'plus-relay' ||
        canonicalAudience(rv.relay) !== rv.relay ||
        !/^[A-Za-z0-9_-]{43}$/.test(rv.ticket) ||
        !Number.isSafeInteger(rv.expiresAt) ||
        rv.expiresAt > authorization.expiresAt ||
        rv.expiresAt <= authorization.issuedAt ||
        rv.expiresAt - authorization.issuedAt > 600000 ||
        !routes.routes.some(
          (route: { transport: string; address: string }) =>
            route.transport === 'plus-relay' &&
            new URL(route.address).origin + new URL(route.address).pathname === rv.relay
        )
      )
        throw new NetError('invite_invalid')
    }
    return { container, descriptor, authorization, token: decodeBase64(container.token, 32) }
  } catch (error) {
    if (error instanceof NetError && error.code === 'too_large') throw error
    throw new NetError('invite_invalid')
  }
}
export function spaceJoinRequest(
  invite: ParsedSpaceInvite,
  identity: IdentityService,
  channel: SecureChannel,
  name: string
): SpaceJoinRequestMessage {
  const self = identity.self(),
    rootKey = self && identity.pinnedRootKey(self.user),
    rosterSigned = self && identity.roster(self.user)
  if (!self || !rootKey || !rosterSigned) throw new NetError('not_enrolled')
  if (channel.peerTransportKey !== invite.descriptor.hostTransportKey)
    throw new NetError('peer_key_mismatch')
  const roster = verifyDocument<Roster>(rosterSigned, rootKey, 'roster'),
    delegation = roster.nodes
      .filter(
        (row) =>
          verifyDocument<NodeDelegation>(row, rootKey, 'nodeDelegation').subject === self.node
      )
      .sort(
        (a, b) =>
          verifyDocument<NodeDelegation>(b, rootKey, 'nodeDelegation').keyEpoch -
          verifyDocument<NodeDelegation>(a, rootKey, 'nodeDelegation').keyEpoch
      )[0]
  if (!delegation) throw new NetError('bad_delegation')
  const stable = {
    t: 'space.join.request' as const,
    invite: invite.authorization.invite,
    space: invite.descriptor.space,
    user: self.user,
    rootKey,
    node: self.node,
    delegation,
    roster: rosterSigned,
    name
  }
  const request = {
    ...stable,
    proof: invitationProof(
      invitationProofKey(invite.token, 'space'),
      channel.exporter('EXPORTER-mousse-net-space-join', 32),
      stable
    )
  }
  if (encodeMessage(request).length > 16 * 1024) throw new NetError('too_large')
  return request
}

export interface SpaceRelayDiscovery {
  v: 1
  kind: 'spaceRelayDiscovery'
  node: SpaceDescriptor['hostNode']
  authorizationHash: string
  descriptorHash: string
  rendezvous: RelayRendezvous
}
export function spaceInviteDigest(value: Signed): string {
  return createHash('sha256').update(canonicalJson(value)).digest('base64url')
}
export function spaceInviteRendezvous(
  container: SpaceInviteContainer
): RelayRendezvous | undefined {
  if (!container.rendezvous) return
  return (parseProtocolJson(decodeBase64(container.rendezvous.payload)) as SpaceRelayDiscovery)
    .rendezvous
}
