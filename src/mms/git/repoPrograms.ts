import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import simpleGit, { type SimpleGit, type SimpleGitOptions } from 'simple-git'
import { NO_HOOKS_PATH } from './gitNullDevice'

/**
 * Git commands Mousse runs on a user's repository start no program the repository configures.
 *
 * Only repository-local configuration (`.git/config`, `config.worktree` and whatever they include) is
 * untrusted: an agent that can write files can write it, or point a worktree's `.git` file at a folder
 * it wrote. The user's global and system configuration is theirs, so the user's identity, line endings,
 * Git LFS (installed globally or by Git for Windows), credential helpers and signing keep working.
 *
 * Every command gets `-c` settings that:
 * - turn hooks off (`core.hooksPath` to the null device, {@link NO_HOOKS_PATH}, and every event's config-defined hooks), so a
 *   husky-style relative hooks path, a `post-commit` that `--no-verify` does not skip, or a `.git` file
 *   pointing at a planted hooks folder never runs;
 * - turn `core.fsmonitor` off, refuse the `ext::` protocol and keep Git out of submodules, where the
 *   submodule's own configuration would apply;
 * - for each program the repository's own config names (filter drivers, diff and merge drivers, ssh,
 *   askpass, editor, signing programs, upload/receive-pack, credential helpers), put back the user's
 *   value for that key, or a value that runs nothing. A filter driver the repository defines is
 *   emptied and not required, so its files are read and written as stored.
 *
 * The settings reach every Git process the command starts (Git passes `-c` on to its children).
 * Diff-producing commands also add {@link NO_DIFF_PROGRAMS}. The commit and push the user presses in
 * the Git panel keep the repository's hooks (`hooks: true`), as a commit from a terminal would.
 */

/** Every hook event in githooks(5); each is turned off by name, which `core.hooksPath` does not reach. */
export const HOOK_EVENTS = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg',
  'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'pre-receive', 'update',
  'proc-receive', 'post-receive', 'post-update', 'reference-transaction', 'push-to-checkout', 'pre-auto-gc',
  'post-rewrite', 'sendemail-validate', 'fsmonitor-watchman', 'p4-changelist', 'p4-prepare-changelist',
  'p4-post-changelist', 'p4-pre-submit', 'post-index-change'
] as const

/** Arguments for `diff`, `show` and `log -p`: no external diff and no textconv, whoever configured them. */
export const NO_DIFF_PROGRAMS = ['--no-ext-diff', '--no-textconv'] as const

export interface RepoProgramOptions {
  /**
   * Keep the repository's hooks. Only for the commit and push the user presses in the Git panel, whose
   * hook output and rejection are shown to them. Every other setting still applies.
   */
  hooks?: boolean
}

/** Settings that do not depend on the repository. */
const FIXED = [
  'core.fsmonitor=false',
  'protocol.ext.allow=never',
  'submodule.recurse=false',
  'diff.ignoreSubmodules=dirty',
  'status.submoduleSummary=false',
  'diff.submodule=short'
]

const HOOKS_OFF = [`core.hooksPath=${NO_HOOKS_PATH}`, ...HOOK_EVENTS.map((event) => `hook.${event}.enabled=false`)]

/** Config written by the user (or their environment) rather than by the repository. */
const TRUSTED_SCOPES = new Set(['system', 'global', 'command'])

/** Keys that name a program, and the value that runs nothing (or Git's own default program). */
const PROGRAM_KEYS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^filter\..+\.(clean|smudge|process)$/, ''],
  [/^diff\..+\.(command|textconv)$/, ''],
  [/^diff\.external$/, ''],
  [/^merge\..+\.driver$/, 'false'],
  [/^core\.sshcommand$/, 'ssh'],
  [/^core\.askpass$/, ''],
  [/^(core|sequence)\.editor$/, ':'],
  [/^gpg\.(openpgp\.)?program$/, 'gpg'],
  [/^gpg\.x509\.program$/, 'gpgsm'],
  [/^gpg\.ssh\.program$/, 'ssh-keygen'],
  [/^gpg\.ssh\.defaultkeycommand$/, ''],
  [/^remote\..+\.uploadpack$/, 'git-upload-pack'],
  [/^remote\..+\.receivepack$/, 'git-receive-pack'],
  [/^core\.alternaterefscommand$/, '']
]

const CREDENTIAL_HELPER = /^credential\.(.+\.)?helper$/

/** Keys whose repository value cannot be overridden from the command line; such a repository is refused. */
const UNOVERRIDABLE = /^core\.gitproxy$/

interface ConfigEntry { scope: string; origin: string; key: string; value: string | null }

interface RepoPrograms {
  /** `key=value` settings for the repository's own programs. */
  overrides: string[]
  /** Hooks named in config (`hook.<name>.*`), turned off by name. */
  hookNames: string[]
}

/** Thrown instead of running Git when the repository configures a program that cannot be turned off. */
export class RepoProgramError extends Error {}

function lower(key: string): string {
  // Section and variable names are case-insensitive (Git prints them lowercased); a subsection is not.
  const first = key.indexOf('.')
  const last = key.lastIndexOf('.')
  return first === last ? key.toLowerCase() : `${key.slice(0, first).toLowerCase()}${key.slice(first, last)}${key.slice(last).toLowerCase()}`
}

function parseConfig(stdout: string): ConfigEntry[] {
  const fields = stdout.split('\0')
  const entries: ConfigEntry[] = []
  // `--null --show-scope --show-origin --list`: scope NUL origin NUL key [LF value] NUL.
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const [scope, origin, pair] = [fields[index]!, fields[index + 1]!, fields[index + 2]!]
    const newline = pair.indexOf('\n')
    entries.push({ scope, origin, key: lower(newline < 0 ? pair : pair.slice(0, newline)), value: newline < 0 ? null : pair.slice(newline + 1) })
  }
  return entries
}

function setting(key: string, value: string): string {
  if (/[=\n\r\0]/.test(key)) throw new RepoProgramError(`This repository's config names a program under "${key.replace(/[\n\r\0]/g, ' ')}", which Mousse cannot turn off, so it does not run Git here.`)
  return `${key}=${value}`
}

/** The overrides for one repository's config listing. */
export function repoProgramOverrides(entries: readonly ConfigEntry[]): RepoPrograms {
  const trusted = (entry: ConfigEntry): boolean => TRUSTED_SCOPES.has(entry.scope)
  const lastTrusted = (key: string): string | null | undefined => entries.filter((entry) => trusted(entry) && entry.key === key).at(-1)?.value
  const overrides: string[] = []
  const emptiedFilters = new Set<string>()
  let credentials = false
  const hookNames = new Set<string>()
  // The value Git would use for each key: the last one listed.
  const effective = new Map<string, ConfigEntry>()
  for (const entry of entries) {
    const hook = /^hook\.(.+)\.[^.]+$/.exec(entry.key)
    if (hook) hookNames.add(hook[1]!)
    effective.set(entry.key, entry)
    // Credential helpers add up; any the repository adds clears the list below.
    if (!trusted(entry) && CREDENTIAL_HELPER.test(entry.key) && entry.value) credentials = true
  }
  for (const entry of effective.values()) {
    // The user's own value, or one that names no program (a pinned empty filter, for one): nothing to undo.
    if (trusted(entry) || !entry.value) continue
    if (UNOVERRIDABLE.test(entry.key)) throw new RepoProgramError(`This repository's own config sets ${entry.key}, which Mousse cannot turn off, so it does not run Git here.`)
    const rule = PROGRAM_KEYS.find(([pattern]) => pattern.test(entry.key))
    if (!rule) continue
    const own = lastTrusted(entry.key)
    overrides.push(setting(entry.key, own ?? rule[1]))
    const filter = /^filter\.(.+)\.(clean|smudge|process)$/.exec(entry.key)
    if (filter && own == null) emptiedFilters.add(filter[1]!)
  }
  for (const name of emptiedFilters) overrides.push(setting(`filter.${name}.required`, 'false'))
  if (credentials) {
    // An empty helper clears the list; the user's own helpers are then added back in their order.
    overrides.push('credential.helper=')
    for (const entry of entries) if (trusted(entry) && CREDENTIAL_HELPER.test(entry.key) && entry.value) overrides.push(setting(entry.key, entry.value))
  }
  return { overrides, hookNames: [...hookNames] }
}

interface Cached { watched: Array<readonly [string, string]>; programs: RepoPrograms }

const cache = new Map<string, Cached>()
const CACHE_LIMIT = 256

function signature(path: string): string {
  const stat = statSync(path, { bigint: true, throwIfNoEntry: false })
  return stat ? `${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}:${stat.ino}` : '-'
}

function bareGit(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })
  return { ok: !result.error && result.status === 0, stdout: result.error ? '' : result.stdout ?? '' }
}

/**
 * The repository's programs, read from its config. Cached until a file that could change the answer
 * changes: each config file listed, the repository's config files, and every `.git` between `cwd` and
 * the top of the worktree (a new or rewritten one would make Git find another repository). A
 * repository that includes other files from its own config is read every time.
 */
function programsFor(cwd: string): RepoPrograms {
  const key = resolve(cwd)
  const hit = cache.get(key)
  if (hit && hit.watched.every(([path, sig]) => signature(path) === sig)) return hit.programs
  cache.delete(key)
  const where = bareGit(key, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'])
  const listing = bareGit(key, ['config', '--null', '--show-scope', '--show-origin', '--list'])
  // Not a repository (or not readable): nothing of a repository's own can run.
  if (!listing.ok) return { overrides: [], hookNames: [] }
  const entries = parseConfig(listing.stdout)
  const programs = repoProgramOverrides(entries)
  const [gitDir, commonDir, top] = where.stdout.split(/\r?\n/).map((line) => line.trim())
  const includes = entries.some((entry) => !TRUSTED_SCOPES.has(entry.scope) && /^include(if\..+)?\.path$/i.test(entry.key))
  if (where.ok && gitDir && commonDir && top && !includes) {
    const paths = new Set<string>([join(gitDir, 'config'), join(gitDir, 'config.worktree'), join(gitDir, 'commondir'), join(commonDir, 'config')])
    for (const entry of entries) if (entry.origin.startsWith('file:')) paths.add(resolve(key, entry.origin.slice(5)))
    for (let dir = key; ; dir = dirname(dir)) {
      paths.add(join(dir, '.git'))
      if (resolve(dir) === resolve(top) || dirname(dir) === dir) break
    }
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!)
    cache.set(key, { watched: [...paths].map((path) => [path, signature(path)] as const), programs })
  }
  return programs
}

/** The `key=value` settings for a Git command in `cwd` (simple-git's `config` option takes these). */
export function repoProgramSettings(cwd: string, options: RepoProgramOptions = {}): string[] {
  const programs = programsFor(cwd)
  const hooks = options.hooks ? [] : [...HOOKS_OFF, ...programs.hookNames.filter((name) => !(HOOK_EVENTS as readonly string[]).includes(name)).map((name) => setting(`hook.${name}.enabled`, 'false'))]
  return [...FIXED, ...hooks, ...programs.overrides]
}

/** `-c` arguments that go before the Git subcommand. */
export function noRepoProgramArgs(cwd: string, options?: RepoProgramOptions): string[] {
  return repoProgramSettings(cwd, options).flatMap((value) => ['-c', value])
}

/**
 * `args` with the `-c` arguments in front, for a `spawn('git', …)` in `cwd`. `git config` runs no
 * program and must read the repository's values as they are (a `-c` would answer for them), so it
 * is left alone.
 */
export function withoutRepoPrograms(cwd: string, args: readonly string[], options?: RepoProgramOptions): string[] {
  if (args[0] === 'config') return [...args]
  return [...noRepoProgramArgs(cwd, options), ...args]
}

/**
 * simple-git for `cwd` with the settings applied. simple-git refuses these keys unless allowed; they
 * are only ever set to the values above, never to a caller's.
 */
export function guardedSimpleGit(cwd: string, options: Partial<Omit<SimpleGitOptions, 'baseDir' | 'config' | 'unsafe'>> = {}): SimpleGit {
  return simpleGit({
    ...options,
    baseDir: cwd,
    config: repoProgramSettings(cwd),
    unsafe: {
      allowUnsafeHooksPath: true,
      allowUnsafeFsMonitor: true,
      allowUnsafeFilter: true,
      allowUnsafeDiffTextConv: true,
      allowUnsafeDiffExternal: true,
      allowUnsafeMergeDriver: true,
      allowUnsafeSshCommand: true,
      allowUnsafeAskPass: true,
      allowUnsafeEditor: true,
      allowUnsafeGpgProgram: true,
      allowUnsafePack: true,
      allowUnsafeCredentialHelper: true,
      allowUnsafeProtocolOverride: true
    }
  })
}

/** For tests: forget cached repositories. */
export function clearRepoProgramCache(): void {
  cache.clear()
}
