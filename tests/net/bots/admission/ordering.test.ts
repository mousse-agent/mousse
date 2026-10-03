import { afterEach, expect, it } from 'vitest'
import { BotOutbox } from '../../../../src/mms/bots/admission'
import { canonicalJson, decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import type { EventId } from '../../../../src/shared/net'
import { cleanup } from '../../spaces/host/helpers'
import { setup } from './helpers'
afterEach(cleanup)
it('keeps signed accepted, progress and completed receipts in durable enqueue order at the same millisecond', async () => {
  const f = await setup(),
    output = f.service.options.output as BotOutbox,
    original = output.prepareAccepted.bind(output)
  function withId(event: ReturnType<BotOutbox['prepareAccepted']>, id: EventId) {
    const envelope = canonicalJson({ ...decodeEnvelope(event.envelope).envelope, id })
    return { ...event, id, envelope, sig: f.p.keys.signAsBot(f.bot, envelope) }
  }
  output.prepareAccepted = (...args) => withId(original(...args), 'evt_7zzzzzzzzzzzzzzzzzzzzzzzzz')
  const admitted = f.service.admit(f.message()).record,
    mention = f.service.mentionForExecution(admitted.id)
  const progress = withId(
      output.prepareTerminal(mention, admitted.id, admitted.binding!, 'bot.run.progress', {
        text: 'Progress'
      }),
      'evt_40000000000000000000000000'
    ),
    completed = withId(
      output.prepareTerminal(mention, admitted.id, admitted.binding!, 'bot.run.completed', {
        text: 'Done'
      }),
      'evt_00000000000000000000000000'
    )
  f.p.db.transaction(() => {
    output.enqueueTerminal(admitted, progress)
    output.enqueueTerminal(admitted, completed)
  })
  const queued = f.outbox.due(admitted.binding!.stream)
  expect(new Set(queued.map((e) => e.createdAt)).size).toBe(1)
  expect(queued.map((e) => decodeEnvelope(e.envelope).envelope.type)).toEqual([
    'bot.run.accepted',
    'bot.run.progress',
    'bot.run.completed'
  ])
})
