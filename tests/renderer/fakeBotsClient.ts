/**
 * A fake of the Bot UI's daemon methods (`bots.personal.v2`) for renderer tests: bots, chats and
 * details held in memory, every call recorded, and the three bot events pushed by hand.
 */
import { vi } from 'vitest'
import type { BotChatMessage, BotChip, BotDetail, BotSummary } from '../../src/shared/bots/personal/chat'
import type { PersonalBotsClient, PersonalBotsEvents } from '../../src/renderer/services/personalBotsClient'

export const AT = '2026-11-07T09:00:00.000Z'

export function summary(id: string, over: Partial<BotSummary> = {}): BotSummary {
  return {
    id, name: `Bot ${id}`, description: `What ${id} does.`, look: { colour: 'teal', accessory: 'cap' },
    state: 'idle', stateText: '', unread: 0, createdAt: AT, ...over
  }
}

export function message(seq: number, over: Partial<BotChatMessage> = {}): BotChatMessage {
  return { seq, id: `m${seq}`, at: AT, author: 'bot', kind: 'text', text: `Message ${seq}`, chips: [], ...over }
}

export interface FakeBots {
  client: PersonalBotsClient
  events: PersonalBotsEvents
  bots: BotSummary[]
  chats: Record<string, BotChatMessage[]>
  details: Record<string, BotDetail>
  live: Record<string, { activationId: string; chip?: BotChip }>
  calls: Array<[string, ...unknown[]]>
  emit: {
    changed(botId: string): void
    message(botId: string, message: BotChatMessage): void
    activity(botId: string, chip: BotChip | null): void
  }
}

export function fakeBots(initial: { bots?: BotSummary[]; chats?: Record<string, BotChatMessage[]>; details?: Record<string, BotDetail> } = {}): FakeBots {
  const listeners = { changed: new Set<(e: { botId?: string }) => void>(), message: new Set<(e: { botId: string; message: BotChatMessage }) => void>(), activity: new Set<(e: { botId: string; activationId: string; chip: BotChip | null }) => void>() }
  const fake: FakeBots = {
    bots: [...(initial.bots ?? [])],
    chats: { ...(initial.chats ?? {}) },
    details: { ...(initial.details ?? {}) },
    live: {},
    calls: [],
    client: undefined as unknown as PersonalBotsClient,
    events: {
      onChanged: (cb) => { listeners.changed.add(cb); return () => listeners.changed.delete(cb) },
      onMessage: (cb) => { listeners.message.add(cb); return () => listeners.message.delete(cb) },
      onActivity: (cb) => { listeners.activity.add(cb); return () => listeners.activity.delete(cb) }
    },
    emit: {
      changed: (botId) => { for (const cb of listeners.changed) cb({ botId }) },
      message: (botId, row) => { for (const cb of listeners.message) cb({ botId, message: row }) },
      activity: (botId, chip) => { for (const cb of listeners.activity) cb({ botId, activationId: 'act1', chip }) }
    }
  }
  const find = (botId: string) => {
    const bot = fake.bots.find((entry) => entry.id === botId)
    if (!bot) throw Object.assign(new Error('No such bot'), { code: 'bot_not_found' })
    return bot
  }
  const put = (bot: BotSummary) => { fake.bots = fake.bots.map((entry) => (entry.id === bot.id ? bot : entry)); return bot }
  const detail = (botId: string): BotDetail => fake.details[botId] ?? { summary: find(botId), permissions: [], runs: [] }
  const record = <T>(name: string, args: unknown[], result: () => T) => { fake.calls.push([name, ...args]); return Promise.resolve().then(result) }
  let seq = 1000
  fake.client = {
    list: vi.fn(() => record('list', [], () => fake.bots.map((bot) => ({ ...bot })))),
    create: vi.fn((input) => record('create', [input], () => {
      const bot = summary(`new${fake.bots.length + 1}`, { name: input.name ?? 'Inbox helper', description: input.description, look: input.look, state: 'working', stateText: 'Working…' })
      fake.bots.push(bot)
      return bot
    })),
    get: vi.fn((botId) => record('get', [botId], () => detail(botId))),
    update: vi.fn((botId, change) => record('update', [botId, change], () => put({ ...find(botId), ...change }))),
    pause: vi.fn((botId) => record('pause', [botId], () => put({ ...find(botId), state: 'paused', stateText: 'Paused' }))),
    resume: vi.fn((botId) => record('resume', [botId], () => put({ ...find(botId), state: 'idle', stateText: '' }))),
    remove: vi.fn((botId) => record('remove', [botId], () => { fake.bots = fake.bots.filter((bot) => bot.id !== botId); return { purgeAt: '2026-12-07T09:00:00.000Z' } })),
    messages: vi.fn((botId, page = {}) => record('messages', [botId, page], () => {
      const all = fake.chats[botId] ?? []
      const before = page.beforeSeq === undefined ? all : all.filter((row) => row.seq < page.beforeSeq!)
      return { messages: before.slice(-(page.limit ?? 100)), ...(fake.live[botId] ? { live: fake.live[botId] } : {}) }
    })),
    send: vi.fn((botId, text, clientRequestId, attachments) => record('send', [botId, text, clientRequestId, attachments], () => {
      const row = message(++seq, { id: `sent:${clientRequestId}`, author: 'owner', text, ...(attachments?.length ? { attachments } : {}) })
      fake.chats[botId] = [...(fake.chats[botId] ?? []), row]
      return row
    })),
    stop: vi.fn((botId) => record('stop', [botId], () => undefined)),
    markRead: vi.fn((botId, at) => record('markRead', [botId, at], () => undefined)),
    answer: vi.fn((botId, askId, answer) => record('answer', [botId, askId, answer], () => {
      const rows = fake.chats[botId] ?? []
      const row = rows.find((entry) => entry.ask?.askId === askId)
      if (!row?.ask) throw new Error('No such ask')
      const next = { ...row, ask: { ...row.ask, status: answer === 'allow' ? 'allowed' as const : 'not_now' as const } }
      fake.chats[botId] = rows.map((entry) => (entry.id === row.id ? next : entry))
      return next
    })),
    revokePermission: vi.fn((botId, permissionId) => record('revokePermission', [botId, permissionId], () => {
      const next = { ...detail(botId), permissions: detail(botId).permissions.filter((item) => item.id !== permissionId) }
      fake.details[botId] = next
      return next
    })),
    removeSchedule: vi.fn((botId, scheduleId) => record('removeSchedule', [botId, scheduleId], () => {
      const next = { ...detail(botId), runs: detail(botId).runs.filter((item) => item.id !== scheduleId) }
      fake.details[botId] = next
      return next
    })),
    exportMemory: vi.fn((botId, dir) => record('exportMemory', [botId, dir], () => ({ files: [`${dir}/memory.md`] })))
  }
  return fake
}

/**
 * A preload stand-in: the bot events come from `fake`, `overrides` replace whole groups or single
 * functions (`{ dialog: { pickFolder } }`), every other `on…` returns an unsubscribe and every
 * other call fails as if the service were offline.
 */
export function installPreload(fake: FakeBots, overrides: Record<string, Record<string, unknown>> = {}): void {
  const call = (name: string) => (name.startsWith('on') ? () => () => {} : async () => { throw new Error('offline') })
  const group = (known: Record<string, unknown> = {}) => new Proxy(known, { get: (target, key: string) => target[key] ?? call(key) })
  const groups: Record<string, unknown> = {
    personalBots: fake.events,
    app: group({ setViewedBot: vi.fn(async () => undefined), ...overrides.app }),
    dialog: group({ pickFolder: vi.fn(async () => null), pickFiles: vi.fn(async () => []), ...overrides.dialog })
  }
  for (const [name, value] of Object.entries(overrides)) if (!(name in groups)) groups[name] = group(value)
  ;(window as unknown as { mousse: unknown }).mousse = new Proxy(groups, { get: (target, key: string) => target[key] ?? group() })
}
