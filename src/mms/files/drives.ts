import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'

/** A place the Files panel offers at the top of its path: a drive, a mounted volume or the system root. */
export interface FilesPlace {
  path: string
  label: string
}

export interface FilesPlaces {
  home: string
  drives: FilesPlace[]
}

/** How long a folder of mounts (`/Volumes`, `/mnt`) may take to answer before it is left out. */
const MOUNTS_ANSWER_MS = 1_500
/** How long the Windows drive list may take; a slower answer falls back to the system drive. */
const WINDOWS_LIST_MS = 4_000
/** How long a drive list is reused, so opening the menu again does not start another process. */
const REUSE_MS = 10_000

function answersWithin<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((settle) => {
    const timer = setTimeout(() => settle(undefined), ms)
    void work.then((value) => { clearTimeout(timer); settle(value) }, () => { clearTimeout(timer); settle(undefined) })
  })
}

/**
 * One line per drive: `C:\|Fixed|True`. The list itself comes from the drive letters Windows has assigned and
 * touches no drive. Readiness is asked of local drives only (an empty card reader or DVD drive is left out);
 * a network drive is listed without being reached, because a disconnected one can hang for a minute. Opening
 * it then goes through the daemon's folder check, which fails at once while the drive does not answer.
 */
const WINDOWS_DRIVES_SCRIPT =
  "[System.IO.DriveInfo]::GetDrives() | ForEach-Object { $_.Name + '|' + $_.DriveType + '|' + $(if ($_.DriveType -eq 'Network') { 'Unknown' } else { $_.IsReady }) }"

/** Parses the script's lines into places; anything else in the output is ignored. */
export function parseWindowsDrives(output: string): FilesPlace[] {
  const drives: FilesPlace[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^([A-Za-z]):\\\|(\w+)\|(\w+)$/.exec(line.trim())
    if (!match || match[3] === 'False') continue
    const letter = match[1]!.toUpperCase()
    drives.push({ path: `${letter}:\\`, label: `${letter}:` })
  }
  return drives
}

function systemDrive(): FilesPlace[] {
  const letter = /^([A-Za-z]):/.exec(process.env.SystemDrive ?? 'C:')?.[1]?.toUpperCase() ?? 'C'
  return [{ path: `${letter}:\\`, label: `${letter}:` }]
}

/**
 * The drive letters, from a short PowerShell run with a time limit. It runs in its own process, so a drive
 * that hangs holds none of the daemon's file threads, and the full path keeps a `powershell.exe` elsewhere
 * on PATH from answering.
 */
function windowsDrives(): Promise<FilesPlace[]> {
  const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((settle) => {
    execFile(
      shell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_DRIVES_SCRIPT],
      { encoding: 'utf8', windowsHide: true, timeout: WINDOWS_LIST_MS, killSignal: 'SIGKILL' },
      (error, stdout) => {
        const drives = error ? [] : parseWindowsDrives(stdout)
        settle(drives.length ? drives : systemDrive())
      }
    )
  })
}

/** The folders directly inside `parent`, as places; none when it cannot be read in time. */
async function mountsIn(parent: string): Promise<FilesPlace[]> {
  const entries = await answersWithin(readdir(parent, { withFileTypes: true }), MOUNTS_ANSWER_MS) ?? []
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .slice(0, 32)
    .map((entry) => ({ path: join(parent, entry.name), label: entry.name }))
}

async function readPlaces(platform: NodeJS.Platform): Promise<FilesPlaces> {
  const home = homedir()
  if (platform === 'win32') return { home, drives: await windowsDrives() }
  const root: FilesPlace = { path: '/', label: '/' }
  if (platform === 'darwin') return { home, drives: [root, ...await mountsIn('/Volumes')] }
  let user = ''
  try { user = userInfo().username } catch { /* no user name: the per-user mount folders are skipped */ }
  const mounts = await Promise.all([
    mountsIn('/mnt'),
    user ? mountsIn(join('/media', user)) : Promise.resolve([]),
    user ? mountsIn(join('/run/media', user)) : Promise.resolve([])
  ])
  return { home, drives: [root, ...mounts.flat()] }
}

let reused: { platform: NodeJS.Platform; at: number; places: Promise<FilesPlaces> } | undefined

/**
 * The drives (Windows) or the root and mounted volumes (macOS, Linux) of this computer, and its home
 * folder. Only lists them: what a folder holds is still read through `files.list`. Calls close together
 * share one list.
 */
export function listFilesPlaces(platform: NodeJS.Platform = process.platform, now = Date.now()): Promise<FilesPlaces> {
  if (reused && reused.platform === platform && now - reused.at < REUSE_MS) return reused.places
  const places = readPlaces(platform)
  reused = { platform, at: now, places }
  return places
}

/** Forgets the reused list (for tests). */
export function forgetFilesPlaces(): void {
  reused = undefined
}
