import type { ChildProcess } from 'node:child_process'
import { isAbsolute, join } from 'node:path'
import type { RpcCommand } from '@earendil-works/pi-coding-agent'
import { compareVersions } from '../driver'
import { HOME_VARIABLES, INHERITED_CREDENTIALS, type InstanceEnv } from '../env'
import { spawnHarness } from '../spawn'
import { ANTHROPIC_OAUTH_ENV_KEYS, piOwnProviderKeys } from './envKeys'
import { PiRpcClient, type PiRpcHandlers } from './rpcClient'

/**
 * How Mousse starts Pi's agent (`@earendil-works/pi-coding-agent`, pinned 1.4.0) in RPC mode:
 * the packaged runtime under `out/pi-runtime/`, run by Mousse's own Node (Electron as Node in the
 * app), with a Mousse-owned agent dir, only Mousse's extension, and no credential it did not choose.
 */

/** Pi's `engines.node`. */
export const PI_MIN_NODE_VERSION = '22.19.0'

export type PiThinkingLevel = Extract<RpcCommand, { type: 'set_thinking_level' }>['level']

/** Where `scripts/build-pi-runtime.mjs` puts the runtime. */
export interface PiRuntimePaths {
  /** The package root (`PI_PACKAGE_DIR`): `package.json` and `dist/bundle/**`. */
  root: string
  /** `dist/bundle/rpc-entry.js`: Pi's CLI with `--mode rpc` prepended. */
  entry: string
  /** Mousse's extension, the only one Pi loads. */
  extension: string
}

/** `applicationRoot` comes from the trusted app or CLI entrypoint; a packaged app reads the unpacked copy. */
export function piRuntimePaths(applicationRoot: string): PiRuntimePaths {
  if (!isAbsolute(applicationRoot)) throw new Error('The Pi runtime application root must be absolute')
  const base = applicationRoot.endsWith('.asar') ? `${applicationRoot}.unpacked` : applicationRoot
  const dir = join(base, 'out', 'pi-runtime')
  const root = join(dir, 'pi-coding-agent')
  return { root, entry: join(root, 'dist', 'bundle', 'rpc-entry.js'), extension: join(dir, 'mousse-extension.mjs') }
}

export interface PiLaunchInput {
  /** The instance's environment; it must have its Mousse-owned home (the driver's `alwaysPrivateHome`). */
  env: InstanceEnv
  runtime: PiRuntimePaths
  /** `<profileHome>/harness/<instanceId>`; sessions are kept under it. */
  stateDir: string
  provider: string
  model: string
  thinking: PiThinkingLevel
  /** Resume this session (`--session`). */
  sessionId?: string
  /** A session of the turn's own, kept in memory only (`--no-session`): nothing is written or resumed. */
  ephemeral?: boolean
  /**
   * Variables configured on the instance (e.g. an account id). They pass the same filter as the
   * inherited environment: no Electron, Node, Mousse or Pi setting, no credential variable, and
   * never the AWS retry pins.
   */
  extraEnv?: Readonly<Record<string, string>>
  /** Mousse's own variables for its extension (`MOUSSE_PI_*`), set by the engine after the drops. */
  engineEnv?: Readonly<Record<`MOUSSE_PI_${string}`, string>>
  /** Where the instance's own provider key is read from: Mousse's environment unless a test passes one. */
  ambient?: NodeJS.ProcessEnv
  /** The host process (test seam): its executable and versions. */
  host?: { execPath: string; versions: Partial<NodeJS.ProcessVersions> }
}

export type PiLaunch =
  | { runs: 'yes'; command: string; args: string[]; env: NodeJS.ProcessEnv }
  | { runs: 'no'; reason: string }

/** Inherited variables that would change how the child runs: Electron's, Node's, Mousse's and the user's own Pi settings. */
const DROPPED = [/^ELECTRON_/i, /^NODE_OPTIONS$/i, /^MOUSSE_/i, /^PI_/i]

/**
 * Set last, over anything inherited or configured: the AWS SDK under Bedrock then makes one HTTP
 * attempt per request. The environment wins over the shared config file's `max_attempts` and
 * `retry_mode`, so the user's profile, SSO and region still come from their files. Pi's own retry
 * (which passes Mousse's request guard every time) is the only one.
 */
export const PI_AWS_RETRY_ENV: Readonly<Record<string, string>> = Object.freeze({ AWS_MAX_ATTEMPTS: '1', AWS_RETRY_MODE: 'standard' })

function find(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const upper = name.toUpperCase()
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === upper)
  return key === undefined ? undefined : env[key]
}

/** Sets `name`, removing any other spelling of it first (Windows names are case-insensitive). */
function put(env: NodeJS.ProcessEnv, name: string, value: string): void {
  remove(env, (key) => key.toUpperCase() === name.toUpperCase())
  env[name] = value
}

function remove(env: NodeJS.ProcessEnv, matches: (key: string) => boolean): void {
  for (const key of Object.keys(env)) if (matches(key)) delete env[key]
}

/** The command, arguments and environment of a Pi RPC process, or why it cannot run here. */
export function piLaunch(input: PiLaunchInput): PiLaunch {
  const host = input.host ?? { execPath: process.execPath, versions: process.versions }
  const nodeVersion = host.versions.node ?? '0'
  if (compareVersions(nodeVersion, PI_MIN_NODE_VERSION) < 0)
    return { runs: 'no', reason: `Pi's agent needs Node ${PI_MIN_NODE_VERSION} or newer; this Mousse runs Node ${nodeVersion}.` }
  const homeVariable = HOME_VARIABLES.pi!
  const home = input.env.home
  if (!home || find(input.env.env, homeVariable) !== home) throw new Error('Pi runs only with its Mousse-owned home')

  const env: NodeJS.ProcessEnv = { ...input.env.env }
  remove(env, (key) => key.toUpperCase() !== homeVariable && DROPPED.some((pattern) => pattern.test(key)))
  // The instance env already dropped them (a private home); kept here so the launcher stands alone.
  const credentials = new Set((INHERITED_CREDENTIALS.pi ?? []).map((name) => name.toUpperCase()))
  remove(env, (key) => credentials.has(key.toUpperCase()))

  // The instance's own provider key, as the pi loop honours it today; never a subscription token.
  const ambient = input.ambient ?? process.env
  for (const name of piOwnProviderKeys(input.provider)) {
    const value = find(ambient, name)
    if (value) put(env, name, value)
  }

  const refused = new Set([...credentials, ...ANTHROPIC_OAUTH_ENV_KEYS, ...Object.keys(PI_AWS_RETRY_ENV)].map((name) => name.toUpperCase()))
  for (const [name, value] of Object.entries(input.extraEnv ?? {}))
    if (!refused.has(name.toUpperCase()) && !DROPPED.some((pattern) => pattern.test(name))) put(env, name, value)
  for (const [name, value] of Object.entries(input.engineEnv ?? {}))
    if (/^MOUSSE_PI_/i.test(name)) put(env, name, value)

  put(env, 'PI_PACKAGE_DIR', input.runtime.root)
  put(env, 'PI_OFFLINE', '1')
  put(env, 'PI_SKIP_VERSION_CHECK', '1')
  if (host.versions.electron) put(env, 'ELECTRON_RUN_AS_NODE', '1')
  for (const [name, value] of Object.entries(PI_AWS_RETRY_ENV)) put(env, name, value)
  // The entry's telemetry switch (Off: `PI_TELEMETRY=0`); `spawnHarness` sets it again.
  for (const [name, value] of Object.entries(input.env.enforced ?? {})) put(env, name, value)

  const args = [
    input.runtime.entry,
    '--provider', input.provider,
    '--model', input.model,
    '--thinking', input.thinking,
    ...(input.ephemeral ? ['--no-session'] : ['--session-dir', join(input.stateDir, 'sessions'), ...(input.sessionId ? ['--session', input.sessionId] : [])]),
    '--no-extensions', '-e', input.runtime.extension,
    '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve'
  ]
  return { runs: 'yes', command: host.execPath, args, env }
}

const STDERR_TAIL = 16 * 1024

export interface PiProcess {
  child: ChildProcess
  client: PiRpcClient
  /** The last 16 KB Pi wrote to stderr (startup diagnostics). */
  stderr(): string
}

/** Starts a launched Pi through `spawnHarness`, with piped stdio and an RPC client on it. */
export function startPiProcess(
  env: InstanceEnv,
  launch: Extract<PiLaunch, { runs: 'yes' }>,
  options: { cwd: string; handlers?: PiRpcHandlers }
): PiProcess {
  const child = spawnHarness({ ...env, env: launch.env }, 'turn', launch.command, launch.args, {
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let tail = ''
  // Always drained: a full stderr pipe would stall the child.
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    tail = (tail + chunk).slice(-STDERR_TAIL)
  })
  child.stderr?.on('error', () => {})
  const client = new PiRpcClient(child, options.handlers)
  return { child, client, stderr: () => tail }
}
