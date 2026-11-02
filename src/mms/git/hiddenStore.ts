import { AsyncLocalStorage } from 'node:async_hooks'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { RepositoryIdentity } from './RepositoryIdentity'
import { assertGitAllowed, type UserAction } from './gitPolicy'
import { GIT_NULL_DEVICE, NO_HOOKS_PATH } from './gitNullDevice'

/**
 * A hidden snapshot store (docs/workspace-snapshots.md, "Folders without Git"): a Git repository Mousse owns, kept in its own
 * data, whose work tree is a folder that has no Git of its own that Mousse may use. Git reaches the folder through
 * `--git-dir` and `--work-tree`, so the folder never gains a `.git`.
 */
export interface HiddenStore {
  /** The folder whose files the store records. */
  workTree: string
  /** The store itself, in Mousse's data. */
  gitDir: string
}

const scope = new AsyncLocalStorage<HiddenStore>()

function canonical(path: string): string {
  const resolved = resolve(path)
  try { return realpathSync.native(resolved) } catch { return resolved }
}

function key(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

/** Whether `path` is the folder `root` or inside it. */
export function insideFolder(root: string, path: string): boolean {
  const base = key(root)
  const target = key(path)
  return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

/**
 * The store in canonical form. A store belongs to the threads that recorded turns in it, never to the folder: once a
 * person runs `git init` there, the folder is also their repository, and only the threads that started in the store
 * keep using it (`threadSnapshotStore` in `SnapshotWorkspace`).
 */
export function registerHiddenStore(store: HiddenStore): HiddenStore {
  return { workTree: canonical(store.workTree), gitDir: resolve(store.gitDir) }
}

/**
 * Runs `operation` with Git commands that Mousse's snapshot code runs inside the store's folder going through the store.
 * Only commands run inside this scope are redirected; the Git panel and every other caller keep seeing a folder with no
 * repository.
 */
export function inHiddenStore<T>(store: HiddenStore, operation: () => T): T {
  return scope.run(store, operation)
}

/**
 * Runs `operation` with no store in scope: for Git in a repository nested inside a store's folder, which is that
 * repository's own and must never be redirected into the store.
 */
export function outsideHiddenStore<T>(operation: () => T): T {
  return scope.exit(operation)
}

/** The store Git commands in `cwd` go through right now, if the caller is inside a scope for it. */
export function activeHiddenStore(cwd: string): HiddenStore | undefined {
  const store = scope.getStore()
  return store && (insideFolder(store.workTree, resolve(cwd)) || insideFolder(store.workTree, canonical(cwd))) ? store : undefined
}


/**
 * What a store never saves, besides the folder's own `.gitignore` files. Directories whose name says "generated
 * output" are matched only at the top of the folder, where a person's own `build/` source folder is not likely to be.
 * Enforced on the store's index after every add (`builtInPathspecs`), so a folder's `.gitignore` cannot take one back in.
 */
export const BUILT_IN_EXCLUDES = [
  '.git/', '.mousse/', 'node_modules/', '.venv/', 'venv/', '__pycache__/', '.DS_Store',
  '/dist/', '/build/', '/target/', '/.next/', '/.cache/'
] as const

/**
 * The built-in list as glob pathspecs: `match` names what is under them (for `git rm --cached`), `exclude` leaves it out
 * of a listing. Pathspecs, unlike ignore rules, are not undone by a `!pattern` in the folder's `.gitignore`.
 */
export function builtInPathspecs(): { match: string[]; exclude: string[] } {
  const globs = BUILT_IN_EXCLUDES.flatMap((pattern) => {
    const top = pattern.startsWith('/')
    const name = pattern.replace(/^\//, '').replace(/\/$/, '')
    const at = top ? name : `**/${name}`
    return pattern.endsWith('/') ? [`${at}/**`] : [at, `${at}/**`]
  })
  return { match: globs.map((glob) => `:(glob)${glob}`), exclude: globs.map((glob) => `:(exclude,glob)${glob}`) }
}

/**
 * Overrides every `.gitattributes` of the folder (`$GIT_DIR/info/attributes` comes last): no end-of-line conversion, no
 * filter, no `$Id$` expansion and no re-encoding, so a snapshot holds a file's exact bytes and a restore writes them
 * back. Diffs and merges keep Git's defaults whatever the folder asks for.
 */
const STORE_ATTRIBUTES = '# Mousse: a snapshot records exact bytes.\n* -text -filter -ident !eol !working-tree-encoding !diff !merge\n'

/**
 * Settings every store command runs with, whatever the person's config, as if given with `-c`. Each only turns something
 * off, so the central Git check accepts them; the attributes override does the rest.
 */
const ISOLATED_SETTINGS: ReadonlyArray<readonly [string, string]> = [
  ['core.autocrlf', 'false'], ['core.safecrlf', 'false'], ['core.eol', 'lf'],
  ['core.attributesFile', GIT_NULL_DEVICE], ['core.excludesFile', GIT_NULL_DEVICE], ['core.hooksPath', NO_HOOKS_PATH],
  ['core.fsmonitor', 'false'], ['core.untrackedCache', 'false'],
  ['core.symlinks', process.platform === 'win32' ? 'false' : 'true'],
  // Mousse collects a store's garbage itself, after it releases refs; nothing it runs may start a collection.
  ['gc.auto', '0'],
  ['diff.autoRefreshIndex', 'false']
]

const prepared = new Set<string>()

/** Writes `content` to `path` only when it differs, through a temporary file and a rename, so no reader sees half of it. */
function writeIfChanged(path: string, content: string): void {
  try { if (readFileSync(path, 'utf8') === content) return } catch { /* not there yet */ }
  mkdirSync(join(path, '..'), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, content)
  renameSync(temporary, path)
}

const STORE_EXCLUDE = `# Mousse: what a snapshot never holds, besides the folder's own .gitignore files.\n${BUILT_IN_EXCLUDES.join('\n')}\n`

/**
 * Brings the store's exclude list and attributes override up to date. Run under the store's mutation lock before each
 * snapshot; a store gets both when it is made, so a read before any snapshot already has them.
 */
export function ensureStoreRules(store: HiddenStore): void {
  writeIfChanged(join(store.gitDir, 'info', 'exclude'), STORE_EXCLUDE)
  writeIfChanged(join(store.gitDir, 'info', 'attributes'), STORE_ATTRIBUTES)
}

/** An older store, read before its first snapshot here, is never without its attributes override. Once per process. */
function ensureAttributes(store: HiddenStore): void {
  if (prepared.has(store.gitDir)) return
  if (existsSync(join(store.gitDir, 'HEAD')) && !existsSync(join(store.gitDir, 'info', 'attributes'))) writeIfChanged(join(store.gitDir, 'info', 'attributes'), STORE_ATTRIBUTES)
  prepared.add(store.gitDir)
}

/** Configuration and attribute sources outside the store that a store command must never read. */
const OUTSIDE_SOURCES = /^GIT_(CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|ATTR_SOURCE|EXTERNAL_DIFF|DIFF_OPTS)$/

/**
 * `base` for a command in the store: no system or global config (the person's filters, hooks, `core.autocrlf` and the
 * rest), no system attributes, no config from the environment, and the store's fixed settings. With the store's own
 * attributes override, what the store records and restores is a file's exact bytes.
 */
export function isolatedEnv(store: HiddenStore, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  ensureAttributes(store)
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) if (!OUTSIDE_SOURCES.test(key) && key !== 'GIT_DIR' && key !== 'GIT_WORK_TREE') env[key] = value
  return { ...env, ...isolation() }
}

/** The variables `isolatedEnv` sets, alone: what the central Git check is shown. */
function isolation(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: GIT_NULL_DEVICE, GIT_ATTR_NOSYSTEM: '1', GIT_CONFIG_COUNT: String(ISOLATED_SETTINGS.length) }
  ISOLATED_SETTINGS.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key
    env[`GIT_CONFIG_VALUE_${index}`] = value
  })
  return env
}

/** The store and, for a command on the folder's files, its work tree, as the environment names them. */
function location(store: HiddenStore, workTree: boolean): NodeJS.ProcessEnv {
  return { GIT_DIR: store.gitDir, ...(workTree ? { GIT_WORK_TREE: store.workTree } : {}) }
}

export interface StoreCommandOptions {
  /** What the caller sets besides the store (a private `GIT_INDEX_FILE`). */
  env?: NodeJS.ProcessEnv
  stdin?: string
  userRequested?: UserAction
}

/**
 * Asks the central Git check about a store command, as it runs: the store as `GIT_DIR` (a store Mousse owns), its folder
 * as `GIT_WORK_TREE`, and the isolation. Throws a refusal; the command never runs without it.
 */
export function checkStoreCommand(store: HiddenStore, cwd: string, args: readonly string[], options: StoreCommandOptions = {}, workTree = true): void {
  assertGitAllowed({ cwd, args, env: { ...options.env, ...location(store, workTree), ...isolation() }, stdin: options.stdin, userRequested: options.userRequested, lockFree: true })
}



/** The whole environment for a caller that cannot pass options (simple-git): the store, its folder and the isolation. */
export function hiddenStoreEnv(store: HiddenStore, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...isolatedEnv(store, base), ...location(store, true) }
}

/**
 * Git on the store itself (no work tree): its creation, ref maintenance and garbage collection. Checked by the central
 * Git check like every store command, and isolated from the person's config.
 */
/** `base` is the caller's environment (`repoProgramEnv()`); the isolation is applied on top. */
export function runStoreGit(store: HiddenStore, args: readonly string[], base: NodeJS.ProcessEnv = process.env): string {
  const run = ['--no-optional-locks', ...args]
  if (args[0] === 'init') {
    // Before the store exists there is no `GIT_DIR` to name: `init` names the folder it makes, under the Mousse home.
    assertGitAllowed({ cwd: dirname(store.gitDir), args: run, env: isolation(), lockFree: true })
    return execFileSync('git', run, { cwd: dirname(store.gitDir), env: isolatedEnv(store, base), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  }
  checkStoreCommand(store, store.gitDir, run, {}, false)
  return execFileSync('git', run, { cwd: store.gitDir, env: { ...isolatedEnv(store, base), ...location(store, false) }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** The identity that mutation leases of the store are keyed on: every thread that shares the store shares the lease. */
export function hiddenStoreIdentity(store: HiddenStore): RepositoryIdentity {
  const key = createHash('sha256').update(store.gitDir.toLowerCase()).digest('hex').slice(0, 32)
  const metadataDir = join(store.gitDir, 'mousse')
  mkdirSync(metadataDir, { recursive: true })
  return { commonDir: store.gitDir, key, worktreePath: store.workTree, metadataDir, capability: { allowed: true } }
}
