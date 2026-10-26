import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { InstallOwner } from '../../../shared/harness/status'
import type { ProviderLoginResult } from '../../../shared/providerAuth'
import type { LoginSession } from '../../providers/LoginSession'
import { cliLaunch, withUserEnv, type CliLaunch } from '../../providers/cliConfig'
import type { AcpConnection, AcpLaunchRequest } from '../acp/connection'
import { GROK_CAPS, GROK_LABEL, GROK_PRESET, GROK_TESTED_VERSION } from '../acp/presets/grok'
import type { AgentInstalls, PackageBinarySpec } from '../agents/install'
import { DIST_DIR } from '../agents/receipt'
import { compareVersions, decodeInstanceConfig, type AuthReading, type DriverContext, type DriverRuntime, type HarnessDriver, type ManagedInstall } from '../driver'
import { cliNames, resolveCommand } from '../env'
import { grokCredential, grokHome, type GrokCredential } from '../grok/credential'
import { GROK_API_KEY_VARIABLE } from '../grok/variables'
import { ptyAvailable, runInPty, signInPrompts, type PtySpawn } from '../pty'
import { InstanceVault } from '../vault'
import { createAcpRuntime } from './acp'

/**
 * xAI's Grok CLI over ACP (the Grok preset of the ACP core). It runs the `grok` on PATH (the
 * official installer's `~/.grok/bin` included), an executable the user sets, or a copy Mousse
 * installs from xAI's npm package. Its sign-in is the home's `auth.json` (`grok login`, run by
 * Mousse in a terminal) or an xAI API key Mousse keeps; status reads the credential without
 * starting Grok (`grokCredential`).
 */

/** The install folder of managed copies under `agents/`. */
export const GROK_AGENT_ID = 'xai-grok'

/** The npm package of this computer's Grok build (`@xai-official/grok-win32-x64`). */
export function grokPackage(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  const os = ({ win32: 'win32', darwin: 'darwin', linux: 'linux' } as Record<string, string>)[platform]
  const cpu = ({ x64: 'x64', arm64: 'arm64' } as Record<string, string>)[arch]
  return os && cpu ? `@xai-official/grok-${os}-${cpu}` : undefined
}

/**
 * The files of Grok's platform package by version range, checked at install (a missing one fails
 * it). The package holds only the brotli-compressed `grok`; its helpers (`grove`, `grove-credential`,
 * `grove-fsmonitor`) are not in it, so Grok fetches them into its home: a managed copy runs only
 * with a home of its own.
 */
export const GROK_FILESET: ReadonlyArray<{ min: string; max: string; files: (exe: string) => string[] }> = [
  { min: '1.0.0', max: '1.99999.0', files: (exe) => [`bin/grok${exe}`] }
]

/** What a managed install takes from the package, for `version` on `platform`. */
export function grokPackageSpec(version: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): PackageBinarySpec {
  const name = grokPackage(platform, arch)
  if (!name) throw new Error('xAI publishes no Grok for this computer.')
  const exe = platform === 'win32' ? '.exe' : ''
  const set = GROK_FILESET.find((entry) => compareVersions(version, entry.min) >= 0 && compareVersions(version, entry.max) <= 0)
  if (!set) throw new Error(`Mousse does not know the files of Grok ${version}.`)
  return {
    agentId: GROK_AGENT_ID,
    name,
    version,
    expand: { [`bin/grok${exe}.br`]: `bin/grok${exe}` },
    required: set.files(exe),
    cmd: `bin/grok${exe}`
  }
}

/** Vault entries. */
const SECRET = { apiKey: 'xai_api_key' } as const

export interface GrokDriverOptions {
  agents?: AgentInstalls
  /** Test seam: opens agent connections instead of starting Grok. */
  connect?: (context: DriverContext, request: AcpLaunchRequest) => AcpConnection
  /** Test seam: the pseudo-terminal for `grok login`. */
  pty?: { available: () => boolean; spawn?: PtySpawn }
  /** Test seam: the system config folder. */
  systemDir?: string
  now?: () => number
}

/** The sign-in methods Mousse offers for Grok, in order. */
export const GROK_SIGN_IN_METHODS = [
  { id: 'account', label: 'Sign in with your Grok account', description: 'Opens a device code to confirm in your browser.' },
  { id: 'api_key', label: 'API key', description: 'An xAI API key from console.x.ai.' }
] as const

export function grokDriver(options: GrokDriverOptions = {}): HarnessDriver {
  return {
    kind: 'grok',
    label: GROK_LABEL,
    binaryNames: cliNames('grok'),
    testedVersions: { min: GROK_TESTED_VERSION, max: GROK_TESTED_VERSION },
    latestVersion: { kind: 'npm', package: '@xai-official/grok' },
    multiInstance: true,
    privateHome: true,
    canInstall: true,
    customModels: false,
    methodLabel: 'Grok account or API key',
    // ACP updates do not name the MCP server: the bearer is kept only after a turn whose tool calls all completed.
    mcpTurnBinding: 'drained_turn',
    userMcp: 'native',
    decodeConfig: (raw) => decodeInstanceConfig(raw, { privateHome: true }),
    versionArgs: () => ['--version'],
    caps: () => GROK_CAPS,
    updateCommand: (owner: InstallOwner) => (owner === 'standalone' ? 'grok update' : owner === 'npm' ? 'npm install -g @xai-official/grok@latest' : undefined),
    create: (context) => createGrokRuntime(context, options)
  }
}

function createGrokRuntime(context: DriverContext, options: GrokDriverOptions): DriverRuntime {
  const label = context.config.displayName ?? GROK_LABEL
  const vault = new InstanceVault(join(context.stateDir, 'secrets.json'))
  const agents = options.agents
  const ptyRuns = () => (options.pty ? options.pty.available() : ptyAvailable())
  /** Bumped by every sign-in start and cancel: a sign-in that finishes under an older one changes nothing. */
  let loginGeneration = 0

  const savedKey = (): string | undefined => {
    try {
      return vault.get(SECRET.apiKey)
    } catch (error) {
      console.warn('[harness] grok secrets unreadable', error instanceof Error ? error.message : String(error))
      return undefined
    }
  }

  /** The managed copy of the tested version, when it is installed. */
  const spec = (): PackageBinarySpec | undefined => {
    try {
      return grokPackageSpec(GROK_TESTED_VERSION)
    } catch {
      return undefined
    }
  }
  const installedNow = () => {
    const wanted = spec()
    return wanted && agents ? agents.installed(agents.packageSource(wanted)) : undefined
  }
  let verified: { hash: string; atMs: number } | undefined
  let filesChanged: string | undefined

  /** The executable: the entry's own, else a managed copy, else the one on PATH. */
  const program = (): { resolved: CliLaunch; managed: boolean; root?: string } | undefined => {
    if (context.config.binaryPath) {
      const resolved = resolveCommand(context.config.binaryPath, context.env)
      return resolved ? { resolved, managed: false } : undefined
    }
    const installed = installedNow()
    if (installed && agents) {
      const launch = agents.launch(installed, context.env)
      return { resolved: { path: launch.path, command: launch.command, args: launch.args }, managed: true, root: installed.root }
    }
    const found = context.findBinary()
    const resolved = found ? cliLaunch(found) : undefined
    return resolved ? { resolved, managed: false } : undefined
  }

  /** The variables every Grok process starts with: the instance's own, then its saved key. */
  const processEnv = (purpose: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
    const key = savedKey()
    let result = key ? withUserEnv(env, { [GROK_API_KEY_VARIABLE]: key }) : env
    // Only probes, checks and sign-ins of the user's own copy run without its updater; its turns
    // run as the user set it up. A managed copy never updates itself.
    if (purpose === 'turn' && !program()?.managed && !context.config.env?.GROK_DISABLE_AUTOUPDATER) {
      result = { ...result }
      for (const name of Object.keys(result)) if (name.toUpperCase() === 'GROK_DISABLE_AUTOUPDATER') delete result[name]
    }
    return result
  }

  /** The credential a Grok process of this instance would use now. */
  const credential = (): GrokCredential =>
    grokCredential({
      env: processEnv('status', withUserEnv(context.env.env, { ...(context.config.env ?? {}) })),
      ...(options.systemDir ? { systemDir: options.systemDir } : {}),
      ...(options.now ? { now: options.now() } : {})
    })

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

  const base = createAcpRuntime(context, GROK_PRESET, {
    ...(options.connect ? { connect: options.connect } : {}),
    ...(options.pty ? { pty: options.pty } : {})
  }, ptyRuns, {
    driver: 'grok',
    program: () => {
      const found = program()
      if (!found) return undefined
      return { resolved: found.resolved, ...(found.root && agents ? { track: () => agents.track(found.root!) } : {}) }
    },
    env: (env, purpose) => processEnv(purpose, env),
    beforeLaunch: () => checkManaged(undefined, true)
  })

  const reading = (): AuthReading => {
    const signInCommand = 'grok login --device-auth'
    const canSignIn = { canSignIn: true }
    const found = credential()
    switch (found.kind) {
      case 'api_key':
        return { state: 'signed_in', methodLabel: 'API key', subject: found.subject, ...canSignIn, ...(savedKey() ? { ownedByMousse: true } : {}) }
      case 'unknown':
        // Grok signs in some other way: Mousse cannot tell the account, so it resumes nothing.
        return { state: 'unknown', methodLabel: 'Set outside Mousse', message: `Mousse cannot tell which account Grok uses: ${found.reason}. Check again after changing it.` }
      case 'none':
        return { state: 'signed_out', methodLabel: 'Grok account or API key', signInCommand, ...canSignIn }
      case 'account':
        if (found.state === 'expired')
          return { state: 'expired', methodLabel: found.methodLabel, message: 'Your Grok sign-in expired.', signInCommand, ...canSignIn }
        return {
          state: 'signed_in',
          methodLabel: found.methodLabel,
          ...(found.subject ? { subject: found.subject } : {}),
          ...(found.state === 'refreshing' ? { message: 'Grok renews its sign-in on the next chat.' } : {}),
          ...canSignIn
        }
    }
  }

  const saveApiKey = (apiKey: string): void => {
    const key = apiKey.trim()
    if (!key) throw new Error('Paste an xAI API key.')
    vault.set(SECRET.apiKey, key)
    // Threads move to the new account through the gateway: their next admission reads a new identity.
    context.changed()
  }

  /**
   * `grok login --device-auth` in a terminal. A private home signs in into a staging home first;
   * its `auth.json` replaces the instance's only when the command succeeds and nobody cancelled, so
   * a late success after a cancel changes nothing.
   */
  const signInAccount = async (session: LoginSession): Promise<void> => {
    const generation = ++loginGeneration
    const found = program()
    if (!found) throw new Error(`${label} is not installed.`)
    if (!ptyRuns()) {
      throw new Error(`Mousse cannot open a sign-in terminal here. Run \`grok login --device-auth\`${context.env.home ? ` with GROK_HOME=${context.env.home}` : ''} in a terminal, then check again.`)
    }
    const home = context.env.home
    const staging = home ? mkdtempSync(join(context.stateDir, 'login-')) : undefined
    try {
      const env = processEnv('sign_in', withUserEnv(context.env.env, { ...(context.config.env ?? {}), ...(staging ? { GROK_HOME: staging } : {}) }))
      // The device sign-in never uses a key: the account's own token is what it writes.
      for (const name of Object.keys(env)) if (name.toUpperCase() === GROK_API_KEY_VARIABLE) delete env[name]
      const shown = new Set<string>()
      const run = runInPty(found.resolved.command, [...found.resolved.args, 'login', '--device-auth'], {
        env,
        ...(options.pty?.spawn ? { spawn: options.pty.spawn } : {}),
        onOutput: (transcript) => {
          const prompt = signInPrompts(transcript)
          if (prompt.url && prompt.userCode && !shown.has(prompt.userCode)) {
            shown.add(prompt.userCode)
            session.emitEvent({ sessionId: session.sessionId, type: 'device_code', userCode: prompt.userCode, verificationUri: prompt.url })
          } else if (prompt.url && !prompt.userCode && !shown.has(prompt.url)) {
            shown.add(prompt.url)
            session.emitEvent({ sessionId: session.sessionId, type: 'auth_url', url: prompt.url, usesCallbackServer: false })
          }
        }
      })
      const cancel = () => {
        loginGeneration += 1
        run.cancel()
      }
      session.abort.signal.addEventListener('abort', cancel, { once: true })
      let exitCode: number
      try {
        ;({ exitCode } = await run.done)
      } finally {
        session.abort.signal.removeEventListener('abort', cancel)
      }
      if (session.abort.signal.aborted || generation !== loginGeneration) throw new Error('Login cancelled')
      if (exitCode !== 0) throw new Error(`grok login exited with code ${exitCode}.`)
      if (home && staging) {
        const signedIn = join(staging, 'auth.json')
        if (!existsSync(signedIn)) throw new Error('grok login finished without signing in.')
        mkdirSync(home, { recursive: true, mode: 0o700 })
        copyFileSync(signedIn, join(home, 'auth.json'))
      }
    } finally {
      if (staging) rmSync(staging, { recursive: true, force: true })
    }
  }

  const signIn = async (session: LoginSession, cwd: string, method?: string): Promise<ProviderLoginResult> => {
    try {
      let chosen = GROK_SIGN_IN_METHODS.find((entry) => entry.id === method)?.id
      if (!chosen) {
        const picked = await session.createAuthCallbacks().prompt({
          type: 'select',
          message: `How do you sign in to ${label}?`,
          options: GROK_SIGN_IN_METHODS.map((entry) => ({ id: entry.id, label: entry.label, description: entry.description }))
        })
        chosen = GROK_SIGN_IN_METHODS.find((entry) => entry.id === picked)?.id
        if (!chosen) throw new Error('Choose a sign-in method.')
      }
      if (chosen === 'api_key') {
        const key = await session.createAuthCallbacks().prompt({ type: 'secret', message: 'Paste an xAI API key (console.x.ai → API keys).', placeholder: 'xai-…' })
        session.abort.signal.throwIfAborted()
        saveApiKey(key)
        return { success: true, sessionId: session.sessionId }
      }
      if (!ptyRuns()) {
        // No terminal here: Grok's own browser sign-in over ACP, then the same check as any agent.
        return await base.signIn!(session, cwd, 'grok.com')
      }
      await signInAccount(session)
      return { success: true, sessionId: session.sessionId }
    } catch (error) {
      return { success: false, sessionId: session.sessionId, error: session.abort.signal.aborted ? 'Login cancelled' : error instanceof Error ? error.message : String(error) }
    }
  }

  const managed = (): ManagedInstall | undefined => {
    const installed = installedNow()
    if (!installed) return undefined
    return {
      path: join(installed.root, DIST_DIR, ...installed.receipt.launch.cmd.split('/')),
      version: installed.receipt.version,
      bytes: installed.receipt.bytes,
      checksum: installed.receipt.checksum,
      ...(filesChanged ? { broken: filesChanged } : {})
    }
  }

  const runtime: DriverRuntime = {
    ...base,
    configured: () => {
      if (!program()) return false
      if (managed()?.broken) return false
      const found = credential()
      return found.kind === 'api_key' || found.kind === 'unknown' || (found.kind === 'account' && found.state !== 'expired')
    },
    llmProvider: () => (runtime.configured() ? { id: context.instanceId, label, models: runtime.models() } : undefined),
    // No process is started: the credential decides.
    auth: async () => reading(),
    // Read at every admission: a credential replaced outside Mousse moves the account generation on.
    identity: async () => {
      const found = credential()
      return found.kind === 'api_key' || found.kind === 'account' ? found.subject : undefined
    },
    signIn,
    signOut: async () => {
      loginGeneration += 1
      vault.set(SECRET.apiKey, undefined)
      // A private home's sign-in is Mousse's own: it goes too. The user's own home is left alone.
      if (context.env.home) rmSync(join(grokHome(context.env.env), 'auth.json'), { force: true })
      await base.signOut?.()
    },
    adoptApiKey: async (apiKey) => saveApiKey(apiKey),
    ...(agents ? {
      install: async (onProgress) => {
        const wanted = spec()
        if (!wanted) throw new Error('xAI publishes no Grok for this computer.')
        // Grok fetches its helpers into its home: a copy Mousse installs runs only with a home of its own.
        if (!context.env.home) throw new Error(`Mousse installs its own Grok only for an entry with its own home. Turn on "Own home" for ${label}, or install Grok yourself.`)
        await agents.installPackageBinary({ instanceId: context.instanceId, spec: wanted, env: context.env, label, onProgress })
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
        const wanted = spec()
        if (!wanted) return { removed: true, bytes: 0 }
        return agents.removeInstall({ instanceId: context.instanceId, source: agents.packageSource(wanted), force })
      },
      release: async () => {
        const wanted = spec()
        if (wanted) await agents.release(context.instanceId, agents.packageSource(wanted))
      }
    } : {})
  }
  return runtime
}
