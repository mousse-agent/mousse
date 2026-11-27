import { execFile, spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { Transform } from 'node:stream'
import { harnessAppError } from '../../../../shared/harness/types'
import type { ProviderCapabilities } from '../../adapter'
import { ACP_BASE_CAPABILITIES } from '../capabilities'
import { connectAcpProcess, treeKilledChild, type AcpConnectionFactory } from '../connection'
import type { AcpQuirks } from '../quirks'

/**
 * Google's Antigravity agent as an ACP preset: its launch environment (an isolated `GEMINI_HOME`,
 * a `BROWSER` helper that hands the sign-in link to Mousse), the sign-in line it prints on ACP
 * stdout, the owned loopback callback, eager `oauth-personal` sign-in and resuming saved sessions.
 */

export const ANTIGRAVITY_LABEL = 'Antigravity'

/**
 * The first `agy` that folds a prompt sent during a running one into that work (1.4 queued it). Probed on 1.5.13: the
 * running prompt answers `end_turn` as soon as the second arrives (or at its own end, when it was already finishing)
 * and the second one carries the rest of the turn, steer included.
 */
export const ANTIGRAVITY_NATIVE_STEER_FROM = '1.5.0'

/**
 * The agent publishes no usage: the base ACP capabilities. `steer` stays `interrupt_restart`
 * although a 1.5 `agy` takes a steer into the running prompt (`ANTIGRAVITY_QUIRKS.nativeSteerFrom`): `native` would let
 * the engine push a subagent's notice into a running turn as a prompt of its own (SPEC §14.3). A person's steer goes in at once either way; how is the session's choice.
 */
export const ANTIGRAVITY_CAPABILITIES: ProviderCapabilities = ACP_BASE_CAPABILITIES

/**
 * Client fs with the workspace check, `session/resume` for saved sessions, its exact protocol
 * version, the `model` option with the account's listed models only, its own steer from 1.5.0,
 * and background commands/subagents with out-of-turn reactive wakeups.
 */
export const ANTIGRAVITY_QUIRKS: AcpQuirks = Object.freeze({ clientFs: true, preferResume: true, strictProtocol: true, modelConfigId: 'model', nativeSteerFrom: ANTIGRAVITY_NATIVE_STEER_FROM, backgroundWork: true })

/** The method `authenticate` signs in with, eagerly, before the first `session/new`. */
export const ANTIGRAVITY_AUTH_METHOD = 'oauth-personal'

const AUTH_PREFIX = 'Open the following link to authenticate the ACP server: '
const BROWSER_MARKER = '__MOUSSE_ANTIGRAVITY_AUTH_URL__'
const ISOLATED_KEYS = [
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION', 'GOOGLE_CLOUD_QUOTA_PROJECT', 'GOOGLE_GENAI_USE_VERTEXAI',
  'GCLOUD_PROJECT', 'CLOUDSDK_CORE_PROJECT', 'AGY_ACP_CCPA_PROJECT', 'AGY_ACP_ENABLE_OAUTH',
  'GEMINI_HOME', 'AGY_ACP_FORCE_FILE_STORAGE', 'AGY_CLI_FORCE_FILE_TOKEN_STORAGE', 'ANTIGRAVITY_HARNESS_PATH',
  'ELECTRON_RUN_AS_NODE', 'BROWSER', 'PYTHONUNBUFFERED'
]

/**
 * Makes `agy` keep its Google sign-in in a file under its `--gemini-dir` instead of the system keyring, which is one
 * per user on Windows, macOS and Linux with D-Bus. Seen in agy 1.5.17: with it, `agy acp` logs "Using file-based
 * token storage because AGY_CLI_FORCE_FILE_TOKEN_STORAGE is set" and a home with no sign-in of its own answers
 * `Authentication required` while the user's keyring holds one; without it, the same home signs in from the keyring.
 */
export const AGY_FILE_TOKEN_ENV = 'AGY_CLI_FORCE_FILE_TOKEN_STORAGE'

/** The sign-in of an entry with a home of its own stays in that home (`AGY_FILE_TOKEN_ENV`); set last, over the user's variables. */
export function privateSignInEnv(env: NodeJS.ProcessEnv, kind: 'legacy' | 'native'): NodeJS.ProcessEnv {
  if (kind === 'native') env[AGY_FILE_TOKEN_ENV] = '1'
  else env.AGY_ACP_FORCE_FILE_STORAGE = '1'
  return env
}

function callbackTarget(authUrl: string): { origin: string; pathname: string; state: string } | undefined {
  try {
    if (authUrl.length > 16_384 || /\s/.test(authUrl)) return undefined
    const signIn = new URL(authUrl)
    if (signIn.origin !== 'https://accounts.google.com' || signIn.pathname !== '/o/oauth2/v2/auth' ||
        signIn.username || signIn.password || signIn.hash || signIn.searchParams.get('response_type') !== 'code' ||
        signIn.searchParams.getAll('state').length !== 1 || signIn.searchParams.getAll('redirect_uri').length !== 1) return undefined
    const redirect = new URL(signIn.searchParams.get('redirect_uri') ?? '')
    const state = signIn.searchParams.get('state')
    if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || !redirect.port || Number(redirect.port) < 1024 ||
        redirect.pathname !== '/' || redirect.search || redirect.hash || !state || state.length > 512) return undefined
    return { origin: redirect.origin, pathname: redirect.pathname, state }
  } catch { return undefined }
}

/** Only relay a pasted callback into the loopback listener that this login opened. */
export async function forwardAntigravityCallback(authUrl: string, pastedUrl: string): Promise<void> {
  const target = callbackTarget(authUrl)
  if (!target) throw new Error('Google sign-in did not expose an owned loopback callback')
  const pasted = new URL(pastedUrl)
  if (pasted.origin !== target.origin || pasted.pathname !== target.pathname || pasted.hash ||
      pasted.username || pasted.password || pasted.searchParams.getAll('iss').length > 1 ||
      pasted.searchParams.getAll('state').length !== 1 || pasted.searchParams.get('state') !== target.state ||
      pasted.searchParams.getAll('code').length + pasted.searchParams.getAll('error').length !== 1 ||
      (pasted.searchParams.has('iss') && pasted.searchParams.get('iss') !== 'https://accounts.google.com')) {
    throw new Error('Redirect URL does not match this Google sign-in flow')
  }
  const response = await fetch(pasted, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`Google sign-in callback was rejected (${response.status})`)
}

/** Google's 1.1.1 agent emits a human-readable auth line on ACP stdout. */
export function antigravityStdout(onAuthUrl: (url: string) => void): Transform {
  let pending = Buffer.alloc(0)
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      pending = Buffer.concat([pending, chunk])
      let end: number
      while ((end = pending.indexOf(10)) !== -1) {
        if (end > 16 * 1024 * 1024) { done(new Error('Antigravity ACP line is too large')); return }
        const line = pending.subarray(0, end + 1)
        pending = pending.subarray(end + 1)
        const value = line.toString('utf8').trimEnd()
        if (value.startsWith(AUTH_PREFIX)) {
          const url = value.slice(AUTH_PREFIX.length)
          if (!callbackTarget(url)) { done(new Error('Antigravity emitted an invalid Google sign-in URL')); return }
          onAuthUrl(url)
        } else this.push(line)
      }
      if (pending.length > 16 * 1024 * 1024) { done(new Error('Antigravity ACP line is too large')); return }
      done()
    },
    flush(done) {
      if (pending.length) this.push(pending)
      done()
    }
  })
}

/** The environment every Antigravity launch starts from: Mousse's own, without Google credentials or agent settings. */
export function scrubbedAntigravityEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base }
  // Windows treats environment keys as case-insensitive: aliases go too.
  for (const key of Object.keys(env)) if (ISOLATED_KEYS.includes(key.toUpperCase())) delete env[key]
  return env
}

/**
 * Which agent runs: Google's `agy` CLI (`native`, served as `agy acp`) or the 1.1.1 ACP server
 * (`legacy`, beside its local harness), and where it came from: a manual path in Settings, the
 * user's own `agy` on this computer, or Mousse's own install.
 */
export interface AntigravityRuntimeChoice { kind: 'legacy' | 'native'; binary: string; source: 'manual' | 'user' | 'managed' }

/** The first https link in a line the agent printed, when there is one. */
function linkIn(line: string): string | undefined {
  return /https:\/\/\S+/.exec(line)?.[0]
}

/** `agy acp` keeps its app data in `<gemini-dir>/<app-data-dir>`: the same folder the 1.1.1 server used. */
export const ANTIGRAVITY_APP_DATA_DIR = 'antigravity-acp'

/** The launch arguments of a runtime, before the user's own. */
export function antigravityRuntimeArgs(kind: AntigravityRuntimeChoice['kind'], geminiHome: string, platform: NodeJS.Platform = process.platform): string[] {
  if (kind === 'native') return ['acp', '--gemini-dir', geminiHome, '--app-data-dir', ANTIGRAVITY_APP_DATA_DIR]
  return platform === 'linux' ? ['--uid='] : []
}

export interface AntigravityLaunchOptions {
  /** `<profileHome>/providers/antigravity`, or an added entry's state folder: the browser helper lives here. */
  profileDir: string
  profileHome: string
  /**
   * Where the agent's `gemini-home` and `bot-gemini-home` are: `profileDir` for the first entry, an added entry's own
   * home for the others, whose sign-in then stays in that home (`privateSignInEnv`).
   */
  privateHome?: string
  /** The runtime to start; undefined when there is none. */
  runtime(): AntigravityRuntimeChoice | undefined
  /** The user's extra launch arguments and variables. */
  args(): string[]
  env(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv
  /**
   * Starts a single request's agent in its place (`oneShot/places.ts` `spawnInPlace`), `cwd` being the place's `work`
   * folder: its tree is recorded before it runs and ends with proof. Without it a single request does not start.
   */
  spawnOneShot?(cwd: string, launch: { command: string; args: string[]; env: NodeJS.ProcessEnv }): ChildProcessWithoutNullStreams
}

/**
 * Starts the agent with its isolated Google home. A sign-in link the agent prints (on ACP stdout,
 * on stderr or through the `BROWSER` helper) goes to `onAuthUrl` once it proves to be a Google
 * sign-in with a loopback callback this process owns.
 *
 * A single request (`request.purpose === 'one_shot'`) runs in its place (`options.spawnOneShot`): the place's `work`
 * folder as working folder, its `tmp` as temporary folder. On `agy` it gets a launch of its own
 * (`antigravityOneShotArgs`): the place's empty `home` as gemini dir ({@link antigravityOneShotHome}),
 * {@link oneShotAntigravityEnv}, settings of its own, none of the user's arguments, variables or skill links. On the
 * 1.1.1 server it keeps the ordinary launch, which is not checked.
 */
export function antigravityConnectionFactory(options: AntigravityLaunchOptions): AcpConnectionFactory {
  return (request) => {
    const runtime = options.runtime()
    if (!runtime) throw new Error('Install Google Antigravity or select its official ACP binary first')
    const { binary, kind } = runtime
    if (request.bot && kind !== 'native') throw new Error('Bot turns require the agy CLI.')
    // A single request's place: `<place>/work` is its folder (`AntigravityProviderService.oneShotTransport`).
    const place = request.purpose === 'one_shot' ? oneShotPlaceOf(request.cwd) : undefined
    if (request.purpose === 'one_shot' && (!place || !options.spawnOneShot)) throw new Error('An Antigravity single request runs only in a place of its own.')
    const oneShot = place !== undefined && kind === 'native'
    const env = oneShot ? oneShotAntigravityEnv(process.env) : scrubbedAntigravityEnv(process.env)
    const geminiHome = antigravityGeminiHome(options.privateHome ?? options.profileDir, request.bot)
    mkdirSync(geminiHome, { recursive: true, mode: 0o700 })
    const acpDir = join(geminiHome, ANTIGRAVITY_APP_DATA_DIR)
    mkdirSync(acpDir, { recursive: true, mode: 0o700 })
    // A one-shot reads settings of its own (`--cli_dir_name`) and leaves the home's alone.
    if (!oneShot) writeFileSync(join(acpDir, 'settings.json'), JSON.stringify({ auth: { type: ANTIGRAVITY_AUTH_METHOD } }), { mode: 0o600 })
    for (const part of request.bot || oneShot ? [] : [['config', 'skills'], ['antigravity-cli', 'skills']]) {
      const link = join(geminiHome, ...part)
      if (existsSync(link)) continue
      try {
        mkdirSync(dirname(link), { recursive: true })
        symlinkSync(join(homedir(), '.gemini', ...part), link, process.platform === 'win32' ? 'junction' : 'dir')
      } catch { /* A missing optional user skill link does not affect sign-in. */ }
    }
    const browserHelper = join(options.profileDir, process.platform === 'win32' ? 'browser.cmd' : 'browser.sh')
    if (process.platform === 'win32') {
      writeFileSync(browserHelper, `@echo off\r\necho ${BROWSER_MARKER}%1 1>&2\r\n`, { mode: 0o700 })
    } else {
      writeFileSync(browserHelper, `#!/bin/sh\nprintf '${BROWSER_MARKER}%s\\n' "$1" >&2\n`, { mode: 0o700 })
      chmodSync(browserHelper, 0o700)
    }
    // A one-shot reads its `config` (hooks, MCP servers, plugins) from an empty home of its own (`antigravityOneShotHome`).
    const oneShotHome = oneShot ? antigravityOneShotHome(place!.dir) : undefined
    if (oneShotHome) mkdirSync(oneShotHome, { recursive: true, mode: 0o700 })
    env.GEMINI_HOME = oneShotHome ?? geminiHome
    if (kind === 'legacy') {
      env.AGY_ACP_FORCE_FILE_STORAGE = '1'
      env.ANTIGRAVITY_HARNESS_PATH = join(dirname(binary), process.platform === 'win32' ? 'localharness_external.exe' : 'localharness_external')
    }
    if (process.platform !== 'win32') {
      const probe = spawnSync(browserHelper, ['https://example.invalid/mousse-browser-probe'], { encoding: 'utf8', timeout: 5_000 })
      if (probe.status !== 0 || probe.stdout || probe.stderr !== `${BROWSER_MARKER}https://example.invalid/mousse-browser-probe\n`) {
        throw new Error('Antigravity browser suppression could not be verified')
      }
    }
    const quotedHelper = `'${browserHelper.replaceAll("'", "'\"'\"'")}'`
    env.BROWSER = `${quotedHelper} %s`
    env.PYTHONUNBUFFERED = '1'
    env.ELECTRON_RUN_AS_NODE = '1'
    const tempDir = place ? join(place.dir, 'tmp') : join(options.profileHome, 'antigravity-tmp', crypto.randomUUID())
    mkdirSync(tempDir, { recursive: true, mode: 0o700 })
    if (process.platform === 'win32') { env.TEMP = tempDir; env.TMP = tempDir }
    else env.TMPDIR = tempDir
    // Bot turns must use ACP approvals and the MCP servers Mousse supplies for their grant; a one-shot runs nothing.
    const args = oneShotHome ? antigravityOneShotArgs(binary, oneShotHome, acpDir, place!.id)
      : [...antigravityRuntimeArgs(kind, geminiHome), ...(request.bot ? ['--include-default-customizations=false'] : options.args())]
    const launchEnv = request.bot || oneShot ? env : options.env(env)
    if (options.privateHome) privateSignInEnv(launchEnv, kind)
    // A process group on POSIX, so Stop ends the agent's helpers with it (`treeKilledChild`). A single request's tree
    // is its place's (a job, or a group with its watcher).
    const child = place ? options.spawnOneShot!(request.cwd!, { command: binary, args, env: launchEnv }) : spawn(binary, args, {
      env: launchEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32'
    })
    const acceptAuthUrl = (url: string) => {
      if (callbackTarget(url)) request.onAuthUrl?.(url)
    }
    const connection = connectAcpProcess(child, request.handlers, {
      stdout: antigravityStdout(acceptAuthUrl),
      stderrLine: (line) => {
        // The 1.1.1 server's line, the browser helper's, or agy's own ("Open this link in a browser…");
        // only a Google sign-in with a loopback callback this process owns is taken (`callbackTarget`).
        const url = line.startsWith(AUTH_PREFIX) ? line.slice(AUTH_PREFIX.length)
          : line.startsWith(BROWSER_MARKER) ? line.slice(BROWSER_MARKER.length) : linkIn(line)
        if (url) acceptAuthUrl(url)
      },
      onExit: () => {
        request.onExit?.()
        // A single request's temporary folder goes with its place.
        if (!place) void rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      }
    })
    // The launcher starts the real agent and its local harness: closing ends all of them.
    connection.child = treeKilledChild(child)
    return connection
  }
}

/** The agent's Google home under `root` (an entry's own home, or its state folder): the one a launch passes as `--gemini-dir`. */
export function antigravityGeminiHome(root: string, bot?: boolean): string {
  return join(root, bot ? 'bot-gemini-home' : 'gemini-home')
}

/** The prefix of a single request's settings folder in `agy`'s app data (`antigravityOneShotCliDir`). */
export const ANTIGRAVITY_ONE_SHOT_DIR = 'one-shot'

/** A place id: what `randomUUID` gives. */
const PLACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The place a single request's folder `<place>/work` is in, with its id; undefined for any other folder. */
function oneShotPlaceOf(cwd: string | undefined): { dir: string; id: string } | undefined {
  if (!cwd || basename(cwd) !== 'work') return undefined
  const dir = dirname(cwd)
  const id = basename(dir)
  return PLACE_ID.test(id) ? { dir, id } : undefined
}

/**
 * The folder under `agy`'s app data where a single request's settings and logs go (`--cli_dir_name`), named after its
 * place's id: a typed leftover of the place, removed with it (`antigravityLeftoverRules`).
 */
export function antigravityOneShotCliDir(placeId: string): string {
  return `${ANTIGRAVITY_ONE_SHOT_DIR}-${placeId}`
}

/**
 * A one-shot's `agy` settings: the `default` agent mode, `strict` tool permission (it asks before every tool, a read
 * included, and Mousse refuses every ask), no access outside the empty workspace, the terminal sandbox, and a rule
 * denying every action `agy` names. Seen in agy 1.5.17: it reads them from `<app data>/<cli dir>/settings.json`
 * (`--cli_dir_name`), and its bundled changelog documents `strict` and `allowNonWorkspaceAccess`.
 */
export const ANTIGRAVITY_ONE_SHOT_SETTINGS = Object.freeze({
  auth: { type: ANTIGRAVITY_AUTH_METHOD },
  agentMode: '',
  toolPermission: 'strict',
  allowNonWorkspaceAccess: false,
  enableTerminalSandbox: true,
  permissions: { deny: ['read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'command(*)', 'unsandboxed(*)', 'mcp(*)'] }
})

/**
 * The empty home a single request passes as `--gemini-dir`: `home` in its place. `agy` reads the global hooks and MCP
 * servers from `<gemini-dir>/config` (`hooks.json`, `mcp_config.json`); neither `--cli_dir_name` nor
 * `--include-default-customizations=false` keeps them out (seen on agy 1.5.18), so a single request's home has none.
 */
export function antigravityOneShotHome(placeDir: string): string {
  return join(placeDir, 'home')
}

/**
 * A one-shot's whole `agy acp` argument list, with its settings written: the empty home `home` as `--gemini-dir`, the
 * entry's own app data `acpDir` (its sign-in and sessions) as `--app-data-dir`, a settings folder of its own, and none
 * of Google's default customizations where this `agy` can leave them out. `agy` refuses an absolute app data path and
 * reads a relative one from the gemini dir. Refused when this `agy`'s flags were not read ({@link readAgyAcpFlags}),
 * it cannot keep the settings apart, or the app data has no relative path from `home`.
 */
function antigravityOneShotArgs(binary: string, home: string, acpDir: string, placeId: string): string[] {
  const flags = knownAgyAcpFlags(binary)
  if (!flags?.cliDir) throw harnessAppError({ code: 'wont_run', message: 'This agy cannot keep a single request apart from its other sessions. Update agy.' })
  const appData = relative(home, acpDir)
  if (!appData || isAbsolute(appData)) throw harnessAppError({ code: 'wont_run', message: `Antigravity's app data ${acpDir} has no relative path from ${home}.` })
  const cliDir = antigravityOneShotCliDir(placeId)
  const settingsDir = join(acpDir, cliDir)
  mkdirSync(settingsDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify(ANTIGRAVITY_ONE_SHOT_SETTINGS), { mode: 0o600 })
  return ['acp', '--gemini-dir', home, '--app-data-dir', appData, '--cli_dir_name', cliDir,
    ...(flags.customizations ? ['--include-default-customizations=false'] : [])]
}

/** What an `agy acp` takes: `--cli_dir_name` (a settings folder of its own) and `--include-default-customizations`. */
export interface AgyAcpFlags { cliDir: boolean; customizations: boolean }

const agyFlags = new Map<string, AgyAcpFlags>()

/** The executable as it is now: a replaced `agy` is read again. */
function agyFingerprint(binary: string): string | undefined {
  try {
    const stat = statSync(binary)
    return `${binary}\0${stat.size}\0${stat.mtimeMs}`
  } catch { return undefined }
}

/** This `agy`'s flags, once {@link readAgyAcpFlags} has read them. */
export function knownAgyAcpFlags(binary: string): AgyAcpFlags | undefined {
  const key = agyFingerprint(binary)
  return key ? agyFlags.get(key) : undefined
}

/** The flags `agy acp --help` lists, read on a one-shot once per executable (about 150 ms on agy 1.5.17), never at start. */
export async function readAgyAcpFlags(binary: string): Promise<AgyAcpFlags> {
  const known = knownAgyAcpFlags(binary)
  if (known) return known
  const key = agyFingerprint(binary)
  const help = await new Promise<string>((resolve) => {
    execFile(binary, ['acp', '--help'], { env: oneShotAntigravityEnv(process.env), timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (_error, stdout, stderr) => resolve(`${stdout}\n${stderr}`))
  })
  const flags = { cliDir: /--cli_dir_name\b/.test(help), customizations: /--include-default-customizations\b/.test(help) }
  // A help that did not list them is not remembered: the next request reads it again.
  if (key && flags.cliDir) agyFlags.set(key, flags)
  return flags
}

/** The variables a one-shot's `agy` keeps from Mousse's own: the system's and the user's folders, locale and proxy. */
const ONE_SHOT_ENV_KEYS = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'USER', 'USERNAME', 'LOGNAME',
  'LANG', 'LANGUAGE', 'TZ', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR'
])

/** A one-shot's environment: only {@link ONE_SHOT_ENV_KEYS} and `LC_*` of `base`, in any case. */
export function oneShotAntigravityEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    const upper = key.toUpperCase()
    if (value !== undefined && (ONE_SHOT_ENV_KEYS.has(upper) || upper.startsWith('LC_'))) env[key] = value
  }
  return env
}
