import { afterEach, describe, expect, it } from 'vitest'
import { createBotMemoryAdmin } from '../../../src/mms/bots/memory/admin'
import { createBotJournal } from '../../../src/mms/bots/memory/capture'
import { createBotContextProvider } from '../../../src/mms/bots/memory/contextPack'
import { disposeFixtures, memoryFixture, type MemoryFixture } from './memoryFixture'

/**
 * Memory on every turn: the pack is frozen per activation for the prompt cache, but a memory saved
 * or forgotten mid-activation reaches that activation's next dispatch (a resumed session after a
 * wall, a continuation), in the chat and in a run.
 */

afterEach(disposeFixtures)

const WISH = 'The owner wants no em dashes in my messages.'

function packs(fx: MemoryFixture) {
  const journal = createBotJournal({ store: fx.store, readThread: () => ({ messages: [] }), listThreads: () => [] })
  return createBotContextProvider({ store: fx.store, journal })
}

describe('a memory saved mid-activation', () => {
  it('reaches the next dispatch of a running chat activation and of a running run', async () => {
    const fx = memoryFixture()
    const provider = packs(fx)
    const chat = await provider.chatPreamble({ botId: 'ada', activationId: 'act-chat' })
    const run = await provider.runPreamble({ botId: 'ada', activationId: 'act-run', input: 'Go' })
    expect(chat).not.toContain(WISH)
    // Unchanged memory: the same frozen text, so a prompt cache holds.
    expect(await provider.chatPreamble({ botId: 'ada', activationId: 'act-chat' })).toBe(chat)
    fx.store.save('ada', { lane: 'chat', kind: 'owner', text: WISH, activationId: 'act-chat' })
    expect(await provider.chatPreamble({ botId: 'ada', activationId: 'act-chat' })).toContain(`[m1 · 7 Nov 2026] ${WISH}`)
    expect(await provider.runPreamble({ botId: 'ada', activationId: 'act-run', input: 'Go' })).toContain(WISH)
    expect(run).not.toContain(WISH)
  })

  it('a run note saved by a run reaches the chat’s next dispatch too', async () => {
    const fx = memoryFixture()
    const provider = packs(fx)
    await provider.chatPreamble({ botId: 'ada', activationId: 'act-chat' })
    fx.store.save('ada', { lane: 'run', kind: 'note', text: 'The feed moved to /rss.', activationId: 'act-run' })
    expect(await provider.chatPreamble({ botId: 'ada', activationId: 'act-chat' })).toContain('The feed moved to /rss.')
  })

  it('saving a text it already holds keeps the frozen packs', async () => {
    const fx = memoryFixture()
    const provider = packs(fx)
    fx.store.save('ada', { lane: 'chat', kind: 'owner', text: WISH })
    await provider.chatPreamble({ botId: 'ada', activationId: 'act-chat' })
    expect(fx.store.getState('ada', 'pack:act-chat')).toBeDefined()
    expect(fx.store.save('ada', { lane: 'chat', kind: 'owner', text: WISH })).toMatchObject({ id: 'm1', version: 1 })
    expect(fx.store.getState('ada', 'pack:act-chat')).toBeDefined()
  })

  it('a forget from About leaves the next dispatch of the same activation', async () => {
    const fx = memoryFixture()
    const provider = packs(fx)
    fx.store.save('ada', { lane: 'chat', kind: 'owner', text: WISH })
    expect(await provider.chatPreamble({ botId: 'ada', activationId: 'act-chat' })).toContain(WISH)
    createBotMemoryAdmin({ store: fx.store }).forget('ada', 'm1')
    expect(await provider.chatPreamble({ botId: 'ada', activationId: 'act-chat' })).not.toContain(WISH)
  })

  it('leaves another bot’s frozen packs alone', async () => {
    const fx = memoryFixture()
    const provider = packs(fx)
    await provider.chatPreamble({ botId: 'bob', activationId: 'act-bob' })
    fx.store.save('ada', { lane: 'chat', kind: 'owner', text: WISH })
    expect(fx.store.getState('bob', 'pack:act-bob')).toBeDefined()
  })
})
