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
  expect(f.bots.chat.detail(f.bots.get(botId).published!, f.clock.now).telling).toBe(line)
})
it.each(['needs_you', 'look', 'fyi', 'every'] as const)('keeps failures audible and owner replies immediate at %s', tellMe => {
  const message = { id: 'm', author: 'bot', kind: 'error', error: { text: 'Failed' } } as any
  expect(tellingClass({ message, ownerTurn: false, reminder: false, quiet: false, tellMe })).toBe('soon')
  expect(tellingClass({ message: { ...message, kind: 'text', error: undefined }, ownerTurn: true, reminder: false, quiet: false, tellMe })).toBe('now')
})
it('omits an unset line and keeps service times in HH:MM', () => {
  expect(tellingLine({})).toBeUndefined()
  expect(tellingLine({ tellMe: 'needs_you' }, { from: '22:00', to: '08:00' })).toBe('Tells you when it needs you · Quiet 22:00 to 08:00')
})

// Owner message, tapped answer; work, reminder work, wake, question default,
// another bot, outside text, creation and a future unattended source.
it.each([
  ['chat:message', true], ['answer:question', true], ['chat:after:message', true],
  ['wake:event', false], ['question:q:default', false], ['botmsg:sender:message', false],
  ['outside:request', false], ['work', false], ['reminder:r:work', false], ['create:bot', false], ['future:start', false]
])('telling_set checks the source of %s', async (key, accepted) => {
  const { botTools } = await import('../../src/mms/run/mcp/appTools/bots')
  const { start, flush } = await import('./botFixture')
  const f = botFixture(); fixtures.push(f)
  const { botId } = await createBot(f, { reply: 'Hello' })
  await f.bots.reconcileOnStartup()
  let activation: { id: string }
  if (key === 'work' || key === 'reminder:r:work') {
    await f.bots.service.chatSend({ botId, text: 'Do this work', clientRequestId: 'owner-work' })
    const owner = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    if (key === 'work') {
      const work = await f.bots.tools.work.start(botId, owner.id, { title: 'Check', brief: 'Check for news', key: 'work' })
      activation = { id: work.workId }
    } else {
      f.bots.addReminder(botId, owner.id, { dueAt: f.store.now(), text: 'Check later', work: { title: 'Check', brief: 'Check for news' } })
      await f.bots.deliverDueReminders()
      await flush()
      activation = f.store.laneActivations(botId, 'run', ['running'])[0]!
    }
    expect(f.store.activation(activation.id)?.lane).toBe('run')
  } else activation = await f.bots.enqueueChat(botId, key, 'Never ping me at night')
  await flush()
  const { payload, prepared } = await start(f, activation.id)
  const tool = botTools(() => ({ host: f.bots.tools })).find(t => t.name === 'telling_set')!
  const result = await tool.handler({ tellMe: 'needs_you' }, {
    caller: { threadId: payload.threadId, runId: payload.runId, provider: 'pi', modeCeiling: 'default', accessLevel: 'lineage' },
    turn: { threadId: payload.threadId, bot: prepared.authority }, toolCallId: 'telling', signal: new AbortController().signal, transport: 'mcp'
  } as any)
  expect(result.isError === true).toBe(!accepted)
  if (!accepted) {
    expect(result.text).toMatch(/owner.*message or tap/)
    expect(() => f.bots.setTelling(botId, activation.id, { tellMe: 'needs_you' })).toThrow(/owner.*message or tap/)
  }
  expect(readBotTelling(f.store.registry(botId)?.tellJson).tellMe).toBe(accepted ? 'needs_you' : undefined)
})

import { readBotTelling } from '../../src/shared/bots/personal/tellingSettings'
import { SettingsStore } from '../../src/mms/settings/SettingsStore'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { join } from 'node:path'
it('writes profile quiet hours, clears them, and refuses bad values before changing anything', async () => {
  const f = botFixture(); fixtures.push(f)
  const config = MousseConfigStore.load(join(f.base, 'settings-home'))
  f.host.settings = new SettingsStore(config)
  const { botId } = await createBot(f)
  const turn = await f.bots.enqueueChat(botId, 'chat:settings', 'No pings at night')
  expect(f.bots.setTelling(botId, turn.id, { quietHours: { from: '22:00', to: '07:00' } })).toBe('Quiet 22:00 to 07:00')
  expect(f.bots.chat.detail(f.bots.get(botId).published!, f.clock.now).tellingSettings).toMatchObject({ quietHours: { from: '22:00', to: '07:00' } })
  expect(new SettingsStore(MousseConfigStore.load(join(f.base, 'settings-home'))).get().notifications.quietHours).toEqual({ from: '22:00', to: '07:00' })
  for (const quietHours of [{ from: '24:00', to: '07:00' }, { from: '10:2', to: '07:00' }, { from: '22:00', to: '22:00' }]) {
    expect(() => f.bots.setTelling(botId, turn.id, { quietHours })).toThrow(/HH:MM/)
    expect(() => f.host.settings!.set({ notifications: { quietHours } } as any)).toThrow(/HH:MM/)
  }
  expect(() => f.bots.setTelling(botId, turn.id, { tellMe: 'urgent' } as any)).toThrow(/needs_you/)
  f.bots.setTelling(botId, turn.id, { quietHours: 'off' })
  expect(new SettingsStore(MousseConfigStore.load(join(f.base, 'settings-home'))).get().notifications.quietHours).toBeUndefined()
})
it('changes only this bot’s automations, and targets a wake exception by schedule id', async () => {
  const f = botFixture(); fixtures.push(f)
  const { botId } = await createBot(f)
  const other = (await createBot(f, { name: 'Other' })).botId
  const a = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 10 }, prompt: 'Check A' }, 'owner')
  const b = f.bots.addSchedule(other, { when: { kind: 'interval', minutes: 10 }, prompt: 'Check B' }, 'owner')
  const turn = await f.bots.enqueueChat(botId, 'chat:schedules', 'Only urgent')
  f.bots.setTelling(botId, turn.id, { tellMe: 'needs_you', schedules: true })
  expect(f.scheduler.getJob(a.jobId)?.tellMe).toBe('needs_you')
  expect(f.scheduler.getJob(b.jobId)?.tellMe).toBeUndefined()
  expect(f.bots.setTelling(botId, turn.id, { scheduleId: a.scheduleId, canWakeMe: true })).toContain('That automation can wake you.')
  expect(f.scheduler.getJob(a.jobId)?.bot?.canWakeMe).toBe(true)
  expect(readBotTelling(f.store.registry(botId)?.tellJson).canWakeMe).toBeUndefined()
  expect(() => f.bots.setTelling(botId, turn.id, { scheduleId: b.scheduleId, canWakeMe: true })).toThrow(/No automation/)
})
it.each(['text', 'run_report', 'error'] as const)('applies every bot level to an unattended %s in the post transaction', async kind => {
  const f = botFixture(); fixtures.push(f)
  const { botId } = await createBot(f)
  const turn = await f.bots.enqueueChat(botId, 'chat:level', 'Set my level')
  for (const tellMe of ['needs_you', 'look', 'fyi', 'every'] as const) {
    f.bots.setTelling(botId, turn.id, { tellMe })
    const events: any[] = []
    f.bots.events.once('message', event => events.push(event))
    const message = f.bots.chat.post({ botId, author: 'bot', kind, text: 'Update' })
    expect(events[0]?.quiet === true).toBe(kind !== 'error' && tellMe === 'needs_you')
    expect(f.store.message(message.id)?.tell).toBe(kind !== 'error' && tellMe === 'needs_you' ? 'later' : 'soon')
  }
})

it.each(['off', { from: '23:00', to: '06:00' }] as const)('keeps bot quiet hours %j through later notification changes in windows', async quietHours => {
  const { bridgeProtocolEvent } = await import('../../src/main/mms/protocolEventBridge')
  const f = botFixture(); fixtures.push(f)
  f.host.settings = new SettingsStore(MousseConfigStore.load(join(f.base, 'settings-home')))
  f.host.settings.set({ notifications: { quietHours: { from: '22:00', to: '08:00' } } } as any)
  // Two already-open windows receive the same IPC payload as the real settings subscription.
  const windows = [f.host.settings.get(), f.host.settings.get()]
  f.host.settingsChanged = (settings: import('../../src/shared/settings').MousseSettings) => {
    bridgeProtocolEvent({ type: 'settings.changed', data: { settings } }, (channel, data) => {
      expect(channel).toBe('settings:changed')
      windows.forEach((_, index) => { windows[index] = structuredClone(data as typeof settings) })
    }, { getActiveThreadId: () => null } as any)
  }
  const { botId } = await createBot(f)
  const turn = await f.bots.enqueueChat(botId, 'chat:settings-window', 'Change quiet hours')
  f.bots.setTelling(botId, turn.id, { quietHours })
  const expected = quietHours === 'off' ? undefined : quietHours
  for (const window of windows) {
    expect(window.notifications.quietHours).toEqual(expected)
    f.host.settings.set({ notifications: { ...window.notifications, allRemoteThreads: !window.notifications.allRemoteThreads } })
    expect(f.host.settings.get().notifications.quietHours).toEqual(expected)
  }
  // A window opened after the event obtains current settings, with no replay needed.
  const reopened = new SettingsStore(MousseConfigStore.load(join(f.base, 'settings-home')))
  const lateWindow = reopened.get()
  reopened.set({ notifications: { ...lateWindow.notifications, threadCompletionSound: !lateWindow.notifications.threadCompletionSound } })
  expect(reopened.get().notifications.quietHours).toEqual(expected)
})

it('the About hours and the quiet-hours reader agree in the owner device zone', async () => {
  const { OwnerQuietHours } = await import('../../src/mms/notifications/OwnerQuietHours')
  const f = botFixture(); fixtures.push(f)
  f.host.settings = new SettingsStore(MousseConfigStore.load(join(f.base, 'settings-home')))
  const q = new OwnerQuietHours(() => f.host.settings!.get().notifications.quietHours, () => f.clock.now, () => 'UTC')
  f.clock.now = Date.parse('2026-11-07T20:00:00Z')
  q.report(f.clock.now, 'Asia/Kolkata')
  const { botId } = await createBot(f)
  const turn = await f.bots.enqueueChat(botId, 'chat:zone', 'Quiet at night')
  f.bots.setTelling(botId, turn.id, { quietHours: { from: '22:00', to: '07:00' } })
  const detail = f.bots.chat.detail(f.bots.get(botId).published!, f.clock.now)
  expect(detail.telling).toBe('Quiet 22:00 to 07:00')
  expect(detail.tellingSettings?.quietHours).toEqual(f.host.settings.get().notifications.quietHours)
  expect(q.ownerZone()).toBe('Asia/Kolkata')
  expect(q.quietHoursFor(botId)?.end).toBe(Date.parse('2026-11-08T01:30:00Z'))
})

it('keeps below-level rows later and holds failures until quiet hours end', async () => {
  const f = botFixture(); fixtures.push(f)
  const { botId } = await createBot(f)
  const turn = await f.bots.enqueueChat(botId, 'chat:level-quiet', 'Only urgent reports')
  f.bots.setTelling(botId, turn.id, { tellMe: 'needs_you' })
  const end = f.clock.now + 3600_000
  Object.assign(f.host, { quietHoursFor: () => ({ end }), ownerActive: () => false })
  const quiet = f.bots.chat.post({ botId, author: 'bot', kind: 'run_report', text: 'FYI' })
  const failed = f.bots.chat.post({ botId, author: 'bot', kind: 'error', text: 'Failed', error: { text: 'Repair this' } })
  expect(f.store.message(quiet.id)).toMatchObject({ tell: 'later', tellAt: f.store.now() })
  expect(f.store.message(failed.id)).toMatchObject({ tell: 'soon', tellAt: new Date(end).toISOString() })
  f.bots.setTellingWindows(1)
  const events: unknown[] = []; f.bots.events.on('tell', e => events.push(e))
  await f.bots.deliverDueReminders()
  expect(events).toHaveLength(0)
})

it.each([false, true])('a single can-wake automation keeps its reports soon and folded (completed=%s)', async completed => {
  const { start } = await import('./botFixture')
  const f = botFixture(); fixtures.push(f)
  await f.bots.reconcileOnStartup()
  const { botId } = await createBot(f)
  const turn = await f.bots.enqueueChat(botId, 'chat:schedule-wake', 'This one can wake me')
  const schedule = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 1 }, prompt: 'Check news' }, 'owner')
  f.bots.setTelling(botId, turn.id, { scheduleId: schedule.scheduleId, canWakeMe: true })
  Object.assign(f.host, { quietHoursFor: () => ({ end: f.clock.now + 3600_000 }), ownerActive: () => false })
  await f.tickSchedules(new Date(f.clock.now + 60_000))
  const activation = f.store.listActivations(botId).find(a => a.trigger.kind === 'schedule')!
  if (completed) {
    const running = await start(f, activation.id)
    f.bots.tools.schedules.done(running.payload.threadId, 'All done.')
    expect(f.book.get(botId, schedule.scheduleId)).toBeUndefined()
  }
  f.bots.setTellingWindows(1)
  const events: import('../../src/shared/bots/personal/telling').BotTelling[] = []
  f.bots.events.on('tell', e => events.push(e))
  for (let n = 0; n < 5; n++) {
    const report = f.bots.chat.post({ botId, activationId: activation.id, author: 'bot', kind: 'run_report', text: `Report ${n}` })
    expect(f.store.message(report.id)).toMatchObject({ tell: 'soon', tellAt: f.store.now() })
    await f.bots.deliverDueReminders()
    f.clock.now += 1000
  }
  expect(new Set(events.map(e => e.id)).size).toBe(1)
  expect(events.filter(e => e.sound)).toHaveLength(1)
  expect(events.at(-1)?.rows).toHaveLength(5)
})

// An owner who asks for only "needs you" still hears open actions; settled actions never tell again.
it.each(['open', 'approved', 'running', 'done', 'failed', 'uncertain', 'declined', 'expired', 'withdrawn'] as const)('C4 needs-you telling for an action that is %s', status => {
  const message: import('../../src/shared/bots/personal/chat').BotChatMessage = {
    id: 'bm_action_review', seq: 1, at: '2026-11-16T10:00:00.000Z', author: 'bot', kind: 'notice', text: 'Send this',
    action: { actionId: 'action_review', digest: 'digest', title: 'Send', serverName: 'Mail', args: {}, hasHiddenValues: false, hiddenPaths: [], status }
  }
  expect(tellingClass({ message, tellMe: 'needs_you', level: 'fyi', ownerTurn: false, reminder: false, quiet: false })).toBe(status === 'open' ? 'soon' : null)
})
