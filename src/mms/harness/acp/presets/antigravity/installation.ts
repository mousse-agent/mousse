import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * Google's 1.1.1 ACP server, which Mousse installed before it ran `agy`. Mousse no longer installs it;
 * an install made earlier is recognised by these digests and sizes, and runs until `agy` is installed.
 */
export const ANTIGRAVITY_RELEASE = 'agy_acp_server_1.1.1'
type Release = { url: string; sha256: string; archiveSize: number; agentSize: number; helperSize: number }
const RELEASES: Record<string, Release> = {
  'linux-x64': { url: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-x86_64.zip', sha256: '38f62d01b32deb0907b3d39a71ec301fd36369f6ffd1cf262d4af385177f79df', archiveSize: 681969407, agentSize: 1880360328, helperSize: 128966920 },
  'linux-arm64': { url: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-arm64.zip', sha256: 'ed69e64b308fcb123ab54bf3277bf9cb0d651064f885ea5aab0ff520c7175398', archiveSize: 656572786, agentSize: 1862073131, helperSize: 122158704 },
  'darwin-arm64': { url: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-agy_acp_server_1.1.1-darwin-arm64.zip', sha256: 'fdfa915652cdb7ba8085cc8fffed072cbe009251aa2c951aabdda07a8c28a189', archiveSize: 316014828, agentSize: 802163856, helperSize: 116766704 },
  'win32-x64': { url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-x86_64.zip', sha256: '47cb50eef14f0a4655d78cfcfda869bcea7aaee5f9787e936bc2935ea612c3b8', archiveSize: 468238392, agentSize: 430801616, helperSize: 130971800 },
  'win32-arm64': { url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-arm64.zip', sha256: '35f4b1f47ba6a3fea7b0a3e30010df5ea73a64b4f0e7cf991cddc673ddfbcafc', archiveSize: 468521191, agentSize: 435075816, helperSize: 122455704 }
}

const executable = (): string => process.platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par'
const helper = (): string => process.platform === 'win32' ? 'localharness_external.exe' : 'localharness_external'
export const releaseDirectory = (installationHome: string): string => join(installationHome, 'providers', 'antigravity', ANTIGRAVITY_RELEASE, `${process.platform}-${process.arch}`)

export function installedAntigravityBinary(installationHome: string): string | undefined {
  const dir = releaseDirectory(installationHome)
  const activePath = join(dirname(dir), 'active.json')
  const manifest = join(dir, 'verified.json')
  const agent = join(dir, executable())
  const harness = join(dir, helper())
  if (!existsSync(activePath) || !existsSync(manifest) || !existsSync(agent) || !existsSync(harness)) return undefined
  try {
    const active = JSON.parse(readFileSync(activePath, 'utf8')) as { version?: string; platform?: string }
    const data = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string; sha256?: string }
    const pin = RELEASES[`${process.platform}-${process.arch}`]
    if (active.version !== ANTIGRAVITY_RELEASE || active.platform !== `${process.platform}-${process.arch}`) return undefined
    if (data.version !== ANTIGRAVITY_RELEASE || data.sha256 !== pin?.sha256) return undefined
    if (statSync(agent).size !== pin.agentSize || statSync(harness).size !== pin.helperSize) return undefined
    return agent
  } catch { return undefined }
}

/** A manual 1.1.1 server must sit beside Google's matched local harness. */
export function validateManualAntigravityBinary(path: string): string {
  const agent = resolve(path)
  if (!existsSync(agent) || !existsSync(join(dirname(agent), helper())) || !agent.endsWith(executable())) {
    throw new Error(`Select agy, or Google's ${executable()} beside ${helper()}.`)
  }
  return agent
}

/** Google's CLI under the names it ships with: `agy` installed, `antigravity` in its download. */
const AGY_NAME = /^(agy|antigravity)(\.exe)?$/i

/**
 * What a manual executable path runs: Google's `agy` CLI as `agy acp`, or the 1.1.1 ACP server
 * beside its local harness. Throws for anything else.
 */
export function manualAntigravityRuntime(path: string): { kind: 'legacy' | 'native'; binary: string } {
  const binary = resolve(path)
  if (AGY_NAME.test(basename(binary))) {
    try {
      if (statSync(binary).isFile()) return { kind: 'native', binary }
    } catch { /* reported below */ }
    throw new Error(`Mousse cannot find ${binary}.`)
  }
  return { kind: 'legacy', binary: validateManualAntigravityBinary(binary) }
}

/** Installs running right now, keyed by release directory: a shared installation downloads once. */
const activeInstalls = new Map<string, { abort: AbortController; progress?: string }>()

export type AntigravityInstallEvent = { type: 'started' | 'finished' } | { type: 'progress'; message: string }
const installEvents = new EventEmitter()
// One listener per live profile of the installation; there is no fixed limit.
installEvents.setMaxListeners(0)

/**
 * Hears about installs into this installation, whichever profile started them: every profile
 * shares the download, so each one tells its own clients. Returns the unsubscribe.
 */
export function onAntigravityInstallEvent(installationHome: string, listener: (event: AntigravityInstallEvent) => void): () => void {
  const key = releaseDirectory(installationHome)
  installEvents.on(key, listener)
  return () => { installEvents.off(key, listener) }
}

function announce(key: string, event: AntigravityInstallEvent): void {
  for (const listener of installEvents.listeners(key)) {
    try { (listener as (event: AntigravityInstallEvent) => void)(event) } catch { /* a listener must not break the install */ }
  }
}

/** Whether an install into this installation is running, with its latest progress line. */
export function antigravityInstallState(installationHome: string): { installing: boolean; progress?: string } {
  const active = activeInstalls.get(releaseDirectory(installationHome))
  return active ? { installing: true, ...(active.progress ? { progress: active.progress } : {}) } : { installing: false }
}

/** Stops the install running in this installation, whichever profile started it; false when none runs. */
export function cancelAntigravityInstall(installationHome: string): boolean {
  const active = activeInstalls.get(releaseDirectory(installationHome))
  if (!active) return false
  active.abort.abort(new DOMException('Antigravity install cancelled', 'AbortError'))
  return true
}

/** Install progress: a line, the fraction done, and the bytes received of the download's size. */
export type AntigravityInstallProgress = (message: string, fraction?: number, bytes?: { receivedBytes: number; totalBytes: number }) => void

/**
 * Runs `work`, an install into this installation, as the one install every profile sees: one runs
 * per installation (a second caller is rejected), every profile hears it start, progress and end,
 * and any profile may cancel it.
 */
export async function runSharedAntigravityInstall<T>(installationHome: string, signal: AbortSignal | undefined, progress: AntigravityInstallProgress | undefined,
  work: (signal: AbortSignal, progress: AntigravityInstallProgress) => Promise<T>): Promise<T> {
  const key = releaseDirectory(installationHome)
  if (activeInstalls.has(key)) throw new Error('Antigravity is already being installed')
  const active: { abort: AbortController; progress?: string } = { abort: new AbortController() }
  activeInstalls.set(key, active)
  announce(key, { type: 'started' })
  const forward = () => active.abort.abort(signal?.reason)
  if (signal?.aborted) forward()
  else signal?.addEventListener('abort', forward, { once: true })
  try {
    return await work(active.abort.signal, (message, fraction, bytes) => {
      active.progress = message
      progress?.(message, fraction, bytes)
      announce(key, { type: 'progress', message })
    })
  } finally {
    signal?.removeEventListener('abort', forward)
    activeInstalls.delete(key)
    announce(key, { type: 'finished' })
  }
}
