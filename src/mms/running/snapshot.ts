import { execFile } from 'node:child_process'
import { readlink } from 'node:fs/promises'

/**
 * What runs on this computer right now, read only when a running list is built (`RunningRegistry`): every process with
 * its parent and start, the TCP ports processes listen on, and, for a few processes, their working folder. Each reader
 * is one short command per platform (macOS, Linux, Windows) and gives up quietly: undefined when it cannot read.
 */

export interface ProcessRow {
  pid: number
  ppid: number
  /** POSIX: the process group, and its terminal's foreground group (0 or less: no terminal). */
  pgid?: number
  tpgid?: number
  /** When it started (ms since the epoch), to the second. */
  startedAt?: number
  command: string
}

export interface ListeningPort {
  pid: number
  /** As the system names it: `127.0.0.1`, `::1`, `*`, `0.0.0.0`, `::` or another address. */
  host: string
  port: number
}

const READ_TIMEOUT_MS = 3_000

function run(file: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { windowsHide: true, timeout: READ_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
        // `lsof` exits 1 when one of the processes it was asked about is gone: what it printed still holds.
        if (error && !stdout) resolve(undefined)
        else resolve(stdout)
      })
    } catch {
      resolve(undefined)
    }
  })
}

// ------------------------------------------------------------------ processes

const WINDOWS_PROCESS_SCRIPT = [
  '$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  "$ErrorActionPreference = 'Stop'",
  "Get-CimInstance -ClassName Win32_Process | ForEach-Object { $s = 0; if ($_.CreationDate) { $s = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }; '{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, $s, ($_.CommandLine -replace '[\\r\\n]+', ' ') }"
].join('; ')

export function processTableCommand(platform: NodeJS.Platform): { file: string; args: string[] } {
  if (platform === 'win32') return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_SCRIPT] }
  // `-ww`: the whole command line. `etime`: how long it has run ([[dd-]hh:]mm:ss), on macOS and Linux alike.
  return { file: 'ps', args: ['-A', '-ww', '-o', 'pid=,ppid=,pgid=,tpgid=,etime=,args='] }
}

/** Seconds in a `ps` elapsed time (`[[dd-]hh:]mm:ss`), or undefined. */
export function elapsedSeconds(etime: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim())
  if (!match) return undefined
  const [, days, hours, minutes, seconds] = match
  return Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds)
}

/** `ps -o pid=,ppid=,pgid=,tpgid=,etime=,args=` read at `now`. */
export function parsePosixProcessTable(stdout: string, now: number): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s?(.*)$/.exec(line)
    if (!match) continue
    const elapsed = elapsedSeconds(match[5]!)
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      tpgid: Number(match[4]),
      ...(elapsed !== undefined ? { startedAt: now - elapsed * 1_000 } : {}),
      command: match[6]!.trim()
    })
  }
  return rows
}

/** The Windows listing: `pid ppid startMs command line`. */
export function parseWindowsProcessTable(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s?(.*)$/.exec(line)
    if (!match) continue
    const started = Number(match[3])
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), ...(started > 0 ? { startedAt: started } : {}), command: match[4]!.trim() })
  }
  return rows
}

export async function readProcessTable(platform: NodeJS.Platform = process.platform, now = Date.now()): Promise<ProcessRow[] | undefined> {
  const { file, args } = processTableCommand(platform)
  const stdout = await run(file, args)
  if (stdout === undefined) return undefined
  const rows = platform === 'win32' ? parseWindowsProcessTable(stdout) : parsePosixProcessTable(stdout, now)
  return rows.length ? rows : undefined
}

// ------------------------------------------------------------------ listening ports

/** `host:port` as `lsof`, `ss` and `netstat` print it (`[::1]:5173`, `*:3000`, `127.0.0.53%lo:53`). */
export function splitHostPort(text: string): { host: string; port: number } | undefined {
  const match = /^(.*):(\d+)$/.exec(text.trim())
  if (!match) return undefined
  const port = Number(match[2])
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return undefined
  const host = match[1]!.replace(/^\[(.*)\]$/, '$1').replace(/%.*$/, '')
  return { host: host || '*', port }
}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpn`: a `p<pid>` line, then `n<host:port>` lines for its sockets. */
export function parseLsofListeners(stdout: string): ListeningPort[] {
  const out: ListeningPort[] = []
  let pid: number | undefined
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('p')) pid = Number(line.slice(1)) || undefined
    else if (line.startsWith('n') && pid) {
      const address = splitHostPort(line.slice(1))
      if (address) out.push({ pid, ...address })
    }
  }
  return out
}

/** `ss -ltnpH`: `LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=1234,fd=23))`. */
export function parseSsListeners(stdout: string): ListeningPort[] {
  const out: ListeningPort[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/)
    if (columns.length < 5 || columns[0] !== 'LISTEN') continue
    const address = splitHostPort(columns[3]!)
    if (!address) continue
    for (const match of line.matchAll(/pid=(\d+)/g)) out.push({ pid: Number(match[1]), ...address })
  }
  return out
}

/**
 * `netstat -ano`: `TCP 0.0.0.0:5173 0.0.0.0:0 LISTENING 1234`. A TCP row whose remote end is all zeros is a listening
 * socket; the state's name is not read, since Windows translates it.
 */
export function parseNetstatListeners(stdout: string): ListeningPort[] {
  const out: ListeningPort[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/)
    if (columns.length < 5 || columns[0]!.toUpperCase() !== 'TCP') continue
    if (!/^(0\.0\.0\.0|\[::\]|\*):(0|\*)$/.test(columns[2]!)) continue
    const address = splitHostPort(columns[1]!)
    const pid = Number(columns[columns.length - 1])
    if (address && Number.isInteger(pid) && pid > 0) out.push({ pid, ...address })
  }
  return out
}

export async function readListeningPorts(platform: NodeJS.Platform = process.platform): Promise<ListeningPort[] | undefined> {
  if (platform === 'win32') {
    const stdout = await run('netstat', ['-ano'])
    return stdout === undefined ? undefined : parseNetstatListeners(stdout)
  }
  if (platform === 'linux') {
    const stdout = await run('ss', ['-ltnpH'])
    if (stdout !== undefined) return parseSsListeners(stdout)
  }
  const stdout = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'])
  return stdout === undefined ? undefined : parseLsofListeners(stdout)
}

// ------------------------------------------------------------------ working folders

/** `lsof -a -d cwd -p <pids> -Fpn`: a `p<pid>` line, then `n<folder>`. */
export function parseLsofCwds(stdout: string): Map<number, string> {
  const out = new Map<number, string>()
  let pid: number | undefined
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('p')) pid = Number(line.slice(1)) || undefined
    else if (line.startsWith('n') && pid && !out.has(pid)) out.set(pid, line.slice(1))
  }
  return out
}

/** The working folder of each of `pids` that can be read: macOS and Linux. Windows does not tell another process's. */
export async function readWorkingFolders(pids: readonly number[], platform: NodeJS.Platform = process.platform): Promise<Map<number, string>> {
  if (!pids.length || platform === 'win32') return new Map()
  if (platform === 'linux') {
    const out = new Map<number, string>()
    await Promise.all(pids.map(async (pid) => {
      try { out.set(pid, await readlink(`/proc/${pid}/cwd`)) } catch { /* gone, or another user's */ }
    }))
    return out
  }
  const stdout = await run('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn'])
  return stdout === undefined ? new Map() : parseLsofCwds(stdout)
}
