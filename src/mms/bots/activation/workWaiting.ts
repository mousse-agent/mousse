import type { BotActivationRow, BotStore, BotReminderRow } from '../store/BotStore'
import { wakeInput } from '../../../shared/bots/personal/wakes'
import type { BotWorkItem } from '../../../shared/bots/personal/chat'
import { questionGoneText, QUESTION_WORK_WAITING_TEXT } from '../../../shared/bots/personal/questions'

/** Read access for line text, continuation context and owner controls. Future wait/action readers belong here. */
export interface WorkWaitLookups {
  store(): Pick<BotStore, 'workQuestion' | 'openAsks' | 'get' | 'workWait'>
}
export type WorkWaitLine = Pick<BotWorkItem, 'status' | 'waitsFor' | 'wait'> & { detail?: string }

/** Facts supplied by the engine; the rules themselves neither write nor hold engine state. */
export interface WorkWaitFacts {
  approvalReady(row: BotActivationRow): boolean
  approvalExists(row: BotActivationRow): boolean
  timerExists(row: BotActivationRow): boolean
  usageResumable(row: BotActivationRow): boolean
  questionExists(row: BotActivationRow): boolean
  roomStranded(row: BotActivationRow): boolean
  usageStranded(row: BotActivationRow): boolean
}
interface WaitRule {
  /** Stored end reasons, including the marker written by the wake source before a slot is free. */
  weekExemptWhenReady: boolean
  rank: number
  reasons: readonly string[]
  allows(row: Pick<BotActivationRow, 'lane' | 'trigger'>): boolean
  ready(row: BotActivationRow, facts: WorkWaitFacts): boolean
  stranded(row: BotActivationRow, facts: WorkWaitFacts): boolean
  endReason: string
  endLine(title: string): string
  resume: 'continue' | 'usageReset'
  continuation(row: BotActivationRow, facts: WorkWaitLookups): { questionAnswered?: boolean; moreRoom?: boolean; usageReset?: boolean }
  continueRefusal(row: BotActivationRow): string
  waitsOnOwner(row: BotActivationRow, facts: WorkWaitLookups): boolean
  needsOwner(row: BotActivationRow, facts: WorkWaitLookups): boolean
  takesNotes(row: BotActivationRow): boolean
  noteRefusal: 'question' | 'held' | 'approval' | 'waiting'
  checkBeforeResume: boolean
  line(row: BotActivationRow, facts: WorkWaitLookups): WorkWaitLine
  clearLiveChip: boolean
  republishQuestion: boolean
}
const workOnly: WaitRule['allows'] = (row) => row.lane === 'run' && row.trigger.kind === 'work'
const nothingToWaitFor = (title: string) => `I stopped "${title}": nothing could let it carry on any more. Ask me again if you still want it.`

/** Rebuilt from the delivered row when a continuation can actually be dispatched. */
export function workWaitInput(wait: BotReminderRow, clock: (iso: string) => string): string {
  const late = wait.deliveredAt && Date.parse(wait.deliveredAt) - Date.parse(wait.dueAt) > 2 * 60_000 && !wait.event
  return wakeInput({ brief: wait.text, setAt: wait.createdAt, event: wait.event, fired: wait.fired, chain: wait.chain, work: true, clock, ...(late ? { late: clock(wait.dueAt) } : {}) })
}

/** One row per reason. Wake sources keep their existing transactions, messages and stored markers. */
export const WORK_WAIT_RULES = {
  approval: {
    weekExemptWhenReady: false, rank: 0, reasons: ['approval', 'approval_answered'], allows: (row) => workOnly(row) || row.lane === 'run' && row.trigger.kind === 'schedule',
    ready: (row, facts) => row.endReason === 'approval_answered' && facts.approvalReady(row),
    stranded: (row, facts) => !facts.approvalExists(row),
    endReason: 'action_gone', endLine: nothingToWaitFor, resume: 'continue', checkBeforeResume: true,
    continuation: (_row, _facts) => ({}),
    continueRefusal: (row) => row.endReason === 'approval_answered' ? 'This work has your answer and carries on when a slot is free.' : 'This work waits for Send or Not now on its held action.',
    waitsOnOwner: (row, _facts) => row.endReason === 'approval',
    needsOwner: (row, facts) => Boolean(facts.store().get("SELECT 1 FROM bot_actions WHERE activation_id = ? AND status = 'open' AND message_id IS NOT NULL", row.id)),
    takesNotes: (row) => row.endReason !== 'approval', noteRefusal: 'approval',
    line: (row, _facts) => ({ status: row.endReason === 'approval_answered' ? 'queued' : 'paused', ...(row.endReason === 'approval' ? { waitsFor: 'answer' as const, detail: 'Send this action?' } : {}) }),
    clearLiveChip: true, republishQuestion: false
  },
  waiting: {
    weekExemptWhenReady: true, rank: 1, reasons: ['waiting', 'wait_ready'], allows: workOnly,
    ready: (row, _facts) => row.endReason === 'wait_ready',
    stranded: (row, facts) => !facts.timerExists(row),
    endReason: 'wait_gone', endLine: nothingToWaitFor, resume: 'continue',
    // Unread wait events are assembled from storage inside continueWith, independent of this park reason.
    continuation: (_row, _facts) => ({}),
    checkBeforeResume: true,
    continueRefusal: (_row) => 'This work carries on by itself when its time or event comes, or when a slot is free. Stop it if it is no longer needed.',
    waitsOnOwner: (_row, _facts) => false, needsOwner: (_row, _facts) => false,
    takesNotes: (_row) => true, noteRefusal: 'waiting',
    line: (row, facts) => {
      const wait = facts.store().workWait(row.id)
      return row.endReason === 'wait_ready' ? { status: 'queued' } : { status: 'paused', ...(wait ? { wait: { dueAt: wait.dueAt, event: wait.event } } : {}) }
    },
    clearLiveChip: true, republishQuestion: false
  },
  question: {
    weekExemptWhenReady: false, rank: 0, reasons: ['question', 'question_answered'], allows: workOnly,
    ready: (row, _facts) => row.endReason === 'question_answered',
    stranded: (row, facts) => !facts.questionExists(row),
    endReason: 'question_gone', endLine: questionGoneText, resume: 'continue', continuation: (_row, _facts) => ({ questionAnswered: true }), checkBeforeResume: true,
    continueRefusal: (row) => row.endReason === 'question_answered'
      ? 'This work has your answer. It carries on when the work before it is done.' : QUESTION_WORK_WAITING_TEXT,
    waitsOnOwner: (row, _facts) => row.endReason === 'question',
    needsOwner: (row, facts) => {
      const question = facts.store().workQuestion(row.id)
      return row.endReason === 'question' && question?.status === 'open' && question.messageId !== null
    },
    takesNotes: (row) => row.endReason !== 'question', noteRefusal: 'question',
    line: (row, _facts) => row.endReason === 'question_answered' ? { status: 'queued' } : { status: 'paused', ...(row.status === 'blocked' ? { waitsFor: 'answer' } : {}) },
    clearLiveChip: false, republishQuestion: true
  },
  budget_exhausted: {
    weekExemptWhenReady: false, rank: 0, reasons: ['budget_exhausted', 'room_allowed'], allows: workOnly,
    ready: (row, _facts) => row.endReason === 'room_allowed',
    stranded: (row, facts) => row.endReason === 'budget_exhausted' && facts.roomStranded(row),
    endReason: 'nothing_to_wait_for', endLine: nothingToWaitFor, resume: 'continue', continuation: (_row, _facts) => ({ moreRoom: true }), checkBeforeResume: false,
    continueRefusal: (row) => row.endReason === 'room_allowed'
      ? 'This work already has more room. It carries on when the work before it is done.'
      : 'This work ran out of room. Answer its ask to let it carry on, or stop it.',
    waitsOnOwner: (row, facts) => facts.store().openAsks(row.botId).some((ask) => ask.activationId === row.id),
    needsOwner: (row, facts) => facts.store().openAsks(row.botId).some((ask) => ask.activationId === row.id && ask.messageId !== null),
    takesNotes: (_row) => true, noteRefusal: 'held',
    line: (row, _facts) => ({ status: row.endReason === 'room_allowed' ? 'queued' : 'paused' }),
    clearLiveChip: false, republishQuestion: false
  },
  usage_limit: {
    weekExemptWhenReady: false, rank: 0, reasons: ['usage_limit'], allows: workOnly,
    ready: (row, facts) => facts.usageResumable(row),
    stranded: (row, facts) => facts.usageStranded(row),
    endReason: 'nothing_to_wait_for', endLine: nothingToWaitFor, resume: 'usageReset', continuation: (_row, _facts) => ({ usageReset: true }), checkBeforeResume: false,
    continueRefusal: (_row) => 'This work waits for a usage limit to reset. It carries on then, or press Resume to try now.',
    waitsOnOwner: (_row, _facts) => false,
    needsOwner: (_row, _facts) => false,
    takesNotes: (_row) => true, noteRefusal: 'held',
    line: (_row, _facts) => ({ status: 'paused' }),
    clearLiveChip: true, republishQuestion: false
  }
} satisfies Record<string, WaitRule>
export type WorkWaitReason = keyof typeof WORK_WAIT_RULES

export function workWaitRule(row: Pick<BotActivationRow, 'endReason'>): WaitRule | undefined {
  return Object.values(WORK_WAIT_RULES).find((rule) => rule.reasons.some((reason) => reason === row.endReason))
}
export const BOT_WORK_WAIT_REASONS: ReadonlySet<string> = new Set(Object.values(WORK_WAIT_RULES).flatMap((rule) => rule.reasons))
export function workWaits(row: Pick<BotActivationRow, 'status' | 'lane' | 'trigger' | 'endReason'>): boolean {
  return row.status === 'blocked' && Boolean(workWaitRule(row)?.allows(row))
}

/** The same decision serves lane admission and the continuation path, for all parked reasons. */
export function workReadiness(row: BotActivationRow, facts: WorkWaitFacts): { ready: boolean } {
  const rule = workWaitRule(row)
  return rule?.ready(row, facts) ? { ready: true } : { ready: false }
}

/** Preserve the old projection even on a queued or paused row with a retained end reason. */
export function workWaitLine(row: BotActivationRow, facts: WorkWaitLookups): WorkWaitLine {
  const line = workWaitRule(row)?.line(row, facts)
  if (row.status === 'queued' || line?.status === 'queued') return { status: 'queued' }
  if (row.status === 'paused' || row.status === 'blocked') return line ?? { status: 'paused' }
  return { status: row.offline ? 'waiting_for_internet' : 'running' }
}

/** Keep shown asks/chat questions as independent sources; parked reasons add their own shown owner attention. */
export function parkedNeedsOwner(rows: readonly BotActivationRow[], facts: WorkWaitLookups): boolean {
  return rows.some((row) => {
    const rule = workWaitRule(row)
    return workWaits(row) && Boolean(rule?.waitsOnOwner(row, facts) && rule.needsOwner(row, facts))
  })
}
