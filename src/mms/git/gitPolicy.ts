import { AsyncLocalStorage } from 'node:async_hooks'
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { getMousseHomeDir } from '../data/paths'
import { gitDirectoryEnv, stripInheritedGitEnv, withGitConfigEnv } from './gitEnv'
import { GIT_NULL_DEVICE, NO_HOOKS_PATH } from './gitNullDevice'

/**
 * The central check for the Git (and `gh`) commands Mousse itself runs. It never applies to commands an
 * agent runs in its own shell; the permission mode governs those.
 *
 * The rule:
 * - Mousse may change what it owns: worktrees under the Mousse home, `mousse/*` branches and `refs/mousse/*`.
 * - Any other change happens only when the user clearly asked for it: a chat or CLI request, or a button
 *   whose label says exactly what happens. The request travels with the command as a {@link UserAction}.
 * - Everything else is refused: deny by default. Reads come from an allowlist.
 *
 * Ref, remote and config writes are never allowed because of where a command runs: an owned folder only
 * covers its own files, index and HEAD. A `commit` in an owned worktree whose HEAD is on a user's branch
 * writes that branch, so it needs the user's request.
 *
 * Commands that redirect Git elsewhere (`-C`, `--git-dir`, `--work-tree`, a `-c` outside a small set that
 * only turns things off) are refused whatever they do, and so are `gc`, `prune`, `worktree prune` and
 * `reflog expire`, which can delete what nothing else keeps.
 *
 * For this release a refusal is only logged. `MOUSSE_GIT_POLICY=refuse` turns refusal on; `log` is the default.
 */

/** What a protocol method, or a command, needs from Git. Ordered from least to most. */
export type GitAccess = 'none' | 'read' | 'owned' | 'userRequested'

const ACCESS_RANK: Record<GitAccess, number> = { none: 0, read: 1, owned: 2, userRequested: 3 }

/** The user's request behind a Git change Mousse makes for them. */
export interface UserAction {
  /** Where they asked: a button or menu item, the CLI, or a chat message. */
  via: 'button' | 'cli' | 'chat'
  /** What they asked for: the button's label, the CLI command, or the request in their words. */
  label: string
}

export function userAction(via: UserAction['via'], label: string): UserAction {
  return { via, label }
}

function isUserAction(value: unknown): value is UserAction {
  const action = value as Partial<UserAction> | null | undefined
  return Boolean(action && (action.via === 'button' || action.via === 'cli' || action.via === 'chat') && typeof action.label === 'string' && action.label.trim())
}

export type GitPolicyMode = 'log' | 'refuse'

/** `refuse` only when `MOUSSE_GIT_POLICY=refuse`; anything else logs. */
export function gitPolicyMode(): GitPolicyMode {
  return process.env.MOUSSE_GIT_POLICY?.trim().toLowerCase() === 'refuse' ? 'refuse' : 'log'
}

export interface GitCommandRequest {
  executable?: 'git' | 'gh'
  cwd: string
  /** The command as the caller wrote it, without the `-c` settings `repoPrograms` adds. */
  args: readonly string[]
  /** Standard input, for `update-ref --stdin`. */
  stdin?: string
  /** The environment the caller sets explicitly (a private `GIT_INDEX_FILE`, for one). */
  env?: NodeJS.ProcessEnv
  userRequested?: UserAction
  /**
   * The runner adds `--no-optional-locks` and `diff.autoRefreshIndex=false` (Mousse's own commands, see
   * `withoutRepoPrograms`), so `status` and `diff` cannot write the index.
   */
  lockFree?: boolean
}

export interface GitDecision {
  /** What the command needs. */
  access: GitAccess
  allowed: boolean
  /** Why it needs that, or why it is refused. */
  reason: string
}

export class GitPolicyError extends Error {
  constructor(readonly decision: GitDecision, readonly command: string) {
    super(`Mousse does not run "${command}" here: ${decision.reason}.`)
    this.name = 'GitPolicyError'
  }
}

// ---------------------------------------------------------------------------------------------------------
// Owned places

const extraOwnedRoots = new Set<string>()

/** For tests and embedders: treat `path` as owned, like the Mousse home. Returns the undo. */
export function registerOwnedGitRoot(path: string): () => void {
  extraOwnedRoots.add(resolve(path))
  return () => { extraOwnedRoots.delete(resolve(path)) }
}

/**
 * The real path of `path`, or of its nearest existing ancestor with the rest appended. `realpathSync.native`
 * expands Windows 8.3 short names (`RUNNER~1`), which plain `realpathSync` keeps, so both sides of a
 * containment check are in the same long form.
 */
export function canonicalGitPath(path: string): string {
  const absolute = resolve(path)
  const missing: string[] = []
  for (let current = absolute; ; current = dirname(current)) {
    try {
      const real = realpathSync.native(current)
      return missing.length ? join(real, ...missing.reverse()) : real
    } catch {
      if (dirname(current) === current) return absolute
      missing.push(current.slice(dirname(current).length).replace(/^[\\/]+/, ''))
    }
  }
}

function contains(root: string, path: string): boolean {
  const [a, b] = process.platform === 'win32' || process.platform === 'darwin' ? [root.toLowerCase(), path.toLowerCase()] : [root, path]
  return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep)
}

function ownedRoots(): string[] {
  return [getMousseHomeDir(), ...extraOwnedRoots].map(canonicalGitPath)
}

/** Whether `path` is inside the Mousse home (or another owned root), compared as real long paths. */
export function isOwnedPath(path: string): boolean {
  if (!path || !isAbsolute(path)) return false
  const real = canonicalGitPath(path)
  return ownedRoots().some((root) => contains(root, real))
}

/** `refs/mousse/*` and `mousse/*` branches, also on a remote. */
export function isOwnedRef(ref: string): boolean {
  const name = ref.replace(/^\+/, '')
  return /^refs\/mousse\//i.test(name) || /^refs\/heads\/mousse\//i.test(name)
}

/**
 * Where `ref` points in the repository of `cwd`, following symbolic refs to the end: the ref itself when it
 * is not symbolic or does not exist, its final target when it is, `detached` for a HEAD that is not
 * symbolic, and null when Git cannot tell. Runs `git symbolic-ref`, a read, with nothing it inherited that
 * could send it elsewhere.
 */
function finalRef(cwd: string, ref: string, env?: NodeJS.ProcessEnv): string | null {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', 'symbolic-ref', '-q', ref], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    env: withGitConfigEnv({ ...stripInheritedGitEnv(process.env), ...gitDirectoryEnv(cwd), ...(env?.GIT_DIR ? { GIT_DIR: env.GIT_DIR } : {}), GIT_OPTIONAL_LOCKS: '0' })
  })
  if (result.error) return null
  if (result.status === 0) return result.stdout.trim() || null
  // Exit 1: not a symbolic ref (or none at all), so a write lands on the ref itself.
  if (result.status === 1) return ref === 'HEAD' ? 'detached' : ref
  return null
}

// ---------------------------------------------------------------------------------------------------------
// Parsing

/** Global options that send Git to another repository, work tree or program. */
const REDIRECTS = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix', '--bare'])

/** Global options that change nothing about where Git works or what it may write. */
const HARMLESS_GLOBALS = new Set([
  '--no-pager', '-P', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs',
  '--no-optional-locks', '--no-replace-objects', '--no-lazy-fetch', '--no-advice', '--version', '-v', '--help', '-h'
])

const NULL_DEVICES = new Set([GIT_NULL_DEVICE, NO_HOOKS_PATH, '/dev/null', 'NUL'])

/**
 * `-c` settings a caller may pass: each only turns something off, checks more, or restores line-ending
 * data. Anything else (`push.default`, `fetch.prune`, `core.worktree`, a remote's URL) could widen or
 * redirect what the command names.
 */
const ALLOWED_SETTINGS: ReadonlyArray<readonly [RegExp, (value: string) => boolean]> = [
  [/^core\.fsmonitor$/, (value) => value === 'false'],
  [/^core\.hookspath$/, (value) => NULL_DEVICES.has(value)],
  [/^core\.excludesfile$/, (value) => NULL_DEVICES.has(value)],
  [/^hook\..+\.enabled$/, (value) => value === 'false'],
  [/^filter\..+\.(clean|smudge|process)$/, (value) => value === ''],
  [/^filter\..+\.required$/, () => true],
  [/^core\.(quotepath|autocrlf|eol|safecrlf|symlinks)$/, () => true],
  [/^protocol\.(.+\.)?allow$/, () => true],
  [/^credential\.interactive$/, (value) => value === 'false'],
  [/^(transfer|fetch|receive)\.fsckobjects$/, (value) => value === 'true'],
  [/^submodule\.recurse$/, (value) => value === 'false'],
  [/^diff\.(ignoresubmodules|submodule)$/, () => true],
  [/^diff\.autorefreshindex$/, (value) => value === 'false'],
  [/^status\.submodulesummary$/, (value) => value === 'false'],
  [/^safe\.barerepository$/, (value) => value === 'explicit']
]

function allowedSetting(pair: string): boolean {
  const equals = pair.indexOf('=')
  const key = (equals < 0 ? pair : pair.slice(0, equals)).toLowerCase()
  const value = equals < 0 ? 'true' : pair.slice(equals + 1)
  return ALLOWED_SETTINGS.some(([pattern, ok]) => pattern.test(key) && ok(value))
}

interface Parsed {
  sub: string | undefined
  rest: string[]
  problem?: string
  /** `--no-optional-locks` was given. */
  noOptionalLocks?: boolean
  /** `-c` settings given, keys lowercased. */
  settings?: Map<string, string>
}

function parseGlobals(args: readonly string[]): Parsed {
  let index = 0
  let noOptionalLocks = false
  const settings = new Map<string, string>()
  while (index < args.length && args[index]!.startsWith('-')) {
    const arg = args[index]!
    const name = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg
    if (arg === '-c') {
      const pair = args[index + 1] ?? ''
      if (!allowedSetting(pair)) return { sub: undefined, rest: [], problem: `it sets "${pair.split('=')[0]}" for one command, which could change what the command does` }
      const equals = pair.indexOf('=')
      settings.set((equals < 0 ? pair : pair.slice(0, equals)).toLowerCase(), equals < 0 ? 'true' : pair.slice(equals + 1))
      index += 2
      continue
    }
    if (arg === '--no-optional-locks') noOptionalLocks = true
    if (REDIRECTS.has(name) || arg.startsWith('-C') || arg.startsWith('-c')) return { sub: undefined, rest: [], problem: `"${name}" points Git at another place` }
    if (!HARMLESS_GLOBALS.has(name)) return { sub: undefined, rest: [], problem: `"${name}" is not an option Mousse uses` }
    index += 1
  }
  return { sub: args[index], rest: args.slice(index + 1), noOptionalLocks, settings }
}

/** The positional arguments of `rest`, skipping options and the values of `withValue` options. */
function positionals(rest: readonly string[], withValue: ReadonlySet<string> = new Set()): string[] {
  const found: string[] = []
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!
    if (arg === '--') {
      found.push(...rest.slice(index + 1))
      break
    }
    if (arg.startsWith('-') && arg !== '-') {
      if (withValue.has(arg)) index += 1
      continue
    }
    found.push(arg)
  }
  return found
}

const has = (rest: readonly string[], ...flags: string[]): boolean =>
  rest.some((arg) => flags.includes(arg) || flags.some((flag) => flag.startsWith('--') && arg.startsWith(`${flag}=`)))

/** What a command changes. A command with nothing set only reads. */
interface Effect {
  /** Refs it writes, in full. */
  refs: string[]
  /** It writes refs nobody can list from the arguments (a plain fetch, a ref read from input that is missing). */
  unlistedRefs?: boolean
  /** It writes files or the index of the worktree it runs in. */
  worktree?: boolean
  /** It writes only the index (a private `GIT_INDEX_FILE` may stand in for it). */
  index?: boolean
  /** It moves the branch HEAD is on in that worktree (commit, merge, reset...). */
  headBranch?: boolean
  /** It points HEAD of that worktree somewhere else (checkout, switch). */
  head?: boolean
  /** Folders it creates, moves or removes; each must be owned. */
  paths?: string[]
  remote?: boolean
  config?: boolean
  /** A command Mousse never runs: it can delete what nothing else keeps. */
  banned?: string
  /** Its ref writes follow symbolic refs, so each ref is judged by where it finally points. */
  deref?: boolean
  /** It writes the worktree's own config (`config --worktree`), which only that worktree reads. */
  worktreeConfig?: boolean
}

const READ: Effect = { refs: [] }
const isRead = (effect: Effect): boolean =>
  !effect.refs.length && !effect.unlistedRefs && !effect.worktree && !effect.index && !effect.headBranch && !effect.head && !effect.paths?.length && !effect.remote && !effect.config && !effect.worktreeConfig && !effect.banned

/** Commands that only read, whatever their arguments. */
const READ_ONLY = new Set([
  'rev-parse', 'diff-index', 'diff-files', 'diff-tree', 'ls-files', 'ls-tree', 'log', 'show', 'cat-file', 'rev-list',
  'merge-base', 'for-each-ref', 'show-ref', 'check-ref-format', 'check-attr', 'check-ignore', 'check-mailmap', 'grep', 'blame',
  'annotate', 'name-rev', 'describe', 'version', 'count-objects', 'var', 'shortlog', 'range-diff', 'ls-remote', 'help', 'whatchanged',
  'archive', 'interpret-trailers', 'patch-id', 'cherry', 'show-branch', 'verify-commit', 'verify-tag', 'fsck',
  'get-tar-commit-id', 'column', 'stripspace', 'fmt-merge-msg', 'mailinfo', 'format-patch'
])

/** Commands that write objects only: nothing a user sees changes, and nothing is lost. */
const OBJECTS_ONLY = new Set(['commit-tree', 'mktree', 'mktag', 'merge-tree', 'unpack-objects', 'index-pack', 'pack-objects'])

/** Commands that change a worktree's files and the branch HEAD is on. */
const MOVES_BRANCH = new Set(['commit', 'merge', 'rebase', 'cherry-pick', 'revert', 'am', 'reset'])

function heads(names: readonly string[], prefix = 'refs/heads/'): string[] {
  return names.map((name) => (name.startsWith('refs/') ? name : `${prefix}${name}`))
}

function updateRefInput(stdin: string | undefined): string[] | null {
  if (stdin === undefined) return null
  const refs: string[] = []
  for (const line of stdin.split(/[\n\0]/)) {
    const [command, ref] = line.trim().split(/\s+/)
    if (command && ref && /^(update|create|delete|symref-update|symref-create|symref-delete)$/.test(command)) refs.push(ref)
  }
  return refs
}

const isObjectName = (value: string): boolean => /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(value)

function fetchEffect(rest: readonly string[]): Effect {
  const withValue = new Set(['--depth', '--deepen', '--shallow-since', '--shallow-exclude', '--refmap', '-j', '--jobs', '--negotiation-tip', '-o', '--server-option', '--filter', '--upload-pack', '--recurse-submodules-default', '--submodule-prefix'])
  const [, ...refspecs] = positionals(rest, withValue)
  const widening = has(rest, '--prune', '-p', '--prune-tags', '-P', '--all', '--multiple', '--tags', '-t', '--refmap', '--upload-pack', '--update-head-ok', '-u')
  const refs: string[] = []
  let unlisted = widening || !has(rest, '--no-tags', '-n') || refspecs.length === 0
  for (const refspec of refspecs) {
    const spec = refspec.replace(/^\+/, '')
    const colon = spec.indexOf(':')
    if (colon < 0) {
      // A bare object name writes no ref (and with `--no-write-fetch-head`, not even FETCH_HEAD).
      if (!isObjectName(spec)) unlisted = true
      continue
    }
    if (spec.slice(colon + 1)) refs.push(spec.slice(colon + 1))
  }
  // A fetch writes through a symbolic destination: `refs/mousse/x` pointing at `refs/heads/main` moves `main`.
  return { refs, unlistedRefs: unlisted, deref: true }
}

function pushEffect(rest: readonly string[]): Effect {
  const withValue = new Set(['--repo', '--receive-pack', '--exec', '-o', '--push-option'])
  const [, ...refspecs] = positionals(rest, withValue)
  const widening = has(rest, '--all', '--branches', '--mirror', '--tags', '--follow-tags', '--delete', '-d', '--prune', '--receive-pack', '--exec', '--repo')
  const refs = refspecs.map((refspec) => {
    const spec = refspec.replace(/^\+/, '')
    const colon = spec.indexOf(':')
    return colon < 0 ? spec : spec.slice(colon + 1)
  })
  // `-u` writes branch.<name>.remote and .merge to the repository's config.
  return { refs, unlistedRefs: widening || refspecs.length === 0, remote: !refs.every(isOwnedRef) || widening || refspecs.length === 0, config: has(rest, '-u', '--set-upstream') }
}

/** What the command runs with that decides whether `status` and `diff` write the index. */
interface IndexContext { optionalLocksOff: boolean; autoRefreshOff: boolean }

function gitEffect(sub: string, rest: readonly string[], stdin: string | undefined, context: IndexContext): Effect {
  if (READ_ONLY.has(sub)) return READ
  if (OBJECTS_ONLY.has(sub)) return READ
  switch (sub) {
    case 'status':
      // `git status` refreshes the index and writes it back unless optional locks are off.
      return context.optionalLocksOff ? READ : { refs: [], index: true }
    case 'diff':
      // So does `git diff` against the working tree, whenever stat data alone changed, unless the refresh is off.
      return context.autoRefreshOff || has(rest, '--cached', '--staged', '--no-index') ? READ : { refs: [], index: true }
    case 'gc':
    case 'prune':
      return { refs: [], banned: `"git ${sub}" can delete objects that only a reflog or a snapshot still reaches` }
    case 'hash-object':
      return READ
    case 'write-tree':
      // Records the index's cache tree back into the index.
      return { refs: [], index: true }
    case 'config': {
      const [first] = positionals(rest, new Set(['--file', '-f', '--blob', '--type', '--default', '--comment']))
      const reads = has(rest, '--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', '--get-color', '--get-colorbool') || first === 'get' || first === 'list'
      const writes = has(rest, '--unset', '--unset-all', '--add', '--replace-all', '--rename-section', '--remove-section', '-e', '--edit') || ['set', 'unset', 'rename-section', 'remove-section', 'edit'].includes(first ?? '')
      const values = positionals(rest, new Set(['--file', '-f', '--blob', '--type', '--default', '--comment']))
      if (!writes && (reads || values.length <= 1)) return READ
      // `--worktree` writes `config.worktree` of the worktree it runs in, and only when `extensions.worktreeConfig`
      // is on (otherwise Git writes the repository's config, so that is checked separately by the caller's flow).
      if (has(rest, '--worktree') && !has(rest, '--file', '-f', '--global', '--system', '--local')) return { refs: [], worktreeConfig: true }
      return { refs: [], config: true }
    }
    case 'remote': {
      const [first] = positionals(rest)
      return first === undefined || first === 'show' || first === 'get-url' ? READ : { refs: [], remote: true, config: true, unlistedRefs: true }
    }
    case 'branch': {
      const withValue = new Set(['--format', '--sort', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--column', '-u', '--set-upstream-to'])
      const names = positionals(rest, withValue)
      if (has(rest, '-u', '--set-upstream-to', '--unset-upstream', '--edit-description')) return { refs: [], config: true }
      // Deleting a symbolic branch deletes the symbolic ref itself, never its target.
      if (has(rest, '-d', '-D', '--delete')) return { refs: heads(names, has(rest, '-r', '--remotes') ? 'refs/remotes/' : 'refs/heads/') }
      // A rename or copy also moves the branch's config section.
      if (has(rest, '-m', '-M', '--move', '-c', '-C', '--copy')) return { refs: heads(names), config: true, unlistedRefs: names.length < 2 }
      if (!names.length || has(rest, '--list', '-l', '--show-current', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at')) return READ
      return { refs: heads(names.slice(0, 1)), config: has(rest, '--track', '-t'), deref: true }
    }
    case 'tag': {
      const names = positionals(rest, new Set(['-m', '-F', '--sort', '--format', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '-u', '--local-user', '--cleanup', '-n']))
      if (!names.length || has(rest, '-l', '--list', '-v', '--verify', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at')) return READ
      return { refs: heads(has(rest, '-d', '--delete') ? names : names.slice(0, 1), 'refs/tags/') }
    }
    case 'symbolic-ref': {
      const names = positionals(rest, new Set(['-m']))
      if (!has(rest, '-d', '--delete') && names.length < 2) return READ
      return names[0] === 'HEAD' ? { refs: [], head: true } : { refs: names.slice(0, 1) }
    }
    case 'update-ref': {
      // Without `--no-deref` an update or delete follows a symbolic ref and lands on its target.
      const deref = !has(rest, '--no-deref')
      if (has(rest, '--stdin')) {
        const refs = updateRefInput(stdin)
        const perLine = stdin !== undefined && /(^|[\n\0])\s*option\s+no-deref/.test(stdin)
        return refs ? { refs, deref: deref && !perLine } : { refs: [], unlistedRefs: true }
      }
      const [ref] = positionals(rest, new Set(['-m']))
      if (!ref) return { refs: [], unlistedRefs: true }
      return ref === 'HEAD' ? { refs: [], headBranch: true } : { refs: [ref], deref }
    }
    case 'reflog': {
      const [first] = positionals(rest)
      if (first === 'expire' || first === 'delete') return { refs: [], banned: `"git reflog ${first}" removes the only record of commits nothing else reaches` }
      return READ
    }
    case 'worktree': {
      const [action, ...more] = rest
      if (action === 'list') return READ
      if (action === 'prune') return { refs: [], banned: '"git worktree prune" forgets worktrees whose folders are only missing for now' }
      if (action === 'add') {
        const withValue = new Set(['-b', '-B', '--reason'])
        const [path] = positionals(more, withValue)
        const branch = more.findIndex((arg) => arg === '-b' || arg === '-B')
        return { refs: branch >= 0 && more[branch + 1] ? heads([more[branch + 1]!]) : [], paths: path ? [path] : [], unlistedRefs: !path }
      }
      if (['remove', 'move', 'lock', 'unlock', 'repair'].includes(action ?? '')) {
        const paths = positionals(more, new Set(['--reason']))
        return { refs: [], paths, unlistedRefs: !paths.length }
      }
      return { refs: [], unlistedRefs: true }
    }
    case 'fetch':
      return fetchEffect(rest)
    case 'push':
      return pushEffect(rest)
    case 'pull':
      return { refs: [], unlistedRefs: true, worktree: true, headBranch: true }
    case 'init': {
      const [path] = positionals(rest, new Set(['--template', '--separate-git-dir', '-b', '--initial-branch', '--object-format', '--ref-format', '--shared']))
      return { refs: [], paths: [path ?? '.'] }
    }
    case 'clone': {
      const [, path] = positionals(rest, new Set(['-o', '--origin', '-b', '--branch', '-u', '--upload-pack', '--reference', '--depth', '--template', '-c', '--config', '--filter', '--separate-git-dir', '-j', '--jobs']))
      return { refs: [], paths: path ? [path] : [], unlistedRefs: !path, config: has(rest, '-c', '--config') }
    }
    case 'checkout':
    case 'switch': {
      const created = rest.flatMap((arg, index) => (['-b', '-B', '-c', '-C', '--orphan'].includes(arg) && rest[index + 1] ? [rest[index + 1]!] : []))
      return { refs: heads(created), worktree: true, head: true, config: has(rest, '--track', '-t') }
    }
    case 'add':
    case 'read-tree':
    case 'update-index':
      return { refs: [], index: true }
    case 'rm':
      return has(rest, '--cached') ? { refs: [], index: true } : { refs: [], worktree: true }
    case 'restore':
      return has(rest, '--staged', '-S') && !has(rest, '--worktree', '-W') ? { refs: [], index: true } : { refs: [], worktree: true }
    case 'apply':
      if (has(rest, '--check', '--stat', '--numstat', '--summary') && !has(rest, '--apply')) return READ
      return has(rest, '--cached') ? { refs: [], index: true } : { refs: [], worktree: true }
    case 'mv':
    case 'clean':
    case 'checkout-index':
    case 'sparse-checkout':
      return { refs: [], worktree: true }
    case 'stash': {
      const [first] = positionals(rest)
      return first === 'list' || first === 'show' ? READ : { refs: ['refs/stash'], worktree: true }
    }
    case 'notes':
    case 'replace': {
      const [first] = positionals(rest)
      if (first === undefined || first === 'list' || first === 'show' || has(rest, '-l', '--list')) return READ
      return { refs: [], unlistedRefs: true }
    }
    case 'bundle': {
      const [action, file] = positionals(rest)
      if (action === 'list-heads' || action === 'verify') return READ
      return action === 'create' && file ? { refs: [], paths: [file] } : { refs: [], unlistedRefs: true }
    }
    case 'submodule': {
      const [first] = positionals(rest)
      return first === 'status' || first === 'summary' ? READ : { refs: [], unlistedRefs: true, worktree: true, config: true }
    }
    default:
      if (MOVES_BRANCH.has(sub)) return { refs: [], worktree: true, headBranch: true }
      // Deny by default: a command not listed here needs the user's request.
      return { refs: [], unlistedRefs: true, worktree: true, config: true }
  }
}

/** `gh` commands that only read. Everything else (create, merge, close, clone, checkout, a POST) needs the user's request. */
function ghReads(args: readonly string[]): boolean {
  const [first, second] = args
  if (first === '--version' || first === 'version' || first === '--help') return true
  if (first === 'auth') return second === 'status'
  if (first === 'api') {
    const method = args.findIndex((arg) => arg === '-X' || arg === '--method')
    const verb = method >= 0 ? args[method + 1]?.toUpperCase() : args.find((arg) => arg.startsWith('--method='))?.slice(9).toUpperCase()
    const fields = args.some((arg) => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(arg))
    return (verb === undefined || verb === 'GET') && !fields
  }
  if (first === 'repo') return second === 'view' || second === 'list'
  if (first === 'pr') return ['view', 'list', 'status', 'checks', 'diff'].includes(second ?? '')
  if (first === 'issue') return ['view', 'list', 'status'].includes(second ?? '')
  if (first === 'run' || first === 'release') return ['view', 'list'].includes(second ?? '')
  if (first === 'search') return true
  return false
}

// ---------------------------------------------------------------------------------------------------------
// Deciding

/**
 * What `request` needs, and whether it may run. Runs Git only to read where a symbolic ref points, for a
 * write to an owned ref or to the branch HEAD is on.
 */
export function decideGitCommand(request: GitCommandRequest): GitDecision {
  const requested = isUserAction(request.userRequested)
  const needUser = (reason: string): GitDecision => ({ access: 'userRequested', allowed: requested, reason: requested ? `the user asked: ${request.userRequested!.label}` : `${reason}, and the user did not ask for it` })

  if (request.executable === 'gh') {
    if (ghReads(request.args)) return { access: 'read', allowed: true, reason: 'a GitHub read' }
    return needUser('it changes something on GitHub or in the checkout')
  }

  const parsed = parseGlobals(request.args)
  if (parsed.problem) return { access: 'userRequested', allowed: false, reason: parsed.problem }
  if (!parsed.sub) return { access: 'read', allowed: true, reason: 'no command' }
  const env = request.env ?? {}
  const effect = gitEffect(parsed.sub, parsed.rest, request.stdin, {
    optionalLocksOff: Boolean(request.lockFree || parsed.noOptionalLocks || env.GIT_OPTIONAL_LOCKS === '0'),
    autoRefreshOff: Boolean(request.lockFree || parsed.settings?.get('diff.autorefreshindex') === 'false')
  })
  if (effect.banned) return { access: 'userRequested', allowed: false, reason: effect.banned }
  if (isRead(effect)) return { access: 'read', allowed: true, reason: 'a read' }

  const cwdOwned = isOwnedPath(request.cwd)
  const problems: string[] = []
  if (effect.config) problems.push('it writes the repository\'s config')
  if (effect.remote) problems.push('it changes a remote')
  if (effect.unlistedRefs) problems.push('it writes refs it does not name')
  // An owned ref that is symbolic is judged by its target: `refs/mousse/x` -> `refs/heads/main` writes `main`.
  const written = effect.refs.map((ref) => {
    if (!effect.deref || !isOwnedRef(ref) || !ref.startsWith('refs/')) return ref
    const target = finalRef(request.cwd, ref.replace(/^\+/, ''), env)
    if (target === null) {
      problems.push(`it may write through ${ref}, and Git could not tell where that points`)
      return ref
    }
    return target
  })
  const others = written.filter((ref) => !isOwnedRef(ref))
  if (others.length) problems.push(`it writes ${others.join(', ')}`)
  if (effect.worktreeConfig && !cwdOwned) problems.push('it writes the config of a worktree Mousse does not own')
  if (effect.worktree && !cwdOwned) problems.push('it changes files outside a Mousse worktree')
  const indexFile = request.env?.GIT_INDEX_FILE
  if (effect.index && !cwdOwned && !(indexFile && isOwnedPath(resolve(request.cwd, indexFile)))) problems.push('it writes the index of a checkout Mousse does not own')
  if (effect.head && !cwdOwned) problems.push('it moves HEAD of a checkout Mousse does not own')
  if (effect.headBranch) {
    const head = cwdOwned ? finalRef(request.cwd, 'HEAD', env) : null
    if (!cwdOwned || !(head === 'detached' || (head !== null && isOwnedRef(head)))) problems.push(`it moves ${head && head !== 'detached' ? head : 'the current branch'}, which Mousse does not own`)
  }
  for (const path of effect.paths ?? []) if (!isOwnedPath(resolve(request.cwd, path))) problems.push(`it changes ${path}, which is outside the Mousse home`)

  if (!problems.length) return { access: 'owned', allowed: true, reason: 'it changes only what Mousse owns' }
  return needUser(problems.join('; '))
}

// ---------------------------------------------------------------------------------------------------------
// Where a command came from

interface AccessScope { method: string; access: GitAccess }
const scope = new AsyncLocalStorage<AccessScope>()

/** Runs `work` as the protocol method `method`, which declared `access`; commands that need more are logged. */
export function withGitAccess<T>(method: string, access: GitAccess, work: () => T): T {
  return scope.run({ method, access }, work)
}

// ---------------------------------------------------------------------------------------------------------
// Logging

export interface GitPolicyEntry {
  command: string
  cwd: string
  decision: GitDecision
  /** The protocol method the command ran under, when it ran under one. */
  method?: string
  kind: 'violation' | 'undeclared'
}

const RECENT_LIMIT = 200
const recent: GitPolicyEntry[] = []
const seen = new Map<string, number>()
const listeners = new Set<(entry: GitPolicyEntry) => void>()

/** Recent violations, newest last; for tests and diagnostics. */
export function gitPolicyLog(): readonly GitPolicyEntry[] {
  return recent
}

export function clearGitPolicyLog(): void {
  recent.length = 0
  seen.clear()
}

export function onGitPolicyEntry(listener: (entry: GitPolicyEntry) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function describe(request: GitCommandRequest): string {
  const words = [request.executable ?? 'git', ...request.args].map((word) => (word.length > 80 ? `${word.slice(0, 77)}...` : word))
  return words.slice(0, 12).join(' ') + (words.length > 12 ? ' ...' : '')
}

function record(entry: GitPolicyEntry): void {
  recent.push(entry)
  if (recent.length > RECENT_LIMIT) recent.shift()
  for (const listener of listeners) {
    try { listener(entry) } catch { /* a listener's failure never stops Git */ }
  }
  // Once per kind of problem and command, then every hundredth time, so a polling loop cannot flood the log.
  const key = `${entry.kind}\0${entry.method ?? ''}\0${entry.command.split(' ').slice(0, 2).join(' ')}\0${entry.decision.reason}`
  const count = (seen.get(key) ?? 0) + 1
  seen.set(key, count)
  if (count === 1 || count % 100 === 0) {
    console.warn(entry.kind === 'violation' ? 'git policy: Mousse ran a Git command the rule does not allow' : 'git policy: a protocol method ran Git it did not declare', {
      command: entry.command, cwd: entry.cwd, reason: entry.decision.reason, method: entry.method, mode: gitPolicyMode(), times: count
    })
  }
}

/**
 * Checks a Git or `gh` command Mousse is about to run. A violation is logged; with `MOUSSE_GIT_POLICY=refuse`
 * it throws a {@link GitPolicyError} instead. A command that needs more than the protocol method it runs
 * under declared is logged too, never refused.
 */
export function assertGitAllowed(request: GitCommandRequest): GitDecision {
  const decision = decideGitCommand(request)
  const current = scope.getStore()
  if (!decision.allowed) {
    record({ command: describe(request), cwd: request.cwd, decision, method: current?.method, kind: 'violation' })
    if (gitPolicyMode() === 'refuse') throw new GitPolicyError(decision, describe(request))
  } else if (current && ACCESS_RANK[decision.access] > ACCESS_RANK[current.access]) {
    record({ command: describe(request), cwd: request.cwd, decision, method: current.method, kind: 'undeclared' })
  }
  return decision
}

// ---------------------------------------------------------------------------------------------------------
// Environment

export { stripInheritedGitEnv } from './gitEnv'
