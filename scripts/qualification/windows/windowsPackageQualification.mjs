/**
 * Bounded Windows packaged-CLI qualification.
 * Talks to the read-only win-unpacked candidate. Never installs OS startup,
 * never downloads a managed browser, never calls paid models.
 */
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createConnection } from 'node:net'
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import {
  plantLegacyHome,
  LEGACY_THREAD_ID,
  LEGACY_AUTH_KEY,
  LEGACY_MOUSSE_CONF
} from '../../../tests/fixtures/agent-platform/package-windows/plantLegacy.mjs'

export {
  plantLegacyHome,
  LEGACY_THREAD_ID,
  LEGACY_AUTH_KEY,
  LEGACY_MOUSSE_CONF
}

export const DEFAULT_WINDOWS_PACKAGE =
  'C:\\Users\\bubbl\\Documents\\Projects\\RYSPA\\mousse\\orchestration\\windows-candidate-20260911\\win-unpacked'

export const REVIEWED_ASAR_SHA256 =
  'EFB718E613ABC85767FE961FAD9D1E0ECCF07144280FE1335EFF5D48B18F48AB'
export const REVIEWED_ASAR_BYTES = 209_336_240

export const PROTOCOL_VERSION = 1
export const MAX_FRAME_BYTES = 4 * 1024 * 1024
const REQUESTED_CAPABILITIES = [
  'profiles-v1',
  'workflows.definitions.v1',
  'browser.setup.v1',
  'workflowRuns.v1'
]

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(SCRIPT_DIR, '../../..')
export const PTY_ECHO_SCRIPT = join(
  REPO_ROOT,
  'tests/fixtures/agent-platform/package-windows/pty-echo.mjs'
)

export function nowIso() {
  return new Date().toISOString()
}

export function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : ''
    return code === 'EPERM'
  }
}

export async function sha256File(filePath) {
  const hash = createHash('sha256')
  await new Promise((resolveHash, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolveHash)
  })
  return hash.digest('hex').toUpperCase()
}

export async function waitUntil(label, timeoutMs, intervalMs, fn) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    last = await fn()
    if (last) return last
    await sleep(intervalMs)
  }
  const extra = last && typeof last === 'object' ? ` last=${JSON.stringify(last)}` : ''
  throw new Error(`${label} timed out after ${timeoutMs}ms${extra}`)
}

function gitHeadSync(repoRoot = REPO_ROOT) {
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true
    }).trim()
  } catch (err) {
    return `unresolved: ${err instanceof Error ? err.message : String(err)}`
  }
}

export function encodeFrame(value, maxBytes = MAX_FRAME_BYTES) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  if (body.length > maxBytes) throw new Error(`Frame size ${body.length} exceeds max ${maxBytes}`)
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
}

export class FrameDecoder {
  constructor(maxBytes = MAX_FRAME_BYTES) {
    this.maxBytes = maxBytes
    this.buffer = Buffer.alloc(0)
  }
  push(chunk) {
    if (!chunk.length) return
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk])
    if (this.buffer.length >= 4) {
      const len = this.buffer.readUInt32BE(0)
      if (len > this.maxBytes) {
        this.buffer = Buffer.alloc(0)
        throw new Error(`Frame size ${len} exceeds max ${this.maxBytes}`)
      }
    }
    if (this.buffer.length > this.maxBytes + 4) {
      this.buffer = Buffer.alloc(0)
      throw new Error('Decode buffer exceeded maximum without a complete frame')
    }
  }
  shift() {
    if (this.buffer.length < 4) return null
    const len = this.buffer.readUInt32BE(0)
    if (this.buffer.length < 4 + len) return null
    const body = this.buffer.subarray(4, 4 + len)
    this.buffer = this.buffer.subarray(4 + len)
    return JSON.parse(body.toString('utf8'))
  }
  shiftAll() {
    const out = []
    for (;;) {
      const next = this.shift()
      if (next === null) break
      out.push(next)
    }
    return out
  }
}

export function parseJsonLines(text) {
  const objects = []
  const raw = String(text || '')
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      objects.push(JSON.parse(trimmed))
    } catch {
      /* keep scanning */
    }
  }
  return objects
}

export function lastJson(text) {
  const objects = parseJsonLines(text)
  return objects.length ? objects[objects.length - 1] : null
}

export function readJsonFile(filePath) {
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return { unreadable: true, path: filePath }
  }
}

export function listRelativeFiles(root, limit = 400) {
  if (!existsSync(root)) return []
  const out = []
  const stack = ['']
  while (stack.length && out.length < limit) {
    const rel = stack.pop()
    const full = rel ? join(root, rel) : root
    let entries
    try {
      entries = readdirSync(full, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = rel ? join(rel, entry.name) : entry.name
      if (entry.isDirectory()) stack.push(child)
      else out.push(child.replaceAll('\\', '/'))
      if (out.length >= limit) break
    }
  }
  return out.sort()
}

function snapshotTreeMetadata(root, limit = 1_000) {
  if (!existsSync(root)) return { exists: false, entries: 0, truncated: false, digest: null }
  const rows = []
  const stack = ['']
  while (stack.length && rows.length < limit) {
    const rel = stack.pop()
    const full = rel ? join(root, rel) : root
    let entries
    try {
      entries = readdirSync(full, { withFileTypes: true })
    } catch (err) {
      rows.push([rel, 'unreadable', err instanceof Error ? err.code || err.name : String(err)])
      continue
    }
    for (const entry of entries) {
      const child = rel ? join(rel, entry.name) : entry.name
      const normalized = child.replaceAll('\\', '/')
      if (entry.isDirectory()) {
        rows.push([normalized, 'directory'])
        stack.push(child)
      } else {
        try {
          const stat = lstatSync(join(root, child))
          rows.push([normalized, entry.isSymbolicLink() ? 'link' : 'file', stat.size, stat.mtimeMs])
        } catch (err) {
          rows.push([normalized, 'unreadable', err instanceof Error ? err.code || err.name : String(err)])
        }
      }
      if (rows.length >= limit) break
    }
  }
  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  return {
    exists: true,
    entries: rows.length,
    truncated: stack.length > 0,
    digest: createHash('sha256').update(JSON.stringify(rows)).digest('hex')
  }
}

function snapshotDefaultMousseState() {
  const home = homedir()
  const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming')
  return [
    join(home, '.mousse'),
    join(appData, 'mousse'),
    join(appData, 'Mousse')
  ].map((path) => ({ path, ...snapshotTreeMetadata(path) }))
}

export async function inspectPackage(packageDir) {
  const root = resolve(packageDir)
  const asar = join(root, 'resources', 'app.asar')
  const versionPath = join(root, 'version')
  const cliExe = join(root, 'mousse-cli.exe')
  const guiExe = join(root, 'Mousse.exe')
  const unpackedPty = join(root, 'resources', 'app.asar.unpacked', 'node_modules', 'node-pty')
  const identity = {
    packageDir: root,
    cliExe,
    guiExe,
    asar,
    versionFile: existsSync(versionPath) ? readFileSync(versionPath, 'utf8').trim() : null,
    cliExeExists: existsSync(cliExe),
    guiExeExists: existsSync(guiExe),
    asarExists: existsSync(asar),
    asarBytes: existsSync(asar) ? statSync(asar).size : null,
    asarSha256: existsSync(asar) ? await sha256File(asar) : null,
    nodePtyUnpacked: existsSync(unpackedPty),
    reviewedAsarSha256: REVIEWED_ASAR_SHA256,
    asarMatchesReview: false
  }
  identity.asarMatchesReview =
    identity.asarSha256 === REVIEWED_ASAR_SHA256 && identity.asarBytes === REVIEWED_ASAR_BYTES
  return identity
}

export function buildCliEnv(options) {
  if (!options.appDataDir || !options.localAppDataDir) {
    throw new Error('Task-owned APPDATA and LOCALAPPDATA directories are required')
  }
  const env = { ...process.env }
  env.MOUSSE_HOME = options.homeDir
  env.MOUSSE_CLI = '1'
  env.MOUSSE_ELECTRON_USER_DATA = options.userDataDir
  env.ELECTRON_NO_ATTACH_CONSOLE = '1'
  // Packaged CLI mode does not call app.setPath. Isolate Electron's default
  // %APPDATA%/<product> by pointing APPDATA at the task-owned tree instead of
  // passing --user-data-dir (workflow/browser reject unknown flags).
  env.APPDATA = options.appDataDir
  env.LOCALAPPDATA = options.localAppDataDir
  delete env.ELECTRON_RUN_AS_NODE
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'XAI_API_KEY', 'OPENROUTER_API_KEY', 'CURSOR_API_KEY']) {
    delete env[key]
  }
  return env
}

export function spawnPackagedCli(options) {
  const {
    packageDir,
    homeDir,
    userDataDir,
    args,
    timeoutMs = 30_000,
    stdioLogs
  } = options
  const cliExe = join(packageDir, 'mousse-cli.exe')
  const argv = ['--cli', '--home', homeDir, ...args]
  const env = buildCliEnv({
    homeDir,
    userDataDir,
    appDataDir: options.appDataDir,
    localAppDataDir: options.localAppDataDir
  })
  const startedAt = Date.now()
  return new Promise((resolveSpawn) => {
    const child = spawn(cliExe, argv, {
      cwd: packageDir,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdoutChunks = []
    const stderrChunks = []
    child.stdout?.on('data', (chunk) => stdoutChunks.push(chunk))
    child.stderr?.on('data', (chunk) => stderrChunks.push(chunk))
    let settled = false
    const finish = (exitCode, signal, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const stderr = Buffer.concat(stderrChunks).toString('utf8')
      if (stdioLogs) {
        writeFileSync(stdioLogs.stdout, stdout)
        writeFileSync(stdioLogs.stderr, stderr)
      }
      resolveSpawn({
        command: cliExe,
        argv,
        exitCode,
        signal,
        error: error ? String(error.message || error) : null,
        stdout,
        stderr,
        json: lastJson(stdout),
        durationMs: Date.now() - startedAt,
        pid: child.pid ?? null
      })
    }
    const timer = setTimeout(() => {
      try {
        if (child.pid) child.kill()
      } catch {
        /* ignore */
      }
      finish(null, 'timeout', new Error(`CLI timed out after ${timeoutMs}ms: ${args.join(' ')}`))
    }, timeoutMs)
    child.on('error', (error) => finish(null, null, error))
    child.on('exit', (code, signal) => finish(code, signal, null))
  })
}

class FallbackMmsClient {
  constructor(opts) {
    this.opts = opts
    this.socket = null
    this.decoder = new FrameDecoder()
    this.pending = new Map()
    this.hello = null
    this.connected = false
    this.closing = false
  }

  connect() {
    return new Promise((resolveConnect, reject) => {
      const socket = createConnection(this.opts.endpoint)
      this.socket = socket
      let settled = false
      const fail = (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          socket.removeAllListeners()
          socket.destroy()
        } catch {
          /* ignore */
        }
        this.socket = null
        reject(err)
      }
      const timer = setTimeout(() => fail(new Error('Hello timeout')), this.opts.helloTimeoutMs ?? 10_000)
      socket.on('connect', () => {
        try {
          socket.write(
            encodeFrame({
              kind: 'hello',
              protocolVersion: PROTOCOL_VERSION,
              ownerToken: this.opts.ownerToken,
              clientType: this.opts.clientType ?? 'cli',
              requestedCapabilities: this.opts.requestedCapabilities ?? REQUESTED_CAPABILITIES
            })
          )
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)))
        }
      })
      const onData = (chunk) => {
        try {
          this.decoder.push(chunk)
          for (const frame of this.decoder.shiftAll()) {
            if (!settled) {
              if (frame && frame.kind === 'hello_ok') {
                settled = true
                clearTimeout(timer)
                this.hello = frame
                this.connected = true
                resolveConnect(frame)
                continue
              }
              if (frame && frame.kind === 'hello_err') {
                fail(new Error(`Hello rejected: ${frame.code || ''} ${frame.message || ''}`.trim()))
                return
              }
            } else {
              this.handleFrame(frame)
            }
          }
        } catch (err) {
          if (settled) this.rejectAll(err instanceof Error ? err : new Error(String(err)))
          else fail(err instanceof Error ? err : new Error(String(err)))
        }
      }
      socket.on('data', onData)
      socket.on('error', (err) => (settled ? this.rejectAll(err) : fail(err)))
      socket.on('close', () => {
        if (!settled) fail(new Error('Connection closed before hello'))
        else this.rejectAll(new Error('Connection closed'))
      })
    })
  }

  handleFrame(frame) {
    if (!frame || typeof frame !== 'object') return
    if (frame.kind === 'res' && typeof frame.id === 'string') {
      const pending = this.pending.get(frame.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(frame.id)
      if (frame.ok) pending.resolve(frame.result)
      else {
        const error = frame.error || {}
        pending.reject(new Error(`${error.code || 'request_failed'}: ${error.message || 'Request failed'}`))
      }
    }
  }

  request(method, params, timeoutMs) {
    if (!this.connected || !this.socket) return Promise.reject(new Error('Not connected'))
    const id = randomBytes(8).toString('hex')
    const waitMs = timeoutMs ?? this.opts.requestTimeoutMs ?? 15_000
    const result = new Promise((resolveReq, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Request timeout: ${method}`))
      }, waitMs)
      this.pending.set(id, { resolve: resolveReq, reject, timer, method })
    })
    this.socket.write(encodeFrame({ kind: 'req', id, method, params }))
    return result
  }

  async close() {
    this.closing = true
    this.rejectAll(new Error('Client closed'))
    if (this.socket) {
      try {
        this.socket.destroy()
      } catch {
        /* ignore */
      }
    }
    this.socket = null
    this.connected = false
  }

  rejectAll(err) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.pending.clear()
    this.connected = false
  }
}

export async function bundleSourceClient(outfile) {
  mkdirSync(dirname(outfile), { recursive: true })
  let esbuild
  try {
    esbuild = await import('esbuild')
  } catch (err) {
    return { ok: false, error: `esbuild unavailable: ${err instanceof Error ? err.message : String(err)}` }
  }
  const entry = join(SCRIPT_DIR, 'source-client-entry.ts')
  try {
    const result = await esbuild.build({
      absWorkingDir: REPO_ROOT,
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile,
      logLevel: 'silent',
      sourcemap: false,
      packages: 'external'
    })
    if (result.errors?.length) {
      return { ok: false, error: result.errors.map((item) => item.text).join('; ') }
    }
    return { ok: true, outfile, bytes: statSync(outfile).size }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function createFixtureClient(options) {
  const Client = options.SourceClient
  if (Client) {
    const client = new Client({
      homeDir: options.homeDir,
      ownerToken: options.ownerToken,
      endpoint: options.endpoint,
      clientType: 'cli',
      requestedCapabilities: REQUESTED_CAPABILITIES,
      requestTimeoutMs: options.requestTimeoutMs ?? 15_000
    })
    const hello = await client.connect()
    return { client, hello, kind: 'source-LocalMmsClient' }
  }
  const client = new FallbackMmsClient(options)
  const hello = await client.connect()
  return { client, hello, kind: 'fallback-framed-client' }
}

export function readOwner(homeDir) {
  return readJsonFile(join(homeDir, 'mms.owner.json'))
}

export function readRuntime(homeDir) {
  return readJsonFile(join(homeDir, 'mms.runtime.json'))
}

export async function connectOwnedClient(homeDir, sourceClient, timeoutMs = 10_000) {
  const owner = await waitUntil('owner token', timeoutMs, 100, async () => {
    const record = readOwner(homeDir)
    if (record && typeof record.token === 'string' && record.token && record.endpoint) return record
    return null
  })
  return createFixtureClient({
    homeDir,
    ownerToken: owner.token,
    endpoint: owner.endpoint,
    SourceClient: sourceClient
  })
}

function killExactPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { attempted: false }
  if (pid === process.pid) throw new Error('Refusing to signal the qualification runner pid')
  if (!isProcessAlive(pid)) return { attempted: false, alive: false }
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      timeout: 15_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    return {
      attempted: true,
      alive: isProcessAlive(pid),
      error: err instanceof Error ? err.message : String(err)
    }
  }
  return { attempted: true, alive: isProcessAlive(pid) }
}

export async function stopOwnedDaemon(ctx, options = {}) {
  const homeDir = ctx.homeDir
  const runtime = readRuntime(homeDir)
  const owner = readOwner(homeDir)
  const pid = runtime?.pid ?? owner?.pid ?? null
  const result = await spawnPackagedCli({
    packageDir: ctx.packageDir,
    homeDir,
    userDataDir: ctx.userDataDir,
    appDataDir: ctx.appDataDir,
    localAppDataDir: ctx.localAppDataDir,
    args: ['--mode', 'json', 'service', 'stop'],
    timeoutMs: options.timeoutMs ?? 45_000,
    stdioLogs: options.logs
  })
  const stopped = result.exitCode === 0 && result.json?.stopped === true && result.json?.running === false
  if (stopped) {
    await sleep(200)
    return { ...result, ownedPid: pid, hardKill: null, stillAlive: pid ? isProcessAlive(pid) : false }
  }
  let hardKill = null
  if (options.allowExactPidKill && pid && isProcessAlive(pid)) {
    hardKill = killExactPid(pid)
    await sleep(300)
  }
  return {
    ...result,
    ownedPid: pid,
    hardKill,
    stillAlive: pid ? isProcessAlive(pid) : false
  }
}

function caseRecord(id, status, details) {
  return { id, status, ...details, at: nowIso() }
}

function countBy(files, predicate) {
  return files.filter(predicate).length
}

async function withClient(ctx, fn) {
  const session = await connectOwnedClient(ctx.homeDir, ctx.SourceClient)
  try {
    const status = await session.client.request('profiles.status', {})
    const profile = ctx.profileId || status.defaultProfileId
    if (profile) {
      await session.client.request('profiles.bind', { profile })
    }
    return await fn(session, status)
  } finally {
    await session.client.close().catch(() => undefined)
  }
}

async function waitForOwnedReady(homeDir, timeoutMs = 20_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const runtime = readRuntime(homeDir)
    const owner = readOwner(homeDir)
    if (runtime?.pid && runtime?.token && owner?.token && owner?.endpoint) {
      return { runtime, owner, waitedMs: Date.now() - started }
    }
    await sleep(150)
  }
  return {
    runtime: readRuntime(homeDir),
    owner: readOwner(homeDir),
    waitedMs: timeoutMs
  }
}

async function waitPtyOutput(client, ptyId, needle, timeoutMs) {
  const started = Date.now()
  let scrollback = ''
  while (Date.now() - started < timeoutMs) {
    const alive = await client.request('pty.isAlive', { ptyId })
    const out = await client.request('pty.scrollback', { ptyId })
    scrollback = typeof out?.scrollback === 'string' ? out.scrollback : ''
    if (scrollback.includes(needle)) return { scrollback, alive: Boolean(alive?.alive) }
    await sleep(150)
  }
  throw new Error(`PTY output did not contain ${JSON.stringify(needle)}. last=${scrollback.slice(-500)}`)
}

export async function runWindowsPackageQualification(input) {
  if (process.platform !== 'win32') {
    throw new Error(`Windows package qualification requires win32, got ${process.platform}`)
  }
  const packageDir = resolve(input.packageDir || DEFAULT_WINDOWS_PACKAGE)
  const workRoot = resolve(input.workRoot)
  if (!isAbsolute(workRoot)) throw new Error('workRoot must be absolute')
  assertNotDefaultUserHome(workRoot)
  const startedAt = nowIso()
  const evidenceDir = join(workRoot, 'evidence')
  const logsDir = join(evidenceDir, 'logs')
  const bundlePath = join(evidenceDir, 'bundled-local-mms-client.mjs')
  mkdirSync(logsDir, { recursive: true })
  const cases = []
  const defaultUserStateBefore = snapshotDefaultMousseState()
  const report = {
    ok: false,
    startedAt,
    finishedAt: null,
    worktreeSha: gitHeadSync(),
    repoRoot: REPO_ROOT,
    workRoot,
    evidenceDir,
    package: null,
    clientKind: null,
    sourceClientBundle: null,
    cases,
    resultCounts: { passed: 0, failed: 0, unsupported: 0 },
    ownedPids: [],
    defaultUserHomeTouched: null,
    defaultUserStateBefore,
    defaultUserStateAfter: null
  }
  /** @type {Array<{ packageDir: string, homeDir: string, userDataDir: string }>} */
  const stopTargets = []

  const push = (record) => {
    cases.push(record)
    if (record.status === 'passed') report.resultCounts.passed += 1
    else if (record.status === 'failed') report.resultCounts.failed += 1
    else report.resultCounts.unsupported += 1
  }

  const writeReport = () => {
    report.finishedAt = nowIso()
    report.ok = report.resultCounts.failed === 0
    writeFileSync(join(evidenceDir, 'report.json'), JSON.stringify(report, null, 2))
    return report
  }

  try {
    const identity = await inspectPackage(packageDir)
    report.package = identity
    if (!identity.cliExeExists || !identity.asarExists) {
      push(caseRecord('package-identity', 'failed', {
        error: 'Packaged CLI or app.asar is missing',
        identity
      }))
      return writeReport()
    }
    push(caseRecord('package-identity', identity.asarMatchesReview ? 'passed' : 'failed', {
      identity,
      note: identity.asarMatchesReview
        ? 'ASAR hash matches final-windows-package.md'
        : 'ASAR hash/size differs from reviewed candidate; still attempting runtime cases'
    }))

    const bundle = await bundleSourceClient(bundlePath)
    report.sourceClientBundle = bundle
    let SourceClient = null
    if (bundle.ok) {
      const mod = await import(pathToFileURL(bundlePath).href)
      SourceClient = mod.LocalMmsClient
    }

    const cleanHome = join(workRoot, 'homes', 'clean')
    const migrateHome = join(workRoot, 'homes', 'migrate')
    const cleanUserData = join(workRoot, 'electron-user-data', 'clean')
    const migrateUserData = join(workRoot, 'electron-user-data', 'migrate')
    const cleanAppData = join(workRoot, 'appdata', 'clean')
    const migrateAppData = join(workRoot, 'appdata', 'migrate')
    const cleanLocalAppData = join(workRoot, 'localappdata', 'clean')
    const migrateLocalAppData = join(workRoot, 'localappdata', 'migrate')
    mkdirSync(cleanHome, { recursive: true })
    mkdirSync(migrateHome, { recursive: true })
    mkdirSync(cleanUserData, { recursive: true })
    mkdirSync(migrateUserData, { recursive: true })
    mkdirSync(cleanAppData, { recursive: true })
    mkdirSync(migrateAppData, { recursive: true })
    mkdirSync(cleanLocalAppData, { recursive: true })
    mkdirSync(migrateLocalAppData, { recursive: true })

    const cleanCtx = {
      packageDir,
      homeDir: cleanHome,
      userDataDir: cleanUserData,
      appDataDir: cleanAppData,
      localAppDataDir: cleanLocalAppData,
      SourceClient
    }
    stopTargets.push(cleanCtx)

    const help = await spawnPackagedCli({
      ...cleanCtx,
      args: ['--help'],
      timeoutMs: 30_000,
      stdioLogs: { stdout: join(logsDir, 'help.stdout.txt'), stderr: join(logsDir, 'help.stderr.txt') }
    })
    push(caseRecord('cli-help', help.exitCode === 0 && /mousse-cli/.test(help.stdout) ? 'passed' : 'failed', {
      exitCode: help.exitCode,
      durationMs: help.durationMs,
      error: help.error,
      stderr: help.stderr.slice(0, 2000)
    }))

    const version = await spawnPackagedCli({
      ...cleanCtx,
      args: ['--version'],
      timeoutMs: 30_000,
      stdioLogs: { stdout: join(logsDir, 'version.stdout.txt'), stderr: join(logsDir, 'version.stderr.txt') }
    })
    push(caseRecord('cli-version', version.exitCode === 0 && /mousse-cli/.test(version.stdout) ? 'passed' : 'failed', {
      exitCode: version.exitCode,
      stdout: version.stdout.trim(),
      durationMs: version.durationMs,
      error: version.error,
      stderr: version.stderr.slice(0, 2000)
    }))

    const statusStopped = await spawnPackagedCli({
      ...cleanCtx,
      args: ['--mode', 'json', 'service', 'status'],
      timeoutMs: 30_000,
      stdioLogs: { stdout: join(logsDir, 'status-stopped.stdout.txt'), stderr: join(logsDir, 'status-stopped.stderr.txt') }
    })
    const stoppedOk =
      statusStopped.exitCode === 0 &&
      statusStopped.json?.running === false &&
      statusStopped.json?.ready === false &&
      statusStopped.json?.home === cleanHome
    push(caseRecord('service-status-stopped', stoppedOk ? 'passed' : 'failed', {
      exitCode: statusStopped.exitCode,
      json: statusStopped.json,
      durationMs: statusStopped.durationMs,
      error: statusStopped.error,
      stderr: statusStopped.stderr.slice(0, 2000)
    }))

    const start = await spawnPackagedCli({
      ...cleanCtx,
      args: ['--mode', 'json', 'service', 'start'],
      timeoutMs: 45_000,
      stdioLogs: { stdout: join(logsDir, 'service-start.stdout.txt'), stderr: join(logsDir, 'service-start.stderr.txt') }
    })
    let startOk = start.exitCode === 0 && start.json?.started === true && Number.isInteger(start.json?.pid)
    let startLate = null
    if (!startOk) {
      startLate = await waitForOwnedReady(cleanHome, 20_000)
      if (startLate.runtime?.pid && startLate.owner?.endpoint) {
        startOk = true
        start.json = start.json || {
          started: true,
          pid: startLate.runtime.pid,
          lateReady: true,
          waitedMs: startLate.waitedMs
        }
      }
    }
    const startPid = start.json?.pid || startLate?.runtime?.pid || startLate?.owner?.pid
    if (startPid) report.ownedPids.push(startPid)
    push(caseRecord('service-start', start.exitCode === 0 && Number.isInteger(start.json?.pid) && !start.json?.lateReady ? 'passed' : 'failed', {
      exitCode: start.exitCode,
      json: start.json,
      lateReady: startLate,
      durationMs: start.durationMs,
      error: start.error,
      stderr: start.stderr.slice(0, 4000)
    }))

    if (!startOk) {
      const diagnose = await spawnPackagedCli({
        ...cleanCtx,
        args: ['--mode', 'json', 'service', 'run'],
        timeoutMs: 20_000,
        stdioLogs: { stdout: join(logsDir, 'service-run-diagnose.stdout.txt'), stderr: join(logsDir, 'service-run-diagnose.stderr.txt') }
      })
      push(caseRecord('service-start-diagnose-run', 'failed', {
        note: 'Foreground service run after failed start, for logs only',
        exitCode: diagnose.exitCode,
        stdout: diagnose.stdout.slice(0, 4000),
        stderr: diagnose.stderr.slice(0, 8000),
        error: diagnose.error
      }))
      await stopOwnedDaemon(cleanCtx, {
        timeoutMs: 20_000,
        allowExactPidKill: true,
        logs: { stdout: join(logsDir, 'cleanup-stop.stdout.txt'), stderr: join(logsDir, 'cleanup-stop.stderr.txt') }
      }).catch(() => undefined)
      return writeReport()
    }

    try {
      const auth = await withClient(cleanCtx, async (session) => {
        report.clientKind = session.kind
        const health = await session.client.request('health', {})
        const capabilities = await session.client.request('capabilities', {})
        return { hello: session.hello, health, capabilities, kind: session.kind }
      })
      const authOk =
        auth.hello?.kind === 'hello_ok' &&
        Array.isArray(auth.hello?.capabilities) &&
        auth.hello.capabilities.includes('profiles-v1') &&
        auth.health &&
        Array.isArray(auth.capabilities?.methods)
      push(caseRecord('authenticated-local-client', authOk ? 'passed' : 'failed', {
        clientKind: auth.kind,
        hello: {
          protocolVersion: auth.hello?.protocolVersion,
          instanceId: auth.hello?.instanceId,
          capabilities: auth.hello?.capabilities
        },
        health: auth.health,
        methodCount: auth.capabilities?.methods?.length ?? 0,
        sourceBundle: bundle
      }))
    } catch (err) {
      report.clientKind = SourceClient ? 'source-LocalMmsClient' : 'fallback-framed-client'
      push(caseRecord('authenticated-local-client', 'failed', {
        clientKind: report.clientKind,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        sourceBundle: bundle
      }))
    }

    try {
      const isolation = await withClient(cleanCtx, async (session) => {
        const listed = await session.client.request('profiles.list', {})
        const created = await session.client.request('profiles.create', {
          displayName: 'Q04 Alice',
          slug: 'q04-alice'
        })
        const defaultId = listed.defaultProfileId
        const aliceId = created.profile?.id
        await session.client.request('profiles.bind', { profile: defaultId })
        await session.client.request('settings.set', {
          partial: { appearance: { theme: 'dark' } }
        })
        await session.client.request('profiles.bind', { profile: aliceId })
        await session.client.request('settings.set', {
          partial: { appearance: { theme: 'light' } }
        })
        const aliceSettings = await session.client.request('settings.get', {})
        await session.client.request('profiles.bind', { profile: defaultId })
        const defaultGet = await session.client.request('settings.get', {})
        const after = await session.client.request('profiles.list', {})
        const files = {
          authAtInstall: existsSync(join(cleanHome, 'auth.json')),
          authInAlice: existsSync(join(cleanHome, 'profiles', aliceId, 'auth.json')),
          aliceConf: existsSync(join(cleanHome, 'profiles', aliceId, 'mousse.conf')),
          defaultConf: existsSync(join(cleanHome, 'profiles', defaultId, 'mousse.conf'))
        }
        return {
          defaultId,
          aliceId,
          profileCount: after.profiles?.length,
          slugs: (after.profiles || []).map((row) => row.slug),
          defaultTheme: defaultGet.settings?.appearance?.theme,
          aliceTheme: aliceSettings.settings?.appearance?.theme,
          files
        }
      })
      const ok =
        isolation.profileCount === 2 &&
        isolation.slugs.includes('q04-alice') &&
        isolation.defaultTheme === 'dark' &&
        isolation.aliceTheme === 'light' &&
        isolation.files.authInAlice === false &&
        isolation.files.aliceConf === true
      push(caseRecord('clean-profile-create-isolation', ok ? 'passed' : 'failed', isolation))
    } catch (err) {
      push(caseRecord('clean-profile-create-isolation', 'failed', {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined
      }))
    }

    const configList = await spawnPackagedCli({
      ...cleanCtx,
      args: ['--mode', 'json', 'config', 'list'],
      timeoutMs: 45_000,
      stdioLogs: { stdout: join(logsDir, 'config-list.stdout.txt'), stderr: join(logsDir, 'config-list.stderr.txt') }
    })
    push(caseRecord('config-list', configList.exitCode === 0 && configList.json && typeof configList.json === 'object' ? 'passed' : 'failed', {
      exitCode: configList.exitCode,
      keys: configList.json && typeof configList.json === 'object' ? Object.keys(configList.json) : [],
      durationMs: configList.durationMs,
      error: configList.error,
      stderr: configList.stderr.slice(0, 4000)
    }))

    const workflowList = await spawnPackagedCli({
      ...cleanCtx,
      args: ['--mode', 'json', 'workflow', 'list'],
      timeoutMs: 45_000,
      stdioLogs: { stdout: join(logsDir, 'workflow-list.stdout.txt'), stderr: join(logsDir, 'workflow-list.stderr.txt') }
    })
    const workflowOk =
      workflowList.exitCode === 0 &&
      workflowList.json &&
      (Array.isArray(workflowList.json) ||
        Array.isArray(workflowList.json.workflows) ||
        workflowList.json.kind === 'definitions')
    push(caseRecord('workflow-list', workflowOk ? 'passed' : 'failed', {
      exitCode: workflowList.exitCode,
      json: workflowList.json,
      durationMs: workflowList.durationMs,
      error: workflowList.error,
      stderr: workflowList.stderr.slice(0, 4000)
    }))

    const browserBefore = listRelativeFiles(join(cleanHome, 'browser-binaries'))
    const browserStatus = await spawnPackagedCli({
      ...cleanCtx,
      args: ['--mode', 'json', 'browser', 'status'],
      timeoutMs: 45_000,
      stdioLogs: { stdout: join(logsDir, 'browser-status.stdout.txt'), stderr: join(logsDir, 'browser-status.stderr.txt') }
    })
    const browserAfter = listRelativeFiles(join(cleanHome, 'browser-binaries'))
    const statusJson = browserStatus.json
    const missingOk =
      browserStatus.exitCode === 0 &&
      statusJson &&
      statusJson.availability &&
      statusJson.availability !== 'ready' &&
      !statusJson.operation &&
      browserAfter.length === browserBefore.length
    push(caseRecord('browser-status-missing-no-autoinstall', missingOk ? 'passed' : 'failed', {
      exitCode: browserStatus.exitCode,
      availability: statusJson?.availability,
      canInstall: statusJson?.canInstall,
      operation: statusJson?.operation ?? null,
      message: statusJson?.message,
      browserBinariesBefore: browserBefore,
      browserBinariesAfter: browserAfter,
      durationMs: browserStatus.durationMs,
      error: browserStatus.error,
      stderr: browserStatus.stderr.slice(0, 4000)
    }))

    try {
      const pty = await withClient(cleanCtx, async (session) => {
        const createdThread = await session.client.request('threads.create', {
          name: 'q04-pty-thread'
        })
        const threadId = createdThread.thread?.id
        if (!threadId) throw new Error('threads.create did not return a thread id')
        const command = `& ${quotePowerShell(process.execPath)} ${quotePowerShell(PTY_ECHO_SCRIPT)}; exit`
        const created = await session.client.request('pty.create', {
          threadId,
          agentId: 'q04-fixture',
          cwd: workRoot,
          command
        })
        const ptyId = created.ptyId
        if (!ptyId) throw new Error('pty.create did not return ptyId')
        await waitPtyOutput(session.client, ptyId, 'Q04-PTY-READY', 20_000)
        await session.client.request('pty.write', { ptyId, data: 'hello-q04\r' })
        const echoed = await waitPtyOutput(session.client, ptyId, 'Q04-PTY-ECHO:hello-q04', 15_000)
        let alive = echoed.alive
        const exitDeadline = Date.now() + 8_000
        while (alive && Date.now() < exitDeadline) {
          const state = await session.client.request('pty.isAlive', { ptyId })
          alive = Boolean(state?.alive)
          if (!alive) break
          await sleep(150)
        }
        if (alive) {
          await session.client.request('pty.kill', { ptyId })
          const killDeadline = Date.now() + 8_000
          while (alive && Date.now() < killDeadline) {
            const state = await session.client.request('pty.isAlive', { ptyId })
            alive = Boolean(state?.alive)
            if (!alive) break
            await sleep(150)
          }
        }
        return {
          threadId,
          ptyId,
          scrollbackTail: echoed.scrollback.slice(-800),
          aliveAfter: alive,
          killed: !alive
        }
      })
      const ptyOk = pty.scrollbackTail.includes('Q04-PTY-ECHO:hello-q04') && pty.killed
      push(caseRecord('native-pty-spawn-write-exit', ptyOk ? 'passed' : 'failed', pty))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const unsupported = /node-pty|conpty|spawn.*fail|not a function|Cannot find module/i.test(message)
      push(caseRecord('native-pty-spawn-write-exit', unsupported ? 'unsupported' : 'failed', {
        error: message,
        stack: err instanceof Error ? err.stack : undefined
      }))
    }

    const firstPid = start.json.pid
    const stop = await stopOwnedDaemon(cleanCtx, {
      timeoutMs: 45_000,
      allowExactPidKill: false,
      logs: { stdout: join(logsDir, 'service-stop.stdout.txt'), stderr: join(logsDir, 'service-stop.stderr.txt') }
    })
    const stopOk = stop.exitCode === 0 && stop.json?.stopped === true && stop.stillAlive === false
    push(caseRecord('service-stop-join', stopOk ? 'passed' : 'failed', {
      exitCode: stop.exitCode,
      json: stop.json,
      ownedPid: stop.ownedPid,
      stillAlive: stop.stillAlive,
      durationMs: stop.durationMs,
      error: stop.error,
      stderr: stop.stderr.slice(0, 4000)
    }))

    const restart = await spawnPackagedCli({
      ...cleanCtx,
      args: ['--mode', 'json', 'service', 'start'],
      timeoutMs: 45_000,
      stdioLogs: { stdout: join(logsDir, 'service-restart.stdout.txt'), stderr: join(logsDir, 'service-restart.stderr.txt') }
    })
    if (restart.json?.pid) report.ownedPids.push(restart.json.pid)
    let restartState = null
    if (restart.exitCode === 0 && restart.json?.started === true) {
      try {
        restartState = await withClient(cleanCtx, async (session) => {
          const listed = await session.client.request('profiles.list', {})
          const threads = await session.client.request('threads.list', {})
          return {
            profileCount: listed.profiles?.length,
            slugs: (listed.profiles || []).map((row) => row.slug),
            defaultProfileId: listed.defaultProfileId,
            threadCount: threads.threads?.length,
            pid: restart.json.pid,
            previousPid: firstPid
          }
        })
      } catch (err) {
        restartState = { error: err instanceof Error ? err.message : String(err) }
      }
    }
    const restartOk =
      restart.exitCode === 0 &&
      restart.json?.started === true &&
      restart.json?.pid !== firstPid &&
      restartState?.profileCount === 2 &&
      countBy(listRelativeFiles(cleanHome), (path) => path === 'auth.json' || path.endsWith('/auth.json')) <= 1
    push(caseRecord('service-restart-no-duplicate-profiles', restartOk ? 'passed' : 'failed', {
      exitCode: restart.exitCode,
      json: restart.json,
      restartState,
      authCopies: listRelativeFiles(cleanHome).filter((path) => path.endsWith('auth.json')),
      durationMs: restart.durationMs,
      error: restart.error,
      stderr: restart.stderr.slice(0, 4000)
    }))

    await stopOwnedDaemon(cleanCtx, {
      timeoutMs: 45_000,
      allowExactPidKill: true,
      logs: { stdout: join(logsDir, 'service-stop-after-restart.stdout.txt'), stderr: join(logsDir, 'service-stop-after-restart.stderr.txt') }
    })

    plantLegacyHome(migrateHome)
    const migrateCtx = {
      packageDir,
      homeDir: migrateHome,
      userDataDir: migrateUserData,
      appDataDir: migrateAppData,
      localAppDataDir: migrateLocalAppData,
      SourceClient
    }
    stopTargets.push(migrateCtx)
    const migrateStart = await spawnPackagedCli({
      ...migrateCtx,
      args: ['--mode', 'json', 'service', 'start'],
      timeoutMs: 45_000,
      stdioLogs: { stdout: join(logsDir, 'migrate-start.stdout.txt'), stderr: join(logsDir, 'migrate-start.stderr.txt') }
    })
    let migrateReady = migrateStart.exitCode === 0 && migrateStart.json?.started === true
    let migrateLate = null
    if (!migrateReady) {
      migrateLate = await waitForOwnedReady(migrateHome, 20_000)
      if (migrateLate.runtime?.pid && migrateLate.owner?.endpoint) {
        migrateReady = true
        migrateStart.json = {
          started: true,
          pid: migrateLate.runtime.pid,
          lateReady: true,
          productionStartError: lastJson(migrateStart.stderr),
          waitedMs: migrateLate.waitedMs
        }
      }
    }
    const migratePid = migrateStart.json?.pid || migrateLate?.runtime?.pid || migrateLate?.owner?.pid
    if (migratePid) report.ownedPids.push(migratePid)
    let migrateDetails = null
    if (migrateReady) {
      try {
        migrateDetails = await withClient(migrateCtx, async (session) => {
          const listed = await session.client.request('profiles.list', {})
          const defaultId = listed.defaultProfileId
          await session.client.request('profiles.bind', { profile: defaultId })
          const threads = await session.client.request('threads.list', {})
          const settings = await session.client.request('settings.get', {})
          const manifest = readJsonFile(join(migrateHome, 'installation.json'))
          const installConf = readJsonFile(join(migrateHome, 'mousse.conf'))
          const profileConf = readJsonFile(join(migrateHome, 'profiles', defaultId, 'mousse.conf'))
          const authInstall = readJsonFile(join(migrateHome, 'auth.json'))
          const authInProfile = existsSync(join(migrateHome, 'profiles', defaultId, 'auth.json'))
          const transcriptMigrated = existsSync(
            join(migrateHome, 'profiles', defaultId, 'thread-data', 'standalone', LEGACY_THREAD_ID, 'transcript.json')
          )
          return {
            defaultId,
            profileCount: listed.profiles?.length,
            slugs: (listed.profiles || []).map((row) => row.slug),
            threadIds: (threads.threads || []).map((row) => row.id),
            threadNames: (threads.threads || []).map((row) => row.name || row.title),
            username: settings.settings?.profile?.username,
            manifestStatus: manifest?.migration?.status,
            installProviders: installConf?.providers ?? null,
            profileProviders: profileConf?.providers ?? null,
            sharedAuthKey: authInstall?.[ 'openai']?.key ?? authInstall?.openai?.key,
            authInProfile,
            transcriptMigrated
          }
        })
      } catch (err) {
        migrateDetails = { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined }
      }
    }
    const migrateOk =
      migrateStart.exitCode === 0 &&
      migrateDetails &&
      migrateDetails.profileCount === 1 &&
      migrateDetails.manifestStatus === 'committed' &&
      migrateDetails.sharedAuthKey === LEGACY_AUTH_KEY &&
      migrateDetails.authInProfile === false &&
      migrateDetails.transcriptMigrated === true &&
      migrateDetails.profileProviders?.llmProvider === 'openrouter' &&
      migrateDetails.installProviders == null
    push(caseRecord('legacy-migration', migrateOk ? 'passed' : 'failed', {
      exitCode: migrateStart.exitCode,
      json: migrateStart.json,
      migrateDetails,
      durationMs: migrateStart.durationMs,
      error: migrateStart.error,
      stderr: migrateStart.stderr.slice(0, 4000)
    }))

    await stopOwnedDaemon(migrateCtx, {
      timeoutMs: 45_000,
      allowExactPidKill: false,
      logs: { stdout: join(logsDir, 'migrate-stop.stdout.txt'), stderr: join(logsDir, 'migrate-stop.stderr.txt') }
    })
    const migrateAgain = await spawnPackagedCli({
      ...migrateCtx,
      args: ['--mode', 'json', 'service', 'start'],
      timeoutMs: 45_000,
      stdioLogs: { stdout: join(logsDir, 'migrate-rerun.stdout.txt'), stderr: join(logsDir, 'migrate-rerun.stderr.txt') }
    })
    let migrateAgainReady = migrateAgain.exitCode === 0 && migrateAgain.json?.started === true
    if (!migrateAgainReady) {
      const late = await waitForOwnedReady(migrateHome, 20_000)
      if (late.runtime?.pid && late.owner?.endpoint) {
        migrateAgainReady = true
        migrateAgain.json = {
          started: true,
          pid: late.runtime.pid,
          lateReady: true,
          productionStartError: lastJson(migrateAgain.stderr),
          waitedMs: late.waitedMs
        }
      }
    }
    const migrateAgainPid = migrateAgain.json?.pid
    if (migrateAgainPid) report.ownedPids.push(migrateAgainPid)
    let rerunDetails = null
    if (migrateAgainReady) {
      try {
        rerunDetails = await withClient(migrateCtx, async (session) => {
          const listed = await session.client.request('profiles.list', {})
          await session.client.request('profiles.bind', { profile: listed.defaultProfileId })
          const threads = await session.client.request('threads.list', {})
          return {
            defaultProfileId: listed.defaultProfileId,
            profileCount: listed.profiles?.length,
            threadCount: threads.threads?.length,
            threadIds: (threads.threads || []).map((row) => row.id)
          }
        })
      } catch (err) {
        rerunDetails = { error: err instanceof Error ? err.message : String(err) }
      }
    }
    const authCopies = listRelativeFiles(migrateHome).filter((path) => /(^|\/)auth\.json$/.test(path))
    const profileDirs = listRelativeFiles(join(migrateHome, 'profiles')).filter((path) => path.endsWith('profile.json'))
    const rerunOk =
      migrateAgain.exitCode === 0 &&
      rerunDetails?.profileCount === 1 &&
      rerunDetails?.defaultProfileId === migrateDetails?.defaultId &&
      authCopies.length === 1 &&
      profileDirs.length === 1
    push(caseRecord('migration-rerun-no-duplicate', rerunOk ? 'passed' : 'failed', {
      exitCode: migrateAgain.exitCode,
      json: migrateAgain.json,
      rerunDetails,
      previousDefaultId: migrateDetails?.defaultId,
      authCopies,
      profileManifests: profileDirs,
      durationMs: migrateAgain.durationMs,
      error: migrateAgain.error,
      stderr: migrateAgain.stderr.slice(0, 4000)
    }))

    await stopOwnedDaemon(migrateCtx, {
      timeoutMs: 45_000,
      allowExactPidKill: true,
      logs: { stdout: join(logsDir, 'migrate-final-stop.stdout.txt'), stderr: join(logsDir, 'migrate-final-stop.stderr.txt') }
    })

    return writeReport()
  } catch (err) {
    push(caseRecord('runner-unhandled', 'failed', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined
    }))
    return writeReport()
  } finally {
    for (const target of stopTargets) {
      try {
        await stopOwnedDaemon(target, {
          timeoutMs: 20_000,
          allowExactPidKill: true,
          logs: {
            stdout: join(logsDir, `final-stop-${target.homeDir === join(workRoot, 'homes', 'clean') ? 'clean' : 'migrate'}.stdout.txt`),
            stderr: join(logsDir, `final-stop-${target.homeDir === join(workRoot, 'homes', 'clean') ? 'clean' : 'migrate'}.stderr.txt`)
          }
        })
      } catch {
        const pid = readRuntime(target.homeDir)?.pid ?? readOwner(target.homeDir)?.pid
        if (pid) killExactPid(pid)
      }
    }
    for (const pid of report.ownedPids) {
      if (isProcessAlive(pid) && pid !== process.pid) killExactPid(pid)
    }
    const residualOwnedPids = report.ownedPids.filter((pid) => isProcessAlive(pid))
    push(caseRecord('owned-process-cleanup', residualOwnedPids.length === 0 ? 'passed' : 'failed', {
      ownedPids: report.ownedPids,
      residualOwnedPids
    }))
    report.defaultUserStateAfter = snapshotDefaultMousseState()
    report.defaultUserHomeTouched =
      JSON.stringify(report.defaultUserStateBefore) !== JSON.stringify(report.defaultUserStateAfter)
    push(caseRecord('default-user-state-unchanged', report.defaultUserHomeTouched ? 'failed' : 'passed', {
      before: report.defaultUserStateBefore,
      after: report.defaultUserStateAfter
    }))
    writeReport()
  }
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function assertNotDefaultUserHome(workRoot) {
  const home = homedir()
  const resolved = resolve(workRoot)
  const forbidden = [
    resolve(home, '.mousse'),
    resolve(home, 'AppData', 'Roaming', 'mousse'),
    resolve(home, 'AppData', 'Roaming', 'Mousse'),
    resolve(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'mousse')
  ]
  if (resolved === home) {
    throw new Error('Refusing to use the user profile directory as MOUSSE_HOME')
  }
  for (const path of forbidden) {
    const prefix = path.endsWith('\\') ? path : `${path}\\`
    if (resolved === path || resolved.toLowerCase().startsWith(prefix.toLowerCase())) {
      throw new Error(`Refusing to use default user Mousse home or AppData: ${resolved}`)
    }
  }
}

export function parseRunnerArgs(argv) {
  const out = {
    packageDir: DEFAULT_WINDOWS_PACKAGE,
    workRoot: null
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--package' || arg === '--package-dir') {
      out.packageDir = argv[++i]
    } else if (arg.startsWith('--package=')) {
      out.packageDir = arg.slice('--package='.length)
    } else if (arg === '--work-root' || arg === '--workRoot') {
      out.workRoot = argv[++i]
    } else if (arg.startsWith('--work-root=')) {
      out.workRoot = arg.slice('--work-root='.length)
    } else if (arg === '--help' || arg === '-h') {
      out.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return out
}
