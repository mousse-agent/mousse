import type { ExecutableRunner } from '../src/mms/git/ghRunner'

/** A line comment as the host stores it. */
export interface FakeLineComment {
  id: number
  createdAt: string
  updatedAt: string
  user: string
  association: string
  body: string
  path?: string
  line?: number
}

export interface FakeCheck {
  name: string
  status: 'COMPLETED' | 'IN_PROGRESS' | 'QUEUED'
  conclusion: '' | 'SUCCESS' | 'FAILURE' | 'ACTION_REQUIRED' | 'SKIPPED'
  detailsUrl?: string
}

/** Seconds-precision timestamp, as the host writes them. */
export const stamp = (ms: number): string => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z')

export function ghFailure(message: string): Error {
  return Object.assign(new Error(message), { stderr: message })
}

/**
 * A `gh` that answers the calls the pull request host makes for one pull request: the repository, `pr view`, the line comment
 * pages (filtered, sorted and paged the way the host does it, already projected as `--jq` would) and the signed-in account.
 * Every call is recorded; a test changes what the host holds between ticks, or makes a call fail or wait.
 */
export class FakeGh {
  readonly calls: string[][] = []
  host = 'github.com'
  repository = 'acme/app'
  number = 7
  title = 'Add thing'
  state: 'OPEN' | 'MERGED' | 'CLOSED' = 'OPEN'
  headSha = 'a'.repeat(40)
  /** How the pull request's author relates to the repository, and whether the branch is in a fork. */
  authorAssociation = 'OWNER'
  fork = false
  viewer = 'me'
  checks: FakeCheck[] = []
  reviews: Array<{ id: string; login: string; association: string; state: string; body: string; submittedAt: string }> = []
  conversation: Array<{ id: string; login: string; association: string; body: string; createdAt: string }> = []
  lines: FakeLineComment[] = []
  /** Throws for the call when it returns an error. */
  fail: ((args: readonly string[]) => Error | null) | null = null
  /** Runs before a page of line comments is served, to change what the host holds mid-read. */
  beforeLinePage: ((page: number, query: URLSearchParams) => void) | null = null
  /** Makes `pr view` wait until released. */
  gate: Promise<void> | null = null

  count(match: (args: string[]) => boolean): number {
    return this.calls.filter(match).length
  }

  prViews(): number {
    return this.count((args) => args[0] === 'pr' && args[1] === 'view')
  }

  linePages(): string[][] {
    return this.calls.filter((args) => args[0] === 'api' && String(args[3]).includes('/comments'))
  }

  readonly runner: ExecutableRunner = async (executable, args) => {
    if (executable !== 'gh') throw ghFailure(`unexpected ${executable}`)
    const list = [...args]
    this.calls.push(list)
    const failure = this.fail?.(list)
    if (failure) throw failure
    if (list[0] === '--version') return { stdout: 'gh version 2.76.1\n', stderr: '' }
    if (list[0] === 'repo' && list[1] === 'view') {
      return { stdout: JSON.stringify({ nameWithOwner: this.repository, url: `https://${this.host}/${this.repository}` }), stderr: '' }
    }
    if (list[0] === 'pr' && list[1] === 'view') {
      if (this.gate) await this.gate
      return { stdout: JSON.stringify(this.view()), stderr: '' }
    }
    if (list[0] === 'api') {
      const path = list[3]
      if (path === 'user') return { stdout: `${this.viewer}\n`, stderr: '' }
      // The pull request itself, projected to its author's association (gh 2.98 refuses that field in `pr view`).
      if (/\/pulls\/\d+$/.test(path)) return { stdout: `${this.authorAssociation}\n`, stderr: '' }
      return { stdout: JSON.stringify(this.linePage(path)), stderr: '' }
    }
    throw ghFailure(`unexpected gh ${list.join(' ')}`)
  }

  private view(): unknown {
    const [owner, name] = this.repository.split('/')
    return {
      number: this.number,
      title: this.title,
      url: `https://${this.host}/${this.repository}/pull/${this.number}`,
      state: this.state,
      isDraft: false,
      body: '',
      author: { login: 'dev' },
      baseRefName: 'main',
      headRefName: 'feature',
      headRefOid: this.headSha,
      headRepository: { name },
      headRepositoryOwner: { login: this.fork ? 'forker' : owner },
      isCrossRepository: this.fork,
      reviewDecision: '',
      updatedAt: stamp(Date.now()),
      mergedAt: this.state === 'MERGED' ? stamp(Date.now()) : null,
      closedAt: this.state === 'CLOSED' ? stamp(Date.now()) : null,
      reviews: this.reviews.map((review) => ({
        id: review.id,
        author: { login: review.login },
        authorAssociation: review.association,
        state: review.state,
        body: review.body,
        submittedAt: review.submittedAt,
        includesCreatedEdit: false
      })),
      comments: this.conversation.map((comment) => ({
        id: comment.id,
        author: { login: comment.login },
        authorAssociation: comment.association,
        body: comment.body,
        createdAt: comment.createdAt,
        includesCreatedEdit: false,
        url: `https://${this.host}/${this.repository}/pull/${this.number}#issuecomment-${comment.id}`
      })),
      statusCheckRollup: this.checks.map((check) => ({ __typename: 'CheckRun', name: check.name, status: check.status, conclusion: check.conclusion, detailsUrl: check.detailsUrl ?? '', workflowName: 'CI' }))
    }
  }

  private linePage(path: string): unknown[] {
    const query = new URL(`http://host/${path}`).searchParams
    const page = Number(query.get('page') ?? '1')
    const perPage = Number(query.get('per_page') ?? '30')
    this.beforeLinePage?.(page, query)
    const since = query.get('since')
    const key = query.get('sort') === 'created' ? 'createdAt' : 'updatedAt'
    const direction = query.get('direction') === 'desc' ? -1 : 1
    const items = this.lines
      .filter((comment) => !since || Date.parse(comment.updatedAt) >= Date.parse(since))
      .sort((a, b) => direction * (Date.parse(a[key]) - Date.parse(b[key]) || a.id - b.id))
      .slice((page - 1) * perPage, page * perPage)
    return items.map((comment) => ({
      id: comment.id,
      path: comment.path ?? 'src/a.ts',
      line: comment.line ?? 3,
      start_line: null,
      side: 'RIGHT',
      created_at: comment.createdAt,
      updated_at: comment.updatedAt,
      in_reply_to_id: null,
      html_url: `https://${this.host}/${this.repository}/pull/${this.number}#discussion_r${comment.id}`,
      author_association: comment.association,
      user: { login: comment.user },
      body: comment.body,
      body_truncated: false
    }))
  }
}
