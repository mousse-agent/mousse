import { execFile } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { englishMessagesEnv } from './gitProcess'
import { GIT_NULL_DEVICE } from './gitNullDevice'
import { nonInteractiveGitEnv } from './gitEnv'

/**
 * The agent tools' `git_status` and `git_diff` (the Mousse MCP server's app tools and the legacy
 * loop alike), held to the folders the agent may read. Nothing outside them is read into the
 * answer or shown, and a read never starts a program the repository configures:
 *
 * - The repository is found once, from the project path, and checked before anything is read: a
 *   `.git` folder is its own repository (no `commondir`); a `.git` file is a linked worktree the
 *   common repository registered (`<common>/worktrees/<name>`) or a submodule checkout its
 *   repository names. When the agent can write in its roots, metadata it could have written is not
 *   trusted: a repository nested in the roots inside a larger one, a git dir or common dir inside
 *   the roots (other than the folder's own `.git`), alternates there, or a `.git` at another root
 *   refuse the read. Every later call names that repository (`GIT_DIR`, `GIT_WORK_TREE`) and never
 *   searches again.
 * - Paths are file names, never Git pathspecs (`--literal-pathspecs`), and are checked by their real
 *   path (junctions and symlinks followed): a diff takes one file inside the roots; a status lists
 *   only entries whose real path is inside them.
 * - Git runs with `core.fsmonitor` off, no hooks, every configured filter emptied and not
 *   required, no external diff or textconv, submodules ignored, no system config (its line-ending
 *   settings passed as data), no lazy fetch, no network protocol and no prompt; the host's `GIT_*`
 *   variables are dropped, except where its config files are.
 */

/** Where a git tool may read: the turn's project, and the roots its reads are held to. */
export interface ProjectGitScope {
  projectPath: string
  /** The definition's canonical roots, else the project path. Nothing outside them is read or shown. */
  roots: readonly string[]
  /**
   * The agent can write in its roots (a definition whose workspace or scripts may write), so Git
   * metadata there may be its own and is not trusted. A Build turn's agent runs commands itself.
   */
  writable?: boolean
}

interface GitResult { code: number | null; stdout: string; stderr: string }

/** Settings on every read: none of them can start a program or reach the network. */
const SAFE_CONFIG = [
  '-c', 'core.fsmonitor=false',
  '-c', `core.hooksPath=${GIT_NULL_DEVICE}`,
  '-c', 'core.quotepath=false',
  '-c', 'diff.submodule=short',
  '-c', 'status.submoduleSummary=false',
  '-c', 'protocol.allow=never',
  '-c', 'credential.interactive=false'
]

/** Settings read from every config level (the system's included) and passed as data: they change no program. */
const LINE_ENDING_KEYS = ['core.autocrlf', 'core.eol', 'core.safecrlf', 'core.symlinks']

/** The repository a read names explicitly, once found and checked. */
interface Repo { gitDir: string; top: string }

/**
 * The host's environment without its own Git settings, plus the read's. Where the user keeps their
 * config files (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`) stays; the system config is read only for
 * line endings (`withSystem`).
 */
function gitEnv(repo?: Repo, withSystem = false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^GIT_/i.test(key) || /^GIT_CONFIG_(GLOBAL|SYSTEM)$/i.test(key)) env[key] = value
  }
  return {
    ...env, ...englishMessagesEnv(), ...nonInteractiveGitEnv(),
    GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
    ...(withSystem ? {} : { GIT_CONFIG_NOSYSTEM: '1' }),
    ...(repo ? { GIT_DIR: repo.gitDir, GIT_WORK_TREE: repo.top, GIT_CEILING_DIRECTORIES: dirname(repo.top) } : {})
  }
}

function git(cwd: string, args: readonly string[], repo?: Repo, withSystem = false): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', [...SAFE_CONFIG, ...args], {
      cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024 * 1024, env: gitEnv(repo, withSystem)
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
 * `-c` settings that empty every filter driver the repository's effective config names, and make
 * none required, so no clean, smudge or process program runs while Git compares files and a
 * required one (Git LFS) does not fail the read: such files are compared as stored. A driver name
 * that cannot be overridden safely refuses the read.
 */
async function filterOverrides(repo: Repo): Promise<string[]> {
  const run = await git(repo.top, ['config', '-z', '--name-only', '--get-regexp', '^filter\\..+\\.(clean|smudge|process|required)$'], repo)
  if (run.code === 1) return []
  if (run.code !== 0) throw new Refused(run.stderr.trim() || 'The repository config could not be read.')
  const names = new Set<string>()
  for (const key of run.stdout.split('\0')) {
    if (!key) continue
    const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/i.exec(key.trim())
    if (!match || /[=\n\r\0]/.test(match[1]!)) throw new Refused('The repository configures a file filter that cannot be turned off for this read.')
    names.add(match[1]!)
  }
  return [...names].flatMap((name) => ['-c', `filter.${name}.clean=`, '-c', `filter.${name}.smudge=`, '-c', `filter.${name}.process=`, '-c', `filter.${name}.required=false`])
}

/**
 * The line-ending settings in effect for the repository, every config level included (Git for
 * Windows keeps `core.autocrlf=true` in its system config), passed as `-c` data.
 */
async function lineEndingSettings(repo: Repo): Promise<string[]> {
  const settings: string[] = []
  for (const key of LINE_ENDING_KEYS) {
    const run = await git(repo.top, ['config', '--get', key], repo, true)
    const value = run.code === 0 ? run.stdout.trim() : ''
    if (value && !/[\n\r\0]/.test(value)) settings.push('-c', `${key}=${value}`)
  }
  return settings
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

const sameFile = (a: string, b: string): boolean => relative(canonical(a), canonical(b)) === ''

/** The `gitdir:` a `.git` file names, resolved against its folder. */
function pointedGitDir(dotGit: string): string | null {
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'))
  return match ? resolve(dirname(dotGit), match[1]!) : null
}

function readText(path: string): string | null {
  try { return readFileSync(path, 'utf8') } catch { return null }
}

/** The object stores a repository borrows from (`objects/info/alternates`), followed a few levels. */
function alternates(commonDir: string): string[] {
  const found: string[] = []
  const visit = (objects: string, depth: number): void => {
    if (depth > 5) return
    for (const line of (readText(join(objects, 'info', 'alternates')) ?? '').split(/\r?\n/)) {
      const entry = line.trim()
      if (!entry || entry.startsWith('#')) continue
      const target = canonical(resolve(objects, entry))
      found.push(target)
      visit(target, depth + 1)
    }
  }
  visit(join(commonDir, 'objects'), 0)
  return found
}

const NOT_OWNED = "The project's .git does not belong to this folder's repository, so it is not read."

/**
 * Checks the repository Git found for `top` before anything is read from it:
 * - a `.git` folder (not a link) is its own repository, with no `commondir` of its own;
 * - a `.git` file is a linked worktree its common repository registered
 *   (`<common>/worktrees/<name>`, whose `gitdir` names this file back), or a submodule checkout whose
 *   repository's `core.worktree` is this folder;
 * - when the agent can write in its roots: no git dir, common dir or alternate inside them (but the
 *   folder's own `.git`), no repository nested in a larger one at or inside them, and no `.git` at
 *   another root.
 */
async function checkRepository(scope: ProjectGitScope, top: string, gitDir: string, commonDir: string, canonicalRoots: string[]): Promise<void> {
  const dotGit = join(top, '.git')
  let stat: ReturnType<typeof lstatSync>
  try { stat = lstatSync(dotGit) } catch { throw new Refused(NOT_OWNED) }
  const own = stat.isDirectory()
  if (own) {
    if (!sameFile(dotGit, gitDir) || !sameFile(gitDir, commonDir) || existsSync(join(gitDir, 'commondir'))) throw new Refused(NOT_OWNED)
  } else if (stat.isFile()) {
    const pointed = pointedGitDir(dotGit)
    if (!pointed || !sameFile(pointed, gitDir)) throw new Refused(NOT_OWNED)
    const registered = sameFile(dirname(gitDir), join(commonDir, 'worktrees'))
    const back = readText(join(gitDir, 'gitdir'))?.trim()
    const linked = registered && Boolean(back) && sameFile(resolve(gitDir, back!), dotGit)
    let submodule = false
    if (!linked && sameFile(gitDir, commonDir)) {
      const worktree = await git(top, ['config', '--file', join(gitDir, 'config'), '--get', 'core.worktree'])
      submodule = worktree.code === 0 && Boolean(worktree.stdout.trim()) && sameFile(resolve(gitDir, worktree.stdout.trim()), top)
    }
    if (!linked && !submodule) throw new Refused(NOT_OWNED)
  } else throw new Refused(NOT_OWNED)
  if (!scope.writable) return
  const inWritable = (path: string): boolean => canonicalRoots.some((root) => inside(root, canonical(path)) !== null)
  const untrusted = "Git metadata inside the agent's folders could be its own, so this repository is not read."
  // The repository's own `.git` folder may sit in the roots (a project that is the repository); any
  // other git dir or common dir there, or an object store borrowed from there, is metadata the agent could have written.
  if (!own && (inWritable(gitDir) || inWritable(commonDir))) throw new Refused(untrusted)
  const borrowed = alternates(canonical(commonDir))
  if (borrowed.some((target) => inWritable(target)) || (own && inWritable(gitDir) && borrowed.length)) throw new Refused(untrusted)
  // A repository whose folder is in the roots, nested in a larger one: its `.git` could be the agent's.
  if (inWritable(top) && dirname(top) !== top) {
    const outer = await git(dirname(top), ['rev-parse', '--show-toplevel'])
    if (outer.code === 0 && outer.stdout.trim()) throw new Refused(untrusted)
  }
  // A `.git` at another root is another repository, never this one's.
  if (canonicalRoots.some((root) => !sameFile(root, top) && existsSync(join(root, '.git')))) throw new Refused(untrusted)
}

interface Worktree {
  repo: Repo
  top: string
  /** The roots inside the worktree, repository-relative (`''` is the whole worktree). */
  roots: string[]
  /** The canonical roots, for checking real paths. */
  canonicalRoots: string[]
  /** `-c` settings: the filters emptied, and the line endings in effect. */
  settings: string[]
}

/** The worktree holding the project, found once and checked, and the roots in it. */
async function worktree(scope: ProjectGitScope): Promise<Worktree | null> {
  const info = await git(scope.projectPath, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'])
  if (info.code !== 0) return null
  const [topLine, gitDirLine, commonLine] = info.stdout.split(/\r?\n/).map((line) => line.trim())
  if (!topLine || !gitDirLine || !commonLine) return null
  const top = canonical(topLine)
  const canonicalRoots = scope.roots.map((root) => canonical(root))
  await checkRepository(scope, top, gitDirLine, commonLine, canonicalRoots)
  const repo: Repo = { gitDir: canonical(gitDirLine), top }
  const roots = canonicalRoots.map((root) => inside(top, root)).filter((root): root is string => root !== null)
  return { repo, top, roots: [...new Set(roots)], canonicalRoots, settings: [...await filterOverrides(repo), ...await lineEndingSettings(repo)] }
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
  const run = await git(tree.top, [...tree.settings, '--literal-pathspecs', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all', '--', ...pathspecs], tree.repo)
  if (run.code !== 0) throw new Error(run.stderr.trim() || 'git status failed')
  const head = await git(tree.top, ['symbolic-ref', '--quiet', '--short', 'HEAD'], tree.repo)
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
 * its repository-relative name with `--literal-pathspecs` after `--`. Filtered files (Git LFS) are
 * compared as stored.
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
  const diff = [...tree.settings, '--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all']
  let run: GitResult
  if (staged) run = await git(tree.top, [...diff, '--cached', '--', name], tree.repo)
  else {
    const untracked = await git(tree.top, [...tree.settings, '--literal-pathspecs', 'ls-files', '--others', '--exclude-standard', '-z', '--', name], tree.repo)
    // A new file: its whole content, against the null device (file paths, not pathspecs, here).
    if (untracked.stdout.split('\0').includes(name)) run = await git(tree.top, [...tree.settings, 'diff', '--no-ext-diff', '--no-textconv', '--no-index', '--', GIT_NULL_DEVICE, name], tree.repo)
    else run = await git(tree.top, [...diff, '--', name], tree.repo)
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
