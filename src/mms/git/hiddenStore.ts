import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { RepositoryIdentity } from './RepositoryIdentity'

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

/** Git's global options that point a command at the store. */
export function hiddenStoreArgs(store: HiddenStore): string[] {
  return [`--git-dir=${store.gitDir}`, `--work-tree=${store.workTree}`]
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

/** Settings every store command runs with, whatever the person's config, as if given with `-c`. */
function isolatedSettings(empty: string, hooks: string): Array<[string, string]> {
  return [
    ['core.autocrlf', 'false'], ['core.safecrlf', 'false'], ['core.eol', 'lf'],
    ['core.attributesFile', empty], ['core.excludesFile', empty], ['core.hooksPath', hooks],
    ['core.fsmonitor', 'false'], ['core.untrackedCache', 'false'],
    ['core.symlinks', process.platform === 'win32' ? 'false' : 'true'],
    ['core.checkRoundtripEncoding', ''], ['advice.addIgnoredFile', 'false']
  ]
}

const prepared = new Set<string>()

/** The store's empty config, attributes and hooks folder, and its attributes override; written once per process. */
function isolationFiles(store: HiddenStore): { empty: string; hooks: string } {
  const directory = join(store.gitDir, 'mousse', 'isolation')
  const empty = join(directory, 'empty')
  const hooks = join(directory, 'hooks')
  if (!prepared.has(store.gitDir)) {
    mkdirSync(hooks, { recursive: true })
    if (!existsSync(empty)) writeFileSync(empty, '')
    const attributes = join(store.gitDir, 'info', 'attributes')
    mkdirSync(join(store.gitDir, 'info'), { recursive: true })
    let current = ''
    try { current = readFileSync(attributes, 'utf8') } catch { /* not there yet */ }
    if (current !== STORE_ATTRIBUTES) writeFileSync(attributes, STORE_ATTRIBUTES)
    prepared.add(store.gitDir)
  }
  return { empty, hooks }
}

/** Configuration and attribute sources outside the store that a store command must never read. */
const OUTSIDE_SOURCES = /^GIT_(CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|ATTR_SOURCE|EXTERNAL_DIFF|DIFF_OPTS)$/

/**
 * `base` for a command in the store: no system or global config (the person's filters, hooks, `core.autocrlf` and the
 * rest), no system attributes, no config from the environment, and the store's fixed settings. With the store's own
 * attributes override, what the store records and restores is a file's exact bytes.
 */
export function isolatedEnv(store: HiddenStore, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { empty, hooks } = isolationFiles(store)
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) if (!OUTSIDE_SOURCES.test(key)) env[key] = value
  const settings = isolatedSettings(empty, hooks)
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = empty
  env.GIT_ATTR_NOSYSTEM = '1'
  env.GIT_CONFIG_COUNT = String(settings.length)
  settings.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key
    env[`GIT_CONFIG_VALUE_${index}`] = value
  })
  return env
}

/** The whole environment for a caller that cannot pass options (simple-git): the store, its folder and the isolation. */
export function hiddenStoreEnv(store: HiddenStore, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...isolatedEnv(store, base), GIT_DIR: store.gitDir, GIT_WORK_TREE: store.workTree }
}

/** The identity that mutation leases of the store are keyed on: every thread that shares the store shares the lease. */
export function hiddenStoreIdentity(store: HiddenStore): RepositoryIdentity {
  const key = createHash('sha256').update(store.gitDir.toLowerCase()).digest('hex').slice(0, 32)
  const metadataDir = join(store.gitDir, 'mousse')
  mkdirSync(metadataDir, { recursive: true })
  return { commonDir: store.gitDir, key, worktreePath: store.workTree, metadataDir, capability: { allowed: true } }
}
