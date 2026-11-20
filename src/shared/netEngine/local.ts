import type { RouteClass } from './routes'

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
  'netEngine.loginStart',
  // "Work on threads", the safety switch, while v1 networking is off (its Devices group has it otherwise)
  'netEngine.workOnThreads',
  // Phase 1b: routes (§1.3, §1.5, §4.3)
  'netEngine.address.remove',
  'netEngine.address.use',
  'netEngine.join.preview',
  'netEngine.routes.config',
  'netEngine.routes.test',
  // Phase 1b: Add over SSH (§3.4)
  'netEngine.ssh.resolve',
  'netEngine.ssh.probe',
  'netEngine.ssh.trust',
  'netEngine.ssh.profiles',
  'netEngine.ssh.connect'
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
  /** Addresses added for it by hand (routes of any owner kind); none means it is found on the local network. */
  addresses?: string[]
  /** The class of the route its connection runs over now (`conn.up.route`), while one is up. */
  route?: RouteClass
  /** Routes it offered in pairback that need the owner's Use before they are dialled (§1.3 suggestions). */
  offered?: string[]
  /** It was added over SSH (§3.4): one way only, until a Send link adds the other direction. */
  source?: 'ssh'
  /** Added over SSH, one way: `out`, this computer uses it; `in`, it uses this computer (§3.6). */
  direction?: 'out' | 'in'
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
  /** The loopback port a tunnel client forwards to, while a tunnel is set. */
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
  destinations: Array<{ route: string; label: string; cls: RouteClass; automatic: boolean }>
  /** This computer's tailnet and public routes and tunnels: pairback sends one only when ticked. */
  shareable: Array<{ route: string; label: string; cls: RouteClass }>
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
  /** The helper speaks protocol 1.1, so Send link and Enter link work. */
  sendLink?: boolean
  /** Send links this computer shows. */
  links?: NetEngineLinkInvite[]
  /** Send link joins running here. */
  joins?: NetEngineLinkJoin[]
}

