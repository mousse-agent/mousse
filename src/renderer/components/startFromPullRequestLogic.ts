import { parsePullRequestReference, type PullRequestListItem, type PullRequestSummary } from '../../shared/pullRequests'
import { ipcErrorLine } from '../lib/errorText'

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
