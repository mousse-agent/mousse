import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { realPathOrAncestor } from './realPath'
import { withGitConfigEnv } from '../git/gitEnv'

/**
 * What a repository reads that can run programs and that lies in the working tree, as real paths:
 * - `hookFolders`: every folder `core.hooksPath` names;
 * - `configFiles`: every file Git reads as configuration besides the repository's own (`include.path`
 *   and `includeIf.*.path` targets, whether they apply now or could later), because a `core.hooksPath` or
 *   `core.fsmonitor` in one of them runs a program on the owner's next `git status` or commit.
 */
export interface GitControl {
  hookFolders: string[]
  configFiles: string[]
}

const GIT_TIMEOUT_MS = 5_000

interface GitRun {
  status: number | null
  stdout: string
  missing: boolean
}

/** Runs Git without blocking the daemon. A non-zero exit is a result (`status`); a failure to run is thrown. */
function runGit(root: string, args: string[]): Promise<GitRun> {
  return new Promise((resolveRun, reject) => {
    execFile(
      'git',
      ['-C', root, ...args],
      {
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env: withGitConfigEnv({ ...process.env, GIT_TERMINAL_PROMPT: '0' })
      },
      (error, stdout) => {
        if (!error) return resolveRun({ status: 0, stdout, missing: false })
        const failure = error as NodeJS.ErrnoException & { killed?: boolean }
        // No Git on this computer: nothing can run a hook or read a configuration.
        if (failure.code === 'ENOENT') return resolveRun({ status: null, stdout: '', missing: true })
        if (typeof failure.code === 'number' && !failure.killed) return resolveRun({ status: failure.code, stdout, missing: false })
        reject(error)
      }
    )
  })
}

const expandHome = (value: string): string => (value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value)

/** The real path of a place named by a setting; a setting that does not resolve still names a place. */
function placeOf(path: string): string {
  try {
    return realPathOrAncestor(path)
  } catch {
    return resolve(path)
  }
}

/** The files of `git config --show-origin` output: `file:<path>` then a tab. Other origins (command line, blobs) are not files. */
function originFiles(output: string, root: string): string[] {
  const files: string[] = []
  for (const line of output.split(/\r?\n/)) {
    const tab = line.indexOf('\t')
    if (!line.startsWith('file:') || tab < 0) continue
    files.push(resolve(root, line.slice(5, tab)))
  }
  return files
}

/** Reads what the repository around `root` takes from the working tree. Throws when it cannot be read. */
export async function loadGitControl(root: string): Promise<GitControl> {
  const hooks = await runGit(root, ['config', '--type=path', '--get-all', 'core.hooksPath'])
  if (hooks.missing) return { hookFolders: [], configFiles: [] }
  if (hooks.status !== 0 && hooks.status !== 1) throw new Error('hooks setting unreadable')
  const files = new Set<string>()
  // Every file that is read for this repository right now, includes followed.
  const active = await runGit(root, ['config', '--list', '--show-origin', '--includes'])
  if (active.status !== 0) throw new Error('configuration unreadable')
  for (const file of originFiles(active.stdout, root)) files.add(file)
  // Every include named, applying or not: an `includeIf` that does not apply yet could after a change of branch or folder.
  const named = await runGit(root, ['config', '--no-includes', '--show-origin', '--get-regexp', '^include(if\\..*)?\\.path$'])
  if (named.status !== 0 && named.status !== 1) throw new Error('includes unreadable')
  for (const line of named.stdout.split(/\r?\n/)) {
    const tab = line.indexOf('\t')
    if (!line.startsWith('file:') || tab < 0) continue
    const space = line.indexOf(' ', tab)
    if (space < 0) continue
    const includedFrom = resolve(root, line.slice(5, tab))
    const value = expandHome(line.slice(space + 1).trim())
    files.add(isAbsolute(value) ? resolve(value) : resolve(dirname(includedFrom), value))
  }
  const folders: string[] = []
  let top: string | undefined
  for (const value of hooks.stdout.split(/\r?\n/).filter(Boolean)) {
    if (isAbsolute(value)) folders.push(resolve(value))
    else {
      // A relative path is taken from the top of the working tree.
      if (top === undefined) {
        const found = await runGit(root, ['rev-parse', '--show-toplevel'])
        top = found.status === 0 ? found.stdout.trim() : root
      }
      folders.push(resolve(top, value))
    }
  }
  return { hookFolders: folders.map(placeOf), configFiles: [...files].map(placeOf) }
}

/** The repository roots whose settings decide what a change at `real` can do: `root` and every nested repository between it and the file. */
export function enclosingRepositories(realRoot: string, real: string): string[] {
  const repositories = [realRoot]
  const nested: string[] = []
  for (let folder = dirname(real); folder !== realRoot && folder.length > realRoot.length; folder = dirname(folder)) {
    if (existsSync(join(folder, '.git'))) nested.push(folder)
    if (dirname(folder) === folder) break
  }
  return repositories.concat(nested)
}

type Entry = { at: number; value: GitControl | Error }

/**
 * Remembers what `loadGitControl` found for a short time, so a save costs no Git process when another has just
 * been made, and a save never waits on Git inside the daemon's event loop: callers `prepare` (asynchronously)
 * before the guard's synchronous check `get`s. The settings cannot be changed from another computer (every
 * file that could hold them is refused), so a little staleness only delays what the owner changes by hand.
 */
export class GitControlCache {
  private readonly entries = new Map<string, Entry>()
  private readonly loading = new Map<string, Promise<void>>()
  constructor(
    private readonly load: (root: string) => Promise<GitControl> = loadGitControl,
    private readonly freshMs = 10_000,
    private readonly now: () => number = Date.now
  ) {}

  async prepare(root: string): Promise<void> {
    const held = this.entries.get(root)
    if (held && this.now() - held.at < (held.value instanceof Error ? 2_000 : this.freshMs)) return
    let running = this.loading.get(root)
    if (!running) {
      running = this.load(root).then(
        (value) => void this.entries.set(root, { at: this.now(), value }),
        (error: unknown) => void this.entries.set(root, { at: this.now(), value: error instanceof Error ? error : new Error(String(error)) })
      ).finally(() => this.loading.delete(root))
      this.loading.set(root, running)
    }
    await running
  }

  /** Forgets what was found, so the next `prepare` reads again (for a test, or after the owner changed a setting by hand). */
  forget(): void {
    this.entries.clear()
  }

  /** What was found, or an error when it could not be read; undefined when nobody prepared this root. */
  get(root: string): GitControl | Error | undefined {
    return this.entries.get(root)?.value
  }
}

/** Shared by every guard of the daemon. */
export const gitControlCache = new GitControlCache()
