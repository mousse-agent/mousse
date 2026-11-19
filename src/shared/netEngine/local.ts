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
  'netEngine.plus.signIn',
  'netEngine.plus.cancel',
  'netEngine.plus.refresh',
  'netEngine.plus.signOut',
  'netEngine.removeEverywhere.plan',
  'netEngine.removeEverywhere',
  'netEngine.removeEverywhere.answer'
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
}
