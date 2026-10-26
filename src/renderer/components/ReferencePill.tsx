import { Bot, File, Folder, Globe, MessageSquare, TerminalSquare, X } from '../lib/icons'
import type { ChatReference } from '../../shared/chatReferences'
import { formatMousseFileLink, parseChatReference } from '../../shared/chatReferences'
import { openProjectReference, routeLink } from '../utils/chatLinks'
import { useAppStore } from '../stores/appStore'
import { useReviewStore } from '../stores/reviewStore'
import { openSurface } from '../lib/surfaces'
import { scopeFromKey } from './review/reviewComments'

const ICONS = {
  file: File,
  project: Folder,
  thread: MessageSquare,
  terminal: TerminalSquare,
  browser: Globe,
  agent: Bot,
  'review-comment': MessageSquare
}

/** Pill tooltip: a review comment shows its scope and text, other kinds show where they point. */
export function referenceTitle(reference: ChatReference): string {
  if (reference.kind === 'review-comment') {
    return [reference.scopeLabel, reference.comment].filter(Boolean).join(': ') || reference.title
  }
  return reference.path ?? reference.metadataPath ?? reference.url ?? reference.title
}

/** Opens what a reference points at: file, project, thread, terminal, browser tab, or the thread an old agent reference belongs to. */
export function openChatReference(reference: ChatReference): void {
  const store = useAppStore.getState()
  if (reference.kind === 'browser' && reference.url) {
    routeLink(reference.url, reference)
    return
  }
  if (reference.kind === 'project' && reference.projectId) {
    void openProjectReference(reference.projectId).catch((error) => console.error('Failed to open referenced project', error))
    return
  }
  if (reference.kind === 'thread' && reference.threadId) {
    store.switchToThread(reference.threadId)
    void window.mousse.threads.select(reference.threadId)
    return
  }
  if (reference.kind === 'terminal' && reference.tabId) {
    if (reference.threadId && reference.threadId !== store.activeThreadId) {
      store.switchToThread(reference.threadId)
      void window.mousse.threads.select(reference.threadId)
    }
    store.openSurfaceKind('terminal')
    store.setActiveProjectTerminalTab(reference.threadId ?? store.activeThreadId, reference.tabId)
    return
  }
  if (reference.kind === 'agent' && reference.threadId) {
    // There is no Agents tab any more; an old agent reference opens the thread that owns it.
    if (reference.threadId !== store.activeThreadId) {
      store.switchToThread(reference.threadId)
      void window.mousse.threads.select(reference.threadId)
    }
    return
  }
  if (reference.kind === 'review-comment' && reference.path && reference.line && reference.reviewScope && store.activeThreadId) {
    // Back to the version of the file the comment was made on, scrolled to its line.
    const scope = scopeFromKey(reference.reviewScope)
    if (scope) {
      useReviewStore.getState().revealComment(store.activeThreadId, { scope, absolutePath: reference.path, line: reference.line })
      openSurface('review')
      return
    }
  }
  // Without a thread, or a scope that cannot be shown, a review comment opens the file at its first line.
  if ((reference.kind === 'file' || reference.kind === 'review-comment') && reference.path) {
    routeLink(formatMousseFileLink(reference.path, reference.line, reference.column), reference)
  }
}

export function ChatReferencePill({ reference: candidate, onRemove }: { reference: ChatReference; onRemove?: () => void }) {
  const reference = parseChatReference(candidate)
  if (!reference) return null
  const Icon = ICONS[reference.kind]
  const open = () => openChatReference(reference)
  return (
    <span className="composer-attachment-pill composer-reference-pill">
      <button type="button" className="composer-reference-link" onClick={open} title={referenceTitle(reference)}>
        <Icon size={12} strokeWidth={2} />
        <span>{reference.title}</span>
      </button>
      {onRemove && <button type="button" className="composer-attachment-remove" onClick={onRemove} aria-label={`Remove ${reference.title}`}><X size={12} /></button>}
    </span>
  )
}
