import { execFile } from 'node:child_process'
import { join } from 'node:path'

/** A process whose executable is inside the install folder. */
export interface InstallFolderProcess {
  pid: number
  parentPid: number
  path: string
  commandLine: string
}

export interface FreeInstallFolderOptions {
  /** This process. It quits once the installer has started. */
  selfPid: number
  /** Processes whose executable is inside the install folder, or null when this platform cannot list them. */
  list: () => Promise<InstallFolderProcess[] | null>
  /** Asks the background service of `homeDir` to stop and waits for it. */
  stopService: (homeDir: string) => Promise<void>
  kill: (pid: number) => void
  /** How long to wait for every straggler to be gone, in all. */
  timeoutMs?: number
  /** How long a straggler may take to exit on its own before it is killed. */
  graceMs?: number
  intervalMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface FreeInstallFolderResult {
  /** False when this platform cannot list processes; nothing was checked. */
  checked: boolean
  killed: number[]
}

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_GRACE_MS = 5_000
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

/**
 * The processes that would keep the installer from replacing the install folder. This process and its own Chromium
 * helpers end when it quits; everything else (a background service, whoever started it, a `mousse-cli` command, the
 * voice engine, another copy of Mousse) has to be gone first.
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
  return processes.map((process) => `${process.pid}`).join(', ')
}

/**
 * Stops every process running from the install folder except this one and its own helpers: background services
 * are asked to stop first, anything still there after `graceMs` is killed. Resolves when none is left; throws when
 * some are still running after `timeoutMs`, so the installer is not started against files in use.
 */
export async function freeInstallFolder(options: FreeInstallFolderOptions): Promise<FreeInstallFolderResult> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const graceMs = Math.min(options.graceMs ?? DEFAULT_GRACE_MS, timeoutMs)
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const started = now()

  const listStragglers = async (): Promise<InstallFolderProcess[] | null> => {
    const processes = await options.list()
    return processes && installFolderStragglers(processes, options.selfPid)
  }

  let stragglers = await listStragglers()
  if (!stragglers) return { checked: false, killed: [] }
  if (stragglers.length === 0) return { checked: true, killed: [] }

  // Services of other homes (another client's, an earlier session's) stop cleanly when asked.
  const homes = new Set(stragglers.map((process) => serviceHomeOf(process.commandLine)).filter((home): home is string => Boolean(home)))
  for (const home of homes) {
    try {
      await options.stopService(home)
    } catch (error) {
      console.warn(`The Mousse service of ${home} did not stop when asked:`, error instanceof Error ? error.message : String(error))
    }
  }

  const killed: number[] = []
  for (;;) {
    stragglers = (await listStragglers()) ?? []
    if (stragglers.length === 0) return { checked: true, killed }
    const elapsed = now() - started
    if (elapsed >= timeoutMs) break
    if (elapsed >= graceMs) {
      for (const process of stragglers) {
        try {
          options.kill(process.pid)
        } catch {
          /* Already gone, or not ours to end: the next listing tells. */
        }
        if (!killed.includes(process.pid)) killed.push(process.pid)
      }
    }
    await sleep(intervalMs)
  }
  throw new Error(`Mousse processes are still running from the install folder (${describe(stragglers)}), so the update was not installed.`)
}

const LIST_SCRIPT = [
  "$dir = $env:MOUSSE_INSTALL_DIR.TrimEnd('\\') + '\\'",
  '$found = @(Get-CimInstance -ClassName Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($dir, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; path = [string]$_.ExecutablePath; commandLine = [string]$_.CommandLine } })',
  'ConvertTo-Json -Compress -InputObject $found'
].join('; ')

function parseListing(stdout: string): InstallFolderProcess[] {
  const text = stdout.trim()
  if (!text) return []
  const parsed = JSON.parse(text) as unknown
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows.flatMap((row) => {
    const value = row as Partial<InstallFolderProcess> | null
    if (!value || typeof value.pid !== 'number' || typeof value.parentPid !== 'number') return []
    return [{ pid: value.pid, parentPid: value.parentPid, path: String(value.path ?? ''), commandLine: String(value.commandLine ?? '') }]
  })
}

/**
 * Lists the processes running from `installDir`. Windows only: there, a running executable cannot be replaced, so
 * the installer fails while one runs. An AppImage is replaced by a rename, which running copies do not block, and
 * macOS does not update itself; both return null.
 */
export function listInstallFolderProcesses(installDir: string, platform: NodeJS.Platform = process.platform): Promise<InstallFolderProcess[] | null> {
  if (platform !== 'win32') return Promise.resolve(null)
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((resolve) => {
    execFile(
      powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', LIST_SCRIPT],
      { windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, MOUSSE_INSTALL_DIR: installDir } },
      (error, stdout) => {
        if (error) {
          console.warn('Mousse could not list the processes of its install folder:', error.message)
          resolve(null)
          return
        }
        try {
          resolve(parseListing(stdout))
        } catch (parseError) {
          console.warn('Mousse could not read the processes of its install folder:', parseError instanceof Error ? parseError.message : String(parseError))
          resolve(null)
        }
      }
    )
  })
}
