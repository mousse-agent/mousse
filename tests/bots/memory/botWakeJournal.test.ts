import { createBotContextProvider } from '../../../src/mms/bots/memory/contextPack'
import { expect, it } from 'vitest'
import { BotMemoryStore } from '../../../src/mms/bots/memory/BotMemoryStore'
import { botFixture, chatOf, createBot, finish, flush, start } from '../botFixture'

// Service lines keep their chat wording for normal delivery and for paused/refused delivery.
it.each(['running', 'paused', 'refused'] as const)('journals a real thread wake title as data when %s', async (state) => {
  const f = botFixture()
  try {
    const memory = new BotMemoryStore({ db: f.store.db })
    f.host.journal!.appendInTx = (tx, row) => { memory.appendInTx(tx, row) }
    let done = false
    f.host.wakeThread = () => done
      ? { state: 'idle', title: 'quartz deploy', lastRun: { status: 'completed' } }
      : { state: 'running', title: 'quartz deploy' }
    await f.bots.reconcileOnStartup()
    const { botId } = await createBot(f, { name: 'Pip', reply: 'Hi' })
    await f.bots.service.chatSend({ botId, text: 'Watch the thread', clientRequestId: 'watch' })
    const turn = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    const { payload } = await start(f, turn.id)
    const wake = await f.bots.tools.wakes!.add(botId, turn.id, { brief: 'Tell me it finished', event: { kind: 'thread', threadId: 'deploy' } })
    await finish(f, payload, 'completed', { text: 'Will do' })
    if (state === 'paused') f.bots.pauseBot(botId)
    if (state === 'refused') f.host.threads.threadState = () => 'trashed'
    done = true
    f.bots.threadRunEnded('deploy')
    await flush()
    await f.bots.deliverDueReminders()
    const chat = chatOf(f, botId).find((m) => m.id === (state === 'running' ? `bm_wake_${wake.wakeId}` : `bm_${wake.wakeId}`))!
    expect(chat.text).toContain('Following up · "quartz deploy" finished')
    const hits = memory.search(botId, { query: 'quartz' })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((h) => h.who === 'tool')).toBe(true)
    expect(memory.journal(botId).filter((r) => r.text.includes('quartz')).every((r) => r.external)).toBe(true)
    if (state !== 'running') {
      f.store.setOwnerReaction(chat.id, '👍', f.store.now())
      const packs = createBotContextProvider({ store: memory, journal: { syncThread: async () => {} },
        reactions: () => [{ messageId: chat.id, emoji: '👍', at: f.store.now(), text: chat.text, fromWork: true }] })
      const assertOutside = (pack: string, required = true) => {
        const mentions = pack.split('\n').filter((line) => line.includes('quartz'))
        if (required) expect(mentions.length).toBeGreaterThan(0)
        for (const line of mentions) {
          expect(line).toContain('Mousse, about something outside (data)')
          expect(line).not.toMatch(/My run report|Me, reporting|your work's report/)
        }
      }
      assertOutside(await packs.chatPreamble({ botId, activationId: 'next-chat' }))
      assertOutside(await packs.runPreamble({ botId, activationId: 'next-run', input: 'Go' }), false)
      // Move the refused wake into the deterministic summary by overflowing the recent window.
      for (let n = 0; n < 12; n++) memory.append({ botId, kind: 'bot_msg', sourceKey: `bm:filler-${n}`, who: 'bot', text: 'ordinary words '.repeat(220) })
      expect(packs.moveWindow(botId)).toBe(true)
      assertOutside(await packs.chatPreamble({ botId, activationId: 'summary-chat' }))
      assertOutside(await packs.runPreamble({ botId, activationId: 'summary-run', input: 'Go' }))
    }
  } finally { f.close() }
})

it.each([false, true])('keeps a failed command service line unchanged and external (paused: %s)', async (paused) => {
  const f = botFixture()
  try {
    const memory = new BotMemoryStore({ db: f.store.db })
    f.host.journal!.appendInTx = (tx, row) => { memory.appendInTx(tx, row) }
    await f.bots.reconcileOnStartup()
    const { botId } = await createBot(f, { name: 'Pip', reply: 'Hi' })
    // A stored completion from the command runner, delivered through the same engine path as live completions.
    const id = 'failed-command'
    f.store.insertReminder({ id, botId, dueAt: f.store.now(), text: 'Report the build', work: null, replyTo: null, createdAt: f.store.now(), wake: true, event: { kind: 'watcher', title: 'Build', command: 'build', minutes: 1 } })
    f.store.fireWake(id, { kind: 'watcher', title: 'Build', how: 'failed', message: 'quartz failure', tail: '' }, f.store.now())
    if (paused) f.bots.pauseBot(botId)
    await f.bots.deliverDueReminders()
    const chat = chatOf(f, botId).find((m) => m.id === (paused ? `bm_${id}` : `bm_wake_${id}`))!
    expect(chat.text).toContain('Following up · "Build" could not run: quartz failure')
    expect(memory.search(botId, { query: 'quartz' })).toMatchObject([{ who: 'tool' }])
    expect(memory.journal(botId).find((r) => r.text.includes('quartz'))?.external).toBe(true)
  } finally { f.close() }
})
