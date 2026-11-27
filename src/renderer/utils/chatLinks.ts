import { parseChatReference, parseMousseFileLink, type ChatReference } from '../../shared/chatReferences'
import { parsePullRequestReference, type PullRequestIdentity } from '../../shared/pullRequests'
import { useAppStore } from '../stores/appStore'
import { openViewedPullRequest } from '../stores/pullRequestStore'
import { visibleThreads } from '../../shared/threadLineage'
import { parseThreadLink } from '../../shared/threadLink'
import { isQualifiedId } from '../../shared/threadRef'
import { selectOrSettle, selectThread } from '../lib/threadActions'
import { showToast } from '../components/ui/Toast'

const UNSAFE_SCHEME = /^(?:javascript|data|vbscript|blob):/i

export type RoutedLink =
  | { kind: 'file'; path: string; line?: number; column?: number }
  | { kind: 'web'; url: string }
  | { kind: 'thread'; threadId: string }
  | { kind: 'relative-file'; path: string; line?: number; column?: number }
  | { kind: 'reject' }

/** Parse links without treating Windows drive letters as URL schemes. */
export function classifyLink(href: string): RoutedLink {
  const value = href.trim()
  if (!value || UNSAFE_SCHEME.test(value)) return { kind: 'reject' }
  const mousseFile = parseMousseFileLink(value)
  if (mousseFile) return { kind: 'file', ...mousseFile }
  const threadId = parseThreadLink(value)
  if (threadId) return { kind: 'thread', threadId }
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'reject' }
      return { kind: 'web', url: url.toString() }
    } catch { return { kind: 'reject' } }
  }
  if (/^(?:mailto|tel):/i.test(value)) return { kind: 'reject' }
  // A file URL names a path like any other, but only one on this computer: another host would be reached when opened.
  const target = /^file:/i.test(value) ? fileUrlPath(value) : value
  if (target === null) return { kind: 'reject' }
  return classifyPath(target.replace(/%5c/gi, '\\'))
}

/** The path of a `file:` URL with no host or `localhost` (`file:///C:/a` is `C:/a`); null for any other host. */
function fileUrlPath(value: string): string | null {
  const match = value.match(/^file:\/\/([^/\\]*)([/\\].*)$/i)
  if (!match || (match[1] && match[1].toLowerCase() !== 'localhost')) return null
  return /^[/\\][a-zA-Z]:[/\\]/.test(match[2]) ? match[2].slice(1) : match[2]
}

/** A path with an optional line, column, or line range (`:12`, `:12:3`, `:12-20`, `#L12`, `#L12C3`, `#L12-L20`). Markdown hands a backslash over as `%5C`, which the caller turns back. */
function classifyPath(value: string): RoutedLink {
  // Agent markdown commonly emits path/to/file.ts#L12-L20, path/to/file.ts:12-20, or C:\repo\file.ts:12:3.
  const windows = value.match(/^([a-zA-Z]:[\\/].*?)(?::(\d+)(?::(\d+))?(?:-\d+(?::\d+)?)?|#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?)?$/i)
  const ordinary = value.match(/^(.+?)(?::(\d+)(?::(\d+))?(?:-\d+(?::\d+)?)?|#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?)?$/i)
  const match = windows ?? ordinary
  if (!match) return { kind: 'reject' }
  const path = match[1]
  if (!path || path.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-zA-Z]:[\\/]/.test(path)) return { kind: 'reject' }
  const line = Number(match[4] ?? match[2]) || undefined
  const column = Number(match[5] ?? match[3]) || undefined
  try {
    return { kind: 'relative-file', path: decodeURIComponent(path), line, column }
  } catch {
    return { kind: 'reject' }
  }
}

/** Top-level MIME types so two-segment dotted types (`application/vnd.ms-excel`) stay plain code. */
const MIME_PREFIX = /^(?:application|audio|font|image|message|model|multipart|text|video)\//i
/** Bare hostnames (`example.com/index.html`) that look like relative paths without a scheme. */
const HOST_PREFIX = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|app|ai|gov|edu|co|me|gg|xyz)$/i

/**
 * Returns the file target when an inline code span is a single file path (with optional line, column, or range),
 * such as Claude or Codex emits (`src/app.ts:42`, `.github/workflows/ci.yml`, `C:\repo\a.ts:10-20`). Returns null for
 * commands, URLs, globs, MIME types, bare filenames without a directory, and prose slashes (`and/or`).
 */
export function inlineCodeFileHref(raw: string): string | null {
  const value = raw.trim()
  if (!value || value.length > 320 || /[\s<>"|*?{}[\]()$`'`;]/.test(value)) return null
  if (/^(?:https?|ftp|mailto|tel|file|data|javascript|vbscript|blob|mousse|mousse-file):/i.test(value)) return null
  if (value.startsWith('//') || value.startsWith('~') || value.startsWith('@') || value.startsWith('-')) return null
  const route = classifyLink(value)
  if (route.kind !== 'relative-file') return null
  const filePath = route.path
  if (!/[\\/]/.test(filePath) || /[\\/]$/.test(filePath)) return null
  if (!/^[a-zA-Z]:[\\/]/.test(filePath) && !filePath.startsWith('/') && !filePath.startsWith('./') && !filePath.startsWith('../')) {
    const segments = filePath.split('/')
    if (segments.length === 2 && MIME_PREFIX.test(filePath)) return null
    if (HOST_PREFIX.test(segments[0]!)) return null
  }
  const base = filePath.split(/[\\/]/).pop() ?? ''
  if (!/^(?:[^./\\][^/\\]*|\.[^./\\][^/\\]*)\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(base)) return null
  return value
}

/** Parses a GitHub pull request URL (`https://github.com/<owner>/<repo>/pull/<number>[/...]`); null for other URLs. */
export function parseGitHubPullRequestUrl(href: string): PullRequestIdentity | null {
  if (!/^https?:\/\//i.test(href.trim())) return null
  const parsed = parsePullRequestReference(href)
  if (!parsed || !parsed.host || !parsed.nameWithOwner) return null
  if (parsed.host !== 'github.com') return null
  return { host: parsed.host, nameWithOwner: parsed.nameWithOwner, number: parsed.number }
}

export function routeLink(href: string, context?: { threadId?: string; projectId?: string }): boolean {
  const route = classifyLink(href)
  if (route.kind === 'reject') return false
  if (route.kind === 'thread') {
    openLinkedThread(route.threadId)
    return true
  }
  if (route.kind === 'web') {
    const store = useAppStore.getState()
    // In Chats (a bot's or an agent chat) the Browser or Pull Request panel would swap the chat for the Projects
    // workspace, so a web link opens in the person's own browser and the chat stays on screen.
    if (store.sidebarMode === 'chats') {
      window.open(route.url, '_blank', 'noopener,noreferrer')
      return true
    }
    const pullRequest = parseGitHubPullRequestUrl(route.url)
    if (pullRequest && typeof window !== 'undefined' && typeof window.mousse?.pullRequests?.view === 'function') {
      openViewedPullRequest(pullRequest, context?.threadId ?? store.activeThreadId)
      store.openSurfaceKind('pullRequest')
      return true
    }
    const tabId = store.addBrowserTab(store.activeThreadId)
    store.updateBrowserTab(tabId, { url: route.url, title: route.url })
    store.setActiveBrowserTab(store.activeThreadId, tabId)
    store.openSurfaceKind('browser')
    return true
  }
  openFileInPanel({
    path: route.path,
    line: route.line,
    column: route.column,
    threadId: context?.threadId,
    projectId: context?.projectId
  })
  return true
}

/**
 * Opens the thread a `mousse://thread/<id>` link names, in the app (out of Chats or a bot's chat). A thread this
 * window does not list, such as a deleted one, gets a short toast instead.
 */
export function openLinkedThread(threadId: string): void {
  const store = useAppStore.getState()
  const missing = (): void => { showToast({ key: 'thread-link-missing', message: 'That thread is no longer here.' }) }
  if (!store.threads.some((thread) => thread.id === threadId)) return missing()
  // The sidebar lands on Projects. Only the list tab is set here: the switch out of Chats is selectThread's, after the
  // navigation guards agree and together with the thread it opens, so the history records that thread and not the one
  // the workspace showed before (see trackThreadHistory).
  useAppStore.setState({ lastThreadListView: 'projects' })
  void selectThread(threadId).catch(missing)
}

/** Opens a file in the Files panel; a relative path is read from the thread's folder. */
export function openFileInPanel(detail: { path: string; line?: number; column?: number; threadId?: string; projectId?: string }): void {
  window.dispatchEvent(new CustomEvent('mousse:open-file', { detail }))
}

/** React-markdown URL transform which allows only links handled by routeLink. */
export function safeMarkdownUrl(href: string): string {
  return classifyLink(href).kind === 'reject' ? '' : href
}

/** Resolve daemon-owned resource metadata before it enters a composer or send payload. */
export async function resolveChatReference(reference: ChatReference): Promise<ChatReference> {
  const parsed = parseChatReference(reference)
  if (!parsed) throw new Error('This reference is incomplete or invalid.')
  if (parsed.kind !== 'project' && parsed.kind !== 'thread') return parsed
  // A thread of another computer: this daemon does not hold it, and the agent reads it there, as that computer allows.
  if (parsed.kind === 'thread' && isQualifiedId(parsed.threadId)) return parsed
  const resolved = await window.mousse.chatReferences.resolve(parsed)
  if (!resolved) throw new Error(`The ${parsed.kind} “${parsed.title}” no longer exists in this profile.`)
  const validated = parseChatReference(resolved)
  if (!validated) throw new Error('Mousse returned invalid reference metadata.')
  return validated
}

export async function resolveChatReferences(references: ChatReference[]): Promise<ChatReference[]> {
  const resolved = await Promise.all(references.map(resolveChatReference))
  const seen = new Set<string>()
  return resolved.filter((reference) => {
    if (seen.has(reference.id)) return false
    seen.add(reference.id)
    return true
  })
}

/** Resolve a referenced project's own draft before opening its workspace. */
export async function ensureProjectReferenceThread(projectId: string, stillCurrent: () => boolean) {
  const store = useAppStore.getState()
  // A subagent is not a thread to land on; open the project's own threads.
  let thread = visibleThreads(store.threads).find((item) => item.projectId === projectId)
  if (!thread) {
    const listed = await window.mousse.projects.listThreads(projectId)
    thread = visibleThreads(listed, [...store.threads, ...listed])[0]
    if (!stillCurrent()) return null
  }
  if (!thread) {
    thread = await window.mousse.threads.create(undefined, projectId)
    if (!stillCurrent()) return null
  }
  if (!stillCurrent()) return null
  useAppStore.getState().upsertThread(thread)
  return thread
}

export async function openProjectReference(projectId: string): Promise<void> {
  const initial = useAppStore.getState()
  const profileId = initial.profileId
  let expectedThreadId = initial.activeThreadId
  const stillCurrent = () => {
    const current = useAppStore.getState()
    return current.profileId === profileId && current.activeThreadId === expectedThreadId
  }
  const thread = await ensureProjectReferenceThread(projectId, stillCurrent)
  if (!thread || !stillCurrent()) return
  if (thread.id !== expectedThreadId) {
    expectedThreadId = thread.id
    useAppStore.getState().switchToThread(thread.id)
    await selectOrSettle(thread.id)
    if (!stillCurrent()) return
  }
  const current = useAppStore.getState()
  current.openSurfaceKind('files')
}
