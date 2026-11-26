/**
 * The engine marks a run's authority `ownerRequested` only for work its owner asked for in the chat: the work run the
 * owner's chat message started, not the chat turn itself, a run started by hand, or a subagent of that work. Only those
 * runs may ask the owner to set up computer use (`computer_use_request`).
 */
import { afterEach, expect, it } from 'vitest'
import { botFixture, createBot, start, type BotFixture, startSubagent, subagentRuns } from './botFixture'

let f: BotFixture
afterEach(() => f?.close())

it("is set for the work the owner's chat message started, and for nothing else", async () => {
  f = botFixture()
  const { botId } = await createBot(f, { name: 'Designer', reply: 'On it.' })
  await f.bots.service.chatSend({ botId, text: 'Export the logo from Figma', clientRequestId: 'chat' })
  const chat = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  expect((await start(f, chat.id)).prepared.authority.ownerRequested).toBeUndefined()

  const work = await f.bots.tools.work.start(botId, chat.id, { title: 'Logo', brief: 'Export the logo from Figma', key: 'work' })
  const run = await start(f, work.workId)
  expect(run.prepared.authority.ownerRequested).toBe(true)
  await run.prepared.authority.subagents!.start({ title: 'Look', brief: 'Find the file' })
  expect((await startSubagent(f, subagentRuns(f, work.workId)[0]!)).prepared.authority.ownerRequested).toBeUndefined()

  const manual = await f.bots.activate({ botId, input: 'Export the logo', clientRequestId: 'manual' })
  expect((await start(f, manual.id)).prepared.authority.ownerRequested).toBeUndefined()
})

it('is not set for that work once its stored start reads as unknown, as the turn-kind table says', async () => {
  f = botFixture()
  const { botId } = await createBot(f, { name: 'Designer', reply: 'On it.' })
  await f.bots.service.chatSend({ botId, text: 'Export the logo from Figma', clientRequestId: 'chat' })
  const chat = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  await start(f, chat.id)
  const work = await f.bots.tools.work.start(botId, chat.id, { title: 'Logo', brief: 'Export the logo from Figma', key: 'work' })
  f.store.run("UPDATE bot_activations SET provenance = 'owner_voice' WHERE id = ?", work.workId)
  expect((await start(f, work.workId)).prepared.authority.ownerRequested).toBeUndefined()
})
