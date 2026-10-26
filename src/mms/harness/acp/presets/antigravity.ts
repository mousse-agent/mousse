import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Transform } from 'node:stream'
import type { ProviderCapabilities } from '../../../run/adapters/ProviderAdapter'
import { ACP_BASE_CAPABILITIES } from '../capabilities'
import { connectAcpProcess, type AcpConnectionFactory } from '../connection'
import type { AcpQuirks } from '../quirks'

/**
 * Google's Antigravity agent as an ACP preset: its launch environment (an isolated `GEMINI_HOME`,
 * a `BROWSER` helper that hands the sign-in link to Mousse), the sign-in line it prints on ACP
 * stdout, the owned loopback callback, eager `oauth-personal` sign-in and resuming saved sessions.
 */

export const ANTIGRAVITY_LABEL = 'Antigravity'

/** The agent rejects plan mode and publishes no usage: the base ACP capabilities. */
export const ANTIGRAVITY_CAPABILITIES: ProviderCapabilities = ACP_BASE_CAPABILITIES

/**
 * Client fs with the workspace check, `session/resume` for saved sessions, its exact protocol
 * version, and the `model` option with the account's listed models only.
 */
export const ANTIGRAVITY_QUIRKS: AcpQuirks = Object.freeze({ clientFs: true, preferResume: true, strictProtocol: true, modelConfigId: 'model' })

/** The method `authenticate` signs in with, eagerly, before the first `session/new`. */
export const ANTIGRAVITY_AUTH_METHOD = 'oauth-personal'

const AUTH_PREFIX = 'Open the following link to authenticate the ACP server: '
const BROWSER_MARKER = '__MOUSSE_ANTIGRAVITY_AUTH_URL__'
const ISOLATED_KEYS = [
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION', 'GOOGLE_CLOUD_QUOTA_PROJECT', 'GOOGLE_GENAI_USE_VERTEXAI',
  'GCLOUD_PROJECT', 'CLOUDSDK_CORE_PROJECT', 'AGY_ACP_CCPA_PROJECT', 'AGY_ACP_ENABLE_OAUTH',
  'GEMINI_HOME', 'AGY_ACP_FORCE_FILE_STORAGE', 'ANTIGRAVITY_HARNESS_PATH', 'ELECTRON_RUN_AS_NODE',
  'BROWSER', 'PYTHONUNBUFFERED'
]

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

export interface AntigravityLaunchOptions {
  /** `<profileHome>/providers/antigravity`: the isolated home and the browser helper live here. */
  profileDir: string
  profileHome: string
  /** The verified install or the manual agent path; undefined when there is none. */
  binary(): string | undefined
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
    const binary = options.binary()
    if (!binary) throw new Error('Install Google Antigravity or select its official ACP binary first')
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (ISOLATED_KEYS.includes(key.toUpperCase())) delete env[key]
    const geminiHome = join(options.profileDir, 'gemini-home')
    mkdirSync(geminiHome, { recursive: true, mode: 0o700 })
    const acpDir = join(geminiHome, 'antigravity-acp')
    mkdirSync(acpDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(acpDir, 'settings.json'), JSON.stringify({ auth: { type: ANTIGRAVITY_AUTH_METHOD } }), { mode: 0o600 })
    for (const part of [['config', 'skills'], ['antigravity-cli', 'skills']]) {
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
    env.AGY_ACP_FORCE_FILE_STORAGE = '1'
    env.ANTIGRAVITY_HARNESS_PATH = join(dirname(binary), process.platform === 'win32' ? 'localharness_external.exe' : 'localharness_external')
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
    const args = [...(process.platform === 'linux' ? ['--uid='] : []), ...options.args()]
    const child = spawn(binary, args, { env: options.env(env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const acceptAuthUrl = (url: string) => {
      if (callbackTarget(url)) request.onAuthUrl?.(url)
    }
    return connectAcpProcess(child, request.handlers, {
      stdout: antigravityStdout(acceptAuthUrl),
      stderrLine: (line) => {
        const url = line.startsWith(AUTH_PREFIX) ? line.slice(AUTH_PREFIX.length)
          : line.startsWith(BROWSER_MARKER) ? line.slice(BROWSER_MARKER.length) : undefined
        if (url) acceptAuthUrl(url)
      },
      onExit: () => {
        request.onExit?.()
        void rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      }
    })
  }
}
