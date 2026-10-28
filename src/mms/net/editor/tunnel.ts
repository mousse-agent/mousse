import { randomBytes } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { connect as tcpConnect, type Socket } from 'node:net'
import { join } from 'node:path'
import { Duplex, duplexPair } from 'node:stream'
import { NetError } from '../../../shared/net/errors'
import type { NodeId } from '../../../shared/net/ids'
import {
  EDITOR_OPENS_PER_MINUTE,
  EDITOR_TUNNELS_MAX,
  EDITOR_TUNNELS_PER_NODE,
  TUNNEL_CHUNK_BYTES,
  TUNNEL_CREDIT_STEP_BYTES,
  TUNNEL_HOST_KEYS_MAX,
  TUNNEL_OPEN_TIMEOUT_MS,
  TUNNEL_REASON_TEXT,
  TUNNEL_WINDOW_BYTES,
  type TunnelFailure,
  type TunnelHostKey,
  type TunnelPath,
  type TunnelReason,
  tunnelPathOf
} from '../../../shared/net/tunnel'
import type { TunnelMessage } from '../../../shared/net/wire'
import type { Clock, SessionTunnelPort, TunnelLink } from '../contracts'
import type { SqliteBridgeAudit } from '../store/audit'
import { checkHostTrust, type HostTrust } from './hostTrust'
import { isHostKey } from './sshConfig'

/**
 * Editor tunnels.
 *
 * An editor reaches a folder on another computer by running `ssh` against it. Here that SSH connection
 * rides the Mousse Net session between the two computers instead of the network: the caller's bytes go in
 * `tunnel.data` messages on a lane of their own, and the computer that carries the far end writes them to
 * its own SSH server and sends the server's bytes back. Net has already chosen the cheapest route to that
 * computer and proved who is on the other side; this module adds only what an SSH connection needs.
 *
 * **The far end is fixed.** `tunnel.open` has no host and no port: it says `ssh`, and the computer that
 * carries the tunnel connects to ITS OWN SSH server on loopback (`SSH_FAR_END`), never to anything the
 * caller named. A wire message with an extra field is not valid and ends the session, and the only way to
 * change the far end is the constructor, which accepts loopback addresses only. A tunnel therefore cannot
 * become an open proxy.
 *
 * **It is shell access.** An SSH login on that server is a shell as the user. So a tunnel follows the rules
 * of a terminal (docs/net/threat-model.md): the device needs "Works on threads", must not be blocked, the
 * owner's switch for other computers must be on, and its own switch, "Editor connections from this device",
 * must be on (off by default). The same checks run again, on every change, for every live tunnel: a block,
 * the switch going off, the owner's switch going off, a lost grant, a revoke and Net being turned off end
 * every tunnel of the device at once. Each open and each end is audited, with the bytes that went each way
 * and the path.
 */

/** What a tunnel ends at, in order: this computer's own SSH server on loopback. Nothing the caller says changes it. */
export const SSH_FAR_END: ReadonlyArray<Readonly<{ host: string; port: number }>> = Object.freeze([
  Object.freeze({ host: '127.0.0.1', port: 22 }),
  Object.freeze({ host: '::1', port: 22 })
])
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1'])
const FAR_END_CONNECT_MS = 3_000
/** How long a tunnel whose own side has closed waits for the other side to end before it is let go. */
const LINGER_MS = 30_000
const SEND_RETRY_MS = 25
const OPEN_WINDOW_MS = 60_000
/** A kind of refusal is written to the audit at most once in this long for a device. */
const REFUSAL_ROW_WINDOW_MS = 60_000
/** How long a close or an open waits for room in a full control queue (`rate_limited`) before it gives up. */
const SEND_PATIENCE_TRIES = 80

/** Why a tunnel ended here: a wire reason, or the session it rode on was lost. */
export type TunnelEnd = TunnelReason | 'session_closed'

/** What an open or a tunnel fails with. `reason` is a fixed word; `message` is plain words for a person. */
export class TunnelError extends Error {
  constructor(
    readonly reason: TunnelFailure,
    message: string = TUNNEL_REASON_TEXT[reason]
  ) {
    super(message)
    this.name = 'TunnelError'
  }
}

/** The directories an SSH server keeps its public host keys in. Public keys only; private keys are never read. */
export function defaultHostKeyDirectories(
  platform: NodeJS.Platform = process.platform,
  programData: string | undefined = process.env.ProgramData
): string[] {
  return platform === 'win32' ? [join(programData || 'C:\\ProgramData', 'ssh')] : ['/etc/ssh']
}

/** `ssh_host_ed25519_key.pub`, never `ssh_host_ed25519_key` (the private key) or a certificate. */
const HOST_KEY_FILE = /^ssh_host_[a-z0-9_]+_key\.pub$/u
const HOST_KEY_FILE_MAX_BYTES = 16 * 1024

/**
 * The public host keys of this computer's SSH server, read from its `ssh_host_*_key.pub` files (read only;
 * a file that is not a plain file, is too large or does not parse is skipped). These are what a computer
 * vouches for over Net, so the other computer can pin them and never has to trust a key on first use.
 */
export async function readHostKeys(directories: readonly string[]): Promise<TunnelHostKey[]> {
  const keys: TunnelHostKey[] = []
  for (const directory of directories) {
    let names: string[]
    try {
      names = (await readdir(directory)).sort()
    } catch {
      continue
    }
    for (const name of names) {
      if (keys.length >= TUNNEL_HOST_KEYS_MAX) return keys
      if (!HOST_KEY_FILE.test(name)) continue
      try {
        const file = join(directory, name)
        const info = await lstat(file)
        if (!info.isFile() || info.size > HOST_KEY_FILE_MAX_BYTES) continue
        const [type, key] = (await readFile(file, 'utf8')).trim().split(/\s+/u)
        const entry = { type: type ?? '', key: key ?? '' }
        if (isHostKey(entry) && !keys.some((known) => known.type === type && known.key === key))
          keys.push(entry)
      } catch {
        // Unreadable: the key is left out, and with none the open is refused `no_host_key`.
      }
    }
  }
  return keys
}

function connectFarEnd(
  targets: ReadonlyArray<{ host: string; port: number }>,
  timeoutMs: number
): Promise<Socket> {
  const attempt = (host: string, port: number): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const socket = tcpConnect({ host, port })
      const timer = setTimeout(() => fail(new Error('timeout')), timeoutMs)
      timer.unref?.()
      const fail = (error: Error): void => {
        clearTimeout(timer)
        socket.destroy()
        reject(error)
      }
      socket.once('error', fail)
      socket.once('connect', () => {
        clearTimeout(timer)
        socket.removeListener('error', fail)
        // Until the tunnel takes the socket over (it waits for the host keys), a reset must not be an
        // unhandled error event; the tunnel's own listener ends it afterwards.
        socket.on('error', () => {})
        socket.setNoDelay(true)
        resolve(socket)
      })
    })
  return targets.reduce<Promise<Socket>>(
    (previous, target) => previous.catch(() => attempt(target.host, target.port)),
    Promise.reject(new Error('no far end'))
  )
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })

// ------------------------------------------------------------------------------------ the byte stream

interface PipeIo {
  id: string
  /** The end of the connection on this computer: the SSH server's socket, or the caller's stream. */
  local: Duplex
  send(message: TunnelMessage, bytes?: Uint8Array): Promise<void>
  /** The tunnel cannot go on. `notify` says whether the other side is told (an abort, not an ordinary end). */
  abort(reason: TunnelReason, notify: boolean): void
  /** Both directions ended and everything was written out. */
  finished(): void
}

/**
 * One tunnel's byte stream, the same on both computers. Each direction has a credit window: a side sends
 * at most `TUNNEL_WINDOW_BYTES` before the other has written them out and granted more, so a slow reader
 * holds a bounded amount and a fast sender is paused (the local stream is paused, which is how a TCP
 * connection or a pipe is slowed). The bytes of a direction end with a `tunnel.data` that says `end`.
 */
class TunnelPipe {
  /** What this side may still send. */
  private credit = TUNNEL_WINDOW_BYTES
  /** Bytes sent, and bytes the other side granted back: the grant can never be more than what was sent. */
  private sentTotal = 0
  private creditedBack = 0
  /** Bytes received, and bytes this side granted back. */
  private receivedTotal = 0
  private grantedTotal = 0
  /** Written out and not granted back yet. */
  private owed = 0
  private pending: Buffer[] = []
  private pendingBytes = 0
  private pumping = false
  private again = false
  private localEnded = false
  private endSent = false
  private remoteEnded = false
  private stopped = false
  private linger?: ReturnType<typeof setTimeout>
  /** Bytes taken from the local stream and sent, and bytes received and written to it. */
  sent = 0
  received = 0

  constructor(private readonly io: PipeIo) {}

  start(): void {
    const { local } = this.io
    local.on('data', (chunk: Buffer | string) => {
      if (this.stopped) return
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      if (!bytes.length) return
      this.pending.push(bytes)
      this.pendingBytes += bytes.length
      // Enough is waiting: the local stream is held until it has gone out.
      if (this.pendingBytes >= TUNNEL_CHUNK_BYTES * 2) local.pause()
      void this.pump()
    })
    local.on('end', () => {
      this.localEnded = true
      void this.pump()
    })
    local.on('finish', () => this.maybeFinished())
    local.on('error', () => {
      if (!this.stopped) this.io.abort('far_end_error', true)
    })
    local.on('close', () => {
      if (this.stopped) return
      // Closed without an end: nothing more can be read or written.
      if (!this.localEnded) return this.io.abort('closed', true)
      // Closed after its end: what is queued still goes out, and the other side is given time to end.
      this.maybeFinished()
      if (!this.stopped) {
        this.linger = setTimeout(() => this.io.abort('closed', true), LINGER_MS)
        this.linger.unref?.()
      }
    })
    // A far end that was lost before the tunnel took it over has nothing left to say 'close' for.
    if (local.destroyed) queueMicrotask(() => this.io.abort('far_end_error', true))
  }

  stop(): void {
    this.stopped = true
    if (this.linger) clearTimeout(this.linger)
    this.pending = []
    this.pendingBytes = 0
    this.io.local.removeAllListeners('data')
  }

  /** A piece of the other side's byte stream, or its end. */
  accept(bytes: Uint8Array, end: boolean): void {
    if (this.stopped) return
    const { local } = this.io
    // The sender may send what it was credited and no more.
    if (this.receivedTotal + bytes.length - this.grantedTotal > TUNNEL_WINDOW_BYTES)
      return this.io.abort('protocol', true)
    if (this.remoteEnded) return this.io.abort('protocol', true)
    this.receivedTotal += bytes.length
    if (bytes.length) {
      this.received += bytes.length
      if (!local.destroyed)
        local.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), () => {
          // Written out: this is when the sender may have those bytes back, which is what slows it down.
          this.owed += bytes.length
          if (this.owed >= TUNNEL_CREDIT_STEP_BYTES) this.grant()
        })
      else this.owed += bytes.length
    }
    if (end) {
      this.remoteEnded = true
      if (!local.destroyed) local.end()
      this.maybeFinished()
    }
  }

  /** The other side wrote `bytes` out. */
  grantReceived(bytes: number): void {
    if (this.stopped) return
    if (this.creditedBack + bytes > this.sentTotal) return this.io.abort('protocol', true)
    this.creditedBack += bytes
    this.credit += bytes
    void this.pump()
  }

  private grant(): void {
    const bytes = this.owed
    if (!bytes || this.stopped) return
    this.owed = 0
    this.grantedTotal += bytes
    void this.deliver({ t: 'tunnel.credit', tunnel: this.io.id, bytes }).catch(() => {
      // A session that cannot take a credit is closing; the tunnel ends with it.
    })
  }

  private maybeFinished(): void {
    if (this.stopped) return
    if (
      this.endSent &&
      this.remoteEnded &&
      (this.io.local.writableFinished || this.io.local.destroyed)
    )
      this.io.finished()
  }

  private take(size: number): Buffer {
    const out = Buffer.allocUnsafe(size)
    let filled = 0
    while (filled < size) {
      const head = this.pending[0]!
      const count = Math.min(head.length, size - filled)
      head.copy(out, filled, 0, count)
      filled += count
      if (count === head.length) this.pending.shift()
      else this.pending[0] = head.subarray(count)
    }
    this.pendingBytes -= size
    return out
  }

  /**
   * Sends one message, waiting for room when the lane's queue is full. The wait is a poll, not a queue: tunnels of
   * one session that wait together are served in whatever order their timers fire, so under sustained load one can
   * get less than its share of its siblings (it is never stuck: the queue empties as the lane is sent).
   */
  private async deliver(message: TunnelMessage, bytes?: Uint8Array): Promise<void> {
    for (;;) {
      try {
        return await this.io.send(message, bytes)
      } catch (error) {
        if (this.stopped) return
        if (!(error instanceof NetError) || error.code !== 'rate_limited') throw error
      }
      await sleep(SEND_RETRY_MS)
      if (this.stopped) return
    }
  }

  /** Moves what the local stream gave into messages, as far as the credit goes, one message at a time. */
  private async pump(): Promise<void> {
    if (this.pumping) {
      this.again = true
      return
    }
    this.pumping = true
    try {
      do {
        this.again = false
        while (!this.stopped) {
          if (this.pendingBytes === 0) {
            if (this.localEnded && !this.endSent) {
              this.endSent = true
              await this.deliver(
                { t: 'tunnel.data', tunnel: this.io.id, end: true, parts: [0] },
                new Uint8Array(0)
              )
              this.maybeFinished()
            }
            break
          }
          if (this.credit <= 0) break
          const size = Math.min(this.credit, TUNNEL_CHUNK_BYTES, this.pendingBytes)
          const chunk = this.take(size)
          this.credit -= size
          this.sentTotal += size
          this.sent += size
          await this.deliver({ t: 'tunnel.data', tunnel: this.io.id, parts: [size] }, chunk)
          if (!this.stopped && !this.localEnded && this.pendingBytes < TUNNEL_CHUNK_BYTES * 2)
            this.io.local.resume()
        }
      } while (this.again && !this.stopped)
    } catch {
      if (!this.stopped) this.io.abort('far_end_error', true)
    } finally {
      this.pumping = false
    }
  }
}

// ------------------------------------------------------------------------------------ the service

type Role = 'host' | 'client'

interface Entry {
  id: string
  role: Role
  link: TunnelLink
  node: NodeId
  openedAt: number
  path: TunnelPath
  transport?: string
  /** The far end's socket on a host, the service's end of the pair on a client. */
  local?: Duplex
  /** The end a client hands to its caller. */
  user?: Duplex
  pipe?: TunnelPipe
  /** A client that has sent `tunnel.open` and waits for the answer. */
  opening?: {
    resolve(tunnel: ClientTunnel): void
    reject(error: TunnelError): void
    timer: ReturnType<typeof setTimeout>
  }
  settle?: (end: TunnelFailure) => void
  /** A client that only asks (`ssh.check`): it gets the answer, never a stream. */
  check?: (answer: CheckAnswer) => void
  /** Stops watching the session and the caller's signal. */
  release: Array<() => void>
  done: boolean
}

/** What a check learns: the path in use and the host keys the other computer vouches for. */
export interface CheckAnswer {
  path: TunnelPath
  transport?: string
  hostKeys: TunnelHostKey[]
}

/** How a tunnel ended here: for a client also that it never opened (it timed out, was cancelled, or the peer is gone). */
type EndReason = TunnelEnd | 'timeout' | 'cancelled' | 'offline'

interface Claim {
  node: NodeId
  link: TunnelLink
  cancelled?: TunnelReason
}

/** A tunnel a computer opened to another one: a byte stream to that computer's SSH server. */
export interface ClientTunnel {
  /** What the editor's `ssh` writes to, and reads the server's bytes from. */
  stream: Duplex
  /** The public host keys the other computer vouches for. */
  hostKeys: TunnelHostKey[]
  path: TunnelPath
  transport?: string
  /**
   * Resolves when the tunnel is over, with why (`closed` for an ordinary end, `offline` when the session was
   * lost, or the other computer's reason: `blocked`, `editor_off`...). The stream itself only ends.
   */
  closed: Promise<TunnelFailure>
  close(): void
}

export interface EditorTunnelOptions {
  clock: Clock
  audit: Pick<SqliteBridgeAudit, 'record' | 'has' | 'countRead'>
  /**
   * Why `link`'s device may not have a tunnel on this computer now, or undefined. Read for every open and for
   * every live tunnel on each change, so it must reflect the current policy, grants and settings.
   */
  refusal(link: TunnelLink): TunnelReason | undefined
  /** The transport the session runs on (`direct`, `relay`...), for the path and the audit. */
  transportOf(link: TunnelLink): string | undefined
  /** The first tunnel a device ever opens here (a desktop notification for the owner). */
  onFirstOpen?(node: NodeId): void
  /** Tests replace the far end with an echo server on loopback; any other address is refused. */
  farEnd?: ReadonlyArray<{ host: string; port: number }>
  /** Tests replace the directories the public host keys are read from. */
  hostKeyDirectories?: readonly string[]
  /**
   * Whether the SSH server on the far end and its folder of keys can be vouched for. By default this is the check
   * for Windows in `hostTrust.ts` (nothing to check elsewhere); a service built with its own far end or key
   * folder (tests) has none unless it is given one.
   */
  hostTrust?: () => Promise<HostTrust>
  perNode?: number
  total?: number
  opensPerMinute?: number
}

/**
 * Both ends of every editor tunnel of one profile: the tunnels other computers opened to this one (it carries
 * the far end), and the tunnels this computer opened to others (its editor's SSH rides them).
 */
export class EditorTunnels implements SessionTunnelPort {
  private readonly tunnels = new Map<string, Entry>()
  private readonly claims = new Set<Claim>()
  private readonly opens = new Map<NodeId, number[]>()
  /** When each device's checks were asked: they have a limit of their own, apart from the opens. */
  private readonly checks = new Map<NodeId, number[]>()
  /** Checks being answered, per device. */
  private readonly checking = new Map<NodeId, number>()
  /** Ids of opens in progress: held from the moment the message is read, before the first await. */
  private readonly reserved = new Set<string>()
  /** When a row was last written for each kind of refusal of each device. */
  private readonly refusalRows = new Map<string, number>()
  private readonly farEnd: ReadonlyArray<{ host: string; port: number }>
  private readonly hostKeyDirectories: readonly string[]
  private readonly trust?: () => Promise<HostTrust>
  private readonly perNode: number
  private readonly total: number
  private readonly opensPerMinute: number

  constructor(private readonly options: EditorTunnelOptions) {
    this.farEnd = options.farEnd ?? SSH_FAR_END
    // The far end is this computer's own SSH server: whatever is configured, it is on loopback.
    if (!this.farEnd.length || this.farEnd.some((target) => !LOOPBACK_HOSTS.has(target.host)))
      throw new NetError('bad_request', 'An editor tunnel ends on loopback only.')
    this.hostKeyDirectories = options.hostKeyDirectories ?? defaultHostKeyDirectories()
    this.trust =
      options.hostTrust ??
      (options.farEnd || options.hostKeyDirectories
        ? undefined
        : () => checkHostTrust({ directories: this.hostKeyDirectories }))
    this.perNode = options.perNode ?? EDITOR_TUNNELS_PER_NODE
    this.total = options.total ?? EDITOR_TUNNELS_MAX
    this.opensPerMinute = options.opensPerMinute ?? EDITOR_OPENS_PER_MINUTE
  }

  // ---------------------------------------------------------------- what is open

  /** How many tunnels `node` has open on this computer (carried here), counting those being opened. */
  count(node: NodeId): number {
    let count = 0
    for (const claim of this.claims) if (claim.node === node) count++
    for (const entry of this.tunnels.values())
      if (entry.role === 'host' && entry.node === node) count++
    return count
  }

  /** The tunnels `node` has open here, for the audit and the Devices screen. */
  list(node?: NodeId): Array<{
    id: string
    node: NodeId
    role: Role
    openedAt: number
    path: TunnelPath
    bytesIn: number
    bytesOut: number
  }> {
    return [...this.tunnels.values()]
      .filter((entry) => !entry.opening && (node === undefined || entry.node === node))
      .map((entry) => ({
        id: entry.id,
        node: entry.node,
        role: entry.role,
        openedAt: entry.openedAt,
        path: entry.path,
        bytesIn: entry.pipe?.received ?? 0,
        bytesOut: entry.pipe?.sent ?? 0
      }))
  }

  // ---------------------------------------------------------------- messages from the peer

  receive(link: TunnelLink, message: TunnelMessage, bytes: Uint8Array | undefined): void {
    try {
      switch (message.t) {
        case 'tunnel.open':
          void this.hostOpen(link, message).catch(() => {
            // An open that failed in a way not listed is simply not answered; the caller times out.
          })
          return
        case 'tunnel.opened': {
          const entry = this.tunnels.get(message.tunnel)
          if (entry?.role === 'client' && entry.link === link && entry.opening) {
            if (entry.check) this.answerCheck(entry, message.hostKeys)
            else this.activate(entry, message.hostKeys)
          }
          return
        }
        case 'tunnel.data': {
          const entry = this.tunnels.get(message.tunnel)
          if (entry?.link === link && entry.pipe)
            entry.pipe.accept(bytes ?? new Uint8Array(0), message.end === true)
          return
        }
        case 'tunnel.credit': {
          const entry = this.tunnels.get(message.tunnel)
          if (entry?.link === link && entry.pipe) entry.pipe.grantReceived(message.bytes)
          return
        }
        case 'tunnel.close': {
          const entry = this.tunnels.get(message.tunnel)
          // An abort from the other side: nothing is sent back. The computer that carries the far end is only told
          // that the device is done; what a computer says about why it refused or ended matters to the one that asked.
          if (entry?.link === link)
            this.finish(entry, entry.role === 'host' ? 'closed' : message.reason, false)
          return
        }
      }
    } catch {
      // A message the service cannot act on is dropped; it never ends the session.
    }
  }

  // ---------------------------------------------------------------- the computer that carries the far end

  private allowOpen(node: NodeId): boolean {
    const now = this.options.clock.now()
    const recent = (this.opens.get(node) ?? []).filter((at) => now - at < OPEN_WINDOW_MS)
    if (recent.length >= this.opensPerMinute) {
      this.opens.set(node, recent)
      return false
    }
    recent.push(now)
    this.opens.set(node, recent)
    return true
  }

  private async hostOpen(
    link: TunnelLink,
    message: Extract<TunnelMessage, { t: 'tunnel.open' }>
  ): Promise<void> {
    if (message.kind === 'ssh.check') return this.hostCheck(link, message)
    const { audit } = this.options
    const node = link.peer.node
    const id = message.tunnel
    // An id that is in use, or being opened, belongs to a tunnel that exists or is on its way: it is not opened a
    // second time, and the opener of the first is not disturbed. The id is held before anything is awaited, so
    // any number of opens made at once with one id give one tunnel, counted, limited and ended like any other.
    if (this.tunnels.has(id) || this.reserved.has(id)) return
    this.reserved.add(id)
    const refuse = (reason: TunnelReason): void => {
      // A refusal that tells the owner something is a row (at most one of each kind per device a minute): the
      // device is allowed to be here but could not open one. Refusals for a blocked or switched-off computer are
      // not rows, so a device cannot fill the audit.
      if (
        reason === 'editor_off' ||
        reason === 'no_ssh_server' ||
        reason === 'no_host_key' ||
        reason === 'host_untrusted' ||
        reason === 'limit'
      )
        this.recordRefusal(node, reason)
      this.tell(link, { t: 'tunnel.close', tunnel: id, reason })
    }
    // The rate comes first: a device that is refused still costs this computer something, so how often it may
    // ask is decided before the roster is read, the policy is read or a row is written.
    if (!this.allowOpen(node)) {
      this.reserved.delete(id)
      return refuse('rate_limited')
    }
    const gate = this.safeRefusal(link)
    if (gate) {
      this.reserved.delete(id)
      return refuse(gate)
    }
    if (this.count(node) >= this.perNode || this.hostCount() + this.claims.size >= this.total) {
      this.reserved.delete(id)
      return refuse('limit')
    }
    // The slot is taken before anything is awaited, so two opens made at once cannot both pass.
    const claim: Claim = { node, link }
    this.claims.add(claim)
    let socket: Socket | undefined
    try {
      try {
        socket = await connectFarEnd(this.farEnd, FAR_END_CONNECT_MS)
      } catch {
        return refuse('no_ssh_server')
      }
      // Whether what answered is the system's own SSH server (checked on Windows, where any account could be).
      if (this.trust) {
        const verdict = await Promise.resolve()
          .then(() => this.trust!())
          .catch(() => ({ ok: false }))
        if (!verdict.ok) return refuse('host_untrusted')
      }
      const keys = await readHostKeys(this.hostKeyDirectories).catch(() => [])
      if (!keys.length) return refuse('no_host_key')
      // Whatever ended the device's right while the far end was being reached ends the open too.
      if (claim.cancelled) return refuse(claim.cancelled)
      if (link.state() !== 'open') return
      const again = this.safeRefusal(link)
      if (again) return refuse(again)
      const transport = this.options.transportOf(link)
      const entry: Entry = {
        id: message.tunnel,
        role: 'host',
        link,
        node,
        openedAt: this.options.clock.now(),
        path: tunnelPathOf(transport),
        ...(transport ? { transport } : {}),
        local: socket,
        release: [],
        done: false
      }
      entry.pipe = this.pipeFor(entry, socket)
      this.tunnels.set(entry.id, entry)
      // From here the tunnel is counted as itself, and an end that finds it ends it.
      this.claims.delete(claim)
      socket = undefined
      // The tunnel rides this session and ends with it.
      entry.release.push(link.onClosed(() => this.finish(entry, 'session_closed', false)))
      // Read before this open's own row is written: the first tunnel a device ever opens is told to the owner.
      const first = !audit.has(node, 'editor.open')
      audit.record({
        node,
        method: 'editor.open',
        outcome: entry.transport ? `${entry.path}; ${entry.transport}`.slice(0, 80) : entry.path,
        kind: 'change'
      })
      if (first) {
        try {
          this.options.onFirstOpen?.(node)
        } catch {
          // A notice that could not be shown does not stop the tunnel; the audit row has it.
        }
      }
      try {
        // The far end's first bytes (the server's banner) follow only after the caller was told it is open.
        await link.sendTunnel({ t: 'tunnel.opened', tunnel: entry.id, hostKeys: keys })
      } catch {
        this.finish(entry, 'closed', false)
        return
      }
      if (!entry.done) entry.pipe.start()
    } finally {
      this.claims.delete(claim)
      this.reserved.delete(id)
      socket?.destroy()
    }
  }

  private allowCheck(node: NodeId): boolean {
    const now = this.options.clock.now()
    const recent = (this.checks.get(node) ?? []).filter((at) => now - at < OPEN_WINDOW_MS)
    if (recent.length >= this.opensPerMinute || (this.checking.get(node) ?? 0) >= this.perNode) {
      this.checks.set(node, recent)
      return false
    }
    recent.push(now)
    this.checks.set(node, recent)
    return true
  }

  /**
   * A check (`ssh.check`): everything an open would meet, answered, with nothing opened. The same rate-first order,
   * the same gate, a bare connection to the SSH server that is dropped at once, the same host trust and host keys.
   * No tunnel, no `editor.open` row, no first-open notice, and the asks are not counted as opens. A row of its own
   * (`editor.check`) says what the check found, at most one of each kind per device a minute.
   */
  private async hostCheck(
    link: TunnelLink,
    message: Extract<TunnelMessage, { t: 'tunnel.open' }>
  ): Promise<void> {
    const node = link.peer.node
    const id = message.tunnel
    const refuse = (reason: TunnelReason): void => {
      if (
        reason === 'editor_off' ||
        reason === 'no_ssh_server' ||
        reason === 'no_host_key' ||
        reason === 'host_untrusted'
      )
        this.recordCheck(node, reason, 'refused')
      this.tell(link, { t: 'tunnel.close', tunnel: id, reason })
    }
    if (!this.allowCheck(node)) return refuse('rate_limited')
    const gate = this.safeRefusal(link)
    if (gate) return refuse(gate)
    this.checking.set(node, (this.checking.get(node) ?? 0) + 1)
    let socket: Socket | undefined
    try {
      try {
        socket = await connectFarEnd(this.farEnd, FAR_END_CONNECT_MS)
      } catch {
        return refuse('no_ssh_server')
      }
      // Nothing is said to the SSH server: the connection is only proof that something listens.
      socket.destroy()
      socket = undefined
      if (this.trust) {
        const verdict = await Promise.resolve()
          .then(() => this.trust!())
          .catch(() => ({ ok: false }))
        if (!verdict.ok) return refuse('host_untrusted')
      }
      const keys = await readHostKeys(this.hostKeyDirectories).catch(() => [])
      if (!keys.length) return refuse('no_host_key')
      if (link.state() !== 'open') return
      const again = this.safeRefusal(link)
      if (again) return refuse(again)
      this.recordCheck(node, 'ok', 'change')
      await link.sendTunnel({ t: 'tunnel.opened', tunnel: id, hostKeys: keys }).catch(() => undefined)
    } finally {
      socket?.destroy()
      const left = (this.checking.get(node) ?? 1) - 1
      if (left > 0) this.checking.set(node, left)
      else this.checking.delete(node)
    }
  }

  private recordCheck(node: NodeId, outcome: string, kind: 'change' | 'refused'): void {
    const now = this.options.clock.now()
    const key = `check ${node} ${outcome}`
    const last = this.refusalRows.get(key)
    if (last !== undefined && now - last < REFUSAL_ROW_WINDOW_MS) return
    if (this.refusalRows.size >= 256)
      for (const [name, at] of this.refusalRows)
        if (now - at >= REFUSAL_ROW_WINDOW_MS) this.refusalRows.delete(name)
    this.refusalRows.set(key, now)
    this.options.audit.record({ node, method: 'editor.check', outcome, kind })
  }

  /** At most one row of a kind of refusal per device a minute, so a device that keeps asking cannot fill the audit. */
  private recordRefusal(node: NodeId, reason: TunnelReason): void {
    const now = this.options.clock.now()
    const key = `${node} ${reason}`
    const last = this.refusalRows.get(key)
    if (last !== undefined && now - last < REFUSAL_ROW_WINDOW_MS) return
    if (this.refusalRows.size >= 256)
      for (const [name, at] of this.refusalRows)
        if (now - at >= REFUSAL_ROW_WINDOW_MS) this.refusalRows.delete(name)
    this.refusalRows.set(key, now)
    this.options.audit.record({ node, method: 'editor.open', outcome: reason, kind: 'refused' })
  }

  private hostCount(): number {
    let count = 0
    for (const entry of this.tunnels.values()) if (entry.role === 'host') count++
    return count
  }

  // ---------------------------------------------------------------- the computer that opens one

  /**
   * Opens a tunnel to the SSH server of the computer at the other end of `link`. The caller names no host and
   * no port: the other computer decides what its far end is. Rejects with a `TunnelError` whose `reason` says
   * why (the other computer's refusal, or that it is offline, too old, or did not answer).
   */
  open(link: TunnelLink, signal?: AbortSignal): Promise<ClientTunnel> {
    if (link.state() !== 'open') return Promise.reject(new TunnelError('offline'))
    if (!link.supportsTunnels()) return Promise.reject(new TunnelError('unsupported'))
    if (signal?.aborted) return Promise.reject(new TunnelError('cancelled'))
    const node = link.peer.node
    let mine = 0
    for (const entry of this.tunnels.values())
      if (entry.role === 'client' && entry.node === node && !entry.check) mine++
    if (mine >= this.perNode) return Promise.reject(new TunnelError('limit'))
    const id = randomBytes(16).toString('hex')
    return new Promise<ClientTunnel>((resolve, reject) => {
      const transport = this.options.transportOf(link)
      const entry: Entry = {
        id,
        role: 'client',
        link,
        node,
        openedAt: this.options.clock.now(),
        path: tunnelPathOf(transport),
        ...(transport ? { transport } : {}),
        release: [],
        done: false
      }
      const timer = setTimeout(() => this.finish(entry, 'timeout', true), TUNNEL_OPEN_TIMEOUT_MS)
      timer.unref?.()
      entry.opening = { resolve, reject, timer }
      this.tunnels.set(id, entry)
      if (signal) {
        const abort = (): void => this.finish(entry, 'cancelled', true)
        signal.addEventListener('abort', abort, { once: true })
        entry.release.push(() => signal.removeEventListener('abort', abort))
      }
      entry.release.push(link.onClosed(() => this.finish(entry, 'session_closed', false)))
      // Everything the open says is `ssh`: there is no field in which to name a host or a port. A full control
      // queue is waited out for a while; a session that cannot take it at all is offline.
      this.sendReliably(
        link,
        { t: 'tunnel.open', tunnel: id, kind: 'ssh' },
        () => entry.done
      ).catch((error) =>
        this.finish(
          entry,
          error instanceof NetError && error.code === 'rate_limited' ? 'timeout' : 'offline',
          false
        )
      )
    })
  }

  /**
   * Asks the computer at the other end of `link` what an open would meet (`ssh.check`), and opens nothing. Resolves
   * with the path in use and the host keys it vouches for; rejects with a `TunnelError` like `open`.
   */
  check(link: TunnelLink, signal?: AbortSignal): Promise<CheckAnswer> {
    if (link.state() !== 'open') return Promise.reject(new TunnelError('offline'))
    if (!link.supportsTunnels()) return Promise.reject(new TunnelError('unsupported'))
    if (signal?.aborted) return Promise.reject(new TunnelError('cancelled'))
    const id = randomBytes(16).toString('hex')
    return new Promise<CheckAnswer>((resolve, reject) => {
      const transport = this.options.transportOf(link)
      const entry: Entry = {
        id,
        role: 'client',
        link,
        node: link.peer.node,
        openedAt: this.options.clock.now(),
        path: tunnelPathOf(transport),
        ...(transport ? { transport } : {}),
        release: [],
        done: false,
        check: resolve
      }
      const timer = setTimeout(() => this.finish(entry, 'timeout', true), TUNNEL_OPEN_TIMEOUT_MS)
      timer.unref?.()
      entry.opening = { resolve: () => undefined, reject, timer }
      this.tunnels.set(id, entry)
      if (signal) {
        const abort = (): void => this.finish(entry, 'cancelled', true)
        signal.addEventListener('abort', abort, { once: true })
        entry.release.push(() => signal.removeEventListener('abort', abort))
      }
      entry.release.push(link.onClosed(() => this.finish(entry, 'session_closed', false)))
      this.sendReliably(link, { t: 'tunnel.open', tunnel: id, kind: 'ssh.check' }, () => entry.done).catch((error) =>
        this.finish(
          entry,
          error instanceof NetError && error.code === 'rate_limited' ? 'timeout' : 'offline',
          false
        )
      )
    })
  }

  /** The answer to a check arrived: it is over, and there is no stream. */
  private answerCheck(entry: Entry, hostKeys: TunnelHostKey[]): void {
    clearTimeout(entry.opening!.timer)
    entry.opening = undefined
    entry.done = true
    if (this.tunnels.get(entry.id) === entry) this.tunnels.delete(entry.id)
    for (const release of entry.release.splice(0)) release()
    entry.check!({ hostKeys, path: entry.path, ...(entry.transport ? { transport: entry.transport } : {}) })
  }

  /** `tunnel.opened` arrived: the tunnel is a stream now. Runs before the next message is handled. */
  private activate(entry: Entry, hostKeys: TunnelHostKey[]): void {
    const opening = entry.opening!
    clearTimeout(opening.timer)
    entry.opening = undefined
    const [user, local] = duplexPair()
    entry.local = local
    entry.user = user
    entry.pipe = this.pipeFor(entry, local)
    entry.pipe.start()
    // The caller destroys its end (the editor's `ssh` died, or the proxy was killed): the other end of the pair only
    // sees its readable side end, so the tunnel is let go of here. After an ordinary end this finds it already over.
    user.once('close', () => this.finish(entry, 'closed', true))
    const closed = new Promise<TunnelFailure>((resolve) => {
      entry.settle = resolve
    })
    opening.resolve({
      stream: user,
      hostKeys,
      path: entry.path,
      ...(entry.transport ? { transport: entry.transport } : {}),
      closed,
      close: () => this.finish(entry, 'closed', true)
    })
  }

  // ---------------------------------------------------------------- ending

  /**
   * Checks every live tunnel against the rules again, and ends those whose device may no longer have one:
   * a block, the device's switch or the owner's going off, a lost grant, a revoke, Net being turned off. Called
   * on each of those changes, so a tunnel never outlives its permission. Returns how many were ended.
   */
  reconcile(): number {
    let ended = 0
    for (const claim of this.claims) {
      const why = this.safeRefusal(claim.link)
      if (why) claim.cancelled ??= why
    }
    for (const entry of [...this.tunnels.values()]) {
      if (entry.role !== 'host') continue
      const why = this.safeRefusal(entry.link)
      if (!why) continue
      // A grant lost while a tunnel was open is not a refusal of a new one.
      this.finish(entry, why === 'capability' ? 'access_lost' : why, true)
      ended++
    }
    return ended
  }

  /** Whatever goes wrong while deciding, the answer is no: a check that fails never lets a tunnel stay open. */
  private safeRefusal(link: TunnelLink): TunnelReason | undefined {
    try {
      return this.options.refusal(link)
    } catch {
      return 'capability'
    }
  }

  /** Ends every tunnel, those carried here and those opened from here (Net or Bridge was turned off). */
  endAll(reason: TunnelReason): number {
    for (const claim of this.claims) claim.cancelled ??= reason
    const open = [...this.tunnels.values()]
    for (const entry of open) this.finish(entry, reason, true)
    return open.length
  }

  private finish(entry: Entry, reason: EndReason, notify: boolean): void {
    if (entry.done) return
    entry.done = true
    // Only this entry's own place: the id is never shared, but a map entry must never be taken for another's.
    if (this.tunnels.get(entry.id) === entry) this.tunnels.delete(entry.id)
    for (const release of entry.release.splice(0)) release()
    // What a person is told: a lost session is "offline".
    const failure: TunnelFailure = reason === 'session_closed' ? 'offline' : reason
    if (entry.opening) {
      clearTimeout(entry.opening.timer)
      entry.opening.reject(new TunnelError(failure))
      entry.opening = undefined
    }
    entry.pipe?.stop()
    entry.local?.destroy()
    // The caller's stream just ends; why is in `closed`. (An error event nobody listens for would crash the process.)
    entry.user?.destroy()
    // The other side is told only of an abort it did not cause, and only when it can still hear.
    if (
      notify &&
      reason !== 'session_closed' &&
      reason !== 'offline' &&
      entry.link.state() === 'open'
    ) {
      const wire: TunnelReason = reason === 'timeout' || reason === 'cancelled' ? 'closed' : reason
      this.tell(entry.link, { t: 'tunnel.close', tunnel: entry.id, reason: wire })
    }
    if (entry.role === 'host') this.audited(entry, reason)
    entry.settle?.(failure)
  }

  /**
   * Tells the other computer something about an end, if it can still hear. Never throws: an end must complete.
   * A close is never dropped because the control queue is full: the mux keeps room for it and puts it first, and
   * this waits and tries again if even that was refused.
   */
  private tell(link: TunnelLink, message: TunnelMessage): void {
    void this.sendReliably(link, message).catch(() => {
      // A session that is closing says so by throwing; the tunnel ends either way.
    })
  }

  /** Sends a control message, waiting (a little) for room when the queue is full. Rejects with the last error. */
  private async sendReliably(
    link: TunnelLink,
    message: TunnelMessage,
    stop: () => boolean = () => false
  ): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await link.sendTunnel(message)
        return
      } catch (error) {
        if (
          !(error instanceof NetError) ||
          error.code !== 'rate_limited' ||
          attempt >= SEND_PATIENCE_TRIES
        )
          throw error
      }
      await sleep(SEND_RETRY_MS)
      if (stop()) return
    }
  }

  /** One row says how a tunnel ended and how much went through it; what the SSH server sent counts as read. */
  private audited(entry: Entry, reason: EndReason): void {
    const bytesIn = entry.pipe?.received ?? 0
    const bytesOut = entry.pipe?.sent ?? 0
    const seconds = Math.max(0, Math.round((this.options.clock.now() - entry.openedAt) / 1000))
    this.options.audit.record({
      node: entry.node,
      method: 'editor.close',
      outcome: `${reason}; ${entry.path}; in ${bytesIn} B; out ${bytesOut} B; ${seconds} s`,
      kind: 'change'
    })
    this.options.audit.countRead(entry.node, bytesOut)
  }

  private pipeFor(entry: Entry, local: Duplex): TunnelPipe {
    const io: PipeIo = {
      id: entry.id,
      local,
      send: (message, bytes) => entry.link.sendTunnel(message, bytes),
      abort: (reason, notify) => this.finish(entry, reason, notify),
      finished: () => this.finish(entry, 'closed', false)
    }
    return new TunnelPipe(io)
  }
}
