/**
 * The editor tunnels that programs on this computer hold, for `mousse-cli net ssh-proxy`. The tunnel itself
 * is a Net tunnel (`NetService.openEditorTunnel`); this carries its bytes over the local protocol to the
 * proxy, which the editor's `ssh` started. A tunnel belongs to the local connection that opened it: it is
 * never reachable from another connection, and it ends with that connection.
 *
 * Flow control is by request. The proxy reads one piece at a time and writes one piece at a time. The daemon
 * pauses the tunnel's stream when it holds enough that nobody has read, which makes the tunnel's own credit
 * stop the other computer, and a write is answered when the tunnel has taken the bytes.
 */
import { randomBytes } from 'node:crypto'
import {
  EDITOR_TUNNEL_HANDLE,
  EDITOR_TUNNEL_LOCAL_CHUNK_BYTES,
  EDITOR_TUNNEL_LOCAL_IDLE_MS,
  EDITOR_TUNNEL_LOCAL_READ_WAIT_MS,
  EDITOR_TUNNELS_PER_CONNECTION,
  proxyComputerName,
  type EditorTunnelOpenAnswer,
  type EditorTunnelReadAnswer,
  type EditorTunnelWriteAnswer,
  type ProxyRefusal
} from '../../../shared/net/editorProxy'
import type { NodeId } from '../../../shared/net'
import type { EditorTunnelInfo, TunnelFailure } from '../../../shared/net/tunnel'
import { NetError } from '../../../shared/net'
import { EditorSshError } from './sshConfig'
import { TunnelError, type ClientTunnel } from './tunnel'

/** The local connection a tunnel belongs to. `lifetime` aborts when the connection closes. */
export interface LocalConnection {
  readonly id: string
  readonly lifetime?: AbortSignal
}

export interface LocalTunnelsHost {
  open(
    node: NodeId,
    signal?: AbortSignal
  ): Promise<{ tunnel: ClientTunnel; info: EditorTunnelInfo }>
  /** What the person calls the computer, when it is known. */
  computerName(node: NodeId): string | undefined
}

export interface LocalTunnelsOptions {
  idleMs?: number
  readWaitMs?: number
  perConnection?: number
  /** Bytes held for a reader before the tunnel's stream is paused. */
  holdBytes?: number
}

interface Held {
  handle: string
  connection: string
  tunnel: ClientTunnel
  queue: Buffer[]
  queued: number
  /** The tunnel's stream has no more bytes. */
  streamEnded: boolean
  /** Why the tunnel is over, once it is, and when that became known. */
  over?: TunnelFailure
  overAt?: number
  waiters: Set<() => void>
  idle?: ReturnType<typeof setTimeout>
  release: Array<() => void>
}

/** How long after a tunnel's end its stream may still deliver bytes before it counts as finished. */
const OVER_GRACE_MS = 300

const fail = (reason: ProxyRefusal, computer?: string): EditorTunnelOpenAnswer => ({
  ok: false,
  reason,
  ...(computer ? { computer } : {})
})

export class LocalEditorTunnels {
  private readonly held = new Map<string, Held>()
  /** Tunnels that ended, by handle, so a late read or write is told they are over and not that the handle is unknown. */
  private readonly gone = new Map<string, { connection: string; end: TunnelFailure }>()
  private readonly idleMs: number
  private readonly readWaitMs: number
  private readonly perConnection: number
  private readonly holdBytes: number

  constructor(
    private readonly host: LocalTunnelsHost,
    options: LocalTunnelsOptions = {}
  ) {
    this.idleMs = options.idleMs ?? EDITOR_TUNNEL_LOCAL_IDLE_MS
    this.readWaitMs = options.readWaitMs ?? EDITOR_TUNNEL_LOCAL_READ_WAIT_MS
    this.perConnection = options.perConnection ?? EDITOR_TUNNELS_PER_CONNECTION
    this.holdBytes = options.holdBytes ?? 256 * 1024
  }

  count(connection?: string): number {
    if (connection === undefined) return this.held.size
    let n = 0
    for (const entry of this.held.values()) if (entry.connection === connection) n++
    return n
  }

  /**
   * Opens a tunnel to `node` for `connection`. A refusal is an answer, not an error, so the proxy can print
   * the reason in words; only a bug is thrown.
   */
  async open(connection: LocalConnection, node: NodeId): Promise<EditorTunnelOpenAnswer> {
    const computer = proxyComputerName(this.host.computerName(node))
    if (connection.lifetime?.aborted) return fail('cancelled', computer)
    if (this.count(connection.id) >= this.perConnection) return fail('limit', computer)
    let opened: Awaited<ReturnType<LocalTunnelsHost['open']>>
    try {
      opened = await this.host.open(node, connection.lifetime)
    } catch (error) {
      return fail(refusalOf(error), computer)
    }
    const { tunnel, info } = opened
    // The connection went away while the tunnel was opening: nobody will read it.
    if (connection.lifetime?.aborted) {
      tunnel.close()
      return fail('cancelled', computer)
    }
    const entry: Held = {
      handle: randomBytes(16).toString('hex'),
      connection: connection.id,
      tunnel,
      queue: [],
      queued: 0,
      streamEnded: false,
      waiters: new Set(),
      release: []
    }
    this.held.set(entry.handle, entry)
    const wake = (): void => {
      for (const waiter of [...entry.waiters]) waiter()
    }
    const onData = (chunk: Buffer): void => {
      entry.queue.push(chunk)
      entry.queued += chunk.length
      if (entry.queued >= this.holdBytes) tunnel.stream.pause()
      wake()
    }
    const onEnd = (): void => {
      entry.streamEnded = true
      wake()
    }
    tunnel.stream.on('data', onData)
    tunnel.stream.once('end', onEnd)
    tunnel.stream.once('close', onEnd)
    // An error on the stream ends it too; the tunnel's own `closed` says why.
    tunnel.stream.on('error', onEnd)
    entry.release.push(() => {
      tunnel.stream.off('data', onData)
      tunnel.stream.off('end', onEnd)
      tunnel.stream.off('close', onEnd)
      tunnel.stream.off('error', onEnd)
    })
    // The reason arrives with the tunnel's end. What the stream still holds is read before the end is told.
    void tunnel.closed.then(
      (why) => {
        entry.over = why
        entry.overAt = Date.now()
        wake()
      },
      () => {
        entry.over = 'closed'
        entry.overAt = Date.now()
        wake()
      }
    )
    if (connection.lifetime) {
      const abort = (): void => this.drop(entry)
      connection.lifetime.addEventListener('abort', abort, { once: true })
      entry.release.push(() => connection.lifetime!.removeEventListener('abort', abort))
    }
    this.touch(entry)
    return {
      ok: true,
      handle: entry.handle,
      path: info.path,
      ...(info.transport ? { transport: info.transport } : {}),
      computer: computer ?? ''
    }
  }

  /** Bytes the other computer's SSH server sent, or why the tunnel is over. Waits for some, up to `waitMs`. */
  async read(
    connection: string,
    handle: string,
    waitMs: number = this.readWaitMs
  ): Promise<EditorTunnelReadAnswer> {
    const over = this.overOf(connection, handle)
    if (over) return { end: over }
    const entry = this.find(connection, handle)
    this.touch(entry)
    const deadline = Math.min(Math.max(0, waitMs), this.readWaitMs)
    const until = Date.now() + deadline
    // Once the tunnel is over, only the grace is waited for: the rest of what it sent is already on its way.
    while (!entry.queued && !this.finished(entry) && this.held.get(handle) === entry) {
      const left = until - Date.now()
      if (left <= 0) break
      await this.waitFor(entry, entry.over ? Math.min(left, OVER_GRACE_MS + 50) : left)
    }
    if (this.held.get(handle) !== entry) return { end: entry.over ?? 'closed' }
    if (entry.queued) {
      const data = this.take(entry)
      this.touch(entry)
      return { data: data.toString('base64') }
    }
    if (this.finished(entry)) {
      // The reason arrives with the tunnel's own end, a moment after the stream's.
      if (!entry.over) await this.waitFor(entry, 250)
      const end = entry.over ?? 'closed'
      this.drop(entry)
      return { end }
    }
    return {}
  }

  /** Writes bytes the editor's `ssh` sent. Answers when the tunnel has taken them. */
  async write(connection: string, handle: string, data: Buffer): Promise<EditorTunnelWriteAnswer> {
    const over = this.overOf(connection, handle)
    if (over) return { end: over }
    const entry = this.find(connection, handle)
    if (data.length > EDITOR_TUNNEL_LOCAL_CHUNK_BYTES) throw new NetError('too_large')
    this.touch(entry)
    if (entry.over || entry.tunnel.stream.destroyed || entry.tunnel.stream.writableEnded)
      return { end: await this.endOf(entry) }
    const written = await new Promise<boolean>((resolve) => {
      try {
        entry.tunnel.stream.write(data, (error) => resolve(!error))
      } catch {
        resolve(false)
      }
    })
    this.touch(entry)
    return written ? { ok: true } : { end: await this.endOf(entry) }
  }

  /**
   * The editor's `ssh` is done writing: the tunnel's write side is ended (the other computer's SSH server sees the
   * end after everything written before it), and reads go on until that server ends the tunnel.
   */
  async end(connection: string, handle: string): Promise<{ ok: true } | { end: TunnelFailure }> {
    const over = this.overOf(connection, handle)
    if (over) return { end: over }
    const entry = this.find(connection, handle)
    this.touch(entry)
    if (entry.over || entry.tunnel.stream.destroyed) return { end: await this.endOf(entry) }
    await new Promise<void>((resolve) => {
      try {
        if (entry.tunnel.stream.writableEnded) return resolve()
        entry.tunnel.stream.end(() => resolve())
      } catch {
        resolve()
      }
    })
    this.touch(entry)
    return { ok: true }
  }

  close(connection: string, handle: string): void {
    const entry = this.held.get(handle)
    if (entry && entry.connection === connection) this.drop(entry)
  }

  /** The connection is gone (or its profile changed): its tunnels end. */
  closeConnection(connection: string): void {
    for (const entry of [...this.held.values()])
      if (entry.connection === connection) this.drop(entry)
  }

  closeAll(): void {
    for (const entry of [...this.held.values()]) this.drop(entry)
  }

  /** Why the tunnel ended, for a handle of this connection that no longer exists. */
  private overOf(connection: string, handle: string): TunnelFailure | undefined {
    const ended = this.gone.get(handle)
    return ended && ended.connection === connection && !this.held.has(handle)
      ? ended.end
      : undefined
  }

  private find(connection: string, handle: string): Held {
    const entry = EDITOR_TUNNEL_HANDLE.test(handle) ? this.held.get(handle) : undefined
    // Another connection's tunnel does not exist for this one.
    if (!entry || entry.connection !== connection)
      throw new NetError('bad_request', 'Unknown tunnel.')
    return entry
  }

  /**
   * Nothing more will come: the stream ended. The tunnel's end (`over`) can be known before the stream has
   * delivered its last bytes, so it counts only after a short wait with nothing arriving, which a stream that
   * never ends (a bug elsewhere) cannot turn into a tunnel that is held forever.
   */
  private finished(entry: Held): boolean {
    return entry.streamEnded || (!!entry.overAt && Date.now() - entry.overAt >= OVER_GRACE_MS)
  }

  private async endOf(entry: Held): Promise<TunnelFailure> {
    if (!entry.over) await this.waitFor(entry, 250)
    return entry.over ?? 'closed'
  }

  private take(entry: Held): Buffer {
    const parts: Buffer[] = []
    let size = 0
    while (entry.queue.length && size < EDITOR_TUNNEL_LOCAL_CHUNK_BYTES) {
      const head = entry.queue[0]!
      const room = EDITOR_TUNNEL_LOCAL_CHUNK_BYTES - size
      if (head.length <= room) {
        parts.push(head)
        size += head.length
        entry.queue.shift()
      } else {
        parts.push(head.subarray(0, room))
        entry.queue[0] = head.subarray(room)
        size += room
      }
    }
    entry.queued -= size
    if (entry.queued < this.holdBytes / 4 && !entry.streamEnded) entry.tunnel.stream.resume()
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts, size)
  }

  private waitFor(entry: Held, ms: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = (): void => {
        if (timer) clearTimeout(timer)
        entry.waiters.delete(done)
        resolve()
      }
      timer = setTimeout(done, ms)
      timer.unref?.()
      entry.waiters.add(done)
    })
  }

  private touch(entry: Held): void {
    if (entry.idle) clearTimeout(entry.idle)
    entry.idle = setTimeout(() => this.drop(entry), this.idleMs)
    entry.idle.unref?.()
  }

  private drop(entry: Held): void {
    if (this.held.get(entry.handle) !== entry) return
    this.held.delete(entry.handle)
    this.gone.set(entry.handle, { connection: entry.connection, end: entry.over ?? 'closed' })
    // Bounded: the oldest are forgotten first.
    while (this.gone.size > 256) this.gone.delete(this.gone.keys().next().value as string)
    if (entry.idle) clearTimeout(entry.idle)
    for (const release of entry.release.splice(0)) release()
    try {
      entry.tunnel.close()
    } catch {
      // Already over.
    }
    for (const waiter of [...entry.waiters]) waiter()
  }
}

/** The word for why `openEditorTunnel` failed. A tunnel refusal keeps its own reason. */
function refusalOf(error: unknown): ProxyRefusal {
  if (error instanceof TunnelError) return error.reason
  if (error instanceof EditorSshError)
    return error.code === 'unknown_computer' ? 'unknown_computer' : 'ssh_settings'
  if (error instanceof NetError) {
    if (error.code === 'bad_request') return 'unknown_computer'
    if (error.code === 'peer_offline') return 'offline'
    if (error.code === 'cancelled') return 'cancelled'
    // Only these say that networking is off or not set up; any other code is not that.
    if (error.code === 'disabled' || error.code === 'not_enrolled') return 'net_disabled'
    return 'failed'
  }
  return 'failed'
}
