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
  'netEngine.retry',
  'netEngine.remove',
  'netEngine.address.add',
  'netEngine.loginStart'
] as const
export type NetEngineLocalMethod = (typeof NET_ENGINE_LOCAL_METHODS)[number]

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
  /** This computer's open invitations (Phase 1b: a Send link's code and tries left). */
  invites?: NetEngineInviteState[]
  /** Joins of a Send link waiting for their code (Phase 1b). */
  joins?: NetEngineJoinState[]
  /**
   * `ask`: the start-at-login question waits for this window (design §10). Answered with `netEngine.loginStart
   * {start}`; asked once per installation, while the switch is on.
   */
  loginStart?: 'ask'
}

/** An invitation this computer made, while it is open (Phase 1b §5). */
export interface NetEngineInviteState {
  invitation: string
  kind: 'in_person' | 'link'
  /** A Send link's six-digit code, read to the other person another way. */
  code?: string
  attemptsLeft?: number
  /** Why it ended (`attempts_exhausted`, `expired`, `cancelled`), shown once before it leaves the list. */
  ended?: string
}

/** A join of a Send link this computer runs, while it waits for the code typed here (Phase 1b §5). */
export interface NetEngineJoinState {
  invitation: string
  codeNeeded: boolean
  attemptsLeft?: number
  /** The last code typed did not work. */
  failed?: boolean
}

/**
 * The line `mousse-cli net-engine ssh` writes to stdout before anything else (Phase 1b §3.3): the computer that ran
 * it over SSH skips whatever a login shell printed up to it. Fixed on purpose.
 */
export const NET_ENGINE_SSH_MARKER = 'mousse-ssh/1'
