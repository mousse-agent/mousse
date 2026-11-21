import type { RouteClass, TicketDestination } from './routes'

/**
 * The daemon methods a Mousse window calls for the new networking (Phase 1a): the switch, the devices and their
 * pairing. They are local only: a window of this computer calls them, and no paired computer can (they are not on
 * `ENGINE_OWNER_METHODS`).
 */
export const NET_ENGINE_LOCAL_METHODS = [
  'netEngine.status',
  'netEngine.enable',
  'netEngine.disable',
  'netEngine.invite',
  'netEngine.invite.cancel',
  'netEngine.approve',
  'netEngine.join',
  'netEngine.join.code',
  'netEngine.retry',
  'netEngine.remove',
  'netEngine.address.add',
  'netEngine.plus.signIn',
  'netEngine.plus.cancel',
  'netEngine.plus.refresh',
  'netEngine.plus.signOut',
  'netEngine.removeEverywhere.plan',
  'netEngine.removeEverywhere',
  'netEngine.removeEverywhere.answer',
  'netEngine.loginStart',
  // "Work on threads", the safety switch, while v1 networking is off (its Devices group has it otherwise)
  'netEngine.workOnThreads',
  // Phase 1b: routes (§1.3, §1.5, §4.3)
  'netEngine.address.remove',
  'netEngine.address.use',
  'netEngine.join.preview',
  'netEngine.routes.config',
  'netEngine.routes.test',
  'netEngine.cloudflare.connect',
  'netEngine.cloudflare.stop',
  'netEngine.cloudflare.forget',
  // Phase 1b: Add over SSH (§3.4)
  'netEngine.ssh.resolve',
  'netEngine.ssh.probe',
  'netEngine.ssh.trust',
  'netEngine.ssh.profiles',
  'netEngine.ssh.connect',
  // Phase 3: relays (§B.9, §B.11)
  'netEngine.relay.enroll',
  'netEngine.relay.remove',
  'netEngine.relay.rotate',
  'netEngine.relay.allow',
  'netEngine.relay.disallow',
  'netEngine.relay.dismiss'
] as const
export type NetEngineLocalMethod = (typeof NET_ENGINE_LOCAL_METHODS)[number]

/** A Send link this computer shows (§5.1): the code to read out and the tries left, until it ends. */
export interface NetEngineLinkInvite {
  invitation: string
  code: string
  attemptsLeft: number
  expiresAt?: number
  /** Why it ended: `used`, `attempts_exhausted`, `expired`, `cancelled`. */
  ended?: string
  /** The pairing it made, once the other computer was let in. */
  node?: string
}

/** A Send link join running here (§5.3): whether it waits for the code, and the tries left. */
export interface NetEngineLinkJoin {
  invitation: string
  node?: string
  needsCode: boolean
  attemptsLeft?: number
  /** The last code typed did not work. */
  wrong?: boolean
}

/**
 * The default of the engine limit `scanIntervalMs` (`MOUSSE_NET_ENGINE_SCAN_INTERVAL_MS`). A window uses the value in
 * the daemon's status; this only until the status arrives.
 */
export const DEFAULT_SCAN_INTERVAL_MS = 200

/**
 * The SSH refusals that park a pairing (1b §1.4): the helper's `dial.failed` carries one in `why` with `retry_ms`
 * null, and no login is tried again on its own (repeated denied logins trip fail2ban and `ufw limit`).
 */
export const NET_ENGINE_SSH_PARKED = ['auth_denied', 'host_key_changed', 'host_key_unknown'] as const
export type NetEngineSshParked = (typeof NET_ENGINE_SSH_PARKED)[number]

export const isSshParked = (why: unknown): why is NetEngineSshParked =>
  (NET_ENGINE_SSH_PARKED as readonly unknown[]).includes(why)

/** Where one paired computer is, as its row in Settings → Devices reads (design §5.2). */
export type NetEngineDeviceState =
  /** Both directions work. */
  | 'connected'
  /** The ceremony has not finished (`consented`, `joined`, `granted`, `awaiting_pairback`). */
  | 'finishing'
  /**
   * Paired, and one direction is up while the other is not, yet or again. Once that has held for `rowStuckMs`,
   * `unreachable` names the direction that is down.
   */
  | 'connecting'
  /** Paired, and no connection is up just now. */
  | 'offline'
  /** Removal is under way. */
  | 'removing'

export interface NetEngineDevice {
  /** This computer's id for the pairing (what the picker and `bridge.policy` use). */
  node: string
  name: string
  /** The start of the other computer's endpoint id, to tell two computers of one name apart. */
  shortId: string
  state: NetEngineDeviceState
  /** Whether a connection to it is up and ready for calls. */
  online: boolean
  /** It refuses this computer (it removed it, or never let it in): only Remove helps. */
  notAccepted?: boolean
  /** Pairing has been finishing for longer than it should (`rowStuckMs`): Retry and Remove are offered. */
  stuck?: boolean
  /**
   * One direction has been down for `rowStuckMs` while the other works: `in`, it cannot reach this computer;
   * `out`, this computer cannot reach it.
   */
  unreachable?: 'in' | 'out'
  /** Its last connection attempt failed on a certificate outside its validity window (either clock may be wrong). */
  certificateWindow?: boolean
  /**
   * Its SSH login failed in a way only the owner can fix (§1.4): nothing logs in again until the owner checks it
   * and presses Retry.
   */
  sshParked?: NetEngineSshParked
  /** Addresses added for it by hand (routes of any owner kind); none means it is found on the local network. */
  addresses?: string[]
  /** The class of the route its connection runs over now (`conn.up.route`), while one is up; `relay` through one. */
  route?: RouteClass | 'relay'
  /** While connected through a relay: the relay's `host:port`. */
  via?: string
  /** Routes it offered in pairback that need the owner's Use before they are dialled (§1.3 suggestions). */
  offered?: string[]
  /** Its SSH route as the owner typed it (`user@host` or an alias), when one was set up for it over SSH. */
  ssh?: string
  /** It was added over SSH (§3.4): one way only, until a Send link adds the other direction. */
  source?: 'ssh'
  /** Added over SSH, one way: `out`, this computer uses it; `in`, it uses this computer (§3.6). */
  direction?: 'out' | 'in'
  /** A Send link it consented to did not finish (no code confirmed, or the outcome was lost): Retry or Remove. */
  unfinished?: boolean
  /** That link is still valid, so Retry may ask for the code again. */
  linkValid?: boolean
  /** Its relays (Phase 3), when anything about them needs showing. */
  relay?: NetEngineDeviceRelay
}

/** What a device's row shows about relays (Phase 3 §B.5, §B.11). */
export interface NetEngineDeviceRelay {
  /** Relay destinations (`relay://host:port`) it can be reached through that wait for Allow. */
  offered?: string[]
  /** Relay destinations allowed for it (by a ticket, the owner or Allow) that can be taken back. */
  allowed?: string[]
  /** The relay info it sent (its manifest) has expired: its routes are tried last until it sends new info. */
  stale?: boolean
  /**
   * It is past this computer's relay limit (a relay lists its first `callersMax` callers): it can't reach this
   * computer through one. `callersMax` as this computer's relays name it, when one does.
   */
  limit?: { callersMax?: number }
}

/** One of this computer's own relays (Phase 3 §B.9), as Settings → Reach lists it. */
export interface NetEngineRelay {
  /** The relay's id, hex. */
  id: string
  /** `host:port`. */
  endpoint: string
  state: 'registered' | 'connecting' | 'retrying' | 'refused'
  /** Why the last registration ended, while retrying or refused (`relay_unreachable`, …). */
  reason?: string
  /** When the next registration starts, ms since 1970, while retrying. */
  retryAt?: number
  /** Callers listed with the relay, and the most it lists (as the helper says; absent when it says none). */
  callers: number
  callersMax?: number
  /** While a new relay key is taking over: when the old one stops, ms since 1970. */
  rotatingUntil?: number
  /** A new relay key is asked for and the relay has not taken it yet. */
  newKeyPending?: boolean
  /** That new key is being cancelled (`relay.rotate {cancel}`). */
  cancelling?: boolean
  /** The relay holds as many keys as it allows: New relay key waits until `chainFullUntil` (ms since 1970). */
  chainFull?: boolean
  chainFullUntil?: number
}

/** What a relay error word (`relay.enroll`'s refusal, a registration's end) means, as Settings says it. */
export const RELAY_REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  bad_link: "That isn't a relay link.",
  already: 'This relay is already added.',
  unavailable: "Relays can't run on this computer.",
  relay_unreachable: "Couldn't reach the relay.",
  relay_refused: "Couldn't reach the relay.",
  relay_key: "The relay's key doesn't match the link.",
  relay_tls: "Couldn't connect securely to the relay.",
  relay_timeout: "The relay didn't answer.",
  relay_protocol: 'The relay answered something unexpected.',
  relay_not_authorized: 'This link was used already, or has expired.',
  relay_removed: 'The relay no longer lists this computer.',
  relay_replaced: 'Another registration took this one’s place.',
  relay_stopping: 'The relay is restarting.',
  relay_limit: 'The relay is full.',
  relay_closed: 'The relay closed the connection.',
  store_failed: "Couldn't save the relay.",
  no_relay: 'That relay was removed.',
  not_registered: "The relay isn't connected; try again once it is.",
  rotating: 'A new key is already on its way.',
  not_rotating: 'No new key is on its way.',
  chain_full: 'Too many key changes. Try again later.'
})

/** This computer's own relays, when its helper has relays. */
export interface NetEngineRelays {
  /** False when relays can't run here (no keystore). */
  available: boolean
  list: NetEngineRelay[]
}

/** A computer asking to join this one, waiting for this computer's window to answer (§5.1 step 3). */
export interface NetEngineApproval {
  request: string
  invitation: string
  /** The name it gave ("<computer> (<profile>)"). */
  name: string
  /** The start of its endpoint id. */
  device: string
}

/** One class of the paid relay (typing, or copies) as the helper's blocks stand. */
export interface NetEngineRelayClass {
  /** `funded`: blocks are held; `paused`: its refill failed or is late (copies only); `unfunded`: none held. */
  state: 'funded' | 'paused' | 'unfunded'
  bytesLeft: number
  /** How long the held blocks last at the recent rate, or until they expire; also through a Plus outage. */
  lastsSecs?: number
  /** Why the last refill failed (`allowance_used`, `balance_empty`, ...). */
  refillError?: string
}

/** A Plus balance (bytes). */
export interface NetEnginePlusPool {
  allowance?: number
  available?: number
  debt?: number
}

/** Mousse Plus as this computer's helper sees it (Phase 4, M16). */
export interface NetEnginePlus {
  /** This build has a Plus address. */
  configured: boolean
  /** This computer is signed in to Plus. */
  linked: boolean
  /** Sign-in in progress: the code to type on the Plus website, and where. */
  link?: { userCode: string; verifyUrl: string; expiresAt: number }
  /** How the last sign-in ended: `approved`, `denied`, `expired`, `gone` (start again) or `unlinked`. */
  linkResult?: string
  /** `active`, `past_due`, `cancelled` or `none`. */
  plan?: string
  periodEndsAt?: number
  bulk?: NetEnginePlusPool
  interactive?: NetEnginePlusPool
  /** Plus can't be reached since this time (Unix seconds). */
  unreachableSince?: number
  /** The paid relay, per class, while this computer uses one. */
  relay?: { interactive?: NetEngineRelayClass; bulk?: NetEngineRelayClass }
}

/** One removal sent from this computer for one host ("Remove on all my hosts", design D.3). */
export interface NetEngineRemoval {
  id: string
  /** The host's endpoint id, and its name here when this computer knows it. */
  host: string
  hostName?: string
  /** The removed device's endpoint id and name. */
  removed: string
  name: string
  grant: number
  /** `waiting`, `sent`, `quota`, `delivered`, `done` or `expired`. */
  state: string
  /** With `done`: `applied`, `stale` or `refused`. */
  result?: string
}

/** A host that learned the removed device later: the user is asked again (design D.1). */
export interface NetEngineRemovalAsk {
  identity: string
  name: string
  host: string
  hostName?: string
  grant: number
}

/** One host in "Remove on all my hosts": the grant id its last list named for the device, or none. */
export interface NetEngineRemovalHost {
  host: string
  name: string
  grant: number | null
}

/** This computer's own routes (§1.5): what its helper listens on and advertises. */
export interface NetEngineReach {
  lan: boolean
  tailnet: boolean
  /** Port forwards, as `tcp://<public host>:<port>` routes. */
  public: string[]
  /** The LAN address the router forwards to, when port forwarding without LAN. */
  forwardTo?: string
  /** Tunnel URLs, as `wss://…/mousse-net/1` routes. */
  tunnels: string[]
  /** The kept TCP port. */
  port?: number
  /** The loopback port a tunnel client forwards to, when the helper has opened it. */
  wsPort?: number
  /** Addresses the helper could not bind yet (it retries them). */
  unbound?: string[]
}

/** What a ticket asks before Connect (§1.3): where it will dial, and what this computer may also share. */
export interface NetEngineJoinPreview {
  /** The name the link gives the other computer, if any. */
  name?: string
  /** 1: shown in person (QR); 2: sent as a link. */
  kind: number
  /** The invitation id (hex): a Send link join's code requests and status name it. */
  invitation?: string
  /** The ticket has expired by this computer's clock. */
  expired?: boolean
  /** Every hint this computer would dial, with its class; the non-automatic ones are what Connect approves. */
  destinations: TicketDestination[]
  /** This computer's tailnet and public routes and tunnels: pairback sends one only when ticked. */
  shareable: Array<{ route: string; label: string; cls: RouteClass }>
}

export interface NetEngineCloudflare {
  state: 'off' | 'preparing' | 'sign_in' | 'connecting' | 'connected' | 'reconnecting' | 'failed'
  hostname?: string
  canForget?: boolean
  loginUrl?: string
  message?: string
}

export interface NetEngineStatus {
  /** The switch, as saved for this profile. */
  enabled: boolean
  /** The engine runs and serves this profile's pairings now. */
  on: boolean
  /** The helper process: `off`, `starting`, `running`, `restarting`, `not_in_build`, `mismatch` or `failed`. */
  helper: { state: string; text?: string }
  /** Why networking is paused (a removal not saved yet), while it is. */
  paused?: string
  /** This endpoint's id, once its helper said hello. */
  identity?: string
  devices: NetEngineDevice[]
  /** Computers waiting for Yes or No. */
  approvals: NetEngineApproval[]
  /** Where this computer listens (`tcp://host:port`), for Add address on the other computer. */
  routes?: string[]
  /** Another profile under this OS account has the new networking on too, so they can read each other's keys. */
  sharedAccount?: boolean
  /** How often Add device reads a camera frame for a pairing code (the engine limit `scanIntervalMs`). */
  scanIntervalMs?: number
  /** Mousse Plus, once the helper said. */
  plus?: NetEnginePlus
  /** "Remove on all my hosts": what was sent, and the questions waiting. */
  removals?: NetEngineRemoval[]
  removalAsks?: NetEngineRemovalAsk[]
  /**
   * `ask`: the start-at-login question waits for this window (design §10). Answered with `netEngine.loginStart
   * {start}`; asked once per installation, while the switch is on.
   */
  loginStart?: 'ask'
  /**
   * "Let my other devices work here" (on unless turned off), set while v1 networking is off: this group shows the
   * switch then (`netEngine.workOnThreads {enabled}`), and v1's Devices group shows it otherwise. One setting.
   */
  workOnThreads?: boolean
  /** This computer's own routes, when its helper speaks protocol 1.1. */
  reach?: NetEngineReach
  cloudflare?: NetEngineCloudflare
  /** The helper speaks protocol 1.1, so Send link and Enter link work. */
  sendLink?: boolean
  /** Send links this computer shows. */
  links?: NetEngineLinkInvite[]
  /** Send link joins running here. */
  joins?: NetEngineLinkJoin[]
  /** This computer's own relays, when its helper has relays (Phase 3). */
  relays?: NetEngineRelays
}

