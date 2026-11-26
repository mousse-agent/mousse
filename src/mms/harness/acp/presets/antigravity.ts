import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Transform } from 'node:stream'
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
 * The agent rejects plan mode and publishes no usage: the base ACP capabilities. `steer` stays `interrupt_restart`
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
}

/**
 * Starts the agent with its isolated Google home. A sign-in link the agent prints (on ACP stdout,
 * on stderr or through the `BROWSER` helper) goes to `onAuthUrl` once it proves to be a Google
 * sign-in with a loopback callback this process owns.
 */
export function antigravityConnectionFactory(options: AntigravityLaunchOptions): AcpConnectionFactory {
  return (request) => {
    const runtime = options.runtime()
    if (!runtime) throw new Error('Install Google Antigravity or select its official ACP binary first')
    const { binary, kind } = runtime
    if (request.bot && kind !== 'native') throw new Error('Bot turns require the agy CLI.')
    const env = scrubbedAntigravityEnv(process.env)
    const geminiHome = join(options.privateHome ?? options.profileDir, request.bot ? 'bot-gemini-home' : 'gemini-home')
    mkdirSync(geminiHome, { recursive: true, mode: 0o700 })
    const acpDir = join(geminiHome, ANTIGRAVITY_APP_DATA_DIR)
    mkdirSync(acpDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(acpDir, 'settings.json'), JSON.stringify({ auth: { type: ANTIGRAVITY_AUTH_METHOD } }), { mode: 0o600 })
    for (const part of request.bot ? [] : [['config', 'skills'], ['antigravity-cli', 'skills']]) {
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
    env.GEMINI_HOME = geminiHome
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
    const tempDir = join(options.profileHome, 'antigravity-tmp', crypto.randomUUID())
    mkdirSync(tempDir, { recursive: true, mode: 0o700 })
    if (process.platform === 'win32') { env.TEMP = tempDir; env.TMP = tempDir }
    else env.TMPDIR = tempDir
    // Bot turns must use ACP approvals and the MCP servers Mousse supplies for their grant.
    const args = [...antigravityRuntimeArgs(kind, geminiHome), ...(request.bot ? ['--include-default-customizations=false'] : options.args())]
    // A process group on POSIX, so Stop ends the agent's helpers with it (`treeKilledChild`).
    const launchEnv = request.bot ? env : options.env(env)
    if (options.privateHome) privateSignInEnv(launchEnv, kind)
    const child = spawn(binary, args, { env: launchEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
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
        void rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      }
    })
    // The launcher starts the real agent and its local harness: closing ends all of them.
    connection.child = treeKilledChild(child)
    return connection
  }
}
