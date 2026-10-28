import { randomBytes } from 'node:crypto'
import {
  connect as tcpConnect,
  createServer,
  type Server as TcpServer,
  type Socket
} from 'node:net'
import type { Duplex } from 'node:stream'
import type { AuthContext, Connection, ServerChannel, ServerSession } from 'ssh2'
import type { NodeId } from '../../../../shared/net/ids'
import type { TunnelHostKey } from '../../../../shared/net/tunnel'
import type { KeyStore } from '../../contracts'
import { acceptsEnvironmentRequest, ENV_REQUESTS_MAX } from './environment'
import type { ProcessHost, SessionProcess } from './host'
import { loadEndpointHostKey, type EndpointHostKey } from './hostKey'
import { ssh2 } from './library'
import { isForwardPort, loopbackTargets } from './loopback'
import type { EditorEndpointPort, EndpointConnection, EndpointCounts, EndpointEvent } from './port'
import { scopeToken } from './scope'
import { serveSftp } from './sftp/server'

/**
 * The Mousse SSH endpoint: an SSH server inside the daemon that answers an editor's connection itself, so a
 * computer needs no SSH server, no `authorized_keys` and no setup (docs/net/threat-model.md, "Editor
 * connections").
 *
 * - **No listener.** One `ssh2` `Server` per tunnel, fed the tunnel's stream with `injectSocket`. Nothing on this
 *   computer can connect to it; the tunnel is the only way in, and a tunnel exists only for a device the owner
 *   allowed.
 * - **The tunnel is the login.** The device that opened the tunnel is already proven by Net, and the owner's
 *   switch is the grant, so SSH authentication adds nothing: the login is accepted on the client's first try of any
 *   method (OpenSSH tries `none` first; a client that does not never has to prompt), if the user name is the
 *   owner's login. A login is bound to the device and audited.
 * - **Loopback only.** Port forwards reach 127.0.0.0/8 and `::1`, by address and never by name; `-R` binds the
 *   loopback; unix-socket forwards, agent forwarding and X11 are refused; the only subsystem is `sftp`.
 * - **Ending.** An ordinary end behaves as `sshd` does; a forced end stops everything the device started
 *   (`scope.ts`).
 */

/** What the owner's audit and the connection limits are measured against. */
const LOGIN_GRACE_MS = 60_000
const AUTH_TRIES_MAX = 6
const CHANNELS_MAX = 256
const SESSIONS_MAX = 64
const REMOTE_FORWARDS_MAX = 16
const FORWARD_CONNECT_MS = 5_000
const SCOPE_KEY_SECRET = 'editor/endpoint/scope-key'

export interface EditorEndpointOptions {
  keys: Pick<KeyStore, 'getSecret' | 'putSecret'>
  /** The system's host; none means the endpoint is unavailable (Windows, until its host exists). */
  host: ProcessHost | undefined
  /** What the connections do that the audit says. Counts and kinds only. */
  onEvent?: (event: EndpointEvent) => void
}

/** Plain text for a client that asked for something the endpoint does not do. */
const REFUSAL_TEXT = 'mousse: not available through Mousse\n'

export class EditorEndpoint implements EditorEndpointPort {
  private hostKey?: EndpointHostKey
  private scopeKey?: Uint8Array
  private readonly connections = new Map<NodeId, Set<ConnectionState>>()
  private readonly tokenNodes = new Map<string, NodeId>()
  private serial = 0

  constructor(private readonly options: EditorEndpointOptions) {}

  available(): boolean {
    return this.options.host !== undefined
  }

  private key(): EndpointHostKey {
    return (this.hostKey ??= loadEndpointHostKey(this.options.keys))
  }

  hostKeys(): TunnelHostKey[] {
    return [this.key().publicKey]
  }

  /** The marker of `node`'s programs: stable across restarts (a keyed hash of the id), so they are still found. */
  scopeOf(node: NodeId): string {
    if (!this.scopeKey) {
      let held = this.options.keys.getSecret(SCOPE_KEY_SECRET)
      if (!held) {
        held = randomBytes(32)
        this.options.keys.putSecret(SCOPE_KEY_SECRET, held)
      }
      this.scopeKey = held
    }
    const token = scopeToken(this.scopeKey, node)
    this.tokenNodes.set(token, node)
    return token
  }

  serve(stream: Duplex, node: NodeId): EndpointConnection {
    const host = this.options.host
    if (!host) throw new Error('The SSH endpoint is not available on this computer.')
    const hostKey = this.key()
    const state = new ConnectionState({
      node,
      stream,
      host,
      scope: this.scopeOf(node),
      label: `127.0.0.1 ${50_000 + (this.serial++ % 10_000)}`,
      emit: (event) => {
        try {
          this.options.onEvent?.(event)
        } catch {
          // An audit that failed never ends a connection.
        }
      },
      forceKill: () => this.killDevice(node),
      onClosed: () => {
        const set = this.connections.get(node)
        set?.delete(state)
        if (set && !set.size) this.connections.delete(node)
      }
    })
    const set = this.connections.get(node) ?? new Set<ConnectionState>()
    set.add(state)
    this.connections.set(node, set)
    const { Server } = ssh2()
    const server = new Server({ hostKeys: [hostKey.privateKey], ident: 'MousseSSH' })
    server.on('connection', (client) => state.attach(client))
    server.on('error', () => {})
    stream.on('error', () => {})
    // The stream of one connection and the connection are one thing: if either ends, so does the other.
    stream.once('close', () => state.end(false))
    // The other side finished sending: an SSH connection has no half-open state, so it is over.
    stream.once('end', () => state.end(false))
    server.injectSocket(stream)
    return { end: (forced) => state.end(forced), counts: () => state.counts }
  }

  async killDevice(node: NodeId): Promise<void> {
    await this.options.host?.killScope(this.scopeOf(node))
  }

  devices(): NodeId[] {
    const nodes = new Set<NodeId>(this.connections.keys())
    for (const token of this.options.host?.scopes() ?? []) {
      const node = this.tokenNodes.get(token)
      if (node) nodes.add(node)
    }
    return [...nodes]
  }
}

interface ConnectionInit {
  node: NodeId
  stream: Duplex
  host: ProcessHost
  scope: string
  /** The client's address as `SSH_CONNECTION` holds it. */
  label: string
  emit(event: EndpointEvent): void
  forceKill(): Promise<void>
  onClosed(): void
}

/** What a session channel has asked for so far, and the program it started. */
interface SessionState {
  requested: Record<string, string>
  pty?: { cols: number; rows: number; term: string }
  running?: Running
}

/** What is running in one session channel. */
interface Running {
  process: SessionProcess
  ended: boolean
}

class ConnectionState {
  readonly counts: EndpointCounts = { exec: 0, shell: 0, sftp: 0, forwards: 0 }
  private client?: Connection
  private closed = false
  /** The connection ended with a block or the like: everything it started is stopped, not hung up. */
  private forced = false
  private authenticated = false
  private authTries = 0
  private refusedUserSaid = false
  private readonly running = new Set<Running>()
  /** Channels that are not a program: forwards and SFTP. They end with the connection. */
  private readonly channels = new Set<{ destroy(): void }>()
  private readonly listeners = new Map<string, TcpServer>()
  private channelCount = 0
  /** Programs being started (their request is accepted, their process not yet running). */
  private starting = 0
  private grace?: ReturnType<typeof setTimeout>

  constructor(private readonly init: ConnectionInit) {
    // A connection that never signs in holds a tunnel for nothing.
    this.grace = setTimeout(() => {
      if (!this.authenticated) {
        this.init.emit({ kind: 'login_refused', node: init.node, reason: 'grace' })
        this.end(false)
      }
    }, LOGIN_GRACE_MS)
    this.grace.unref?.()
  }

  attach(client: Connection): void {
    this.client = client
    client.on('error', () => {})
    client.on('authentication', (context) => this.authenticate(context))
    client.on('ready', () => {
      if (this.grace) clearTimeout(this.grace)
      client.on('session', (accept, reject) => this.session(accept, reject))
      client.on('tcpip', (accept, reject, info) => this.directTcpip(accept, reject, info))
      // Forwards to a unix socket (`ssh -L port:/path`) are not carried.
      client.on('openssh.streamlocal', (_accept, reject) => {
        this.refuse('streamlocal')
        reject()
      })
      client.on('request', (accept, reject, name, info) =>
        this.globalRequest(name, info, accept, reject)
      )
    })
    client.on('close', () => this.end(false))
  }

  // ---------------------------------------------------------------- login

  private authenticate(context: AuthContext): void {
    const { node, host } = this.init
    // Windows names are not case-sensitive; no other system's are.
    const user =
      host.kind === 'windows'
        ? context.username.toLowerCase() === host.user.toLowerCase()
        : context.username === host.user
    if (!user) {
      if (!this.refusedUserSaid) {
        this.refusedUserSaid = true
        this.init.emit({ kind: 'login_refused', node, reason: 'user' })
      }
      // Six tries, as OpenSSH's default; then the connection is closed.
      if (++this.authTries >= AUTH_TRIES_MAX) {
        this.init.emit({ kind: 'login_refused', node, reason: 'too_many' })
        context.reject([])
        this.end(false)
        return
      }
      return context.reject([])
    }
    // "Would this key do?" is a question, not a login: the answer is yes, and the login follows with a signature.
    if (context.method === 'publickey' && context.signature === undefined) return context.accept()
    this.authenticated = true
    this.init.emit({ kind: 'login', node, method: context.method })
    context.accept()
  }

  // ---------------------------------------------------------------- channels

  private refuse(what: Extract<EndpointEvent, { kind: 'refused' }>['what']): void {
    this.init.emit({ kind: 'refused', node: this.init.node, what })
  }

  /** A channel slot, or false when the connection already has all it may have. */
  private take(): boolean {
    if (this.closed) return false
    if (this.channelCount >= CHANNELS_MAX) {
      this.refuse('channel_limit')
      return false
    }
    this.channelCount++
    return true
  }
  private release(): void {
    this.channelCount = Math.max(0, this.channelCount - 1)
  }

  private session(accept: () => ServerSession, reject: () => void): void {
    if (!this.take()) return reject()
    const session = accept()
    let released = false
    const give = (): void => {
      if (released) return
      released = true
      this.release()
    }
    session.on('close', give)
    const request: SessionState = { requested: {} }
    let environmentRequests = 0
    session.on('env', (acceptRequest, rejectRequest, info) => {
      if (environmentRequests < ENV_REQUESTS_MAX && acceptsEnvironmentRequest(info.key, info.val)) {
        environmentRequests++
        request.requested[info.key] = info.val
        acceptRequest?.()
      } else rejectRequest?.()
    })
    session.on('pty', (acceptRequest, rejectRequest, info) => {
      if (!this.init.host.terminals()) {
        this.refuse('terminal')
        return rejectRequest?.()
      }
      const term = /^[A-Za-z0-9._+-]{1,64}$/u.test(info.term ?? '') ? info.term : 'xterm-256color'
      request.pty = { cols: clampSize(info.cols, 80), rows: clampSize(info.rows, 24), term }
      acceptRequest?.()
    })
    session.on('window-change', (acceptRequest, _rejectRequest, info) => {
      const cols = clampSize(info.cols, 80)
      const rows = clampSize(info.rows, 24)
      if (request.pty) request.pty = { ...request.pty, cols, rows }
      request.running?.process.resize(cols, rows)
      acceptRequest?.()
    })
    session.on('signal', (acceptRequest, _rejectRequest, info) => {
      request.running?.process.signal(String(info.name))
      acceptRequest?.()
    })
    // Agent forwarding and X11 would hand this computer's sockets and screen to the other computer.
    session.on('auth-agent', (_acceptRequest, rejectRequest) => {
      this.refuse('agent')
      rejectRequest?.()
    })
    session.on('x11', (_acceptRequest, rejectRequest) => {
      this.refuse('x11')
      rejectRequest?.()
    })
    session.on('shell', (acceptRequest, rejectRequest) => {
      this.counts.shell++
      void this.start(request, undefined, acceptRequest, rejectRequest)
    })
    session.on('exec', (acceptRequest, rejectRequest, info) => {
      this.counts.exec++
      void this.start(request, info.command, acceptRequest, rejectRequest)
    })
    session.on('subsystem', (acceptRequest, rejectRequest, info) => {
      if (info.name !== 'sftp') {
        this.refuse('subsystem')
        return rejectRequest()
      }
      this.counts.sftp++
      const channel = acceptRequest()
      if (!channel) return
      this.channels.add(channel)
      channel.once('close', () => this.channels.delete(channel))
      serveSftp(channel, {
        paths: this.init.host.sftp.paths,
        user: this.init.host.user,
        ...(this.init.host.sftp.listRoots ? { listRoots: this.init.host.sftp.listRoots } : {})
      })
    })
  }

  /** The program of a shell or exec request: started, wired to the channel, and reported when it ends. */
  private async start(
    request: SessionState,
    command: string | undefined,
    accept: () => ServerChannel,
    reject: () => void
  ): Promise<void> {
    if (this.running.size + this.starting >= SESSIONS_MAX) {
      this.refuse('channel_limit')
      return reject()
    }
    // The request is accepted at once, before anything is awaited: a client that has no input (`ssh host cmd < /dev/null`)
    // sends EOF right behind the request, and `ssh2` drops a channel that gets its EOF before it was accepted, so the
    // client would wait for an answer that never comes.
    const channel = accept()
    if (!channel) return
    this.starting++
    let channelClosed = false
    channel.once('close', () => {
      channelClosed = true
    })
    let program: SessionProcess
    try {
      program = await this.init.host.start({
        command,
        ...(request.pty ? { pty: request.pty } : {}),
        requested: { ...request.requested },
        sshConnection: `${this.init.label} 127.0.0.1 22`,
        scope: this.init.scope
      })
    } catch (error) {
      this.starting--
      try {
        // What `sshd` does when it cannot run the shell: says so, and the command has failed.
        channel.stderr.write(
          `mousse: ${error instanceof Error ? error.message : 'could not start'}\n`
        )
        channel.exit(127)
        channel.end()
      } catch {
        // The channel is gone.
      }
      return
    }
    this.starting--
    const running: Running = { process: program, ended: false }
    // The connection or the channel ended while the program was being started: it is let go as any other would be.
    if (this.closed || channelClosed) {
      // A forced end that came while the program was starting stops it too; the sweep may have run before it existed.
      if (this.forced) program.kill()
      else program.hangUp()
      return
    }
    request.running = running
    this.running.add(running)
    channel.pipe(program.input)
    program.output.pipe(channel, { end: false })
    if (program.errors) program.errors.pipe(channel.stderr, { end: false })
    program.onError((error) => {
      running.ended = true
      this.running.delete(running)
      try {
        channel.stderr.write(`mousse: ${error.message}\n`)
        channel.exit(127)
        channel.end()
      } catch {
        // The channel is gone.
      }
    })
    program.onExit((exit) => {
      running.ended = true
      this.running.delete(running)
      try {
        if (exit.signal) channel.exit(exit.signal.replace(/^SIG/u, ''), false, '')
        else channel.exit(exit.code ?? 0)
      } catch {
        // The channel is gone.
      }
    })
    program.onClose(() => {
      try {
        channel.end()
      } catch {
        // The channel is gone.
      }
    })
    // The client closed the channel (or the window): what `sshd` does, which keeps editor servers alive.
    channel.on('close', () => {
      if (!running.ended) program.hangUp()
    })
  }

  // ---------------------------------------------------------------- forwards

  private directTcpip(
    accept: () => ServerChannel,
    reject: () => void,
    info: { destIP: string; destPort: number }
  ): void {
    const hosts = loopbackTargets(info.destIP)
    // Decided on the text of the address, before anything is connected or looked up.
    if (!hosts || !isForwardPort(info.destPort)) {
      this.refuse('direct-tcpip')
      return reject()
    }
    if (!this.take()) return reject()
    void connectLoopback(hosts, info.destPort).then(
      (socket) => {
        if (this.closed) {
          this.release()
          return void socket.destroy()
        }
        const channel = accept()
        if (!channel) {
          this.release()
          return void socket.destroy()
        }
        this.counts.forwards++
        this.channels.add(channel)
        socket.setNoDelay(true)
        channel.pipe(socket)
        socket.pipe(channel)
        const done = (): void => {
          this.release()
          this.channels.delete(channel)
          socket.destroy()
          channel.destroy()
        }
        channel.once('close', done)
        socket.once('close', done)
        socket.on('error', () => {})
        channel.on('error', () => {})
      },
      () => {
        this.release()
        reject()
      }
    )
  }

  private globalRequest(
    name: string,
    info: unknown,
    accept: ((chosenPort?: number) => void) | undefined,
    reject: (() => void) | undefined
  ): void {
    if (name === 'cancel-tcpip-forward') {
      const bind = info as { bindAddr: string; bindPort: number }
      const key = `${bind.bindAddr}:${bind.bindPort}`
      this.listeners.get(key)?.close()
      this.listeners.delete(key)
      return accept?.()
    }
    if (name !== 'tcpip-forward') {
      // `streamlocal-forward@openssh.com` and its cancel: a unix socket on this computer is not offered.
      if (name === 'streamlocal-forward@openssh.com') this.refuse('streamlocal')
      return reject?.()
    }
    const bind = info as { bindAddr: string; bindPort: number }
    // An empty address asks for the server's choice, which is the loopback (sshd's `GatewayPorts no`); `localhost`
    // is the loopback; `0.0.0.0`, `*` and every other address are refused.
    const hosts = bind.bindAddr === '' ? ['127.0.0.1'] : loopbackTargets(bind.bindAddr)
    if (
      !hosts ||
      !(bind.bindPort === 0 || isForwardPort(bind.bindPort)) ||
      this.listeners.size >= REMOTE_FORWARDS_MAX
    ) {
      this.refuse('tcpip-forward')
      return reject?.()
    }
    const client = this.client
    if (!client) return reject?.()
    const key = `${bind.bindAddr}:${bind.bindPort}`
    const server = createServer((socket) => {
      const port = (server.address() as { port: number } | null)?.port ?? bind.bindPort
      client.forwardOut(
        bind.bindAddr,
        port,
        socket.remoteAddress ?? '127.0.0.1',
        socket.remotePort ?? 0,
        (error, channel) => {
          if (error || !channel) return void socket.destroy()
          this.counts.forwards++
          this.channels.add(channel)
          socket.pipe(channel)
          channel.pipe(socket)
          const done = (): void => {
            this.channels.delete(channel)
            socket.destroy()
            channel.destroy()
          }
          channel.once('close', done)
          socket.once('close', done)
          socket.on('error', () => {})
          channel.on('error', () => {})
        }
      )
    })
    server.on('error', () => reject?.())
    server.listen({ host: hosts[0]!, port: bind.bindPort }, () => {
      if (this.closed) return void server.close()
      this.listeners.set(key, server)
      server.once('close', () => this.listeners.delete(key))
      accept?.((server.address() as { port: number }).port)
    })
  }

  // ---------------------------------------------------------------- ending

  /** The connection is over. See `EndpointConnection.end`. */
  end(forced: boolean): void {
    if (this.closed) return
    this.closed = true
    this.forced = forced
    if (this.grace) clearTimeout(this.grace)
    for (const running of [...this.running]) {
      if (forced) running.process.kill()
      else running.process.hangUp()
    }
    this.running.clear()
    for (const channel of this.channels) channel.destroy()
    this.channels.clear()
    for (const server of this.listeners.values()) server.close()
    this.listeners.clear()
    try {
      this.client?.end()
    } catch {
      // The connection is already gone.
    }
    this.init.stream.destroy()
    this.init.onClosed()
    // Everything the device started, including servers that left their session. Not waited for: the caller is the
    // tunnel (or the thread of a block), which must not stand still while the lists are read.
    if (forced) void this.init.forceKill().catch(() => {})
  }
}

function clampSize(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 1000
    ? value
    : fallback
}

/** A connection to the first of `hosts` that answers, for `FORWARD_CONNECT_MS` at most each. */
function connectLoopback(hosts: string[], port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const attempt = (index: number): void => {
      const host = hosts[index]
      if (host === undefined) return reject(new Error('refused'))
      const socket = tcpConnect({ host, port })
      const timer = setTimeout(() => fail(), FORWARD_CONNECT_MS)
      timer.unref?.()
      const fail = (): void => {
        clearTimeout(timer)
        socket.destroy()
        attempt(index + 1)
      }
      socket.once('error', fail)
      socket.once('connect', () => {
        clearTimeout(timer)
        socket.removeListener('error', fail)
        resolve(socket)
      })
    }
    attempt(0)
  })
}
