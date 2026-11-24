import type {
  EngineFeature,
  NetEngineJoinCheck,
  NetEngineJoinProbe,
  NetEngineReach,
  NetEngineStatus,
  NetEngineWay,
  NetEngineWayReadiness
} from '../../../shared/netEngine/local'

/** Each way by its real name, as Reach this computer names it. */
export const WAY_LABEL: Readonly<Record<NetEngineWay, string>> = Object.freeze({
  lan: 'Same Wi-Fi',
  tailnet: 'Tailscale',
  public: 'Port forward',
  tunnel: 'Cloudflare Tunnel / own tunnel',
  relay: 'Your own relay'
})

/** The order the picker lists the ways in: the nearest first. */
export const WAY_ORDER: readonly NetEngineWay[] = ['lan', 'tailnet', 'public', 'tunnel', 'relay']

/** Why a way can't make a code now, in a few words; the helper's reason as given when it is new. */
export function wayReason(way: NetEngineWay, reason: string | undefined): string {
  switch (reason) {
    case 'disabled':
      return 'Off'
    case 'no_interface':
      return way === 'tailnet' ? 'Tailscale isn’t running' : 'Not on a network'
    case 'interface_unknown':
      return 'Can’t tell if it’s connected'
    case 'not_bound':
      return 'Starting'
    case 'restart_required':
      return 'Needs networking restarted'
    case 'route_too_long':
      return 'Address too long for a code'
    case 'not_configured':
      return 'Not set up'
    case 'origin_unavailable':
      return 'Tunnel isn’t answering'
    case 'relay_not_registered':
      return 'No relay added'
    case 'relay_capacity':
      return 'Relay is full'
    case 'paused':
      return 'Networking is paused'
    default:
      return reason ? reason.replace(/_/g, ' ') : 'Not ready'
  }
}

/**
 * What the owner can do here about a way that isn't ready: turn a switch on, or set it up in Reach this computer.
 * Undefined where nothing on this computer fixes it. A switch saved off while the helper still listens that way
 * reads as "needs a restart"; turning it on matches the two again.
 */
export function wayFix(
  readiness: NetEngineWayReadiness,
  reach?: Pick<NetEngineReach, 'lan' | 'tailnet'>
): 'turn-on' | 'set-up' | undefined {
  if (readiness.state === 'ready') return undefined
  if (readiness.way === 'lan' || readiness.way === 'tailnet') {
    if (readiness.reason === 'disabled') return 'turn-on'
    if (readiness.reason === 'restart_required' && reach?.[readiness.way] === false) return 'turn-on'
  }
  if (readiness.reason === 'not_configured' || readiness.reason === 'relay_not_registered' || readiness.reason === 'origin_unavailable')
    return 'set-up'
  return undefined
}

/** The helper lists every feature named. */
export const hasFeatures = (status: NetEngineStatus | undefined, ...features: EngineFeature[]): boolean =>
  features.every((feature) => status?.features?.includes(feature))

/** The ways a link's routes use, nearest first. */
export function linkWays(check: NetEngineJoinCheck): NetEngineWay[] {
  const ways = new Set<NetEngineWay>()
  for (const hint of check.hints) if (hint.way && hint.eligibility !== 'skip') ways.add(hint.way)
  return WAY_ORDER.filter((way) => ways.has(way))
}

/** "Same Wi-Fi or Tailscale". */
export const waysText = (ways: readonly NetEngineWay[]): string =>
  ways.map((way) => WAY_LABEL[way]).join(' or ')

/**
 * Why the computer in a link can't be used from here, and what to do, before anything is sent; undefined when
 * nothing says it can't (it may still work).
 */
export function cannotUse(
  name: string,
  check: NetEngineJoinCheck,
  probe: NetEngineJoinProbe | undefined
): { why: string; todo: string } | undefined {
  const usable = check.hints.filter((hint) => hint.eligibility !== 'skip')
  if (!check.hints.length || !usable.length) {
    const missing = check.hints.find((hint) => hint.local === 'no_matching_interface' && hint.way)
    if (missing?.way === 'tailnet')
      return { why: 'This computer isn’t on Tailscale.', todo: 'Turn Tailscale on here, then check again.' }
    if (missing?.way === 'lan')
      return { why: 'This computer isn’t on a network.', todo: 'Join the same Wi-Fi, then check again.' }
    return {
      why: `${name}’s code has no way this computer can use.`,
      todo: `Make a new code on ${name} with another way.`
    }
  }
  if (probe?.reachable === false) {
    const ways = linkWays(check)
    return {
      why: `${name} didn’t answer${ways.length ? ` over ${waysText(ways)}` : ''}.`,
      todo:
        ways.length === 1 && ways[0] === 'lan'
          ? `Check both are on the same Wi-Fi and Mousse is open on ${name}.`
          : `Check Mousse is open on ${name}, then check again.`
    }
  }
  return undefined
}
