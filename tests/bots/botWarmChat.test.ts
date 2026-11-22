/**
 * The bot side of a chat's warm process (docs/bots.md, Warm chat process): the chat's own turns carry the key a warm
 * process is kept under, and a change to what the bot's turns start with closes the process its chat keeps.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { botFixture, createBot, runDispatch, type BotFixture } from './botFixture'

let f: BotFixture | undefined
afterEach(() => {
  f?.close()
  f = undefined
})

async function warmBot() {
  f = botFixture()
  const release = vi.fn<(threadId: string) => void>()
  f.host.harness.releaseBotProcess = release
  const { botId, firstActivation } = await createBot(f)
  const home = f.store.registry(botId)!.homeThreadId!
  return { f, botId, firstActivation, home, release }
}

describe("a bot's warm chat process", () => {
  it("keys the chat's own turns by lane, turn kind and grant", async () => {
    const { f, firstActivation } = await warmBot()
    const prepared = await runDispatch(f, firstActivation, 1, { text: 'Hello.' })
    expect(prepared.authority.warm).toMatch(/^chat:activation:/)
  })

  it('closes the chat process when the bot is paused or deleted', async () => {
    const { f, botId, home, release } = await warmBot()
    await f.bots.service.pause(botId)
    expect(release).toHaveBeenCalledWith(home)
    release.mockClear()
    await f.bots.service.delete(botId)
    expect(release).toHaveBeenCalledWith(home)
  })
})
