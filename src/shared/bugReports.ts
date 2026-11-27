/**
 * Bug reports: the draft an error's Report button and an agent's `report_bug` build, what is cleaned out of it, the
 * signature that finds the same bug again, and the local list of the reports this person filed.
 *
 * By default a draft holds no data of the person's: the error as Mousse words it, with secrets, paths, emails and
 * addresses taken out. Logs and environment details join it only when the person ticks "Include diagnostics", and
 * the draft they see is exactly what is sent.
 */

/** Where reports go. */
export const BUG_REPORT_REPOSITORY = 'mousse-agent/mousse'
export const BUG_REPORT_ISSUES_URL = `https://github.com/${BUG_REPORT_REPOSITORY}/issues`

/** Longest title and body sent. */
export const BUG_REPORT_TITLE_MAX = 200
export const BUG_REPORT_BODY_MAX = 30_000
/** A prefilled new-issue URL stays under what browsers and GitHub take. */
const PREFILLED_URL_MAX = 7_500

/** Settings → General → Error reports. */
export interface ErrorReportSettings {
  /** Errors show a Report button, and agents may ask to file bugs (`report_bug`). On by default. */
  enabled: boolean
  /** Files through Mousse's own relay account once it runs; until then the report opens on GitHub for the person to submit. Off: their own `gh` sign-in. On by default. */
  anonymous: boolean
}

export function normalizeErrorReportSettings(raw?: Partial<ErrorReportSettings> | null): ErrorReportSettings {
  return { enabled: raw?.enabled !== false, anonymous: raw?.anonymous !== false }
}

/** What a report starts from: an error on screen, or an agent's description of a bug. */
export interface BugReportSource {
  /** `button`: a person pressed Report on an error. `agent`: an agent called `report_bug`. */
  kind: 'button' | 'agent'
  /** A short title, such as the error's heading. */
  title: string
  /** The error's message, or the agent's account of what happened. */
  message: string
  /** The reference the error was logged under. */
  reference?: string
  /** The error's code, such as `internal_error`. */
  code?: string
  /** The stack, when there is one. */
  stack?: string
  /** Steps to see it again (agents). */
  steps?: string
  /** Where it showed: `toast`, `transcript`, `window`, `dialog`. */
  surface?: string
  /** The agent that asked to file it (agents only). */
  agent?: string
}

/** The environment and log lines a report may carry when the person opts in. */
export interface BugReportDiagnostics {
  app: string
  os: string
  runtime?: string
  view?: string
  /** Recent warning and error lines from Mousse's logs, already cleaned. */
  logs: string[]
}

/** A draft as shown and sent. */
export interface BugReportDraft {
  title: string
  body: string
  /** Finds the same bug again (dedupe). */
  signature: string
}

/** What filing did. */
export type BugReportOutcome =
  | { status: 'filed'; number: number; url: string }
  /** The same bug was already open: a 👍 was added to it instead of a new issue. */
  | { status: 'existing'; number: number; url: string }
  /** Nothing could file it here: the person opens this prefilled page and submits it there. */
  | { status: 'browser'; url: string; reason: string }
  /** Too many reports; nothing was sent. */
  | { status: 'limited'; message: string }

/** A report this person filed, kept on this computer so they can find and revoke it, anonymous or not. */
export interface FiledBugReport {
  /** Missing while a report sent through the prefilled page is not found on GitHub yet. */
  number?: number
  /** The issue; for one not found yet, a GitHub search for its signature. */
  url: string
  title: string
  signature: string
  filedAt: string
  anonymous: boolean
  /** Added a 👍 to an issue that was already open rather than opening one. */
  existing?: boolean
  /** Submitted by the person on GitHub's prefilled page, from their own account. */
  browser?: boolean
  /** Closed by the person in Settings. */
  revokedAt?: string
}

/** A filed report with its issue's state now. */
export interface FiledBugReportView extends FiledBugReport {
  /** `pending`: sent through the prefilled page, and GitHub does not show its issue yet. */
  state: 'open' | 'closed' | 'unknown' | 'pending'
  /** `completed` when it was fixed; `not_planned` when closed otherwise. */
  stateReason?: string
  /** Merged pull requests of this repository whose description closes the issue (`Closes #N`), from its timeline. */
  closedBy?: number[]
}

/** An agent's report waiting for the person to file it or not. */
export interface PendingBugReport {
  id: string
  draft: BugReportDraft
  /** Diagnostics the person may add; nothing of them is sent unless they tick the box. */
  diagnostics: BugReportDiagnostics
  source: BugReportSource
  /** The thread or bot that asked. */
  from: { kind: 'thread' | 'bot'; id: string; name?: string }
  createdAt: string
}

/** The service methods a window calls. */
export const BUG_REPORT_METHODS = [
  'bugReports.draft',
  'bugReports.file',
  'bugReports.list',
  'bugReports.revoke',
  'bugReports.pending',
  'bugReports.answer'
] as const
export type BugReportMethod = (typeof BUG_REPORT_METHODS)[number]

/** What cleaning knows about this computer, so it can take its user out of the text. */
export interface CleanContext {
  /** The home folder, such as `C:\Users\ana` or `/home/ana`. */
  home?: string
  /** The account name. */
  username?: string
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Takes the person out of a text: secrets and tokens, the home folder and account name, other user folders, emails,
 * IP addresses and long hex strings that may be ids. What is left is the error as Mousse words it.
 */
export function cleanReportText(text: string, context: CleanContext = {}): string {
  let out = text
    .replace(/\b(?:Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '[secret]')
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/g, '[secret]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{10,}\b/g, '[secret]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{10,}\b/g, '[secret]')
    .replace(/\bxox[abposr]-[A-Za-z0-9-]{8,}\b/g, '[secret]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[secret]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[secret]')
    .replace(/([?&](?:api[_-]?key|key|token|secret|password|access_token|auth|sig|signature)=)[^&#\s]+/gi, '$1[secret]')
    .replace(/((?:api[_-]?key|token|secret|password|passwd|authorization)["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi, '$1[secret]')
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[secret]')
  if (context.home) {
    for (const form of new Set([context.home, context.home.replace(/\\/g, '/'), context.home.replace(/\//g, '\\')])) {
      if (form.length > 2) out = out.replace(new RegExp(escapeRegExp(form), 'gi'), '~')
    }
  }
  out = out
    .replace(/[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s"'`:]+/gi, '~')
    .replace(/\/(?:Users|home)\/[^/\s"'`:]+/g, '~')
    .replace(/\/root(?=\/|\b)/g, '~')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
    .replace(/\b[0-9a-f]{32,}\b/gi, '[id]')
  if (context.username && context.username.length >= 3) {
    out = out.replace(new RegExp(`\\b${escapeRegExp(context.username)}\\b`, 'gi'), '[user]')
  }
  return out
}

/** A stack with paths shortened to the app's own files and nothing of the person's. */
export function cleanStack(stack: string, context: CleanContext = {}): string {
  return cleanReportText(stack, context)
    .split('\n')
    .slice(0, 14)
    .map((line) => line
      // Keep the file name inside the app bundle: `…/out/renderer/assets/index-abc.js:12:3` → `index-abc.js:12:3`.
      .replace(/(?:file:\/\/\/?|app:\/\/[^/]*\/|https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/)?(?:[^\s()]*[\\/])?([^\\/\s()]+\.(?:m?js|tsx?|cjs))/g, '$1')
      .trimEnd())
    .join('\n')
}

/** The template of a message: numbers, ids, quoted names and paths taken out, so one bug reads the same each time. */
export function messageTemplate(message: string): string {
  return message
    .replace(/Reference:\s*\S+/gi, '')
    .replace(/(["'`“‘]).*?(["'`”’])/g, '…')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '#')
    .replace(/[~/\\][^\s]*/g, '…')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 160)
}

/** FNV-1a, 64 bits as hex: the same in a window and in the service, without async crypto. */
export function hash64(text: string): string {
  let h = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i))
    h = (h * prime) & 0xffffffffffffffffn
  }
  return h.toString(16).padStart(16, '0')
}

/** The top frames of a stack by function and file, without line numbers that move between builds. */
function stackFrames(stack: string | undefined): string[] {
  if (!stack) return []
  return stack.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at ') || /@/.test(line))
    .slice(0, 5)
    .map((line) => line.replace(/:\d+(?::\d+)?\)?$/, '').replace(/-[A-Za-z0-9_]{6,}\.js/, '.js').replace(/\(.*[\\/]/, '('))
}

/**
 * The bug's signature: its code, the top frames of its stack, and the template of its message. The same bug on
 * another computer or build gives the same signature; it is written into the issue so the next report finds it.
 */
export function bugSignature(source: Pick<BugReportSource, 'code' | 'stack' | 'message' | 'title' | 'kind'>): string {
  const frames = stackFrames(source.stack)
  const basis = [source.code ?? '', ...frames, frames.length ? '' : messageTemplate(source.message || source.title)].join('|')
  return `mousse-sig-${hash64(basis).slice(0, 12)}`
}

/** The reference at the end of a message (`… Reference: 1ecec6b5-…`), apart. */
export function splitReference(message: string): { text: string; reference?: string } {
  const match = /\s*Reference:\s*(\S+)\s*$/.exec(message)
  if (!match) return { text: message.trim() }
  return { text: message.slice(0, match.index).trim(), reference: match[1] }
}

/** The diagnostics section, exactly as it is added to a draft. */
export function diagnosticsSection(diagnostics: BugReportDiagnostics): string {
  const lines = [
    '### Diagnostics',
    '',
    `- App: ${diagnostics.app}`,
    `- OS: ${diagnostics.os}`,
    ...(diagnostics.runtime ? [`- Runtime: ${diagnostics.runtime}`] : []),
    ...(diagnostics.view ? [`- View: ${diagnostics.view}`] : [])
  ]
  if (diagnostics.logs.length) lines.push('', '<details><summary>Recent log lines</summary>', '', '```', ...diagnostics.logs, '```', '', '</details>')
  return lines.join('\n')
}

/**
 * The draft: a title, and a body with the error and (agents) what happened and the steps. No data of the person's;
 * `diagnostics` is added only when given (the person opted in).
 */
export function buildBugReportDraft(source: BugReportSource, diagnostics?: BugReportDiagnostics, context: CleanContext = {}): BugReportDraft {
  const clean = (text: string) => cleanReportText(text, context)
  const { text: message, reference: inlineReference } = splitReference(source.message)
  const reference = source.reference ?? inlineReference
  const title = clean(source.title || message.split('\n')[0] || 'Error').replace(/\s+/g, ' ').trim().slice(0, BUG_REPORT_TITLE_MAX)
  const signature = bugSignature(source)
  const body: string[] = []
  if (source.kind === 'agent') {
    body.push('### What happened', '', clean(message).slice(0, 6000))
    if (source.steps?.trim()) body.push('', '### Steps', '', clean(source.steps).slice(0, 4000))
  } else {
    body.push('### Error', '', '```', clean(message).slice(0, 4000) || '(no message)', '```')
  }
  const facts = [
    ...(source.code ? [`- Code: \`${source.code}\``] : []),
    ...(reference ? [`- Reference: \`${reference.slice(0, 64)}\``] : []),
    ...(source.surface ? [`- Shown in: ${source.surface}`] : []),
    `- Reported by: ${source.kind === 'agent' ? 'an agent, approved by the person' : 'the Report button'}`
  ]
  body.push('', ...facts)
  if (source.stack?.trim()) body.push('', '<details><summary>Stack</summary>', '', '```', cleanStack(source.stack, context), '```', '', '</details>')
  if (diagnostics) body.push('', diagnosticsSection(diagnostics))
  body.push('', `<!-- ${signature} -->`)
  return { title, body: body.join('\n').slice(0, BUG_REPORT_BODY_MAX), signature }
}

/**
 * The draft as filed: its body as the person left it, with the diagnostics section (when they ticked the box) before
 * the signature line, which is kept or put back.
 */
export function finalDraft(draft: BugReportDraft, edited: { title: string; body: string }, diagnostics?: BugReportDiagnostics): BugReportDraft {
  const marker = `<!-- ${draft.signature} -->`
  const base = edited.body.replace(marker, '').trimEnd()
  const body = [base, ...(diagnostics ? [diagnosticsSection(diagnostics)] : []), marker].join('\n\n')
  return { title: edited.title.trim(), body: body.slice(0, BUG_REPORT_BODY_MAX), signature: draft.signature }
}

/** A prefilled new-issue page, for when nothing here can file it. The body is cut to fit a URL. */
export function prefilledIssueUrl(draft: Pick<BugReportDraft, 'title' | 'body'>): string {
  const base = `${BUG_REPORT_ISSUES_URL}/new?title=${encodeURIComponent(draft.title)}&body=`
  let body = draft.body
  while (body.length > 0 && base.length + encodeURIComponent(body).length > PREFILLED_URL_MAX) body = body.slice(0, Math.floor(body.length * 0.8))
  return base + encodeURIComponent(body === draft.body ? body : `${body}\n\n(cut to fit)`)
}

const CLOSING_KEYWORD = '(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)'
const escapedRepository = escapeRegExp(BUG_REPORT_REPOSITORY)

/**
 * Whether a pull request's description closes issue `number` of the report repository the way GitHub reads it: a
 * closing keyword, then `#N`, `owner/repo#N` or the issue's URL. A plain mention (`Refs #N`) does not.
 */
export function closesIssue(body: string, number: number): boolean {
  const reference = `(?:#|${escapedRepository}#|https://github\\.com/${escapedRepository}/issues/)${number}(?!\\d)`
  return new RegExp(`\\b${CLOSING_KEYWORD}:?\\s+${reference}`, 'i').test(body)
}

/**
 * The reports an update fixes: fixed (closed as completed), not revoked, and closed by a pull request the update
 * brings. Nothing is matched on a mere mention.
 */
export function reportsFixedBy(reports: readonly FiledBugReportView[], pullRequests: readonly number[]): FiledBugReportView[] {
  if (!pullRequests.length) return []
  const brought = new Set(pullRequests)
  return reports.filter((report) => !report.revokedAt && report.state === 'closed' && report.stateReason !== 'not_planned' &&
    (report.closedBy ?? []).some((pr) => brought.has(pr)))
}
