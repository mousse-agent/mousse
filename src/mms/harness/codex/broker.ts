import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Writable } from 'node:stream'
import { encodeTokenResponse, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, parseTokenRequest, type TokenResponse } from './tokenProtocol'

/**
 * The ChatGPT token broker: one per daemon process. A managed Codex's `auth.command` runs the
 * token helper, which connects here with the lease id its app-server was launched with and gets
 * the lease's access token back (`tokenProtocol.ts`).
 *
 * - The endpoint is private to the user: a named pipe with a random name on Windows; elsewhere a
 *   socket (0600) in a fresh 0700 folder under a temp folder the user (or root, sticky) owns.
 * - A lease names the instance and the profile key its app-server started with, and resolves the
 *   token through the instance's sign-in (`access`), which refuses a changed key. Revoking an
 *   instance drops its leases; a request on a dropped lease is refused, also one in flight.
 * - Deadlines: reading an incomplete request, and every blocked response write, get `idleMs`
 *   (5 s). An admitted request gets `resolveMs` (75 s) for the lock wait, a refresh and the answer,
 *   inside the helper's 78 s and Codex's 80 s.
 * - At most 32 connections and 16 admitted jobs. Nothing is written before a complete request
 *   (Windows pipes admit read-only peers by default).
 *
 * The broker never logs or echoes a token.
 */

export const BROKER_IDLE_MS = 5_000
export const BROKER_RESOLVE_MS = 75_000
export const BROKER_MAX_CONNECTIONS = 32
export const BROKER_MAX_JOBS = 16
/** POSIX socket paths are limited (104 bytes on macOS); stay below with room. */
const MAX_SOCKET_PATH_BYTES = 100

export interface ChatGptTokenBrokerOptions {
  idleMs?: number
  resolveMs?: number
  maxConnections?: number
  maxJobs?: number
  maxResponseBytes?: number
  platform?: NodeJS.Platform
  /** Temp folders to try, in order (POSIX); default `os.tmpdir()`, then `/tmp`. */
  tempRoots?: string[]
}

export interface ChatGptLeaseInput {
  profileId: string
  instanceId: string
  profileKey: string
  credentialEpoch?: number
  /** The lease's access token; it refuses when the instance's profile key is no longer `profileKey`. */
  access(signal: AbortSignal): Promise<string>
}

export interface ChatGptLease {
  leaseId: string
  /** Ends the lease (its app-server exited). */
  release(): void
}

interface Lease extends ChatGptLeaseInput {
  leaseId: string
}

const REFUSED = {
  unknownLease: 'This Codex process is no longer allowed to use the ChatGPT sign-in. Mousse restarts it with the current sign-in.',
  busy: 'Mousse is busy answering other token requests. Try again.',
  invalid: 'Mousse could not read the token request.',
  timeout: 'Mousse could not get a ChatGPT token in time.',
  failed: 'Mousse could not get a ChatGPT token. Sign in again in Settings → Providers.',
  tooLarge: 'The ChatGPT token is larger than Mousse can send.'
} as const

/** Ends the write within `ms` of a blocked write, else destroys the stream. */
export function writeWithDeadline(stream: Writable, data: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const settle = (ok: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (!ok) stream.destroy()
      resolve(ok)
    }
    const timer = setTimeout(() => settle(false), ms)
    stream.once('error', () => settle(false))
    stream.once('close', () => settle(false))
    stream.end(data, () => settle(true))
  })
}

/** A temp folder the socket's folder may go in: owned by the user (or root with the sticky bit), not writable by others, not a link. */
function safeParent(path: string): boolean {
  try {
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false
    const uid = process.getuid?.()
    if (uid === undefined) return false
    if (stat.uid === uid) return (stat.mode & 0o022) === 0
    return stat.uid === 0 && (stat.mode & 0o1000) !== 0
  } catch {
    return false
  }
}

export class ChatGptTokenBroker {
  private server?: Server
  private starting?: Promise<string>
  private folder?: { path: string; dev: number; ino: number }
  private readonly leases = new Map<string, Lease>()
  private readonly sockets = new Set<Socket>()
  private jobs = 0
  private closed = false
  endpoint: string | undefined

  constructor(private readonly options: ChatGptTokenBrokerOptions = {}) {}

  private get idleMs(): number {
    return this.options.idleMs ?? BROKER_IDLE_MS
  }

  /** Listens (once) and resolves with the endpoint the helper connects to. */
  start(): Promise<string> {
    if (this.closed) return Promise.reject(new Error('The ChatGPT token broker is closed.'))
    this.starting ??= this.listen().catch((error) => {
      this.starting = undefined
      throw error
    })
    return this.starting
  }

  private endpointPath(): string {
    if ((this.options.platform ?? process.platform) === 'win32') return `\\\\.\\pipe\\mousse-chatgpt-${randomUUID()}`
    const roots = this.options.tempRoots ?? [tmpdir(), '/tmp']
    for (const root of roots) {
      if (!safeParent(root)) continue
      const dir = mkdtempSync(join(root, 'mousse-chatgpt-'))
      const path = join(dir, 'broker.sock')
      if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) {
        rmSync(dir, { recursive: true, force: true })
        continue
      }
      chmodSync(dir, 0o700)
      const stat = lstatSync(dir)
      this.folder = { path: dir, dev: stat.dev, ino: stat.ino }
      return path
    }
    throw new Error('Mousse found no private temporary folder for the ChatGPT token broker.')
  }

  private async listen(): Promise<string> {
    const path = this.endpointPath()
    const server = createServer((socket) => this.accept(socket))
    server.maxConnections = this.options.maxConnections ?? BROKER_MAX_CONNECTIONS
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.off('error', reject)
        resolve()
      })
    })
    if (this.folder) chmodSync(path, 0o600)
    server.on('error', (error) => console.warn('[chatgpt-broker] server error', { error: error.message }))
    this.server = server
    this.endpoint = path
    if (this.closed) {
      await this.close()
      throw new Error('The ChatGPT token broker is closed.')
    }
    return path
  }

  register(input: ChatGptLeaseInput): ChatGptLease {
    const leaseId = randomBytes(16).toString('hex')
    this.leases.set(leaseId, { ...input, leaseId })
    return { leaseId, release: () => void this.leases.delete(leaseId) }
  }

  /** Drops every lease of the instance; their requests are refused from now on. */
  revokeInstance(instanceId: string): void {
    for (const [leaseId, lease] of this.leases) if (lease.instanceId === instanceId) this.leases.delete(leaseId)
  }

  /** Live leases (tests). */
  leaseCount(instanceId?: string): number {
    return [...this.leases.values()].filter((lease) => instanceId === undefined || lease.instanceId === instanceId).length
  }

  private accept(socket: Socket): void {
    if (this.closed || this.sockets.size >= (this.options.maxConnections ?? BROKER_MAX_CONNECTIONS)) {
      socket.destroy()
      return
    }
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    let buffer = Buffer.alloc(0)
    // Reading the request has one deadline from the connection on, however slowly bytes arrive.
    const readTimer = setTimeout(() => socket.destroy(), this.idleMs)
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf(0x0a)
      if (end < 0 ? buffer.length >= MAX_REQUEST_BYTES : end + 1 > MAX_REQUEST_BYTES || buffer.length > end + 1) {
        clearTimeout(readTimer)
        socket.destroy()
        return
      }
      if (end < 0) return
      clearTimeout(readTimer)
      socket.off('data', onData)
      socket.pause()
      void this.answer(socket, buffer.subarray(0, end).toString('utf8'))
    }
    socket.on('data', onData)
    socket.once('end', () => {
      clearTimeout(readTimer)
      if (!socket.destroyed && buffer.indexOf(0x0a) < 0) socket.destroy()
    })
  }

  private async answer(socket: Socket, line: string): Promise<void> {
    const request = parseTokenRequest(line)
    if (!request) return this.respond(socket, { error: REFUSED.invalid })
    const lease = this.leases.get(request.leaseId)
    if (!lease) return this.respond(socket, { error: REFUSED.unknownLease })
    if (this.jobs >= (this.options.maxJobs ?? BROKER_MAX_JOBS)) return this.respond(socket, { error: REFUSED.busy })
    this.jobs += 1
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(REFUSED.timeout)), this.options.resolveMs ?? BROKER_RESOLVE_MS)
    const onClose = (): void => controller.abort(new Error('The token helper went away.'))
    socket.once('close', onClose)
    let response: TokenResponse
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
      })
      deadline.catch(() => undefined)
      const token = await Promise.race([lease.access(controller.signal), deadline])
      // A lease dropped while its token was being resolved gets nothing.
      if (this.leases.get(request.leaseId) !== lease) response = { error: REFUSED.unknownLease }
      else response = { token }
    } catch (error) {
      response = { error: controller.signal.aborted && controller.signal.reason instanceof Error && controller.signal.reason.message === REFUSED.timeout ? REFUSED.timeout : failureText(error) }
    } finally {
      clearTimeout(timer)
      socket.off('close', onClose)
      this.jobs -= 1
    }
    await this.respond(socket, response)
  }

  private async respond(socket: Socket, response: TokenResponse): Promise<void> {
    if (socket.destroyed) return
    let line = encodeTokenResponse(response)
    if (Buffer.byteLength(line) > (this.options.maxResponseBytes ?? MAX_RESPONSE_BYTES)) line = encodeTokenResponse({ error: REFUSED.tooLarge })
    await writeWithDeadline(socket, line, this.idleMs)
  }

  async close(): Promise<void> {
    this.closed = true
    this.leases.clear()
    for (const socket of this.sockets) socket.destroy()
    const server = this.server
    this.server = undefined
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    this.removeFolder()
  }

  /** Removes the socket folder this broker made (POSIX); synchronous, so it also runs at process exit. */
  removeFolder(): void {
    const folder = this.folder
    this.folder = undefined
    if (!folder) return
    try {
      const stat = lstatSync(folder.path)
      // Only the folder this broker made: never one that replaced it meanwhile.
      if (stat.isDirectory() && stat.dev === folder.dev && stat.ino === folder.ino) rmSync(folder.path, { recursive: true, force: true })
    } catch {
      // Already gone.
    }
  }
}

/** A failure's message when it is one of the sign-in's own (typed, token-free); otherwise generic. */
function failureText(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  const typed = error && typeof error === 'object' && 'failure' in error
  return typed && message ? message : REFUSED.failed
}

let shared: ChatGptTokenBroker | undefined

/** The process's broker (started on first use by the managed runtime). */
export function chatgptTokenBroker(): ChatGptTokenBroker {
  if (!shared) {
    const broker = new ChatGptTokenBroker()
    shared = broker
    // The listening socket ends with the process; its private folder must not outlive it.
    process.once('exit', () => broker.removeFolder())
  }
  return shared
}
