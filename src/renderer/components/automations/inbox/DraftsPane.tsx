// The drafts the Automation manager (or a bot, or an agent in a chat) wrote, each a card with When, Who and Project,
// and while the manager works on the composer's words, one line that says so.
import { useState } from 'react'
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
import { closePane, useInboxStore } from './inboxStore'
import { Loader2, X } from '../../../lib/icons'

export function DraftsPane({ drafts, meta, bots, onBotMade }: { drafts: AutomationItem[]; meta: (jobId: string) => InboxAutomationMeta | undefined; bots: BotChoice[]; onBotMade: () => void }) {
  const projects = useAppStore((s) => s.projects).filter((project) => !project.node)
  const composing = useInboxStore((s) => s.composing)
  const working = useManagerWorking()
  const [newBotFor, setNewBotFor] = useState<AutomationItem | null>(null)
  const now = new Date()
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
      {working ? (
        <p className="inbox-drafts-working" role="status" data-testid="inbox-drafts-working">
          <Loader2 size={13} strokeWidth={1.8} className="inbox-spin" aria-hidden="true" />
          Setting it up…
          {composing?.threadId ? <button type="button" className="inbox-text-btn muted" onClick={() => void window.mousse.orchestrator.abort(composing.threadId!)}>Stop</button> : null}
        </p>
      ) : null}
      {!drafts.length && !working ? <p className="inbox-manage-none">No drafts. Describe an automation above and the Automation manager writes one.</p> : null}
      <div className="inbox-drafts-list">
        {drafts.map((item) => (
          <DraftCard
            key={item.key}
            item={item}
            {...(meta(item.id)?.context ? { context: meta(item.id)!.context } : {})}
            projects={projects}
            bots={bots}
            now={now}
            onWhen={(schedule) => setDraftWhen(item.id, schedule)}
            onWho={(key) => { if (key === NEW_BOT_KEY) setNewBotFor(item); else void setDraftWho(item.id, key) }}
            onProject={(projectId) => setDraftProject(item.id, projectId)}
            onTurnOn={() => turnOnDraft(item.id)}
            onEditDetails={() => editDetails(item.id)}
            onDiscard={() => void discardDraft(item.id)}
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
