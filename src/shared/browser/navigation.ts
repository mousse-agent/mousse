/**
 * What becomes of a page a managed browser loads, in a few plain classes shared by every user of
 * the browser worker (bots, thread agents, group chats) and by the person watching a bot's browser.
 *
 * - A navigation is **done** once its page has committed and its document is ready. Waiting longer
 *   for every image and script (`load`) is reported as **still loading**, never as a failure: the
 *   agent can carry on or wait (`browser_wait` with `document-ready`).
 * - A navigation that **fails** has one of four classes, each with what to do next: the site can't
 *   be reached, the site blocked this browser, the site needs a person (a sign-in, a consent choice,
 *   a human check), or the browser can't start. Chromium's own code (`net::ERR_…`) or the HTTP
 *   status is kept for details, never in the main line.
 *
 * Browser-safe.
 */

export type BrowserProblemKind = 'unreachable' | 'blocked' | 'needs-you' | 'cannot-start'

/** Why a site needs a person. */
export type BrowserNeedsYouReason = 'sign-in' | 'consent' | 'human-check'

export interface BrowserProblem {
  kind: BrowserProblemKind
  /** For `needs-you`: what the person is needed for. */
  reason?: BrowserNeedsYouReason
  /** Chromium's own code (`net::ERR_NAME_NOT_RESOLVED`) or the HTTP status (`HTTP 403`): details only. */
  code?: string
  /** The site, for the plain line. */
  host?: string
  /** For `cannot-start`: why, in plain words. */
  cause?: string
}

/** A navigation's outcome. */
export interface BrowserNavigation {
  /** The address it went to. */
  url: string
  /**
   * `ready`: the page committed, its document is ready and it loaded. `loading`: it committed (or
   * the site has not answered yet) and is still loading: not a failure. `failed`: see `problem`.
   */
  state: 'ready' | 'loading' | 'failed'
  /** Why it failed, or what a page that opened needs (a sign-in page is `ready` with a `needs-you` problem). */
  problem?: BrowserProblem
}

/** The error code of a browser call that failed for one of these reasons. */
export const BROWSER_PROBLEM_CODES = {
  unreachable: 'site_unreachable',
  blocked: 'site_blocked',
  'needs-you': 'needs_person',
  'cannot-start': 'browser_cannot_start'
} as const satisfies Record<BrowserProblemKind, string>

export type BrowserProblemCode = (typeof BROWSER_PROBLEM_CODES)[BrowserProblemKind]

const KIND_OF_CODE = Object.fromEntries(Object.entries(BROWSER_PROBLEM_CODES).map(([kind, code]) => [code, kind])) as Record<BrowserProblemCode, BrowserProblemKind>

/** The class of a browser error code, when it is one of these. */
export function browserProblemKindOfCode(code: string | undefined): BrowserProblemKind | undefined {
  return code ? KIND_OF_CODE[code as BrowserProblemCode] : undefined
}

/** Chromium refusing to load something for this browser: the site's or the browser's policy, not the network. */
const BLOCKED_ERRORS = /^net::ERR_(BLOCKED_BY_[A-Z_]+|ACCESS_DENIED|UNSAFE_PORT|DISALLOWED_URL_SCHEME|NETWORK_ACCESS_DENIED|INSECURE_RESPONSE|BLOCKED_BY_PRIVATE_NETWORK_ACCESS_CHECKS)$/

/**
 * The class of Chromium's navigation error (`Page.navigate`'s `errorText`). Everything that is not
 * the site or the browser refusing it is a site that can't be reached: no such name, no connection,
 * refused, reset, timed out, a broken secure connection or certificate, an empty or broken answer,
 * too many redirects. `net::ERR_ABORTED` is no failure at all (a download, or a newer navigation).
 */
export function classifyNavigationError(errorText: string): BrowserProblemKind | undefined {
  const code = errorText.trim()
  if (code === 'net::ERR_ABORTED') return undefined
  return BLOCKED_ERRORS.test(code) ? 'blocked' : 'unreachable'
}

/** What a page that opened shows of a refusal or of needing a person: its HTTP status and a few plain marks. */
export interface BrowserPageSigns {
  status?: number
  title?: string
  url?: string
  /** A human check on the page (Cloudflare, reCAPTCHA, hCaptcha). */
  humanCheck?: boolean
  /** A password field on the page. */
  password?: boolean
  /** A consent wall covering the page (a consent site, or a known consent dialog). */
  consent?: boolean
}

const SIGN_IN_WORDS = /\b(log ?in|sign ?in|signin|login|auth|account|session)\b/i

/**
 * What a page that opened needs, from its status and marks: a human check, a sign-in or a consent
 * choice (`needs-you`), or nothing; a refusal (`blocked`: 403, 429, 451). Only a hint: the page did open.
 */
export function classifyOpenedPage(signs: BrowserPageSigns): BrowserProblem | undefined {
  const status = signs.status ?? 0
  const code = status >= 400 ? `HTTP ${status}` : undefined
  const host = hostOf(signs.url)
  const withHost = <T extends BrowserProblem>(problem: T): T => ({ ...problem, ...(code ? { code } : {}), ...(host ? { host } : {}) })
  if (signs.humanCheck || /^just a moment\b/i.test(signs.title ?? '')) return withHost({ kind: 'needs-you', reason: 'human-check' })
  if (status === 401 || (signs.password && (SIGN_IN_WORDS.test(signs.url ?? '') || SIGN_IN_WORDS.test(signs.title ?? '')))) return withHost({ kind: 'needs-you', reason: 'sign-in' })
  if (signs.consent) return withHost({ kind: 'needs-you', reason: 'consent' })
  if (status === 403 || status === 429 || status === 451) return withHost({ kind: 'blocked' })
  return undefined
}

export function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    return host || undefined
  } catch {
    return undefined
  }
}

const NEEDS = { 'sign-in': 'a sign-in', consent: 'a consent choice', 'human-check': 'a human check' } as const

/**
 * The problem in plain words for an agent: what happened, then what to do next. Never retried in a
 * loop: a blocked site or one that needs a person won't change by trying again.
 */
export function browserProblemForAgent(problem: BrowserProblem): string {
  const site = problem.host ?? 'The site'
  const details = problem.code ? ` (${problem.code})` : ''
  switch (problem.kind) {
    case 'unreachable':
      return `Can't reach ${problem.host ?? 'the site'}${details}. Check the address; if it is right, the site or the connection is down: try once more later, or carry on without it.`
    case 'blocked':
      return `${site} blocked this browser${details}. Don't retry it: try another site, or ask the person to open it.`
    case 'needs-you':
      return `${site} needs a person: ${NEEDS[problem.reason ?? 'sign-in']}${details}. Don't retry it or work around it: ask the person to do it (browser_request_human, or say so in your reply), then carry on.`
    case 'cannot-start':
      return `The browser can't start${problem.cause ? `: ${problem.cause}` : ''}. Try again later; if it keeps failing, say so.`
  }
}

/** The problem for the person watching: one short line, and the details for its tooltip. */
export function browserProblemForPerson(problem: BrowserProblem): { line: string; detail: string } {
  const site = problem.host ?? 'The site'
  const code = problem.code ? ` (${problem.code})` : ''
  switch (problem.kind) {
    case 'unreachable':
      return { line: `Can't reach ${problem.host ?? 'the site'}`, detail: `Check the address, or try again later${code}.` }
    case 'blocked':
      return { line: `${site} blocked this browser`, detail: `The site refused this browser${code}. Trying again won't help.` }
    case 'needs-you':
      return { line: `${site} needs you: ${NEEDS[problem.reason ?? 'sign-in']}`, detail: `Take over to do it${code}.` }
    case 'cannot-start':
      return { line: 'The browser can\'t start', detail: problem.cause ?? 'Try again later.' }
  }
}

/** The plain message of an error for a navigation that failed (the worker's error message). */
export function browserProblemMessage(problem: BrowserProblem): string {
  return browserProblemForAgent(problem)
}
