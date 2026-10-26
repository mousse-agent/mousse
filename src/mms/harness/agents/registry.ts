/**
 * The ACP agent registry (https://agentclientprotocol.com/registry): fetched with hard caps,
 * cached in the installation, and decoded leniently, so one bad entry drops only itself. Every
 * value that later becomes a path, a download or a launch is validated here first.
 */
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { RESERVED_AGENT_IDS, reservedAgentMessage, type RegistryAgentView, type RegistryChecksum } from '../../../shared/harness/types'

export { RESERVED_AGENT_IDS, reservedAgentMessage }
import { atomicWriteJsonSync } from '../../data/AtomicFs'
import { HOME_VARIABLES, INHERITED_CREDENTIALS } from '../env'

export const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'
export const REGISTRY_MAX_BYTES = 1024 * 1024
export const REGISTRY_TIMEOUT_MS = 30_000
export const REGISTRY_MAX_AGENTS = 512

const AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/
/** One release: three numbers, then any pre-release or build parts (`1.2.3`, `v0.4.0-beta.1+7`). */
const RELEASE = /^v?\d+\.\d+\.\d+([-+][0-9A-Za-z][0-9A-Za-z.-]*)*$/
/** An npm package name, with or without a scope. */
const NPM_NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i
/** A Python package name. */
const PYPI_NAME = /^[a-z0-9][\w.-]*$/i
const SHA256 = /^[a-f0-9]{64}$/i

/**
 * Whether a package runner spec names one release of one package: `name@1.2.3` for npm (scoped
 * names too), `name==1.2.3` or `name@1.2.3` for Python. A tag (`latest`) or a range never passes.
 */
export function pinnedPackage(spec: string, runner: 'npx' | 'uvx'): boolean {
  const separator = runner === 'uvx' && spec.includes('==') ? '==' : '@'
  const split = spec.lastIndexOf(separator)
  if (split <= 0) return false
  const name = spec.slice(0, split)
  const version = spec.slice(split + separator.length)
  return (runner === 'npx' ? NPM_NAME : PYPI_NAME).test(name) && RELEASE.test(version)
}

/** Registry platform keys. */
export type RegistryPlatform = 'darwin-aarch64' | 'darwin-x86_64' | 'linux-aarch64' | 'linux-x86_64' | 'windows-aarch64' | 'windows-x86_64'

export interface RegistryBinaryTarget {
  archive: string
  /** Relative to the archive root, `/`-separated; never absolute or with `..`. */
  cmd: string
  sha256?: string
  args: string[]
  env: Record<string, string>
}

export interface RegistryPackage {
  package: string
  args: string[]
  env: Record<string, string>
}

export interface RegistryAgent {
  id: string
  name: string
  version: string
  description: string
  authors: string[]
  license?: string
  website?: string
  repository?: string
  distribution: {
    binary?: Partial<Record<RegistryPlatform, RegistryBinaryTarget>>
    npx?: RegistryPackage
    uvx?: RegistryPackage
  }
}

/**
 * Agents that have their own entry in Mousse (or must not be added as a generic agent): hidden
 * from search. Claude runs only through Claude Code.
 */
export const COVERED_AGENT_IDS: Readonly<Record<string, string>> = {
  'grok-build': 'grok',
  cursor: 'cursor',
  'antigravity-acp': 'antigravity',
  'claude-acp': 'claude',
  'codex-acp': 'codex'
}

/** What a registry agent installs as on one computer. */
export type ResolvedDistribution =
  | { kind: 'binary'; platform: RegistryPlatform; target: RegistryBinaryTarget; archive: ArchiveFormat | undefined }
  | { kind: 'npx'; spec: RegistryPackage; name: string; packageVersion: string }
  | { kind: 'uvx'; spec: RegistryPackage }

export type ArchiveFormat = 'zip' | 'tar.gz'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined
}

function httpsUrl(value: unknown): string | undefined {
  const text = boundedString(value, 2_048)
  if (!text) return undefined
  try {
    const url = new URL(text)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined
  } catch {
    return undefined
  }
}

/** A registry `cmd` as path segments: relative, `\` read as `/`, no `.`/`..`, drive or UNC form. */
export function commandSegments(command: string): string[] | undefined {
  const parts = command.trim().split(/[\\/]/)
  // A leading separator (`/x`, `\\server`) or a drive (`C:`) names a place outside the install.
  if (parts[0] === '' || /^[A-Za-z]:/.test(parts[0]!)) return undefined
  const segments: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..' || unsafeSegment(part)) return undefined
    segments.push(part)
  }
  return segments.length ? segments : undefined
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i

/**
 * A path segment Windows would read as something else, on every platform: `:` (an NTFS alternate
 * stream the receipt cannot see), `<>"|?*`, control characters, a trailing dot or space (dropped
 * by Windows, so two names meet), and reserved device names (`CON`, `NUL`, `COM1`…).
 */
export function unsafeSegment(segment: string): boolean {
  return /[<>:"|?*\x00-\x1f]/.test(segment) || /[. ]$/.test(segment) || WINDOWS_RESERVED.test(segment)
}

/** Names the registry may never set for an agent: the launch path, loaders, homes and credentials. */
export function droppedVariable(name: string): boolean {
  const upper = name.toUpperCase()
  if (upper === 'PATH' || upper === 'NODE_OPTIONS' || upper === 'NODE_PATH') return true
  if (upper.startsWith('LD_') || upper.startsWith('DYLD_') || upper.startsWith('ELECTRON_')) return true
  const homes = Object.values(HOME_VARIABLES).map((variable) => variable!.toUpperCase())
  const credentials = Object.values(INHERITED_CREDENTIALS).flatMap((names) => names!.map((entry) => entry.toUpperCase()))
  return homes.includes(upper) || credentials.includes(upper) || upper === 'HOME' || upper === 'USERPROFILE'
}

/** Registry variables without the ones Mousse never passes on (`droppedVariable`). */
export function cleanEnv(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const env: Record<string, string> = {}
  for (const [name, entry] of Object.entries(value).slice(0, 64)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || droppedVariable(name)) continue
    const text = boundedString(entry, 1_024)
    if (text !== undefined) env[name] = text
  }
  return env
}

function cleanArgs(value: unknown): string[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 64) return undefined
  const args = value.filter((arg): arg is string => typeof arg === 'string' && arg.length <= 1_024)
  return args.length === value.length ? args : undefined
}

function decodeBinaryTarget(value: unknown): RegistryBinaryTarget | undefined {
  if (!isRecord(value)) return undefined
  const archive = httpsUrl(value.archive)
  const cmd = boundedString(value.cmd, 1_024)
  const args = cleanArgs(value.args)
  if (!archive || !cmd || !commandSegments(cmd) || !args) return undefined
  if (value.sha256 !== undefined && (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256))) return undefined
  return { archive, cmd, ...(typeof value.sha256 === 'string' ? { sha256: value.sha256.toLowerCase() } : {}), args, env: cleanEnv(value.env) }
}

function decodePackage(value: unknown, runner: 'npx' | 'uvx'): RegistryPackage | undefined {
  if (!isRecord(value)) return undefined
  const spec = boundedString(value.package, 256)
  const args = cleanArgs(value.args)
  if (!spec || !pinnedPackage(spec, runner) || !args) return undefined
  return { package: spec, args, env: cleanEnv(value.env) }
}

const PLATFORMS: readonly RegistryPlatform[] = ['darwin-aarch64', 'darwin-x86_64', 'linux-aarch64', 'linux-x86_64', 'windows-aarch64', 'windows-x86_64']

/** One registry entry, or undefined when any field that matters is invalid. */
export function decodeAgent(value: unknown): RegistryAgent | undefined {
  if (!isRecord(value)) return undefined
  const id = boundedString(value.id, 64)
  const version = boundedString(value.version, 64)
  const name = boundedString(value.name, 160)?.trim()
  if (!id || !AGENT_ID.test(id) || !version || !VERSION.test(version) || !name) return undefined
  const distribution = isRecord(value.distribution) ? value.distribution : {}
  const binary: Partial<Record<RegistryPlatform, RegistryBinaryTarget>> = {}
  if (isRecord(distribution.binary))
    for (const platform of PLATFORMS) {
      const target = decodeBinaryTarget(distribution.binary[platform])
      if (target) binary[platform] = target
    }
  const npx = distribution.npx === undefined ? undefined : decodePackage(distribution.npx, 'npx')
  const uvx = distribution.uvx === undefined ? undefined : decodePackage(distribution.uvx, 'uvx')
  if (!Object.keys(binary).length && !npx && !uvx) return undefined
  const authors = Array.isArray(value.authors) ? value.authors.filter((author): author is string => typeof author === 'string' && author.length <= 256).slice(0, 16) : []
  const license = boundedString(value.license, 128)
  const website = httpsUrl(value.website)
  const repository = httpsUrl(value.repository)
  return {
    id,
    name,
    version,
    description: boundedString(value.description, 1_024) ?? '',
    authors,
    ...(license ? { license } : {}),
    ...(website ? { website } : {}),
    ...(repository ? { repository } : {}),
    distribution: {
      ...(Object.keys(binary).length ? { binary } : {}),
      ...(npx ? { npx } : {}),
      ...(uvx ? { uvx } : {})
    }
  }
}

/** The registry document: its valid entries (at most `REGISTRY_MAX_AGENTS`), the rest dropped. */
export function decodeRegistry(value: unknown): RegistryAgent[] {
  if (!isRecord(value) || !Array.isArray(value.agents)) throw new Error('The ACP registry is not in the expected format.')
  const agents: RegistryAgent[] = []
  const seen = new Set<string>()
  for (const entry of value.agents.slice(0, REGISTRY_MAX_AGENTS)) {
    const agent = decodeAgent(entry)
    if (!agent || seen.has(agent.id)) continue
    seen.add(agent.id)
    agents.push(agent)
  }
  return agents
}

/** This computer's registry platform keys, best first: Windows on Arm also runs x64 builds. */
const REGISTRY_OS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'darwin', linux: 'linux', win32: 'windows' }
const REGISTRY_CPU: Readonly<Record<string, string>> = { arm64: 'aarch64', x64: 'x86_64' }

export function platformKeys(platform: NodeJS.Platform = process.platform, arch: string = process.arch): RegistryPlatform[] {
  const os = REGISTRY_OS[platform]
  const cpu = REGISTRY_CPU[arch]
  if (!os || !cpu) return []
  const keys = [`${os}-${cpu}` as RegistryPlatform]
  // Windows on Arm emulates x64 programs, so an x64 build serves when there is no Arm one.
  if (os === 'windows' && cpu === 'aarch64') keys.push('windows-x86_64')
  return keys
}

export function archiveFormat(url: string): ArchiveFormat | undefined {
  const path = new URL(url).pathname.toLowerCase()
  if (path.endsWith('.zip')) return 'zip'
  if (path.endsWith('.tar.gz') || path.endsWith('.tgz')) return 'tar.gz'
  return undefined
}

/** `name@1.2.3` (scoped names too) as name and version without a leading `v`. */
export function packageSpec(spec: string): { name: string; version: string } {
  const at = spec.lastIndexOf('@')
  return { name: spec.slice(0, at), version: spec.slice(at + 1).replace(/^v/i, '') }
}

/** What Mousse installs for `agent` here: a binary when one fits, else npx, else uvx (not offered yet). */
export function resolveDistribution(agent: RegistryAgent, keys: readonly RegistryPlatform[] = platformKeys(), prefer?: 'binary' | 'npx'): ResolvedDistribution | undefined {
  const platform = keys.find((key) => agent.distribution.binary?.[key])
  const binary: ResolvedDistribution | undefined = platform
    ? { kind: 'binary', platform, target: agent.distribution.binary![platform]!, archive: archiveFormat(agent.distribution.binary![platform]!.archive) }
    : undefined
  const npm = agent.distribution.npx
  const npx: ResolvedDistribution | undefined = npm ? { kind: 'npx', spec: npm, ...(({ name, version }) => ({ name, packageVersion: version }))(packageSpec(npm.package)) } : undefined
  if (prefer === 'npx') return npx
  if (prefer === 'binary') return binary
  return binary ?? npx ?? (agent.distribution.uvx ? { kind: 'uvx', spec: agent.distribution.uvx } : undefined)
}

/** The search row of an agent for this computer. */
export function agentView(agent: RegistryAgent, keys: readonly RegistryPlatform[] = platformKeys()): RegistryAgentView | undefined {
  const resolved = resolveDistribution(agent, keys)
  if (!resolved) return undefined
  const base = {
    id: agent.id,
    name: agent.name,
    version: agent.version,
    description: agent.description,
    authors: agent.authors,
    ...(agent.license ? { license: agent.license } : {}),
    ...(agent.website ? { website: agent.website } : {}),
    ...(agent.repository ? { repository: agent.repository } : {})
  }
  // Listed, so a search for it finds why; never added.
  const reserved = RESERVED_AGENT_IDS.has(agent.id) ? { unsupported: reservedAgentMessage(agent.id) } : {}
  if (resolved.kind === 'uvx')
    return { ...base, distribution: 'uvx', checksum: 'none', package: resolved.spec.package, args: resolved.spec.args, env: resolved.spec.env, unsupported: `Python (uvx) agents are not supported yet. Add it as a Custom command running uvx ${resolved.spec.package}.` }
  if (resolved.kind === 'npx')
    // npm checks every package against the npm registry's integrity hashes.
    return { ...base, distribution: 'npx', checksum: 'registry', package: resolved.spec.package, args: resolved.spec.args, env: resolved.spec.env, ...reserved }
  const checksum: RegistryChecksum = resolved.target.sha256 ? 'registry' : 'none'
  return {
    ...base,
    distribution: 'binary',
    checksum,
    artifactUrl: resolved.target.archive,
    args: resolved.target.args,
    env: resolved.target.env,
    ...(resolved.archive ? {} : { unsupported: 'Mousse installs zip and tar.gz downloads only.' }),
    ...reserved
  }
}

/**
 * How well an agent matches a search, higher is better, or undefined when a word of the query is
 * found nowhere. Each word scores by where it is found: a whole word of the id or name, the start
 * of one, anywhere in them, or in the authors and description. The whole query naming the agent
 * exactly comes first.
 */
function matchScore(agent: RegistryAgent, query: string): number | undefined {
  const wanted = query.trim().toLowerCase()
  const words = wanted.split(/\s+/).filter(Boolean)
  if (!words.length) return 0
  const title = `${agent.id} ${agent.name}`.toLowerCase()
  const titleWords = title.split(/[^a-z0-9]+/).filter(Boolean)
  const other = `${agent.authors.join(' ')} ${agent.description}`.toLowerCase()
  let score = wanted === agent.id.toLowerCase() || wanted === agent.name.toLowerCase() ? 100 : 0
  for (const word of words) {
    if (titleWords.includes(word)) score += 4
    else if (titleWords.some((titleWord) => titleWord.startsWith(word))) score += 3
    else if (title.includes(word)) score += 2
    else if (other.includes(word)) score += 1
    else return undefined
  }
  return score
}

/** Matching agents for this computer, best first; agents with their own Mousse entry are left out. */
export function searchAgents(agents: readonly RegistryAgent[], query: string, keys: readonly RegistryPlatform[] = platformKeys()): RegistryAgentView[] {
  return agents
    .filter((agent) => !Object.prototype.hasOwnProperty.call(COVERED_AGENT_IDS, agent.id))
    .flatMap((agent) => {
      const score = matchScore(agent, query)
      const view = score === undefined ? undefined : agentView(agent, keys)
      return view && score !== undefined ? [{ score, view }] : []
    })
    .sort((a, b) => b.score - a.score || a.view.name.localeCompare(b.view.name))
    .map((entry) => entry.view)
}

/** Reads a response body up to `max` bytes; longer bodies fail. */
async function readCapped(response: Response, max: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) throw new Error('The ACP registry is larger than Mousse accepts.')
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      throw new Error('The ACP registry is larger than Mousse accepts.')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export interface RegistryOptions {
  /** `<installationHome>/agents/registry.json`. */
  cachePath: string
  url?: string
  fetch?: typeof fetch
  now?: () => number
  /** How long a fetched copy is reused before the network is asked again. */
  maxAgeMs?: number
}

/**
 * The registry, network first with the cached copy as the fallback. A fetched copy is reused for
 * a few minutes, so typing a search does not refetch it.
 */
export class AcpRegistry {
  private memory?: { agents: RegistryAgent[]; atMs: number }
  private loading?: Promise<RegistryAgent[]>
  /** The cached file as last decoded, by its modification time (snapshots ask often). */
  private disk?: { mtimeMs: number; agents: RegistryAgent[] }

  constructor(private readonly options: RegistryOptions) {}

  async agents(signal?: AbortSignal): Promise<RegistryAgent[]> {
    const now = this.options.now?.() ?? Date.now()
    if (this.memory && now - this.memory.atMs < (this.options.maxAgeMs ?? 5 * 60_000)) return this.memory.agents
    this.loading ??= this.load(signal).finally(() => {
      this.loading = undefined
    })
    return this.loading
  }

  /** An agent at its current registry version, or undefined. */
  async agent(agentId: string, signal?: AbortSignal): Promise<RegistryAgent | undefined> {
    return (await this.agents(signal)).find((agent) => agent.id === agentId)
  }

  /** The cached copy only, without the network (launch-metadata advisories). */
  cached(): RegistryAgent[] {
    if (this.memory) return this.memory.agents
    try {
      const { mtimeMs } = statSync(this.options.cachePath)
      if (this.disk?.mtimeMs !== mtimeMs) this.disk = { mtimeMs, agents: decodeRegistry(JSON.parse(readFileSync(this.options.cachePath, 'utf8'))) }
      return this.disk.agents
    } catch {
      return []
    }
  }

  async search(query: string, signal?: AbortSignal): Promise<RegistryAgentView[]> {
    return searchAgents(await this.agents(signal), query)
  }

  private async load(signal?: AbortSignal): Promise<RegistryAgent[]> {
    const fetchFile = this.options.fetch ?? fetch
    const timeout = AbortSignal.timeout(REGISTRY_TIMEOUT_MS)
    try {
      const response = await fetchFile(this.options.url ?? REGISTRY_URL, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' })
      if (!response.ok) throw new Error(`The ACP registry answered ${response.status}.`)
      const raw: unknown = JSON.parse(await readCapped(response, REGISTRY_MAX_BYTES))
      const agents = decodeRegistry(raw)
      mkdirSync(dirname(this.options.cachePath), { recursive: true })
      atomicWriteJsonSync(this.options.cachePath, raw)
      this.memory = { agents, atMs: this.options.now?.() ?? Date.now() }
      return agents
    } catch (error) {
      signal?.throwIfAborted()
      const cached = this.cached()
      if (cached.length) {
        this.memory = { agents: cached, atMs: this.options.now?.() ?? Date.now() }
        return cached
      }
      throw new Error(`Mousse could not load the ACP registry: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
