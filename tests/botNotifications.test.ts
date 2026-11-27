import { describe, expect, it } from 'vitest'
import {
  BotNotificationIndex,
  botNotificationContent,
  botNotificationKind,
  planThreadNotification
} from '../src/main/notifications/threadNotification'
import { BotChatProjection } from '../src/mms/bots/chat/projection'
import type { BotMessageRow } from '../src/mms/bots/store/BotStore'
import type { BotChatMessage } from '../src/shared/bots/personal/chat'

/**
 * Bot notifications (Bot Phase 1 §5.7): a bot's run report, reply, notice or error uses the
 * person's `completed` choices and an open ask their `question` choices; chips, the owner's own
 * messages and changed old rows never notify; the banner names the bot and opens its chat.
 */
const NOW = Date.parse('2026-11-07T09:05:00.000Z')
const row = (over: Partial<BotChatMessage> = {}): BotChatMessage =>
  ({ seq: 1, id: 'm1', at: '2026-11-07T09:04:00.000Z', author: 'bot', kind: 'run_report', text: 'Three emails need a reply.', chips: [], ...over })

describe('what a bot row announces', () => {
  it('announces run reports, replies, notices and errors as completed', () => {
    for (const kind of ['run_report', 'text', 'notice', 'error'] as const) expect(botNotificationKind(row({ kind }), NOW)).toBe('completed')
  })

  it.each(['bm_wake_w1', 'bm_permission_switch_1'])('keeps projected service line %s silent and announces the reply', (id) => {
    // These notice ids become systemLine in the chat projection used by bots.message.
    const projection = new BotChatProjection({ store: {} as never, emit: () => {} })
    const service = projection.toMessage({ ...row({ id, kind: 'notice', text: 'Following up' }), botId: 'b1' } as BotMessageRow)
    expect(service.systemLine).toBe(true)
    expect(botNotificationKind(service, NOW)).toBeNull()
    expect(botNotificationKind(row({ kind: 'text', text: 'The deploy is done.' }), NOW)).toBe('completed')
  })

  it('announces an open ask as a question, and an answered one not at all', () => {
    const ask = { askId: 'k1', title: 'read files in ~/Invoices', note: '', status: 'open' as const }
    expect(botNotificationKind(row({ kind: 'notice', ask }), NOW)).toBe('question')
    expect(botNotificationKind(row({ kind: 'notice', ask: { ...ask, status: 'allowed' } }), NOW)).toBeNull()
  })

  it('announces a question with answers to tap as a question, with its answers; an answered one not at all', () => {
    const question = { questionId: 'q_1', choices: [{ label: 'Flat A' }, { label: 'Flat B' }], other: true, status: 'open' as const }
    const asked = row({ kind: 'text', text: 'Which flat should I book a viewing for?\n\nFlat A · Flat B · Something else', plainFrom: 39, question })
    expect(botNotificationKind(asked, NOW)).toBe('question')
    expect(botNotificationContent('Flat Finder', asked)).toEqual({ title: 'Flat Finder', body: 'Which flat should I book a viewing for? — Flat A / Flat B' })
    expect(botNotificationKind(row({ kind: 'text', question: { ...question, status: 'answered', answer: 'Flat B' } }), NOW)).toBeNull()
  })

  it('announces a nudge with the question it reminds of, cut to fit, so it reads on its own', () => {
    const question = { questionId: 'q_1', choices: [{ label: 'Flat A' }, { label: 'Flat B' }], other: true, status: 'open' as const, nudge: true as const }
    const long = 'I found two flats that fit what you asked for, both close to the station and under budget, and both free on Saturday. Which one should I book a viewing for?'
    const nudge = row({ kind: 'text', text: 'Still need your answer on this one.\n\nFlat A · Flat B · Something else', plainFrom: 35, question, replyTo: { id: 'qb', author: 'bot', text: long } })
    const { body } = botNotificationContent('Flat Finder', nudge)
    expect(body.startsWith(`Still need your answer: ${long.slice(0, 80)}`)).toBe(true)
    expect(body).toMatch(/… — Flat A \/ Flat B$/)
    expect(body.length).toBeLessThanOrEqual(140)
    // The bubble it replies to is gone: the nudge's own line.
    expect(botNotificationContent('Flat Finder', { ...nudge, replyTo: { id: 'qb', author: 'bot', text: '', gone: true } }).body).toBe('Still need your answer on this one. — Flat A / Flat B')
  })

  it('never announces the owner’s own messages or an old row that changed', () => {
    expect(botNotificationKind(row({ author: 'owner', kind: 'text' }), NOW)).toBeNull()
    expect(botNotificationKind(row({ at: '2026-11-06T09:00:00.000Z' }), NOW)).toBeNull()
  })
})

describe('the banner', () => {
  it('names the bot and says what it wants', () => {
    expect(botNotificationContent('Inbox helper', row({ ask: { askId: 'k1', title: 'send email as you', note: '', status: 'open' } })))
      .toEqual({ title: 'Inbox helper', body: 'Wants to send email as you' })
  })

  it('carries the error, or the first plain line of the message', () => {
    expect(botNotificationContent('Garden', row({ kind: 'error', error: { text: 'Paused until 14:00 (your Claude usage limit)' } })).body)
      .toBe('Paused until 14:00 (your Claude usage limit)')
    expect(botNotificationContent('Garden', row({ text: '\n**No rain** since Sunday.\n- Water today' })).body).toBe('No rain since Sunday.')
    expect(botNotificationContent(undefined, row({ text: '' }))).toEqual({ title: 'Your bot', body: 'New message' })
    expect(botNotificationContent('Garden', row({ text: 'x'.repeat(300) })).body).toHaveLength(140)
  })
})

describe('the bot index', () => {
  it('learns names from list and single-bot replies, per profile', () => {
    const index = new BotNotificationIndex()
    index.note('p1', { bots: [{ id: 'b1', name: 'Inbox helper' }, { id: 'b2', name: 'Garden' }] })
    index.note('p1', { bot: { id: 'b2', name: 'Plants' } })
    index.note('p1', { summary: { id: 'b3', name: 'Flights' }, permissions: [], runs: [] })
    index.note('p1', { purgeAt: '2026-12-07' })
    expect([index.name('p1', 'b1'), index.name('p1', 'b2'), index.name('p1', 'b3'), index.name('p2', 'b1')]).toEqual(['Inbox helper', 'Plants', 'Flights', undefined])
  })

  it('announces each row once, so a changed row (an answered ask) is not news again', () => {
    const index = new BotNotificationIndex()
    expect(index.first('p1', 'm1')).toBe(true)
    expect(index.first('p1', 'm1')).toBe(false)
    expect(index.first('p2', 'm1')).toBe(true)
  })
})

describe('how a bot row reaches the person', () => {
  const channels = { toast: false, system: true, sound: true }
  it('only sounds while that bot’s chat is on screen in a focused window', () => {
    expect(planThreadNotification(channels, { windowFocused: true, viewingThread: true, systemSupported: true })).toEqual({ toast: false, system: false, playSound: true })
  })

  it('shows the system notification for a bot that is not on screen, even with Mousse in front', () => {
    expect(planThreadNotification(channels, { windowFocused: true, viewingThread: false, systemSupported: true })).toEqual({ toast: false, system: true, playSound: false })
  })
})

it('keeps an owner MCP review readable in its sidebar summary, card and notification after the master merges', async () => {
  // Owner MCP tools are offered and called directly; use_tool deliberately refuses their names.
  const { botFixture, createBot, start, finish } = await import('./bots/botFixture')
  const { BotMcp, callForBot } = await import('../src/mms/bots/mcp/BotMcp')
  const { getDefaultSettings } = await import('../src/shared/settings')
  const { botManifestDigest } = await import('../src/mms/bots/grants/compile')
  const f = botFixture()
  try {
    const settings = getDefaultSettings()
    settings.experimental.botAsksFirstOff = false
    f.host.settings = { get: () => settings } as never
    const descriptor = { configRevision: 'r1', toolName: 'send_email', providerName: 'mail_send_email', inputSchema: { type: 'object' }, installationId: 'mail', serverId: 'mail', serverName: 'Mail' }
    const mcp = new BotMcp({ enabled: () => true, catalog: {
      ensure: async () => undefined, listing: () => [{ ...descriptor, name: 'Mail__send_email' }],
      servers: () => [{ installationId: 'mail', serverName: 'Mail', configDigest: 'c1', tools: [descriptor] }]
    }, manager: { callTool: async () => { throw new Error('An open review must not send') } } as never })
    f.host.mcp = mcp
    await f.bots.reconcileOnStartup()
    const { botId } = await createBot(f, { reply: 'Ready' })
    const grant = f.store.activeGrant(botId)!
    f.store.approve(botId, botManifestDigest({ ...grant.manifest, mcp: [{ serverId: 'mail', tool: 'send_email', level: 'asks_first' }] }), { ...grant.manifest, mcp: [{ serverId: 'mail', tool: 'send_email', level: 'asks_first' }] })
    await f.bots.service.chatSend({ botId, text: 'Send an email', clientRequestId: 'owner-mail' })
    const chat = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    const talk = await start(f, chat.id)
    const { workId } = await f.bots.tools.work.start(botId, chat.id, { title: 'Mail', brief: 'Send the email', key: 'send-mail' })
    await finish(f, talk.payload)
    const work = await start(f, workId)
    await callForBot({ bot: work.prepared.authority, mcp, name: 'Mail__send_email', args: { to: 'private@example.test', body: 'Private content' }, toolCallId: 'send-one', signal: new AbortController().signal })
    const message = f.bots.service.chatList(botId).messages.find(message => message.action)!
    expect(message.action).toMatchObject({ title: 'Send email', serverName: 'Mail', status: 'open' })
    const summary = f.bots.service.list().bots.find(bot => bot.id === botId)!
    expect(summary).toMatchObject({ state: 'needs_you', needsOwner: true })
    expect(summary.stateText).toBe('Waiting for you: Send email · Mail')
    const banner = botNotificationContent(summary.name, message)
    expect(botNotificationKind(message, f.clock.now)).toBe('question')
    expect(banner).toEqual({ title: summary.name, body: 'Wants to send email' })
    for (const internal of ['send_email', 'mail_send_email', 'Mail__', 'private@example.test', 'Private content']) expect(`${summary.stateText}\n${banner.body}`).not.toContain(internal)
  } finally { f.close() }
})

it('notifies an older bot own-tool permission in its plain card words, without the tool id or call details', async () => {
  const { botFixture, createBot, start, finish } = await import('./bots/botFixture')
  const f = botFixture()
  try {
    const { botId } = await createBot(f, { reply: 'Ready' })
    f.bots.narrowGrant(botId, manifest => ({ ...manifest, appTools: manifest.appTools.filter(tool => tool !== 'set_profile') }))
    await f.bots.service.chatSend({ botId, text: 'Call yourself Scout.', clientRequestId: 'rename' })
    const chat = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    const { prepared, payload } = await start(f, chat.id)
    expect(prepared.authority.check({ kind: 'app', tool: 'set_profile', args: { name: 'Scout' } })).toMatchObject({ ok: false, wall: { kind: 'escalated' } })
    await finish(f, payload, 'interrupted', { text: 'I need your OK first.', outcome: { interruptedBy: 'bot_wall' } })
    const message = f.bots.service.chatList(botId).messages.find(message => message.ask?.status === 'open')!
    expect(message.ask?.title).toBe('change its name, description or look')
    const banner = botNotificationContent('Helper', message)
    expect(botNotificationKind(message, f.clock.now)).toBe('question')
    expect(banner).toEqual({ title: 'Helper', body: 'Wants to change its name, description or look' })
    for (const internal of ['set_profile', 'Scout']) expect(banner.body).not.toContain(internal)
  } finally { f.close() }
})
