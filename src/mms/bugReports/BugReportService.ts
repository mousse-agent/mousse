/**
 * Files bug reports on GitHub: from an error's Report button, and from an agent's `report_bug` once the person
 * approved its draft. Nothing is sent that the person did not see in the draft.
 *
 * Who files it (Settings → General → Error reports → File with gh, which shows the `anonymous` flag's opposite):
 * - anonymous (default): Mousse's own account, through a relay (`MOUSSE_BUG_RELAY_URL`) that is not running yet, so no token
 *   ships in the app. Until it runs, a `mousse-bug` token can be given for testing: the secret
 *   `MOUSSE_BUG_GITHUB_TOKEN` (Settings → Secrets) or the same environment variable.
 * - not anonymous: the person's own GitHub sign-in (`gh auth token`).
 * When neither works, the person gets a prefilled new-issue page instead and submits it there.
 *
 * Dedupe: the draft carries the bug's signature; an open issue with it gets a 👍 instead of a new issue. A closed one
 * is linked from the new issue. Limits: the same bug once a day and at most ten reports an hour from this computer.
 *
 * The reports filed from here are kept in `<profile>/bug-reports.json`, anonymous ones too, so Settings lists them and
 * can revoke them, and an update can say which ones it fixes. One sent through the prefilled page has no number until a
 * search for its signature finds its issue; with a gh sign-in, the person's own reports on GitHub are added too.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir, release, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import {
  BUG_REPORT_BODY_MAX,
  BUG_REPORT_ISSUES_URL,
  BUG_REPORT_REPOSITORY,
  BUG_REPORT_TITLE_MAX,
  buildBugReportDraft,
  cleanReportText,
  closesIssue,
  prefilledIssueUrl,
  type BugReportDiagnostics,
  type BugReportDraft,
  type BugReportOutcome,
  type BugReportSource,
  type CleanContext,
  type ErrorReportSettings,
  type FiledBugReport,
  type FiledBugReportView,
  type PendingBugReport
} from '../../shared/bugReports'
import { mousseVersion } from '../appVersion'

/** The same bug is filed again from here at most once in this long. */
const SAME_BUG_MS = 24 * 60 * 60_000
/** Reports from this computer in an hour, at most. */
const PER_HOUR = 10
/** An agent's draft waits this long for the person, then lapses. */
const PENDING_MS = 30 * 60_000
/** Agent drafts waiting at once, at most. */
const MAX_PENDING = 5
/** Reports a thread or bot may ask to file in a day. */
const AGENT_PER_DAY = 3
/** Log lines a report may carry. */
const LOG_LINES = 40
/** A report sent through the prefilled page is looked for on GitHub this long, then dropped if never found. */
const FIND_MS = 3 * 24 * 60 * 60_000
/** An issue made up to this long before a report was sent can still be it: clocks differ. */
const CLOCK_SLACK_MS = 10 * 60_000
/** Signatures looked for in one search: GitHub allows five ORs in a query. */
const SEARCH_SIGNATURES = 6
const API = 'https://api.github.com'

/** An issue as GitHub's search returns it. */
interface SearchItem { number: number; html_url: string; title?: string; body?: string | null; created_at?: string }

export type GhTokenReader = () => Promise<string | undefined>

export interface BugReportServiceOptions {
  /** Mousse's own home, whose `logs` folder holds the window and connection logs. */
  installationHome: string
  /** The profile's home, where the list of filed reports is kept. */
  profileHome: string
  settings: () => ErrorReportSettings
  /** A saved secret's value, by name. */
  secret?: (name: string) => string | undefined
  /** The person's own GitHub token (`gh auth token`); undefined when they are not signed in. */
  ghToken?: GhTokenReader
  fetch?: typeof fetch
  now?: () => number
  env?: NodeJS.ProcessEnv
  /** The pending agent drafts or the filed list changed. */
  changed?: () => void
}

/** A credential and where it came from, for the words of an error. */
interface Credential { token: string; via: 'relay' | 'mousse' | 'you' }

export class BugReportError extends Error {
  constructor(readonly code: 'disabled' | 'invalid' | 'not_found' | 'failed', message: string) {
    super(message)
  }
}

export class BugReportService {
  private readonly sent: Array<{ at: number; signature: string; outcome: BugReportOutcome }> = []
  private readonly agentAsks = new Map<string, number[]>()
  private readonly pending = new Map<string, PendingBugReport & { resolve: (outcome: BugReportOutcome | null) => void; timer: ReturnType<typeof setTimeout> }>()
  private readonly listPath: string
  private readonly fetcher: typeof fetch
  private readonly now: () => number
  private readonly env: NodeJS.ProcessEnv
  /** The person's own reports on GitHub were added once already. */
  private ownIssuesAdded = false

  constructor(private readonly options: BugReportServiceOptions) {
    this.listPath = join(options.profileHome, 'bug-reports.json')
    this.fetcher = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.env = options.env ?? process.env
  }

  settings(): ErrorReportSettings {
    return this.options.settings()
  }

  /** What cleaning takes out on this computer: its home folder and account name. */
  cleanContext(): CleanContext {
    let username: string | undefined
    try { username = userInfo().username } catch { username = undefined }
    return { home: homedir(), username }
  }

  /** The environment and recent warning and error log lines, cleaned: what "Include diagnostics" adds. */
  async diagnostics(view?: { app?: string; view?: string }): Promise<BugReportDiagnostics> {
    const context = this.cleanContext()
    const logs: string[] = []
    for (const name of ['renderer-errors.log', 'gui-connection.log']) {
      try {
        const text = await readFile(join(this.options.installationHome, 'logs', name), 'utf8')
        const lines = text.split(/\r?\n/).filter((line) => /error|warn|fail|threw|uncaught|reject/i.test(line)).slice(-Math.ceil(LOG_LINES / 2))
        for (const line of lines) logs.push(cleanLogLine(line, context))
      } catch {
        // No such log yet.
      }
    }
    return {
      app: view?.app ? cleanReportText(view.app, context).slice(0, 120) : `Mousse ${mousseVersion()}`,
      os: `${osName(process.platform)} ${release()} · ${process.arch}`,
      runtime: [process.versions.electron ? `Electron ${process.versions.electron}` : '', `Node ${process.versions.node}`].filter(Boolean).join(' · '),
      ...(view?.view ? { view: cleanReportText(view.view, context).slice(0, 80) } : {}),
      logs: logs.slice(-LOG_LINES)
    }
  }

  /** The draft of `source`, cleaned, with `diagnostics` only when given. */
  draft(source: BugReportSource, diagnostics?: BugReportDiagnostics): BugReportDraft {
    return buildBugReportDraft(source, diagnostics, this.cleanContext())
  }

  /**
   * Files a draft the person saw and confirmed (title and body as they left them). Cleans it once more, so a secret
   * typed into the box is not sent either.
   */
  async file(input: BugReportDraft): Promise<BugReportOutcome> {
    const settings = this.settings()
    if (!settings.enabled) throw new BugReportError('disabled', 'Error reports are off in Settings → General.')
    const context = this.cleanContext()
    const title = cleanReportText(String(input.title ?? ''), context).replace(/\s+/g, ' ').trim().slice(0, BUG_REPORT_TITLE_MAX)
    const signature = /^mousse-sig-[0-9a-f]{12}$/.test(input.signature) ? input.signature : undefined
    if (!title) throw new BugReportError('invalid', 'The report needs a title.')
    if (!signature) throw new BugReportError('invalid', 'The report has no signature.')
    let body = cleanReportText(String(input.body ?? ''), context).slice(0, BUG_REPORT_BODY_MAX)
    if (!body.includes(signature)) body = `${body}\n\n<!-- ${signature} -->`
    const draft: BugReportDraft = { title, body, signature }

    const now = this.now()
    while (this.sent.length && now - this.sent[0]!.at > SAME_BUG_MS) this.sent.shift()
    const same = this.sent.find((entry) => entry.signature === signature && entry.outcome.status !== 'browser')
    if (same) return same.outcome
    if (this.sent.filter((entry) => now - entry.at < 60 * 60_000).length >= PER_HOUR) {
      return { status: 'limited', message: 'Too many reports from this computer in the last hour. Try again later.' }
    }

    const outcome = await this.send(draft, settings.anonymous)
    this.sent.push({ at: now, signature, outcome })
    const filedAt = new Date(now).toISOString()
    if (outcome.status === 'filed' || outcome.status === 'existing') {
      this.remember({ number: outcome.number, url: outcome.url, title, signature, filedAt, anonymous: settings.anonymous, ...(outcome.status === 'existing' ? { existing: true } : {}) })
    } else if (outcome.status === 'browser') {
      // The person submits it on GitHub, so its number is not known here; list() finds it by its signature.
      this.remember({ url: signatureSearchUrl(signature), title, signature, filedAt, anonymous: settings.anonymous, browser: true })
    }
    return outcome
  }

  /**
   * The reports filed from here, newest first, with their issues' state when GitHub answers. Reports sent through the
   * prefilled page are looked up by signature first, and, with a gh sign-in, the person's own reports on GitHub that
   * this computer does not know yet are added once.
   */
  async list(): Promise<FiledBugReportView[]> {
    const reports = this.readList()
    const credential = await this.credential(this.settings().anonymous).catch(() => undefined)
    const found = await this.findSubmitted(reports, credential?.via === 'relay' ? undefined : credential?.token)
    const added = await this.addOwnIssues(reports)
    if (found || added) this.writeList(reports)
    if (!reports.length) return []
    const views = await Promise.all(reports.map(async (report): Promise<FiledBugReportView> => {
      if (report.number === undefined) return { ...report, state: 'pending' }
      try {
        const issue = await this.api<{ state: string; state_reason?: string | null }>(`/repos/${BUG_REPORT_REPOSITORY}/issues/${report.number}`, { token: credential?.via === 'relay' ? undefined : credential?.token })
        const closedBy = issue.state === 'closed' ? await this.closingPullRequests(report.number, credential).catch(() => []) : []
        return { ...report, state: issue.state === 'closed' ? 'closed' : 'open', ...(issue.state_reason ? { stateReason: issue.state_reason } : {}), ...(closedBy.length ? { closedBy } : {}) }
      } catch {
        return { ...report, state: 'unknown' }
      }
    }))
    return views.sort((a, b) => b.filedAt.localeCompare(a.filedAt))
  }

  /**
   * Revokes a report: closes its issue as not planned with a note, with the account that filed it. A 👍 added to an
   * issue someone else opened is taken back instead. The report stays listed as revoked.
   */
  async revoke(number: number): Promise<FiledBugReport> {
    const reports = this.readList()
    const report = reports.find((entry) => entry.number === number)
    if (!report) throw new BugReportError('not_found', 'That report is not in this computer’s list.')
    if (!report.revokedAt) {
      // A report submitted on GitHub's page is the person's own issue, so their sign-in closes it.
      const anonymous = report.anonymous && !report.browser
      const credential = await this.credential(anonymous)
      if (!credential) throw new BugReportError('failed', anonymous ?'Mousse’s report account is not set up on this computer, so the issue could not be closed. Close it on GitHub instead.' : 'Sign in with gh (gh auth login) to close the issue, or close it on GitHub.')
      if (credential.via === 'relay') await this.relay({ action: 'revoke', number, signature: report.signature })
      else if (report.existing) await this.unreact(number, credential.token)
      else {
        await this.api(`/repos/${BUG_REPORT_REPOSITORY}/issues/${number}/comments`, { token: credential.token, method: 'POST', body: { body: 'The reporter withdrew this report.' } })
        await this.api(`/repos/${BUG_REPORT_REPOSITORY}/issues/${number}`, { token: credential.token, method: 'PATCH', body: { state: 'closed', state_reason: 'not_planned' } })
      }
      report.revokedAt = new Date(this.now()).toISOString()
      this.writeList(reports)
    }
    return report
  }

  // ----- Agents' reports -----

  /**
   * Holds an agent's draft for the person: a window shows it in the report dialog, where they file it, add
   * diagnostics, edit it, or not. Resolves with what filing did, or null when they did not file it or it lapsed.
   */
  propose(source: BugReportSource, from: PendingBugReport['from']): { id: string; settled: Promise<BugReportOutcome | null> } {
    if (!this.settings().enabled) throw new BugReportError('disabled', 'Error reports are off in Settings → General, so nothing can be filed.')
    const now = this.now()
    const asks = (this.agentAsks.get(from.id) ?? []).filter((at) => now - at < SAME_BUG_MS)
    if (asks.length >= AGENT_PER_DAY) throw new BugReportError('failed', `This ${from.kind} already asked to file ${AGENT_PER_DAY} reports today.`)
    if (this.pending.size >= MAX_PENDING) throw new BugReportError('failed', 'Several reports already wait for the person. Try again later.')
    asks.push(now)
    this.agentAsks.set(from.id, asks)
    const id = `bug_${randomUUID()}`
    const draft = this.draft(source)
    let resolve!: (outcome: BugReportOutcome | null) => void
    const settled = new Promise<BugReportOutcome | null>((done) => { resolve = done })
    const timer = setTimeout(() => this.settle(id, null), PENDING_MS)
    timer.unref?.()
    // Diagnostics are read now, so the dialog shows exactly what ticking the box adds.
    this.pending.set(id, { id, draft, diagnostics: { app: `Mousse ${mousseVersion()}`, os: '', logs: [] }, source, from, createdAt: new Date(now).toISOString(), resolve, timer })
    void this.diagnostics().then((diagnostics) => {
      const entry = this.pending.get(id)
      if (entry) entry.diagnostics = diagnostics
      this.options.changed?.()
    })
    this.options.changed?.()
    return { id, settled }
  }

  /** The agent drafts waiting for the person, oldest first. */
  pendingReports(): PendingBugReport[] {
    return [...this.pending.values()].map(({ resolve: _resolve, timer: _timer, ...entry }) => entry)
  }

  /** The person's answer to an agent's draft: filed as they left it, or not. */
  async answer(id: string, decision: { file: false } | { file: true; draft: BugReportDraft }): Promise<BugReportOutcome | null> {
    const entry = this.pending.get(id)
    if (!entry) throw new BugReportError('not_found', 'That report is no longer waiting.')
    if (!decision.file) {
      this.settle(id, null)
      return null
    }
    const outcome = await this.file({ ...decision.draft, signature: entry.draft.signature })
    this.settle(id, outcome.status === 'limited' ? null : outcome)
    return outcome
  }

  dispose(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, null)
  }

  private settle(id: string, outcome: BugReportOutcome | null): void {
    const entry = this.pending.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(id)
    entry.resolve(outcome)
    this.options.changed?.()
  }

  // ----- GitHub -----

  private async send(draft: BugReportDraft, anonymous: boolean): Promise<BugReportOutcome> {
    const browser = (reason: string): BugReportOutcome => ({ status: 'browser', url: prefilledIssueUrl(draft), reason })
    const credential = await this.credential(anonymous).catch(() => undefined)
    if (!credential) {
      return browser(anonymous
        ? 'The report opens on GitHub. Submit it there from your GitHub account; the issue is public.'
        : 'You are not signed in with gh, so the report opens on GitHub. Submit it there from your GitHub account; the issue is public.')
    }
    try {
      if (credential.via === 'relay') return await this.relay({ action: 'file', ...draft }) as BugReportOutcome
      const existing = await this.findSame(draft.signature, credential.token)
      if (existing?.state === 'open') {
        await this.api(`/repos/${BUG_REPORT_REPOSITORY}/issues/${existing.number}/reactions`, { token: credential.token, method: 'POST', body: { content: '+1' } })
        return { status: 'existing', number: existing.number, url: existing.url }
      }
      const body = existing ? `${draft.body}\n\nMaybe the same as #${existing.number}, which is closed.` : draft.body
      const created = await this.api<{ number: number; html_url: string }>(`/repos/${BUG_REPORT_REPOSITORY}/issues`, { token: credential.token, method: 'POST', body: { title: draft.title, body } })
      return { status: 'filed', number: created.number, url: created.html_url }
    } catch (error) {
      return browser(`GitHub did not take the report (${error instanceof Error ? error.message : 'unknown error'}), so it opens there for you to submit.`)
    }
  }

  /**
   * Gives reports sent through the prefilled page their issue: one search for all their signatures (the newest few),
   * unauthenticated when there is no token. One never found is dropped after FIND_MS. When the search fails, nothing
   * changes. Says whether `reports` changed.
   */
  private async findSubmitted(reports: FiledBugReport[], token?: string): Promise<boolean> {
    const waiting = reports.filter((report) => report.number === undefined)
      .sort((a, b) => b.filedAt.localeCompare(a.filedAt)).slice(0, SEARCH_SIGNATURES)
    if (!waiting.length) return false
    let items: SearchItem[]
    try {
      const q = encodeURIComponent(`repo:${BUG_REPORT_REPOSITORY} is:issue in:body ${waiting.map((report) => `"${report.signature}"`).join(' OR ')}`)
      items = (await this.api<{ items?: SearchItem[] }>(`/search/issues?q=${q}&sort=created&order=desc&per_page=100`, { token })).items ?? []
    } catch {
      return false
    }
    const taken = new Set(reports.flatMap((report) => (report.number === undefined ? [] : [report.number])))
    let changed = false
    for (const report of waiting) {
      const issue = submittedIssue(report, items.filter((item) => !taken.has(item.number)))
      if (issue) {
        report.number = issue.number
        report.url = issue.html_url
        taken.add(issue.number)
        changed = true
      } else if (this.now() - Date.parse(report.filedAt) > FIND_MS) {
        reports.splice(reports.indexOf(report), 1)
        changed = true
      }
    }
    return changed
  }

  /**
   * With a gh sign-in, adds the person's own issues in the report repository that carry a signature and are not in
   * the list (reports sent through the prefilled page before this computer remembered them). Once per run; nothing
   * without gh or when the search fails. Says whether `reports` changed.
   */
  private async addOwnIssues(reports: FiledBugReport[]): Promise<boolean> {
    if (this.ownIssuesAdded) return false
    const token = await this.options.ghToken?.().catch(() => undefined)
    if (!token) return false
    let items: SearchItem[]
    try {
      const q = encodeURIComponent(`repo:${BUG_REPORT_REPOSITORY} is:issue author:@me "mousse-sig-" in:body`)
      items = (await this.api<{ items?: SearchItem[] }>(`/search/issues?q=${q}&sort=created&order=desc&per_page=100`, { token })).items ?? []
    } catch {
      return false
    }
    this.ownIssuesAdded = true
    const known = new Set(reports.flatMap((report) => (report.number === undefined ? [] : [report.number])))
    let changed = false
    for (const item of [...items].reverse()) {
      const signature = SIGNATURE_IN_BODY.exec(item.body ?? '')?.[0]
      if (known.has(item.number) || !signature || !item.created_at) continue
      const waiting = reports.find((report) => report.number === undefined && report.signature === signature && submittedIssue(report, [item]))
      if (waiting) {
        waiting.number = item.number
        waiting.url = item.html_url
      } else {
        const title = String(item.title ?? '').slice(0, BUG_REPORT_TITLE_MAX) || signature
        reports.push({ number: item.number, url: item.html_url, title, signature, filedAt: item.created_at, anonymous: false, browser: true })
      }
      known.add(item.number)
      changed = true
    }
    return changed
  }

  /** An issue that carries the signature, open first. */
  private async findSame(signature: string, token: string): Promise<{ number: number; url: string; state: string } | undefined> {
    const q = encodeURIComponent(`repo:${BUG_REPORT_REPOSITORY} is:issue "${signature}" in:body`)
    const found = await this.api<{ items?: Array<{ number: number; html_url: string; state: string }> }>(`/search/issues?q=${q}&sort=created&order=desc&per_page=10`, { token })
    const items = found.items ?? []
    const hit = items.find((item) => item.state === 'open') ?? items[0]
    return hit ? { number: hit.number, url: hit.html_url, state: hit.state } : undefined
  }

  /**
   * The merged pull requests that close an issue, as GitHub links them: its timeline's cross-references from this
   * repository's pull requests whose description closes it. Works without a sign-in.
   */
  private async closingPullRequests(number: number, credential?: Credential): Promise<number[]> {
    type Source = { number?: number; body?: string | null; pull_request?: { merged_at?: string | null }; repository?: { full_name?: string } }
    const events = await this.api<Array<{ event?: string; source?: { issue?: Source } }>>(
      `/repos/${BUG_REPORT_REPOSITORY}/issues/${number}/timeline?per_page=100`, { token: credential?.via === 'relay' ? undefined : credential?.token })
    const closing = events.flatMap((event) => {
      const source = event.event === 'cross-referenced' ? event.source?.issue : undefined
      return source && typeof source.number === 'number' && source.pull_request?.merged_at &&
        source.repository?.full_name === BUG_REPORT_REPOSITORY && closesIssue(source.body ?? '', number) ? [source.number] : []
    })
    return [...new Set(closing)]
  }

  private async unreact(number: number, token: string): Promise<void> {
    const me = await this.api<{ login: string }>('/user', { token })
    const reactions = await this.api<Array<{ id: number; content: string; user?: { login?: string } }>>(`/repos/${BUG_REPORT_REPOSITORY}/issues/${number}/reactions?per_page=100`, { token })
    const mine = reactions.find((reaction) => reaction.content === '+1' && reaction.user?.login === me.login)
    if (mine) await this.api(`/repos/${BUG_REPORT_REPOSITORY}/issues/${number}/reactions/${mine.id}`, { token, method: 'DELETE' })
  }

  private async credential(anonymous: boolean): Promise<Credential | undefined> {
    if (anonymous) {
      if (this.env.MOUSSE_BUG_RELAY_URL) return { token: '', via: 'relay' }
      const token = this.env.MOUSSE_BUG_GITHUB_TOKEN || this.options.secret?.('MOUSSE_BUG_GITHUB_TOKEN')
      return token ? { token, via: 'mousse' } : undefined
    }
    const token = await this.options.ghToken?.()
    return token ? { token, via: 'you' } : undefined
  }

  private async relay(payload: Record<string, unknown>): Promise<unknown> {
    const response = await this.fetcher(String(this.env.MOUSSE_BUG_RELAY_URL), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repository: BUG_REPORT_REPOSITORY, ...payload }),
      signal: AbortSignal.timeout(20_000)
    })
    if (!response.ok) throw new Error(`relay ${response.status}`)
    return response.json()
  }

  private async api<T = unknown>(path: string, request: { token?: string; method?: string; body?: unknown }): Promise<T> {
    const response = await this.fetcher(`${API}${path}`, {
      method: request.method ?? 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'mousse-bug-report',
        ...(request.token ? { authorization: `Bearer ${request.token}` } : {}),
        ...(request.body ? { 'content-type': 'application/json' } : {})
      },
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      signal: AbortSignal.timeout(20_000)
    })
    if (!response.ok) throw new Error(`GitHub ${response.status}`)
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }

  // ----- The local list -----

  private readList(): FiledBugReport[] {
    try {
      const parsed = JSON.parse(readFileSync(this.listPath, 'utf8')) as { reports?: unknown }
      return Array.isArray(parsed.reports) ? parsed.reports.filter(isFiled) : []
    } catch {
      return []
    }
  }

  private writeList(reports: FiledBugReport[]): void {
    const dir = dirname(this.listPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const temp = `${this.listPath}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ version: 1, reports: reports.slice(-500) }, null, 2))
    renameSync(temp, this.listPath)
    this.options.changed?.()
  }

  private remember(report: FiledBugReport): void {
    // One entry per issue, and one per signature among those not found on GitHub yet.
    const reports = this.readList().filter((entry) => report.number !== undefined
      ? entry.number !== report.number
      : !(entry.number === undefined && entry.signature === report.signature))
    reports.push(report)
    this.writeList(reports)
  }
}

const SIGNATURE_IN_BODY = /mousse-sig-[0-9a-f]{12}/

/** A GitHub search for a signature: where a report not found yet links to. */
function signatureSearchUrl(signature: string): string {
  return `${BUG_REPORT_ISSUES_URL}?q=${encodeURIComponent(`is:issue "${signature}"`)}`
}

/**
 * The issue among `items` (newest first) that a report sent through the prefilled page became: the first one made
 * after it was sent that carries its signature. An older issue with the same signature is someone else's.
 */
function submittedIssue(report: FiledBugReport, items: readonly SearchItem[]): SearchItem | undefined {
  const sent = Date.parse(report.filedAt) - CLOCK_SLACK_MS
  return items.filter((item) => (item.body ?? '').includes(report.signature) && Date.parse(item.created_at ?? '') >= sent).at(-1)
}

function isFiled(value: unknown): value is FiledBugReport {
  const entry = value as FiledBugReport
  return Boolean(entry) && (entry.number === undefined || typeof entry.number === 'number') && typeof entry.url === 'string' && typeof entry.title === 'string' && typeof entry.signature === 'string' && typeof entry.filedAt === 'string'
}

function osName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : platform
}

/** A log line with only its time, kind and error text: no thread, project or file names, no message text. */
function cleanLogLine(line: string, context: CleanContext): string {
  try {
    const record = JSON.parse(line) as Record<string, unknown>
    const kept = ['at', 'time', 'kind', 'name', 'level', 'code', 'event', 'view', 'repeats']
      .filter((key) => record[key] !== undefined && typeof record[key] !== 'object')
      .map((key) => `${key}=${String(record[key]).slice(0, 80)}`)
    const message = typeof record.message === 'string' ? ` ${record.message.slice(0, 200)}` : ''
    return cleanReportText(`${kept.join(' ')}${message}`, context).slice(0, 300)
  } catch {
    return cleanReportText(line, context).slice(0, 300)
  }
}
