import { statSync } from 'node:fs'
import { win32 } from 'node:path'
import { execFileGit } from './gitSpawn'

/**
 * The Git program Mousse starts, and the environment it starts it with.
 *
 * On Windows, Git for Windows puts only `<root>\cmd` on PATH. `<root>\cmd\git.exe` is a launcher: it sets up the
 * environment and starts the real `<root>\mingw64\bin\git.exe`, so every command costs two process starts. Mousse runs
 * the real one instead, with the environment the launcher would have given it (see {@link withLauncherEnvironment}).
 *
 * The real one is used only for the standard layout, once both it and the launcher report the same `--exec-path` inside
 * that install. Any other layout (a shim, a portable or scoop install, a missing sibling, a mismatch) runs the launcher
 * found on PATH by its absolute path. Until that check is done (it runs once, in the background, on the first Git
 * command) the launcher runs, so nothing waits for it. macOS and Linux run `git` as before.
 *
 * Every Git process Mousse starts goes through {@link gitFile} and {@link gitEnvFor}.
 */

/** The program Git runs as, and the install it belongs to. */
export interface ResolvedGit {
  file: string
  /** Set when `file` is the real Git of the install at this root: its environment gets the launcher's additions. */
  root?: string
}

/** What resolving reads from the machine; tests replace it. */
export interface GitLocatorDeps {
  platform: NodeJS.Platform
  path: string | undefined
  isFile(path: string): boolean
  /** `<file> --exec-path`, trimmed; undefined when it fails. */
  execPath(file: string): Promise<string | undefined>
}

/** The `git` a bare name finds on `pathValue`, as an absolute path: the first folder with `git.com` or `git.exe`. */
export function findGitOnPath(pathValue: string | undefined, isFile: (path: string) => boolean): string | undefined {
  for (const raw of (pathValue ?? '').split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1')
    // A relative entry would name a folder below wherever Git runs: never one to take a program from.
    if (!dir || !win32.isAbsolute(dir)) continue
    for (const name of ['git.com', 'git.exe']) {
      const candidate = win32.join(dir, name)
      if (isFile(candidate)) return candidate
    }
  }
  return undefined
}

/** The install root of a Git for Windows launcher (`<root>\cmd\git.exe`), or undefined for any other layout. */
export function launcherRoot(launcher: string): string | undefined {
  const dir = win32.dirname(launcher)
  if (win32.basename(launcher).toLowerCase() !== 'git.exe' || win32.basename(dir).toLowerCase() !== 'cmd') return undefined
  return win32.dirname(dir)
}

const samePath = (a: string | undefined, b: string): boolean =>
  a !== undefined && win32.normalize(a).replace(/[\\/]+$/, '').toLowerCase() === win32.normalize(b).replace(/[\\/]+$/, '').toLowerCase()

/** The first answer, known without running anything: the launcher on PATH, or the real Git still to be confirmed. */
function locate(deps: GitLocatorDeps): { interim: ResolvedGit; candidate?: { real: string; launcher: string; root: string } } {
  if (deps.platform !== 'win32') return { interim: { file: 'git' } }
  const launcher = findGitOnPath(deps.path, deps.isFile)
  // No Git on PATH: there is nothing better to name, and starting it fails as it did before.
  if (!launcher) return { interim: { file: 'git' } }
  const root = launcherRoot(launcher)
  const real = root && win32.join(root, 'mingw64', 'bin', 'git.exe')
  if (!root || !real || !deps.isFile(real)) return { interim: { file: launcher } }
  return { interim: { file: launcher }, candidate: { real, launcher, root } }
}

async function confirm(candidate: { real: string; launcher: string; root: string }, deps: GitLocatorDeps): Promise<ResolvedGit> {
  const expected = win32.join(candidate.root, 'mingw64', 'libexec', 'git-core')
  const [real, launched] = await Promise.all([deps.execPath(candidate.real), deps.execPath(candidate.launcher)])
  return samePath(real, expected) && samePath(launched, expected) ? { file: candidate.real, root: candidate.root } : { file: candidate.launcher }
}

/** The program Git runs as on this machine, worked out in full (for tests and measurement). */
export async function resolveGitProgram(deps: GitLocatorDeps): Promise<ResolvedGit> {
  const { interim, candidate } = locate(deps)
  return candidate ? await confirm(candidate, deps) : interim
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile() } catch { return false }
}

const directories = new Map<string, boolean>()
function isDirectory(path: string): boolean {
  let known = directories.get(path)
  if (known === undefined) {
    try { known = statSync(path).isDirectory() } catch { known = false }
    directories.set(path, known)
  }
  return known
}

function runExecPath(file: string): Promise<string | undefined> {
  return new Promise((settle) => {
    execFileGit(file, ['--exec-path'], { windowsHide: true, encoding: 'utf8', timeout: 15_000, cwd: win32.dirname(file) }, (error, stdout) => settle(error ? undefined : stdout.trim()))
  })
}

const machine = (): GitLocatorDeps => ({ platform: process.platform, path: process.env.PATH, isFile, execPath: runExecPath })

let settled: ResolvedGit | undefined
let interim: ResolvedGit | undefined
let confirming: Promise<void> | undefined

function current(): ResolvedGit {
  if (settled) return settled
  if (!interim) {
    const deps = machine()
    const found = locate(deps)
    interim = found.interim
    if (!found.candidate) settled = found.interim
    else confirming = confirm(found.candidate, deps).then((resolved) => { settled = resolved }, () => { settled = found.interim })
  }
  return interim
}

/** Settles once the check started by the first Git command is done (immediately when none is running). */
export function gitProgramSettled(): Promise<void> {
  current()
  return confirming ?? Promise.resolve()
}

/** Forgets what was resolved, for tests. */
export function resetGitProgram(): void {
  settled = undefined
  interim = undefined
  confirming = undefined
  directories.clear()
}

function keyOf(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const upper = name.toUpperCase()
  return Object.keys(env).find((key) => key.toUpperCase() === upper)
}

/**
 * `env` with what Git for Windows' launcher adds before it starts `<root>\mingw64\bin\git.exe` (as Git 2.55 does it):
 * `MSYSTEM=MINGW64`, `PLINK_PROTOCOL=ssh` and `HOME` (`HOMEDRIVE`+`HOMEPATH` when that folder exists, else
 * `USERPROFILE`), each only when unset, and PATH led by `<root>\mingw64\bin`, `<root>\usr\bin` and `%HOME%\bin`, the
 * caller's PATH after them. Names are matched as Windows matches them, without regard to case.
 */
export function withLauncherEnvironment(env: NodeJS.ProcessEnv, root: string, folderExists: (path: string) => boolean = isDirectory): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  const get = (name: string): string | undefined => {
    const key = keyOf(out, name)
    const value = key === undefined ? undefined : out[key]
    return value ? value : undefined
  }
  const set = (name: string, value: string): void => { out[keyOf(out, name) ?? name] = value }
  if (!get('MSYSTEM')) set('MSYSTEM', 'MINGW64')
  if (!get('PLINK_PROTOCOL')) set('PLINK_PROTOCOL', 'ssh')
  if (!get('HOME')) {
    const homePath = get('HOMEPATH')
    const fromDrive = homePath ? `${get('HOMEDRIVE') ?? ''}${homePath}` : undefined
    const home = fromDrive && folderExists(fromDrive) ? fromDrive : get('USERPROFILE')
    if (home) set('HOME', home)
  }
  const home = get('HOME')
  const lead = [win32.join(root, 'mingw64', 'bin'), win32.join(root, 'usr', 'bin'), ...(home ? [win32.join(home, 'bin')] : [])]
  const path = get('PATH')
  set('PATH', [...lead, ...(path ? [path] : [])].join(';'))
  return out
}

/**
 * The program to start for Git: the real Git for Windows executable, or the launcher on PATH by its absolute path, or
 * `git` off Windows. Pass the environment through {@link gitEnvFor} in the same synchronous step, so both describe the
 * same program.
 */
export function gitFile(): string {
  return current().file
}

/** `env` (the process's own when undefined) as the program {@link gitFile} names needs it; returned as is when nothing is added. */
export function gitEnvFor<T extends NodeJS.ProcessEnv | undefined>(env: T): T | NodeJS.ProcessEnv {
  const resolved = current()
  return resolved.root ? withLauncherEnvironment(env ?? process.env, resolved.root) : env
}

/** simple-git's own check of a custom binary: a path outside these characters is "unsafe" to it, and warns on each use. */
const SIMPLE_GIT_SAFE_BINARY = /^([a-z]:)?([a-z0-9/.\\_~-]+)$/i

/**
 * A simple-git instance made by `make` with the options that run {@link gitFile}; give it an environment through
 * {@link gitEnvFor} in the same synchronous step. A path simple-git calls unsafe (one with a
 * space, as under Program Files) is one Mousse resolved itself, so it is allowed, and the warning simple-git prints for
 * it on every instance is kept out of the log.
 */
export function simpleGitWithProgram<T>(make: (options: { binary?: string; allowUnsafeCustomBinary?: boolean }) => T): T {
  const file = gitFile()
  if (file === 'git') return make({})
  if (SIMPLE_GIT_SAFE_BINARY.test(file)) return make({ binary: file })
  const warn = console.warn
  console.warn = (...values: unknown[]) => {
    if (typeof values[0] === 'string' && values[0].startsWith('Invalid value supplied for custom binary')) return
    warn.apply(console, values)
  }
  try { return make({ binary: file, allowUnsafeCustomBinary: true }) } finally { console.warn = warn }
}
