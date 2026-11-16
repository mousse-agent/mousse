import type { BotActivationRow, BotStore } from '../store/BotStore'
import type { BotWorkItem } from '../../../shared/bots/personal/chat'
import { questionGoneText, QUESTION_WORK_WAITING_TEXT } from '../../../shared/bots/personal/questions'

/** Read access for line text, continuation context and owner controls. Future wait/action readers belong here. */
export interface WorkWaitLookups {
  store(): Pick<BotStore, 'workQuestion' | 'openAsks' | 'get'>
}
export type WorkWaitLine = Pick<BotWorkItem, 'status' | 'waitsFor'> & { detail?: string }

/** Facts supplied by the engine; the rules themselves neither write nor hold engine state. */
export interface WorkWaitFacts {
  approvalReady(row: BotActivationRow): boolean
  approvalExists(row: BotActivationRow): boolean
  usageResumable(row: BotActivationRow): boolean
  questionExists(row: BotActivationRow): boolean
  roomStranded(row: BotActivationRow): boolean
  usageStranded(row: BotActivationRow): boolean
}
interface WaitRule {
  /** Stored end reasons, including the marker written by the wake source before a slot is free. */
  reasons: readonly string[]
  allows(row: Pick<BotActivationRow, 'lane' | 'trigger'>): boolean
  ready(row: BotActivationRow, facts: WorkWaitFacts): boolean
  stranded(row: BotActivationRow, facts: WorkWaitFacts): boolean
  endReason: string
  endLine(title: string): string
  resume: 'continue' | 'usageReset'
  continuation(row: BotActivationRow, facts: WorkWaitLookups): { questionAnswered?: boolean; moreRoom?: boolean; usageReset?: boolean; ownerText?: string; waitContext?: string }
  continueRefusal(row: BotActivationRow): string
  waitsOnOwner(row: BotActivationRow, facts: WorkWaitLookups): boolean
  needsOwner(row: BotActivationRow, facts: WorkWaitLookups): boolean
  takesNotes(row: BotActivationRow): boolean
  noteRefusal: 'question' | 'held' | 'approval'
  checkBeforeResume: boolean
  line(row: BotActivationRow, facts: WorkWaitLookups): WorkWaitLine
  clearLiveChip: boolean
  republishQuestion: boolean
}
const workOnly: WaitRule['allows'] = (row) => row.lane === 'run' && row.trigger.kind === 'work'
const nothingToWaitFor = (title: string) => `I stopped "${title}": nothing could let it carry on any more. Ask me again if you still want it.`

/** One row per reason. Wake sources keep their existing transactions, messages and stored markers. */
export const WORK_WAIT_RULES = {
  approval: {
    reasons: ['approval', 'approval_answered'], allows: workOnly,
    ready: (row, facts) => row.endReason === 'approval_answered' && facts.approvalReady(row),
    stranded: (row, facts) => !facts.approvalExists(row),
    endReason: 'action_gone', endLine: nothingToWaitFor, resume: 'continue', checkBeforeResume: true,
    continuation: (row, facts) => {
      const action = facts.store().get('SELECT status, result_json FROM bot_actions WHERE activation_id = ? ORDER BY rowid DESC LIMIT 1', row.id)
      const result = typeof action?.result_json === 'string' ? JSON.parse(action.result_json) as { text?: string } : undefined
      const line = action?.status === 'done' ? 'Your owner sent it. The tool answered:'
        : action?.status === 'declined' ? 'Your owner chose not to send this: carry on without it and say what you skipped.'
          : action?.status === 'uncertain' ? 'It could not be confirmed whether this went through: check before trying again.'
            : 'Nothing was sent. The call failed:'
      return { waitContext: `${line}${action?.status === 'done' || action?.status === 'failed' || action?.status === 'withdrawn' || action?.status === 'expired' ? `\n${result?.text ?? 'Carry on without it.'}` : ''}` }
    },
    continueRefusal: (row) => row.endReason === 'approval_answered' ? 'This work has your answer and carries on when a slot is free.' : 'This work waits for Send or Not now on its held action.',
    waitsOnOwner: (row, _facts) => row.endReason === 'approval',
    needsOwner: (row, facts) => Boolean(facts.store().get("SELECT 1 FROM bot_actions WHERE activation_id = ? AND status = 'open' AND message_id IS NOT NULL", row.id)),
    takesNotes: (row) => row.endReason !== 'approval', noteRefusal: 'approval',
    line: (row, _facts) => ({ status: row.endReason === 'approval_answered' ? 'queued' : 'paused', ...(row.endReason === 'approval' ? { waitsFor: 'answer' as const, detail: 'Send this action?' } : {}) }),
    clearLiveChip: true, republishQuestion: false
  },
  question: {
    reasons: ['question', 'question_answered'], allows: workOnly,
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
    reasons: ['budget_exhausted', 'room_allowed'], allows: workOnly,
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
    reasons: ['usage_limit'], allows: workOnly,
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
