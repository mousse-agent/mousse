import type { NetEngineNeedsUpdate } from '../../shared/netEngine/local'

/**
 * Version refusals as the app reads them from its helper (pair-with-IP design §5): a helper that lists
 * `version-refusals` puts each paired device's last refusal for version on its `peers.list` and `grants.list` rows,
 * as `version_refusal {peer_minor, local_minor, since}` or null. The first connection with the device that agrees a
 * version clears it.
 */

/** One device's last refusal for version. `since` in ms since 1970. */
export interface VersionRefusal {
  peerMinor: number
  localMinor: number
  since: number
}

const minor = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined

/** One row's `version_refusal`, or undefined for null or anything that doesn't read. */
export function readVersionRefusal(value: unknown): VersionRefusal | undefined {
  if (!value || typeof value !== 'object') return undefined
  const refusal = value as Record<string, unknown>
  const peerMinor = minor(refusal.peer_minor)
  const localMinor = minor(refusal.local_minor)
  const since = typeof refusal.since === 'number' && Number.isFinite(refusal.since) ? refusal.since : undefined
  if (peerMinor === undefined || localMinor === undefined || since === undefined) return undefined
  return { peerMinor, localMinor, since: since * 1000 }
}

/**
 * Each device's refusal from `peers.list` and `grants.list`, by identity (lower case). A device on both lists has one
 * refusal in the helper; the later one is kept should they differ.
 */
export function readVersionRefusals(
  ...answers: Array<Record<string, unknown> | undefined>
): Map<string, VersionRefusal> {
  const out = new Map<string, VersionRefusal>()
  for (const answer of answers)
    for (const row of [
      ...(Array.isArray(answer?.peers) ? answer.peers : []),
      ...(Array.isArray(answer?.grants) ? answer.grants : [])
    ]) {
      if (!row || typeof row.identity !== 'string') continue
      const refusal = readVersionRefusal(row.version_refusal)
      if (!refusal) continue
      const identity = row.identity.toLowerCase()
      const kept = out.get(identity)
      if (!kept || refusal.since > kept.since) out.set(identity, refusal)
    }
  return out
}

/** Whether two reads hold the same refusals. */
export function sameRefusals(a: ReadonlyMap<string, VersionRefusal>, b: ReadonlyMap<string, VersionRefusal>): boolean {
  if (a.size !== b.size) return false
  for (const [identity, refusal] of a) {
    const other = b.get(identity)
    if (!other || other.since !== refusal.since || other.peerMinor !== refusal.peerMinor || other.localMinor !== refusal.localMinor)
      return false
  }
  return true
}

/**
 * What a device's row shows for its refusal: the lower minor names the computer that has to update (`there`, the
 * device; `here`, this computer). `told` once its one notice was shown.
 */
export function needsUpdate(refusal: VersionRefusal | undefined, told: boolean): NetEngineNeedsUpdate | undefined {
  if (!refusal) return undefined
  return {
    who: refusal.localMinor < refusal.peerMinor ? 'here' : 'there',
    since: refusal.since,
    ...(told ? { told: true } : {})
  }
}

/** The helper events after which a device's refusal may have changed, so the lists are read again. */
export function refusalMayChange(event: Record<string, unknown>): boolean {
  switch (event.ev) {
    // A connection that came up agreed a version: its device's refusal cleared.
    case 'conn.up':
    case 'peer.incompatible':
    // A pairing made or removed here.
    case 'enrolled':
    case 'grant.closed':
      return true
    // The keeper's dials and a path's renewal say `peer_minor` when they were refused for version.
    case 'dial.failed':
    case 'path.renew_failed':
      return typeof event.peer_minor === 'number'
    default:
      return false
  }
}
