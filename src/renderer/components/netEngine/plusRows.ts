import type {
  NetEnginePlus,
  NetEnginePlusPool,
  NetEngineRelayClass,
  NetEngineRemoval
} from '../../../shared/netEngine/local'
import { formatBytes } from '../../../shared/storage'
import { formatDurationShort } from '../../utils/responseTimeline'

/** A host as the user knows it: its name here, else the start of its id. */
export const hostLabel = (item: { host: string; hostName?: string }): string =>
  item.hostName || item.host.slice(0, 8)

/** One removal's state, as design D.3 words it. */
export function removalText(item: NetEngineRemoval): { line: string; warn?: boolean } {
  const host = hostLabel(item)
  switch (item.state) {
    case 'done':
      if (item.result === 'applied') return { line: 'Removed' }
      // A newer pairing of the device stays on that host: it still has access there.
      if (item.result === 'stale') return { line: 'Already replaced by a newer pairing', warn: true }
      return { line: 'Refused', warn: true }
    case 'sent':
      return { line: 'Waiting (sent)' }
    case 'delivered':
      return { line: 'Delivered, not confirmed' }
    case 'quota':
      return { line: `Waiting for ${host} to collect its mail` }
    case 'expired':
      return { line: `Couldn't remove from ${host}; remove it there`, warn: true }
    default:
      return { line: `Waits until this device reaches ${host}` }
  }
}

/**
 * The title over one removed device's per-host states: removed only once every host removed it, a warning once a
 * host did not, and removing while any host has yet to answer.
 */
export function removalTitle(name: string, items: NetEngineRemoval[]): { line: string; warn?: boolean } {
  if (items.some((item) => removalText(item).warn)) return { line: `${name} not removed on every host`, warn: true }
  if (items.every((item) => item.state === 'done')) return { line: `${name} removed on my hosts` }
  return { line: `Removing ${name} on my hosts` }
}

/** How the last sign-in ended, when it did not end signed in. */
export function linkResultText(result: string | undefined): string | undefined {
  switch (result) {
    case 'denied':
      return 'Sign-in was declined.'
    case 'expired':
      return 'The code expired. Sign in again.'
    case 'gone':
      return 'Sign-in ended. Sign in again.'
    default:
      return undefined
  }
}

const PLAN_TEXT: Record<string, string> = {
  active: 'Active',
  past_due: 'Payment due',
  cancelled: 'Cancelled',
  none: 'No plan'
}

/** "Plus · Active · renews 3 Dec". */
export function planLine(plus: NetEnginePlus): string {
  const parts = ['Plus', PLAN_TEXT[plus.plan ?? ''] ?? 'Signed in']
  if (plus.periodEndsAt && plus.plan === 'active')
    parts.push(
      `renews ${new Date(plus.periodEndsAt * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
    )
  return parts.join(' · ')
}

/** "1.2 GB of 50.00 GB left". */
export function poolLine(pool: NetEnginePlusPool | undefined): string | undefined {
  if (!pool || pool.available === undefined) return undefined
  const left = formatBytes(pool.available)
  return pool.allowance ? `${left} of ${formatBytes(pool.allowance)} left` : `${left} left`
}

/** One class on the paid relay: "about 2h left", "paused", "not funded". */
export function relayClassLine(cls: NetEngineRelayClass | undefined): string | undefined {
  if (!cls) return undefined
  if (cls.state === 'paused') return 'paused'
  if (cls.state === 'unfunded') return 'not funded'
  return cls.lastsSecs !== undefined
    ? `about ${formatDurationShort(cls.lastsSecs * 1000)} left`
    : `${formatBytes(cls.bytesLeft)} left`
}

/**
 * The status lines under Plus: the top-up line when a balance is spent, the paused-copies line, and the outage
 * line. Lines only; nothing here asks the user anything (design I.3).
 */
export function plusNotices(plus: NetEnginePlus): Array<{ line: string; detail?: string }> {
  const out: Array<{ line: string; detail?: string }> = []
  const relay = plus.relay
  const interactive = relay?.interactive
  const bulk = relay?.bulk
  if (interactive?.refillError === 'balance_empty' || (plus.interactive?.debt ?? 0) > 0)
    out.push({
      line: 'Typing balance used up. Top up on the Plus website.',
      detail:
        'Typing over the paid relay stops until you top up. The local network and your own addresses still work.'
    })
  if (bulk?.refillError === 'allowance_used')
    out.push({
      line: 'Copy allowance used up for this period.',
      detail:
        'Copies over the paid relay wait until the next period. The local network still works.'
    })
  if (bulk?.state === 'paused')
    out.push({
      line: 'Copies over the paid relay are paused.',
      detail:
        'They resume on their own when more data is available, or finish over the local network.'
    })
  if (plus.unreachableSince)
    out.push({
      line: "Plus can't be reached. Showing what was last known.",
      detail: `Since ${new Date(plus.unreachableSince * 1000).toLocaleString()}`
    })
  return out
}
