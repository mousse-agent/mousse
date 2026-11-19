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
  'netEngine.link.read',
  'netEngine.retry',
  'netEngine.remove',
  'netEngine.address.add'
] as const
export type NetEngineLocalMethod = (typeof NET_ENGINE_LOCAL_METHODS)[number]

/** Where a destination is, as the join dialog labels it (design 1b §1.2): LAN, Tailnet, Internet or Tunnel. */
export type NetEngineRouteClass = 'lan' | 'tailnet' | 'public' | 'tunnel'

export interface NetEngineDestination {
  route: string
  class: NetEngineRouteClass
}

/** A Send link's ticket as this computer reads it before Connect (`netEngine.link.read`). */
export interface NetEngineLinkFacts {
  invitation: string
  /** 2 for a Send link; a scanned code is 1. */
  kind?: number
  /** The start of the host's endpoint id. */
  host: string
  expiresAt?: number
  /** The destinations Connect lets this computer contact (§1.3); LAN addresses need no approval. */
  destinations: NetEngineDestination[]
}

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
  /** Addresses added for it by hand (`tcp://host:port`); none means it is found on the local network. */
  addresses?: string[]
  /** A Send link it consented to did not finish (no code confirmed, or the outcome was lost): Retry or Remove. */
  unfinished?: boolean
  /** That link is still valid, so Retry may ask for the code again. */
  linkValid?: boolean
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
  /** The helper speaks protocol 1.1, so Send link and Enter link work. */
  sendLink?: boolean
  /** Send links this computer shows. */
  links?: NetEngineLinkInvite[]
  /** Send link joins running here. */
  joins?: NetEngineLinkJoin[]
  /** This computer's tailnet, public and tunnel routes, which "Also share" may send in pairback (§1.3). */
  shareable?: NetEngineDestination[]
}
