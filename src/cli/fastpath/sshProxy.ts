import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { MMS_PROTOCOL_VERSION } from '../../mms/protocol/types'
import { FrameDecoder, encodeFrame } from '../../mms/protocol/framing'
import { isId } from '../../shared/net/ids'
import { NET_LOCAL_CAPABILITY } from '../../shared/net/local'
import { PROFILES_V1_CAPABILITY } from '../../shared/profiles/types'
import {
  EDITOR_TUNNEL_LOCAL_CHUNK_BYTES,
  EDITOR_TUNNEL_LOCAL_READ_WAIT_MS,
  SSH_PROXY_EXIT,
  proxyMessage,
  type EditorTunnelOpenAnswer,
  type EditorTunnelReadAnswer,
  type EditorTunnelWriteAnswer,
  type ProxyLocalProblem,
  type ProxyRefusal
} from '../../shared/net/editorProxy'
import type { TunnelFailure } from '../../shared/net/tunnel'

/**
 * `mousse-cli net ssh-proxy <node-id> --profile <profile>`: the program an editor's `ssh` starts as its
 * `ProxyCommand` (the line Mousse writes into `~/.mousse/ssh/config`). It asks the daemon of this computer to
 * open an editor tunnel to the other computer's SSH server and moves bytes between that tunnel and its own
 * stdin and stdout, raw, until either side ends.
 *
 * - stdout carries tunnel bytes and nothing else: no banner, no log, no warning. Every word goes to stderr, as
 *   one plain line, which the editor shows in its log.
 * - The exit code is 0 when either side ended the connection in the ordinary way, 1 when it was refused or
 *   broke, and 2 for a bad command line.
 *
 * It runs on every reconnect of an editor, so it is dispatched before the CLI loads anything and imports only
 * Node's own modules and a few small shared files. It does not start the daemon: a reconnect that finds
 * Mousse closed says so and fails. It keeps its own small copies of how the local endpoint is found
 * (`src/mms/protocol/endpoint.ts`) and of the owner file (`src/mms/ownership/MmsOwnerLease.ts`); a test checks
 * that both agree.
 */

export interface SshProxyIo {
  stdin: NodeJS.ReadableStream & { pause(): unknown; resume(): unknown }
  stdout: { write(chunk: Uint8Array, callback: (error?: Error | null) => void): unknown }
  stderr: { write(text: string, callback?: (error?: Error | null) => void): unknown }
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  home: () => string
  /** How long to keep reading after `ssh` closed its end (milliseconds); tests shorten it. */
  halfCloseWaitMs?: number
  /** Tests dial a socket of their own. */
  connect?: (endpoint: string) => Socket
}

export function isSshProxyArgv(argv: readonly string[]): boolean {
  return argv[0] === 'net' && argv[1] === 'ssh-proxy'
}

const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

/** `net ssh-proxy <node> --profile <id> [--home <dir>]`, flags in any order; anything else is a bad command line. */
export function parseSshProxyArgv(
  argv: readonly string[]
): { node: string; profile: string; home?: string } | undefined {
  if (!isSshProxyArgv(argv)) return undefined
  let node: string | undefined
  let profile: string | undefined
  let home: string | undefined
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!
    const flag = /^--(profile|home)(?:=(.*))?$/u.exec(arg)
    if (flag) {
      const value = flag[2] ?? argv[++i]
      if (!value) return undefined
      if (flag[1] === 'profile') {
        if (profile !== undefined) return undefined
        profile = value
      } else {
        if (home !== undefined) return undefined
        home = value
      }
    } else if (arg.startsWith('-') || node !== undefined) return undefined
    else node = arg
  }
  if (!node || !isId('node', node) || !profile || !PROFILE_ID.test(profile)) return undefined
  return { node, profile, ...(home ? { home } : {}) }
}

/** The endpoint of the daemon of `home`: a named pipe on Windows, a socket in the home elsewhere. */
export function localEndpoint(home: string, platform: NodeJS.Platform): string {
  const canonical = resolve(home)
  if (platform === 'win32')
    return `\\\\.\\pipe\\mousse-mms-${createHash('sha256').update(canonical, 'utf-8').digest('hex').slice(0, 32)}`
  return join(canonical, 'mms.sock')
}

/** The daemon's token and endpoint, from the owner file in its home. Undefined when there is no daemon. */
export function readDaemon(
  home: string,
  platform: NodeJS.Platform
): { token: string; endpoint: string } | undefined {
  let record: unknown
  try {
    record = JSON.parse(readFileSync(join(resolve(home), 'mms.owner.json'), 'utf-8'))
  } catch {
    return undefined
  }
  const row = record && typeof record === 'object' ? (record as Record<string, unknown>) : {}
  if (typeof row.token !== 'string' || !row.token) return undefined
  return {
    token: row.token,
    endpoint:
      typeof row.endpoint === 'string' && row.endpoint
        ? row.endpoint
        : localEndpoint(home, platform)
  }
}

class Refusal extends Error {
  constructor(
    readonly reason: ProxyRefusal | ProxyLocalProblem,
    readonly computer?: string
  ) {
    super(reason)
  }
}

/** A protocol failure of the daemon, as the proxy words it. */
function daemonProblem(code: unknown): Refusal {
  if (code === 'profile_not_found' || code === 'profile_archived') return new Refusal('profile')
  if (code === 'method_not_available' || code === 'capability_required')
    return new Refusal('daemon_old')
  if (code === 'protocol_version') return new Refusal('daemon_version')
  if (code === 'bad_request' || code === 'unknown_field') return new Refusal('daemon_old')
  return new Refusal('failed')
}

/** The frames of the local protocol, request and answer, over one socket. */
class LocalLine {
  private readonly decoder = new FrameDecoder()
  private readonly pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void }
  >()
  private helloDone?: { resolve(): void; reject(error: Error): void }
  private lost?: Error
  private next = 0
  readonly closed: Promise<void>
  private closeNow!: () => void

  constructor(private readonly socket: Socket) {
    this.closed = new Promise<void>((resolve) => (this.closeNow = resolve))
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('error', (error) => this.lose(error))
    socket.on('close', () => this.lose(new Error('closed')))
  }

  private lose(error: Error): void {
    if (this.lost) return
    this.lost = error
    this.helloDone?.reject(error)
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
    this.closeNow()
  }

  private onData(chunk: Buffer): void {
    let frames: unknown[]
    try {
      this.decoder.push(chunk)
      frames = this.decoder.shiftAll()
    } catch (error) {
      this.lose(error instanceof Error ? error : new Error('bad frame'))
      this.socket.destroy()
      return
    }
    for (const frame of frames) {
      const row = frame && typeof frame === 'object' ? (frame as Record<string, unknown>) : {}
      if (row.kind === 'hello_ok') this.helloDone?.resolve()
      else if (row.kind === 'hello_err') this.helloDone?.reject(daemonProblem(row.code))
      else if (row.kind === 'res' && typeof row.id === 'string') {
        const entry = this.pending.get(row.id)
        if (!entry) continue
        this.pending.delete(row.id)
        if (row.ok === false) {
          const error =
            row.error && typeof row.error === 'object' ? (row.error as Record<string, unknown>) : {}
          entry.reject(daemonProblem(error.code))
        } else entry.resolve(row.result)
      }
      // Events and reverse commands are for windows; a proxy asks for none.
    }
  }

  hello(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // A socket that never answers (a daemon that is starting, or not ours) is the same as no daemon.
      const timer = setTimeout(() => reject(new Refusal('not_running')), 10_000)
      this.helloDone = {
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      }
      if (this.lost) return this.helloDone.reject(this.lost)
      this.socket.write(
        encodeFrame({
          kind: 'hello',
          protocolVersion: MMS_PROTOCOL_VERSION,
          ownerToken: token,
          clientType: 'cli',
          // `profiles.bind` needs profiles-v1 as well as net.v1: the daemon leaves a capability out unless it is asked for.
          requestedCapabilities: [NET_LOCAL_CAPABILITY, PROFILES_V1_CAPABILITY]
        })
      )
    })
  }

  request<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.lost) return reject(this.lost)
      const id = `p${++this.next}`
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Refusal('timeout'))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      this.socket.write(encodeFrame({ kind: 'req', id, method, params }))
    })
  }

  close(): void {
    this.socket.destroy()
  }
}

const REQUEST_MS = 30_000
const OPEN_MS = 30_000
const READ_MS = EDITOR_TUNNEL_LOCAL_READ_WAIT_MS + 30_000

function flushed(stream: SshProxyIo['stdout'], bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      stream.write(bytes, (error) => (error ? reject(error) : resolve()))
    } catch (error) {
      reject(error instanceof Error ? error : new Error('stdout closed'))
    }
  })
}

/** Runs the proxy against the daemon of this computer. Resolves with the exit code. */
export async function runSshProxy(
  argv: readonly string[],
  io: SshProxyIo = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    platform: process.platform,
    home: () => process.env.MOUSSE_HOME ?? join(homedir(), '.mousse')
  }
): Promise<number> {
  const say = (reason: ProxyRefusal | ProxyLocalProblem, computer?: string): Promise<void> =>
    new Promise((resolve) => {
      try {
        io.stderr.write(`${proxyMessage(reason, computer)}\n`, () => resolve())
      } catch {
        resolve()
      }
    })
  const parsed = parseSshProxyArgv(argv)
  if (!parsed) {
    await say('usage')
    return SSH_PROXY_EXIT.usage
  }
  const home = parsed.home ?? io.home()
  const daemon = readDaemon(home, io.platform)
  if (!daemon) {
    await say('not_running')
    return SSH_PROXY_EXIT.refused
  }
  let line: LocalLine | undefined
  let computer: string | undefined
  let handle: string | undefined
  try {
    const socket = await new Promise<Socket>((resolveSocket, rejectSocket) => {
      const opened = (io.connect ?? connect)(daemon.endpoint)
      opened.once('connect', () => resolveSocket(opened))
      opened.once('error', () => rejectSocket(new Refusal('not_running')))
    })
    line = new LocalLine(socket)
    await line.hello(daemon.token)
    await line.request('profiles.bind', { profile: parsed.profile }, REQUEST_MS)
    const opened = await line.request<EditorTunnelOpenAnswer>(
      'net.editor.tunnel.open',
      { node: parsed.node },
      OPEN_MS
    )
    computer = opened.ok ? opened.computer || undefined : opened.computer
    if (!opened.ok) throw new Refusal(opened.reason, computer)
    handle = opened.handle
    return await pump(line, handle, io, computer, say)
  } catch (error) {
    if (error instanceof Refusal) await say(error.reason, error.computer ?? computer)
    else if (line) await say('daemon_lost')
    else await say('not_running')
    return SSH_PROXY_EXIT.refused
  } finally {
    if (line && handle) {
      // Best effort: the daemon also ends the tunnel when this connection closes.
      await Promise.race([
        line.request('net.editor.tunnel.close', { tunnel: handle }, 2_000).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 500).unref?.())
      ])
    }
    line?.close()
  }
}

/** How long the proxy keeps reading after `ssh` closed its end, for the other computer's SSH server to finish. */
const HALF_CLOSE_WAIT_MS = 5_000

/**
 * Moves bytes both ways until one side ends. Returns the exit code.
 *
 * When `ssh` closes its end (stdin ends), the tunnel's write side is ended after everything written before it,
 * and reading goes on until the other computer's SSH server ends the tunnel, so the last bytes of either side
 * are not lost. A server that does not answer is waited for a few seconds only.
 */
async function pump(
  line: LocalLine,
  handle: string,
  io: SshProxyIo,
  computer: string | undefined,
  say: (reason: ProxyRefusal | ProxyLocalProblem, computer?: string) => Promise<void>
): Promise<number> {
  let ended: TunnelFailure | 'stdin' | 'daemon' | undefined
  let finished!: () => void
  const done = new Promise<void>((resolve) => (finished = resolve))
  let halfClosed = false
  let halfCloseTimer: ReturnType<typeof setTimeout> | undefined
  const finish = (why: TunnelFailure | 'stdin' | 'daemon'): void => {
    ended ??= why
    if (halfCloseTimer) clearTimeout(halfCloseTimer)
    io.stdin.pause()
    finished()
  }
  // stdin -> tunnel. One write call at a time; stdin is paused while the daemon takes the bytes.
  let chain: Promise<void> = Promise.resolve()
  io.stdin.on('data', (chunk: Buffer | string) => {
    if (ended || halfClosed) return
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk
    io.stdin.pause()
    chain = chain.then(async () => {
      try {
        for (let at = 0; at < bytes.length && !ended; at += EDITOR_TUNNEL_LOCAL_CHUNK_BYTES) {
          const answer = await line.request<EditorTunnelWriteAnswer>(
            'net.editor.tunnel.write',
            {
              tunnel: handle,
              data: Buffer.from(bytes.subarray(at, at + EDITOR_TUNNEL_LOCAL_CHUNK_BYTES)).toString(
                'base64'
              )
            },
            REQUEST_MS
          )
          if ('end' in answer) return finish(answer.end)
        }
        if (!ended) io.stdin.resume()
      } catch {
        finish('daemon')
      }
    })
  })
  io.stdin.once('end', () => {
    // `ssh` is done writing. What it wrote is with the daemon (the chain is waited for), then the write side ends.
    chain = chain.then(async () => {
      if (ended) return
      halfClosed = true
      halfCloseTimer = setTimeout(() => finish('stdin'), io.halfCloseWaitMs ?? HALF_CLOSE_WAIT_MS)
      halfCloseTimer.unref?.()
      try {
        const answer = await line.request<{ ok: true } | { end: TunnelFailure }>(
          'net.editor.tunnel.end',
          { tunnel: handle },
          REQUEST_MS
        )
        if ('end' in answer) finish(answer.end)
      } catch {
        finish('daemon')
      }
    })
  })
  // A stdin that is destroyed without an end: nobody is there to read anything either.
  io.stdin.once('error', () => finish('stdin'))
  io.stdin.once('close', () => {
    chain = chain.then(() => {
      if (!halfClosed) finish('stdin')
    })
  })
  io.stdin.resume()
  // tunnel -> stdout. One read call at a time; the next is asked for once stdout has taken the bytes.
  void (async (): Promise<void> => {
    while (!ended) {
      let answer: EditorTunnelReadAnswer
      try {
        answer = await line.request<EditorTunnelReadAnswer>(
          'net.editor.tunnel.read',
          { tunnel: handle, waitMs: EDITOR_TUNNEL_LOCAL_READ_WAIT_MS },
          READ_MS
        )
      } catch {
        return finish('daemon')
      }
      if (answer.data) {
        try {
          await flushed(io.stdout, Buffer.from(answer.data, 'base64'))
        } catch {
          // The editor's `ssh` closed its end; there is nobody to read the tunnel.
          return finish('stdin')
        }
      }
      if (answer.end) return finish(answer.end)
    }
  })()
  await done
  io.stdin.pause()
  const why = ended
  if (why === 'stdin' || why === 'closed') return SSH_PROXY_EXIT.ok
  if (why === 'daemon') {
    await say('daemon_lost')
    return SSH_PROXY_EXIT.refused
  }
  await say(why ?? 'failed', computer)
  return SSH_PROXY_EXIT.refused
}
