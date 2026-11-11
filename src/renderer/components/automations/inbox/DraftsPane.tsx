// The drafts the Automation manager (or a bot, or an agent in a chat) wrote, each a card with When, Who and Project,
// and while the manager works on the composer's words, one line that says so.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AutomationItem } from '../../../../shared/automations'
import type { InboxAutomationMeta } from '../../../../shared/automationInbox'
import { useAppStore } from '../../../stores/appStore'
import { openThread } from '../../../lib/openThread'
import { closeRailPages } from '../../../lib/railPages'
import { useChatsStore } from '../../../stores/chatsStore'
import { NewBotDialog } from '../../bots/NewBotDialog'
import { DraftCard, NEW_BOT_KEY } from '../DraftCard'
import type { BotChoice } from '../whoDo'
import { answerDraft, discardDraft, editDetails, setDraftProject, setDraftWhen, setDraftWho, turnOnDraft } from './draftActions'
import { useManagerWorking } from './InboxComposer'
import { retryRequest } from './draftActions'
import { closePane, dismissRequest, newDrafts, stopRequest, useInboxStore, type ManagerRequest } from './inboxStore'
import { CircleAlert, Loader2, MessageSquare, RotateCcw, X } from '../../../lib/icons'

export function DraftsPane({ drafts, meta, bots, onBotMade }: { drafts: AutomationItem[]; meta: (jobId: string) => InboxAutomationMeta | undefined; bots: BotChoice[]; onBotMade: () => void }) {
  const projects = useAppStore((s) => s.projects).filter((project) => !project.node)
  const composing = useInboxStore((s) => s.composing)
  const index = useInboxStore((s) => s.index)
  const working = useManagerWorking()
  const [newBotFor, setNewBotFor] = useState<AutomationItem | null>(null)
  const now = new Date()
  // The drafts the person's last words made: lit until they send again.
  const fresh = useMemo(() => new Set(newDrafts(composing, index)), [composing, index])
  const listRef = useRef<HTMLDivElement>(null)
  const firstFresh = drafts.find((item) => fresh.has(item.id))?.id
  useEffect(() => {
    if (firstFresh) listRef.current?.querySelector(`[data-key="job:${firstFresh}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [firstFresh])
  const openManagerChat = (request: ManagerRequest) => {
    if (request.botId) {
      closeRailPages()
      void useChatsStore.getState().openBot(request.botId)
    } else if (request.threadId) {
      void openThread(request.threadId).then(closeRailPages)
    }
  }
  const openConversation = (item: AutomationItem) => {
    const origin = meta(item.id)?.originThreadId
    const thread = origin ?? item.draft?.managerThreadId ?? composing?.threadId
    if (item.draft?.botId) {
      closeRailPages()
      void useChatsStore.getState().openBot(item.draft.botId)
    } else if (thread) {
      void openThread(thread).then(closeRailPages)
    }
  }
  return (
    <div className="inbox-drafts" data-testid="inbox-drafts">
      <div className="inbox-manage-head">
        <span className="inbox-manage-title">Drafts</span>
        {drafts.length ? <span className="inbox-group-count">{drafts.length}</span> : null}
        <span className="inbox-strip-spacer" />
        <button type="button" className="inbox-icon-btn small" title="Close · Esc" aria-label="Close" onClick={closePane}><X size={14} strokeWidth={1.8} /></button>
      </div>
      {composing && (!composing.draftId || composing.status === 'failed') && !fresh.size ? (
        <RequestCard request={composing} working={working} onOpenChat={() => openManagerChat(composing)} />
      ) : null}
      {!drafts.length && !composing ? <p className="inbox-manage-none">No drafts yet. Describe an automation to get one.</p> : null}
      <div className="inbox-drafts-list" ref={listRef}>
        {drafts.map((item) => (
          <DraftCard
            key={item.key}
            item={item}
            fresh={fresh.has(item.id)}
            {...(meta(item.id)?.context ? { context: meta(item.id)!.context } : {})}
            projects={projects}
            bots={bots}
            now={now}
            onWhen={(schedule) => setDraftWhen(item.id, schedule)}
            onWho={(key) => { if (key === NEW_BOT_KEY) setNewBotFor(item); else void setDraftWho(item.id, key) }}
            onProject={(projectId) => setDraftProject(item.id, projectId)}
            onTurnOn={() => turnOnDraft(item.id)}
            onEditDetails={() => editDetails(item.id)}
            onDiscard={() => discardDraft(item.id)}
            onAnswer={(answer) => void answerDraft(item, answer)}
            onOpenConversation={() => openConversation(item)}
          />
        ))}
      </div>
      {newBotFor ? (
        <NewBotDialog
          initialDescription={newBotFor.name}
          onCreated={(bot) => { const target = newBotFor; setNewBotFor(null); onBotMade(); void setDraftWho(target.id, `bot:${bot.id}`) }}
          onClose={() => setNewBotFor(null)}
        />
      ) : null}
    </div>
  )
}

/** The person's last words to the manager: pending while it writes, then an error with Retry, or no draft with its chat. */
function RequestCard({ request, working, onOpenChat }: { request: ManagerRequest; working: boolean; onOpenChat: () => void }) {
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!working) return
    const timer = setInterval(() => setTick((count) => count + 1), 1_000)
    return () => clearInterval(timer)
  }, [working])
  const seconds = Math.max(0, Math.round((Date.now() - request.at) / 1000))
  const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  const retry = () => {
    setRetrying(true)
    setRetryError(null)
    void retryRequest(request).catch((cause) => setRetryError(cause instanceof Error ? cause.message : String(cause))).finally(() => setRetrying(false))
  }
  const state = working ? 'working' : request.status === 'failed' ? 'failed' : request.status === 'stopped' ? 'stopped' : 'done'
  const error = retryError ?? request.error
  return (
    <section className="inbox-request" data-state={state} data-testid="inbox-request" role="status" aria-live="polite">
      <div className="inbox-request-head">
        <span className="inbox-request-icon" aria-hidden="true">
          {state === 'working' ? <Loader2 size={14} strokeWidth={2} className="inbox-spin" /> : state === 'failed' ? <CircleAlert size={14} strokeWidth={2} /> : <MessageSquare size={14} strokeWidth={1.8} />}
        </span>
        <strong className="inbox-request-title">
          {state === 'working' ? 'Writing a draft…' : state === 'failed' ? "Couldn't write the draft" : state === 'stopped' ? 'Stopped' : 'No draft yet: the manager replied in its chat'}
        </strong>
        {state === 'working' ? <span className="inbox-request-time" title="Since you sent it">{elapsed}</span> : null}
        <span className="inbox-strip-spacer" />
        {!working ? <button type="button" className="inbox-icon-btn small" title="Dismiss" aria-label="Dismiss" onClick={dismissRequest}><X size={13} strokeWidth={1.8} /></button> : null}
      </div>
      <p className="inbox-request-text" title={request.text}>{request.text}</p>
      {state === 'failed' && error ? <p className="inbox-request-error" data-testid="inbox-request-error" title={error}>{error}</p> : null}
      <div className="inbox-request-actions">
        {state === 'failed' || state === 'stopped' ? (
          <button type="button" className="inbox-primary-btn" data-testid="inbox-request-retry" disabled={retrying} aria-busy={retrying || undefined} onClick={retry}>
            {retrying ? <Loader2 size={13} strokeWidth={2} className="inbox-spin" aria-hidden="true" /> : <RotateCcw size={13} strokeWidth={2} aria-hidden="true" />}
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        ) : null}
        {request.threadId || request.botId ? <button type="button" className="inbox-text-btn" title="The manager's chat" onClick={onOpenChat}><MessageSquare size={12} strokeWidth={1.8} aria-hidden="true" />Open chat</button> : null}
        {state === 'working' && request.threadId ? <button type="button" className="inbox-text-btn muted" data-testid="inbox-request-stop" onClick={stopRequest}>Stop</button> : null}
      </div>
    </section>
  )
}
