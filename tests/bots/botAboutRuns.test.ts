/**
 * About → Automations shows what each automation is: its name, what each run does in its own words, and when its last
 * run ended and how. Rows: never ran; ran to the end; failed; stopped; a later run after an earlier one; a fixed line
 * (its label already says it, so no words of its own); one schedule's runs never show on another.
 */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { botFixture, createBot, runDispatch, T0, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string
beforeEach(async () => {
  f = botFixture()
  ;({ botId } = await createBot(f, { reply: 'Hi.' }))
  await f.bots.reconcileOnStartup()
})
afterEach(() => f.close())

const runsOf = () => f.bots.service.get(botId).runs
const scheduleRuns = (scheduleId: string) => f.store.listActivations(botId).filter((row) => row.trigger.kind === 'schedule' && row.trigger.scheduleId === scheduleId)

it('names each automation and says what its runs do; before a run there is no last run', () => {
  const digest = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 60 }, name: 'Morning PR digest', prompt: 'Read open PRs\n\nand tell me which need me.' }, 'owner')
  const pills = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 120 }, say: 'Take your pills' }, 'owner')
  const runs = runsOf()
  expect(runs.find((run) => run.id === digest.scheduleId)).toMatchObject({ name: 'Morning PR digest', does: 'Read open PRs and tell me which need me.' })
  expect(runs.find((run) => run.id === digest.scheduleId)?.lastAt).toBeUndefined()
  // A fixed line: its label says it, and it has no words of its own.
  expect(runs.find((run) => run.id === pills.scheduleId)?.label).toContain('Take your pills')
  expect(runs.find((run) => run.id === pills.scheduleId)?.does).toBeUndefined()
})

it('says when its last run ended and how, per schedule', async () => {
  const digest = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Check the price.' }, 'owner')
  const other = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 60 }, prompt: 'Other check.' }, 'owner')
  await f.tickSchedules(new Date(T0 + 5 * 60_000))
  const first = scheduleRuns(digest.scheduleId)[0]!
  await runDispatch(f, first.id)
  const ended = f.store.activation(first.id)!
  expect(ended.status).toBe('done')
  expect(runsOf().find((run) => run.id === digest.scheduleId)).toMatchObject({ lastAt: ended.endedAt, lastOutcome: 'ok' })
  expect(runsOf().find((run) => run.id === other.scheduleId)?.lastAt).toBeUndefined()

  // A later run: how it ended is what About says, failed or stopped, never the earlier run's.
  await f.tickSchedules(new Date(T0 + 10 * 60_000))
  const second = scheduleRuns(digest.scheduleId).find((row) => row.id !== first.id)!
  await runDispatch(f, second.id)
  for (const [status, outcome] of [['failed', 'failed'], ['cancelled', 'stopped']] as const) {
    const at = new Date(Date.parse(ended.endedAt!) + 60_000).toISOString()
    f.store.run('UPDATE bot_activations SET status = ?, ended_at = ? WHERE id = ?', status, at, second.id)
    expect(runsOf().find((run) => run.id === digest.scheduleId)).toMatchObject({ lastAt: at, lastOutcome: outcome })
  }
  expect(runsOf().find((run) => run.id === other.scheduleId)?.lastAt).toBeUndefined()
})
