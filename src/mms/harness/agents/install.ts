/**
 * Managed installs of registry agents, shared by every profile of the installation:
 *
 *   <installationHome>/agents/registry.json                      the registry cache
 *   <installationHome>/agents/<agentId>/<version>/<platform>/    receipt.json + dist/
 *   <installationHome>/agents/<agentId>/refs/<profileId>.json    which entries use which version
 *   <installationHome>/agents/<agentId>/.staging-<random>/       an install in progress
 *   <installationHome>/agents/<agentId>/pending-delete.json      old versions still to delete
 *   <installationHome>/agents/<agentId>/lock.db                  the agent's lock (SQLite, never deleted)
 *
 * A version is downloaded (or installed with npm) into a staging folder, checked, given a receipt
 * and renamed into place under the agent's lock. A published version is never changed; a launch
 * refuses files that differ from its receipt.
 */
import { createHash } from 'node:crypto'
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import type { RegistrySourcePatch, RemoveInstallResult } from '../../../shared/harness/types'
import { atomicWriteJsonSync } from '../../data/AtomicFs'
import { resolveWindowsShim, type CliLaunch } from '../../providers/resolveWindowsShim'
import { quirksFor } from '../acp/quirks'
import { INHERITED_CREDENTIALS, resolveCommand, type InstanceEnv } from '../env'
import { runHarness, type HarnessRunResult } from '../spawn'
import { containedFile, createStaging, extractArchive } from './archive'
import { LOCK_FILE, withLock } from './lock'
import { changedFile, DIST_DIR, hashFile, hashTree, readReceipt, RECEIPT_FILE, type AgentReceipt } from './receipt'
import { cleanEnv, commandSegments, platformKeys, resolveDistribution, type AcpRegistry, type RegistryAgent, type RegistryPlatform } from './registry'

export const MAX_DOWNLOAD_BYTES = 1024 ** 3
export const DOWNLOAD_TIMEOUT_MS = 20 * 60_000
export const NPM_TIMEOUT_MS = 20 * 60_000

/** Redirects a download may follow besides its own host: release assets GitHub serves elsewhere. */
export const REDIRECT_HOSTS: Readonly<Record<string, readonly string[]>> = {
  'github.com': ['objects.githubusercontent.com', 'release-assets.githubusercontent.com']
}

const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/

export interface InstallProgress {
  message: string
  receivedBytes?: number
  totalBytes?: number
}

export class ConsentRequiredError extends Error {}

/** A registry source as the instance config stores it. */
export type RegistrySource = RegistrySourcePatch & { receiptHash?: string }

export interface InstalledAgent {
  root: string
  receipt: AgentReceipt
  hash: string
}

export interface AgentLaunch {
  command: string
  args: string[]
  env: Record<string, string>
  /** The file the receipt guards that starts the agent (the script, for Node agents). */
  path: string
}

export type NpmRunner = (args: string[], options: { env: InstanceEnv; signal: AbortSignal; timeoutMs: number; cwd: string }) => Promise<HarnessRunResult>

/** The npm registry npm agents install from: the registry the ACP registry's `npx` entries mean. */
export const NPM_REGISTRY = 'https://registry.npmjs.org/'

export interface AgentInstallsOptions {
  installationHome: string
  profileId: string
  registry: Pick<AcpRegistry, 'agent' | 'cached'>
  /** Profiles the installation lists; a reference from any other profile does not count. Absent: all count. */
  listProfiles?: () => Array<{ id: string; displayName?: string }>
  /** This profile's entries; its references of entries removed since do not count. Absent: all count. */
  liveInstances?: () => string[]
  fetch?: typeof fetch
  /** Test seam: runs `npm …` (default: the user's npm from the login-shell PATH). */
  npm?: NpmRunner
  platformKeys?: RegistryPlatform[]
  maxDownloadBytes?: number
  downloadTimeoutMs?: number
  /** How long a deletion waits for processes that are exiting (default 5 s). */
  exitGraceMs?: number
  /** Test seam: the npm registry (default `NPM_REGISTRY`). */
  npmRegistry?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const mb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1_048_576))} MB`

/** References one profile keeps: entry id → the version and platform it runs. */
type RefFile = { instances: Record<string, { version: string; platform: string }> }
type Ref = { version: string; platform: string }

/** Processes running from an install root in this process, so its files are not deleted under them. */
const running = new Map<string, number>()
/**
 * Roots waiting for their last process here to end, with the deletion to run then: it takes the
 * agent's lock and checks the references again, since another entry may use the version by then.
 */
const deleteWhenIdle = new Map<string, () => void>()
/** Installation homes swept in this process. */
const swept = new Set<string>()

function tryDelete(root: string): boolean {
  if ((running.get(root) ?? 0) > 0) return false
  try {
    rmSync(root, { recursive: true, force: true })
    return !existsSync(root)
  } catch {
    return false
  }
}

/** Variables an npm install never sees: every credential a driver reads, and any token or secret. */
export function withoutCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const named = new Set(Object.values(INHERITED_CREDENTIALS).flatMap((names) => names!.map((name) => name.toUpperCase())))
  const result: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase()
    if (named.has(upper) || /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|_AUTH|CREDENTIAL)/.test(upper)) continue
    result[key] = value
  }
  return result
}

/**
 * The environment npm installs an agent with: no credentials, none of the user's npm settings
 * (every `npm_config_*` is dropped; user and global config are empty files of Mousse's own), a
 * private cache, and a home of its own, so no `.npmrc` of the user's is read.
 */
export function isolatedNpmEnv(env: NodeJS.ProcessEnv, paths: { home: string; userconfig: string; globalconfig: string; cache: string }): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(withoutCredentials(env))) {
    const upper = key.toUpperCase()
    if (upper.startsWith('NPM_CONFIG_') || upper === 'HOME' || upper === 'USERPROFILE' || upper === 'XDG_CONFIG_HOME') continue
    result[key] = value
  }
  return {
    ...result,
    HOME: paths.home,
    USERPROFILE: paths.home,
    NPM_CONFIG_USERCONFIG: paths.userconfig,
    NPM_CONFIG_GLOBALCONFIG: paths.globalconfig,
    NPM_CONFIG_CACHE: paths.cache,
    NPM_CONFIG_UPDATE_NOTIFIER: 'false'
  }
}

/** The sha512 of an npm `dist.integrity` (it may list several algorithms). */
export function sha512Of(integrity: unknown): string | undefined {
  if (typeof integrity !== 'string') return undefined
  return integrity.split(/\s+/).find((entry) => entry.startsWith('sha512-'))?.slice('sha512-'.length)
}

/**
 * Downloads `url` to `target`: streamed SHA-256, a size cap and a deadline. Redirects may only
 * stay on the declared host (same scheme) or go to the fixed `REDIRECT_HOSTS` table.
 */
export async function downloadArtifact(
  url: string,
  target: string,
  options: { signal?: AbortSignal; fetch?: typeof fetch; maxBytes?: number; timeoutMs?: number; onProgress?: (progress: InstallProgress) => void; label: string }
): Promise<{ sha256: string; finalUrl: string; bytes: number }> {
  const fetchFile = options.fetch ?? fetch
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const declared = new URL(url)
  const allowed = new Set([declared.host, ...(REDIRECT_HOSTS[declared.hostname] ?? [])])
  let current = declared
  let response: Response | undefined
  for (let hop = 0; ; hop += 1) {
    response = await fetchFile(current.href, { signal, redirect: 'manual' })
    if (response.status < 300 || response.status >= 400) break
    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => undefined)
    if (!location || hop >= 5) throw new Error(`The ${options.label} download redirected too often.`)
    const next = new URL(location, current)
    if (next.protocol !== declared.protocol || !allowed.has(next.host))
      throw new Error(`The ${options.label} download redirected to ${next.host}, which Mousse does not download agents from.`)
    current = next
  }
  if (!response.ok || !response.body) throw new Error(`The ${options.label} download failed (${response.status}).`)
  const max = options.maxBytes ?? MAX_DOWNLOAD_BYTES
  const declaredSize = Number(response.headers.get('content-length'))
  const total = Number.isFinite(declaredSize) && declaredSize > 0 ? declaredSize : undefined
  if (total && total > max) {
    await response.body.cancel().catch(() => undefined)
    throw new Error(`The ${options.label} download is larger than ${mb(max)}.`)
  }
  const hash = createHash('sha256')
  const writer = createWriteStream(target, { flags: 'wx', mode: 0o600 })
  // A failing file (no folder, no permission, a full disk) rejects the download; it never goes
  // unhandled. The file is closed before the caller deletes the staging folder.
  const closed = new Promise<void>((resolve) => writer.once('close', resolve))
  const failed = new Promise<never>((_resolve, reject) => writer.once('error', reject))
  failed.catch(() => undefined)
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  aborted.catch(() => undefined)
  const reader = response.body.getReader()
  let received = 0
  let reported = -1
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await Promise.race([reader.read(), failed])
      if (done) break
      received += value.byteLength
      if (received > max) throw new Error(`The ${options.label} download is larger than ${mb(max)}.`)
      hash.update(value)
      const step = total ? Math.floor((received / total) * 100) : Math.floor(received / 1_048_576)
      if (step > reported) {
        reported = step
        options.onProgress?.({ message: total ? `Downloading ${mb(received)} of ${mb(total)}` : `Downloading ${mb(received)}`, receivedBytes: received, ...(total ? { totalBytes: total } : {}) })
      }
      if (!writer.write(value)) await Promise.race([new Promise<void>((resolve) => writer.once('drain', resolve)), failed, aborted])
    }
    writer.end()
    await Promise.race([new Promise<void>((resolve) => writer.once('finish', resolve)), failed])
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    writer.destroy()
    await closed
    throw timeout.aborted && !options.signal?.aborted ? new Error(`The ${options.label} download did not finish in time.`) : error
  }
  await closed
  return { sha256: hash.digest('hex'), finalUrl: current.href, bytes: received }
}

/** The package folder of `name` under an npm `--global --prefix` folder. */
function npmPackageDir(prefix: string, name: string, platform: NodeJS.Platform = process.platform): string {
  const base = platform === 'win32' ? join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules')
  return join(base, ...name.split('/'))
}

/**
 * The script a package's command runs. A package with one command (`"bin": "cli.js"`, or a single
 * entry) runs that; with several, the one named after the registry agent, else after the package.
 */
export function packageBin(manifest: Record<string, unknown>, agentId: string, name: string): string | undefined {
  const bin = manifest.bin
  if (typeof bin === 'string') return bin
  if (!isRecord(bin)) return undefined
  const commands = new Map(Object.entries(bin).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  if (commands.size === 1) return [...commands.values()][0]
  return commands.get(agentId) ?? commands.get(name.slice(name.lastIndexOf('/') + 1))
}

export class AgentInstalls {
  private readonly agentsDir: string
  private readonly installs = new Map<string, AbortController>()
  /** Receipts as last read, by file stamp: snapshots read them often. */
  private readonly receipts = new Map<string, { stamp: string; read: ReturnType<typeof readReceipt> }>()

  constructor(private readonly options: AgentInstallsOptions) {
    this.agentsDir = join(options.installationHome, 'agents')
    if (!PROFILE_ID.test(options.profileId)) throw new Error(`Invalid profile id ${options.profileId}`)
  }

  private agentDir(agentId: string): string {
    if (!AGENT_ID.test(agentId)) throw new Error(`Invalid agent id ${agentId}`)
    return join(this.agentsDir, agentId)
  }

  private lockPath(agentId: string): string {
    return join(this.agentDir(agentId), LOCK_FILE)
  }

  private keys(): RegistryPlatform[] {
    return this.options.platformKeys ?? platformKeys()
  }

  /** Candidate roots of `source`, best first (Windows on Arm may run the x64 build). */
  private roots(source: RegistrySource): string[] {
    if (!VERSION.test(source.version)) throw new Error(`Invalid agent version ${source.version}`)
    const base = join(this.agentDir(source.agentId), source.version)
    return source.distribution === 'npx' ? [join(base, 'node')] : this.keys().map((key) => join(base, key))
  }

  /** The published install of `source`, when there is one. */
  installed(source: RegistrySource): InstalledAgent | undefined {
    for (const root of this.roots(source)) {
      const read = this.receipt(join(root, RECEIPT_FILE))
      if (read && read.receipt.agentId === source.agentId && read.receipt.version === source.version && read.receipt.distribution === source.distribution)
        return { root, ...read }
    }
    return undefined
  }

  private receipt(path: string): ReturnType<typeof readReceipt> {
    let stamp: string
    try {
      const stat = statSync(path)
      stamp = `${stat.size}:${stat.mtimeMs}:${stat.ino}`
    } catch {
      this.receipts.delete(path)
      return undefined
    }
    const cached = this.receipts.get(path)
    if (cached?.stamp === stamp) return cached.read
    const read = readReceipt(path)
    this.receipts.set(path, { stamp, read })
    return read
  }

  /**
   * Why `installed` may not run now: its receipt is not the one the entry was installed with, or a
   * file under it was added, changed or removed (every file is rehashed).
   */
  async changed(installed: InstalledAgent, receiptHash: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
    if (receiptHash && installed.hash !== receiptHash) return 'the install was replaced'
    return changedFile(join(installed.root, DIST_DIR), installed.receipt, signal)
  }

  /** How `installed` starts: its receipt's launch, resolved inside the install folder. */
  launch(installed: InstalledAgent, env: Pick<InstanceEnv, 'env' | 'searchPath'>): AgentLaunch {
    const { root } = installed
    // The receipt's arguments and variables pass the registry's rules again (a receipt can be edited).
    const receipt = { ...installed.receipt, launch: { ...installed.receipt.launch, args: installed.receipt.launch.args.filter((arg): arg is string => typeof arg === 'string'), env: cleanEnv(installed.receipt.launch.env) } }
    const segments = commandSegments(receipt.launch.cmd)
    if (!segments) throw new Error('The receipt names an invalid command.')
    const dist = join(root, DIST_DIR)
    if (receipt.launch.runner === 'node') {
      const script = containedFile(dist, segments)
      const node = resolveCommand('node', env)
      if (!node) throw new Error('Node.js is not on your PATH, and this agent needs it.')
      return { command: node.command, args: [...node.args, script, ...receipt.launch.args], env: { ...receipt.launch.env }, path: script }
    }
    const program = containedFile(dist, segments, { executable: true })
    const launch = resolveWindowsShim(program, { env: env.env })
    if (!launch) throw new Error(`Mousse cannot run ${receipt.launch.cmd}.`)
    // A Windows shim runs another file: it must be one the receipt guards, inside the install.
    if (launch.path !== program) {
      const inside = relative(dist, launch.path)
      if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error(`${receipt.launch.cmd} starts a program outside the install folder.`)
      containedFile(dist, inside.split(/[\\/]/))
    }
    return { command: launch.command, args: [...launch.args, ...receipt.launch.args], env: { ...receipt.launch.env }, path: program }
  }

  /** Marks a process running from `root`; the returned function marks it ended. */
  track(root: string): () => void {
    running.set(root, (running.get(root) ?? 0) + 1)
    let done = false
    return () => {
      if (done) return
      done = true
      const left = (running.get(root) ?? 1) - 1
      if (left > 0) running.set(root, left)
      else {
        running.delete(root)
        const retry = deleteWhenIdle.get(root)
        deleteWhenIdle.delete(root)
        retry?.()
      }
    }
  }

  /** Set when the registry now starts the installed version differently than its receipt. */
  advisory(installed: InstalledAgent): string | undefined {
    const agent = this.options.registry.cached().find((entry) => entry.id === installed.receipt.agentId)
    if (!agent || agent.version !== installed.receipt.version) return undefined
    const resolved = resolveDistribution(agent, this.keys(), installed.receipt.distribution)
    if (!resolved || resolved.kind === 'uvx') return undefined
    const { args, env } = resolved.kind === 'binary' ? resolved.target : resolved.spec
    const sameCmd = resolved.kind !== 'binary' || commandSegments(resolved.target.cmd)?.join('/') === installed.receipt.launch.cmd
    const same = sameCmd && JSON.stringify([args, env]) === JSON.stringify([installed.receipt.launch.args, installed.receipt.launch.env])
    return same ? undefined : 'The registry now starts this version differently. Mousse keeps the settings it installed; reinstall to use the new ones.'
  }

  cancel(instanceId: string): boolean {
    const controller = this.installs.get(instanceId)
    if (!controller) return false
    controller.abort(new Error('Install cancelled'))
    return true
  }

  installing(instanceId: string): boolean {
    return this.installs.has(instanceId)
  }

  /**
   * Installs `source` for the entry `instanceId` (or reuses the copy another entry or profile
   * published), records the entry's reference, and deletes the version it used before once no one
   * uses it.
   */
  async install(input: { instanceId: string; source: RegistrySource; env: InstanceEnv; label: string; onProgress: (progress: InstallProgress) => void }): Promise<InstalledAgent> {
    if (this.installs.has(input.instanceId)) throw new Error(`${input.label} is already being installed.`)
    const controller = new AbortController()
    this.installs.set(input.instanceId, controller)
    const signal = controller.signal
    try {
      this.sweep()
      const { source } = input
      const agentDir = this.agentDir(source.agentId)
      const previous = this.readRefs(source.agentId, this.options.profileId).instances[input.instanceId]
      let installed = this.installed(source)
      // A copy another entry or profile published, unchanged since, serves this one too.
      if (!installed || (await this.changed(installed, undefined, signal))) installed = await this.download(input, agentDir, signal)
      else await withLock(this.lockPath(source.agentId), () => this.writeRef(source.agentId, input.instanceId, installed), { signal })
      if (previous && (previous.version !== installed.receipt.version || previous.platform !== installed.receipt.platform))
        await this.retire(source.agentId, previous)
      return installed
    } finally {
      this.installs.delete(input.instanceId)
    }
  }

  private async download(input: { instanceId: string; source: RegistrySource; env: InstanceEnv; label: string; onProgress: (progress: InstallProgress) => void }, agentDir: string, signal: AbortSignal): Promise<InstalledAgent> {
    const { source, label } = input
    input.onProgress({ message: `Checking the ACP registry for ${label}…` })
    const agent = await this.options.registry.agent(source.agentId, signal)
    if (!agent) throw new Error(`The ACP registry no longer lists ${source.agentId}.`)
    if (agent.version !== source.version) throw new Error(`The ACP registry now has ${label} ${agent.version}, not ${source.version}. Update the entry to install it.`)
    const staging = createStaging(agentDir)
    try {
      atomicWriteJsonSync(join(staging, 'owner.json'), { pid: process.pid })
      const receipt = source.distribution === 'npx'
        ? await this.stageNpm(agent, staging, input, signal)
        : await this.stageBinary(agent, source, staging, input, signal)
      atomicWriteJsonSync(join(staging, RECEIPT_FILE), receipt)
      rmSync(join(staging, 'owner.json'), { force: true })
      input.onProgress({ message: `Finishing the ${label} install…` })
      signal.throwIfAborted()
      const root = join(agentDir, source.version, receipt.platform)
      return await withLock(this.lockPath(source.agentId), async () => {
        // The last point to stop: past here the version is published.
        signal.throwIfAborted()
        // Another profile published this version meanwhile: its copy serves when it is sound.
        const current = this.installed(source)
        if (current?.root === root && !(await this.changed(current, undefined, signal))) {
          this.writeRef(source.agentId, input.instanceId, current)
          return current
        }
        // Anything else there is broken (changed files, a partial copy): it is replaced.
        if (existsSync(root) && !tryDelete(root)) throw new Error(`The old ${label} files are still in use. Stop the chats using them, then install again.`)
        mkdirSync(join(agentDir, source.version), { recursive: true })
        renameSync(staging, root)
        const read = readReceipt(join(root, RECEIPT_FILE))
        if (!read) throw new Error('The install could not be recorded.')
        const installed: InstalledAgent = { root, ...read }
        this.writeRef(source.agentId, input.instanceId, installed)
        return installed
      }, { signal })
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }

  private async stageBinary(agent: RegistryAgent, source: RegistrySource, staging: string, input: { label: string; onProgress: (progress: InstallProgress) => void }, signal: AbortSignal): Promise<AgentReceipt> {
    const resolved = resolveDistribution(agent, this.keys(), 'binary')
    if (!resolved || resolved.kind !== 'binary') throw new Error(`${input.label} has no download for this computer.`)
    if (!resolved.archive) throw new Error(`${input.label} is not a zip or tar.gz download, which Mousse needs.`)
    const { target } = resolved
    const verified = Boolean(target.sha256)
    // Every new unverified download needs its own yes: the consent names the version and the URL.
    if (!verified && (source.consent?.version !== agent.version || source.consent.artifactUrl !== target.archive))
      throw new ConsentRequiredError(`The registry publishes no checksum for ${input.label} ${agent.version}. Confirm the download to install it.`)
    const segments = commandSegments(target.cmd)!
    const archive = join(staging, `download${resolved.archive === 'zip' ? '.zip' : '.tar.gz'}`)
    input.onProgress({ message: `Downloading ${input.label}…` })
    const download = await downloadArtifact(target.archive, archive, {
      signal,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.maxDownloadBytes ? { maxBytes: this.options.maxDownloadBytes } : {}),
      ...(this.options.downloadTimeoutMs ? { timeoutMs: this.options.downloadTimeoutMs } : {}),
      onProgress: input.onProgress,
      label: input.label
    })
    if (target.sha256 && download.sha256 !== target.sha256) throw new Error(`The ${input.label} download does not match the registry checksum.`)
    input.onProgress({ message: `Unpacking ${input.label}…` })
    const dist = join(staging, DIST_DIR)
    await extractArchive(archive, dist, { format: resolved.archive, signal })
    rmSync(archive, { force: true })
    // The declared command runs as a program (zip files often lose the executable bit).
    if (process.platform !== 'win32') {
      try {
        const program = join(dist, ...segments)
        if (statSync(program).isFile()) chmodSync(program, 0o755)
      } catch {
        /* reported below */
      }
    }
    containedFile(dist, segments, { executable: true })
    const tree = await hashTree(dist, signal)
    const now = new Date().toISOString()
    return {
      agentId: agent.id,
      version: agent.version,
      platform: resolved.platform,
      distribution: 'binary',
      artifactUrl: target.archive,
      ...(download.finalUrl !== target.archive ? { finalUrl: download.finalUrl } : {}),
      ...(target.sha256 ? { expected: { algorithm: 'sha256' as const, digest: target.sha256 } } : {}),
      archiveSha256: download.sha256,
      files: tree.files,
      bytes: tree.bytes,
      launch: { cmd: segments.join('/'), args: [...target.args], env: { ...target.env } },
      checksum: verified ? 'registry' : 'none',
      ...(verified ? {} : { consentedAt: now }),
      installedAt: now
    }
  }

  private async stageNpm(agent: RegistryAgent, staging: string, input: { env: InstanceEnv; label: string; onProgress: (progress: InstallProgress) => void }, signal: AbortSignal): Promise<AgentReceipt> {
    const resolved = resolveDistribution(agent, this.keys(), 'npx')
    if (!resolved || resolved.kind !== 'npx') throw new Error(`${input.label} has no npm package.`)
    const dist = join(staging, DIST_DIR)
    mkdirSync(dist, { recursive: true })
    // The package itself comes from the npm registry, checked against the sha512 it publishes for
    // this exact version; npm then installs that file, and its dependencies from the same registry.
    const registry = this.options.npmRegistry ?? NPM_REGISTRY
    input.onProgress({ message: `Checking ${resolved.spec.package} on the npm registry…` })
    const meta = await this.packageMetadata(registry, resolved.name, resolved.packageVersion, signal)
    const tarball = join(staging, 'package.tgz')
    input.onProgress({ message: `Downloading ${resolved.spec.package}…` })
    const download = await downloadArtifact(meta.tarball, tarball, {
      signal,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      onProgress: input.onProgress,
      label: input.label
    })
    if ((await hashFile(tarball, signal, 'sha512', 'base64')) !== meta.sha512) throw new Error(`The ${resolved.spec.package} download does not match the npm registry checksum.`)
    // npm reads none of the user's settings or credentials: empty config files and a home of its own.
    const npmDir = join(staging, 'npm')
    const paths = { home: join(npmDir, 'home'), userconfig: join(npmDir, 'userconfig'), globalconfig: join(npmDir, 'globalconfig'), cache: join(npmDir, 'cache') }
    mkdirSync(paths.home, { recursive: true })
    mkdirSync(paths.cache, { recursive: true })
    writeFileSync(paths.userconfig, '')
    writeFileSync(paths.globalconfig, '')
    input.onProgress({ message: `Installing ${resolved.spec.package} with npm…` })
    const scripts = quirksFor(agent.id).allowInstallScripts ? [] : ['--ignore-scripts']
    const args = [
      'install', '--global', '--prefix', dist, `--registry=${registry}`, `--userconfig=${paths.userconfig}`, `--globalconfig=${paths.globalconfig}`,
      `--cache=${paths.cache}`, ...scripts, '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=error', tarball
    ]
    const env: InstanceEnv = { ...input.env, env: isolatedNpmEnv(input.env.env, paths) }
    let result: HarnessRunResult
    try {
      result = await (this.options.npm ?? runUserNpm)(args, { env, signal, timeoutMs: NPM_TIMEOUT_MS, cwd: npmDir })
    } finally {
      // npm's private cache, home and config, and the tarball, are not part of the install.
      rmSync(npmDir, { recursive: true, force: true })
      rmSync(tarball, { force: true })
    }
    signal.throwIfAborted()
    if (result.spawnError) throw new Error(result.spawnError === 'npm_not_found' ? 'npm is not on your PATH. Install Node.js, then try again.' : `npm could not start (${result.spawnError}).`)
    if (result.timedOut) throw new Error('npm did not finish in time.')
    if (result.code !== 0) throw new Error(`npm failed: ${(result.stderr || result.stdout).trim().split(/\r?\n/).slice(-3).join(' ') || `exit code ${result.code}`}`)
    const packageDir = npmPackageDir(dist, resolved.name)
    let manifest: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
      if (!isRecord(parsed)) throw new Error('not an object')
      manifest = parsed
    } catch {
      throw new Error(`npm did not install ${resolved.name}.`)
    }
    if (manifest.version !== resolved.packageVersion) throw new Error(`npm installed ${resolved.name} ${String(manifest.version)}, not ${resolved.packageVersion}.`)
    const bin = packageBin(manifest, agent.id, resolved.name)
    const binSegments = bin ? commandSegments(bin) : undefined
    if (!binSegments) throw new Error(`${resolved.name} names no command to run.`)
    const cmd = [...packageDir.slice(dist.length + 1).split(/[\\/]/), ...binSegments].join('/')
    containedFile(dist, cmd.split('/'))
    const tree = await hashTree(dist, signal)
    return {
      agentId: agent.id,
      version: agent.version,
      platform: 'node',
      distribution: 'npx',
      artifactUrl: resolved.spec.package,
      finalUrl: download.finalUrl,
      expected: { algorithm: 'sha512', digest: meta.sha512 },
      archiveSha256: download.sha256,
      files: tree.files,
      bytes: tree.bytes,
      launch: { cmd, args: [...resolved.spec.args], env: { ...resolved.spec.env }, runner: 'node' },
      // Mousse checked the package against the npm registry's sha512; npm checked its dependencies.
      checksum: 'registry',
      installedAt: new Date().toISOString()
    }
  }

  /** The tarball and sha512 the npm registry publishes for `name@version`. */
  private async packageMetadata(registry: string, name: string, version: string, signal: AbortSignal): Promise<{ tarball: string; sha512: string }> {
    const base = new URL(registry)
    const url = new URL(`${name.replace('/', '%2f')}/${encodeURIComponent(version)}`, base)
    const response = await (this.options.fetch ?? fetch)(url.href, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: 'error', headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`The npm registry has no ${name}@${version} (${response.status}).`)
    const text = await response.text()
    if (text.length > 4 * 1024 * 1024) throw new Error(`The npm registry answer for ${name} is too large.`)
    let meta: unknown
    try {
      meta = JSON.parse(text)
    } catch {
      throw new Error(`The npm registry answer for ${name} is not JSON.`)
    }
    const dist = isRecord(meta) && isRecord(meta.dist) ? meta.dist : undefined
    const sha512 = sha512Of(dist?.integrity)
    if (!dist || !sha512 || typeof dist.tarball !== 'string') throw new Error(`The npm registry publishes no sha512 for ${name}@${version}.`)
    if (!isRecord(meta) || meta.version !== version) throw new Error(`The npm registry answered for another version of ${name}.`)
    // The tarball comes from that registry's host, like everything npm installs here.
    const tarball = new URL(dist.tarball)
    if (tarball.protocol !== base.protocol || tarball.host !== base.host) throw new Error(`The ${name} package is served from ${tarball.host}, not ${base.host}.`)
    return { tarball: tarball.href, sha512 }
  }

  // -- References ---------------------------------------------------------------------------------

  private refPath(agentId: string, profileId: string): string {
    return join(this.agentDir(agentId), 'refs', `${profileId}.json`)
  }

  private readRefs(agentId: string, profileId: string): RefFile {
    try {
      const value: unknown = JSON.parse(readFileSync(this.refPath(agentId, profileId), 'utf8'))
      if (isRecord(value) && isRecord(value.instances)) {
        const instances: RefFile['instances'] = {}
        for (const [id, entry] of Object.entries(value.instances))
          if (isRecord(entry) && typeof entry.version === 'string' && typeof entry.platform === 'string') instances[id] = { version: entry.version, platform: entry.platform }
        return { instances }
      }
    } catch {
      /* none yet */
    }
    return { instances: {} }
  }

  /** Call with the agent's lock held. `installed` undefined drops the entry's reference. */
  private writeRef(agentId: string, instanceId: string, installed: InstalledAgent | undefined): void {
    const refs = this.readRefs(agentId, this.options.profileId)
    if (installed) {
      refs.instances[instanceId] = { version: installed.receipt.version, platform: installed.receipt.platform }
      // A version in use again is no longer waiting to be deleted.
      deleteWhenIdle.delete(installed.root)
      const pending = this.readPending(agentId)
      const left = pending.filter((entry) => entry.version !== installed.receipt.version || entry.platform !== installed.receipt.platform)
      if (left.length !== pending.length) {
        if (left.length) atomicWriteJsonSync(this.pendingPath(agentId), left)
        else rmSync(this.pendingPath(agentId), { force: true })
      }
    } else delete refs.instances[instanceId]
    const path = this.refPath(agentId, this.options.profileId)
    if (!Object.keys(refs.instances).length) {
      rmSync(path, { force: true })
      return
    }
    mkdirSync(join(this.agentDir(agentId), 'refs'), { recursive: true })
    atomicWriteJsonSync(path, refs)
  }

  /** Every reference that counts: of profiles the installation still lists. */
  private liveRefs(agentId: string): Array<{ profileId: string; instanceId: string } & Ref> {
    let files: string[]
    try {
      files = readdirSync(join(this.agentDir(agentId), 'refs')).filter((name) => name.endsWith('.json'))
    } catch {
      return []
    }
    const listed = this.options.listProfiles ? new Set(this.options.listProfiles().map((profile) => profile.id)) : undefined
    const own = this.options.liveInstances ? new Set(this.options.liveInstances()) : undefined
    return files.flatMap((name) => {
      const profileId = name.slice(0, -'.json'.length)
      if (!PROFILE_ID.test(profileId)) return []
      // A reference of a deleted profile keeps nothing alive.
      if (listed && !listed.has(profileId) && profileId !== this.options.profileId) return []
      return Object.entries(this.readRefs(agentId, profileId).instances)
        // Nor does one this profile kept for an entry it no longer has.
        .filter(([instanceId]) => profileId !== this.options.profileId || !own || own.has(instanceId))
        .map(([instanceId, entry]) => ({ profileId, instanceId, ...entry }))
    })
  }

  /** The entry was removed: its reference goes (its files stay unless deleted). */
  async release(instanceId: string, source: RegistrySource): Promise<void> {
    await withLock(this.lockPath(source.agentId), () => this.writeRef(source.agentId, instanceId, undefined))
  }

  /**
   * Deletes the files of the entry's install. Other entries that use them (in any listed profile)
   * block it unless `force`; a process running from them here always does.
   */
  async removeInstall(input: { instanceId: string; source: RegistrySource; force: boolean }): Promise<RemoveInstallResult> {
    const installed = this.installed(input.source)
    const { agentId } = input.source
    // A check that just ended may still be exiting: give it a moment, never a running chat.
    if (installed) await this.idle(installed.root, this.options.exitGraceMs ?? 5_000)
    return withLock(this.lockPath(agentId), (): RemoveInstallResult => {
      if (!installed) {
        this.writeRef(agentId, input.instanceId, undefined)
        return { removed: true, bytes: 0 }
      }
      const others = this.liveRefs(agentId).filter((ref) =>
        ref.version === installed.receipt.version && ref.platform === installed.receipt.platform &&
        !(ref.profileId === this.options.profileId && ref.instanceId === input.instanceId))
      if (others.length && !input.force) {
        const names = new Map((this.options.listProfiles?.() ?? []).map((profile) => [profile.id, profile.displayName]))
        const byProfile = new Map<string, number>()
        for (const ref of others) byProfile.set(ref.profileId, (byProfile.get(ref.profileId) ?? 0) + 1)
        return {
          removed: false,
          usedBy: [...byProfile].map(([profileId, entries]) => {
            const profileName = names.get(profileId)
            return { profileId, ...(profileName ? { profileName } : {}), entries }
          })
        }
      }
      if ((running.get(installed.root) ?? 0) > 0) throw new Error('A chat is still running on these files. Stop it, then delete them.')
      if (!tryDelete(installed.root)) throw new Error('Mousse could not delete the files. Close anything using them, then try again.')
      this.writeRef(agentId, input.instanceId, undefined)
      return { removed: true, bytes: installed.receipt.bytes }
    })
  }

  /** Waits up to `ms` for the processes running from `root` here to end. */
  private async idle(root: string, ms: number): Promise<void> {
    const deadline = Date.now() + ms
    while ((running.get(root) ?? 0) > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
  }

  /** Bytes the entry's install takes on disk, when it is installed. */
  bytes(source: RegistrySource): number | undefined {
    return this.installed(source)?.receipt.bytes
  }

  private pendingPath(agentId: string): string {
    return join(this.agentDir(agentId), 'pending-delete.json')
  }

  private readPending(agentId: string): Ref[] {
    try {
      const value: unknown = JSON.parse(readFileSync(this.pendingPath(agentId), 'utf8'))
      return Array.isArray(value) ? value.filter((entry): entry is Ref => isRecord(entry) && typeof entry.version === 'string' && typeof entry.platform === 'string') : []
    } catch {
      return []
    }
  }

  /**
   * An entry moved off `old` (an update): `old` is deleted once no live reference names it. One
   * that cannot go yet (a process still runs from it, a Windows file lock) is deleted when its last
   * process here ends, or at the next start.
   */
  private async retire(agentId: string, old: Ref): Promise<void> {
    await withLock(this.lockPath(agentId), () => {
      const pending = [...this.readPending(agentId).filter((entry) => entry.version !== old.version || entry.platform !== old.platform), old]
      atomicWriteJsonSync(this.pendingPath(agentId), pending)
      this.deletePending(agentId)
    }).catch((error) => console.warn('[agents] could not delete an old version', { agentId, error: errorText(error) }))
  }

  /** Call with the lock held: deletes pending versions no live reference names. */
  private deletePending(agentId: string): void {
    const used = new Set(this.liveRefs(agentId).map((ref) => `${ref.version}/${ref.platform}`))
    const left = this.readPending(agentId).filter((entry) => {
      if (used.has(`${entry.version}/${entry.platform}`) || !VERSION.test(entry.version) || !/^[a-z0-9_-]+$/.test(entry.platform)) {
        deleteWhenIdle.delete(join(this.agentDir(agentId), entry.version, entry.platform))
        return false
      }
      const versionDir = join(this.agentDir(agentId), entry.version)
      const root = join(versionDir, entry.platform)
      if (!tryDelete(root)) {
        // Still running here: tried again, under the lock and with fresh references, once it ends.
        deleteWhenIdle.set(root, () => void withLock(this.lockPath(agentId), () => this.deletePending(agentId)).catch((error) =>
          console.warn('[agents] could not delete an old version', { agentId, error: errorText(error) })))
        return true
      }
      try {
        if (!readdirSync(versionDir).length) rmSync(versionDir, { recursive: true, force: true })
      } catch {
        /* already gone */
      }
      return false
    })
    if (left.length) atomicWriteJsonSync(this.pendingPath(agentId), left)
    else rmSync(this.pendingPath(agentId), { force: true })
  }

  private listDirs(dir: string): string[] {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      return []
    }
  }

  /**
   * Once per process and installation: removes staging folders whose installing process is gone,
   * and old versions an earlier run could not delete yet.
   */
  sweep(): void {
    if (swept.has(this.agentsDir)) return
    swept.add(this.agentsDir)
    for (const agentId of this.listDirs(this.agentsDir)) {
      if (!AGENT_ID.test(agentId)) continue
      const agentDir = join(this.agentsDir, agentId)
      for (const name of this.listDirs(agentDir)) {
        if (!name.startsWith('.staging-')) continue
        const staging = join(agentDir, name)
        if (!this.stagingAlive(staging)) rmSync(staging, { recursive: true, force: true })
      }
      if (existsSync(this.pendingPath(agentId)))
        void withLock(this.lockPath(agentId), () => this.deletePending(agentId)).catch(() => undefined)
    }
  }

  /** A staging folder another live process is still filling (its owner, or one made in the last hour). */
  private stagingAlive(staging: string): boolean {
    let owner: number | undefined
    try {
      const value = JSON.parse(readFileSync(join(staging, 'owner.json'), 'utf8')) as { pid?: unknown }
      if (typeof value.pid === 'number') owner = value.pid
    } catch {
      /* not recorded (yet) */
    }
    if (owner === undefined) {
      try {
        return Date.now() - statSync(staging).mtimeMs < 60 * 60_000
      } catch {
        return false
      }
    }
    // This process sweeps before it installs anything: a folder it owns is left from a reused pid.
    if (owner === process.pid) return false
    try {
      process.kill(owner, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  }
}

/** Test hook: forgets which installations were swept and which roots wait for deletion. */
export function resetAgentInstallState(): void {
  swept.clear()
  deleteWhenIdle.clear()
  running.clear()
}

/**
 * The user's npm on the login-shell PATH, run without a shell. On Windows npm's own `npm.cmd`
 * does not name its script the way package shims do, so npm runs as Node with the `npm-cli.js`
 * installed beside that Node; an extensionless `npm` there is a shell script and never runs.
 */
export function resolveNpm(env: Pick<InstanceEnv, 'env' | 'searchPath'>, platform: NodeJS.Platform = process.platform): CliLaunch | undefined {
  if (platform !== 'win32') return resolveCommand('npm', env, platform)
  const node = resolveCommand('node', env, platform)
  if (node) {
    const cli = join(dirname(node.path), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (existsSync(cli)) return { path: cli, command: node.command, args: [...node.args, cli] }
  }
  // Volta and similar managers ship an `npm.exe` launcher instead.
  return resolveCommand('npm.exe', env, platform) ?? resolveCommand('npm.cmd', env, platform)
}

const runUserNpm: NpmRunner = async (args, options) => {
  const npm = resolveNpm(options.env)
  if (!npm) return { code: null, stdout: '', stderr: '', timedOut: false, spawnError: 'npm_not_found' }
  return runHarness(options.env, 'install', npm.command, [...npm.args, ...args], { timeoutMs: options.timeoutMs, signal: options.signal, maxBytes: 64 * 1024, cwd: options.cwd })
}
