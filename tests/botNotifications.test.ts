import { describe, expect, it } from 'vitest'
import {
  BotNotificationIndex,
  botNotificationContent,
  botNotificationKind,
  planThreadNotification
} from '../src/main/notifications/threadNotification'
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

  it('announces an open ask as a question, and an answered one not at all', () => {
    const ask = { askId: 'k1', title: 'read files in ~/Invoices', note: '', status: 'open' as const }
    expect(botNotificationKind(row({ kind: 'notice', ask }), NOW)).toBe('question')
    expect(botNotificationKind(row({ kind: 'notice', ask: { ...ask, status: 'allowed' } }), NOW)).toBeNull()
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
