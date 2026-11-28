import { randomBytes } from 'node:crypto'
import { NetError } from '../../../shared/net/errors'
import { isSshParked, type NetEngineSshParked } from '../../../shared/netEngine/local'
import { helperCode, helperWhy } from '../helper/appChannel'
import type { EngineHelper } from '../helper/connections'
import { engineControl, engineLimits } from '../limits'
import { handedRoutes } from '../routes'
import type { EnginePeerRow, EnginePeerStore, EngineSshJournal } from '../store'

/** `ssh.resolve`'s answer. */
export interface SshResolved {
  routeId: string
  user: string
  hostname: string
  port: number
  pinned: boolean
}

/** `ssh.probe`'s answer: the host key to confirm. */
export interface SshProbe {
  keyType: string
  sha256: string
  inUserKnownHosts: boolean
}

/** B's `profiles` reply (§3.4 step 2). */
export interface SshProfiles {
  computer: string
  os: string
  startsAtLogin: boolean
  profiles: Array<{ selector: string; label: string; networking: boolean; identity?: string }>
  /** The shell B's SSH server ran the session in, as the helper learned it (§3.3). */
  shell: SshShell
}

/** The remote shells the helper reaches B through (§3.3): POSIX `sh`, or Windows OpenSSH's `cmd` or PowerShell. */
export type SshShell = 'sh' | 'cmd' | 'powershell'

/** The shell an `ssh.run` answer names; none (a helper from before Windows remotes) means `sh`. */
export function shellOf(answer: { shell?: unknown }): SshShell {
  return answer.shell === 'cmd' || answer.shell === 'powershell' ? answer.shell : 'sh'
}

/** The SSH add's limits (1b §13.3), app side. */
export interface SshLimits {
  deadlineMs: number
  maxAgeSecs: number
}

export interface SshAddPort {
  peers: EnginePeerStore
  helper(): EngineHelper | undefined
  /** This computer's helper identity and name, as B's grant names it. */
  identity(): string
  name(): string
  limits(): SshLimits
  changed(): void
  /** Seconds since 1970. */
  now(): number
  /** A dial failed on a login only the owner can fix (§1.4): the pairing shows it and is not dialled on its own. */
  park?(node: EnginePeerRow['localId'], why: NetEngineSshParked): void
  /** The owner trusted the host key of `routeId` (`host`): parked logins to that host may be tried again. */
  trusted?(routeId: string, host?: string): void
}

/** §3.5: each reason as one line, `<host>` and `<user>` filled in. */
export function sshErrorText(reason: string, host = 'the other computer', user = 'you'): string {
  switch (reason) {
    case 'auth_denied':
      return 'SSH sign-in was refused. Mousse uses your SSH keys or agent, never a password.'
    case 'host_key_changed':
      return `${host}'s SSH key changed.`
    case 'host_key_unknown':
    case 'probe_again':
      return `Check ${host}'s SSH key first.`
    case 'remote_not_installed':
      return `Mousse isn't installed for ${user} on ${host}, or needs an update. Install or update it there, then open it once.`
    case 'remote_not_running':
      return `Mousse isn't running for ${user} on ${host}. Sign in there and open it once.`
    case 'remote_no_endpoint':
      return `That profile is gone on ${host}.`
    case 'removed':
      return `${host} removed this computer's access.`
    case 'ssh_proxy_unsupported':
      return "Jump hosts aren't supported yet."
    case 'windows_remote_unsupported':
      return "Adding a Windows computer over SSH isn't supported yet."
    case 'unreachable':
    case 'timeout':
      return `Couldn't reach ${host} over SSH.`
    default:
      return `Mousse on ${host} didn't answer as expected.`
  }
}

/** The §3.5 reasons the helper's `ssh.*` replies name, each with its own line in `sshErrorText`. */
const SSH_REASONS = new Set([
  'auth_denied',
  'host_key_changed',
  'host_key_unknown',
  'probe_again',
  'remote_not_installed',
  'remote_not_running',
  'remote_no_endpoint',
  'remote_failed',
  'removed',
  'ssh_proxy_unsupported',
  'windows_remote_unsupported',
  'unreachable',
  'timeout'
])

/**
 * A helper's or B's refusal, as a NetError carrying its §3.5 reason. A helper reply names its reason as its code and
 * the remote's own output as its text (`'exec' is not recognized…` from a Windows remote): the code decides the line
 * shown, never the raw output, and an unknown code never reads as an internal error.
 */
export function sshError(error: unknown, host?: string, user?: string): NetError {
  const code = helperCode(error)
  if (code && SSH_REASONS.has(code))
    return new NetError('bad_request', sshErrorText(code, host, user), { details: { reason: code } })
  if (error instanceof NetError && typeof reasonOf(error) === 'string') return error
  const reason = code ?? 'remote_failed'
  return new NetError('bad_request', sshErrorText(reason, host, user), { details: { reason } })
}

/**
 * Add over SSH on A (1b §3.4): resolve, probe and trust the host key, list B's profiles, then Connect: the journal
 * row first (`ssh_requested`, `source: ssh`, a fresh `request_id`), then `prepare` on B, then B's pin and its SSH
 * route (`ssh_granted`), then the dial. A repeats `prepare` with the same id only while the row was never
 * connected and the request is younger than the maximum age.
 */
export class SshAdd {
  constructor(private readonly port: SshAddPort) {}

  private helper(): EngineHelper {
    const helper = this.port.helper()
    if (!helper) throw new NetError('peer_offline', 'Turn networking on first.')
    if (!helper.speaks(1))
      throw new NetError('bad_request', 'Update Mousse to add a computer over SSH.', {
        details: { reason: 'proto_1_0' }
      })
    return helper
  }

  private async ask(op: string, fields: Record<string, unknown>, host?: string, user?: string) {
    try {
      return await this.helper().request(op, fields, this.port.limits().deadlineMs)
    } catch (error) {
      throw sshError(error, host, user)
    }
  }

  async resolve(target: string): Promise<SshResolved> {
    const text = target.trim()
    if (!text || /\s/.test(text) || text.startsWith('-'))
      throw new NetError('bad_request', 'Use user@host or an SSH alias.', {
        details: { reason: 'bad_target' }
      })
    const answer = await this.ask('ssh.resolve', { target: text }, text)
    return {
      routeId: String(answer.route_id),
      user: String(answer.user ?? ''),
      hostname: String(answer.hostname ?? text),
      port: Number(answer.port ?? 22),
      pinned: answer.pinned === true
    }
  }

  async probe(routeId: string, host?: string): Promise<SshProbe> {
    const answer = await this.ask('ssh.probe', { route_id: routeId }, host)
    return {
      keyType: String(answer.key_type ?? ''),
      sha256: String(answer.sha256 ?? ''),
      inUserKnownHosts: answer.in_user_known_hosts === true
    }
  }

  async trust(routeId: string, sha256: string, host?: string): Promise<void> {
    await this.ask('ssh.trust', { route_id: routeId, sha256 }, host)
    this.port.trusted?.(routeId, host)
  }

  /** The last profiles list session 1 answered, by route: Connect reads it rather than signing in again (§3.4). */
  private readonly listed = new Map<string, SshProfiles>()

  /** What session 1 last answered for `routeId`, if it ran in this add. */
  listedProfiles(routeId: string): SshProfiles | undefined {
    return this.listed.get(routeId)
  }

  /** The shell an `ssh.run` of this add last answered for `routeId`. */
  private readonly shells = new Map<string, SshShell>()

  /** The shell this add learned for `routeId`, `sh` when no session ran yet. */
  shellFor(routeId: string): SshShell {
    return this.shells.get(routeId) ?? 'sh'
  }

  /** Session 1: B's profiles. */
  async profiles(routeId: string, host?: string, user?: string): Promise<SshProfiles> {
    const { reply, shell } = await this.run(routeId, { op: 'profiles' }, host, user)
    const list = Array.isArray(reply.profiles) ? reply.profiles : []
    const answer = this.readProfiles(reply, list, shell, host)
    this.listed.set(routeId, answer)
    return answer
  }

  private readProfiles(reply: Record<string, any>, list: unknown[], shell: SshShell, host?: string): SshProfiles {
    return {
      shell,
      computer: String(reply.computer ?? host ?? ''),
      os: String(reply.os ?? ''),
      startsAtLogin: reply.starts_at_login === true,
      profiles: list
        .filter(
          (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object'
        )
        .map((item: Record<string, unknown>) => ({
          selector: String(item.selector ?? ''),
          label: String(item.label ?? ''),
          networking: item.networking === true,
          ...(typeof item.identity === 'string' ? { identity: item.identity } : {})
        }))
        .filter((item: { selector: string }) => /^[a-z2-7]{26}$/.test(item.selector))
    }
  }

  private async run(
    routeId: string,
    request: Record<string, unknown>,
    host?: string,
    user?: string
  ): Promise<{ reply: Record<string, any>; shell: SshShell }> {
    const answer = await this.ask('ssh.run', { route_id: routeId, request }, host, user)
    const shell = shellOf(answer)
    this.shells.set(routeId, shell)
    const reply = answer.reply as Record<string, any> | undefined
    if (!reply || typeof reply !== 'object') {
      const reason = typeof answer.error === 'string' ? answer.error : 'remote_failed'
      throw new NetError('bad_request', sshErrorText(reason, host, user), { details: { reason } })
    }
    if (typeof reply.error === 'string')
      throw new NetError('bad_request', sshErrorText(reply.error, host, user), {
        details: { reason: reply.error }
      })
    return { reply, shell }
  }

  /**
   * Connect (§3.4 steps 3–5): the journal row is written before anything is sent, then `prepare` runs, then B is
   * pinned with its SSH route. Answers the row; the dial that confirms it follows.
   */
  async connect(choice: {
    routeId: string
    target: string
    host: string
    user: string
    selector?: string
    newLabel?: string
    /** The shell session 1 learned; this add's own when not given. */
    shell?: SshShell
  }): Promise<EnginePeerRow> {
    if (!choice.selector === !choice.newLabel)
      throw new NetError('bad_request', 'Pick a profile.', { details: { reason: 'bad_request' } })
    const requestId = randomBytes(16).toString('hex')
    const ssh: EngineSshJournal = {
      requestId,
      issuedAt: Math.floor(this.port.now()),
      routeId: choice.routeId,
      ...(choice.selector ? { selector: choice.selector } : { newLabel: choice.newLabel }),
      target: choice.target,
      host: choice.host,
      user: choice.user,
      shell: choice.shell ?? this.shellFor(choice.routeId)
    }
    // Until B answers, the row knows B only by this request.
    const row = this.port.peers.add({
      endpoint: `ssh:${requestId}`,
      fingerprint: '',
      grant: '',
      name: choice.host,
      state: 'ssh_requested',
      source: 'ssh',
      receipt: requestId,
      ssh,
      pairedAt: Date.now()
    })
    this.port.changed()
    return this.prepare(row)
  }

  /** Session 2 and what follows it, for a row in `ssh_requested` (Connect, or a repeat). */
  async prepare(row: EnginePeerRow): Promise<EnginePeerRow> {
    const ssh = row.ssh
    if (!ssh?.routeId) throw new NetError('bad_request', 'Not an SSH add.')
    if (ssh.everConnected && !engineControl('retry-after-connected'))
      throw new NetError('bad_request', sshErrorText('removed', ssh.host), {
        details: { reason: 'removed' }
      })
    if (
      ssh.issuedAt !== undefined &&
      this.port.now() - ssh.issuedAt > this.port.limits().maxAgeSecs &&
      !engineControl('retry-after-connected')
    )
      throw new NetError('bad_request', 'That request is too old. Add it again.', {
        details: { reason: 'expired' }
      })
    let reply: Record<string, any>
    let shell: SshShell
    try {
      ;({ reply, shell } = await this.run(
        ssh.routeId,
        {
          op: 'prepare',
          request_id: ssh.requestId,
          issued_at: ssh.issuedAt,
          ...(ssh.selector ? { selector: ssh.selector } : { new_label: ssh.newLabel }),
          joiner: this.port.identity(),
          joiner_name: this.port.name()
        },
        ssh.host,
        ssh.user
      ))
    } catch (error) {
      if (error instanceof NetError && reasonOf(error) === 'removed') {
        this.port.peers.update(row.localId, { ssh: { ...ssh, removed: true } })
        this.port.changed()
      }
      throw error
    }
    const identity = typeof reply.identity === 'string' ? reply.identity : ''
    if (!/^[0-9a-f]{2,}$/i.test(identity))
      throw new NetError('bad_request', sshErrorText('remote_failed', ssh.host), {
        details: { reason: 'remote_failed' }
      })
    const name = typeof reply.name === 'string' && reply.name ? reply.name : (ssh.host ?? row.name)
    const selector = typeof reply.selector === 'string' ? reply.selector : ssh.selector
    const journal: EngineSshJournal = {
      ...ssh,
      ...(selector ? { selector } : {}),
      shell,
      startsAtLogin: reply.starts_at_login === true
    }
    // The owner removed this row here while B answered: nothing is recorded over the removal.
    const removedHere = () =>
      new NetError('bad_request', 'Removed on this computer.', {
        details: { reason: 'removed_here' }
      })
    if (this.port.peers.get(row.localId)?.state !== 'ssh_requested') throw removedHere()
    // A row of an earlier add of this profile (one B removed, say) gives way to this one: one row per computer.
    for (const earlier of this.port.peers.all())
      if (
        earlier.localId !== row.localId &&
        earlier.source === 'ssh' &&
        earlier.endpoint === identity
      )
        this.port.peers.prune(earlier.localId)
    // Step 5: B pinned with no routes, then its SSH route as the owner's address.
    const helper = this.helper()
    await helper.request('peer.add', { identity, name, routes: [] })
    await helper.request('peer.addresses.set', {
      identity,
      routes: handedRoutes<string | Record<string, unknown>>([
        // The `route-leak` control: what B offered beyond its SSH route goes first.
        ...(engineControl('route-leak') ? leaked(reply.routes) : []),
        ...(row.addresses ?? []),
        { route_id: journal.routeId, selector: journal.selector, shell }
      ])
    })
    const saved = this.port.peers.advance(row.localId, ['ssh_requested'], {
      endpoint: identity,
      name,
      state: 'ssh_granted',
      ssh: journal
    })
    if (!saved) {
      // Removed meanwhile: B's pin and route go again, unless another live row still uses them.
      const other = this.port.peers
        .all()
        .some((item) => item.endpoint === identity && item.state !== 'removed')
      if (!other) await helper.request('peer.forget', { identity }).catch(() => undefined)
      throw removedHere()
    }
    this.port.changed()
    helper.claim(identity)
    this.dialUntilConnected(saved.localId, identity)
    return saved
  }

  /** Retries of first dials waiting now; `dispose` clears them. */
  private readonly retries = new Set<ReturnType<typeof setTimeout>>()
  private disposed = false

  /** Networking stopped: no retry runs after it (its store is closed). */
  dispose(): void {
    this.disposed = true
    for (const timer of this.retries) clearTimeout(timer)
    this.retries.clear()
  }

  /**
   * A's first dial to B. One that fails (B's helper may not take the new grant yet, as right after B removed an
   * earlier pairing) is tried again every `pairingRetryMs` while the row waits for it and networking runs. A
   * refusal only the owner can clear (`auth_denied`, `host_key_changed`, `host_key_unknown`) parks it instead: the
   * row shows it and it is never retried on its own (§1.4; repeated denied logins trip fail2ban).
   */
  private dialUntilConnected(node: EnginePeerRow['localId'], identity: string): void {
    const waiting = (): EnginePeerRow | undefined => {
      if (this.disposed) return undefined
      try {
        const row = this.port.peers.get(node)
        return row?.state === 'ssh_granted' ? row : undefined
      } catch {
        // Networking stopped and its store closed.
        return undefined
      }
    }
    const attempt = (): void => {
      const helper = this.port.helper()
      if (!helper || !waiting()) return
      void helper.dial(identity).catch((error) => {
        if (!waiting()) return
        const why = helperWhy(error) ?? (error instanceof NetError ? reasonOf(error) : undefined)
        if (isSshParked(why)) {
          this.port.park?.(node, why)
          return
        }
        const timer = setTimeout(() => {
          this.retries.delete(timer)
          attempt()
        }, engineLimits().pairingRetryMs)
        timer.unref?.()
        this.retries.add(timer)
      })
    }
    attempt()
  }

  /** A's first live connection to B: the row is connected, and `prepare` is never repeated. */
  connected(row: EnginePeerRow): void {
    if (row.source !== 'ssh' || row.state !== 'ssh_granted') return
    this.port.peers.update(row.localId, {
      state: 'connected',
      ssh: { ...row.ssh!, everConnected: true }
    })
    this.port.changed()
  }
}

/** Under the `route-leak` control, the routes B's reply offered (text only). */
const leaked = (routes: unknown): string[] =>
  Array.isArray(routes) ? routes.filter((route): route is string => typeof route === 'string') : []

/** The §3.5 reason a NetError carries. */
const reasonOf = (error: NetError): unknown =>
  (error.details as { reason?: unknown } | undefined)?.reason
