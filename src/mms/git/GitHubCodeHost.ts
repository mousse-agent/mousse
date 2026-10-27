import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CreatePullRequestInput,
  GitPullRequestInfo,
  GitPullRequestLookup,
  PullRequestBaseBranches,
  PullRequestCheckState,
  RepositoryIdentity
} from '../../shared/pullRequests'
import type { CodeHost } from './CodeHost'
import {
  classifyGhFailure,
  defaultRunner,
  isMissingExecutable,
  processMessage,
  type ExecutableRunner
} from './ghRunner'

const FAILED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE'])
const FAILED_STATES = new Set(['FAILURE', 'ERROR'])
const PENDING_STATES = new Set(['PENDING', 'EXPECTED'])
/** A workflow run held until a maintainer approves it; it has not run and has not failed. */
const WAITING_CONCLUSION = 'ACTION_REQUIRED'

export interface PullRequestCheckSummary {
  checks: PullRequestCheckState
  checkCounts: GitPullRequestInfo['checkCounts']
}

function upper(value: unknown): string {
  return typeof value === 'string' ? value.toUpperCase() : ''
}

/** Maps gh's statusCheckRollup (CheckRun and StatusContext items) to one summary. */
export function summarizeCheckRollup(rollup: unknown): PullRequestCheckSummary {
  const counts = { passed: 0, failed: 0, pending: 0, waiting: 0, total: 0 }
  for (const item of Array.isArray(rollup) ? rollup : []) {
    if (!item || typeof item !== 'object') continue
    const { status, conclusion, state } = item as Record<string, unknown>
    counts.total++
    if (FAILED_CONCLUSIONS.has(upper(conclusion)) || FAILED_STATES.has(upper(state))) counts.failed++
    else if (upper(conclusion) === WAITING_CONCLUSION) {
      counts.waiting++
      counts.pending++
    } else if ((upper(status) && upper(status) !== 'COMPLETED') || PENDING_STATES.has(upper(state))) counts.pending++
    else counts.passed++
  }
  const checks: PullRequestCheckState = counts.failed > 0
    ? 'failing'
    : counts.pending > 0
      ? 'pending'
      : counts.total > 0
        ? 'passing'
        : 'none'
  return { checks, checkCounts: counts }
}

const PULL_REQUEST_FIELDS = 'number,title,url,state,isDraft,statusCheckRollup,isCrossRepository,headRefName,baseRefName'
/** Enough to find this repository's own pull request among forks with a branch of the same name. */
const PULL_REQUEST_CANDIDATES = 10

/**
 * Parses `gh pr list --json …` output, newest first: the newest pull request from this
 * repository (a fork's branch can share the name), 'empty' for none, or null when unreadable.
 */
export function parsePullRequestList(stdout: string): GitPullRequestInfo | 'empty' | null {
  let data: unknown
  try {
    data = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(data)) return null
  if (data.length === 0) return 'empty'
  const own = data.find((item) => item && typeof item === 'object' && (item as { isCrossRepository?: unknown }).isCrossRepository !== true)
  return own === undefined ? 'empty' : parsePullRequest(own)
}

/** Parses one pull request from gh's JSON (`number,title,url,state,isDraft,statusCheckRollup`). */
export function parsePullRequestJson(stdout: string): GitPullRequestInfo | null {
  let data: unknown
  try {
    data = JSON.parse(stdout)
  } catch {
    return null
  }
  return parsePullRequest(data)
}

function parsePullRequest(data: unknown): GitPullRequestInfo | null {
  if (!data || typeof data !== 'object') return null
  const value = data as Record<string, unknown>
  const state = upper(value.state).toLowerCase()
  if (typeof value.number !== 'number' || typeof value.url !== 'string') return null
  if (state !== 'open' && state !== 'closed' && state !== 'merged') return null
  return {
    number: value.number,
    title: typeof value.title === 'string' ? value.title : '',
    url: value.url,
    state,
    isDraft: value.isDraft === true,
    ...(typeof value.headRefName === 'string' && value.headRefName ? { headRefName: value.headRefName } : {}),
    ...(typeof value.baseRefName === 'string' && value.baseRefName ? { baseRefName: value.baseRefName } : {}),
    ...summarizeCheckRollup(value.statusCheckRollup)
  }
}

/** Classifies a failed `gh pr view` by its error text; rate limits and missing pull requests are plain errors here. */
export function classifyPullRequestFailure(message: string): 'none' | 'not-github' | 'unauthenticated' | 'error' {
  const kind = classifyGhFailure(message)
  return kind === 'rate-limited' || kind === 'not-found' ? 'error' : kind
}

/** Parses `gh repo view --json nameWithOwner,url`; the host is the host of the repository's web URL. */
export function parseRepositoryIdentity(stdout: string): RepositoryIdentity | null {
  let data: unknown
  try {
    data = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const { nameWithOwner, url } = data as Record<string, unknown>
  if (typeof nameWithOwner !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(nameWithOwner) || typeof url !== 'string') return null
  try {
    const host = new URL(url).host
    return host ? { host, nameWithOwner } : null
  } catch {
    return null
  }
}

export interface GitRemote {
  name: string
  url: string
}

/** The fetch URLs of `git remote -v`, in the order Git lists the remotes. */
export function parseRemotes(output: string): GitRemote[] {
  const remotes: GitRemote[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim())
    if (match && !remotes.some((remote) => remote.name === match[1])) remotes.push({ name: match[1], url: match[2] })
  }
  return remotes
}

function hostWithoutPort(host: string): string {
  return host.toLowerCase().replace(/:\d+$/, '')
}

/** Reads host and `owner/repo` from an ssh, scp-style or https remote URL. */
export function parseRemoteUrl(url: string): RepositoryIdentity | null {
  const text = url.trim()
  let host: string
  let path: string
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      const parsed = new URL(text)
      host = parsed.hostname
      path = parsed.pathname
    } catch {
      return null
    }
  } else {
    const scp = /^(?:[^@\s/]+@)?([^:\s/]+):([^\s]+)$/.exec(text)
    if (!scp) return null
    host = scp[1]
    path = scp[2]
  }
  const segments = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/')
  if (!host || segments.length !== 2 || segments.some((segment) => !segment || segment.includes('\\'))) return null
  return { host, nameWithOwner: segments.join('/') }
}

/** The remote whose URL is the repository: same host and `owner/repo`, ignoring case, scheme and `.git`. */
export function remoteForIdentity(remotes: readonly GitRemote[], identity: RepositoryIdentity): string | null {
  const matches = remotes.filter((remote) => {
    const parsed = parseRemoteUrl(remote.url)
    return parsed !== null
      && hostWithoutPort(parsed.host) === hostWithoutPort(identity.host)
      && parsed.nameWithOwner.toLowerCase() === identity.nameWithOwner.toLowerCase()
  })
  return (matches.find((remote) => remote.name === 'origin') ?? matches[0])?.name ?? null
}

const LOOKUP_TTL_MS = 30_000
const IDENTITY_TTL_MS = 10 * 60_000
const AVAILABILITY_TTL_MS = 60_000
/** How long a failure that will not fix itself (not on GitHub, signed out, rate limited) is remembered. */
const NEGATIVE_TTL_MS = 30_000
/** A client's `force` cannot reach the host more often than this for one entry. */
const FORCE_MIN_AGE_MS = 5_000

/** The daemon lives as long as the app, so every cache keeps at most this many entries, oldest first out. */
const MAX_CACHE_ENTRIES = 500

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > MAX_CACHE_ENTRIES) {
    const oldest = map.keys().next()
    if (oldest.done) break
    map.delete(oldest.value)
  }
}

/** Failures worth remembering briefly: asking again at once only repeats them. */
function isLastingFailure(message: string): boolean {
  const kind = classifyGhFailure(message)
  return kind === 'not-github' || kind === 'unauthenticated' || kind === 'rate-limited'
}

/**
 * Reads shared between callers. A fresh value answers without a command; concurrent callers
 * join one read, `force` included, which only skips a fresh value. Failures are never kept.
 */
class ReadCache<T> {
  private readonly values = new Map<string, { at: number; ttlMs: number; result: { value: T } | { error: unknown } }>()
  private readonly flights = new Map<string, Promise<T>>()

  constructor(private readonly ttlMs: number, private readonly clock: () => number) {}

  /**
   * `cacheable` decides whether a value is kept; `shortLived` keeps one only briefly (a failure
   * that will not fix itself, such as a folder that is not on GitHub); `cacheError` does the same
   * for a thrown error. `force` skips a stored value only once it is `FORCE_MIN_AGE_MS` old.
   */
  read(
    key: string,
    load: () => Promise<T>,
    options: {
      force?: boolean
      cacheable?: (value: T) => boolean
      shortLived?: (value: T) => boolean
      cacheError?: (error: unknown) => boolean
    } = {}
  ): Promise<T> {
    const hit = this.values.get(key)
    if (hit) {
      const age = this.clock() - hit.at
      if (age < (options.force ? Math.min(hit.ttlMs, FORCE_MIN_AGE_MS) : hit.ttlMs)) {
        return 'error' in hit.result ? Promise.reject(hit.result.error) : Promise.resolve(hit.result.value)
      }
    }
    const joined = this.flights.get(key)
    if (joined) return joined
    const started: Promise<T> = load().then(
      (value) => {
        // A read that was invalidated while it ran describes the state before the change.
        if (this.flights.get(key) === started) {
          this.flights.delete(key)
          if (!options.cacheable || options.cacheable(value)) {
            remember(this.values, key, { at: this.clock(), ttlMs: options.shortLived?.(value) ? NEGATIVE_TTL_MS : this.ttlMs, result: { value } })
          }
        }
        return value
      },
      (error: unknown) => {
        if (this.flights.get(key) === started) {
          this.flights.delete(key)
          if (options.cacheError?.(error)) remember(this.values, key, { at: this.clock(), ttlMs: NEGATIVE_TTL_MS, result: { error } })
        }
        throw error
      }
    )
    this.flights.set(key, started)
    return started
  }

  invalidatePrefix(prefix: string): void {
    for (const key of [...this.values.keys()]) if (key.startsWith(prefix)) this.values.delete(key)
    for (const key of [...this.flights.keys()]) if (key.startsWith(prefix)) this.flights.delete(key)
  }
}

function repositoryPrefix(identity: RepositoryIdentity): string {
  return `${identity.host.toLowerCase()}\u0000${identity.nameWithOwner.toLowerCase()}\u0000`
}

type GhProbe = { ok: true } | { ok: false; reason: 'gh-missing' | 'error'; message: string }

/** GitHub (github.com or an Enterprise Server) through the `gh` CLI. */
export class GitHubCodeHost implements CodeHost {
  private probe: { at: number; result: GhProbe } | null = null
  private readonly defaultBranches = new Map<string, string>()
  private readonly identities: ReadCache<RepositoryIdentity>
  private readonly lookups: ReadCache<GitPullRequestLookup>
  private readonly viewers: ReadCache<string>

  constructor(
    private readonly runExecutable: ExecutableRunner = defaultRunner,
    private readonly clock: () => number = Date.now
  ) {
    this.identities = new ReadCache(IDENTITY_TTL_MS, clock)
    this.lookups = new ReadCache(LOOKUP_TTL_MS, clock)
    this.viewers = new ReadCache(IDENTITY_TTL_MS, clock)
  }

  repositoryIdentity(cwd: string): Promise<RepositoryIdentity> {
    return this.identities.read(cwd, async () => {
      const { stdout } = await this.runExecutable('gh', ['repo', 'view', '--json', 'nameWithOwner,url'], { cwd })
      const identity = parseRepositoryIdentity(stdout)
      if (!identity) throw new Error('GitHub CLI returned an unexpected repository response.')
      return identity
    }, { cacheError: (error) => isLastingFailure(processMessage(error)) })
  }

  /**
   * Looks up the pull request for a branch, by default the folder's current one. Naming
   * the branch keeps a slow lookup from answering for a branch checked out meanwhile.
   * Shared by every folder of the repository for 30 seconds.
   */
  async lookupPullRequest(cwd: string, requestedBranch?: string, options: { force?: boolean } = {}): Promise<GitPullRequestLookup> {
    const branch = requestedBranch?.trim() || await this.runExecutable('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd })
      .then((result) => result.stdout.trim())
      .catch(() => '')
    if (!branch) return { state: 'unavailable', reason: 'no-branch', message: 'There is no branch checked out.' }
    // Git refuses branch names that start with a dash; never let one read as a gh flag.
    if (branch.startsWith('-')) return { state: 'unavailable', reason: 'error', message: 'Unsupported branch name.' }

    const probe = await this.probeGh()
    if (!probe.ok) return { state: 'unavailable', reason: probe.reason, message: probe.message }

    let identity: RepositoryIdentity
    try {
      identity = await this.repositoryIdentity(cwd)
    } catch (error) {
      return this.lookupFailure(cwd, branch, error)
    }
    return this.lookups.read(
      `${repositoryPrefix(identity)}${branch}`,
      () => this.readLookup(cwd, branch),
      {
        force: options.force,
        // An unavailable lookup is kept only when asking again would fail the same way.
        cacheable: (lookup) => lookup.state !== 'unavailable' || isLastingFailure(lookup.message),
        shortLived: (lookup) => lookup.state === 'unavailable'
      }
    )
  }

  private async readLookup(cwd: string, branch: string): Promise<GitPullRequestLookup> {
    try {
      // `pr list --head` matches branch names only; `pr view <branch>` reads an all-digit branch as a PR number.
      // An open pull request wins over a newer closed one, as `pr view` would choose.
      const list = (state: 'open' | 'all') => this.runExecutable(
        'gh',
        ['pr', 'list', '--head', branch, '--state', state, '--limit', String(PULL_REQUEST_CANDIDATES), '--json', PULL_REQUEST_FIELDS],
        { cwd }
      ).then((result) => parsePullRequestList(result.stdout))
      let listed = await list('open')
      if (listed === 'empty') listed = await list('all')
      if (listed === 'empty') return { state: 'none', isDefaultBranch: await this.isDefaultBranch(cwd, branch) }
      if (listed) return { state: 'found', pullRequest: listed }
      return { state: 'unavailable', reason: 'error', message: 'GitHub CLI returned an unexpected pull request response.' }
    } catch (error) {
      return this.lookupFailure(cwd, branch, error)
    }
  }

  private async lookupFailure(cwd: string, branch: string, error: unknown): Promise<GitPullRequestLookup> {
    const message = processMessage(error)
    const kind = classifyPullRequestFailure(message)
    if (kind === 'none') return { state: 'none', isDefaultBranch: await this.isDefaultBranch(cwd, branch) }
    if (kind === 'not-github') return { state: 'unavailable', reason: 'not-github', message }
    if (kind === 'unauthenticated') return { state: 'unavailable', reason: 'unauthenticated', message }
    return { state: 'unavailable', reason: 'error', message }
  }

  async createPullRequest(cwd: string, input: CreatePullRequestInput): Promise<GitPullRequestInfo> {
    const title = input.title.trim()
    if (title.length < 1 || title.length > 256) throw new Error('The title must be 1–256 characters.')
    const base = input.base.trim()
    if (!base) throw new Error('Choose a base branch.')
    const head = input.head.trim()
    if (!head) throw new Error('Name the branch the pull request is opened from.')
    // Git refuses branch names that start with a dash; never let one read as a gh flag.
    if (base.startsWith('-') || head.startsWith('-')) throw new Error('Unsupported branch name.')

    const directory = await mkdtemp(join(tmpdir(), 'mousse-pr-'))
    const bodyFile = join(directory, 'body.md')
    let stdout: string
    let stderr: string
    try {
      await writeFile(bodyFile, input.body, 'utf8')
      // `--flag=value` keeps every value, whatever it starts with, from being read as another flag.
      const args = ['pr', 'create', `--title=${title}`, `--body-file=${bodyFile}`, `--base=${base}`, `--head=${head}`]
      if (input.draft) args.push('--draft')
      try {
        ({ stdout, stderr } = await this.runExecutable('gh', args, { cwd }))
      } catch (error) {
        if (isMissingExecutable(error)) throw new Error('GitHub CLI (gh) was not found. Install it and try again.')
        const message = processMessage(error)
        if (/already exists/i.test(message)) throw new Error('A pull request for this branch already exists.')
        throw new Error(message)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }

    const created = /https?:\/\/\S+\/pull\/(\d+)/.exec(stdout)
    if (!created) throw Object.assign(new Error('GitHub CLI did not report the new pull request'), { stdout, stderr })
    const url = created[0]
    const number = Number(created[1])

    // Whatever was read before the pull request existed no longer describes the branch.
    const identity = await this.repositoryIdentity(cwd).catch(() => null)
    if (identity) this.lookups.invalidatePrefix(repositoryPrefix(identity))

    // The pull request exists even when it cannot be read back, so a failed read must not look like a failed create.
    const readBack = await this.runExecutable('gh', ['pr', 'view', String(number), '--json', PULL_REQUEST_FIELDS], { cwd })
      .then((result) => parsePullRequestJson(result.stdout))
      .catch(() => null)
    return readBack ?? {
      number,
      title,
      url,
      state: 'open',
      isDraft: input.draft,
      headRefName: head,
      baseRefName: base,
      ...summarizeCheckRollup([])
    }
  }

  async listBaseBranches(cwd: string): Promise<PullRequestBaseBranches> {
    const defaultBranch = await this.defaultBranchName(cwd)
    const remote = await this.remoteForRepository(cwd)
    const refs = remote
      ? await this.runExecutable('git', ['for-each-ref', '--format=%(refname:lstrip=3)', `refs/remotes/${remote}`], { cwd })
        .then((result) => result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((name) => name && name !== 'HEAD'))
        .catch(() => [])
      : []
    const branches = defaultBranch ? [defaultBranch, ...refs.filter((name) => name !== defaultBranch)] : refs
    return { defaultBranch, branches }
  }

  async viewerLogin(cwd: string): Promise<string | null> {
    try {
      const { host } = await this.repositoryIdentity(cwd)
      return await this.viewers.read(hostWithoutPort(host), async () => {
        const { stdout } = await this.runExecutable('gh', ['api', '--hostname', host, 'user', '--jq', '.login'], { cwd })
        const login = stdout.trim()
        if (!login) throw new Error('GitHub CLI did not report the signed-in account.')
        return login
      }, { cacheError: (error) => isLastingFailure(processMessage(error)) })
    } catch {
      return null
    }
  }

  /** The remote that points at this folder's repository, else `origin`, else the only remote. */
  async remoteForRepository(cwd: string): Promise<string | null> {
    try {
      const remotes = parseRemotes((await this.runExecutable('git', ['remote', '-v'], { cwd })).stdout)
      const identity = await this.repositoryIdentity(cwd).catch(() => null)
      return (identity ? remoteForIdentity(remotes, identity) : null)
        ?? remotes.find((remote) => remote.name === 'origin')?.name
        ?? (remotes.length === 1 ? remotes[0].name : null)
    } catch {
      return null
    }
  }

  /**
   * Only checks that gh is installed. Sign-in is judged from the lookup itself, because
   * `gh auth status` also fails when an unrelated host's token is stale.
   */
  private async probeGh(): Promise<GhProbe> {
    if (this.probe && this.clock() - this.probe.at < AVAILABILITY_TTL_MS) return this.probe.result
    let result: GhProbe
    try {
      await this.runExecutable('gh', ['--version'])
      result = { ok: true }
    } catch (error) {
      result = isMissingExecutable(error)
        ? { ok: false, reason: 'gh-missing', message: 'GitHub CLI (gh) was not found. Install it to see pull requests.' }
        : { ok: false, reason: 'error', message: `Could not run GitHub CLI: ${processMessage(error)}` }
    }
    this.probe = { at: this.clock(), result }
    return result
  }

  /** Null when the repository's default branch could not be read. */
  private async defaultBranchName(cwd: string): Promise<string | null> {
    let name = this.defaultBranches.get(cwd)
    if (!name) {
      try {
        const { stdout } = await this.runExecutable(
          'gh',
          ['repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'],
          { cwd }
        )
        name = stdout.trim()
      } catch {
        return null
      }
      if (!name) return null
      remember(this.defaultBranches, cwd, name)
    }
    return name
  }

  private async isDefaultBranch(cwd: string, branch: string): Promise<boolean | null> {
    const name = await this.defaultBranchName(cwd)
    return name === null ? null : name === branch
  }
}
