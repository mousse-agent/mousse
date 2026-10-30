import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
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

const stores = new Map<string, HiddenStore>()
const scope = new AsyncLocalStorage<HiddenStore>()

function canonical(path: string): string {
  const resolved = resolve(path)
  try { return realpathSync.native(resolved) } catch { return resolved }
}

function key(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function inside(root: string, path: string): boolean {
  const base = key(root)
  const target = key(path)
  return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

/** Tells the process that the folder's snapshots live in `store`. Operations on the folder find it through `hiddenStoreFor`. */
export function registerHiddenStore(store: HiddenStore): HiddenStore {
  const entry = { workTree: canonical(store.workTree), gitDir: resolve(store.gitDir) }
  stores.set(key(entry.workTree), entry)
  stores.set(key(resolve(store.workTree)), entry)
  return entry
}

/** The store registered for the folder `cwd` is, or is inside. */
export function hiddenStoreFor(cwd: string): HiddenStore | undefined {
  if (stores.size === 0) return undefined
  const path = resolve(cwd)
  for (const store of stores.values()) if (inside(store.workTree, path)) return store
  return undefined
}

/** For tests: forget every registered store. */
export function clearHiddenStores(): void {
  stores.clear()
}

/**
 * Runs `operation` with Git commands that Mousse's snapshot code runs inside the store's folder going through the store.
 * Only commands run inside this scope are redirected; the Git panel and every other caller keep seeing a folder with no
 * repository.
 */
export function inHiddenStore<T>(store: HiddenStore, operation: () => T): T {
  return scope.run(store, operation)
}

/** `inHiddenStore` for the store registered for `cwd`, when there is one. */
export function inSnapshotScope<T>(cwd: string, operation: () => T): T {
  const store = hiddenStoreFor(cwd)
  return store ? scope.run(store, operation) : operation()
}

/** The store Git commands in `cwd` go through right now, if the caller is inside a scope for it. */
export function activeHiddenStore(cwd: string): HiddenStore | undefined {
  const store = scope.getStore()
  return store && inside(store.workTree, resolve(cwd)) ? store : undefined
}

/** Git's global options that point a command at the store. */
export function hiddenStoreArgs(store: HiddenStore): string[] {
  return [`--git-dir=${store.gitDir}`, `--work-tree=${store.workTree}`]
}

/** The same, as environment variables, for a caller that cannot pass options (simple-git). */
export function hiddenStoreEnv(store: HiddenStore): NodeJS.ProcessEnv {
  return { GIT_DIR: store.gitDir, GIT_WORK_TREE: store.workTree }
}

/** The identity that mutation leases of the store are keyed on: every thread that shares the store shares the lease. */
export function hiddenStoreIdentity(store: HiddenStore): RepositoryIdentity {
  const key = createHash('sha256').update(store.gitDir.toLowerCase()).digest('hex').slice(0, 32)
  const metadataDir = join(store.gitDir, 'mousse')
  mkdirSync(metadataDir, { recursive: true })
  return { commonDir: store.gitDir, key, worktreePath: store.workTree, metadataDir, capability: { allowed: true } }
}
