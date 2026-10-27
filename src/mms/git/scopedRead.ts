import { execFile } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { englishMessagesEnv } from './gitProcess'
import { GIT_NULL_DEVICE } from './gitNullDevice'
import { nonInteractiveGitEnv } from './gitEnv'

/**
 * The agent tools' `git_status` and `git_diff` (the Mousse MCP server's app tools and the legacy
 * loop alike), held to the folders the agent may read. Nothing outside them is read into the
 * answer or shown, and a read never starts a program the repository configures:
 *
 * - Paths are file names, never Git pathspecs (`--literal-pathspecs`), and are checked by their real
 *   path (junctions and symlinks followed): a diff takes one file inside the roots; a status lists
 *   only entries whose real path is inside them.
 * - The repository must own the folder: a `.git` file must point at a repository that lists the
 *   folder as its linked worktree or submodule checkout, never at an unrelated one.
 * - Git runs with `core.fsmonitor` off, every configured clean, smudge and process filter emptied,
 *   no external diff or textconv, submodules ignored, no system config, no lazy fetch, no network
 *   protocol and no prompt; any `GIT_*` variable of the host process is dropped.
 */

/** Where a git tool may read: the turn's project, and the roots its reads are held to. */
export interface ProjectGitScope {
  projectPath: string
  /** The definition's canonical roots, else the project path. Nothing outside them is read or shown. */
  roots: readonly string[]
}

interface GitResult { code: number | null; stdout: string; stderr: string }

/** Settings on every read: none of them can start a program or reach the network. */
const SAFE_CONFIG = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.quotepath=false',
  '-c', 'diff.submodule=short',
  '-c', 'status.submoduleSummary=false',
  '-c', 'protocol.allow=never',
  '-c', 'credential.interactive=false'
]

/** The host's environment without its own Git settings, plus the read's. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) if (!/^GIT_/i.test(key)) env[key] = value
  return {
    ...env, ...englishMessagesEnv(), ...nonInteractiveGitEnv(),
    GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1'
  }
}

function git(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', [...SAFE_CONFIG, ...args], {
      cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024 * 1024, env: gitEnv()
    }, (error, stdout, stderr) => {
      const exit = error ? (error as { code?: unknown }).code : 0
      if (error && typeof exit !== 'number') reject(error)
      else resolvePromise({ code: typeof exit === 'number' ? exit : null, stdout, stderr })
    })
  })
}

/** Refused read: the tool's message. */
class Refused extends Error {}

/**
 * `-c` settings that empty every filter driver the repository's effective config names, so no
 * clean, smudge or process program runs while Git compares files. A driver name that cannot be
 * overridden safely refuses the read.
 */
async function filterOverrides(cwd: string): Promise<string[]> {
  const run = await git(cwd, ['config', '-z', '--name-only', '--get-regexp', '^filter\\..+\\.(clean|smudge|process)$'])
  if (run.code === 1) return []
  if (run.code !== 0) throw new Refused(run.stderr.trim() || 'The repository config could not be read.')
  const names = new Set<string>()
  for (const key of run.stdout.split('\0')) {
    if (!key) continue
    const match = /^filter\.(.+)\.(?:clean|smudge|process)$/i.exec(key.trim())
    if (!match || /[=\n\r\0]/.test(match[1]!)) throw new Refused('The repository configures a file filter that cannot be turned off for this read.')
    names.add(match[1]!)
  }
  return [...names].flatMap((name) => ['-c', `filter.${name}.clean=`, '-c', `filter.${name}.smudge=`, '-c', `filter.${name}.process=`])
}

/** The real path of a file, or of its nearest existing parent with the rest appended (a deleted file). */
function canonical(path: string): string {
  const missing: string[] = []
  let current = resolve(path)
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(path)
      missing.push(basename(current))
      current = parent
    }
  }
}

const posix = (path: string): string => path.split(sep).join('/')

/** `target` relative to `base` with `/`, or null when it is outside `base` (or is `base` itself, when `strict`). */
function inside(base: string, target: string, strict = false): string | null {
  const rel = relative(base, target)
  if (rel === '') return strict ? null : ''
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return posix(rel)
}

const sameFile = (a: string, b: string): boolean => {
  const rel = relative(canonical(a), canonical(b))
  return rel === ''
}

/** The `gitdir:` a `.git` file names, resolved against its folder. */
function pointedGitDir(dotGit: string): string | null {
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'))
  return match ? resolve(dirname(dotGit), match[1]!) : null
}

/**
 * Whether the repository Git found owns the worktree `top`: its `.git` folder, or a `.git` file whose
 * repository lists `top` back (a linked worktree's `gitdir`, a submodule's `core.worktree`).
 */
async function ownsWorktree(top: string, gitDir: string): Promise<boolean> {
  const dotGit = join(top, '.git')
  let stat: ReturnType<typeof lstatSync>
  try { stat = lstatSync(dotGit) } catch { return false }
  if (stat.isDirectory()) return sameFile(dotGit, gitDir)
  if (!stat.isFile()) return false
  const pointed = pointedGitDir(dotGit)
  if (!pointed || !sameFile(pointed, gitDir)) return false
  // A linked worktree: the repository's record of it names this `.git` file.
  try {
    const back = readFileSync(join(gitDir, 'gitdir'), 'utf8').trim()
    if (back && sameFile(resolve(gitDir, back), dotGit)) return true
  } catch { /* not a linked worktree */ }
  // A submodule checkout: its repository's `core.worktree` is this folder.
  const worktree = await git(top, ['config', '--file', join(gitDir, 'config'), '--get', 'core.worktree'])
  return worktree.code === 0 && Boolean(worktree.stdout.trim()) && sameFile(resolve(gitDir, worktree.stdout.trim()), top)
}

interface Worktree {
  top: string
  /** The roots inside the worktree, repository-relative (`''` is the whole worktree). */
  roots: string[]
  /** The canonical roots, for checking real paths. */
  canonicalRoots: string[]
  /** `-c` settings emptying the repository's filters. */
  filters: string[]
}

/** The worktree holding the project, verified to belong to its repository, and the roots in it. */
async function worktree(scope: ProjectGitScope): Promise<Worktree | null> {
  const info = await git(scope.projectPath, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir'])
  if (info.code !== 0) return null
  const [topLine, gitDirLine] = info.stdout.split(/\r?\n/)
  if (!topLine?.trim() || !gitDirLine?.trim()) return null
  const top = canonical(topLine.trim())
  if (!(await ownsWorktree(top, gitDirLine.trim())))
    throw new Refused("The project's .git does not belong to this folder's repository, so it is not read.")
  const canonicalRoots = scope.roots.map((root) => canonical(root))
  const roots = canonicalRoots.map((root) => inside(top, root)).filter((root): root is string => root !== null)
  return { top, roots: [...new Set(roots)], canonicalRoots, filters: await filterOverrides(top) }
}

/** A real path inside one of the canonical roots. */
const inRoots = (tree: Worktree, path: string): boolean => tree.canonicalRoots.some((root) => inside(root, path) !== null)

const STATUS: Record<string, string> = { M: 'modified', T: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied' }

/**
 * `git status` held to the roots: Git reads only the roots (literal pathspecs, submodules ignored),
 * and every entry shown (a rename's source included) has its real path inside them, relative to the
 * project. Repository-wide facts (upstream, ahead and behind, remotes) are left out.
 */
async function scopedStatus(scope: ProjectGitScope): Promise<Record<string, unknown>> {
  const tree = await worktree(scope)
  if (!tree) return { isRepo: false, changes: [] }
  if (!tree.roots.length) return { isRepo: true, changes: [] }
  const pathspecs = tree.roots.map((root) => root || '.')
  const run = await git(tree.top, [...tree.filters, '--literal-pathspecs', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all', '--', ...pathspecs])
  if (run.code !== 0) throw new Error(run.stderr.trim() || 'git status failed')
  const head = await git(tree.top, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const branch = head.code === 0 ? head.stdout.trim() || null : null
  const project = canonical(scope.projectPath)
  // Shown only when its real path (through junctions and symlinks) is inside the roots.
  const real = (path: string): string | null => {
    const file = canonical(join(tree.top, path))
    return inRoots(tree, file) ? posix(relative(project, file)) : null
  }
  const fields = run.stdout.split('\0')
  const changes: Array<Record<string, unknown>> = []
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!
    if (field.length < 4) continue
    const x = field[0]!
    const y = field[1]!
    const path = real(field.slice(3))
    const from = x === 'R' || x === 'C' ? fields[++index] : undefined
    if (path === null) continue
    const fromShown = from !== undefined ? real(from) : null
    const source = fromShown !== null ? { originalPath: fromShown } : undefined
    if (x === '?' && y === '?') changes.push({ path, status: 'untracked', staged: false })
    else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) changes.push({ path, status: 'conflicted', staged: false })
    else {
      // A rename or copy whose source is outside the roots shows as an added file, without its source.
      if (STATUS[x]) changes.push({ path, status: from !== undefined && !source ? 'added' : STATUS[x], staged: true, ...(source ?? {}) })
      if (STATUS[y]) changes.push({ path, status: STATUS[y], staged: false })
    }
  }
  return { isRepo: true, branch, changes }
}

/**
 * `git diff` of one file, read as a file name and never as a Git pathspec: the name is resolved
 * against the project, its real path must be a file (not a folder) inside the roots, and Git gets
 * its repository-relative name with `--literal-pathspecs` after `--`.
 */
async function scopedDiff(scope: ProjectGitScope, requested: string, staged: boolean): Promise<{ text: string; isError: boolean }> {
  const file = canonical(resolve(scope.projectPath, requested))
  if (!scope.roots.some((root) => inside(canonical(root), file) !== null)) return { text: `Path is outside the project: ${requested}`, isError: true }
  let folder = false
  try { folder = statSync(file).isDirectory() } catch { /* a deleted file */ }
  if (folder) return { text: `git_diff takes one file; ${requested} is a folder.`, isError: true }
  const tree = await worktree(scope)
  if (!tree) return { text: '(no diff)', isError: false }
  const name = inside(tree.top, file, true)
  if (name === null) return { text: `Path is outside the project: ${requested}`, isError: true }
  const diff = [...tree.filters, '--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all']
  let run: GitResult
  if (staged) run = await git(tree.top, [...diff, '--cached', '--', name])
  else {
    const untracked = await git(tree.top, [...tree.filters, '--literal-pathspecs', 'ls-files', '--others', '--exclude-standard', '-z', '--', name])
    // A new file: its whole content, against the null device (file paths, not pathspecs, here).
    if (untracked.stdout.split('\0').includes(name)) run = await git(tree.top, [...tree.filters, 'diff', '--no-ext-diff', '--no-textconv', '--no-index', '--', GIT_NULL_DEVICE, name])
    else run = await git(tree.top, [...diff, '--', name])
  }
  // `--no-index` exits 1 when the files differ.
  if (run.code !== 0 && run.code !== 1) return { text: run.stderr.trim() || 'git diff failed', isError: true }
  return { text: run.stdout || '(no diff)', isError: false }
}

/**
 * Runs `git_status` or `git_diff` for the project, held to the scope's roots; errors are results,
 * never throws.
 */
export async function runProjectGitTool(name: string, args: Record<string, unknown>, scope: ProjectGitScope): Promise<{ text: string; isError: boolean }> {
  try {
    if (name === 'git_status') return { text: JSON.stringify(await scopedStatus(scope), null, 2), isError: false }
    if (name === 'git_diff') {
      const path = typeof args.path === 'string' ? args.path : ''
      if (!path.trim()) return { text: 'A file path is required.', isError: true }
      return await scopedDiff(scope, path, args.staged === true)
    }
    return { text: `Unknown git tool: ${name}`, isError: true }
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true }
  }
}
