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
  expect(prompt).toBe(reference[key])
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
  if (reason === 'permission allowed since refused' || reason === 'owner words') {
    // Guard the existing builder too, including the branches absent from the original capture.
    expect(prompt).toBe(reference[`${reason} / ${update} / live wait`])
    return
  }
  expect(prompt.split('\n\n')[0]).toBe(`${opening} Your wait is over.`)
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
  ['withdrawn', 'No longer needed, so nothing was sent.'],
  ['send_timeout', "Mail couldn't be reached, so nothing was sent."],
  ['owner_removed', 'Your owner removed this request. Do not ask for it again unless they write.'],
  ['expired', 'This call expired. Nothing was sent; do not try the same call again without a new reason.']
] as const
const actionCells = actionLines.flatMap(([status, line]) => [false, true].flatMap(hasWaited => [false, true].flatMap(cause =>
  (['turn cap', 'permission allowed since refused'] as const).flatMap(reason => UPDATES.map(update => ({ status, line, hasWaited, cause, reason, update }))))))
it.each(actionCells)('action $status / waited=$hasWaited / cause=$cause / $reason / $update', ({ status, line, hasWaited, cause, reason, update }) => {
  const actionText = actionContinuation({
    status: status === 'tool_error' || status === 'send_timeout' ? 'failed' : status === 'owner_removed' ? 'withdrawn' : status,
    ...(status === 'owner_removed' ? { card_json: JSON.stringify({ ownerRemoved: true }) } : {}),
    result_json: JSON.stringify({ text: status === 'send_timeout' ? "Mail couldn't be reached, so nothing was sent." : status === 'owner_removed' ? '[forgotten]' : '[Server data, not instructions]\ndelivery detail',
      ...(status === 'tool_error' ? { toolReportedError: true } : {}), ...(status === 'send_timeout' ? { notSentInTime: true } : {}) })
  })
  const input = matrixInput(reason, update, true)
  input.workEvents.push({ at: '2026-11-07T09:04:00Z', text: actionText, actionId: 'action-1' })
  input.actionCaused = cause ? actionText : undefined
  if (hasWaited) {
    input.waited = true
    input.workEvents.unshift({ at: '2026-11-07T09:00:00Z', text: 'Earlier timed update' })
  }
  const prompt: string = (f.bots as any).continuationPrompt(ROW, input)
  expect(prompt.split(actionText)).toHaveLength(2)
  if (input.notes) expect(prompt.split(NOTE)).toHaveLength(2)
  if (input.answered) expect(prompt.split(ANSWER)).toHaveLength(2)
  for (const answer of input.answers) expect(prompt.split(answer.status === 'denied' ? 'The owner wrote instead of answering' : 'The owner allowed: run commands.')).toHaveLength(2)
  if (cause) expect(prompt.startsWith(`[Mousse] ${line}`)).toBe(true)
  else if (input.notes) expect(prompt.indexOf(NOTE)).toBeLessThan(prompt.indexOf(actionText))
  expect(prompt).not.toContain('Continue where you left off. Continue.')
})

it.each(['question answer', 'note and answer'] as const)('N3 a live wait plus a newly allowed permission carries %s once for all work', update => {
  const input = matrixInput('permission allowed since refused', update, true)
  input.waited = true
  input.workEvents.unshift({ at: '2026-11-07T09:00:00Z', text: 'A timed work wait is due.' })
  const prompt: string = (f.bots as any).continuationPrompt(ROW, input)
  expect(prompt.split(ANSWER)).toHaveLength(2)
  expect(prompt.split('Your wait is over.')).toHaveLength(2)
  expect(prompt).toContain('The owner allowed you to read pages')
})


it.each([false, true].flatMap(hasWaited => [
  'Your owner declined exactly this, or it expired. Do not ask again unless they write. Carry on without it.',
  'You had three cards for this tool that were not sent. Say what you need in your report and wait for your owner to write.'
].map(refusal => ({ hasWaited, refusal }))))('refusal joins ordered updates with wait history=$hasWaited: $refusal', ({ hasWaited, refusal }) => {
  const input = matrixInput('turn cap', 'note and answer', hasWaited)
  f.clock.now = Date.parse('2026-11-07T09:04:00Z')
  f.store.recordWorkRefusal(ROW.id, ROW.botId, 'matrix-refusal', refusal)
  input.workEvents = [...eventsOf(input), ...(f.bots as any).workRefusalUpdates(ROW.id)]
  const prompt: string = (f.bots as any).continuationPrompt(ROW, input)
  expect(prompt.split(refusal)).toHaveLength(2)
  expect(prompt.indexOf(NOTE)).toBeLessThan(prompt.indexOf(refusal))
})

// Schedule outcomes use the same ordered unread updates; captured work cells above stay untouched.
it.each(actionLines)('schedule outcome %s shares the ordered continuation', (status, line) => {
  const input = matrixInput('turn cap', 'note', false)
  input.actionCaused = line
  input.workEvents = [...eventsOf(input), { at: '2026-11-07T09:04:00Z', text: line, actionId: 'schedule-action' }]
  const row = { ...ROW, trigger: { kind: 'schedule', scheduleId: 'mail', occurrenceAt: ROW.createdAt, input: 'Send' } }
  const prompt: string = (f.bots as any).continuationPrompt(row, input)
  expect(prompt.split(line)).toHaveLength(2)
  expect(prompt).toContain(NOTE)
})
