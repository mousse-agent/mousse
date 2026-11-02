import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { GIT_NULL_DEVICE } from './gitNullDevice'

/**
 * Environment for Git that runs without the user asking for it (the bridge's bundle
 * ingest, a future background fetch): no prompt of any kind can open. Callers add
 * `-c credential.interactive=false` to the command line; it is not an environment variable.
 */
export function nonInteractiveGitEnv(): Record<string, string> {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: GIT_NULL_DEVICE,
    SSH_ASKPASS: GIT_NULL_DEVICE,
    SSH_ASKPASS_REQUIRE: 'never',
    GCM_INTERACTIVE: 'never'
  }
}

/**
 * Environment for a Git action the user just pressed. The service has no terminal, so a
 * terminal prompt could never be answered and is turned off. Git Credential Manager,
 * askpass helpers and SSH passphrase prompts keep working; a silence timer stops an
 * action that waits on one forever.
 */
export function explicitActionGitEnv(): Record<string, string> {
  return { GIT_TERMINAL_PROMPT: '0' }
}

/**
 * Settings every Git process Mousse starts carries, whoever asked for it. `safe.bareRepository=explicit`
 * keeps Git from treating a folder it walks up to as a bare repository: a bare repository an agent or an
 * archive left inside a project would otherwise be found, and its config read, by a command run below it.
 * They are passed in the environment (`GIT_CONFIG_COUNT`), which reaches every Git that process starts
 * (hooks, `gh`, credential helpers) and counts as command-line config, the only kind besides the user's
 * own that Git reads this setting from.
 */
export const MOUSSE_GIT_CONFIG: ReadonlyArray<readonly [string, string]> = [['safe.bareRepository', 'explicit']]

/**
 * `env` with `entries` added as `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` after any the environment
 * already lists, so a user's own `GIT_CONFIG_COUNT` entries stay. An entry already present with the same
 * value is not added again, so wrapping an environment twice changes nothing. A count Git would reject
 * (not a whole number) is replaced: Git refuses to run at all with it.
 */
export function withGitConfigEnv(env: NodeJS.ProcessEnv, entries: ReadonlyArray<readonly [string, string]> = MOUSSE_GIT_CONFIG): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env }
  const raw = next.GIT_CONFIG_COUNT
  let count = raw !== undefined && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : 0
  if (raw !== undefined && count === 0) {
    // An invalid or zero count: none of its entries apply, so stale keys must not be revived by a later count.
    for (const key of Object.keys(next)) if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete next[key]
  }
  for (const [key, value] of entries) {
    // The last entry for a key wins in Git: ours is added unless the last one already says the same.
    let last = -1
    for (let index = 0; index < count; index++) if (next[`GIT_CONFIG_KEY_${index}`]?.toLowerCase() === key.toLowerCase()) last = index
    if (last >= 0 && next[`GIT_CONFIG_VALUE_${last}`] === value) continue
    next[`GIT_CONFIG_KEY_${count}`] = key
    next[`GIT_CONFIG_VALUE_${count}`] = value
    count += 1
  }
  next.GIT_CONFIG_COUNT = String(count)
  return next
}

/**
 * The environment for a Git process Mousse starts: `GIT_*` variables inherited from Mousse's own
 * environment that could send it elsewhere are dropped ({@link stripInheritedGitEnv}), then
 * {@link MOUSSE_GIT_CONFIG} is added.
 */
export function mousseGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return withGitConfigEnv(stripInheritedGitEnv(env))
}

/**
 * Whether `path` is itself a Git directory (a bare repository, or a repository's `.git` or common
 * directory) rather than a working tree: what Git checks before it uses a folder as a repository.
 */
export function isGitDirectory(path: string): boolean {
  try {
    if (existsSync(join(path, '.git'))) return false
    return statSync(join(path, 'HEAD')).isFile() && statSync(join(path, 'objects')).isDirectory() && statSync(join(path, 'refs')).isDirectory()
  } catch {
    return false
  }
}

/**
 * `GIT_DIR` for a command Mousse runs inside a Git directory it named itself (a repository's common
 * directory, the bridge's quarantine). With `safe.bareRepository=explicit` Git no longer finds such a
 * folder on its own; naming it says that Mousse chose it, while a bare repository Git would only reach
 * by walking up from the working folder stays refused.
 */
export function gitDirectoryEnv(cwd: string): Record<string, string> {
  return isGitDirectory(cwd) ? { GIT_DIR: resolve(cwd) } : {}
}

/**
 * `GIT_*` variables a Git process may inherit from Mousse's own environment: where the user's config lives,
 * their command-line config, identity and commit dates, and how they reach remotes. Every other `GIT_*` the process
 * inherited (`GIT_DIR`, `GIT_INDEX_FILE`, `GIT_WORK_TREE`, `GIT_CONFIG_PARAMETERS` from a hook that started
 * Mousse, ...) is dropped, so it cannot send Mousse's commands to another repository or index.
 */
const INHERITED_KEEP = /^GIT_(CONFIG_(GLOBAL|SYSTEM|NOSYSTEM|COUNT|KEY_\d+|VALUE_\d+)|(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)|SSH|SSH_COMMAND|SSH_VARIANT|SSL_\w+|HTTP_\w+|PROXY_\w+|ASKPASS|TERMINAL_PROMPT|EDITOR|SEQUENCE_EDITOR|PAGER|TRACE2_EVENT|OPTIONAL_LOCKS|NO_LAZY_FETCH|LFS_\w+)$/

/**
 * `env` without the `GIT_*` variables it inherited from `inherited` (the process's own by default) that
 * are not in the keep-list. A variable the caller set itself, to a value of its own, stays.
 */
export function stripInheritedGitEnv(env: NodeJS.ProcessEnv, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env }
  for (const key of Object.keys(next)) {
    if (!/^GIT_/i.test(key) || INHERITED_KEEP.test(key)) continue
    if (inherited[key] !== undefined && next[key] === inherited[key]) delete next[key]
  }
  return next
}
