// "Check this daily" in an ordinary chat: the agent's `automation_draft_save` shows as the draft's card in the chat,
// always in the automation's current state. Turn on folds it to "On · next 09:00 · Open"; runs never post here.
import { useEffect, useMemo, useState } from 'react'
import type { CustomToolRendererProps } from '../../../chat/components/agent-elements/types'
import { Loader2 } from '../../../lib/icons'
import { isRunLevel, type RunLevel } from '../../../../shared/automationInbox'
import { LEVEL_VIEW } from './RunParts'
import { useAppStore } from '../../../stores/appStore'
import { NewBotDialog } from '../../bots/NewBotDialog'
import { DraftCard, DraftOnLine, NEW_BOT_KEY } from '../DraftCard'
import { viewerTimeZone } from '../automationTime'
import { useAutomationLibrary } from '../WhoDoPickers'
import { discardDraft, editDetails, setDraftProject, setDraftWhen, setDraftWho, turnOnDraft } from './draftActions'
import { openAutomationRuns, refreshIfOld, useInboxStore } from './inboxStore'
import './inbox.css'

/** The tool whose result is a draft card in the chat. */
export const DRAFT_TOOL = 'automation_draft_save'

/** The draft a call saved: its result's `draftId`, else the one it changed. */
export function draftIdOf(input: Record<string, unknown>, output: unknown): string | undefined {
  const read = (value: unknown): string | undefined => {
    if (value && typeof value === 'object' && typeof (value as { draftId?: unknown }).draftId === 'string') return (value as { draftId: string }).draftId
    if (typeof value === 'string') {
      try {
        return read(JSON.parse(value))
      } catch {
        return /"draftId"\s*:\s*"([^"]+)"/.exec(value)?.[1]
      }
    }
    if (Array.isArray(value)) for (const entry of value) { const found = read((entry as { text?: unknown })?.text ?? entry); if (found) return found }
    return undefined
  }
  return read(output) ?? (typeof input.draftId === 'string' ? input.draftId : undefined)
}

export function ChatDraftCard({ input, output, status }: CustomToolRendererProps) {
  const threadId = useAppStore((s) => s.activeThreadId)
  const profileId = useAppStore((s) => s.profileId)
  const projects = useAppStore((s) => s.projects)
  const index = useInboxStore((s) => s.index)
  const inbox = useInboxStore((s) => s.inbox)
  const { library, reload } = useAutomationLibrary(profileId)
  const [newBot, setNewBot] = useState(false)
  const viewerZone = useMemo(viewerTimeZone, [])
  const draftId = draftIdOf(input, output)

  useEffect(() => { void refreshIfOld(3_000) }, [draftId, status])

  if (status === 'pending' || status === 'streaming') {
    return <p className="inbox-draft-writing" data-testid="chat-draft-writing"><Loader2 size={13} strokeWidth={1.8} className="inbox-spin" aria-hidden="true" />Writing a draft…</p>
  }
  if (status === 'error') return <p className="inbox-draft-writing" data-testid="chat-draft-failed">The draft was not saved.</p>

  const items = index?.items ?? []
  const name = typeof input.name === 'string' ? input.name : undefined
  const fromThisChat = (id: string) => items.some((entry) => entry.id === id && entry.draft?.originThreadId === threadId) || Boolean(inbox?.meta.some((meta) => meta.jobId === id && meta.originThreadId === threadId))
  // The call's draft by id. A draft turned on with a bot as Who became that bot's automation: it is found by the chat
  // it came from. A runtime that keeps neither the call's arguments nor its result (an ACP agent): the chat's newest.
  const item = (draftId ? items.find((entry) => entry.id === draftId) : undefined)
    ?? items.find((entry) => entry.kind === 'job' && name !== undefined && entry.name === name && fromThisChat(entry.id))
    ?? (!draftId && !name ? [...items].reverse().find((entry) => entry.kind === 'job' && fromThisChat(entry.id)) : undefined)
  const now = new Date()
  if (!index) return <p className="inbox-draft-writing" data-testid="chat-draft-loading">Reading the draft…</p>
  if (!item) return <p className="inbox-draft-gone" data-testid="chat-draft-gone">{name ? `“${name}” was discarded.` : 'This draft was discarded.'}</p>
  if (!item.draft) return <DraftOnLine item={item} now={now} viewerZone={viewerZone} onOpen={() => openAutomationRuns(item.id)} testId="chat-draft-on" />
  const context = inbox?.meta.find((meta) => meta.jobId === item.id)?.context ?? (typeof input.context === 'string' ? input.context : undefined)
  return (
    <>
      <DraftCard
        item={item}
        {...(context ? { context } : {})}
        projects={projects.filter((project) => !project.node)}
        bots={library.bots}
        now={now}
        testIdPrefix="chat-draft"
        onWhen={(schedule) => setDraftWhen(item.id, schedule)}
        onWho={(key) => { if (key === NEW_BOT_KEY) setNewBot(true); else void setDraftWho(item.id, key) }}
        onProject={(projectId) => setDraftProject(item.id, projectId)}
        onTurnOn={() => turnOnDraft(item.id)}
        onEditDetails={() => editDetails(item.id)}
        onDiscard={() => void discardDraft(item.id)}
      />
      {newBot ? (
        <NewBotDialog
          initialDescription={context ?? item.name}
          onCreated={(bot) => { setNewBot(false); reload(); void setDraftWho(item.id, `bot:${bot.id}`) }}
          onClose={() => setNewBot(false)}
        />
      ) : null}
    </>
  )
}

/** What a run reported, from the call's arguments or its result (a runtime may give only one of them). */
export function reportOf(input: Record<string, unknown>, output: unknown): { level?: RunLevel; summary?: string } {
  const read = (value: unknown): Record<string, unknown> | undefined => {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
    if (typeof value === 'string') { try { return read(JSON.parse(value)) } catch { return undefined } }
    if (Array.isArray(value)) for (const entry of value) { const found = read((entry as { text?: unknown })?.text ?? entry); if (found) return found }
    return undefined
  }
  const source = isRunLevel(input.level) ? input : read(output) ?? {}
  return { ...(isRunLevel(source.level) ? { level: source.level } : {}), ...(typeof source.summary === 'string' ? { summary: source.summary } : {}) }
}

/** An automation run's `run_report`, in its thread: the level it reported and its one line. */
export function RunReportCard({ input, output, status }: CustomToolRendererProps) {
  const threadId = useAppStore((s) => s.activeThreadId)
  // A runtime that keeps neither the call's arguments nor its result (an ACP agent): the report the inbox holds for
  // this thread's newest reported run.
  const held = useInboxStore((s) => s.inbox?.runs.find((run) => run.threadId === threadId && run.level))
  const given = reportOf(input, output)
  const report = given.level ? given : held ? { level: held.level, ...(held.summary ? { summary: held.summary } : {}) } : given
  const view = report.level ? LEVEL_VIEW[report.level] : undefined
  if (status === 'error') return <p className="inbox-draft-writing" data-testid="run-report-failed">The report was not taken.</p>
  return (
    <p className="inbox-run-report" data-testid="run-report" data-level={report.level}>
      {view?.icon}
      <span className="inbox-run-report-level">{view ? `Reported ${view.label}` : 'Reporting…'}</span>
      {report.summary ? <span className="inbox-run-report-summary" title={report.summary}>{report.summary}</span> : null}
    </p>
  )
}

/** The chat's custom tool cards. */
export const CHAT_TOOL_RENDERERS = { [DRAFT_TOOL]: ChatDraftCard, run_report: RunReportCard }
