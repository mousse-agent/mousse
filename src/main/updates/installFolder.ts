import { execFile } from 'node:child_process'
import { basename, join } from 'node:path'

/** A process whose executable is inside the install folder. */
export interface InstallFolderProcess {
  pid: number
  parentPid: number
  path: string
  commandLine: string
}

/** A process with a Mousse executable name whose path this user cannot see (one running elevated, or as another user). */
export interface HiddenProcess {
  pid: number
  name: string
}

export interface InstallFolderListing {
  processes: InstallFolderProcess[]
  hidden: HiddenProcess[]
}

/**
 * The executables a Mousse install runs: the app (and the background service it hosts), the console copy behind
 * `mousse-cli`, the voice engine, the SSH endpoint's helper and node-pty's console hosts. Only these are stopped;
 * anything else running from the install folder (a custom folder such as `D:\Apps` holds other programs) is left
 * alone and the install waits for the user instead.
 */
export const MOUSSE_IMAGE_NAMES: readonly string[] = ['mousse.exe', 'mousse-cli.exe', 'mousse-voice.exe', 'sshd.exe', 'openconsole.exe', 'winpty-agent.exe']

export interface FreeInstallFolderOptions {
  /** This process. It quits once the installer has started. */
  selfPid: number
  /** What runs from the install folder, or null when it could not be listed. */
  list: () => Promise<InstallFolderListing | null>
  /** Asks the background service of `homeDir` to stop and waits for it, for at most `timeoutMs`. */
  stopService: (homeDir: string, timeoutMs: number) => Promise<void>
  kill: (pid: number) => void
  /** How long each other home's service may take to stop. They stop in parallel. */
  serviceStopTimeoutMs?: number
  /** How long the rest may take to exit on their own, counted from when those services stopped. */
  graceMs?: number
  /** How long killed processes may take to disappear. */
  killWaitMs?: number
  intervalMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface FreeInstallFolderResult {
  /** False when the install folder could not be listed at all; nothing was checked. */
  checked: boolean
  killed: number[]
}

const DEFAULT_SERVICE_STOP_TIMEOUT_MS = 30_000
const DEFAULT_GRACE_MS = 5_000
const DEFAULT_KILL_WAIT_MS = 10_000
const DEFAULT_INTERVAL_MS = 250

/** Chromium starts its renderer, GPU and utility processes with `--type=…`. */
function isChromiumHelper(process: InstallFolderProcess): boolean {
  return /(^|\s)--type=/.test(process.commandLine)
}

function descendsFrom(process: InstallFolderProcess, ancestor: number, byPid: Map<number, InstallFolderProcess>): boolean {
  let parent = process.parentPid
  for (let depth = 0; depth < 32; depth += 1) {
    if (parent === ancestor) return true
    const next = byPid.get(parent)
    if (!next || next.pid === next.parentPid) return false
    parent = next.parentPid
  }
  return false
}

function imageName(path: string): string {
  return basename(path.replace(/\\/g, '/')).toLowerCase()
}

export function isMousseImage(path: string): boolean {
  return MOUSSE_IMAGE_NAMES.includes(imageName(path))
}

/**
 * The processes that would keep the installer from replacing the install folder. This process and its own Chromium
 * helpers end when it quits; everything else (a background service, whoever started it, a `mousse-cli` command, the
 * voice engine, another copy of Mousse, another program in a shared folder) has to be gone first.
 */
export function installFolderStragglers(processes: InstallFolderProcess[], selfPid: number): InstallFolderProcess[] {
  const byPid = new Map(processes.map((process) => [process.pid, process]))
  return processes.filter((process) => process.pid !== selfPid && !(isChromiumHelper(process) && descendsFrom(process, selfPid, byPid)))
}

/** The home of a background service (`service run --home <dir>`), or undefined for any other process. */
export function serviceHomeOf(commandLine: string): string | undefined {
  if (!/(^|\s)service\s+run(\s|$)/.test(commandLine)) return undefined
  const match = /(?:^|\s)--home(?:\s+|=)(?:"([^"]+)"|(\S+))/.exec(commandLine)
  return match?.[1] ?? match?.[2]
}

function describe(processes: InstallFolderProcess[]): string {
  return processes.map((process) => `${basename(process.path.replace(/\\/g, '/'))} ${process.pid}`).join(', ')
}

/** Mousse's own stragglers, which may be stopped, and other programs' processes, which may not. */
function classify(listing: InstallFolderListing, selfPid: number): { mousse: InstallFolderProcess[]; foreign: InstallFolderProcess[] } {
  const stragglers = installFolderStragglers(listing.processes, selfPid)
  return {
    mousse: stragglers.filter((process) => isMousseImage(process.path)),
    foreign: stragglers.filter((process) => !isMousseImage(process.path))
  }
}

function foreignError(foreign: InstallFolderProcess[]): Error {
  return new Error(`Other programs are running from the Mousse install folder (${describe(foreign)}). Close them, then try the update again.`)
}

/**
 * Stops every Mousse process running from the install folder except this one and its own helpers, then confirms
 * the folder is free. Services of other homes are asked to stop first, all at once; whatever is still there after
 * `graceMs` is killed. Throws, so the installer is not started against files in use, when a process cannot be
 * killed, when another program runs from the folder, or when the folder cannot be listed again to confirm it is free.
 */
export async function freeInstallFolder(options: FreeInstallFolderOptions): Promise<FreeInstallFolderResult> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS

  const first = await options.list()
  if (!first) return { checked: false, killed: [] }
  if (first.hidden.length > 0) {
    console.warn(`Mousse cannot see where ${first.hidden.length} of its processes run from (${first.hidden.map((process) => `${process.name} ${process.pid}`).join(', ')}); if they run from the install folder, the installer may not be able to replace it.`)
  }
  let state = classify(first, options.selfPid)
  // Nothing is stopped when the install cannot go ahead anyway.
  if (state.foreign.length > 0) throw foreignError(state.foreign)
  if (state.mousse.length === 0) return { checked: true, killed: [] }

  // Services of other homes (another client's, an earlier session's) stop cleanly when asked; each gets the full
  // stop time, at once, and the grace period starts once they have.
  const homes = new Set(state.mousse.map((process) => serviceHomeOf(process.commandLine)).filter((home): home is string => Boolean(home)))
  const stopTimeoutMs = options.serviceStopTimeoutMs ?? DEFAULT_SERVICE_STOP_TIMEOUT_MS
  await Promise.all([...homes].map(async (home) => {
    try {
      await options.stopService(home, stopTimeoutMs)
    } catch (error) {
      console.warn(`The Mousse service of ${home} did not stop when asked:`, error instanceof Error ? error.message : String(error))
    }
  }))

  /** Lists again; null when that failed, which never counts as free. */
  const relist = async (): Promise<typeof state | null> => {
    const listing = await options.list()
    return listing ? classify(listing, options.selfPid) : null
  }

  let confirmed: typeof state | null = null
  const graceEnd = now() + (options.graceMs ?? DEFAULT_GRACE_MS)
  for (;;) {
    confirmed = await relist()
    if (confirmed) state = confirmed
    if (confirmed && confirmed.mousse.length === 0 && confirmed.foreign.length === 0) return { checked: true, killed: [] }
    if (now() >= graceEnd) break
    await sleep(intervalMs)
  }
  if (state.foreign.length > 0) throw foreignError(state.foreign)

  // Still running after their services stopped and the grace period: these are ended, never left for the installer
  // to trip over. Only a process that cannot be killed, or a folder that cannot be listed, stops the install now.
  const killed: number[] = []
  const killEnd = now() + (options.killWaitMs ?? DEFAULT_KILL_WAIT_MS)
  for (;;) {
    for (const process of state.mousse) {
      try {
        options.kill(process.pid)
      } catch {
        /* Already gone, or not ours to end: the next listing tells. */
      }
      if (!killed.includes(process.pid)) killed.push(process.pid)
    }
    await sleep(intervalMs)
    confirmed = await relist()
    if (confirmed) state = confirmed
    if (confirmed && confirmed.mousse.length === 0 && confirmed.foreign.length === 0) return { checked: true, killed }
    if (now() >= killEnd) break
  }
  if (!confirmed) throw new Error('Mousse could not confirm that its install folder is free, so the update was not installed.')
  if (state.foreign.length > 0) throw foreignError(state.foreign)
  throw new Error(`Mousse processes are still running from the install folder (${describe(state.mousse)}), so the update was not installed.`)
}

/** Makes Windows PowerShell 5.1 write UTF-8 (no byte order mark) instead of the console's OEM code page. */
const UTF8_OUTPUT = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false'

const LIST_SCRIPT = [
  "$dir = $env:MOUSSE_INSTALL_DIR.TrimEnd('\\') + '\\'",
  `$names = @(${MOUSSE_IMAGE_NAMES.map((name) => `'${name}'`).join(', ')})`,
  '$all = @(Get-CimInstance -ClassName Win32_Process)',
  '$found = @($all | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($dir, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; path = [string]$_.ExecutablePath; commandLine = [string]$_.CommandLine } })',
  '$hidden = @($all | Where-Object { -not $_.ExecutablePath -and $names -contains $_.Name.ToLowerInvariant() } | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; name = [string]$_.Name } })',
  'ConvertTo-Json -Compress -Depth 4 -InputObject ([pscustomobject]@{ processes = $found; hidden = $hidden })'
].join('; ')

function asArray(value: unknown): unknown[] {
  if (value === null || value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

/** Reads the listing script's output. Throws on anything that is not its JSON. */
export function parseListing(stdout: string): InstallFolderListing {
  const text = stdout.replace(/^\uFEFF/, '').trim()
  if (!text) throw new Error('The process listing printed nothing')
  const parsed = JSON.parse(text) as { processes?: unknown; hidden?: unknown } | null
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The process listing is not an object')
  const processes = asArray(parsed.processes).flatMap((row) => {
    const value = row as Partial<InstallFolderProcess> | null
    if (!value || typeof value.pid !== 'number' || typeof value.parentPid !== 'number') return []
    return [{ pid: value.pid, parentPid: value.parentPid, path: String(value.path ?? ''), commandLine: String(value.commandLine ?? '') }]
  })
  const hidden = asArray(parsed.hidden).flatMap((row) => {
    const value = row as Partial<HiddenProcess> | null
    return value && typeof value.pid === 'number' ? [{ pid: value.pid, name: String(value.name ?? '') }] : []
  })
  return { processes, hidden }
}

/** Runs a Windows PowerShell script and returns its UTF-8 output. */
export function runPowerShell(script: string, env: NodeJS.ProcessEnv = {}): Promise<string> {
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((resolve, reject) => {
    execFile(
      powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `${UTF8_OUTPUT}; ${script}`],
      { windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, ...env } },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    )
  })
}

/**
 * Lists what runs from `installDir`. Windows only: there, a running executable cannot be replaced, so the installer
 * fails while one runs. An AppImage is replaced by a rename, which running copies do not block, and macOS does not
 * update itself; both return null.
 */
export async function listInstallFolderProcesses(installDir: string, platform: NodeJS.Platform = process.platform): Promise<InstallFolderListing | null> {
  if (platform !== 'win32') return null
  try {
    return parseListing(await runPowerShell(LIST_SCRIPT, { MOUSSE_INSTALL_DIR: installDir }))
  } catch (error) {
    console.warn('Mousse could not list the processes of its install folder:', error instanceof Error ? error.message : String(error))
    return null
  }
}
