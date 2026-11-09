// Creating an automation from an ordinary chat, mocked: the agent's create_automation call shows the draft card
// inline (what "this" meant, When / Who / project, Turn on, Edit details); after Turn on it folds to one chip.
// Shown only in the seeded thread MOCK_DRAFT_THREAD_TITLE while the mock is on. Nothing is created.
import { useMemo, useState } from 'react'
import type { UIMessage } from 'ai'
import { mousseToUIMessages } from '../../../chat/adapters/mousseToUI'
import type { CustomToolRendererProps } from '../../../chat/components/agent-elements/types'
import { CircleCheck, Clock, Folder, MessageSquare, Pencil, Repeat, User } from '../../../lib/icons'
import { Select } from '../../ui/Select'
import { MOCK_CHAT_DRAFT, MOCK_CHAT_DRAFT_OPTIONS, MOCK_DRAFT_THREAD_TITLE, mockDraftMessages } from './data'
import { isMockOn, setDraftOn, setInboxFilter, useInboxMock } from './store'
import { useAppStore } from '../../../stores/appStore'
import './inbox.css'

const TOOL = 'create_automation'

/** The mock messages and the card's renderer for a thread, or null when the mock is off or it is another thread. */
export function useMockChatDraft(threadTitle: string | undefined): { messages: UIMessage[]; toolRenderers: Record<string, React.ComponentType<CustomToolRendererProps>> } | null {
  const mode = useInboxMock((s) => s.mode)
  const show = isMockOn(mode) && threadTitle === MOCK_DRAFT_THREAD_TITLE
  return useMemo(() => {
    if (!show) return null
    const messages = mousseToUIMessages(mockDraftMessages())
    const reply = messages[messages.length - 1]
    if (reply) {
      reply.parts = [
        ...reply.parts,
        { type: `tool-mcp__user-tools__${TOOL}`, toolCallId: 'mock-draft', state: 'output-available', input: { name: MOCK_CHAT_DRAFT.name }, output: { draft: true } } as unknown as UIMessage['parts'][number]
      ]
    }
    return { messages, toolRenderers: { [TOOL]: DraftTool } }
  }, [show])
}

function DraftTool() {
  const on = useInboxMock((s) => s.draftOn)
  const [when, setWhen] = useState(MOCK_CHAT_DRAFT.when)
  const [who, setWho] = useState(MOCK_CHAT_DRAFT.who)
  const [project, setProject] = useState(MOCK_CHAT_DRAFT.project)
  if (on) {
    return (
      <div className="inbox-draft-on" data-testid="mock-draft-on">
        <CircleCheck size={14} strokeWidth={1.8} aria-hidden="true" className="inbox-draft-on-icon" />
        <strong>{MOCK_CHAT_DRAFT.name}</strong>
        <span className="inbox-draft-on-meta">On · next {MOCK_CHAT_DRAFT.next}</span>
        <button
          type="button"
          className="inbox-text-btn"
          title="Its runs, in Automations"
          onClick={() => { setInboxFilter({ automationId: 'flaky' }); useAppStore.getState().setScheduledOpen(true) }}
        >Open</button>
      </div>
    )
  }
  return (
    <section className="inbox-draft" data-testid="mock-draft-card" aria-label={`Draft: ${MOCK_CHAT_DRAFT.name}`}>
      <div className="inbox-draft-head">
        <Repeat size={14} strokeWidth={1.8} aria-hidden="true" />
        <strong>{MOCK_CHAT_DRAFT.name}</strong>
        <span className="inbox-draft-tag">Draft</span>
      </div>
      <p className="inbox-draft-context" title="What “this” means, taken from this chat. Every run gets it.">
        <MessageSquare size={13} strokeWidth={1.8} aria-hidden="true" />
        <span>{MOCK_CHAT_DRAFT.context}</span>
      </p>
      <div className="inbox-draft-fields">
        <span className="inbox-draft-field" title="When"><Clock size={13} strokeWidth={1.8} aria-hidden="true" /><Select ariaLabel="When" size="small" value={when} options={MOCK_CHAT_DRAFT_OPTIONS.when} onChange={setWhen} /></span>
        <span className="inbox-draft-field" title="Who"><User size={13} strokeWidth={1.8} aria-hidden="true" /><Select ariaLabel="Who" size="small" value={who} options={MOCK_CHAT_DRAFT_OPTIONS.who} onChange={setWho} /></span>
        <span className="inbox-draft-field" title="Project"><Folder size={13} strokeWidth={1.8} aria-hidden="true" /><Select ariaLabel="Project" size="small" value={project} options={MOCK_CHAT_DRAFT_OPTIONS.project} onChange={setProject} /></span>
      </div>
      <div className="inbox-draft-actions">
        <button type="button" className="inbox-primary-btn" data-testid="mock-draft-turn-on" title="Nothing runs until you turn it on" onClick={() => setDraftOn(true)}>Turn on</button>
        <button type="button" className="inbox-text-btn" title="Edit details" onClick={() => undefined}><Pencil size={12} strokeWidth={1.8} aria-hidden="true" />Edit details</button>
      </div>
    </section>
  )
}
