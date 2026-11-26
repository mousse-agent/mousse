import { readFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { HarnessCaps, RuntimeFacts } from '../../../shared/harness/types'
import type { InstallOwner } from '../../../shared/harness/status'
import { cliLaunch, withUserEnv, type CliLaunch } from '../cliConfig'
import type { AcpConnection, AcpLaunchRequest } from '../acp/connection'
import type { AcpLaunch } from '../acp/preset'
import { OPENCODE_CAPS, OPENCODE_LABEL, OPENCODE_PRESET } from '../acp/presets/opencode'
import { compatibilityFields } from '../compatibility'
import type { AgentInstalls, InstalledAgent, RegistrySource } from '../agents/install'
import { DIST_DIR } from '../agents/receipt'
import type { AcpRegistry } from '../agents/registry'
import { decodeInstanceConfig, type DriverContext, type DriverRuntime, type HarnessDriver, type ManagedInstall } from '../driver'
import { cliNames, resolveCommand } from '../env'
import { LATEST_TTL_MS } from '../latest'
import { ptyAvailable, type PtySpawn } from '../pty'
import { createAcpRuntime } from './acp'

/**
 * OpenCode over ACP (`opencode acp`, the OpenCode preset of the ACP core). It runs an executable
 * the user sets, else the copy Mousse installed from the ACP registry's `opencode` entry, else the
 * `opencode` on PATH (OpenCode's installer folders included, `opencodeStandalonePaths`).
 *
 * OpenCode keeps its sign-ins in this computer's XDG folders (`~/.local/share/opencode/auth.json`)
 * and has no home variable, so every entry shares them: there is one entry, on the user's own
 * OpenCode setup, and a sign-out in Mousse never signs OpenCode itself out.
 */

/** The ACP registry entry a managed copy is installed from, and its folder under `agents/`. */
export const OPENCODE_AGENT_ID = 'opencode'

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

/**
 * A one-shot's variables (a chat title, a pull request draft, a commit message): OpenCode's inline config
 * (`OPENCODE_CONFIG_CONTENT`, merged over the user's config files) with every permission denied, so the request
 * runs no tool, MCP tools included. An inline config the user already sets is kept, with its permissions replaced.
 */
export function opencodeOneShotEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  let inline: Record<string, unknown> = {}
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'OPENCODE_CONFIG_CONTENT')
  try {
    const parsed = key ? JSON.parse(env[key] ?? '') as unknown : undefined
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) inline = parsed as Record<string, unknown>
  } catch {
    // Not JSON: OpenCode could not read it either.
  }
  const { permissions: _permissions, ...rest } = inline
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...rest, permission: { '*': 'deny' } }) }
}

export interface OpencodeDriverOptions {
  /** Managed installs; without them (and `registry`) Mousse cannot install OpenCode. */
  agents?: AgentInstalls
  /** The ACP registry: which OpenCode version an install takes, and what a managed copy updates to. */
  registry?: Pick<AcpRegistry, 'agent' | 'cached'>
  /** Test seam: the clock of the registry's update check. */
  now?: () => number
  /** Test seam: opens agent connections instead of starting OpenCode. */
  connect?: (context: DriverContext, request: AcpLaunchRequest) => AcpConnection
  /** Test seam: the pseudo-terminal for `terminal` sign-in methods. */
  pty?: { available: () => boolean; spawn?: PtySpawn }
}

export function opencodeDriver(options: OpencodeDriverOptions = {}): HarnessDriver {
  return {
    kind: 'opencode',
    label: OPENCODE_LABEL,
    binaryNames: cliNames('opencode'),
    ...compatibilityFields('opencode'),
    latestVersion: { kind: 'npm', package: OPENCODE_NPM_PACKAGE },
    // npm and Homebrew each have two OpenCodes: a copy follows the one it came from.
    packageOf: opencodePackageOf,
    // One sign-in per computer (OpenCode's XDG folders): a second entry would share it.
    multiInstance: false,
    privateHome: false,
    canInstall: true,
    customModels: false,
    methodLabel: 'OpenCode’s own sign-in',
    // OpenCode's sign-in is this computer's, whichever executable runs: never Mousse's own.
    sharedSignIn: true,
    // ACP updates do not name the MCP server: the bearer is kept only after a turn whose tool calls all completed.
    mcpTurnBinding: 'drained_turn',
    userMcp: 'native',
    // The agent's own `session/request_permission` flow decides (when it asks at all).
    relay: { approvals: 'runtime' },
    decodeConfig: (raw) => decodeInstanceConfig(raw, { privateHome: false }),
    versionArgs: () => ['--version'],
    caps: (_config, _version, facts?: RuntimeFacts): HarnessCaps => {
      const caps = { ...OPENCODE_CAPS }
      return facts && OPENCODE_PRESET.capsFromFacts ? OPENCODE_PRESET.capsFromFacts(caps, facts) : caps
    },
    updateCommand: opencodeUpdateCommand,
    // Chat titles, pull request drafts and commit messages: one prompt with every tool denied (`opencodeOneShotEnv`).
    oneShot: true,
    create: (context) => createOpencodeRuntime(context, options)
  }
}

function createOpencodeRuntime(context: DriverContext, options: OpencodeDriverOptions): DriverRuntime {
  const label = context.config.displayName ?? OPENCODE_LABEL
  const { agents, registry } = options
  const ptyRuns = () => (options.pty ? options.pty.available() : ptyAvailable())

  /** The source of the version this entry installed (it may predate the registry's current one). */
  const ownSource = (): RegistrySource | undefined => {
    const ref = agents?.reference(OPENCODE_AGENT_ID, context.instanceId)
    return ref && agents ? agents.packageSource({ agentId: OPENCODE_AGENT_ID, version: ref.version }) : undefined
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
   * The executable: the entry's own, else the managed copy, else the one on PATH. The managed copy
   * starts as its install record says (the registry's `acp` and variables), with the entry's own
   * arguments and variables after; the others start as the preset says.
   */
  const program = (): { resolved: CliLaunch; launch?: AcpLaunch; managed: boolean; root?: string } | undefined => {
    if (context.config.binaryPath) {
      const resolved = resolveCommand(context.config.binaryPath, context.env)
      return resolved ? { resolved, managed: false } : undefined
    }
    const installed = installedNow()
    if (installed && agents) {
      const agent = agents.launch(installed, context.env)
      return {
        resolved: { path: agent.path, command: agent.command, args: agent.args },
        launch: { command: agent.command, args: [...(context.config.args ?? [])], env: { ...agent.env, ...(context.config.env ?? {}) } },
        managed: true,
        root: installed.root
      }
    }
    const found = context.findBinary()
    const resolved = found ? cliLaunch(found) : undefined
    return resolved ? { resolved, managed: false } : undefined
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

  const base = createAcpRuntime(context, OPENCODE_PRESET, {
    ...(options.connect ? { connect: options.connect } : {}),
    ...(options.pty ? { pty: options.pty } : {})
  }, ptyRuns, {
    driver: 'opencode',
    program: () => {
      const found = program()
      if (!found) return undefined
      return { resolved: found.resolved, ...(found.launch ? { launch: found.launch } : {}), ...(found.root && agents ? { track: () => agents.track(found.root!) } : {}) }
    },
    // Only Mousse's own copy is kept from updating itself; the user's own OpenCode runs as they set it up.
    // A one-shot's process also denies every tool (`opencodeOneShotEnv`).
    env: (env, purpose) => {
      const own = program()?.managed ? withUserEnv(env, { ...OPENCODE_MANAGED_ENV }) : env
      return purpose === 'one_shot' ? withUserEnv(own, opencodeOneShotEnv(own)) : own
    },
    checkInstall: ({ signal, reuse }) => checkManaged(signal, reuse),
    // OpenCode's sign-in is this computer's, shared with the user's terminal: Mousse never signs it out.
    agentLogout: () => false
  })

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
    ...base,
    // A broken managed copy stops only itself: `checkManaged` reads the copy only while it is what runs,
    // so an entry with its own executable never finds it broken.
    configured: () => !managed()?.broken && base.configured(),
    llmProvider: () => (runtime.configured() ? { id: context.instanceId, label, models: runtime.models() } : undefined),
    ...(agents && registry ? {
      install: async (onProgress) => {
        onProgress({ message: `Checking the ACP registry for ${label}…` })
        const agent = await registry.agent(OPENCODE_AGENT_ID)
        if (!agent) throw new Error(`The ACP registry no longer lists ${label}.`)
        await agents.install({
          instanceId: context.instanceId,
          source: agents.packageSource({ agentId: OPENCODE_AGENT_ID, version: agent.version }),
          env: context.env,
          label,
          onProgress
        })
        filesChanged = undefined
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
          base.closeSessions()
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
