import type { NodeCapability } from './capabilities'
import type { PermissionMode } from '../permissionMode'
import type { NodeId, UserId } from './ids'
import type { Route } from './identity'
import type { KeystoreState, RosterState } from './identity'
import type { NetErrorCode } from './errors'

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
  'net.init',
  'net.disable',
  'net.status',
  'net.doctor',
  'net.protect',
  'net.unlock',
  'bridge.invite',
  'bridge.join',
  'bridge.nodes',
  'bridge.revoke',
  'bridge.rename',
  'bridge.setCaps',
  'bridge.setKind',
  'bridge.policy',
  'bridge.workOnThreads',
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
}
export interface NetStatus {
  enabled: boolean
  features?: import('../featureFlags').NetFeatureFlags
  /** Whether other computers of the user may work on this computer's threads (`bridge.workOnThreads`). On by default. */
  workOnThreads?: boolean
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
  self?: { node: NodeId; user: UserId; isAuthority: boolean }
  rosterState?: RosterState
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
export interface PlusStatus {
  configured: boolean
  connected: boolean
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
export interface NetDoctor {
  ok: boolean
  checks: Array<{ name: string; ok: boolean; code?: NetErrorCode; message: string }>
}
