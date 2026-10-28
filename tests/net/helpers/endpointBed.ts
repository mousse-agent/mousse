import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { duplexPair, type Duplex } from 'node:stream'
import type { NodeId } from '../../../src/shared/net/ids'
import { EditorEndpoint } from '../../../src/mms/net/editor/endpoint/endpoint'
import type { ProcessHost } from '../../../src/mms/net/editor/endpoint/host'
import { linkedPair } from '../../../src/mms/net/editor/endpoint/linkedPair'
import type { EndpointConnection, EndpointEvent } from '../../../src/mms/net/editor/endpoint/port'
import { createUnixHost } from '../../../src/mms/net/editor/endpoint/unixHost'

/**
 * A fixture for the SSH endpoint: the endpoint on a key store that lives in memory, a throwaway home folder, and
 * an `ssh2` client (the library's own, standing in for any editor's) that talks to it over a pair of streams, the
 * way a tunnel does. Nothing listens on a port, and nothing here reads the real home folder or `~/.ssh`.
 */

// `ssh2` is a CommonJS package; its client is used here only as a test peer.
const library = createRequire(import.meta.url)('ssh2') as {
  Client: new () => SshClient
  utils: { generateKeyPairSync(type: 'ed25519'): { private: string; public: string } }
}

/** The slice of the `ssh2` client the tests use. */
export interface SshClient {
  connect(options: Record<string, unknown>): void
  on(event: string, listener: (...args: any[]) => void): this
  once(event: string, listener: (...args: any[]) => void): this
  exec(
    command: string,
    options: Record<string, unknown>,
    callback: (error: Error | undefined, channel: any) => void
  ): boolean
  exec(command: string, callback: (error: Error | undefined, channel: any) => void): boolean
  shell(
    options: Record<string, unknown> | false,
    callback: (error: Error | undefined, channel: any) => void
  ): boolean
  subsys(name: string, callback: (error: Error | undefined, channel: any) => void): boolean
  sftp(callback: (error: Error | undefined, sftp: any) => void): boolean
  forwardOut(
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
    callback: (error: Error | undefined, channel: any) => void
  ): boolean
  forwardIn(
    bindAddr: string,
    bindPort: number,
    callback: (error: Error | undefined, port: number) => void
  ): boolean
  openssh_forwardOutStreamLocal(
    socketPath: string,
    callback: (error: Error | undefined, channel: any) => void
  ): boolean
  end(): void
  destroy(): void
}

export const NODE_A = 'nod_aaaaaaaaaaaaaaaaaaaaaaaaaaaa' as NodeId
export const NODE_B = 'nod_bbbbbbbbbbbbbbbbbbbbbbbbbbbb' as NodeId

export function memoryKeys(): {
  getSecret(name: string): Uint8Array | undefined
  putSecret(name: string, value: Uint8Array): void
  secrets: Map<string, Uint8Array>
} {
  const secrets = new Map<string, Uint8Array>()
  return {
    secrets,
    getSecret: (name) => secrets.get(name),
    putSecret: (name, value) => void secrets.set(name, Buffer.from(value))
  }
}

export function sshKeyPair(): { private: string; public: string } {
  return library.utils.generateKeyPairSync('ed25519')
}

/** Joins two streams with a hop to a later turn in each direction. */
function asyncRelay(a: Duplex, b: Duplex): void {
  const forward = (from: Duplex, to: Duplex): void => {
    from.on('data', (chunk: Buffer) =>
      setImmediate(() => {
        if (!to.destroyed) to.write(chunk)
      })
    )
    from.on('end', () =>
      setImmediate(() => {
        if (!to.destroyed) to.end()
      })
    )
    from.on('close', () => setImmediate(() => to.destroy()))
    from.on('error', () => {})
  }
  forward(a, b)
  forward(b, a)
}

export interface Bed {
  endpoint: EditorEndpoint
  host: ProcessHost
  /** The throwaway home folder of the owner (the real path, which `pwd` prints). */
  home: string
  user: string
  events: EndpointEvent[]
  keys: ReturnType<typeof memoryKeys>
  /** A client connected and logged in on a new tunnel of `node`. */
  connect(options?: {
    node?: NodeId
    username?: string
    authHandler?: string[]
    /** More options for the client's `connect` (a password, a key). */
    extra?: Record<string, unknown>
  }): Promise<Session>
  /** A tunnel with no client on it yet: the client's end of the pair and the endpoint's connection. */
  tunnel(node?: NodeId): { stream: Duplex; connection: EndpointConnection }
  close(): Promise<void>
}

export interface Session {
  client: SshClient
  connection: EndpointConnection
  /** The client's end of the pair, which a tunnel would carry. */
  stream: Duplex
}

export async function endpointBed(options: { host?: ProcessHost } = {}): Promise<Bed> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mousse endpoint ')))
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  const info = userInfo()
  const host =
    options.host ??
    createUnixHost({
      account: {
        user: info.username,
        home,
        shell: info.shell || '/bin/sh',
        ...(info.uid >= 0 ? { uid: info.uid } : {})
      },
      // No `/etc/environment` of this computer in the clean environment a test checks.
      systemEnvironmentFiles: [join(root, 'no-etc-environment')]
    })
  const keys = memoryKeys()
  const events: EndpointEvent[] = []
  const endpoint = new EditorEndpoint({ keys, host, onEvent: (event) => events.push(event) })
  const clients = new Set<SshClient>()
  const connections = new Set<EndpointConnection>()
  const pinned = (): string => endpoint.hostKeys()[0]!.key

  const tunnel = (node: NodeId = NODE_A): { stream: Duplex; connection: EndpointConnection } => {
    const [near, far] = linkedPair()
    const connection = endpoint.serve(far, node)
    connections.add(connection)
    // The client's stream is joined to the tunnel's end by an asynchronous hop, as the Net session is: bytes
    // that one side writes reach the other on a later turn, never inside the writer's own call (which `ssh2`
    // does not tolerate: a reply that is answered before the server has finished sending it).
    const [stream, clientSide] = duplexPair()
    asyncRelay(near, clientSide)
    return { stream, connection }
  }

  return {
    endpoint,
    host,
    home,
    user: host.user,
    events,
    keys,
    tunnel,
    async connect(connectOptions = {}) {
      const { stream, connection } = tunnel(connectOptions.node)
      const client = new library.Client()
      clients.add(client)
      await new Promise<void>((resolve, reject) => {
        client.on('ready', () => resolve())
        client.on('error', reject)
        client.connect({
          sock: stream,
          username: connectOptions.username ?? host.user,
          authHandler: connectOptions.authHandler ?? ['none'],
          // The key the owner vouches for, as the editor's `known_hosts` would pin it.
          hostVerifier: (key: Buffer) => key.toString('base64') === pinned(),
          readyTimeout: 15_000,
          ...connectOptions.extra
        })
      })
      return { client, connection, stream }
    },
    async close() {
      for (const client of clients) client.destroy()
      for (const connection of connections) connection.end(false)
      await host.killScope(endpoint.scopeOf(NODE_A))
      await host.killScope(endpoint.scopeOf(NODE_B))
      await rm(root, { recursive: true, force: true })
    }
  }
}

export interface ExecResult {
  code: number | null
  signal: string | null
  stdout: Buffer
  stderr: string
}

/** Runs `command` on `client` and collects what it did. `stdin` is written and ended. */
export function run(
  client: SshClient,
  command: string,
  options: { stdin?: string | Buffer; env?: Record<string, string>; pty?: boolean } = {}
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(
      command,
      { ...(options.env ? { env: options.env } : {}), ...(options.pty ? { pty: true } : {}) },
      (error, channel) => {
        if (error) return reject(error)
        const out: Buffer[] = []
        let stderr = ''
        let code: number | null = null
        let signal: string | null = null
        channel.on('data', (chunk: Buffer) => out.push(chunk))
        channel.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
        channel.on('exit', (status: number | null, name?: string) => {
          if (typeof status === 'number') code = status
          else signal = name ?? 'unknown'
        })
        channel.on('close', () => resolve({ code, signal, stdout: Buffer.concat(out), stderr }))
        if (options.stdin !== undefined) channel.end(options.stdin)
      }
    )
  })
}

/** Whether a process is alive (a zombie counts as gone: it has been signalled and only waits to be reaped). */
export async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    const { readFile } = await import('node:fs/promises')
    const stat = await readFile(`/proc/${pid}/stat`, 'latin1')
    return !/^\d+ \(.*\) [ZX]/u.test(stat)
  } catch {
    return true
  }
}

export async function until(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
