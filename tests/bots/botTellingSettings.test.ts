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
  ['outside:request', false], ['reminder:r:work', false], ['create:bot', false], ['future:start', false]
])('telling_set checks the source of %s', async (key, accepted) => {
  const { botTools } = await import('../../src/mms/run/mcp/appTools/bots')
  const { start, flush } = await import('./botFixture')
  const f = botFixture(); fixtures.push(f)
  const { botId } = await createBot(f, { reply: 'Hello' })
  const activation = await f.bots.enqueueChat(botId, key, 'Never ping me at night')
  await flush()
  const { payload, prepared } = await start(f, activation.id)
  const tool = botTools(() => ({ host: f.bots.tools })).find(t => t.name === 'telling_set')!
  const result = await tool.handler({ tellMe: 'needs_you' }, {
    caller: { threadId: payload.threadId, runId: payload.runId, provider: 'pi', modeCeiling: 'default', accessLevel: 'lineage' },
    turn: { threadId: payload.threadId, bot: prepared.authority }, toolCallId: 'telling', signal: new AbortController().signal, transport: 'mcp'
  } as any)
  expect(result.isError === true).toBe(!accepted)
  if (!accepted) expect(result.text).toMatch(/owner.*message or tap/)
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
