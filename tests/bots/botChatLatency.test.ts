/**
 * The owner's message starts its turn's internet check as it is taken, beside the model and context work, and the turn's
 * first check takes that round instead of probing again. A round kept too long, or for another entry, is not taken; a
 * failed one is still confirmed by a fresh round, as a check of the turn's own is.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CHAT_CHECK_KEPT_MS } from '../../src/mms/bots/activation/BotEngine'
import { botFixture, createBot, flush, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string
/** In order: each internet check (`check`, `fresh`) and each model resolve (`resolve`). */
let events: string[]
let next: boolean[]
let release: () => void

beforeEach(async () => {
  f = botFixture()
  botId = (await createBot(f, { name: 'Noobesh', reply: 'Hello.' })).botId
  events = []
  next = []
  f.host.connectivity = {
    online: async ({ fresh }) => {
      events.push(fresh ? 'fresh' : 'check')
      return next.shift() ?? true
    }
  }
  // The model resolve waits until the test lets it go, so the check started with the message is still pending.
  const resolve = f.host.models.resolve
  f.host.models.resolve = async (input) => {
    events.push('resolve')
    await new Promise<void>((done) => { release = done })
    return resolve(input)
  }
})

afterEach(() => f.close())

async function send(during: () => void = () => {}): Promise<string> {
  const sent = f.bots.service.chatSend({ botId, text: 'What changed today?', clientRequestId: 'owner' })
  await flush()
  during()
  release()
  await sent
  await flush(16)
  return f.store.laneActivations(botId, 'chat', ['running'])[0]!.id
}

describe('the owner\'s message starts its turn\'s internet check', () => {
  it.each([
    { name: 'its turn takes that round: one check, started before the model', during: () => {}, answers: [], seen: ['check', 'resolve'] },
    { name: 'a round older than it is kept for: the turn checks again', during: () => { f.clock.now += CHAT_CHECK_KEPT_MS }, answers: [], seen: ['check', 'resolve', 'check'] },
    { name: 'a failed round: confirmed by one fresh round, then sent', during: () => {}, answers: [false], seen: ['check', 'resolve', 'fresh'] }
  ])('$name', async ({ during, answers, seen }) => {
    next = [...answers]
    const activationId = await send(during)
    expect(events).toEqual(seen)
    expect(f.store.dispatch(activationId, 1)!.runId).not.toBeNull()
  })

  it('a round for another entry than the turn runs on is not taken', async () => {
    const other = { instanceId: 'pi:other', model: 'other-model' }
    f.candidates = [other]
    const activationId = await send()
    expect(f.store.activation(activationId)!.selection).toMatchObject({ instanceId: 'pi:other' })
    expect(events.filter((event) => event === 'check')).toHaveLength(2)
  })
})
