import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  pullRequestIdentityKey,
  type CreatePullRequestInput,
  type GitPullRequestInfo,
  type GitPullRequestLookup,
  type PullRequestBaseBranches,
  type PullRequestCheck,
  type PullRequestCheckState,
  type PullRequestComment,
  type PullRequestDetail,
  type PullRequestIdentity,
  type PullRequestReview,
  type PullRequestReviewDecision,
  type PullRequestReviewVerdict,
  type RepositoryIdentity
} from '../../shared/pullRequests'
import type { CodeHost } from './CodeHost'
import {
  classifyGhFailure,
  defaultRunner,
  isMissingExecutable,
  processMessage,
  type ExecutableRunner,
  type GhFailureKind
} from './ghRunner'

const FAILED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE'])
const FAILED_STATES = new Set(['FAILURE', 'ERROR'])
const PENDING_STATES = new Set(['PENDING', 'EXPECTED'])
/** A workflow run held until a maintainer approves it; it has not run and has not failed. */
const WAITING_CONCLUSION = 'ACTION_REQUIRED'

/** The `code` of the error a create fails with when the branch already has a pull request (another client was first). */
export const PULL_REQUEST_EXISTS = 'pull_request_exists'

/**
 * Removes a temp folder, retrying briefly, and never throws. A scanner or a just-ended gh can hold the
 * file for a moment on Windows; a leftover temp folder must not turn a pull request that was created
 * into an error.
 */
export async function removeTempFolder(directory: string, remove: typeof rm = rm): Promise<void> {
  try {
    await remove(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    // Left for the operating system's temp cleanup.
  }
}

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

const PULL_REQUEST_DETAIL_FIELDS = [
  'number', 'title', 'url', 'state', 'isDraft', 'body', 'author', 'baseRefName', 'headRefName', 'headRefOid',
  'headRepository', 'headRepositoryOwner', 'isCrossRepository', 'reviewDecision', 'reviews', 'comments',
  'statusCheckRollup', 'updatedAt', 'mergedAt', 'closedAt'
].join(',')

/** Longest conversation comment or review body kept; the full text stays on the host. */
const VIEW_BODY_CHARS = 4_000
/** Longest pull request description kept. */
const PULL_REQUEST_BODY_CHARS = 20_000
/** Longest line comment body kept. */
const LINE_COMMENT_BODY_CHARS = 2_000
const LINE_COMMENT_PAGE_SIZE = 100
/** Pages of line comments read, newest first: at most this many times a page of 100. */
const LINE_COMMENT_MAX_PAGES = 5

/**
 * Caps the bodies of `gh pr view` with gh's own `--jq`, so a busy pull request cannot outgrow the runner's
 * output limit whatever its authors wrote. A cut body is flagged `bodyTruncated`.
 */
export const PULL_REQUEST_VIEW_JQ = [
  `.body |= .[:${PULL_REQUEST_BODY_CHARS}]`,
  `.comments |= map(.bodyTruncated = ((.body | length) > ${VIEW_BODY_CHARS}) | .body |= .[:${VIEW_BODY_CHARS}])`,
  `.reviews |= map(.bodyTruncated = ((.body | length) > ${VIEW_BODY_CHARS}) | .body |= .[:${VIEW_BODY_CHARS}])`
].join(' | ')

/**
 * Projects a page of line comments to what Mousse shows, with gh's own `--jq`: no diff hunks and bodies cut at
 * 2,000 characters, so a page of 100 stays far below the runner's 1 MiB output limit.
 */
export const LINE_COMMENT_JQ = `[.[] | {id, path, line, start_line, side, created_at, updated_at, in_reply_to_id, html_url, author_association, user: {login: .user.login}, body: .body[:${LINE_COMMENT_BODY_CHARS}], body_truncated: (.body | length > ${LINE_COMMENT_BODY_CHARS})}]`

/** Why a pull request read failed; `message` is the host's own, with the folder, host and account added where they explain it. */
export class PullRequestReadError extends Error {
  constructor(message: string, readonly kind: Exclude<GhFailureKind, 'none'> | 'gh-missing') {
    super(message)
    this.name = 'PullRequestReadError'
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function login(value: unknown): string {
  return value && typeof value === 'object' && typeof (value as { login?: unknown }).login === 'string' && (value as { login: string }).login
    ? (value as { login: string }).login
    : 'ghost'
}

/** The state one check shows. Skipped and neutral runs are neither passing nor failing, so they are named apart. */
function checkItemState(item: Record<string, unknown>): PullRequestCheck['state'] {
  const conclusion = upper(item.conclusion)
  const status = upper(item.status)
  const state = upper(item.state)
  if (FAILED_CONCLUSIONS.has(conclusion) || FAILED_STATES.has(state)) return 'failing'
  if (conclusion === WAITING_CONCLUSION) return 'waiting'
  if ((status && status !== 'COMPLETED') || PENDING_STATES.has(state)) return 'pending'
  if (conclusion === 'SKIPPED' || conclusion === 'NEUTRAL') return 'skipped'
  return 'passing'
}

/** Each check of gh's statusCheckRollup (check runs and status contexts) with its state and link. */
export function parseCheckRuns(rollup: unknown): PullRequestCheck[] {
  const checks: PullRequestCheck[] = []
  for (const entry of Array.isArray(rollup) ? rollup : []) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const name = text(item.name) || text(item.context) || 'Check'
    const url = text(item.detailsUrl) || text(item.targetUrl)
    const workflowName = text(item.workflowName)
    checks.push({ name, state: checkItemState(item), url: url || null, ...(workflowName ? { workflowName } : {}) })
  }
  return checks
}

/** The host's review decision; an empty one (no review required, none given) is null. */
export function parseReviewDecision(value: unknown): PullRequestReviewDecision | null {
  const decision = upper(value)
  if (decision === 'APPROVED') return 'approved'
  if (decision === 'CHANGES_REQUESTED') return 'changes_requested'
  if (decision === 'REVIEW_REQUIRED') return 'review_required'
  return null
}

function reviewVerdict(value: unknown): PullRequestReviewVerdict {
  const state = upper(value)
  if (state === 'APPROVED') return 'approved'
  if (state === 'CHANGES_REQUESTED') return 'changes_requested'
  if (state === 'DISMISSED') return 'dismissed'
  if (state === 'PENDING') return 'pending'
  return 'commented'
}

function parseReviews(value: unknown, pullRequestUrl: string): PullRequestReview[] {
  const reviews: PullRequestReview[] = []
  for (const entry of Array.isArray(value) ? value : []) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const id = text(item.id)
    if (!id) continue
    reviews.push({
      id,
      author: login(item.author),
      authorAssociation: text(item.authorAssociation) || 'NONE',
      state: reviewVerdict(item.state),
      body: text(item.body),
      bodyTruncated: item.bodyTruncated === true,
      submittedAt: text(item.submittedAt) || null,
      edited: item.includesCreatedEdit === true,
      url: text(item.url) || pullRequestUrl
    })
  }
  return reviews
}

function parseConversationComments(value: unknown, pullRequestUrl: string): PullRequestComment[] {
  const comments: PullRequestComment[] = []
  for (const entry of Array.isArray(value) ? value : []) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const id = text(item.id)
    if (!id) continue
    comments.push({
      id,
      author: login(item.author),
      authorAssociation: text(item.authorAssociation) || 'NONE',
      body: text(item.body),
      bodyTruncated: item.bodyTruncated === true,
      createdAt: text(item.createdAt),
      edited: item.includesCreatedEdit === true,
      url: text(item.url) || pullRequestUrl,
      path: null,
      line: null,
      startLine: null,
      side: null,
      inReplyTo: null
    })
  }
  return comments
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Parses one page of `gh api …/pulls/<n>/comments --jq <LINE_COMMENT_JQ>`; null when it is not a list. */
export function parseLineCommentPage(stdout: string, pullRequestUrl = ''): PullRequestComment[] | null {
  let data: unknown
  try {
    data = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(data)) return null
  const comments: PullRequestComment[] = []
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const rawId = typeof item.id === 'number' || typeof item.id === 'string' ? String(item.id) : ''
    if (!rawId) continue
    const created = text(item.created_at)
    const updated = text(item.updated_at)
    const parent = typeof item.in_reply_to_id === 'number' || typeof item.in_reply_to_id === 'string' ? String(item.in_reply_to_id) : null
    comments.push({
      id: rawId,
      author: login(item.user),
      authorAssociation: text(item.author_association) || 'NONE',
      body: text(item.body),
      bodyTruncated: item.body_truncated === true,
      createdAt: created,
      edited: Boolean(created && updated && Date.parse(updated) > Date.parse(created)),
      url: text(item.html_url) || pullRequestUrl,
      path: text(item.path) || null,
      line: numberOrNull(item.line),
      startLine: numberOrNull(item.start_line),
      side: item.side === 'LEFT' || item.side === 'RIGHT' ? item.side : null,
      inReplyTo: parent
    })
  }
  return comments
}

function repositoryOf(owner: unknown, repository: unknown): string | null {
  const ownerName = owner && typeof owner === 'object' ? text((owner as { login?: unknown }).login) : ''
  const name = repository && typeof repository === 'object' ? text((repository as { name?: unknown }).name) : ''
  return ownerName && name ? `${ownerName}/${name}` : null
}

/**
 * Parses `gh pr view --json <detail fields>` and the line comment pages read newest first (each as
 * `parseLineCommentPage` reads them). `commentsTruncated` says the last page was full, so older line
 * comments exist. Null when the view is not a pull request.
 */
export function parsePullRequestDetail(
  identity: PullRequestIdentity,
  viewJson: string,
  commentPages: readonly string[],
  commentsTruncated = false
): PullRequestDetail | null {
  const info = parsePullRequestJson(viewJson)
  if (!info) return null
  const value = JSON.parse(viewJson) as Record<string, unknown>
  const line: PullRequestComment[] = []
  for (const page of commentPages) {
    const parsed = parseLineCommentPage(page, info.url)
    if (!parsed) return null
    line.push(...parsed)
  }
  // Pages come newest first; display is oldest first, with conversation comments in between by their time.
  line.reverse()
  const comments = [...parseConversationComments(value.comments, info.url), ...line]
    .map((comment, index) => {
      const at = Date.parse(comment.createdAt)
      return { comment, index, at: Number.isNaN(at) ? Infinity : at }
    })
    .sort((a, b) => (a.at === b.at ? a.index - b.index : a.at < b.at ? -1 : 1))
    .map(({ comment }) => comment)
  return {
    ...info,
    headRefName: info.headRefName ?? '',
    baseRefName: info.baseRefName ?? '',
    identity,
    body: text(value.body),
    author: login(value.author),
    headSha: text(value.headRefOid),
    headRepository: repositoryOf(value.headRepositoryOwner, value.headRepository),
    baseRepository: identity.nameWithOwner,
    isCrossRepository: value.isCrossRepository === true,
    reviewDecision: parseReviewDecision(value.reviewDecision),
    reviews: parseReviews(value.reviews, info.url),
    comments,
    commentsTruncated,
    checkRuns: parseCheckRuns(value.statusCheckRollup),
    updatedAt: text(value.updatedAt),
    mergedAt: text(value.mergedAt) || null,
    closedAt: text(value.closedAt) || null
  }
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
      /** A stored "nothing there" answer: a forced read never reuses one, since what it asks for may exist by now. Joining a read in flight is unchanged. */
      negative?: (value: T) => boolean
    } = {}
  ): Promise<T> {
    const hit = this.values.get(key)
    const staleNegative = options.force === true && hit !== undefined && 'value' in hit.result && options.negative?.(hit.result.value) === true
    if (hit && !staleNegative) {
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
  private readonly details: ReadCache<PullRequestDetail>
  private readonly viewers: ReadCache<string>

  constructor(
    private readonly runExecutable: ExecutableRunner = defaultRunner,
    private readonly clock: () => number = Date.now
  ) {
    this.identities = new ReadCache(IDENTITY_TTL_MS, clock)
    this.lookups = new ReadCache(LOOKUP_TTL_MS, clock)
    this.details = new ReadCache(LOOKUP_TTL_MS, clock)
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
        shortLived: (lookup) => lookup.state === 'unavailable',
        // A forced lookup is asked because a pull request may have appeared (a push, a create, a duplicate check).
        negative: (lookup) => lookup.state === 'none'
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

  /**
   * One pull request with its reviews, comments and checks. The line comments are read newest first, at most
   * five pages of 100, so a busy pull request shows its latest ones; every read of them is projected and capped
   * by gh itself. Shared by every folder of the repository for 30 seconds; `force` only skips a value younger than that.
   */
  async getPullRequestDetail(cwd: string, number: number, options: { force?: boolean } = {}): Promise<PullRequestDetail> {
    if (!Number.isSafeInteger(number) || number < 1) throw new PullRequestReadError('Unsupported pull request number.', 'error')
    const probe = await this.probeGh()
    if (!probe.ok) throw new PullRequestReadError(probe.message, probe.reason)

    let identity: RepositoryIdentity
    try {
      identity = await this.repositoryIdentity(cwd)
    } catch (error) {
      throw await this.detailFailure(cwd, null, number, error)
    }
    const pullRequest: PullRequestIdentity = { ...identity, number }
    return this.details.read(
      pullRequestIdentityKey(pullRequest),
      () => this.readDetail(cwd, pullRequest).catch(async (error: unknown) => {
        throw error instanceof PullRequestReadError ? error : await this.detailFailure(cwd, identity, number, error)
      }),
      // A failure that asking again would only repeat is kept briefly, so a signed-out or limited host is not hammered.
      { force: options.force, cacheError: (error) => error instanceof PullRequestReadError && (error.kind === 'unauthenticated' || error.kind === 'not-github' || error.kind === 'rate-limited') }
    )
  }

  private async readDetail(cwd: string, pullRequest: PullRequestIdentity): Promise<PullRequestDetail> {
    const { stdout: view } = await this.runExecutable(
      'gh',
      ['pr', 'view', String(pullRequest.number), '--json', PULL_REQUEST_DETAIL_FIELDS, '--jq', PULL_REQUEST_VIEW_JQ],
      { cwd }
    )
    const [owner, repository] = pullRequest.nameWithOwner.split('/')
    const endpoint = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${pullRequest.number}/comments`
    const pages: string[] = []
    let lastCount = 0
    for (let page = 1; page <= LINE_COMMENT_MAX_PAGES; page++) {
      const { stdout } = await this.runExecutable(
        'gh',
        [
          'api', '--hostname', pullRequest.host,
          `${endpoint}?sort=created&direction=desc&per_page=${LINE_COMMENT_PAGE_SIZE}&page=${page}`,
          '--jq', LINE_COMMENT_JQ
        ],
        { cwd }
      )
      const parsed = parseLineCommentPage(stdout)
      if (!parsed) throw new PullRequestReadError('GitHub CLI returned an unexpected comments response.', 'error')
      pages.push(stdout)
      lastCount = parsed.length
      if (lastCount < LINE_COMMENT_PAGE_SIZE) break
    }
    const truncated = pages.length === LINE_COMMENT_MAX_PAGES && lastCount === LINE_COMMENT_PAGE_SIZE
    const detail = parsePullRequestDetail(pullRequest, view, pages, truncated)
    if (!detail) throw new PullRequestReadError('GitHub CLI returned an unexpected pull request response.', 'error')
    return detail
  }

  /** A failed detail read with the host's own message, plus where and as whom it failed when that explains it. */
  private async detailFailure(cwd: string, identity: RepositoryIdentity | null, number: number, error: unknown): Promise<PullRequestReadError> {
    if (error instanceof PullRequestReadError) return error
    if (isMissingExecutable(error)) return new PullRequestReadError('GitHub CLI (gh) was not found. Install it to see pull requests.', 'gh-missing')
    const message = processMessage(error)
    const kind = classifyGhFailure(message)
    const first = message.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? message
    if (kind === 'not-found') {
      const viewer = identity ? await this.viewerLogin(cwd) : null
      const where = identity ? `${identity.nameWithOwner} on ${identity.host}` : cwd
      const account = identity
        ? viewer
          ? `signed in to ${identity.host} as ${viewer}, which cannot see it`
          : `the account signed in to ${identity.host} may not see it`
        : 'the signed-in account may not see it'
      return new PullRequestReadError(`${first} — pull request #${number} is not in ${where}, or ${account}.`, 'not-found')
    }
    if (kind === 'unauthenticated') {
      return new PullRequestReadError(`${first} — not signed in${identity ? ` to ${identity.host}` : ''} for ${cwd}.`, 'unauthenticated')
    }
    if (kind === 'not-github') return new PullRequestReadError(`${first} — ${cwd} is not a GitHub repository.`, 'not-github')
    return new PullRequestReadError(message, kind === 'none' ? 'error' : kind)
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
        if (/already exists/i.test(message)) throw Object.assign(new Error('A pull request for this branch already exists.'), { code: PULL_REQUEST_EXISTS })
        throw new Error(message)
      }
    } finally {
      await removeTempFolder(directory)
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
