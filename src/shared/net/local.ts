import type { NodeCapability } from './capabilities'
import type { PermissionMode } from '../permissionMode'
import type { NodeId, UserId } from './ids'
import type { Route } from './identity'
import type { KeystoreState, RosterState } from './identity'
import type { NetErrorCode } from './errors'
import type { TunnelFailure, TunnelPath } from './tunnel'

export const NET_LOCAL_CAPABILITY = 'net.v1'
export const NET_LOCAL_METHODS = [
  'net.plus.discover',
  'net.plus.login.begin',
  'net.plus.login.finish',
  'net.plus.configure',
  'net.plus.renew',
  'net.plus.allow',
  'net.plus.status',
  'net.plus.bind',
  'net.plus.connect',
  'net.plus.disconnect',
  'net.plus.login.cancel',
  'net.plus.enrollment.requests',
  'net.plus.enrollment.approve',
  'net.plus.enrollment.deny',
  'net.plus.enrollment.offer',
  'net.transport.list',
  'net.transport.configure',
  'net.transport.action.describe',
  'net.transport.action.apply',
  'net.transport.action.undo',
  'net.routes',
  'net.ssh.check',
  'net.ssh.trust',
  'net.ssh.plan',
  'net.ssh.list',
  'net.ssh.setup.begin',
  'net.ssh.setup.status',
  'net.ssh.setup.cancel',
  'net.ssh.setup.retry',
  'net.ssh.undo',
  'net.ssh.update',
  'net.ssh.rename',
  'net.ssh.approve',
  'net.ssh.target',
  'net.editor.ssh.status',
  'net.editor.ssh.prepare',
  'net.editor.ssh.enable',
  'net.editor.ssh.disable',
  'net.editor.ssh.ack',
  'net.editor.alias',
  'net.editor.probe',
  'net.init',
  'net.disable',
  'net.status',
  'net.doctor',
  'net.protect',
  'net.unlock',
  'bridge.invite',
  'bridge.join',
  'net.join.retry',
  'net.join.abandon',
  'net.startOver.check',
  'net.startOver',
  'net.link.make',
  'net.link.check',
  'net.link.paste',
  'bridge.nodes',
  'bridge.revoke',
  'bridge.rename',
  'bridge.setCaps',
  'bridge.setKind',
  'bridge.policy',
  'bridge.connect',
  'bridge.disconnect',
  'bridge.allow',
  'bridge.access.there',
  // One step of updating another computer (#476): `update.*` asked of it, or its version asked again.
  'net.update.there',
  'bridge.workOnThreads',
  'bridge.editorServer',
  'net.authority.transfer',
  'net.authority.status',
  'net.recovery.export',
  'net.recovery.import'
] as const
export type NetLocalMethod = (typeof NET_LOCAL_METHODS)[number]
export interface NetInitInput {
  name?: string
  listen?: boolean
  host?: string
  port?: number
  passphrase?: string
}
/** One change an add-on action will make, shown before it runs. */
export interface NetAddonChange {
  title: string
  detail: string
  command?: string
}
/** `net.transport.action.describe|apply|undo`. A refusal is a result, so its message reaches the dialog. */
export type NetAddonActionResult =
  | {
      ok: true
      changes?: NetAddonChange[]
      /** For an undo: what was found and done. `left` means something was deliberately not touched. */
      outcome?: 'removed' | 'already-removed' | 'left'
      message?: string
    }
  | {
      ok: false
      code: NetErrorCode
      message: string
      /** A command for the user to run themselves; Mousse never runs it. */
      remedy?: string
    }
/** Tailnet ports that Tailscale uses for Funnel (the public internet). Serve never uses them. */
export const TAILSCALE_FUNNEL_PORTS: readonly number[] = [443, 8443, 10000]
/** What `net.transport.list` reports about changes made through add-on actions, keyed by add-on. */
export type NetAddonRecords = Record<string, { action: string; appliedAt: number; record: unknown }>
export interface BridgeInviteInput {
  ttlMs?: number
  name?: string
  caps?: NodeCapability[]
}
/**
 * Whether another device of this user's list is connected here (`connection` on each `bridge.nodes` row, set with
 * `bridge.connect` and `bridge.disconnect`). `none`: never connected here; `disconnected`: someone disconnected it;
 * `held`: it came in by a connect link (made here, or pasted here to join it) and waits for `bridge.allow`. Until
 * connected this computer serves it nothing but the keeper's control traffic, and two members not connected on both
 * ends open no session.
 */
export type BridgeNodeConnection = 'connected' | 'disconnected' | 'held' | 'none'
/** `net.link.make`: a connect link made on this computer. */
export interface NetLinkMade {
  /** The copyable text, `ml1_…`. */
  link: string
  /** It adds a computer (this computer keeps the list); otherwise it only connects devices already in the list. */
  add: boolean
  /** This computer had no network identity: making the link created it, and it now keeps the others connected. */
  created: boolean
  expiresAt: number
  /** Some address in the link is not this computer's loopback; without one, only another copy here can use it. */
  reachable: boolean
  /** For a link that only connects: the name of the computer that adds computers. */
  keeper?: string
}
/**
 * `net.link.check`: what pasting a link here would do, read from the link alone with no network call. `join`: this
 * computer joins the maker's list. `connect`: both are in one list; nothing is enrolled. `start_over`: this computer
 * must start over first (it is alone), offered once a route answers. `refused`: `reason` says why.
 */
export interface NetLinkCheck {
  row: 'join' | 'connect' | 'start_over' | 'refused'
  add: boolean
  reason?:
    | 'connect_only'
    | 'own_link'
    | 'other_list'
    | 'join_unfinished'
    | 'space_host'
    | 'mousse_id'
    | 'live_devices'
  /** For `start_over`, and for a refusal that comes from it. */
  startOver?: NetStartOverCheck
}
/** `net.link.paste`: what the link did. The device reached is held here until Allow when this computer joined. */
export interface NetLinkPasted {
  row: 'join' | 'connect'
  /** The computer that made the link. */
  node: NodeId
  name?: string
  connection: BridgeNodeConnection
  /** For a join: whether the first session opened in time. */
  connected?: boolean
}
/**
 * What this computer lets another device do here (`bridge.policy`, and `policy` on each
 * `bridge.nodes` row). It is kept on this computer only, so every computer sets its own.
 */
export interface BridgeNodePolicy {
  /** Every Bridge call, stream and routed call from the device is refused. */
  blocked: boolean
  /** The most permissive permission mode a person on the device can run a turn or rule in. */
  maxPermissionMode: PermissionMode
  /** The device may open terminals on this computer. */
  terminal: boolean
  /**
   * The device may open its editor on a folder of this computer: an SSH login on this computer's own SSH
   * server, carried over Mousse Net. Shell access as the user, like a terminal. Off until the owner turns it on.
   */
  editor: boolean
  /**
   * The device may reach this computer's personal bots, each within its own Devices choice. On until the owner turns
   * it off. Absent from a service from before the switch.
   */
  bots?: boolean
  /**
   * Which threads here the device's agents may change with calls marked as an agent's: none, the threads its agents
   * started here (the default), or all. Absent from a service from before the setting.
   */
  agentReach?: AgentReach
  /**
   * The device may work on threads here ("Work on threads from this device"): start, send, steer, stop, change
   * settings, files and Git, and make or change bots. Off, it reads threads and chats with bots only. On until the
   * owner turns it off. Absent from a service from before the switch.
   */
  work?: boolean
}

/**
 * `bridge.access.mine`, a call one computer makes on another of its user's: what the computer that answers lets the
 * caller do there now. Each field is the result of the same checks a real call from the caller meets there (connected
 * there, the block, the grant, "Let my other computers work here", the per-device switches). A caller that
 * is not connected there is refused (`forbidden`, reason `not_connected`).
 */
export interface BridgeAccessMine {
  v: 1
  /** Every Bridge call from the caller is refused there. */
  blocked: boolean
  /** Reads threads there. */
  threads: boolean
  /** Starts and works on threads there, up to `maxPermissionMode`. */
  work: boolean
  terminal: boolean
  editor: boolean
  /** Reaches that computer's bots (each bot's own Devices choice still applies). */
  bots: boolean
  maxPermissionMode: PermissionMode
  agentReach: AgentReach
}
/**
 * `bridge.access.there { node }`: `bridge.access.mine` asked of `node`. `not_connected`: that computer has not connected
 * this one. `unknown`: it could not answer now (`offline`), or runs a build without the call (`older`).
 */
export type BridgeAccessThere =
  | { state: 'known'; access: BridgeAccessMine }
  | { state: 'not_connected' }
  /** It answered, and refused this computer the question: its grant there covers nothing. */
  | { state: 'refused' }
  | { state: 'unknown'; reason: 'offline' | 'older' }

/** What a device's agents may change on this computer (`net_node_policy.agent_reach`). */
export type AgentReach = 'none' | 'launched' | 'all'
export const AGENT_REACHES: readonly AgentReach[] = ['none', 'launched', 'all']
export const isAgentReach = (value: unknown): value is AgentReach =>
  (AGENT_REACHES as readonly unknown[]).includes(value)
export interface NetStatus {
  enabled: boolean
  features?: import('../featureFlags').NetFeatureFlags
  /** Whether other computers of the user may work on this computer's threads (`bridge.workOnThreads`). On by default. */
  workOnThreads?: boolean
  /**
   * Which SSH server answers editor connections from other computers (`bridge.editorServer`): `system` is the
   * owner's choice "Use this computer's SSH server", and `available` says whether Mousse's own endpoint can
   * answer here at all (not on a Windows computer whose helper is missing or does not run, where the system's server
   * is the one).
   */
  editorServer?: { system: boolean; available: boolean }
  restartRequired?: boolean
  keystore: KeystoreState | 'unavailable'
  transports?: Array<{
    id: string
    enabled: boolean
    state: 'disabled' | 'provisioning' | 'ready' | 'degraded' | 'failed'
    routes: Route[]
    error?: NetErrorCode
    /** Why the add-on is not ready, in words for the user. */
    detail?: string
  }>
  protected?: boolean
  /** The keys are protected by a passphrase; `net.protect` without one moves them to the system keychain. */
  passphraseProtected?: boolean
  /**
   * The system keychain refused to protect network keys (it is missing, or access was denied). Until
   * Mousse restarts, only a passphrase can protect them.
   */
  vaultUnavailable?: boolean
  /**
   * `removed`: this computer was removed from the user's devices and cannot reconnect with this
   * identity. Signing in to Mousse ID sets it aside and adds the computer back as a new one.
   */
  self?: { node: NodeId; user: UserId; isAuthority: boolean; removed?: true }
  rosterState?: RosterState
  /**
   * A join sent to another computer whose answer never came back (no identity yet). `name` is that
   * computer's; `net.join.retry` asks again with the same keys, `net.join.abandon` gives up.
   */
  unfinishedJoin?: { name?: string; expiresAt?: number }
  routes: Route[]
  peers: Array<{ node: NodeId; state: 'connecting' | 'open' | 'closed'; error?: NetErrorCode }>
  error?: NetErrorCode
}
/** One Mousse ID service binding for this computer, as `net.plus.configure` takes it. */
export interface PlusConfiguration {
  apiOrigin: string
  audience: string
  installationId: string
  accountId: string
  gatewayId: string
}
/** `net.plus.status`. Not configured (and never connected) when the Mousse ID module is absent. */
/**
 * Whether this computer may start over with a new identity, as `net.startOver.check` answers.
 */
export interface NetStartOverCheck {
  /** It was removed, no other device holds a pass in its list, or its own pass lapsed past renewal. */
  allowed?: 'removed' | 'alone' | 'lapsed'
  /** It hosts a Space, is signed in to Mousse ID, or other devices still hold a pass in its list. */
  refused?: 'space_host' | 'mousse_id' | 'live_devices'
  /** It keeps the list; its key stays in the set-aside folder. */
  keeper: boolean
  /** The Spaces it hosts, when that is why it is refused. */
  hosted?: string[]
  /** The other devices that still hold a pass in its list. */
  live?: string[]
  /** The Spaces it belongs to, to join again afterwards. */
  spaces: string[]
}
export interface PlusStatus {
  configured: boolean
  connected: boolean
  /**
   * Still signed in, but the short relay registration lapsed (after sleep or time offline) and the
   * daemon is renewing it. Only a computer Mousse ID refused, with this unset, needs a new sign-in.
   */
  reconnecting?: boolean
  accountId?: string
  /** Display-only, from the sign-in grant when Mousse ID sends it. */
  email?: string
  plan?: string
  audience?: string
  expiresAt?: number
  registrationId?: string
  generation?: number
  /**
   * Computers and phones on this account against the plan's limit, read from Mousse ID when this
   * computer signed in. Display-only; it can be out of date until the next sign-in.
   */
  devices?: { used: number; limit: number }
  /**
   * Why this computer is not signed in. `list_merged`: Mousse ID moved the account's devices onto
   * one list and this computer's list was folded into it; signing in again joins that list.
   */
  reason?: 'list_merged'
}
/** A phone asking to join through Mousse ID, as `net.plus.enrollment.requests` returns it. */
export interface PlusEnrollmentRequestView {
  id: string
  deviceName: string
  kind: 'phone' | 'computer'
  boxPublicKey: string
  transportFingerprint: string
  createdAt: number
  expiresAt: number
  /** Six digits the phone also shows; computed locally, never by Mousse ID. */
  matchCode: string
}
export interface PlusEnrollmentOffer {
  offerId: string
  /** `mousse://net/join?...` payload for the QR code. Contains the one-time key. */
  url: string
  inviteId: string
  expiresAt: number
}
/** Why a remote machine check stopped; the dialog shows `detail` and picks its remedy from this. */
export type SshCheckProblem =
  'invalid_host' | 'proxy_refused' | 'unreachable' | 'host_key_revoked' | 'host_key_failed'

export interface SshHostKeyView {
  type: string
  /** `SHA256:…`, what `ssh-keygen -l` prints for the key the host offered. */
  fingerprint: string
  state: 'unknown' | 'trusted' | 'changed' | 'revoked'
  changed?: { previousFingerprint: string; file: string }
  /** Files that hold an older key for this host; ssh accepts the host while another file has the new one. */
  stale?: Array<{ file: string; previousFingerprint: string }>
  /** The host is already known to the terminal by keys of these types. */
  knownByOtherTypes?: string[]
}
export interface SshPrerequisite {
  name: string
  ok: boolean
  /** The probe could not tell; it never blocks setup. */
  indeterminate?: boolean
  remedy?: string
}
export type SshOwner = 'none' | 'managed' | 'external'
export interface SshInstalledView {
  cli: { owner: SshOwner; version?: string; path?: string }
  service: { owner: SshOwner; state?: 'running' | 'stopped' }
}
/**
 * `net.ssh.check`. Two phases and the trust boundary between them: phase `untrusted` only reads
 * `ssh -G` and retrieves the host key, and never authenticates or runs a command on the host.
 */
export interface SshCheckResult {
  ok: boolean
  phase: 'untrusted' | 'probed'
  host: string
  resolved?: { hostname: string; port: number; user: string }
  hostKey?: SshHostKeyView
  os?: string
  arch?: string
  home?: string
  installed?: SshInstalledView
  /** The host already belongs to a device set. */
  enrolled?: boolean
  /** The device id a running Mousse on the machine reports for itself. */
  hostNode?: string
  /** `loginctl` linger for the user: whether a user service survives logout. */
  linger?: 'yes' | 'no'
  prerequisites: SshPrerequisite[]
  auth?: 'ok' | 'denied' | 'unreachable'
  /** The command that installs this computer's key on the host, shown when the key was denied. */
  copyId?: string
  problem?: SshCheckProblem
  detail?: string
}
export interface SshTrustResult {
  ok: boolean
  state: SshHostKeyView['state']
  /** Why nothing was written. */
  detail?: string
}
export interface SshPlanStep {
  id: string
  title: string
  detail: string
  command?: string
}
export interface SshPlan {
  steps: SshPlanStep[]
  blocked?: Array<{ name: string; remedy: string }>
}
/** `net.ssh.setup.begin`: an id when the setup started, otherwise why it did not. */
export interface SshBeginResult {
  id?: string
  error?: string
}
export type SshSetupPhase = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'
export interface SshSetupStatus {
  id: string
  phase: SshSetupPhase
  /** The step that is running, or the last one that ran. */
  step?: string
  progress?: string
  error?: string
  node?: NodeId
  /** Undo and Retry are offered. */
  recoverable: boolean
  /** The daemon will not start after a reboot until this command is run on the host. */
  lingerCommand?: string
  steps: Array<{ step: string; state: 'pending' | 'done' | 'failed' | 'unknown' | 'skipped' }>
}
export interface SshUndoResult {
  ok: boolean
  report: Array<{ step: string; result: 'undone' | 'left' | 'skipped'; detail: string }>
  /** What to run on the machine by hand; Mousse never deletes its data directory or identity. */
  commands: string[]
}
export interface SshUpdateResult {
  ok: boolean
  version?: string
  /** A machine Mousse did not install is updated by running this on it. */
  command?: string
  detail?: string
}
/** One machine this computer set up or approved over SSH. */
export interface SshRecordView {
  id: string
  endpoint: string
  node?: NodeId
  phase: SshSetupPhase
  owner: SshOwner
  version?: string
  recoverable: boolean
  createdAt: number
  updatedAt: number
}
/** Why Mousse's ssh settings for editors could not be written or used. */
export type EditorSshProblemCode =
  | 'unavailable'
  | 'off'
  | 'unsafe_path'
  | 'unreadable'
  | 'unwritable'
  | 'bad_value'
  | 'unknown_computer'
  /** The system ssh could not read what Mousse wrote, so the line was not added (or was taken out again). */
  | 'ssh_check_failed'
  | 'no_ssh'
  /** `~/.ssh/config` belongs to another account on macOS or Linux. */
  | 'not_owner'
  /** The line is in the file but below a `Host` or `Match` line. */
  | 'scoped'

/** One computer an editor can reach through an ssh alias. */
export interface EditorSshComputer {
  node: NodeId
  /** The `Host` name an editor opens, such as `mousse-workbox-3fa2c1`. It never changes. */
  alias: string
  name: string
  /** The login name on that computer, once it has said it. */
  user?: string
  /** Its host key is pinned, so ssh connects without a trust-on-first-use question. */
  hostKeyPinned: boolean
}

/**
 * `net.editor.ssh.status` and the `status` of every other `net.editor.ssh.*` answer. Mousse keeps a
 * config file of its own and one `Include` line for it in `~/.ssh/config`.
 */
export interface EditorSshStatus {
  /** False when this build gives the service no home directory to write to. */
  available: boolean
  /** False after the person undid the setup, until they turn it on again. */
  enabled: boolean
  /** The user's `~/.ssh/config` carries the line where `ssh` applies it to every host. */
  included: boolean
  /** The line is there but below a `Host` or `Match` line, so `ssh` reads it for that block only. */
  scoped?: boolean
  /** The line is in force but edited (a comment added, another file on the same line), so undo cannot remove it. */
  edited?: boolean
  includeLine: string
  userConfig: string
  mousseConfig: string
  knownHosts: string
  /** The line was added and the person has not yet seen `notice`. */
  noticePending: boolean
  notice?: string
  computers: EditorSshComputer[]
  problem?: { code: EditorSshProblemCode; message: string }
}

/**
 * `net.editor.probe { node }`: whether an editor connection to that computer can be opened now. It opens one
 * and closes it at once, so what a refusal says is what the editor's own connection would meet, in the fixed
 * words of the tunnel (`editor_off`, `no_ssh_server`...). Nothing else is sent through it.
 */
export type EditorProbeResult =
  | { ok: true; path: TunnelPath; transport?: string }
  | {
      ok: false
      /** The tunnel's reason, or `ssh_settings` when this computer's own editor settings were not ready (`code`). */
      reason: TunnelFailure | 'ssh_settings'
      message: string
      code?: EditorSshProblemCode
    }

/** `prepare`, `enable` and `disable`: the new status, or why nothing changed. */
export type EditorSshResult =
  | {
      ok: true
      /** This call added the line, so the notice is due. */
      added: boolean
      /** For `disable`: how many Mousse lines were removed. */
      removed?: number
      /**
       * For `disable`: a line that names Mousse's file is still in `~/.ssh/config` because the person
       * edited it. Mousse left it; show `status.includeLine` and say to remove it by hand.
       */
      leftover?: boolean
      status: EditorSshStatus
    }
  | { ok: false; code: EditorSshProblemCode; message: string; status: EditorSshStatus }

export interface NetDoctor {
  ok: boolean
  checks: Array<{ name: string; ok: boolean; code?: NetErrorCode; message: string }>
}
