import { classifyNavigationFailure, hostOf } from '../../../shared/browser/navigation'

/** A page a browser tab could not open, as Electron's `did-fail-load` reports it for the main frame. */
export interface BrowserLoadFailure {
  url: string
  /** Chromium's net error number (`-102`). */
  errorCode: number
  /** Chromium's net error name (`ERR_CONNECTION_REFUSED`). */
  errorDescription: string
}

/** What the tab's error page says: a title, one line naming the site, what to try, and Chromium's code for details. */
export interface BrowserLoadErrorView {
  title: string
  /** The site the line names in bold, when the address has one. */
  host?: string
  /** The rest of the line after the site (or the whole line when there is no site). */
  line: string
  tips: string[]
  /** `ERR_CONNECTION_REFUSED`. */
  code: string
}

/** Chromium's "aborted": a download, or another navigation replaced this one. No failure to show. */
const ERR_ABORTED = -3

/** The guest failed to open a page the person (or the agent) sees: anything but an aborted load. */
export function isShownLoadFailure(errorCode: number, isMainFrame: boolean): boolean {
  return isMainFrame && errorCode !== 0 && errorCode !== ERR_ABORTED
}

/**
 * A `<webview>` `loadURL` rejection for a page that failed to load ("ERR_CONNECTION_REFUSED (-102)
 * loading 'http://…'"). The tab's error page shows it, so it needs no notice of its own.
 */
export function isPageLoadRejection(error: unknown): boolean {
  const message = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : String(error ?? '')
  return /\bERR_[A-Z0-9_]+ \(-\d+\) loading\b/.test(message)
}

/** An address on this computer: a stopped development server is the usual reason it refuses. */
function isLocalHost(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '::1' || host === '0.0.0.0' || /^127\.\d+\.\d+\.\d+$/.test(host)
}

function portOf(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return parsed.port || (parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : undefined)
  } catch {
    return undefined
  }
}

/** What happened, after the site's name, for the codes people meet most; anything else "couldn't be opened". */
const UNREACHABLE_LINES: Record<string, string> = {
  ERR_CONNECTION_REFUSED: 'refused to connect.',
  ERR_NAME_NOT_RESOLVED: 'couldn’t be found. Its address may be misspelled.',
  ERR_NAME_RESOLUTION_FAILED: 'couldn’t be found. Its address may be misspelled.',
  ERR_CONNECTION_TIMED_OUT: 'took too long to respond.',
  ERR_TIMED_OUT: 'took too long to respond.',
  ERR_CONNECTION_RESET: 'closed the connection unexpectedly.',
  ERR_CONNECTION_CLOSED: 'closed the connection unexpectedly.',
  ERR_EMPTY_RESPONSE: 'didn’t send any data.',
  ERR_ADDRESS_UNREACHABLE: 'can’t be reached from this network.',
  ERR_TOO_MANY_REDIRECTS: 'redirected too many times.',
  ERR_SSL_PROTOCOL_ERROR: 'sent a response this browser can’t read securely.',
  ERR_HTTP_RESPONSE_CODE_FAILURE: 'answered with an error and no page.',
  ERR_INVALID_RESPONSE: 'sent a response this browser can’t read.'
}

/** The tab's error page for a load that failed: plain words first, Chromium's code last. */
export function browserLoadErrorView(failure: BrowserLoadFailure): BrowserLoadErrorView {
  const code = failure.errorDescription.replace(/^net::/, '') || `Error ${failure.errorCode}`
  const host = hostOf(failure.url) ?? undefined
  const outcome = classifyNavigationFailure(`net::${code}`)
  const problem = outcome.kind === 'problem' ? outcome.problem : { kind: 'unreachable' as const, code }
  const base = { code, ...(host ? { host } : {}) }
  // A line that names no site stands alone.
  const plain = { code }

  if (problem.kind === 'blocked') {
    return { ...base, title: 'This page was refused', line: host ? 'refused to show this page here.' : 'The site refused to show this page here.', tips: ['Open it in your usual browser'] }
  }
  if (problem.kind === 'browser-refused') {
    if (problem.reason === 'certificate') {
      return { ...base, title: 'This connection isn’t private', line: host ? 'has a certificate this browser doesn’t trust.' : 'The site’s certificate isn’t trusted.', tips: ['Check the address for typos', 'Check that this computer’s date and time are right'] }
    }
    if (problem.reason === 'unsafe-port') {
      const port = portOf(failure.url)
      return { ...plain, title: 'This address isn’t allowed', line: `Browsers refuse to open port ${port ?? 'this port'}.`, tips: ['Use the site’s usual port'] }
    }
    return { ...plain, title: 'This address isn’t allowed', line: 'This browser’s own rules refuse this address.', tips: ['Try another address'] }
  }

  if (code === 'ERR_INTERNET_DISCONNECTED') {
    return { ...plain, title: 'You’re offline', line: 'This computer isn’t connected to the internet.', tips: ['Check your Wi‑Fi or network cable', 'Reload once you’re back online'] }
  }
  const line = UNREACHABLE_LINES[code] ?? 'couldn’t be opened.'
  if (host && isLocalHost(host)) {
    const port = portOf(failure.url)
    return {
      ...base,
      title: 'This site can’t be reached',
      line,
      tips: [port ? `Check that the server on port ${port} is running` : 'Check that the server is running', 'Check the port in the address']
    }
  }
  return {
    ...base,
    title: 'This site can’t be reached',
    line: host ? line : `The page ${line}`,
    tips: code.startsWith('ERR_NAME_') ? ['Check the address for typos', 'Check your internet connection'] : ['Check your internet connection', 'Try again in a moment']
  }
}
