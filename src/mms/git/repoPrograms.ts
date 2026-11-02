import { spawn, spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import simpleGit, { type SimpleGit, type SimpleGitOptions } from 'simple-git'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { gitDirectoryEnv, gitDirectoryEnvAsync, mousseGitEnv } from './gitEnv'
import { assertGitAllowed, assertGitAllowedAsync, type UserAction } from './gitPolicy'
import { NO_HOOKS_PATH } from './gitNullDevice'
import { activeHiddenStore, checkStoreCommandAsync, hiddenStoreEnv } from './hiddenStore'
import { isTrustedRepoEntry, readRepoTrust, readRepoTrustAt, readRepoTrustAtAsync, repoTrustPath, repoTrustPathAsync, TRUSTED_FILTER_KEY, writeRepoTrust, type RepoTrustRecord } from './repoTrust'
import { waitForFolderAccess } from '../files/folderAccess'

/**
 * Git commands Mousse runs on a user's repository start no program the repository configures.
 *
 * Only repository-local configuration (`.git/config`, `config.worktree` and whatever they include) is
 * untrusted: an agent that can write files can write it, or point a worktree's `.git` file at a folder
 * it wrote. The user's global and system configuration is theirs, so the user's identity, line endings,
 * Git LFS (installed globally or by Git for Windows), credential helpers and signing keep working.
 *
 * Every command Mousse runs by itself (checkpoints, restore and undo, status polling, diffs, worktree
 * creation and removal, agent-triggered reads) gets `-c` settings that:
 * - turn hooks off (`core.hooksPath` to a folder that cannot exist, {@link NO_HOOKS_PATH}, and every event's config-defined hooks), so a
 *   husky-style relative hooks path, a `post-commit` that `--no-verify` does not skip, or a `.git` file
 *   pointing at a planted hooks folder never runs;
 * - turn `core.fsmonitor` off, refuse the `ext::` protocol and keep Git out of submodules, where the
 *   submodule's own configuration would apply;
 * - for each program the repository's own config names (filter drivers, diff and merge drivers, ssh,
 *   askpass, editor, signing programs, upload/receive-pack, credential helpers), put back the user's
 *   value for that key, or a value that runs nothing. A filter driver the repository's own config
 *   defines (git-crypt, a `git lfs install --local`, nbstripout) runs only while its command is the
 *   one recorded when the user added the project ({@link trustRepositoryPrograms}); otherwise it is
 *   emptied. A read compares its files as
 *   stored (`required=false`); a command that writes the index or the working tree keeps it required,
 *   so Git refuses those files instead of storing them unfiltered ({@link filterRefusal}).
 *
 * The settings are worked out for each command, so a config written between two commands is seen,
 * and they reach every Git process the command starts (Git passes `-c` on to its children). One race
 * remains: config written between the check and Git reading it. Diff-producing commands also add
 * {@link NO_DIFF_PROGRAMS}.
 *
 * The actions the user presses in the Git panel (stage, discard, commit, fetch, pull, switch, push)
 * are theirs, as in a terminal: `userAction` keeps the repository's hooks and programs (a per-repo
 * `core.sshCommand` for a second account, git-crypt, a signing program). Only the fixed settings apply.
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
   * An action the user pressed in the Git panel: the repository's hooks and programs run, as they
   * would from a terminal. Only the fixed settings (no fsmonitor, no `ext::`, no submodules) apply.
   */
  userAction?: boolean
}

/** What the central Git check ({@link assertGitAllowed}) needs besides the command itself. */
export interface GitCheckOptions {
  /** The user's request, for a command that changes something Mousse does not own. */
  userRequested?: UserAction
  /** Standard input, for `update-ref --stdin`. */
  stdin?: string
  /** The environment the caller sets explicitly (a private `GIT_INDEX_FILE`). */
  env?: NodeJS.ProcessEnv
}

/** Subcommands that write the index, objects from files, or the working tree through filters. */
const WRITES = new Set([
  'add', 'commit', 'checkout', 'switch', 'restore', 'reset', 'stash', 'merge', 'pull', 'rebase', 'cherry-pick',
  'revert', 'am', 'apply', 'read-tree', 'checkout-index', 'update-index', 'sparse-checkout', 'clone', 'mv'
])

/** Global options that take a value as the next argument. */
const OPTIONS_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path'])

/** The subcommand and its arguments, past Git's own options. */
function subcommand(args: readonly string[]): readonly string[] {
  let index = 0
  while (index < args.length && args[index]!.startsWith('-')) index += OPTIONS_WITH_VALUE.has(args[index]!) ? 2 : 1
  return args.slice(index)
}

/** Whether a command can write files through a filter into the index, the object store or the worktree. */
export function writesThroughFilters(args: readonly string[]): boolean {
  const [command, ...rest] = subcommand(args)
  if (!command) return false
  if (command === 'worktree') return rest[0] === 'add'
  if (command === 'hash-object') return rest.includes('-w')
  return WRITES.has(command)
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

/**
 * For Mousse's own commands: a read never writes the index. `git status` refreshes and writes it back
 * unless optional locks are off (`--no-optional-locks`, added in {@link withoutRepoPrograms}), and
 * `git diff` does whenever it finds a file whose stat data alone changed, unless this is off. A command
 * that writes the index on purpose still does.
 */
export const NO_INDEX_REFRESH = ['diff.autoRefreshIndex=false'] as const

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

/**
 * Programs Git LFS (a filter the user installed, often from Git for Windows' system config) reads
 * from the repository's config and starts itself. An LFS extension the repository defines also
 * empties the `lfs` filter, so writes through it are refused rather than stored unfiltered.
 */
const LFS_PROGRAM_KEYS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^lfs\.extension\..+\.(clean|smudge)$/, ''],
  [/^lfs\.customtransfer\..+\.(path|args)$/, ''],
  [/^lfs\.(.+\.)?standalonetransferagent$/, '']
]
const LFS_EXTENSION = /^lfs\.extension\..+\.(clean|smudge)$/

/**
 * Set for Mousse's own Git commands and every filter they start: Python does not import modules from
 * the current folder (`python -m nbstripout` would load an `nbstripout.py` an agent wrote in the
 * worktree), and Windows does not look up a bare program name (`git`) in the current folder first.
 */
export const SAFE_LOOKUP_ENV: Readonly<Record<string, string>> = { PYTHONSAFEPATH: '1', NoDefaultCurrentDirectoryInExePath: '1' }

/**
 * `env` (the process's own by default) with {@link SAFE_LOOKUP_ENV} and the settings every Git process
 * Mousse starts carries ({@link mousseGitEnv}), for a Git command Mousse runs by itself.
 */
export function repoProgramEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return mousseGitEnv({ ...env, ...SAFE_LOOKUP_ENV })
}

/** Keys whose repository value cannot be overridden from the command line; such a repository is refused. */
const UNOVERRIDABLE = /^core\.gitproxy$/

interface ConfigEntry { scope: string; origin: string; key: string; value: string | null }

interface RepoPrograms {
  /** `key=value` settings for the repository's own programs. */
  overrides: string[]
  /** Filter drivers only the repository defines, emptied in `overrides`. */
  emptiedFilters: string[]
  /** Hooks named in config (`hook.<name>.*`), turned off by name. */
  hookNames: string[]
}

const NONE: RepoPrograms = { overrides: [], emptiedFilters: [], hookNames: [] }

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

/**
 * The overrides for one repository's config listing. `record` holds the repository's own filter
 * commands the user trusted; an entry with the same key and command is treated as the user's own.
 */
export function repoProgramOverrides(entries: readonly ConfigEntry[], record: RepoTrustRecord | null = null): RepoPrograms {
  const trusted = (entry: ConfigEntry): boolean => TRUSTED_SCOPES.has(entry.scope) || isTrustedRepoEntry(record, entry.key, entry.value)
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
    const rule = [...PROGRAM_KEYS, ...LFS_PROGRAM_KEYS].find(([pattern]) => pattern.test(entry.key))
    if (!rule) continue
    if (LFS_EXTENSION.test(entry.key) && !emptiedFilters.has('lfs')) {
      emptiedFilters.add('lfs')
      for (const part of ['clean', 'smudge', 'process']) overrides.push(`filter.lfs.${part}=`)
    }
    const own = lastTrusted(entry.key)
    overrides.push(setting(entry.key, own ?? rule[1]))
    const filter = /^filter\.(.+)\.(clean|smudge|process)$/.exec(entry.key)
    if (filter && own == null) emptiedFilters.add(filter[1]!)
  }
  if (credentials) {
    // An empty helper clears the list; the user's own entries are then added back in their order,
    // their own empty resets included (`gh auth setup-git` clears the list for github.com).
    overrides.push('credential.helper=')
    for (const entry of entries) if (trusted(entry) && CREDENTIAL_HELPER.test(entry.key) && entry.value !== null) overrides.push(setting(entry.key, entry.value))
  }
  // A hook whose name cannot be written as `-c` is still off: every event is turned off by name.
  return { overrides, emptiedFilters: [...emptiedFilters], hookNames: [...hookNames].filter((name) => !/[=\n\r\0]/.test(name)) }
}

interface Cached { watched: Array<readonly [string, string]>; programs: RepoPrograms }

const cache = new Map<string, Cached>()
const CACHE_LIMIT = 256
let probes = 0

/** For tests: how many times a repository's config has been read rather than taken from the cache. */
export function repoProgramProbes(): number {
  return probes
}

/**
 * What a watched path is now. A folder is known by its identity only: Git changes a `.git` folder's
 * times on every `index.lock`, and the config files in it are watched one by one.
 */
function signature(path: string): string {
  const stat = statSync(path, { bigint: true, throwIfNoEntry: false })
  if (!stat) return '-'
  return stat.isDirectory() ? `dir:${stat.dev}:${stat.ino}` : `${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}:${stat.ino}`
}

/** Every `.git` from `dir` up to the root (or to `top`): a new one would make Git find another repository. */
function dotGitsUpFrom(dir: string, top?: string): string[] {
  const paths: string[] = []
  for (let current = dir; ; current = dirname(current)) {
    paths.push(join(current, '.git'))
    if ((top && resolve(current) === resolve(top)) || dirname(current) === current) break
  }
  return paths
}

function remember(key: string, paths: Iterable<string>, signatures: readonly string[], programs: RepoPrograms): void {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  cache.set(key, { watched: [...paths].map((path, index) => [path, signatures[index]!] as const), programs })
}

/** What a probe of the repository's config returns. */
interface BareResult {
  ok: boolean
  stdout: string
  /** Git could not be run or read in full (a timeout, output past the limit). */
  failed: boolean
  /** Git was still running at the time limit. */
  timedOut: boolean
}

/** How long a probe may run before it is stopped. */
let probeTimeoutMs = 30_000
const PROBE_MAX_BUFFER = 16 * 1024 * 1024

const PROBE_ARGS = (args: readonly string[]): string[] => ['-c', 'core.fsmonitor=false', ...args]

function bareGit(cwd: string, args: string[]): BareResult {
  assertGitAllowed({ cwd, args })
  // A common directory Mousse names is named the same way for the probe as for the command it is for.
  const result = spawnSync('git', PROBE_ARGS(args), { cwd, encoding: 'utf8', windowsHide: true, timeout: probeTimeoutMs, maxBuffer: PROBE_MAX_BUFFER, env: repoProgramEnv({ ...process.env, GIT_OPTIONAL_LOCKS: '0', ...gitDirectoryEnv(cwd) }) })
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
  return { ok: !result.error && result.status === 0, stdout: result.error ? '' : result.stdout ?? '', failed: Boolean(result.error), timedOut }
}

/**
 * {@link bareGit} without blocking: the same central check (read without blocking), command, time and output
 * limits, and the same answer. Git running past a limit is stopped, as `spawnSync` stops it. `signal` stops
 * Git and rejects with its reason.
 */
async function bareGitAsync(cwd: string, args: string[], signal?: AbortSignal): Promise<BareResult> {
  await assertGitAllowedAsync({ cwd, args }, signal)
  const env = repoProgramEnv({ ...process.env, GIT_OPTIONAL_LOCKS: '0', ...await gitDirectoryEnvAsync(cwd) })
  signal?.throwIfAborted()
  return new Promise((settle, reject) => {
    const child = spawn('git', PROBE_ARGS(args), { cwd, windowsHide: true, env, stdio: ['ignore', 'pipe', 'ignore'], signal })
    const chunks: Buffer[] = []
    let size = 0
    let stopped: 'time' | 'size' | undefined
    let done = false
    const finish = (result: BareResult): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (signal?.aborted) reject(signal.reason)
      else settle(result)
    }
    const stop = (why: 'time' | 'size'): void => {
      stopped ??= why
      child.kill()
    }
    const timer = setTimeout(() => stop('time'), probeTimeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      if (stopped) return
      size += chunk.length
      if (size > PROBE_MAX_BUFFER) stop('size')
      else chunks.push(chunk)
    })
    child.on('error', () => finish({ ok: false, stdout: '', failed: true, timedOut: false }))
    child.on('close', (code) => finish(stopped
      ? { ok: false, stdout: '', failed: true, timedOut: stopped === 'time' }
      : { ok: code === 0, stdout: Buffer.concat(chunks).toString('utf8'), failed: false, timedOut: false }))
  })
}

/** {@link signature} without blocking. */
async function signatureAsync(path: string): Promise<string> {
  const found = await stat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    // `statSync` with `throwIfNoEntry: false` returns nothing only for a path that is not there; any other failure throws.
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
    throw error
  })
  if (!found) return '-'
  return found.isDirectory() ? `dir:${found.dev}:${found.ino}` : `${found.mtimeNs}:${found.ctimeNs}:${found.size}:${found.ino}`
}

const UNREADABLE = "This repository's Git config could not be read in full (it may be very large or include a file that cannot be read), so Mousse does not run Git here."
const CHANGING = "This repository's Git config kept changing while Mousse read it, so Mousse does not run Git here this time."

/**
 * What reading a repository's programs needs from the folder. {@link programsFor} answers each step
 * synchronously and {@link programsForAsync} without blocking; both run the same steps in the same
 * order, so they reach the same answer.
 */
type Step =
  | { kind: 'git'; cwd: string; args: string[] }
  | { kind: 'signature'; path: string }
  | { kind: 'trustPath'; commonDir: string }
  | { kind: 'trustRecord'; path: string }

type Reading<T> = Generator<Step, T, unknown>

function* signaturesOf(paths: readonly string[]): Reading<string[]> {
  const signatures: string[] = []
  for (const path of paths) signatures.push((yield { kind: 'signature', path }) as string)
  return signatures
}

function sameSignatures(before: readonly string[], after: readonly string[]): boolean {
  return before.length === after.length && before.every((value, index) => value === after[index])
}

/** Readings tried while the files they depend on keep changing, before the repository is refused for now. */
const READ_ATTEMPTS = 3

/**
 * The repository's programs, read from its config. Cached until a file that could change the answer
 * changes: each config file listed, the repository's config files, and every `.git` between `cwd` and
 * the top of the worktree (a new or rewritten one would make Git find another repository). A
 * repository that includes other files from its own config is read every time.
 */
function* readPrograms(key: string): Reading<RepoPrograms> {
  const hit = cache.get(key)
  if (hit) {
    let same = true
    // One at a time, stopping at the first change.
    for (const [path, sig] of hit.watched) {
      if ((yield { kind: 'signature', path }) !== sig) { same = false; break }
    }
    if (same) return hit.programs
  }
  cache.delete(key)
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    const programs = yield* readProgramsOnce(key)
    if (programs) return programs
  }
  throw new RepoProgramError(CHANGING)
}

/**
 * One reading of the repository's programs, or null when a file the answer depends on changed while it was
 * read. Each such file is looked at before Git reads it and again after, and only an answer whose files did
 * not change in between is used and cached: a `git init` while Git looks for the repository, or a config
 * written while Git lists it, is never cached as the old answer with the new files' state.
 */
function* readProgramsOnce(key: string): Reading<RepoPrograms | null> {
  probes += 1
  // Every `.git` from the folder up: one made or changed while Git looks would make it find another repository.
  const above = [...new Set([key, ...dotGitsUpFrom(key)])]
  const aboveBefore = yield* signaturesOf(above)
  const where = (yield { kind: 'git', cwd: key, args: ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'] }) as BareResult
  if (where.failed) throw new RepoProgramError(UNREADABLE)
  // Not a repository: nothing of a repository's own can run. Remembered until a `.git` appears above it.
  if (!where.ok) {
    const aboveAfter = yield* signaturesOf(above)
    if (!sameSignatures(aboveBefore, aboveAfter)) return null
    remember(key, above, aboveAfter, NONE)
    return NONE
  }
  const [gitDir, commonDir, top] = where.stdout.split(/\r?\n/).map((line) => line.trim())
  const trustPath = commonDir ? (yield { kind: 'trustPath', commonDir }) as string : null
  // The repository's own config files and the trust record, looked at before they are read.
  const own = gitDir && commonDir && trustPath ? [join(gitDir, 'config'), join(gitDir, 'config.worktree'), join(gitDir, 'commondir'), join(commonDir, 'config'), trustPath] : []
  const ownBefore = yield* signaturesOf(own)
  // Without the listing, nothing can be overridden: refuse rather than run the repository's programs.
  const listing = (yield { kind: 'git', cwd: key, args: ['config', '--null', '--show-scope', '--show-origin', '--list'] }) as BareResult
  if (!listing.ok) throw new RepoProgramError(UNREADABLE)
  const entries = parseConfig(listing.stdout)
  const record = trustPath ? (yield { kind: 'trustRecord', path: trustPath }) as RepoTrustRecord | null : null
  const programs = repoProgramOverrides(entries, record)
  const ownAfter = yield* signaturesOf(own)
  const aboveAfter = yield* signaturesOf(above)
  if (!sameSignatures(ownBefore, ownAfter) || !sameSignatures(aboveBefore, aboveAfter)) return null
  const includes = entries.some((entry) => !TRUSTED_SCOPES.has(entry.scope) && /^include(if\..+)?\.path$/i.test(entry.key))
  if (gitDir && commonDir && top && trustPath && !includes) {
    const known = new Map<string, string>([...above.map((path, index) => [path, aboveAfter[index]!] as const), ...own.map((path, index) => [path, ownAfter[index]!] as const)])
    const paths = new Set<string>(own)
    for (const entry of entries) if (entry.origin.startsWith('file:')) paths.add(resolve(key, entry.origin.slice(5)))
    for (const path of dotGitsUpFrom(key, top)) paths.add(path)
    const watched = [...paths]
    const signatures: string[] = []
    for (const path of watched) signatures.push(known.get(path) ?? (yield { kind: 'signature', path }) as string)
    remember(key, watched, signatures, programs)
  }
  return programs
}

function programsFor(cwd: string): RepoPrograms {
  const reading = readPrograms(resolve(cwd))
  for (let step = reading.next(); ; ) {
    if (step.done) return step.value
    const need = step.value
    step = reading.next(
      need.kind === 'git' ? bareGit(need.cwd, need.args)
        : need.kind === 'signature' ? signature(need.path)
          : need.kind === 'trustPath' ? repoTrustPath(need.commonDir)
            : readRepoTrustAt(need.path)
    )
  }
}

/**
 * {@link programsFor} without blocking: Git runs as a child process, the central check reads without
 * blocking, and files are read with async calls. It first waits until the folder's volume answers
 * ({@link waitForFolderAccess}). `signal` ends the wait, and stops Git, with its reason.
 */
async function programsForAsync(cwd: string, signal?: AbortSignal): Promise<RepoPrograms> {
  const key = resolve(cwd)
  await waitForFolderAccess([key], { signal })
  const reading = readPrograms(key)
  for (let step = reading.next(); ; ) {
    if (step.done) return step.value
    const need = step.value
    const answer = need.kind === 'git' ? await bareGitAsync(need.cwd, need.args, signal)
      : need.kind === 'signature' ? await signatureAsync(need.path)
        : need.kind === 'trustPath' ? await repoTrustPathAsync(need.commonDir)
          : await readRepoTrustAtAsync(need.path)
    signal?.throwIfAborted()
    step = reading.next(answer)
  }
}

function settingsFrom(programs: RepoPrograms, write: boolean | undefined): string[] {
  const hooks = [...HOOKS_OFF, ...programs.hookNames.filter((name) => !(HOOK_EVENTS as readonly string[]).includes(name)).map((name) => `hook.${name}.enabled=false`)]
  const required = programs.emptiedFilters.map((name) => `filter.${name}.required=${write ? 'true' : 'false'}`)
  return [...FIXED, ...NO_INDEX_REFRESH, ...hooks, ...programs.overrides, ...required]
}

/**
 * The `key=value` settings for a Git command in `cwd`. `write` keeps an emptied filter required (see
 * {@link writesThroughFilters}). Code that can wait uses {@link repoProgramSettingsAsync}.
 */
export function repoProgramSettings(cwd: string, options: RepoProgramOptions & { write?: boolean } = {}): string[] {
  if (options.userAction) return [...FIXED]
  return settingsFrom(programsFor(cwd), options.write)
}

/** What the async functions here also take: `signal` ends the wait for the folder and stops the check's Git. */
export interface WaitOptions { signal?: AbortSignal }

/** {@link repoProgramSettings} without blocking the daemon: the same settings, or the same refusal. */
export async function repoProgramSettingsAsync(cwd: string, options: RepoProgramOptions & WaitOptions & { write?: boolean } = {}): Promise<string[]> {
  if (options.userAction) {
    await waitForFolderAccess([resolve(cwd)], { signal: options.signal })
    return [...FIXED]
  }
  return settingsFrom(await programsForAsync(cwd, options.signal), options.write)
}

/**
 * Waits until `cwd`'s volume answers and reads its repository's programs, without blocking: throws the
 * {@link RepoProgramError} a Git command there would. Called before a run of simple-git commands whose
 * failures the caller turns into defaults, so a refused repository still shows its reason.
 */
export async function checkRepoPrograms(cwd: string, options: WaitOptions = {}): Promise<void> {
  await waitForFolderAccess([resolve(cwd)], options)
  // Inside a hidden store's scope, `guardedSimpleGit` runs nothing of the folder's config, so there is nothing to refuse.
  if (activeHiddenStore(cwd)) return
  await programsForAsync(cwd, options.signal)
}

/** `-c` arguments that go before the Git subcommand `args`. */
export function noRepoProgramArgs(cwd: string, args: readonly string[], options?: RepoProgramOptions): string[] {
  return repoProgramSettings(cwd, { ...options, write: writesThroughFilters(args) }).flatMap((value) => ['-c', value])
}

/** {@link noRepoProgramArgs} without blocking. */
export async function noRepoProgramArgsAsync(cwd: string, args: readonly string[], options?: RepoProgramOptions & WaitOptions): Promise<string[]> {
  return (await repoProgramSettingsAsync(cwd, { ...options, write: writesThroughFilters(args) })).flatMap((value) => ['-c', value])
}

/**
 * A clear message for Git refusing to write files whose filter only the repository defines, or null
 * when `output` is not that refusal.
 */
export function filterRefusal(output: string): string | null {
  const match = /(?:clean|smudge) filter '([^']+)' failed/.exec(output)
  if (!match) return null
  return `This repository's own config defines the "${match[1]}" filter (git-crypt or a local Git LFS install, for example), and it is not the one Mousse recorded when the project was added. Mousse runs only the repository's filters it recorded, so it left these files alone instead of storing them unfiltered. If you set up or changed this filter yourself, right-click the project in the sidebar and choose "Trust Git settings again".`
}

/**
 * Records the filter drivers the repository at `path` defines in its own config as the user's, so
 * Mousse's own commands run them while they stay as they are now. Called when the user adds a
 * project and when they choose "Trust Git settings again". Null when `path` is not in a repository.
 */
export function trustRepositoryPrograms(path: string): RepoTrustRecord | null {
  const where = bareGit(resolve(path), ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const commonDir = where.stdout.trim()
  if (!where.ok || !commonDir) return null
  const listing = bareGit(resolve(path), ['config', '--null', '--show-scope', '--show-origin', '--list'])
  if (!listing.ok) return null
  const filters: Record<string, string> = {}
  for (const entry of parseConfig(listing.stdout)) {
    if (!TRUSTED_SCOPES.has(entry.scope) && entry.value !== null && TRUSTED_FILTER_KEY.test(entry.key)) filters[entry.key] = entry.value
  }
  const record = writeRepoTrust(commonDir, filters)
  cache.clear()
  return record
}

/**
 * For projects added before trust was recorded: records each project's repository once, the first
 * time this profile starts with this version. A repository already recorded is left as it is.
 */
export function trustExistingProjectsOnce(profileHome: string, projectPaths: readonly string[]): void {
  const marker = join(profileHome, 'git-trust-recorded')
  if (existsSync(marker)) return
  for (const path of projectPaths) {
    try {
      const where = bareGit(resolve(path), ['rev-parse', '--path-format=absolute', '--git-common-dir'])
      if (where.ok && where.stdout.trim() && !readRepoTrust(where.stdout.trim())) trustRepositoryPrograms(path)
    } catch {
      /* a project folder that is gone or unreadable is recorded when the user trusts it */
    }
  }
  mkdirSync(profileHome, { recursive: true })
  writeFileSync(marker, `${new Date().toISOString()}\n`)
}

/**
 * `args` with the `-c` arguments in front, for a `spawn('git', …)` in `cwd`. `git config` runs no
 * program and must read the repository's values as they are (a `-c` would answer for them), so it
 * is left alone.
 */
export function withoutRepoPrograms(cwd: string, args: readonly string[], options?: RepoProgramOptions & GitCheckOptions): string[] {
  const own = !options?.userAction
  const run = own ? withoutDeref(args) : [...args]
  // Checked as it runs: Mousse's own commands are lock-free (`--no-optional-locks`, NO_INDEX_REFRESH).
  assertGitAllowed({ cwd, args: run, userRequested: options?.userRequested, stdin: options?.stdin, env: options?.env, lockFree: own && run[0] !== 'config' })
  const named = gitDirectoryArgs(cwd)
  if (run[0] === 'config') return [...named, ...run]
  // Optional locks are off for Mousse's own commands, so `status` does not refresh and write the index.
  return [...named, ...(own ? ['--no-optional-locks'] : []), ...noRepoProgramArgs(cwd, run, options), ...run]
}

/**
 * {@link withoutRepoPrograms} without blocking the daemon, for code that can wait: what new code uses.
 * It first waits until `cwd`'s volume answers, before anything reads the folder. Then it runs the same
 * central check ({@link assertGitAllowedAsync}, which reads without blocking) and the same reading of the
 * repository's programs, so it returns the same arguments or refuses the same way (as a rejection).
 * `signal` ends the wait and the check with its reason.
 */
export async function withoutRepoProgramsAsync(cwd: string, args: readonly string[], options?: RepoProgramOptions & GitCheckOptions & WaitOptions): Promise<string[]> {
  await waitForFolderAccess([resolve(cwd)], { signal: options?.signal })
  const own = !options?.userAction
  const run = own ? withoutDeref(args) : [...args]
  await assertGitAllowedAsync({ cwd, args: run, userRequested: options?.userRequested, stdin: options?.stdin, env: options?.env, lockFree: own && run[0] !== 'config' }, options?.signal)
  const dir = (await gitDirectoryEnvAsync(cwd)).GIT_DIR
  const named = dir ? [`--git-dir=${dir}`] : []
  if (run[0] === 'config') return [...named, ...run]
  return [...named, ...(own ? ['--no-optional-locks'] : []), ...await noRepoProgramArgsAsync(cwd, run, options), ...run]
}

/**
 * `--git-dir` for a command Mousse runs inside a Git directory it chose (a repository's shared directory, a
 * bare clone with linked worktrees, the bridge's quarantine). `safe.bareRepository=explicit` stops Git from
 * finding such a folder by itself, and Git before 2.45 refuses even a `.git` folder that way. Only the
 * folder the command runs in is named, never one Git would reach by walking up.
 */
function gitDirectoryArgs(cwd: string): string[] {
  const dir = gitDirectoryEnv(cwd).GIT_DIR
  return dir ? [`--git-dir=${dir}`] : []
}

/**
 * `update-ref` that writes the ref it names, never through it: Mousse's own refs are written with
 * `--no-deref`, so a symbolic `refs/mousse/x` pointing at `refs/heads/main` cannot move `main`. `HEAD` is
 * left alone (moving the branch it is on is what such a command asks for), and so is `--stdin`, whose
 * callers pass `--no-deref` themselves.
 */
export function withoutDeref(args: readonly string[]): string[] {
  if (args[0] !== 'update-ref' || args.includes('--no-deref') || args.includes('--stdin')) return [...args]
  // The first positional argument, past options: `-m <reason>` takes a value, `--` ends the options.
  let ref: string | undefined
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--') { ref = args[index + 1]; break }
    if (arg === '-m') { index += 1; continue }
    if (arg.startsWith('-')) continue
    ref = arg
    break
  }
  if (!ref || ref === 'HEAD') return [...args]
  return ['update-ref', '--no-deref', ...args.slice(1)]
}

/** simple-git's checks Mousse turns off: the values it sets are its own, never a caller's (see {@link guardedSimpleGit}). */
export const UNSAFE_ALLOWED = {
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
  allowUnsafeProtocolOverride: true,
  // The instance's environment is the process's own (plus SAFE_LOOKUP_ENV), never a caller's; simple-git
  // would otherwise refuse a GIT_CONFIG_GLOBAL, EDITOR, PAGER or askpass the user set.
  allowUnsafeConfigPaths: true,
  allowUnsafeConfigEnvCount: true,
  allowUnsafeGitProxy: true,
  allowUnsafeTemplateDir: true,
  allowUnsafePager: true
} as const

/** The Git subcommand a simple-git method other than `raw` runs, for the central check. */
const SIMPLE_GIT_COMMANDS: Record<string, readonly string[]> = {
  status: ['status'], diff: ['diff'], diffSummary: ['diff'], log: ['log'], show: ['show'], branchLocal: ['branch'], branch: ['branch'],
  checkIsRepo: ['rev-parse'], revparse: ['rev-parse'], listRemote: ['ls-remote'], getRemotes: ['remote'], tags: ['tag'], init: ['init'],
  deleteLocalBranch: ['branch', '-d'], deleteLocalBranches: ['branch', '-d'], checkoutBranch: ['checkout', '-b'], checkoutLocalBranch: ['checkout', '-b'],
  addConfig: ['config'], addRemote: ['remote', 'add'], removeRemote: ['remote', 'remove'], addTag: ['tag'], addAnnotatedTag: ['tag', '-a']
}

/**
 * The command a simple-git call runs, as the check should see it: the method's subcommand followed by the
 * string arguments it was given (`branch(['-d', name])` is `git branch -d name`, not a branch listing).
 * An options object only ever adds reading options for the methods used here, so only strings are kept.
 */
function simpleGitCommand(method: string, parameters: readonly unknown[] = []): string[] {
  const words = parameters.flat().filter((value): value is string => typeof value === 'string')
  return [...(SIMPLE_GIT_COMMANDS[method] ?? [method]), ...words]
}

/**
 * `git` with every `raw` command, and every other method, checked by {@link assertGitAllowed} first: for
 * a simple-git instance made with settings of its own (`safeWorktreeGit`).
 */
export function policedSimpleGit(cwd: string, git: SimpleGit): SimpleGit {
  return new Proxy(git, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown
      if (typeof key === 'symbol' || typeof value !== 'function' || key === 'env' || key === 'then') return value
      return async (...parameters: unknown[]) => {
        const args = key === 'raw' ? parameters.flat().filter((item): item is string => typeof item === 'string') : simpleGitCommand(key, parameters)
        // Without blocking: the folder answers first, then the check reads what it needs with async calls.
        await waitForFolderAccess([resolve(cwd)])
        await assertGitAllowedAsync({ cwd, args })
        return await (value as (...values: unknown[]) => unknown).apply(target, parameters)
      }
    }
  })
}

/**
 * simple-git for `cwd`. Each method call gets a fresh instance with the settings worked out for that
 * command, so a config written after an earlier call is seen. simple-git refuses these keys unless
 * allowed; they are only ever set to the values above, never to a caller's.
 *
 * Nothing here blocks the daemon: each method first waits until the folder's volume answers, then runs the
 * central check ({@link assertGitAllowedAsync}) and works out the settings ({@link repoProgramSettingsAsync})
 * without blocking. So each method returns a promise, and a refusal (by the central check, or for a
 * repository whose programs Mousse cannot turn off) rejects it rather than throwing. A caller that turns
 * failed reads into defaults calls {@link checkRepoPrograms} first, so a refused repository still shows its
 * reason.
 */
export function guardedSimpleGit(cwd: string, options: Partial<Omit<SimpleGitOptions, 'baseDir' | 'config' | 'unsafe'>> = {}): SimpleGit {
  // A command in a hidden store reads only the store's config (`hiddenStoreEnv`): nothing of the folder's is overridden.
  const forCommand = (config: string[]): SimpleGit => simpleGit({
    ...options,
    baseDir: cwd,
    config,
    unsafe: UNSAFE_ALLOWED
  })
  return new Proxy({} as SimpleGit, {
    get(_target, key) {
      // Not a thenable: awaiting the instance itself must not call a Git method.
      if (key === 'then' || typeof key === 'symbol') return undefined
      return async (...parameters: unknown[]) => {
        // Only `raw` takes free-form arguments; every other method used here only reads.
        const args = key === 'raw' ? parameters.flat().filter((value): value is string => typeof value === 'string') : []
        const command = key === 'raw' ? args : simpleGitCommand(key, parameters)
        // Before anything reads the folder.
        await waitForFolderAccess([resolve(cwd)])
        // Inside a hidden store's scope (snapshot review) the command goes through the store; nowhere else is a folder's Git redirected.
        const store = activeHiddenStore(cwd)
        // Lock-free: the instance's config holds NO_INDEX_REFRESH (a store's isolation turns it off too) and its
        // environment turns optional locks off. A store command is checked with the store it names.
        if (store) await checkStoreCommandAsync(store, cwd, command)
        else await assertGitAllowedAsync({ cwd, args: command, lockFree: true })
        const config = store ? [] : await repoProgramSettingsAsync(cwd, { write: writesThroughFilters(args) })
        // No optional locks: a status or diff read here never refreshes and rewrites the index.
        const instance = forCommand(config).env(store ? hiddenStoreEnv(store, repoProgramEnv({ ...process.env, GIT_OPTIONAL_LOCKS: '0' })) : repoProgramEnv({ ...process.env, GIT_OPTIONAL_LOCKS: '0' })) as unknown as Record<string, (...values: unknown[]) => unknown>
        return await instance[key]!(...parameters)
      }
    }
  })
}

/** For tests: forget cached repositories. */
export function clearRepoProgramCache(): void {
  cache.clear()
}
