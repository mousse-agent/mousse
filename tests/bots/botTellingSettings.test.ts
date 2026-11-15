import { afterEach, expect, it } from 'vitest'
import { botFixture, createBot } from './botFixture'
import { tellingClass } from '../../src/mms/bots/chat/telling'
import { tellingLine } from '../../src/shared/bots/personal/tellingSettings'
const fixtures: ReturnType<typeof botFixture>[] = []
afterEach(() => fixtures.splice(0).forEach(f => f.close()))
it('stores the owner’s wishes and shows the resulting line in About', async () => {
  const f = botFixture(); fixtures.push(f)
  await f.bots.reconcileOnStartup()
  const { botId } = await createBot(f)
  const turn = await f.bots.enqueueChat(botId, 'chat:tell-test', 'Only ping me if it needs me')
  const line = f.bots.setTelling(botId, turn.id, { tellMe: 'needs_you', canWakeMe: true })
  expect(JSON.parse(f.store.registry(botId)!.tellJson!)).toEqual({ tellMe: 'needs_you', canWakeMe: true })
  expect(line).toBe('Tells you when it needs you · can wake you')
  expect(f.bots.chat.detail(f.bots.get(botId).definition, f.clock.now).telling).toBe(line)
})
it.each(['needs_you', 'look', 'fyi', 'every'] as const)('keeps failures audible and owner replies immediate at %s', tellMe => {
  const message = { id: 'm', author: 'bot', kind: 'error', error: { text: 'Failed' } } as any
  expect(tellingClass({ message, ownerTurn: false, reminder: false, quiet: false, tellMe })).toBe('soon')
  expect(tellingClass({ message: { ...message, kind: 'text', error: undefined }, ownerTurn: true, reminder: false, quiet: false, tellMe })).toBe('now')
})
it('omits an unset line and uses the owner’s clock format', () => {
  expect(tellingLine({})).toBeUndefined()
  expect(tellingLine({ tellMe: 'needs_you' }, { from: '22:00', to: '08:00' }, 'en-GB')).toBe('Tells you when it needs you · Quiet 22:00 to 08:00')
})
