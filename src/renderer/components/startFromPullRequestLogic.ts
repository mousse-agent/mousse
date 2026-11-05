import { parsePullRequestReference, type PullRequestListItem, type PullRequestSummary } from '../../shared/pullRequests'
import { ipcErrorLine } from '../lib/errorText'
import { GITHUB_SIGN_IN_COMMAND, isGitHubSignedOutError } from '../lib/githubSignIn'

/** The open pull requests whose number, title, author or branch contains every word of the query. */
export function filterPullRequests(items: readonly PullRequestListItem[], query: string): PullRequestListItem[] {
  const words = query.trim().toLowerCase().replace(/^#/, '').split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...items]
  return items.filter((item) => {
    const haystack = `${item.number} ${item.title} ${item.author} ${item.headRefName}`.toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}

/**
 * What the dialog starts from: a pull request typed as a number, URL or `gh pr checkout` command, else the one picked
 * in the list. Typed text that is not a reference only narrows the list.
 */
export function startReference(query: string, picked: number | null): string | null {
  const typed = query.trim()
  if (typed && parsePullRequestReference(typed)) return typed
  return picked !== null ? String(picked) : null
}

/** The daemon's refusal code, when the failure carries one. */
export function startErrorCode(error: unknown): string | null {
  return error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : null
}

export function startErrorMessage(error: unknown): string {
  const line = ipcErrorLine(error)
  return !line || line === '[object Object]' ? 'The thread could not be started.' : line
}

/** What the dialog says in place of the list, and of a typed pull request, while GitHub CLI is signed out. */
export const SIGNED_OUT_LIST = 'Sign in to GitHub CLI to search pull requests'
export const SIGNED_OUT_READ = 'Sign in to GitHub CLI to read this pull request'

/** The tooltip of a signed-out line: the command, and where to run it when that is another computer. */
export function signInHint(computerName: string | null): string {
  return `Run ${GITHUB_SIGN_IN_COMMAND} in a terminal${computerName ? ` on ${computerName}` : ''}`
}

/** A failed read as the dialog keeps it: signed out (said in one muted line, without the CLI's text), or the failure's own message. */
export function readFailure(error: unknown): { signedOut: true } | { signedOut: false; message: string } {
  return isGitHubSignedOutError(error) ? { signedOut: true } : { signedOut: false, message: startErrorMessage(error) }
}

export interface StartButtonModel {
  label: string
  /** The start passes these because the person has seen the pull request's state or the thread that exists. */
  allowClosed: boolean
  allowDuplicate: boolean
}

export function startButtonModel(summary: PullRequestSummary | null, threads: ReadonlyArray<{ id: string; name: string }>, starting: boolean): StartButtonModel {
  const allowClosed = summary !== null && summary.state !== 'open'
  const allowDuplicate = threads.length > 0
  if (starting) return { label: 'Starting…', allowClosed, allowDuplicate }
  return { label: allowDuplicate ? 'Start another thread' : allowClosed ? 'Start anyway' : 'Start thread', allowClosed, allowDuplicate }
}

/** The query is a pull request reference (a URL, number or `gh pr checkout` command), not words that narrow the list. */
export function isTypedReference(query: string): boolean {
  const typed = query.trim()
  return typed !== '' && parsePullRequestReference(typed) !== null
}

/**
 * What Enter does in the field. A typed reference starts at once, as before. Words only narrow the list, so Enter first
 * picks the highlighted result and starts only once that result is the picked one: filtering and pressing Enter never
 * launches a thread the person has not seen named.
 */
export function enterAction(input: { query: string; active: number | null; picked: number | null }): 'start' | 'pick' | 'none' {
  if (isTypedReference(input.query)) return 'start'
  if (input.active !== null && input.active !== input.picked) return 'pick'
  return input.picked !== null ? 'start' : 'none'
}

/** The result a key moves to among `count` results: arrows wrap, Home and End go to the ends. Null for any other key. */
export function rovingIndex(current: number, key: string, count: number): number | null {
  if (count === 0) return null
  switch (key) {
    case 'ArrowDown':
      return (current + 1) % count
    case 'ArrowUp':
      return (current - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}
