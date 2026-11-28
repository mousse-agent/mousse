import { memo, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { AppletReference } from '../../../shared/applets'
import { useAppStore } from '../../stores/appStore'
import './applets.css'
import { Button } from '../ui/Button'
import { useAppletRuntime } from './useAppletRuntime'
import { addAppletInputToDraft, requestAppletRepair, type AppletConversation } from './appletActions'

export function isAppletPart(
  value: unknown
): value is { type: 'data-applet'; data: AppletReference } {
  if (!value || typeof value !== 'object') return false
  const part = value as { type?: unknown; data?: unknown }
  if (part.type !== 'data-applet' || !part.data || typeof part.data !== 'object') return false
  const ref = part.data as Record<string, unknown>
  return ['appletId', 'revisionId', 'sourceHash', 'title', 'description'].every(
    (key) => typeof ref[key] === 'string'
  )
}

/** Height kept for a preview until the applet reports its own. */
const INITIAL_HEIGHT = 320

/** An applet's name above its content; it opens the applet in the side panel. */
export function AppletName({ title, description, onOpen }: { title: string; description?: string; onOpen?: () => void }) {
  return (
    <button
      type="button"
      className="mousse-applet-name"
      title={description ? `${description}\nOpen in side panel` : 'Open in side panel'}
      onClick={onOpen}
      disabled={!onOpen}
    >
      {title}
    </button>
  )
}

/** An applet error with a way to ask the assistant to repair it (none while the bot that made it is away). */
export function AppletError({ error, onRepair }: { error: string; onRepair?: () => void }) {
  return (
    <p className="mousse-applet-error" role="alert">
      {error}
      {onRepair && <Button size="sm" type="button" onClick={onRepair}>
        Ask the assistant to fix this
      </Button>}
    </p>
  )
}

/**
 * A bot of another computer's applet shown from the copy here while that computer is away: what changes in it is not
 * saved. Null otherwise.
 */
export function AppletAwayNote({ conversation, readOnly, error }: { conversation?: AppletConversation; readOnly: boolean; error: string | null }) {
  const bot = conversation?.bot
  // Not opened here before, it has no copy: its error says the computer is offline instead.
  if (!bot || (!readOnly && (!bot.offline || error))) return null
  return <p className="mousse-applet-note" role="status">{bot.computer} is offline · changes here aren’t saved</p>
}

/** Text the applet asked to add to the conversation, with Add and Dismiss. */
export function AppletConversationInput({ text, onAdd, onDismiss }: { text: string; onAdd: () => void; onDismiss: () => void }): ReactNode {
  return (
    <aside className="mousse-applet-conversation-input scrollbar-ultra-thin">
      <p>{text}</p>
      <Button size="sm" type="button" onClick={onAdd}>
        Add to conversation draft
      </Button>
      <Button size="sm" type="button" onClick={onDismiss}>
        Dismiss
      </Button>
    </aside>
  )
}

/**
 * The applet's page, drawn in the preview by a `<webview>`. The address is minted by the main process for this mount
 * and loads once; main gives the page its own sandboxed process and session, so no generated code enters this DOM.
 * Keyed by address: a new page is a new webview, never a navigation of the old one.
 */
export function AppletFrame({ src, webview }: { src: string | null; webview: RefObject<HTMLWebViewElement | null> }) {
  return src ? <webview key={src} ref={webview} src={src} className="mousse-applet-webview" /> : null
}

/**
 * An applet in the transcript: only its content at its own height, under a quiet name that opens it in the side
 * panel.
 * `conversation`: it shows outside the open thread (a bot's chat), from that thread and with that composer, and `onOpen`
 * opens it in that place's own view.
 */
export const AppletCard = memo(function AppletCard({ reference, conversation, onOpen }: { reference: AppletReference; conversation?: AppletConversation; onOpen?: () => void }) {
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const profileId = useAppStore((s) => s.profileId)
  // The thread this row belongs to. Once another thread is open, the row may render once more before it goes, and must
  // not show (or start) its applet over the new thread. An applet shown elsewhere names its own thread.
  const [hostThreadId] = useState(activeThreadId)
  const threadId = conversation ? conversation.threadId : hostThreadId === activeThreadId ? activeThreadId : null
  const preview = useRef<HTMLDivElement>(null)
  const applet = useAppletRuntime(preview, { host: 'transcript', threadId, profileId, reference, enabled: true, restart: 0, bot: conversation?.bot })
  const { error, conversationInput, setConversationInput } = applet
  // A remote applet whose computer is away, or shown from the copy here, can't be repaired from here.
  const away = Boolean(conversation?.bot?.offline || applet.readOnly)

  const openInPanel = conversation ? onOpen : threadId ? () => useAppStore.getState().openAppletDocument(threadId, reference) : undefined
  return (
    <section className="mousse-applet" aria-label={`Applet: ${reference.title}`}>
      <AppletName title={reference.title} description={reference.description} onOpen={openInPanel} />
      <AppletAwayNote conversation={conversation} readOnly={applet.readOnly} error={error} />
      {error && threadId && (
        <AppletError error={error} onRepair={away ? undefined : () => requestAppletRepair(profileId, threadId, reference, error, conversation)} />
      )}
      <div
        ref={preview}
        className="mousse-applet-preview"
        // A stopped applet keeps no empty space; its error says what happened.
        style={{ height: error && !applet.ready ? 0 : applet.height ?? INITIAL_HEIGHT }}
        aria-label="Applet preview"
      >
        <AppletFrame src={applet.src} webview={applet.webview} />
      </div>
      {conversationInput && threadId && (
        <AppletConversationInput
          text={conversationInput}
          onAdd={() => { if (addAppletInputToDraft(profileId, threadId, reference, conversationInput, conversation)) setConversationInput(null) }}
          onDismiss={() => setConversationInput(null)}
        />
      )}
    </section>
  )
})
