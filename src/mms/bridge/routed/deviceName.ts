import type { NodeDelegation, NodeId, Roster } from '../../../shared/net'
import type { NetIdentityService } from '../../net/identity/NetIdentityService'

/** The name the user gave a device, from the signed roster; `fallback` when it has none or the roster cannot be read. */
export function deviceNameOf(
  identity: Pick<NetIdentityService, 'self' | 'pinnedRootKey' | 'roster' | 'verifySigned'>,
  node: NodeId,
  fallback = 'another computer'
): string {
  try {
    const self = identity.self()
    const root = self && identity.pinnedRootKey(self.user)
    const signed = self && identity.roster(self.user)
    if (root && signed) {
      const roster = identity.verifySigned<Roster>(signed, root)
      const found = roster.nodes
        .map((row) => identity.verifySigned<NodeDelegation>(row, root))
        .filter((row) => row.subject === node)
        .sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0]
      if (found?.name) return found.name
    }
  } catch {
    // The name is only for people to read.
  }
  return fallback
}
