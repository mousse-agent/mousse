import { join } from 'node:path'
import type { HarnessCaps, RuntimeFacts } from '../../../shared/harness/types'
import type { InstallOwner } from '../../../shared/harness/status'
import { cliLaunch, withUserEnv, type CliLaunch } from '../cliConfig'
import type { AcpConnection, AcpLaunchRequest } from '../acp/connection'
import { OPENCODE_CAPS, OPENCODE_LABEL, OPENCODE_PRESET } from '../acp/presets/opencode'
import { compatibilityFields } from '../compatibility'
import type { AgentInstalls, InstalledAgent, RegistrySource } from '../agents/install'
import { DIST_DIR } from '../agents/receipt'
import type { AcpRegistry } from '../agents/registry'
import { decodeInstanceConfig, type DriverContext, type DriverRuntime, type HarnessDriver, type ManagedInstall } from '../driver'
import { cliNames, resolveCommand } from '../env'
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

/** OpenCode's npm package (`npm i -g @opencode/cli`). */
export const OPENCODE_NPM_PACKAGE = '@opencode/cli'

/** The command that updates an OpenCode its owner installed, when Mousse knows one. */
export function opencodeUpdateCommand(owner: InstallOwner): string | undefined {
  switch (owner) {
    case 'standalone':
      return 'opencode upgrade'
    case 'npm':
      return `npm install -g ${OPENCODE_NPM_PACKAGE}@latest`
    case 'pnpm':
      return `pnpm add -g ${OPENCODE_NPM_PACKAGE}@latest`
    case 'bun':
      return `bun add -g ${OPENCODE_NPM_PACKAGE}@latest`
    case 'brew':
      return 'brew upgrade anomalyco/tap/opencode-v2'
    default:
      return undefined
  }
}

export interface OpencodeDriverOptions {
  /** Managed installs; without them (and `registry`) Mousse cannot install OpenCode. */
  agents?: AgentInstalls
  /** The ACP registry: which OpenCode version an install takes. */
  registry?: Pick<AcpRegistry, 'agent'>
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
    // One sign-in per computer (OpenCode's XDG folders): a second entry would share it.
    multiInstance: false,
    privateHome: false,
    canInstall: true,
    customModels: false,
    methodLabel: 'OpenCode’s own sign-in',
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

  /** The executable: the entry's own, else the managed copy, else the one on PATH. */
  const program = (): { resolved: CliLaunch; managed: boolean; root?: string } | undefined => {
    if (context.config.binaryPath) {
      const resolved = resolveCommand(context.config.binaryPath, context.env)
      return resolved ? { resolved, managed: false } : undefined
    }
    const installed = installedNow()
    if (installed && agents) {
      const launch = agents.launch(installed, context.env)
      // The receipt ends with the registry's own arguments (`acp`): the preset adds its own, once.
      const receiptArgs = installed.receipt.launch.args.filter((arg): arg is string => typeof arg === 'string').length
      const args = launch.args.slice(0, launch.args.length - receiptArgs)
      return { resolved: { path: launch.path, command: launch.command, args }, managed: true, root: installed.root }
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
      return { resolved: found.resolved, ...(found.root && agents ? { track: () => agents.track(found.root!) } : {}) }
    },
    // Only Mousse's own copy is kept from updating itself; the user's own OpenCode runs as they set it up.
    env: (env) => (program()?.managed ? withUserEnv(env, { ...OPENCODE_MANAGED_ENV }) : env),
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
        return agents.removeInstall({ instanceId: context.instanceId, source, force })
      },
      release: async () => {
        const source = ownSource()
        if (source) await agents.release(context.instanceId, source)
      }
    } : {})
  }
  return runtime
}
