import { cleanDeviceName } from '../../../shared/bridge/editorAsk'
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

/**
 * The name a person here tells a device by, made safe to show (no control or direction characters, cut to a
 * readable length), with the last characters of its id after it when another device on the roster has the same name.
 */
export function deviceLabelOf(
  identity: Pick<NetIdentityService, 'self' | 'pinnedRootKey' | 'roster' | 'verifySigned'>,
  node: NodeId
): string {
  const own = cleanDeviceName(deviceNameOf(identity, node))
  try {
    const self = identity.self()
    const root = self && identity.pinnedRootKey(self.user)
    const signed = self && identity.roster(self.user)
    if (root && signed) {
      const roster = identity.verifySigned<Roster>(signed, root)
      const others = new Set(
        roster.nodes
          .map((row) => identity.verifySigned<NodeDelegation>(row, root))
          .filter((row) => row.subject !== node && cleanDeviceName(row.name ?? '') === own)
          .map((row) => row.subject)
      )
      if (others.size) return `${own} (${node.slice(-4)})`
    }
  } catch {
    // The label is only for people to read.
  }
  return own
}
