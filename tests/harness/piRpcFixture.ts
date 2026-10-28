import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { getPiExtensionBuildOptions } from '../../scripts/build-pi-runtime.mjs'
import { instanceEnv, type InstanceEnv } from '../../src/mms/harness/env'
import { piLaunch, startPiProcess, type PiProcess, type PiRuntimePaths } from '../../src/mms/harness/pi/launch'
import type { PiRpcEvent } from '../../src/mms/harness/pi/rpcClient'
import { killTree } from '../../src/mms/harness/spawn'

// Real Pi children against local recorders only: no request ever leaves 127.0.0.1, every key is a
// fake one, and the user's own home and environment never reach the child.

export const repoRoot = resolve(__dirname, '..', '..')
export const piPackage = join(repoRoot, 'node_modules/@earendil-works/pi-coding-agent')

/** What a process needs to start, and on Windows where Git Bash is installed. */
const SYSTEM_VARIABLES = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'windir', 'ComSpec', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'TEMP', 'TMP', 'TMPDIR']

export interface Scratch {
  dir: string
  cleanup(): void
}

export function scratchDir(prefix = 'mousse-pi-rpc-'): Scratch {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) }
}

const builds = new Map<string, Promise<string>>()

/** Mousse's extension built from source with its test seams on, once per directory. */
export function testExtension(dir: string): Promise<string> {
  const outfile = join(dir, 'mousse-extension.mjs')
  let pending = builds.get(outfile)
  if (!pending) {
    pending = build({ ...getPiExtensionBuildOptions(repoRoot, { test: true }), outfile, logLevel: 'silent' }).then(() => outfile)
    builds.set(outfile, pending)
  }
  return pending
}

/** A clean base environment with an empty user home, so nothing of the developer's reaches the child. */
export function cleanBase(userHome: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(SYSTEM_VARIABLES.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])),
    HOME: userHome,
    USERPROFILE: userHome,
    ...extra
  }
}

export interface RecordedRequest {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: string
}

export interface Recorder {
  url: string
  port: number
  /** Every TCP connection, TLS attempts included: zero means nothing was sent here. */
  connections(): number
  requests: RecordedRequest[]
  /** How the next requests are answered (default: 400 with a JSON error). */
  respond(handler: (request: RecordedRequest, res: ServerResponse) => void): void
  close(): Promise<void>
}

export function defaultReply(_request: RecordedRequest, res: ServerResponse): void {
  const body = JSON.stringify({ error: { type: 'invalid_request_error', message: 'recorded by the Mousse test recorder' } })
  res.writeHead(400, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/** A local HTTP recorder that also counts raw connections (an HTTPS attempt is a connection, never a request). */
export async function startRecorder(): Promise<Recorder> {
  let connections = 0
  const sockets = new Set<Socket>()
  const requests: RecordedRequest[] = []
  let handler = defaultReply
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const request: RecordedRequest = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }
      requests.push(request)
      handler(request, res)
    })
  })
  server.on('connection', (socket) => {
    connections += 1
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    connections: () => connections,
    requests,
    respond: (next) => {
      handler = next
    },
    close: () => new Promise<void>((done) => {
      for (const socket of sockets) socket.destroy()
      server.close(() => done())
    })
  }
}

export interface PiChild {
  process: PiProcess
  env: InstanceEnv
  stateDir: string
  home: string
  events: PiRpcEvent[]
  /** Resolves with the first event matching `match` from now on (or already seen since `from`). */
  next(match: (event: PiRpcEvent) => boolean, from?: number): Promise<PiRpcEvent>
  kill(): void
}

export interface LaunchOptions {
  dir: string
  provider: string
  model: string
  extension: string
  bridge?: { url: string; token: string }
  /** Files written into Pi's agent dir before start (`settings.json`, `auth.json`). */
  homeFiles?: Record<string, unknown>
  /** Variables added to the clean base environment. */
  env?: NodeJS.ProcessEnv
  /** Instance id of the launch; defaults to `pi:<provider>`. */
  instanceId?: string
  sessionId?: string
  /** Mousse's own variables for the extension (`MOUSSE_PI_*`, which the launcher keeps). */
  engineEnv?: Record<`MOUSSE_PI_${string}`, string>
  /** Test-only change to the launched environment (a negative control without the AWS pins). */
  adjustEnv?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv
}

/** Starts the pinned Pi through the launcher with Mousse's extension and a private agent dir. */
export function launchPi(options: LaunchOptions): PiChild {
  const stateDir = join(options.dir, 'state')
  const home = join(stateDir, 'home')
  const userHome = join(options.dir, 'user')
  mkdirSync(home, { recursive: true })
  mkdirSync(userHome, { recursive: true })
  for (const [name, value] of Object.entries(options.homeFiles ?? {}))
    writeFileSync(join(home, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  const base = cleanBase(userHome, options.env)
  const env = instanceEnv({ instanceId: options.instanceId ?? `pi:${options.provider}`, driver: 'pi', configRevision: 0, home, searchPath: [], base })
  const runtime: PiRuntimePaths = { root: piPackage, entry: join(piPackage, 'dist/bundle/rpc-entry.js'), extension: options.extension }
  const launched = piLaunch({
    env, runtime, stateDir, provider: options.provider, model: options.model, thinking: 'off', ambient: base,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    engineEnv: { ...(options.engineEnv ?? {}), ...(options.bridge ? { MOUSSE_PI_BRIDGE: JSON.stringify(options.bridge) } : {}) }
  })
  if (launched.runs !== 'yes') throw new Error(launched.reason)
  if (options.adjustEnv) launched.env = options.adjustEnv(launched.env)
  const events: PiRpcEvent[] = []
  const waiters: Array<{ match: (event: PiRpcEvent) => boolean; resolve: (event: PiRpcEvent) => void }> = []
  const started = startPiProcess(env, launched, {
    cwd: options.dir,
    handlers: {
      event: (event) => {
        events.push(event)
        for (const waiter of [...waiters]) {
          if (!waiter.match(event)) continue
          waiters.splice(waiters.indexOf(waiter), 1)
          waiter.resolve(event)
        }
      }
    }
  })
  return {
    process: started,
    env,
    stateDir,
    home,
    events,
    next: (match, from) => {
      const seen = from === undefined ? undefined : events.slice(from).find(match)
      if (seen) return Promise.resolve(seen)
      return new Promise((resolve) => waiters.push({ match, resolve }))
    },
    kill: () => killTree(started.child)
  }
}

/** The private `settings.json` of a test child: Mousse's values, retries off unless given. */
export function testSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { defaultProjectTrust: 'never', retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: 'off', ...overrides }
}
