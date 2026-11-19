import { randomBytes } from 'node:crypto'
import { NetError } from '../../../shared/net/errors'
import { helperCode } from '../helper/appChannel'
import type { EngineHelper } from '../helper/connections'
import { engineControl } from '../limits'
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
      return `Mousse isn't installed for ${user} on ${host}.`
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

/** A helper's or B's refusal, as a NetError carrying its §3.5 reason. */
export function sshError(error: unknown, host?: string, user?: string): NetError {
  if (error instanceof NetError && typeof reasonOf(error) === 'string') return error
  const reason = helperCode(error) ?? 'remote_failed'
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
  }

  /** Session 1: B's profiles. */
  async profiles(routeId: string, host?: string, user?: string): Promise<SshProfiles> {
    const reply = await this.run(routeId, { op: 'profiles' }, host, user)
    const list = Array.isArray(reply.profiles) ? reply.profiles : []
    return {
      computer: String(reply.computer ?? host ?? ''),
      os: String(reply.os ?? ''),
      startsAtLogin: reply.starts_at_login === true,
      profiles: list
        .filter((item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object')
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
  ): Promise<Record<string, any>> {
    const answer = await this.ask('ssh.run', { route_id: routeId, request }, host, user)
    const reply = answer.reply as Record<string, any> | undefined
    if (!reply || typeof reply !== 'object') {
      const reason = typeof answer.error === 'string' ? answer.error : 'remote_failed'
      throw new NetError('bad_request', sshErrorText(reason, host, user), { details: { reason } })
    }
    if (typeof reply.error === 'string')
      throw new NetError('bad_request', sshErrorText(reply.error, host, user), {
        details: { reason: reply.error }
      })
    return reply
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
    shell?: string
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
      shell: choice.shell ?? 'sh'
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
    try {
      reply = await this.run(
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
      )
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
      startsAtLogin: reply.starts_at_login === true
    }
    // Step 5: B pinned with no routes, then its SSH route as the owner's address.
    const helper = this.helper()
    await helper.request('peer.add', { identity, name, routes: [] })
    await helper.request('peer.addresses.set', {
      identity,
      routes: [
        ...(row.addresses ?? []),
        { route_id: journal.routeId, selector: journal.selector, shell: journal.shell ?? 'sh' }
      ]
    })
    const saved = this.port.peers.update(row.localId, {
      endpoint: identity,
      name,
      state: 'ssh_granted',
      ssh: journal
    })!
    this.port.changed()
    helper.claim(identity)
    void helper.dial(identity).catch(() => undefined)
    return saved
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

/** The §3.5 reason a NetError carries. */
const reasonOf = (error: NetError): unknown => (error.details as { reason?: unknown } | undefined)?.reason
