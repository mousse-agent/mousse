import { memo, useRef, useState, type ReactNode } from 'react'
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

/** An applet error with a way to ask the assistant to repair it. */
export function AppletError({ error, onRepair }: { error: string; onRepair: () => void }) {
  return (
    <p className="mousse-applet-error" role="alert">
      {error}
      <Button size="sm" type="button" onClick={onRepair}>
        Ask the assistant to fix this
      </Button>
    </p>
  )
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
 * An applet in the transcript: only its content at its own height, under a quiet name that opens it in the side
 * panel. Native guest content is mounted only over the measured preview; no generated code enters this DOM.
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
  const applet = useAppletRuntime(preview, { host: 'transcript', threadId, profileId, reference, enabled: true, restart: 0 })
  const { error, scrollImage, conversationInput, setConversationInput } = applet

  const openInPanel = conversation ? onOpen : threadId ? () => useAppStore.getState().openAppletDocument(threadId, reference) : undefined
  return (
    <section className="mousse-applet" aria-label={`Applet: ${reference.title}`}>
      <AppletName title={reference.title} description={reference.description} onOpen={openInPanel} />
      {error && threadId && (
        <AppletError error={error} onRepair={() => requestAppletRepair(profileId, threadId, reference, error, conversation)} />
      )}
      <div
        ref={preview}
        className="mousse-applet-preview"
        // A stopped applet keeps no empty space; its error says what happened.
        style={{ height: error && !applet.ready ? 0 : applet.height ?? INITIAL_HEIGHT }}
        aria-label="Applet preview"
      >
        {scrollImage && (
          <img className="mousse-applet-scroll-frame" src={scrollImage} alt="" aria-hidden="true" />
        )}
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
