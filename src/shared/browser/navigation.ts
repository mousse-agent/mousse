/**
 * What becomes of a page a managed browser loads, in a few plain classes shared by every user of
 * the browser worker (bots, thread agents, group chats) and by the person watching a bot's browser.
 *
 * - A navigation is **done** once its page has committed and its document is ready. Waiting longer
 *   for every image and script (`load`) is reported as **still loading**, never as a failure: the
 *   agent can carry on or wait (`browser_wait` with `document-ready`).
 * - A navigation that **fails** has one of five classes, each with what to do next: the site can't
 *   be reached, the site refused this browser, the page is nothing but a check or a wall a person
 *   must get past (or an HTTP sign-in the browser can't show), the browser refused the address
 *   itself (an unsafe port, its own rules, a certificate it does not trust), or the browser can't
 *   start. Chromium's own code (`net::ERR_…`) or the HTTP status is kept for details.
 * - A page that **opened** is never a failure because of what is on it. What it shows that the agent
 *   may deal with comes as notes: a sign-in form, a cookie banner, a human check that is part of
 *   the page, a "not found" or a server error, a request to slow down.
 *
 * Browser-safe.
 */

export type BrowserProblemKind = 'unreachable' | 'blocked' | 'needs-you' | 'browser-refused' | 'cannot-start'

/** Why a site needs a person: a human check or consent wall that is the whole page, or an HTTP sign-in. */
export type BrowserNeedsYouReason = 'sign-in' | 'consent' | 'human-check'

/** Why the browser refused an address itself. */
export type BrowserRefusedReason = 'unsafe-port' | 'browser-rules' | 'certificate'

export interface BrowserProblem {
  kind: BrowserProblemKind
  /** For `needs-you`: what the person is needed for; for `browser-refused`: why the browser would not go. */
  reason?: BrowserNeedsYouReason | BrowserRefusedReason
  /** Chromium's own code (`net::ERR_NAME_NOT_RESOLVED`) or the HTTP status (`HTTP 403`): details only. */
  code?: string
  /** The site, for the plain line. */
  host?: string
  /** For `cannot-start`: why, in plain words. */
  cause?: string
}

/** What a page that opened shows that the agent may deal with: never a failure. */
export type BrowserPageNote =
  | { kind: 'sign-in-form' }
  | { kind: 'cookie-banner' }
  /** A human check that is part of the page (a form's check), not the whole page. */
  | { kind: 'human-check' }
  /** The site answered with an error status and a page (404, 410, 429, 5xx): it can be read. */
  | { kind: 'http-status'; status: number; retryAfterSeconds?: number }

/** A navigation's outcome. */
export interface BrowserNavigation {
  /** Where the tab is: the address it went to, or the one it really ended on (`replaced`). */
  url: string
  /**
   * `ready`: the page committed, its document is ready and it loaded. `loading`: it committed (or
   * the site has not answered yet) and is still loading: not a failure. `failed`: see `problem`.
   */
  state: 'ready' | 'loading' | 'failed'
  /** Why it failed (only when `failed`). */
  problem?: BrowserProblem
  /** What the page that opened shows that the agent may deal with. */
  notes?: BrowserPageNote[]
  /** The address started a download instead of opening a page: the tab stays where it was. */
  download?: { name: string }
  /** Another navigation (the page's own, or a newer one) replaced the one asked for: `url` is where the tab is. */
  replaced?: { asked: string }
}

/** The error code of a browser call that failed for one of these reasons. */
export const BROWSER_PROBLEM_CODES = {
  unreachable: 'site_unreachable',
  blocked: 'site_blocked',
  'needs-you': 'needs_person',
  'browser-refused': 'browser_refused',
  'cannot-start': 'browser_cannot_start'
} as const satisfies Record<BrowserProblemKind, string>

export type BrowserProblemCode = (typeof BROWSER_PROBLEM_CODES)[BrowserProblemKind]

const KIND_OF_CODE = Object.fromEntries(Object.entries(BROWSER_PROBLEM_CODES).map(([kind, code]) => [code, kind])) as Record<BrowserProblemCode, BrowserProblemKind>

/** The class of a browser error code, when it is one of these. */
export function browserProblemKindOfCode(code: string | undefined): BrowserProblemKind | undefined {
  return code ? KIND_OF_CODE[code as BrowserProblemCode] : undefined
}

/** The browser refusing an address by its own rules (an extension, a policy, an address it never opens). */
const BROWSER_RULES = /^net::ERR_(BLOCKED_BY_CLIENT|BLOCKED_BY_ADMINISTRATOR|NETWORK_ACCESS_DENIED|ACCESS_DENIED|DISALLOWED_URL_SCHEME|BLOCKED_BY_PRIVATE_NETWORK_ACCESS_CHECKS|BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS)$/
/** A secure connection the browser does not trust: never something to get around. */
const CERTIFICATE_ERRORS = /^net::ERR_(CERT_[A-Z_]+|INSECURE_RESPONSE|SSL_PINNED_KEY_NOT_IN_CERT_CHAIN|BAD_SSL_CLIENT_AUTH_CERT)$/
/** The site's own answer refusing the page (its headers). */
const SITE_REFUSALS = /^net::ERR_(BLOCKED_BY_RESPONSE|BLOCKED_BY_CSP)$/

/** The main document's answer, when the site gave one. */
export interface BrowserNavigationResponse { status: number; retryAfterSeconds?: number }

/** How a navigation Chromium reported as failed went, in a class or as an opened page with a note. */
export type BrowserNavigationFailure =
  | { kind: 'aborted' }
  | { kind: 'problem'; problem: Omit<BrowserProblem, 'host'> }
  | { kind: 'status'; note: Extract<BrowserPageNote, { kind: 'http-status' }> }

/**
 * The class of Chromium's navigation error (`Page.navigate`'s `errorText`), with the site's answer
 * when it gave one. `net::ERR_ABORTED` is no failure (a download, or another navigation replaced
 * it). An error status with an empty body (`ERR_HTTP_RESPONSE_CODE_FAILURE`) is the site's answer:
 * 401 a sign-in the browser can't show, 403 and 451 a refusal, and 404, 410, 429 and 5xx a page
 * the tab shows (Chromium's own) with a note. The browser refusing the address itself (an unsafe
 * port, its own rules, a certificate it does not trust) is `browser-refused`. Everything else is a
 * site that can't be reached.
 */
export function classifyNavigationFailure(errorText: string, response?: BrowserNavigationResponse): BrowserNavigationFailure {
  const code = errorText.trim()
  if (code === 'net::ERR_ABORTED') return { kind: 'aborted' }
  if (code === 'net::ERR_HTTP_RESPONSE_CODE_FAILURE' && response) {
    const status = response.status
    if (status === 401 || status === 407) return { kind: 'problem', problem: { kind: 'needs-you', reason: 'sign-in', code: `HTTP ${status}` } }
    if (status === 403 || status === 451) return { kind: 'problem', problem: { kind: 'blocked', code: `HTTP ${status}` } }
    return { kind: 'status', note: { kind: 'http-status', status, ...(response.retryAfterSeconds !== undefined ? { retryAfterSeconds: response.retryAfterSeconds } : {}) } }
  }
  if (code === 'net::ERR_UNSAFE_PORT') return { kind: 'problem', problem: { kind: 'browser-refused', reason: 'unsafe-port', code } }
  if (BROWSER_RULES.test(code)) return { kind: 'problem', problem: { kind: 'browser-refused', reason: 'browser-rules', code } }
  if (CERTIFICATE_ERRORS.test(code)) return { kind: 'problem', problem: { kind: 'browser-refused', reason: 'certificate', code } }
  if (SITE_REFUSALS.test(code)) return { kind: 'problem', problem: { kind: 'blocked', code } }
  return { kind: 'problem', problem: { kind: 'unreachable', code } }
}

/** `Retry-After` in seconds (a number of seconds, or a date), when it names a wait. */
export function retryAfterSeconds(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Math.min(86_400, Number(trimmed))
  const at = Date.parse(trimmed)
  return Number.isFinite(at) ? Math.max(0, Math.min(86_400, Math.round((at - now) / 1000))) : undefined
}

/**
 * What a page that opened shows, read where its scripts can't reach (`readPageSigns`). Only what is
 * visible counts, and only what covers the page can make it a failure.
 */
export interface BrowserPageSigns {
  status?: number
  title?: string
  url?: string
  /**
   * A human check: `part` of the page (a widget a form uses, a visible box), or the `page` itself
   * (an interstitial with almost nothing else, or an overlay over most of the viewport that the
   * page behind can't be reached through). An invisible badge is none.
   */
  humanCheck?: 'part' | 'page'
  /** A visible password field. */
  signInForm?: boolean
  /** A consent dialog: a `banner` the page can be used beside, or a `wall` that covers and blocks it. */
  consent?: 'banner' | 'wall'
  /** The page runs scripts of its own, so a check may still appear (a challenge page builds it after it loads). */
  scripted?: boolean
}

/**
 * What a page that opened is: a failure only when it is nothing but a human check or a consent
 * wall, whatever status it came with (a person can get past it: never a refusal), or the site
 * refused it with nothing to get past (403, 451), or asks for an HTTP sign-in (401 without a form). Else
 * notes: a sign-in form, a cookie banner, a human check that is part of the page, an error status
 * the page can be read with (404, 410, 429, 5xx). The page's title and classes alone decide nothing.
 */
export function classifyOpenedPage(signs: BrowserPageSigns, response?: BrowserNavigationResponse): { problem?: BrowserProblem; notes: BrowserPageNote[] } {
  const status = response?.status ?? signs.status ?? 0
  const host = hostOf(signs.url)
  const fail = (problem: BrowserProblem) => ({ problem: { ...problem, ...(status >= 400 ? { code: `HTTP ${status}` } : {}), ...(host ? { host } : {}) }, notes: [] })
  if (signs.humanCheck === 'page') return fail({ kind: 'needs-you', reason: 'human-check' })
  if (signs.consent === 'wall') return fail({ kind: 'needs-you', reason: 'consent' })
  if (status === 403 || status === 451) return fail({ kind: 'blocked' })
  if ((status === 401 || status === 407) && !signs.signInForm) return fail({ kind: 'needs-you', reason: 'sign-in' })
  const notes: BrowserPageNote[] = []
  if (signs.signInForm) notes.push({ kind: 'sign-in-form' })
  if (signs.consent === 'banner') notes.push({ kind: 'cookie-banner' })
  if (signs.humanCheck === 'part') notes.push({ kind: 'human-check' })
  if (status === 404 || status === 410 || status === 429 || status >= 500) {
    const wait = response?.retryAfterSeconds
    notes.push({ kind: 'http-status', status, ...(wait !== undefined ? { retryAfterSeconds: wait } : {}) })
  }
  return { notes }
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
 * The problem in plain words for an agent: what happened, then what to do next. Only a page that is
 * nothing but a human check or consent wall, and a site that refused this browser, are never tried
 * again: trying won't change them.
 */
export function browserProblemForAgent(problem: BrowserProblem, reader: BrowserNoteReader = 'agent'): string {
  const site = problem.host ?? 'The site'
  const details = problem.code ? ` (${problem.code})` : ''
  switch (problem.kind) {
    case 'unreachable':
      return `Can't reach ${problem.host ?? 'the site'}${details}. Check the address; if it is right, the site or the connection is down: try once more later, or carry on without it.`
    case 'blocked':
      return `${site} refused this browser${details}. Don't retry it: try another site, or ask the person to open it.`
    case 'needs-you': {
      if (problem.reason === 'sign-in') return `${site} asks for a sign-in this browser can't show${details}. Ask the person to open it, or carry on without it.`
      const what = problem.reason === 'consent' ? 'a consent wall' : 'a human check'
      // A person can get past it (whatever status the site answered with): it is theirs to do, never a refusal.
      if (reader === 'bot') return `${site} shows ${what} that covers the page${details}. A person can get past it: ask your owner to take over your browser and do it (say so in your reply), then carry on. Don't retry it or try to get around it yourself.`
      return `${site} shows ${what} that covers the page${details}. A person can get past it: don't retry it or try to get around it, ask the person to (browser_request_human, or say so in your reply), then carry on.`
    }
    case 'browser-refused':
      if (problem.reason === 'certificate') return `${site}'s certificate is not trusted${details}, so this browser won't open it. Check the address; don't try to get around it. If it is the address you need, say so.`
      if (problem.reason === 'unsafe-port') return `This browser won't open that address: its port is one browsers refuse${details}. Use the address's usual port, or another address.`
      return `This browser's own rules refuse that address${details}. Use another address, or say so.`
    case 'cannot-start':
      return `The browser can't start${problem.cause ? `: ${problem.cause}` : ''}. Try again later; if it keeps failing, say so.`
  }
}

/** Who reads a page's notes: a bot (it has no sign-in of its own: signing in is its owner's) or another agent. */
export type BrowserNoteReader = 'bot' | 'agent'

/** A page's note in plain words for an agent: what the page shows, and what it may do about it. Never an order to stop. */
export function browserNoteForAgent(note: BrowserPageNote, reader: BrowserNoteReader = 'agent'): string {
  switch (note.kind) {
    case 'sign-in-form':
      return reader === 'bot'
        ? 'This page shows a sign-in form. You have no sign-in of your own: ask your owner to sign in here (they can take over your browser), then carry on.'
        : 'This page shows a sign-in form. Fill it if you have what it needs (a test account or details the person gave you for this site); if you don\'t, ask the person.'
    case 'cookie-banner':
      return 'This page shows a cookie banner. You may dismiss it (choose what the person would want, or close it) and use the page.'
    case 'human-check':
      return 'This page shows a human check as part of it. The rest of the page can be used; if you need what the check guards, ask the person to complete it.'
    case 'http-status':
      if (note.status === 429) return `The site asked to slow down (HTTP 429)${note.retryAfterSeconds !== undefined ? `: wait ${note.retryAfterSeconds} s` : ': wait a while'} before loading it again.`
      if (note.status === 404 || note.status === 410) return `The page was not found (HTTP ${note.status}). It is open and can be read; check the address, or find the page from the site.`
      return `The site had an error (HTTP ${note.status}). The page is open and can be read; you may try once more later.`
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
      return { line: `${site} refused this browser`, detail: `The site refused this browser${code}. Trying again won't help.` }
    case 'needs-you':
      return { line: `${site} needs you: ${NEEDS[(problem.reason as BrowserNeedsYouReason | undefined) ?? 'sign-in']}`, detail: `Take over to do it${code}.` }
    case 'browser-refused':
      if (problem.reason === 'certificate') return { line: `${site}'s certificate isn't trusted`, detail: `The browser won't open it${code}.` }
      return { line: 'The browser won\'t open that address', detail: problem.reason === 'unsafe-port' ? `Its port is one browsers refuse${code}.` : `Its own rules refuse it${code}.` }
    case 'cannot-start':
      return { line: 'The browser can\'t start', detail: problem.cause ?? 'Try again later.' }
  }
}

/**
 * What the person watching a bot's browser is told of a page that opened: a sign-in form, or a
 * human check that is part of the page, is theirs to do for the bot. A cookie banner or an error
 * status they see in the picture.
 */
export function browserNoteForPerson(notes: readonly BrowserPageNote[] | undefined, host: string | undefined): BrowserProblem | undefined {
  const signIn = notes?.some((note) => note.kind === 'sign-in-form')
  const check = notes?.some((note) => note.kind === 'human-check')
  if (!signIn && !check) return undefined
  return { kind: 'needs-you', reason: signIn ? 'sign-in' : 'human-check', ...(host ? { host } : {}) }
}

/** The plain message of an error for a navigation that failed (the worker's error message). */
export function browserProblemMessage(problem: BrowserProblem): string {
  return browserProblemForAgent(problem)
}
