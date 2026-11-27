/**
 * What another device's bots feed says about telling, from the real bot store: how far the chat is read, its newest
 * message, and the unread now/soon messages that still want the owner (`BotEngine.feedTelling`). And a deleted bot is
 * announced at once, before its runs are stopped, so a device reading its chat hears that it is gone.
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { botsFeedSource } from '../../src/mms/bridge/remote/BotStreamSources'
import { botFixture, createBot, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string
beforeEach(async () => {
  f = botFixture()
  await f.bots.reconcileOnStartup()
  ;({ botId } = await createBot(f))
})
afterEach(() => f.close())

it('lists the unread now and soon messages, newest first, and none that is read, quiet or the owner\'s', () => {
  const owner = f.bots.chat.post({ botId, author: 'owner', kind: 'text', text: 'Check the servers' })
  const early = f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: 'Looking' })
  f.bots.markRead(botId, early.seq)
  const soon = f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: 'One is down' })
  const later = f.bots.chat.post({ id: 'bm_x_offline', botId, author: 'bot', kind: 'notice', text: 'Waiting for internet' })
  const now = f.bots.chat.post({ botId, author: 'bot', kind: 'text', text: 'Restart it?' })
  f.store.run("UPDATE bot_messages SET tell = 'now' WHERE id = ?", now.id)
  expect([owner, early, soon, later, now].map((m) => f.store.message(m.id)?.tell)).toEqual([null, 'soon', 'soon', 'later', 'now'])

  const telling = f.bots.feedTelling(botId)
  expect(telling).toEqual({
    readSeq: early.seq,
    latest: { id: now.id, seq: now.seq, author: 'bot', tell: 'now' },
    attention: [now.id, soon.id]
  })

  // The feed row another device reads carries the same.
  const feed = botsFeedSource({ personalBots: f.bots, orchestrator: new EventEmitter() }, 'nod_pocket').snapshot() as {
    bots: Array<{ id: string; readSeq: number; telling: unknown }>
  }
  expect(feed.bots.find((bot) => bot.id === botId)).toMatchObject({
    readSeq: early.seq,
    telling: { latest: { id: now.id, tell: 'now' }, attention: [now.id, soon.id] }
  })

  // Read on any device: nothing wants the owner any more.
  f.bots.markRead(botId, now.seq)
  expect(f.bots.feedTelling(botId)).toMatchObject({ readSeq: now.seq, attention: [] })
})

it('announces a deleted bot before its runs are stopped', async () => {
  let release!: (quiet: boolean) => void
  // Its runs take their time to stop, as a hung provider does (up to 15 seconds).
  vi.spyOn(f.bots as unknown as { stopAndWait(): Promise<boolean> }, 'stopAndWait').mockReturnValue(new Promise((resolve) => { release = resolve }))
  const changed: unknown[] = []
  f.bots.events.on('changed', (event) => changed.push(event))
  const removing = f.bots.remove(botId)
  expect(changed).toContainEqual({ botId })
  release(true)
  await removing
})
