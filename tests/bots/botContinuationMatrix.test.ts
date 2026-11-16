import { afterEach, beforeEach, expect, it } from 'vitest'
import golden from './fixtures/continuationMaster.json'
import { botFixture, type BotFixture } from './botFixture'
import { CELLS, REASONS, ROW, NOTE, ANSWER, REPLAY, matrixInput, eventsOf } from './fixtures/continuationMatrix'

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

it.each(REASONS)('%s with a live wait keeps the master reason before the wait and remaining updates', reason => {
  const input = matrixInput(reason, 'note', true)
  const why = 'Continue comparing the flats with the evidence already read.'
  const waitText = `[Mousse] A work wait you set at 09:00 is due.\n\nWhat you wrote for yourself: ${why}`
  input.workEvents = [{ at: '2026-11-07T09:00:00Z', text: waitText }, ...eventsOf(input)]
  input.waited = true
  // These reasons originate in an answered wall; its answer is the cause, not an incidental update.
  input.answerCaused = ['wall Allow', 'wall Not now', 'question re-asked'].includes(reason)
  const prompt: string = (f.bots as any).continuationPrompt(ROW, input, reason === 'replay' ? REPLAY : undefined)
  const opening = reference[`${reason} / note`]!.split('\n\n')[0]
  expect(prompt.split('\n\n')[0]).toBe(`${opening} Your wait is over.`)
  expect(prompt.split(why)).toHaveLength(2)
  expect(prompt.split(NOTE)).toHaveLength(2)
  expect(prompt.indexOf(why)).toBeLessThan(prompt.indexOf(NOTE))
  if (input.answered) expect(prompt.split(ANSWER)).toHaveLength(2)
  for (const answer of input.answers) {
    const line = answer.status === 'denied' ? 'The owner said not now: run commands.' : 'The owner allowed: run commands.'
    expect(prompt.split(line)).toHaveLength(2)
  }
  if (reason === 'replay') expect(prompt).toContain(REPLAY)
})
