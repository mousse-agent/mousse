import { createHash } from 'node:crypto'
import {
  newId,
  type NodeDelegation,
  type Roster,
  type RpcArtifactRef,
  type RpcId,
  type StreamDescriptor,
  type BlobId
} from '../../../shared/net'
import { ROUTED_STAGE_ITEM_BYTES, routedNetMethod, isRoutedReply } from '../../../shared/bridge/routed'
import type { IdentityService, KeyStore, SyncSession } from '../../net/contracts'
import { encodeEnvelope } from '../../net/sync/codec'
import { DomainRpcError } from '../../protocol/domainRegistry'
import { refusalError } from './computerErrors'

export interface StagerDeps {
  identity: Pick<IdentityService, 'self' | 'pinnedRootKey' | 'roster' | 'verifySigned'>
  keys: Pick<KeyStore, 'signAsNode'>
  clock: { now(): number }
}

/**
 * Sends a value that is too large for a request ahead of the call that uses it: it goes up as the
 * input artifact of a `routed.stage` request, and the owner keeps it for the call that names it in
 * `stagedValues`. The value is the JSON text of what the call would have carried inline.
 */
export class RoutedStager {
  constructor(private readonly deps: StagerDeps) {}

  /** The id the owner gives the staged value (`stg_…`). */
  async stage(session: SyncSession, value: unknown, signal?: AbortSignal): Promise<string> {
    const bytes = Buffer.from(JSON.stringify(value))
    if (bytes.length > ROUTED_STAGE_ITEM_BYTES)
      throw new DomainRpcError('too_large', 'That is too large to send to another computer.', {
        bytes: bytes.length,
        max: ROUTED_STAGE_ITEM_BYTES
      })
    const { identity, keys, clock } = this.deps
    const id = newId('rpc') as RpcId
    const descriptor = (await session.rpc(
      'bridge.artifacts.open',
      { forRpcId: id, forMethod: routedNetMethod('stage') },
      { id: newId('rpc'), idem: `open-${id}`, deadlineMs: 20_000, signal }
    )) as StreamDescriptor
    const blob = `blb_${createHash('sha256').update(bytes).digest('hex')}` as BlobId
    await session.putBlob(descriptor.id, blob, bytes, false)
    const self = identity.self()
    if (!self) throw new DomainRpcError('not_enrolled', 'This computer is not part of a network.')
    const root = identity.pinnedRootKey(self.user)
    const signed = identity.roster(self.user)
    if (!root || !signed) throw new DomainRpcError('roster_conflict', 'No usable roster.')
    const roster = identity.verifySigned<Roster>(signed, root)
    const delegation = roster.nodes
      .map((row) => identity.verifySigned<NodeDelegation>(row, root))
      .filter((row) => row.subject === self.node)
      .sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0]
    if (!delegation) throw new DomainRpcError('bad_delegation', 'This device has no delegation.')
    const event = newId('event')
    const envelope = encodeEnvelope({
      v: 1,
      minor: 0,
      id: event,
      stream: descriptor.id,
      type: 'artifact.published',
      crit: false,
      author: { user: self.user, node: self.node, keyEpoch: delegation.keyEpoch },
      ts: clock.now(),
      body: { rpc: id, purpose: 'input' },
      blobs: [{ id: blob, bytes: bytes.length, mime: 'application/json' }]
    })
    await session.append(descriptor.id, event, envelope, keys.signAsNode(envelope))
    const ref: RpcArtifactRef = { stream: descriptor.id, event, blob }
    const reply = await session.rpc(
      routedNetMethod('stage'),
      { input: ref },
      { id, idem: `stage-${id}`, deadlineMs: 60_000, signal }
    )
    if (!isRoutedReply(reply)) throw new DomainRpcError('bad_reply', 'The other computer sent an unreadable reply.')
    if (!reply.ok) throw refusalError(reply.error)
    const staged = (reply.result as { stage?: unknown } | undefined)?.stage
    if (typeof staged !== 'string')
      throw new DomainRpcError('bad_reply', 'The other computer sent an unreadable reply.')
    return staged
  }
}
