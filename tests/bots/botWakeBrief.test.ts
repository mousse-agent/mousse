import { afterEach, describe, expect, it, vi } from 'vitest'
import { BotWatchers } from '../../src/mms/bots/watchers'
import { botFixture, createBot, finish, flush, start, type BotFixture } from './botFixture'

let f: BotFixture | undefined
afterEach(() => { f?.close(); vi.restoreAllMocks() })

describe('wake briefs keep their whole meaning', () => {
  it.each(['wake', 'watcher'] as const)('%s refuses 2,001 characters and keeps all 2,000', async (kind) => {
    // Only process launch is stubbed: the engine and stored reminder are real.
    const launch = vi.spyOn(BotWatchers.prototype, 'start').mockImplementation(() => {})
    f = botFixture()
    const fx = f
    await fx.bots.reconcileOnStartup()
    const { botId } = await createBot(fx, { name: 'Pip', reply: 'Hello.' })
    if (kind === 'watcher') {
      const grant = await fx.bots.activate({ botId, input: 'Run', clientRequestId: 'grant' })
      const turn = await start(fx, grant.id)
      turn.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'Watch a build.' })
      await finish(fx, turn.payload, 'completed', { text: 'Asked.' })
      for (const ask of fx.store.openAsks(botId)) await fx.bots.service.answer(botId, ask.id, 'allow')
      await flush()
    }
    await fx.bots.service.chatSend({ botId, text: 'Follow up on the build', clientRequestId: 'owner' })
    const activation = fx.store.laneActivations(botId, 'chat', ['running'])[0]!
    await start(fx, activation.id)
    const set = async (brief: string) => kind === 'wake'
      ? (await fx.bots.tools.wakes!.add(botId, activation.id, { brief, dueAt: new Date(fx.clock.now + 60_000).toISOString() })).wakeId
      : fx.bots.tools.watchers!.start(botId, activation.id, { command: 'build', brief }).watcherId
    const brief = 'Follow up. '.repeat(200).slice(0, 1_999) + '.'
    await expect(set(brief + '!')).rejects.toThrow('Keep the brief to 2,000 characters')
    expect(fx.store.waitingReminders(botId)).toHaveLength(0)
    expect(launch).not.toHaveBeenCalled()
    const id = await set(brief)
    expect(fx.store.reminder(id)?.text).toBe(brief)
    if (kind === 'watcher') expect(launch).toHaveBeenCalledOnce()
  })
})
