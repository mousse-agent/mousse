import { afterEach, expect, it, vi } from 'vitest'
import { botFixture, createBot, T0 } from './botFixture'
const fixtures: ReturnType<typeof botFixture>[] = []
afterEach(() => { vi.restoreAllMocks(); fixtures.splice(0).forEach(f => f.close()) })
it.each(['quietHoursChanged', 'loadPendingScheduleRemovals', 'retryCompletedScheduleRemovals'])('startup continues when %s throws', async method => {
  const f = botFixture(); fixtures.push(f)
  vi.spyOn(f.bots as any, method).mockImplementationOnce(() => { throw new Error('store unavailable') })
  await expect(f.bots.reconcileOnStartup()).resolves.toBeUndefined()
  expect((f.bots as any).startupPassed).toBe(true)
  expect(f.journal.some(row => row.sourceKey === 'catchUp')).toBe(true)
})
it('upkeep reads ended jobs once and still checks usage pauses when that read fails', async () => {
  const f = botFixture(); fixtures.push(f)
  await f.bots.reconcileOnStartup()
  const a = await createBot(f)
  const b = await createBot(f)
  for (const { botId } of [a,b]) f.store.setPaused(botId, 'usage_limit', new Date(T0 - 1).toISOString())
  const ended = vi.spyOn(f.book, 'ended').mockImplementation(() => { throw new Error('busy lock') })
  await f.bots.maintain(new Date(T0))
  expect(ended).toHaveBeenCalledTimes(1)
  for (const { botId } of [a,b]) expect(f.store.registry(botId)?.pausedReason).toBeNull()
})
