import { Bot, File, Folder, Globe, MessageSquare, TerminalSquare, X } from 'lucide-react'
import type { ChatReference } from '../../shared/chatReferences'
import { formatMousseFileLink, parseChatReference } from '../../shared/chatReferences'
import { openProjectReference, routeLink } from '../utils/chatLinks'
import { useAppStore } from '../stores/appStore'

const ICONS = {
  file: File,
  project: Folder,
  thread: MessageSquare,
  terminal: TerminalSquare,
  browser: Globe,
  agent: Bot
}

export function ChatReferencePill({ reference: candidate, onRemove }: { reference: ChatReference; onRemove?: () => void }) {
  const reference = parseChatReference(candidate)
  if (!reference) return null
  const Icon = ICONS[reference.kind]
  const open = () => {
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
      store.setMainAreaOpen(true)
      store.setMainView('terminal')
      store.setActiveProjectTerminalTab(reference.threadId ?? store.activeThreadId, reference.tabId)
      return
    }
    if (reference.kind === 'agent' && reference.agentId) {
      if (reference.threadId && reference.threadId !== store.activeThreadId) {
        store.switchToThread(reference.threadId)
        void window.mousse.threads.select(reference.threadId)
      }
      store.setMainAreaOpen(true)
      store.setMainView('agents')
      store.setActiveAgentId(reference.agentId)
      if (reference.sessionId) store.setActivePtyId(reference.sessionId)
      return
    }
    if (reference.kind === 'file' && reference.path) {
      routeLink(formatMousseFileLink(reference.path, reference.line, reference.column), reference)
    }
  }
  return (
    <span className="composer-attachment-pill composer-reference-pill">
      <button type="button" className="composer-reference-link" onClick={open} title={reference.path ?? reference.metadataPath ?? reference.url ?? reference.title}>
        <Icon size={12} strokeWidth={2} />
        <span>{reference.title}</span>
      </button>
      {onRemove && <button type="button" className="composer-attachment-remove" onClick={onRemove} aria-label={`Remove ${reference.title}`}><X size={12} /></button>}
    </span>
  )
}
