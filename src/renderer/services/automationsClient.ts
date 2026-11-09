import type { AttentionAnswer, AutomationIndex, AutomationMoveResult } from '../../shared/automations'
import type { AutomationInbox, InboxCounts, TuningNote } from '../../shared/automationInbox'
import type { PlatformRequestApi } from '../../shared/platform'
import type { ScheduledJob, QuestionAnswerOutcome } from '../../shared/types'

export interface AutomationsClient {
  /** Every automation of the bound profile in one read-only list (`automations.list`). */
  list(): Promise<AutomationIndex>
  /** Allow or Not now on an agent's first-creation ask (`automations.asks.answer`). */
  answerAsk(askId: string, answer: 'allow' | 'not_now'): Promise<void>
  /** Keep: an agent-added automation loses only its end (`automations.keep`). */
  keep(jobId: string): Promise<ScheduledJob>
  /** Move to computer: this computer's automations to another of the person's computers (`automations.move`). */
  move(jobIds: string[], node: string): Promise<AutomationMoveResult>
  /** Resend: runs a request automation again with a delivery's stored payload (`automations.request.resend`). */
  resend(jobId: string, occurrenceId: string): Promise<void>
  /** The saved keys' names in the profile's secret store (`automations.keys.list`); never their values. */
  listKeys(): Promise<string[]>
  /** Stores a key typed into a masked field (`automations.keys.set`). */
  setKey(name: string, value: string): Promise<void>
  /** Turn on: the draft becomes the person's own automation (`automations.drafts.turnOn`). */
  turnOn(draftId: string): Promise<ScheduledJob>
  /** Discard: the draft is deleted (`automations.drafts.discard`). */
  discard(draftId: string): Promise<void>
  /** A blank draft to set up by hand (`automations.drafts.create`). */
  createDraft(projectId?: string): Promise<ScheduledJob>
  /** The person answered the draft's question; its answer goes to the manager as a message (`automations.drafts.answered`). */
  answered(draftId: string): Promise<void>
  /** The Automation manager's hidden thread, made the first time (`automations.manager.thread`). */
  /** The manager's thread; its next turns work in this project (else the manager's own folder). */
  managerThread(projectId?: string): Promise<string>
  /** The person changed Who on a draft (`automations.drafts.setWho`). */
  setWho(draftId: string, who: AutomationWhoPick): Promise<void>
  /** The person's Who for the next drafts this manager writes (`automations.drafts.nextWho`). */
  nextWho(botId: string | undefined, who: AutomationWhoPick): Promise<void>
  /** The inbox: runs, the Needs you queue, Tuning notes and this month's usage (`automations.inbox.list`). */
  inbox(): Promise<AutomationInbox>
  /** Unresolved Needs you items assigned to the person, by project (`automations.inbox.counts`). */
  counts(): Promise<InboxCounts>
  /** Resolve every open item of a run (`automations.inbox.resolve`). */
  resolve(runId: string): Promise<void>
  /** Undo the last Resolve (`automations.inbox.undo`); the run it reopened. */
  undo(): Promise<string | undefined>
  /** Too noisy / Should have told me (`automations.inbox.calibrate`); undefined when it was taken back. */
  calibrate(runId: string, kind: TuningNote['kind']): Promise<TuningNote | undefined>
  /** Remove a Tuning note (`automations.tuning.remove`). */
  removeTuning(noteId: string): Promise<void>
}

/** Who does it, as the person picks it: the default agent or a bot. */
export type AutomationWhoPick = { kind: 'default' } | { kind: 'bot'; botId: string }

/** Uses the host's profile-bound bridge. */
export function createAutomationsClient(transport: PlatformRequestApi): AutomationsClient {
  return {
    list: () => transport.request<AutomationIndex>('automations.list', {}),
    answerAsk: async (askId, answer) => { await transport.request('automations.asks.answer', { askId, answer }) },
    keep: async (jobId) => (await transport.request<{ job: ScheduledJob }>('automations.keep', { jobId })).job,
    move: (jobIds, node) => transport.request<AutomationMoveResult>('automations.move', { jobIds, node }),
    resend: async (jobId, occurrenceId) => { await transport.request('automations.request.resend', { jobId, occurrenceId }) },
    listKeys: async () => (await transport.request<{ keys: Array<{ name: string }> }>('automations.keys.list', {})).keys.map((key) => key.name),
    setKey: async (name, value) => { await transport.request('automations.keys.set', { name, value }) },
    turnOn: async (draftId) => (await transport.request<{ job: ScheduledJob }>('automations.drafts.turnOn', { draftId })).job,
    discard: async (draftId) => { await transport.request('automations.drafts.discard', { draftId }) },
    createDraft: async (projectId) => (await transport.request<{ job: ScheduledJob }>('automations.drafts.create', projectId ? { projectId } : {})).job,
    answered: async (draftId) => { await transport.request('automations.drafts.answered', { draftId }) },
    managerThread: async (projectId) => (await transport.request<{ threadId: string }>('automations.manager.thread', projectId ? { projectId } : {})).threadId,
    setWho: async (draftId, who) => { await transport.request('automations.drafts.setWho', { draftId, who }) },
    nextWho: async (botId, who) => { await transport.request('automations.drafts.nextWho', { ...(botId ? { botId } : {}), who }) },
    inbox: () => transport.request<AutomationInbox>('automations.inbox.list', {}),
    counts: () => transport.request<InboxCounts>('automations.inbox.counts', {}),
    resolve: async (runId) => { await transport.request('automations.inbox.resolve', { runId }) },
    undo: async () => (await transport.request<{ runId?: string }>('automations.inbox.undo', {})).runId,
    calibrate: async (runId, kind) => (await transport.request<{ note?: TuningNote }>('automations.inbox.calibrate', { runId, kind })).note,
    removeTuning: async (noteId) => { await transport.request('automations.tuning.remove', { noteId }) }
  }
}

/** What answering in place needs from the app: the thread's permission request answer and the platform requests. */
export interface AnswerPorts {
  transport: PlatformRequestApi
  answerQuestions(requestId: string, answers: Record<string, string>, threadId: string): Promise<QuestionAnswerOutcome>
}

/**
 * Answers an open ask from Needs you with the same daemon method its own surface uses: the thread's permission request,
 * the workflow step's approval, the agent's first-creation ask or the bot's ask. Throws what the person should read when
 * the ask was answered elsewhere first or is gone.
 */
export async function answerAttention(answer: AttentionAnswer, allow: boolean, ports: AnswerPorts): Promise<void> {
  switch (answer.kind) {
    case 'thread_approval': {
      const outcome = await ports.answerQuestions(answer.requestId, { [answer.questionId]: allow ? answer.allow : answer.deny }, answer.threadId)
      if (!outcome.ok) throw new Error(outcome.reason === 'already_answered' ? 'It was already answered.' : 'This request was closed.')
      return
    }
    case 'workflow_approval':
      await ports.transport.request('workflowRuns.approve', { runId: answer.runId, approvalId: answer.approvalId, nodeId: answer.nodeId, instanceKey: answer.instanceKey, attempt: answer.attempt, approved: allow })
      return
    case 'agent_ask':
      await ports.transport.request('automations.asks.answer', { askId: answer.askId, answer: allow ? 'allow' : 'not_now' })
      return
    case 'bot_ask':
      await ports.transport.request('bots.asks.answer', { botId: answer.botId, askId: answer.askId, answer: allow ? 'allow' : 'not_now' })
  }
}
