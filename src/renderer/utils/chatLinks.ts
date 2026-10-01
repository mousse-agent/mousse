import { parseChatReference, parseMousseFileLink, type ChatReference } from '../../shared/chatReferences'
import { useAppStore } from '../stores/appStore'

const UNSAFE_SCHEME = /^(?:javascript|data|vbscript|blob):/i

export type RoutedLink =
  | { kind: 'file'; path: string; line?: number; column?: number }
  | { kind: 'web'; url: string }
  | { kind: 'relative-file'; path: string; line?: number; column?: number }
  | { kind: 'reject' }

/** Parse links without treating Windows drive letters as URL schemes. */
export function classifyLink(href: string): RoutedLink {
  const value = href.trim()
  if (!value || UNSAFE_SCHEME.test(value)) return { kind: 'reject' }
  const mousseFile = parseMousseFileLink(value)
  if (mousseFile) return { kind: 'file', ...mousseFile }
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'reject' }
      return { kind: 'web', url: url.toString() }
    } catch { return { kind: 'reject' } }
  }
  if (/^(?:mailto|tel|file):/i.test(value)) return { kind: 'reject' }

  // Agent markdown commonly emits path/to/file.ts#L12 or C:\repo\file.ts:12:3.
  const windows = value.match(/^([a-zA-Z]:[\\/].*?)(?::(\d+))?(?::(\d+))?(?:#L(\d+)(?:C(\d+))?)?$/)
  const ordinary = value.match(/^(.+?)(?::(\d+))?(?::(\d+))?(?:#L(\d+)(?:C(\d+))?)?$/)
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

export function routeLink(href: string, context?: { threadId?: string; projectId?: string }): boolean {
  const route = classifyLink(href)
  if (route.kind === 'reject') return false
  if (route.kind === 'web') {
    const store = useAppStore.getState()
    const tabId = store.addBrowserTab(store.activeThreadId)
    store.updateBrowserTab(tabId, { url: route.url, title: route.url })
    store.setActiveBrowserTab(store.activeThreadId, tabId)
    store.setMainAreaOpen(true)
    store.setMainView('browser')
    return true
  }
  window.dispatchEvent(new CustomEvent('mousse:open-file', {
    detail: {
      path: route.path,
      line: route.line,
      column: route.column,
      threadId: context?.threadId,
      projectId: context?.projectId
    }
  }))
  return true
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
