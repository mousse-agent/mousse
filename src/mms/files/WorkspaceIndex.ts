import { execFile, spawn } from 'node:child_process'
import { readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { promisify } from 'node:util'
import { lowerPath } from '../../shared/fuzzyPath'
import { SKIP_DIR_NAMES } from './pathGuard'
import { repoProgramEnv, withoutRepoPrograms } from '../git/repoPrograms'

export type WorkspaceIndexFallbackReason = 'not-a-repo' | 'git-missing' | 'git-too-old'

export interface WorkspaceIndexSnapshot {
  /** Absolute root the paths are relative to. */
  root: string
  source: 'git' | 'walk'
  /** Why a `walk` was used; absent for `git`. */
  fallbackReason?: WorkspaceIndexFallbackReason
  /** Root-relative, `/`-separated. */
  files: string[]
  /** Every proper parent of every file plus listed directories, deduplicated, excluding the root. */
  folders: string[]
  lowerFiles: string[]
  lowerFolders: string[]
  builtAt: number
  /** The path cap was hit; later paths are not indexed. */
  truncated: boolean
  /** `false` for a partial snapshot handed out while the build is still running. */
  complete: boolean
}

export interface BuildWorkspaceIndexOptions {
  cap?: number
  maxDepth?: number
  signal?: AbortSignal
  /** Called every `progressEvery` entries with a snapshot that has `complete: false`. */
  onProgress?: (partial: WorkspaceIndexSnapshot) => void
  progressEvery?: number
  /** Replaceable for tests. */
  detectGit?: typeof detectGitRoute
}

export type GitRoute =
  | { ok: true; version: [major: number, minor: number] }
  | { ok: false; reason: WorkspaceIndexFallbackReason }

const DEFAULT_CAP = 200_000
const DEFAULT_MAX_DEPTH = 32
const DEFAULT_PROGRESS_EVERY = 10_000
const WALK_YIELD_EVERY = 2_000
/** `git grep --column` (2018) is the oldest feature the daemon relies on. */
const MIN_GIT_VERSION: [number, number] = [2, 19]

const execFileAsync = promisify(execFile)

let gitVersion: [number, number] | null = null

async function readGitVersion(): Promise<[number, number] | null> {
  if (gitVersion) return gitVersion
  try {
    const { stdout } = await execFileAsync('git', ['--version'], { windowsHide: true })
    const match = /(\d+)\.(\d+)/.exec(stdout)
    if (!match) return null
    // Only a successful probe is cached, so installing git later takes effect without a restart.
    gitVersion = [Number(match[1]), Number(match[2])]
    return gitVersion
  } catch {
    return null
  }
}

/**
 * Decides whether `root` can be listed and searched by git. The synchronous
 * helpers in `actions/git.ts` would block the daemon, so this is asynchronous.
 * The version lets callers gate options (`git grep -m` needs 2.38).
 */
export async function detectGitRoute(root: string): Promise<GitRoute> {
  const version = await readGitVersion()
  if (!version) return { ok: false, reason: 'git-missing' }
  if (version[0] < MIN_GIT_VERSION[0] || (version[0] === MIN_GIT_VERSION[0] && version[1] < MIN_GIT_VERSION[1])) {
    return { ok: false, reason: 'git-too-old' }
  }
  try {
    await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: root, windowsHide: true })
    return { ok: true, version }
  } catch {
    return { ok: false, reason: 'not-a-repo' }
  }
}

/**
 * Whether `absPath` resolves, through symlinks and Windows junctions, to a
 * place inside `rootReal` (the root's own `realpath`). `false` when it cannot
 * be resolved. Callers use it before listing or reading anything that was
 * reached through a link.
 */
export async function isPhysicallyWithin(rootReal: string, absPath: string): Promise<boolean> {
  try {
    return isInside(rootReal, await realpath(absPath))
  } catch {
    return false
  }
}

function isInside(rootReal: string, real: string): boolean {
  const rel = relative(rootReal, real)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function abortError(): Error {
  const error = new Error('Workspace index build was aborted')
  error.name = 'AbortError'
  return error
}

/** Accumulates paths, lowercase copies and derived parent folders as entries arrive. */
class IndexCollector {
  readonly files: string[] = []
  readonly lowerFiles: string[] = []
  readonly folders: string[] = []
  readonly lowerFolders: string[] = []
  /** Listed entries (files and explicit directories); this is what the cap counts. */
  count = 0
  truncated = false
  private readonly folderSet = new Set<string>()

  constructor(
    private readonly root: string,
    private readonly source: 'git' | 'walk',
    private readonly fallbackReason: WorkspaceIndexFallbackReason | undefined,
    private readonly cap: number,
    private readonly onProgress: ((partial: WorkspaceIndexSnapshot) => void) | undefined,
    private readonly progressEvery: number
  ) {}

  /** `false` once the cap is reached; the caller stops reading and the snapshot is marked truncated. */
  addFile(path: string): boolean {
    if (!this.reserve()) return false
    this.files.push(path)
    this.lowerFiles.push(lowerPath(path))
    this.addParents(path)
    this.progress()
    return true
  }

  addFolder(path: string): boolean {
    if (!this.reserve()) return false
    this.addFolderEntry(path)
    this.addParents(path)
    this.progress()
    return true
  }

  snapshot(complete: boolean): WorkspaceIndexSnapshot {
    return {
      root: this.root,
      source: this.source,
      ...(this.fallbackReason ? { fallbackReason: this.fallbackReason } : {}),
      files: complete ? this.files : this.files.slice(),
      folders: complete ? this.folders : this.folders.slice(),
      lowerFiles: complete ? this.lowerFiles : this.lowerFiles.slice(),
      lowerFolders: complete ? this.lowerFolders : this.lowerFolders.slice(),
      builtAt: Date.now(),
      truncated: this.truncated,
      complete
    }
  }

  private reserve(): boolean {
    if (this.count >= this.cap) {
      this.truncated = true
      return false
    }
    this.count += 1
    return true
  }

  private addFolderEntry(path: string): void {
    if (this.folderSet.has(path)) return
    this.folderSet.add(path)
    this.folders.push(path)
    this.lowerFolders.push(lowerPath(path))
  }

  private addParents(path: string): void {
    let slash = path.lastIndexOf('/')
    while (slash > 0) {
      const parent = path.slice(0, slash)
      // A folder already known has all its parents known too.
      if (this.folderSet.has(parent)) return
      this.addFolderEntry(parent)
      slash = parent.lastIndexOf('/')
    }
  }

  private progress(): void {
    if (this.onProgress && this.count % this.progressEvery === 0) this.onProgress(this.snapshot(false))
  }
}

function hasSkippedSegment(segments: string[]): boolean {
  return segments.some((segment) => SKIP_DIR_NAMES.has(segment))
}

/**
 * Lists a repository with `git ls-files`, which applies every `.gitignore`
 * rule. The NUL-delimited stream is parsed as it arrives so the child can be
 * killed at the cap (`execFile` with `maxBuffer` would throw instead).
 *
 * Paths are relative to `cwd`, so a worktree or subdirectory root lists only
 * its own files. An untracked nested repository appears as one `inner/`
 * entry and becomes a folder; its contents are not indexed. A submodule shows
 * up as a plain path and is kept as a file entry. A tracked file deleted from
 * disk but not yet committed still appears.
 *
 * Returns `false` when git failed before listing anything usable.
 */
async function listWithGit(root: string, collector: IndexCollector, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise<boolean>((resolvePromise, reject) => {
    let args: string[]
    try {
      args = withoutRepoPrograms(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--'])
    } catch {
      resolvePromise(false)
      return
    }
    const child = spawn('git', args, {
      cwd: root,
      env: repoProgramEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    let pending: Buffer = Buffer.alloc(0)
    let stopped = false
    let spawnFailed = false

    const stop = (): void => {
      if (stopped) return
      stopped = true
      child.kill()
    }
    const onAbort = (): void => stop()
    signal?.addEventListener('abort', onAbort, { once: true })

    const accept = (record: string): boolean => {
      if (!record) return true
      const path = record.replace(/\\/g, '/')
      if (path.endsWith('/')) {
        const folder = path.slice(0, -1)
        if (!folder || hasSkippedSegment(folder.split('/'))) return true
        return collector.addFolder(folder)
      }
      const segments = path.split('/')
      segments.pop()
      if (hasSkippedSegment(segments)) return true
      return collector.addFile(path)
    }

    child.stdout.on('data', (chunk: Buffer) => {
      if (stopped) return
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      let start = 0
      let nul = pending.indexOf(0, start)
      while (nul >= 0) {
        if (!accept(pending.toString('utf8', start, nul))) {
          stop()
          return
        }
        start = nul + 1
        nul = pending.indexOf(0, start)
      }
      pending = pending.subarray(start)
    })
    child.on('error', () => {
      spawnFailed = true
      stopped = true
      signal?.removeEventListener('abort', onAbort)
      resolvePromise(false)
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) {
        reject(abortError())
        return
      }
      if (!stopped && pending.length) accept(pending.toString('utf8'))
      // A killed child reports no useful exit code; the cap or abort stopped it on purpose.
      resolvePromise(!spawnFailed && (code === 0 || collector.truncated))
    })
  })
}

/** Breadth-first walk for roots git cannot list. Symlinks are listed only when they stay inside the root and are never descended. */
async function walkTree(
  root: string,
  collector: IndexCollector,
  maxDepth: number,
  signal: AbortSignal | undefined
): Promise<void> {
  const rootReal = await realpath(root)
  const queue: Array<{ rel: string; depth: number }> = [{ rel: '', depth: 0 }]
  let sinceYield = 0

  for (let head = 0; head < queue.length; head += 1) {
    const { rel, depth } = queue[head]
    if (signal?.aborted) throw abortError()
    let entries
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true })
    } catch {
      // Unreadable directory: the rest of the tree is still worth listing.
      continue
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name
      sinceYield += 1
      if (sinceYield >= WALK_YIELD_EVERY) {
        sinceYield = 0
        await yieldToEventLoop()
        if (signal?.aborted) throw abortError()
      }

      if (entry.isSymbolicLink()) {
        const abs = join(root, path)
        let real: string
        let kind: 'file' | 'directory' | null = null
        try {
          real = await realpath(abs)
          if (!isInside(rootReal, real)) continue
          const target = await stat(real)
          kind = target.isDirectory() ? 'directory' : target.isFile() ? 'file' : null
        } catch {
          continue
        }
        if (kind === 'directory') {
          if (!collector.addFolder(path)) return
        } else if (kind === 'file') {
          if (!collector.addFile(path)) return
        }
        continue
      }
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue
        if (!collector.addFolder(path)) return
        if (depth + 1 < maxDepth) queue.push({ rel: path, depth: depth + 1 })
      } else if (entry.isFile()) {
        if (!collector.addFile(path)) return
      }
    }
  }
}

/**
 * Builds the path index for one root: `git ls-files` in a repository (so
 * `.gitignore` is honoured by git itself), a directory walk otherwise or when
 * git is missing or older than 2.19. Both routes skip `SKIP_DIR_NAMES`.
 */
export async function buildWorkspaceIndex(
  root: string,
  options: BuildWorkspaceIndexOptions = {}
): Promise<WorkspaceIndexSnapshot> {
  const {
    cap = DEFAULT_CAP,
    maxDepth = DEFAULT_MAX_DEPTH,
    signal,
    onProgress,
    progressEvery = DEFAULT_PROGRESS_EVERY,
    detectGit = detectGitRoute
  } = options
  const absoluteRoot = resolve(root)
  if (signal?.aborted) throw abortError()

  const route = await detectGit(absoluteRoot)
  if (route.ok) {
    const collector = new IndexCollector(absoluteRoot, 'git', undefined, cap, onProgress, progressEvery)
    if (await listWithGit(absoluteRoot, collector, signal)) return collector.snapshot(true)
    // git failed outright (damaged repository, unsafe directory): list the folder instead.
  }
  const reason: WorkspaceIndexFallbackReason = route.ok ? 'not-a-repo' : route.reason
  const collector = new IndexCollector(absoluteRoot, 'walk', reason, cap, onProgress, progressEvery)
  await walkTree(absoluteRoot, collector, maxDepth, signal)
  return collector.snapshot(true)
}
