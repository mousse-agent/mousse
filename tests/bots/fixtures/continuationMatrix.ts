import type { BotActivationRow, BotEscalationRow } from '../../../src/mms/bots/store/BotStore'

export const MASTER_COMMIT = 'da8d8f5d111942d8993dcc8a231e31beee23c253'
export const NOTE = 'Read the release notes next.'
export const NOTE_TEXT = `The owner added while you worked:\n- ${NOTE}`
export const ANSWER = 'Your owner answered your question "Which flat?": A.'
export const REPLAY = 'The original task never reached the provider.'
export const REASONS = ['turn cap', 'more room', 'restart', 'reload', 'internet back', 'usage reset', 'updated report', 'question answered', 'question re-asked', 'wall Allow', 'wall Not now', 'replay', 'permission switched off'] as const
export const UPDATES = ['none', 'note', 'question answer', 'wall answer', 'note and answer'] as const
export type Reason = typeof REASONS[number]
export type Update = typeof UPDATES[number]
export const ROW = { id: 'matrix-work', botId: 'matrix-bot', lane: 'run', modelOverride: null, trigger: { kind: 'work', input: 'Compare flats', title: 'Flats', from: 'chat' } } as BotActivationRow

export function wall(status: 'allowed_bot' | 'denied' = 'allowed_bot'): BotEscalationRow {
  return { id: 'matrix-wall', botId: ROW.botId, activationId: ROW.id, dispatchN: 1, kind: 'escalate', permission: { tool: 'shell' }, status, title: 'run commands', note: '', mode: 'wall', createdAt: '2026-11-07T09:00:00Z', answeredAt: '2026-11-07T09:01:00Z', amount: null, appliedAt: null, expiresAt: null, messageId: null, toolCallId: null, cooldownUntil: null, fingerprint: 'matrix' }
}

// Update columns are additions to the causal event. A causal question/wall answer is shared,
// rather than inventing a second simultaneously-open question or a duplicate answer to one wall.
export function matrixInput(reason: Reason, update: Update, ordered: boolean): any {
  const input: any = { answers: [] }
  const flag: Partial<Record<Reason, string>> = { 'turn cap': 'turnCap', 'more room': 'moreRoom', restart: 'restart', reload: 'reload', 'internet back': 'network', 'usage reset': 'usageReset', 'updated report': 'afterReport', replay: 'restart', 'permission switched off': 'switchCut' }
  if (flag[reason]) input[flag[reason]!] = true
  if (reason === 'question answered') Object.assign(input, { questionAnswered: true, answered: ANSWER })
  if (reason === 'question re-asked') Object.assign(input, { answers: [wall()], askAgain: ['Which release?'] })
  if (reason === 'wall Allow') input.answers = [wall()]
  if (reason === 'wall Not now') input.answers = [wall('denied')]
  if (update === 'note' || update === 'note and answer') input.notes = NOTE_TEXT
  if (update === 'question answer' || update === 'note and answer') input.answered = ANSWER
  if (update === 'wall answer' && !input.answers.length) input.answers = [wall()]
  if (ordered) input.workEvents = eventsOf(input)
  return input
}

export function eventsOf(input: any): any[] {
  return [
    ...input.answers.map((answer: BotEscalationRow) => ({ at: answer.answeredAt!, answer })),
    ...(input.notes ? [{ at: '2026-11-07T09:02:00Z', text: input.notes }] : []),
    ...(input.answered ? [{ at: '2026-11-07T09:03:00Z', text: input.answered }] : [])
  ]
}
export const CELLS = REASONS.flatMap(reason => UPDATES.flatMap(update => [false, true].map(hasWaited => ({ reason, update, hasWaited, key: `${reason} / ${update}` }))))
