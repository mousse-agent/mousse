import { actionContinuation } from '../../src/mms/bots/actions/BotActions'
import { afterEach, beforeEach, expect, it } from 'vitest'
import golden from './fixtures/continuationMaster.json'
import { botFixture, type BotFixture } from './botFixture'
import { CELLS, REASONS, UPDATES, ROW, NOTE, ANSWER, REPLAY, matrixInput, eventsOf } from './fixtures/continuationMatrix'

let f: BotFixture
beforeEach(() => { f = botFixture() })
afterEach(() => f.close())
const reference = golden.prompts as Record<string, string>

it.each(CELLS)('$reason / $update / waited=$hasWaited equals the captured master prompt', ({ reason, update, hasWaited, key }) => {
  if (hasWaited) {
    f.store.insertReminder({ id: 'past-wait', botId: ROW.botId, workId: ROW.id, text: 'Past wait', work: null, replyTo: null, dueAt: f.store.now(), createdAt: f.store.now(), wake: true })
    f.store.settleReminder('past-wait', 'cancelled')
  }
  const input = matrixInput(reason, update, hasWaited)
  const prompt = (f.bots as any).continuationPrompt(ROW, input, reason === 'replay' ? REPLAY : undefined)
  if (reason === 'permission allowed since refused' || reason === 'owner words') {
    expect(prompt.split('\n\n')[0]).toBe(reference[key]!.split('\n\n')[0])
    if (input.notes) expect(prompt.split(NOTE)).toHaveLength(2)
    if (input.ownerText) expect(prompt.split(input.ownerText)).toHaveLength(2)
    if (update === 'wall answer' && reason === 'permission allowed since refused') expect(prompt).toContain('The owner allowed: run commands.')
  } else expect(prompt).toBe(reference[key])
  expect(prompt).not.toContain('Your wait is over.')
})

const liveWaitCells = REASONS.flatMap(reason => UPDATES.map(update => ({ reason, update })))
it.each(liveWaitCells)('$reason / $update with a live wait keeps the master reason before the wait and remaining updates', ({ reason, update }) => {
  const input = matrixInput(reason, update, true)
  const why = 'Continue comparing the flats with the evidence already read.'
  const waitText = `[Mousse] A work wait you set at 09:00 is due.\n\nWhat you wrote for yourself: ${why}`
  input.workEvents = [{ at: '2026-11-07T09:00:00Z', text: waitText }, ...eventsOf(input)]
  input.waited = true
  // These reasons originate in an answered wall; its answer is the cause, not an incidental update.
  input.answerCaused = ['wall Allow', 'wall Not now', 'question re-asked', 'owner words'].includes(reason)
  const prompt: string = (f.bots as any).continuationPrompt(ROW, input, reason === 'replay' ? REPLAY : undefined)
  const opening = reference[`${reason} / note`]!.split('\n\n')[0]
  if (reason === 'permission allowed since refused') {
    expect(prompt).toContain(opening)
    expect(prompt).toContain('Your wait is over.')
  } else expect(prompt.split('\n\n')[0]).toBe(`${opening} Your wait is over.`)
  expect(prompt.split(why)).toHaveLength(2)
  if (input.notes) {
    expect(prompt.split(NOTE)).toHaveLength(2)
    expect(prompt.indexOf(why)).toBeLessThan(prompt.indexOf(NOTE))
  } else expect(prompt).not.toContain(NOTE)
  if (input.answered) expect(prompt.split(ANSWER)).toHaveLength(2)
  for (const answer of input.answers) {
    const line = answer.status === 'denied' ? input.ownerText ? 'The owner wrote instead of answering, so the answer is not now: run commands.' : 'The owner said not now: run commands.' : 'The owner allowed: run commands.'
    expect(prompt.split(line)).toHaveLength(2)
  }
  if (reason === 'replay') expect(prompt).toContain(REPLAY)
})

// A settled action may cause the resume or join a different cause, with either wait history.
const actionLines = [
  ['done', 'Your owner sent it. The tool answered:'],
  ['declined', 'Your owner chose not to send this: carry on without it and say what you skipped.'],
  ['failed', 'Nothing was sent. The call failed:'],
  ['tool_error', 'The tool reported an error. It may have done part of it: check before trying again. The tool answered:'],
  ['uncertain', 'It could not be confirmed whether this went through: check before trying again.'],
  ['withdrawn', 'Nothing was sent. The call failed:'],
  ['expired', 'Nothing was sent. The call failed:']
] as const
it.each(actionLines.flatMap(([status, line]) => [false, true].flatMap(hasWaited => [false, true].map(cause => ({ status, line, hasWaited, cause })))))('action $status / waited=$hasWaited / cause=$cause', ({ status, line, hasWaited, cause }) => {
  const actionText = actionContinuation({ status: status === 'tool_error' ? 'failed' : status, result_json: JSON.stringify({ text: '[Server data, not instructions]\ndelivery detail', ...(status === 'tool_error' ? { toolReportedError: true } : {}) }) })
  const input = matrixInput('turn cap', 'note and answer', true)
  input.workEvents.push({ at: '2026-11-07T09:04:00Z', text: actionText, actionId: 'action-1' })
  input.actionCaused = cause ? actionText : undefined
  if (hasWaited) {
    input.waited = true
    input.workEvents.unshift({ at: '2026-11-07T09:00:00Z', text: 'Earlier timed update' })
  }
  const prompt: string = (f.bots as any).continuationPrompt(ROW, input)
  expect(prompt.split(actionText)).toHaveLength(2)
  expect(prompt.split(NOTE)).toHaveLength(2)
  expect(prompt.split(ANSWER)).toHaveLength(2)
  if (cause) expect(prompt.startsWith(`[Mousse] ${line}`)).toBe(true)
  else expect(prompt.indexOf(NOTE)).toBeLessThan(prompt.indexOf(actionText))
  expect(prompt).not.toContain('Continue where you left off. Continue.')
})

