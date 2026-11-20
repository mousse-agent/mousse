/**
 * A bot's browser notice ("I have my browser back …") shows once in a row: a second hold that ends the same way while
 * the chat still shows that line (another window gone, the app restarted) adds no copy of it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { HOLD_EXPIRED_NOTICE } from '../../src/mms/bots/browser/BotBrowsers'
import { BotChatProjection } from '../../src/mms/bots/chat/projection'
import { BotStore } from '../../src/mms/bots/store/BotStore'

let home: string
let store: BotStore
let chat: BotChatProjection
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'bot-notice-once-'))
  store = new BotStore({ profileHome: home, clock: () => Date.UTC(2026, 10, 19, 10, 0) })
  chat = new BotChatProjection({ store, emit: () => {} })
})
afterEach(() => {
  store.close()
  rmSync(home, { recursive: true, force: true })
})

const notice = () => chat.post({ botId: 'ada', author: 'bot', kind: 'notice', text: HOLD_EXPIRED_NOTICE, unlessLatest: true })
const texts = () => store.messages('ada', { limit: 10 }).map((row) => row.text)

it('a browser notice is not posted again while it is still the chat\'s latest line', () => {
  notice()
  notice()
  expect(texts()).toEqual([HOLD_EXPIRED_NOTICE])

  // After the chat moved on, a later hold that ends the same way says so again.
  chat.post({ botId: 'ada', author: 'owner', kind: 'text', text: 'Thanks' })
  notice()
  expect(texts()).toEqual([HOLD_EXPIRED_NOTICE, 'Thanks', HOLD_EXPIRED_NOTICE])
})
