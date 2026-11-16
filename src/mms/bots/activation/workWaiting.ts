import type { BotActivationRow } from '../store/BotStore'
import type { BotWorkItem } from '../../../shared/bots/personal/chat'
import { questionGoneText } from '../../../shared/bots/personal/questions'

/** Facts supplied by the engine; the rules themselves neither write nor hold engine state. */
export interface WorkWaitFacts {
  usageResumable(row: BotActivationRow): boolean
  questionExists(row: BotActivationRow): boolean
  roomStranded(row: BotActivationRow): boolean
  usageStranded(row: BotActivationRow): boolean
}
interface WaitRule {
  /** Stored end reasons, including the marker written by the wake source before a slot is free. */
  reasons: readonly string[]
  allows(row: Pick<BotActivationRow, 'lane' | 'trigger'>): boolean
  wake: string
  ready(row: BotActivationRow, facts: WorkWaitFacts): boolean
  stranded(row: BotActivationRow, facts: WorkWaitFacts): boolean
  endReason: string
  endLine(title: string): string
  resume: 'continue' | 'usageReset'
  continuation: { questionAnswered?: boolean; moreRoom?: boolean }
  checkBeforeResume: boolean
  line(row: BotActivationRow): Pick<BotWorkItem, 'status' | 'waitsFor'>
  clearLiveChip: boolean
  republishQuestion: boolean
}
const workOnly: WaitRule['allows'] = (row) => row.lane === 'run' && row.trigger.kind === 'work'
const nothingToWaitFor = (title: string) => `I stopped "${title}": nothing could let it carry on any more. Ask me again if you still want it.`

/** One row per reason. Wake sources keep their existing transactions, messages and stored markers. */
export const WORK_WAIT_RULES = {
  question: {
    reasons: ['question', 'question_answered'], allows: workOnly, wake: 'tap, reply, default',
    ready: (row, _facts) => row.endReason === 'question_answered',
    stranded: (row, facts) => !facts.questionExists(row),
    endReason: 'question_gone', endLine: questionGoneText, resume: 'continue', continuation: { questionAnswered: true }, checkBeforeResume: true,
    line: (row) => row.endReason === 'question_answered' ? { status: 'queued' } : { status: 'paused', ...(row.status === 'blocked' ? { waitsFor: 'answer' } : {}) },
    clearLiveChip: false, republishQuestion: true
  },
  budget_exhausted: {
    reasons: ['budget_exhausted', 'room_allowed'], allows: workOnly, wake: 'Allow',
    ready: (row, _facts) => row.endReason === 'room_allowed',
    stranded: (row, facts) => row.endReason === 'budget_exhausted' && facts.roomStranded(row),
    endReason: 'nothing_to_wait_for', endLine: nothingToWaitFor, resume: 'continue', continuation: { moreRoom: true }, checkBeforeResume: false,
    line: (row) => ({ status: row.endReason === 'room_allowed' ? 'queued' : 'paused' }),
    clearLiveChip: false, republishQuestion: false
  },
  usage_limit: {
    reasons: ['usage_limit'], allows: workOnly, wake: 'reset time, Resume',
    ready: (row, facts) => facts.usageResumable(row),
    stranded: (row, facts) => facts.usageStranded(row),
    endReason: 'nothing_to_wait_for', endLine: nothingToWaitFor, resume: 'usageReset', continuation: {}, checkBeforeResume: false,
    line: (_row) => ({ status: 'paused' }),
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

/** The same decision serves lane admission and the continuation path, with the reason when it still waits. */
export function workReadiness(row: BotActivationRow, facts: WorkWaitFacts): { ready: boolean; waitingFor?: string } {
  const rule = workWaitRule(row)
  return rule?.ready(row, facts) ? { ready: true } : { ready: false, waitingFor: rule?.wake }
}

/** Preserve the old projection even on a queued or paused row with a retained end reason. */
export function workWaitLine(row: BotActivationRow): Pick<BotWorkItem, 'status' | 'waitsFor'> {
  const line = workWaitRule(row)?.line(row)
  if (row.status === 'queued' || line?.status === 'queued') return { status: 'queued' }
  if (row.status === 'paused' || row.status === 'blocked') return line ?? { status: 'paused' }
  return { status: row.offline ? 'waiting_for_internet' : 'running' }
}
