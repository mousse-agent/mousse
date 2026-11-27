import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { harnessAppError, type HarnessCaps } from '../../../shared/harness/types'
import type { InstallOwner } from '../../../shared/harness/status'
import type { LlmModelOption } from '../../../shared/settings'
import { atomicWriteJsonSync } from '../../data/AtomicFs'
import type { ProviderCapabilities } from '../adapter'
import { cliLaunch } from '../cliConfig'
import { compatibilityFields } from '../compatibility'
import type { AgentInstalls, InstalledAgent, RegistrySource } from '../agents/install'
import { DIST_DIR } from '../agents/receipt'
import type { AcpRegistry } from '../agents/registry'
import { decodeInstanceConfig, type AuthReading, type DriverContext, type DriverRuntime, type HarnessDriver, type ManagedInstall } from '../driver'
import { cliNames, resolveCommand } from '../env'
import { LATEST_TTL_MS } from '../latest'
import { OpencodeServer, type OpencodeLaunch, type StartedServer } from '../opencode/server'
import { OpencodeSessions, type SavedOpencodeSession } from '../opencode/sessions'
import { AcpAdapter, type AcpTurnClient } from './acp/adapter'
import { legacyOneShotRoute } from '../oneShot/routes'

/**
 * OpenCode on its own server API (`opencode serve`, `../opencode/`). It runs an executable the user sets, else the copy
 * Mousse installed from the ACP registry's `opencode` entry, else the `opencode` on PATH (OpenCode's installer folders
 * included, `opencodeStandalonePaths`). One server per entry starts on first use and closes after idling.
 *
 * OpenCode keeps its sign-ins in this computer's own data folder and has no home variable, so every entry shares them:
 * there is one entry, on the user's own OpenCode setup, and a sign-out in Mousse never signs OpenCode itself out.
 */

export const OPENCODE_LABEL = 'OpenCode'

/** The ACP registry entry a managed copy is installed from, and its folder under `agents/`. */
export const OPENCODE_AGENT_ID = 'opencode'

/** The ACP registry's ids of OpenCode: its own and the legacy alias of the same release. */
const OPENCODE_REGISTRY_IDS: ReadonlySet<string> = new Set([OPENCODE_AGENT_ID, 'opencode-v2'])

/** Set on every process of a managed copy: OpenCode must not replace files Mousse checks against its receipt. */
export const OPENCODE_MANAGED_ENV: Readonly<Record<string, string>> = Object.freeze({ OPENCODE_DISABLE_AUTOUPDATE: '1' })

/** OpenCode's npm package since 2.0 (`npm i -g @opencode/cli`). */
export const OPENCODE_NPM_PACKAGE = '@opencode/cli'
/** OpenCode's earlier npm package, still published as the 1.x line: its copies update within it. */
export const OPENCODE_LEGACY_NPM_PACKAGE = 'opencode-ai'

/**
 * OpenCode's Homebrew formulae: `opencode` in homebrew-core (2.x), and in OpenCode's tap
 * `anomalyco/tap/opencode` (the 1.x line) and `anomalyco/tap/opencode-v2` (2.x).
 */
const BREW_FORMULAE: ReadonlySet<string> = new Set(['opencode', 'opencode-v2'])
const OPENCODE_TAP = 'anomalyco/tap'

/**
 * Each package's folder in a `/`-separated, lower-case path: the package itself, or one of its
 * per-platform builds (`@opencode/cli-linux-x64`, `opencode-darwin-arm64`) its launcher runs.
 */
const PACKAGE_FOLDERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\/node_modules\/@opencode\/cli(?:-[a-z0-9-]+)?\//, OPENCODE_NPM_PACKAGE],
  [/\/node_modules\/(?:opencode-ai|opencode-(?:linux|darwin|windows)(?:-[a-z0-9-]+)?)\//, OPENCODE_LEGACY_NPM_PACKAGE]
]

/** The one OpenCode package a path or a launcher script names; undefined for none, or both. */
function packageNamedIn(text: string): string | undefined {
  const normalized = text.replace(/\\/g, '/').toLowerCase()
  const named = PACKAGE_FOLDERS.filter(([folder]) => folder.test(normalized))
  return named.length === 1 ? named[0]![1] : undefined
}

/** A launcher script's text; a file larger than a script (the executable itself) is not read. */
function readLauncher(path: string): string | undefined {
  try {
    if (statSync(path).size > 64 * 1024) return undefined
    const bytes = readFileSync(path)
    // Bun's `.bunx` names its target in UTF-16.
    return bytes.includes(0) ? bytes.toString('utf16le') : bytes.toString('utf8')
  } catch {
    return undefined
  }
}

function realPath(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/**
 * Which OpenCode package an npm, pnpm or bun copy came from. The executable's real path names it
 * (`lib/node_modules/opencode-ai/bin/opencode`, bun's `install/global/node_modules/...`); where PATH
 * holds a launcher instead (npm's `opencode.cmd` on Windows, pnpm's scripts, bun's `opencode.bunx`
 * beside its `.exe` on Windows), the launcher's text names it. Undefined when nothing does.
 */
export function opencodeNpmPackageOf(
  path: string,
  io: { realpath?: (path: string) => string | undefined; read?: (path: string) => string | undefined } = {}
): string | undefined {
  const target = (io.realpath ?? realPath)(path)
  for (const candidate of target ? [target, path] : [path]) {
    const named = packageNamedIn(candidate)
    if (named) return named
  }
  const read = io.read ?? readLauncher
  const launchers = /\.exe$/i.test(path) ? [path.replace(/\.exe$/i, '.bunx')] : [path]
  for (const launcher of launchers) {
    const text = read(launcher)
    const named = text ? packageNamedIn(text) : undefined
    if (named) return named
  }
  return undefined
}

/**
 * Which Homebrew formula a Homebrew copy came from, named as `brew info` and `brew upgrade` take it.
 * The keg it links to names the formula (`Cellar/opencode-v2/2.4.1/bin/opencode`); its install
 * record names the tap, since homebrew-core and OpenCode's tap both have an `opencode` (2.x and
 * 1.x). Undefined when the formula is not OpenCode's, or which `opencode` it is cannot be read.
 */
export function opencodeBrewFormulaOf(
  path: string,
  io: { realpath?: (path: string) => string | undefined; read?: (path: string) => string | undefined } = {}
): string | undefined {
  const target = ((io.realpath ?? realPath)(path) ?? path).replace(/\\/g, '/')
  const keg = /^(.*\/cellar\/([^/]+)\/[^/]+)\//i.exec(target)
  const name = keg?.[2]?.toLowerCase()
  if (!keg || !name || !BREW_FORMULAE.has(name)) return undefined
  let tap: unknown
  try {
    tap = (JSON.parse((io.read ?? readLauncher)(`${keg[1]}/INSTALL_RECEIPT.json`) ?? 'null') as { source?: { tap?: unknown } } | null)?.source?.tap
  } catch {
    tap = undefined
  }
  if (typeof tap === 'string' && tap) return tap === 'homebrew/core' ? name : `${tap}/${name}`
  // Only OpenCode's tap has `opencode-v2`.
  return name === 'opencode-v2' ? `${OPENCODE_TAP}/${name}` : undefined
}

/** The npm package or Homebrew formula an OpenCode copy came from (`HarnessDriver.packageOf`). */
export function opencodePackageOf(path: string, owner: InstallOwner): string | undefined {
  return owner === 'brew' ? opencodeBrewFormulaOf(path) : opencodeNpmPackageOf(path)
}

/**
 * The command that updates an OpenCode its owner installed, when Mousse knows one. A package
 * manager's copy updates within the package or formula it came from (`pkg`): none for an npm, pnpm
 * or bun copy when that is unknown; OpenCode's own upgrade for a Homebrew one.
 */
export function opencodeUpdateCommand(owner: InstallOwner, pkg?: string): string | undefined {
  switch (owner) {
    case 'standalone':
      return 'opencode upgrade'
    case 'brew':
      // OpenCode's own upgrade finds how it was installed, Homebrew included.
      return pkg ? `brew upgrade ${pkg}` : 'opencode upgrade'
    case 'npm':
      return pkg ? `npm install -g ${pkg}@latest` : undefined
    case 'pnpm':
      return pkg ? `pnpm add -g ${pkg}@latest` : undefined
    case 'bun':
      return pkg ? `bun add -g ${pkg}@latest` : undefined
    default:
      return undefined
  }
}

export interface OpencodeDriverOptions {
  /** Managed installs; without them (and `registry`) Mousse cannot install OpenCode. */
  agents?: AgentInstalls
  /** The ACP registry: which OpenCode version an install takes, and what a managed copy updates to. */
  registry?: Pick<AcpRegistry, 'agent' | 'cached'>
  /** Test seam: the clock of the registry's update check. */
  now?: () => number
  /** Test seam: starts a server instead of spawning `opencode serve`. */
  startServer?: (launch: OpencodeLaunch, signal: AbortSignal) => Promise<StartedServer>
  /** Test seam: how long an unused server stays up. */
  serverIdleMs?: number
  /** Test seam: how long a stop waits for OpenCode to confirm. */
  interruptWaitMs?: number
}

/**
 * OpenCode's turns run on its own server API, where each session carries the permission rules of the thread's mode and
 * every ask reaches Mousse before the tool runs (`opencode/rules.ts`): Ask and Auto-accept edits hold, and so do the
 * unattended uses (delegation, workflows, schedules). Steers wait for the turn to end.
 */
export const OPENCODE_CAPS: HarnessCaps = Object.freeze({
  steer: 'queue_only',
  steerBoundary: 'none',
  steerSettleMs: null,
  interrupt: true,
  rollback: 'none',
  fork: 'portable',
  events: 'rich',
  containment: 'weak',
  historyInjection: 'prompt',
  mcp: true,
  childPolicy: 'isolated_only',
  contextUsage: 'none',
  toolControl: 'approval_only',
  autoPermissionMode: false,
  budgets: 'unsupported',
  spendLimits: 'unsupported'
})

const OPENCODE_CAPABILITIES: ProviderCapabilities = Object.freeze({
  steer: OPENCODE_CAPS.steer,
  steerBoundary: OPENCODE_CAPS.steerBoundary,
  steerSettleMs: OPENCODE_CAPS.steerSettleMs,
  interrupt: OPENCODE_CAPS.interrupt,
  rollback: OPENCODE_CAPS.rollback,
  fork: OPENCODE_CAPS.fork,
  events: OPENCODE_CAPS.events,
  containment: OPENCODE_CAPS.containment,
  historyInjection: OPENCODE_CAPS.historyInjection,
  mcp: OPENCODE_CAPS.mcp,
  childPolicy: OPENCODE_CAPS.childPolicy
})

export function opencodeDriver(options: OpencodeDriverOptions = {}): HarnessDriver {
  return {
    kind: 'opencode',
    label: OPENCODE_LABEL,
    binaryNames: cliNames('opencode'),
    ...compatibilityFields('opencode'),
    latestVersion: { kind: 'npm', package: OPENCODE_NPM_PACKAGE },
    // npm and Homebrew each have two OpenCodes: a copy follows the one it came from.
    packageOf: opencodePackageOf,
    // One sign-in per computer (OpenCode's own data folder): a second entry would share it.
    multiInstance: false,
    privateHome: false,
    canInstall: true,
    customModels: false,
    // Chat titles, branch names, pull request drafts and commit messages: a session that denies every tool.
    // Until its own slice, on its own one-shot code (`DriverRuntime.oneShot`), admitted with no facts claimed.
    oneShotRoute: legacyOneShotRoute('opencode'),
    methodLabel: 'OpenCode’s own sign-in',
    // OpenCode's sign-in is this computer's, whichever executable runs: never Mousse's own.
    sharedSignIn: true,
    // OpenCode's events do not name the MCP server a call went to: the bearer is kept only after a turn whose tool
    // calls all completed.
    mcpTurnBinding: 'drained_turn',
    userMcp: 'native',
    // OpenCode asks about the relay's tools through its own permission flow, which Mousse answers.
    relay: { approvals: 'runtime' },
    decodeConfig: (raw) => {
      const config = decodeInstanceConfig(raw, { privateHome: false })
      // Kept for an entry moved from the ACP list: its managed copy is found under the id it was installed with.
      if (typeof raw?.registryAgentId === 'string' && OPENCODE_REGISTRY_IDS.has(raw.registryAgentId)) config.registryAgentId = raw.registryAgentId
      return config
    },
    versionArgs: () => ['--version'],
    caps: () => ({ ...OPENCODE_CAPS }),
    updateCommand: opencodeUpdateCommand,
    create: (context) => createOpencodeRuntime(context, options)
  }
}

/** What the runtime keeps for an entry (`<stateDir>/opencode.json`). */
interface OpencodeState {
  sessions?: Record<string, SavedOpencodeSession>
  models?: LlmModelOption[]
  modelsRefreshedAt?: string
  /** What the last check of OpenCode's providers found. */
  connected?: { providers: string[]; checkedAt: string }
  /** The ACP state of this entry (`acp.json`) was read in once: its saved sessions are OpenCode sessions. */
  importedAcp?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The sessions an entry saved while it ran OpenCode over ACP (`acp.json`): OpenCode's ACP session ids are its own
 * session ids, and the history fingerprint is the same, so a thread resumes its session on the server.
 */
export function sessionsFromAcpState(raw: unknown): Record<string, SavedOpencodeSession> {
  const sessions = isRecord(raw) && isRecord(raw.sessions) ? raw.sessions : {}
  const out: Record<string, SavedOpencodeSession> = {}
  for (const [threadId, value] of Object.entries(sessions)) {
    if (!isRecord(value) || typeof value.sessionId !== 'string' || typeof value.cwd !== 'string') continue
    out[threadId] = {
      sessionId: value.sessionId,
      cwd: value.cwd,
      ...(typeof value.historyKey === 'string' ? { historyKey: value.historyKey } : {}),
      ...(typeof value.instanceId === 'string' ? { instanceId: value.instanceId } : {}),
      ...(typeof value.instructionsHash === 'string' ? { instructionsHash: value.instructionsHash } : {})
    }
  }
  return out
}

function createOpencodeRuntime(context: DriverContext, options: OpencodeDriverOptions): DriverRuntime {
  const label = context.config.displayName ?? OPENCODE_LABEL
  const { agents, registry } = options
  const statePath = join(context.stateDir, 'opencode.json')
  let state: OpencodeState = {}
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as unknown
    if (isRecord(parsed)) state = parsed as OpencodeState
  } catch {
    // No state yet.
  }
  const save = () => {
    mkdirSync(context.stateDir, { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(statePath, state, { mode: 0o600 })
  }
  if (!state.importedAcp) {
    try {
      const acp = JSON.parse(readFileSync(join(context.stateDir, 'acp.json'), 'utf8')) as unknown
      state.sessions = { ...sessionsFromAcpState(acp), ...(state.sessions ?? {}) }
      state.importedAcp = true
      save()
    } catch {
      // Nothing saved over ACP.
    }
  }

  /**
   * The registry id this entry's managed copy was installed under: `opencode`, or the alias an entry moved from the ACP
   * list was installed with, until it installs again.
   */
  const registryId = (): string => {
    if (agents?.reference(OPENCODE_AGENT_ID, context.instanceId)) return OPENCODE_AGENT_ID
    const alias = context.config.registryAgentId
    return alias && agents?.reference(alias, context.instanceId) ? alias : OPENCODE_AGENT_ID
  }
  /** The source of the version this entry installed (it may predate the registry's current one). */
  const ownSource = (): RegistrySource | undefined => {
    const agentId = registryId()
    const ref = agents?.reference(agentId, context.instanceId)
    return ref && agents ? agents.packageSource({ agentId, version: ref.version }) : undefined
  }
  /** The managed copy this entry installed, when it is on disk. Another entry's copy is never picked up. */
  const installedNow = (): InstalledAgent | undefined => {
    const source = ownSource()
    return source && agents ? agents.installed(source) : undefined
  }
  let verified: { hash: string; atMs: number } | undefined
  let filesChanged: string | undefined
  /** When the registry was last asked for a managed copy's newest version. */
  let registryCheckedAt: number | undefined

  /**
   * The executable: the entry's own, else the managed copy, else the one on PATH. A managed copy starts as its install
   * record says, without the record's own arguments (`acp`): the server is `serve`.
   */
  const program = (): { command: string; args: string[]; path: string; env: Record<string, string>; managed: boolean; root?: string } | undefined => {
    if (context.config.binaryPath) {
      const resolved = resolveCommand(context.config.binaryPath, context.env)
      return resolved ? { command: resolved.command, args: resolved.args, path: resolved.path, env: {}, managed: false } : undefined
    }
    const installed = installedNow()
    if (installed && agents) {
      const agent = agents.launch(installed, context.env)
      const own = installed.receipt.launch.args.length
      const args = own && agent.args.length >= own ? agent.args.slice(0, agent.args.length - own) : agent.args
      return { command: agent.command, args, path: agent.path, env: { ...agent.env }, managed: true, root: installed.root }
    }
    const found = context.findBinary()
    const resolved = found ? cliLaunch(found) : undefined
    return resolved ? { command: resolved.command, args: resolved.args, path: resolved.path, env: {}, managed: false } : undefined
  }

  const checkManaged = async (signal?: AbortSignal, reuse = false): Promise<void> => {
    const installed = program()?.managed ? installedNow() : undefined
    if (!installed || !agents) return
    if (reuse && verified?.hash === installed.hash && Date.now() - verified.atMs < 5_000 && !filesChanged) return
    const changed = await agents.changed(installed, undefined, signal)
    if (changed) {
      if (filesChanged !== changed) {
        filesChanged = changed
        context.changed()
      }
      throw new Error(`Installed files changed since install (${changed}). Reinstall ${label} in Settings → Providers.`)
    }
    filesChanged = undefined
    verified = { hash: installed.hash, atMs: Date.now() }
  }

  const serverDir = join(context.stateDir, 'server')
  const server = new OpencodeServer({
    label,
    env: () => context.env,
    launch: () => {
      const found = program()
      if (!found) throw harnessAppError({ code: 'not_installed', message: `${label} is not installed. Install it in Settings → Providers, or set its executable.` })
      if (found.managed && (!verified || Date.now() - verified.atMs > 60_000)) throw new Error(`Mousse did not check the files of ${label} before starting it.`)
      mkdirSync(serverDir, { recursive: true, mode: 0o700 })
      return {
        command: found.command,
        args: [...found.args, ...(context.config.args ?? [])],
        // Only Mousse's own copy is kept from updating itself; the user's own OpenCode runs as they set it up.
        env: { ...found.env, ...(context.config.env ?? {}), ...(found.managed ? OPENCODE_MANAGED_ENV : {}) },
        cwd: serverDir,
        ...(found.root && agents ? { track: () => agents.track(found.root!) } : {})
      }
    },
    ...(options.startServer ? { start: options.startServer } : {}),
    ...(options.serverIdleMs !== undefined ? { idleMs: options.serverIdleMs } : {}),
    onEvent: (event) => sessions.dispatch(event),
    onExit: () => sessions.serverEnded()
  })

  /** The server's client, after the managed copy's files were checked. */
  const started = async (signal?: AbortSignal) => {
    if (!server.running()) await checkManaged(signal, true)
    return server.client(signal)
  }

  const sessions: OpencodeSessions = new OpencodeSessions({
    label,
    defaultInstanceId: context.instanceId,
    server: { running: () => server.running(), hold: () => server.hold(), client: (signal?: AbortSignal) => started(signal) },
    ...(options.interruptWaitMs !== undefined ? { interruptWaitMs: options.interruptWaitMs } : {}),
    scratch: () => {
      const path = join(context.stateDir, 'one-shot', randomUUID())
      mkdirSync(path, { recursive: true, mode: 0o700 })
      // A server that held the folder a moment longer leaves an empty one behind: harmless.
      return { path, remove: () => { try { rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* kept */ } } }
    },
    store: {
      saved: (threadId) => state.sessions?.[threadId],
      setSaved: (threadId, saved) => {
        if (saved) state.sessions = { ...state.sessions, [threadId]: saved }
        else if (state.sessions) {
          const { [threadId]: _dropped, ...rest } = state.sessions
          state.sessions = rest
        }
        save()
      },
      models: () => state.models ?? [],
      setModels: (models) => {
        state.models = models
        state.modelsRefreshedAt = new Date().toISOString()
        save()
      }
    }
  })

  /** Which of OpenCode's providers have a connection (a sign-in or a key), read from the server. */
  const readConnections = async (signal?: AbortSignal): Promise<string[]> => {
    const client = await started(signal)
    const data = await client.data('GET', '/api/integration', { signal: signal ?? AbortSignal.timeout(15_000) })
    const providers = (Array.isArray(data) ? data : []).filter(isRecord)
      .filter((integration) => Array.isArray(integration.connections) && integration.connections.length > 0)
      .map((integration) => String(integration.id ?? integration.name ?? ''))
      .filter(Boolean)
    state.connected = { providers, checkedAt: new Date().toISOString() }
    save()
    return providers
  }

  const reading = (): AuthReading => {
    if (context.signedOut()) return { state: 'signed_out', methodLabel: 'OpenCode’s own sign-in', message: `Signed out of ${label} in Mousse.`, signInCommand: 'opencode auth login', canSignIn: true }
    if (!state.connected) return { state: 'unknown', methodLabel: 'OpenCode’s own sign-in', message: 'Check again to see which providers OpenCode can use.', signInCommand: 'opencode auth login' }
    if (!state.connected.providers.length)
      return { state: 'not_required', methodLabel: 'OpenCode’s free models', message: 'Only OpenCode’s free models. Add providers with `opencode auth login`.', signInCommand: 'opencode auth login' }
    return { state: 'signed_in', methodLabel: state.connected.providers.slice(0, 3).join(' · ') }
  }

  const standaloneWorkspace = (threadId: string): string => {
    const directory = join(context.stateDir, 'workspaces', createHash('sha256').update(threadId).digest('hex'))
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    return directory
  }

  const client: AcpTurnClient = {
    chat: (input) => sessions.chat(input),
    commitConversation: (threadId, history) => sessions.commitConversation(threadId, history),
    commitInterrupted: (threadId, history) => sessions.commitInterrupted(threadId, history),
    standaloneWorkspace,
    configured: () => runtime.configured(),
    interrupt: (sessionId) => sessions.interrupt(sessionId)
  }
  const adapter = new AcpAdapter(() => client, { driver: 'opencode', label, capabilities: OPENCODE_CAPABILITIES })

  const managed = (): ManagedInstall | undefined => {
    const installed = installedNow()
    if (!installed || !agents) return undefined
    const advisory = agents.advisory(installed)
    return {
      path: join(installed.root, DIST_DIR, ...installed.receipt.launch.cmd.split('/')),
      version: installed.receipt.version,
      bytes: installed.receipt.bytes,
      checksum: installed.receipt.checksum,
      receiptHash: installed.hash,
      ...(filesChanged ? { broken: filesChanged } : {}),
      ...(advisory ? { advisory } : {})
    }
  }

  const runtime: DriverRuntime = {
    adapter,
    oneShot: async (spec, signal) => {
      if (context.signedOut()) throw harnessAppError({ code: 'signed_out', message: `Sign in to ${label} in Settings → Providers.` })
      return { text: await sessions.oneShot({ model: spec.model, system: spec.system, prompt: spec.prompt, signal, onActivity: () => spec.onActivity() }) }
    },
    // A broken managed copy stops only itself.
    configured: () => !managed()?.broken && Boolean(program()),
    llmProvider: () => (runtime.configured() ? { id: context.instanceId, label, models: runtime.models() } : undefined),
    models: () => state.models ?? [],
    modelsRefreshedAt: () => (state.models?.length ? state.modelsRefreshedAt : undefined),
    refreshModels: async (cwd) => {
      await sessions.refreshModels(await started(), cwd)
      context.changed()
    },
    // Recheck asks the server which providers are connected; the periodic checks read what was found.
    auth: async ({ force, signal }) => {
      if (force && !context.signedOut() && program()) await readConnections(signal).catch(() => undefined)
      return reading()
    },
    signIn: async (session) => {
      try {
        await readConnections(session.abort.signal)
        return { success: true, sessionId: session.sessionId }
      } catch (error) {
        return { success: false, sessionId: session.sessionId, error: session.abort.signal.aborted ? 'Login cancelled' : error instanceof Error ? error.message : String(error) }
      }
    },
    // OpenCode's sign-in is this computer's, shared with the user's terminal: Mousse never signs it out.
    // The gateway keeps the flag (`signedOutInMousse`); the server ends so nothing runs on.
    signOut: async () => {
      server.stop()
    },
    handshake: async (signal) => {
      await readConnections(signal)
      await sessions.refreshModels(await started(signal))
    },
    launchChanged: () => server.stop(),
    credentialsChanged: async () => server.stop(),
    forgetConversation: (threadId) => {
      sessions.forgetConversation(threadId)
      void sessions.detachMcp(threadId).catch(() => undefined)
    },
    terminate: (ref) => {
      void sessions.interrupt(ref.sessionId).catch(() => undefined)
    },
    stop: () => server.stopped(),
    ...(agents && registry ? {
      install: async (onProgress) => {
        onProgress({ message: `Checking the ACP registry for ${label}…` })
        const agent = await registry.agent(OPENCODE_AGENT_ID)
        if (!agent) throw new Error(`The ACP registry no longer lists ${label}.`)
        // A copy installed under the registry's alias is let go once the entry has its own.
        const aliased = registryId() !== OPENCODE_AGENT_ID ? ownSource() : undefined
        await agents.install({
          instanceId: context.instanceId,
          source: agents.packageSource({ agentId: OPENCODE_AGENT_ID, version: agent.version }),
          env: context.env,
          label,
          onProgress
        })
        if (aliased) await agents.release(context.instanceId, aliased).catch(() => undefined)
        filesChanged = undefined
        server.stop()
      },
      managedLatestVersion: () => registry.cached().find((agent) => agent.id === OPENCODE_AGENT_ID)?.version,
      refreshManagedLatest: async () => {
        // Asked at most once per `LATEST_TTL_MS`, like the package registries; a failure waits as long.
        const now = options.now?.() ?? Date.now()
        if (registryCheckedAt !== undefined && now - registryCheckedAt < LATEST_TTL_MS) return false
        registryCheckedAt = now
        const before = registry.cached().find((agent) => agent.id === OPENCODE_AGENT_ID)?.version
        const after = (await registry.agent(OPENCODE_AGENT_ID).catch(() => undefined))?.version
        return Boolean(after) && after !== before
      },
      cancelInstall: () => agents.cancel(context.instanceId),
      installState: () => ({ installing: agents.installing(context.instanceId) }),
      managed,
      verifyInstall: async (signal) => {
        try {
          await checkManaged(signal)
        } catch {
          // Shown through `managed().broken`.
        }
      },
      removeInstall: async ({ force }) => {
        const source = ownSource()
        if (!source) return { removed: true, bytes: 0 }
        const result = await agents.removeInstall({ instanceId: context.instanceId, source, force })
        if (result.removed) {
          filesChanged = undefined
          verified = undefined
          // Nothing keeps running from the deleted files; the next chat starts whatever is found now.
          server.stop()
        }
        return result
      },
      release: async () => {
        const source = ownSource()
        if (source) await agents.release(context.instanceId, source)
      }
    } : {})
  }
  return runtime
}
