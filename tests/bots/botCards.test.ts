/**
 * Small cards on a bot's message (`show_card`, issue #1123), over a real engine and a real `bots.db`: a card is made
 * through the bot's own tool, checked strictly, carried by the turn's next message (the chat's reply, work's report),
 * kept in `cards_json`, and read as plain text wherever cards aren't drawn.
 *
 * What each case covers:
 * - kinds and limits: facts, checklist, progress, gallery; an unknown type or field; values out of their limits
 * - gallery pictures: in the files folder, outside it, through a link out of it, not a picture, a web address
 * - where a card goes: a chat reply, work's report, a message of cards alone, a question's bubble; at most 3 per message
 * - where it is offered: chat and work turns; never a consult (subagents: botWorkSubagents.test.ts)
 * - plain text: the message's text from `plainFrom`, the journal, a notification, the Recent line, another device
 * - Forget: the card and its gallery's files go with the message, found by the message; another message's card stays
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { botTools } from '../../src/mms/run/mcp/appTools/bots'
import type { MousseTool, ToolCallContext } from '../../src/mms/run/mcp/appTools/types'
import type { PreparedBotTurn } from '../../src/mms/bots/activation/dispatcher'
import { BotMemoryStore } from '../../src/mms/bots/memory/BotMemoryStore'
import { capturedRows } from '../../src/mms/bots/memory/capture'
import { resetReplyCards } from '../../src/mms/bots/chat/replyCards'
import { remoteBotMessage } from '../../src/mms/bridge/remote/RemoteBots'
import { botNotificationContent } from '../../src/main/notifications/threadNotification'
import { CARD_SHOWN_TEXT, CARDS_FULL_TEXT, cardOf } from '../../src/shared/bots/personal/cards'
import { QUESTION_ASKED_TEXT } from '../../src/shared/bots/personal/questions'
import type { BotChatMessage } from '../../src/shared/bots/personal/chat'
import type { ChatMessage } from '../../src/shared/types'
import { botFixture, chatOf, createBot, finish, flush, payloadOf, start, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string
let folder: string

beforeEach(async () => {
  f = botFixture()
  botId = (await createBot(f, { reply: 'Hi, I compare things.' })).botId
  folder = f.bots.filesFolder(botId)
  mkdirSync(join(folder, 'images'), { recursive: true })
})
afterEach(() => {
  resetReplyCards()
  f.close()
})

const tools = new Map(botTools(() => ({ host: f.bots.tools })).map((tool) => [tool.name, tool]))
/** One of the bot's tools, called from a running turn as its runtime would. */
async function tool(name: string, prepared: PreparedBotTurn, threadId: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const ctx = {
    caller: { threadId, runId: 'r', provider: 'pi', modeCeiling: 'default', accessLevel: 'lineage' },
    turn: { threadId, bot: prepared.authority },
    toolCallId: `call-${Math.random()}`,
    signal: new AbortController().signal,
    transport: 'mcp'
  } as unknown as ToolCallContext
  return (tools.get(name) as MousseTool).handler(args, ctx)
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
const SPECS = { type: 'facts', title: 'Roborock Q7', rows: [{ label: 'Suction', value: '**8,000 Pa**' }, { label: 'Price', value: '₹24,999' }] }

/** The owner writes; the chat turn their message started, running. */
async function chatTurn(text: string, id: string) {
  const { message } = await f.bots.service.chatSend({ botId, text, clientRequestId: id })
  const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  return { message, activation, ...(await start(f, activation.id)) }
}

/** A chat turn that shows `cards` and replies `reply`; the bot's message it posted. */
async function shown(cards: Array<Record<string, unknown>>, reply = 'Here it is.', id = 'm1'): Promise<BotChatMessage> {
  const turn = await chatTurn('Compare the Roborock Q7 for me.', id)
  for (const card of cards) {
    const answer = await tool('show_card', turn.prepared, turn.payload.threadId, { card })
    expect(answer.isError, answer.text).toBeFalsy()
    expect(JSON.parse(answer.text)).toEqual({ shown: true, note: CARD_SHOWN_TEXT })
  }
  await finish(f, turn.payload, 'completed', { text: reply })
  return chatOf(f, botId).filter((message) => message.activationId === turn.activation.id && message.author === 'bot').at(-1)!
}

describe('what a card may be', () => {
  // Each kind's limits, and what is refused with a reason the bot can act on.
  const ROWS: Array<[string, unknown, 'ok' | RegExp]> = [
    ['facts', SPECS, 'ok'],
    ['facts with a number value', { type: 'facts', rows: [{ label: 'Rooms', value: 3 }] }, 'ok'],
    ['facts with no rows', { type: 'facts', rows: [] }, /1 to 12 rows/],
    ['facts with 13 rows', { type: 'facts', rows: Array.from({ length: 13 }, (_, i) => ({ label: `L${i}`, value: 'v' })) }, /1 to 12 rows/],
    ['a label over 40 characters', { type: 'facts', rows: [{ label: 'L'.repeat(41), value: 'v' }] }, /40 characters/],
    ['a value over 300 characters', { type: 'facts', rows: [{ label: 'L', value: 'v'.repeat(301) }] }, /300 characters/],
    ['a row with another field', { type: 'facts', rows: [{ label: 'L', value: 'v', html: '<b>x</b>' }] }, /label, value/],
    ['a checklist', { type: 'checklist', items: [{ text: 'Book', state: 'done' }, { text: 'Pay', state: 'todo' }] }, 'ok'],
    ['a checklist item with a made-up state', { type: 'checklist', items: [{ text: 'Book', state: 'maybe' }] }, /done, doing, todo or skipped/],
    ['a checklist of 21 items', { type: 'checklist', items: Array.from({ length: 21 }, () => ({ text: 't', state: 'todo' })) }, /1 to 20/],
    ['progress', { type: 'progress', label: 'Pages checked', done: 3, total: 5 }, 'ok'],
    ['progress past its total', { type: 'progress', label: 'Pages', done: 6, total: 5 }, /0 to total/],
    ['progress with a fraction', { type: 'progress', label: 'Pages', done: 1.5, total: 5 }, /whole number/],
    ['progress with a title (not one of its fields)', { type: 'progress', title: 'T', label: 'Pages', done: 1, total: 5 }, /no "title"/],
    ['a gallery of 9 pictures', { type: 'gallery', files: Array.from({ length: 9 }, (_, i) => ({ path: `p${i}.png` })) }, /1 to 8/],
    ['a gallery picture from the web', { type: 'gallery', files: [{ path: 'https://example.com/a.png' }] }, /never web addresses/],
    ['an unknown type', { type: 'html', html: '<script>alert(1)</script>' }, /facts, checklist, progress or gallery/],
    ['a style field', { ...SPECS, style: 'color:red' }, /no "style"/]
  ]
  it.each(ROWS)('%s', (_name, value, expected) => {
    const card = cardOf(value)
    if (expected === 'ok') expect(card).not.toHaveProperty('problem')
    else expect((card as { problem: string }).problem).toMatch(expected)
  })
})

describe('a card on a message', () => {
  it('goes with the chat reply, which keeps it and carries it as plain text after its words', async () => {
    const reply = await shown([SPECS])
    expect(reply.cards).toEqual([SPECS])
    // An app that draws cards stops at `plainFrom`; an older one shows the plain copy.
    expect(reply.text.slice(0, reply.plainFrom)).toBe('Here it is.')
    expect(reply.text.slice(reply.plainFrom).trim()).toBe('Roborock Q7\nSuction: **8,000 Pa**\nPrice: ₹24,999')
    // Its journal row has the copy, so search and the chat pack show the bot its own card.
    expect(f.journal.find((row) => row.sourceKey === `bm:${reply.id}`)?.text).toBe(`Here it is.\n\n${reply.text.slice(reply.plainFrom).trim()}`)
  })

  it('a turn that showed a card and wrote nothing posts the card alone; its notification and the Recent line read the card', async () => {
    const reply = await shown([{ type: 'progress', label: 'Listings checked', done: 4, total: 9, note: 'Two look good.' }], '')
    expect(reply).toMatchObject({ text: '4 of 9 · Listings checked\nTwo look good.', plainFrom: 0 })
    expect(botNotificationContent('Pip', reply).body).toBe('4 of 9 · Listings checked')
    expect(f.bots.service.list().bots.find((bot) => bot.id === botId)?.last?.text).toBe('4 of 9 · Listings checked')
  })

  it('goes with work\'s report', async () => {
    const turn = await chatTurn('Compare two vacuums.', 'w')
    const { workId } = await f.bots.tools.work.start(botId, turn.activation.id, { title: 'Vacuums', brief: 'Compare two vacuums.', key: 'w1' })
    await finish(f, turn.payload, 'completed', { text: 'On it.' })
    const work = await start(f, workId)
    const checklist = { type: 'checklist', title: 'Steps', items: [{ text: 'Find prices', state: 'done' }, { text: 'Read reviews', state: 'skipped' }] }
    expect((await tool('show_card', work.prepared, work.payload.threadId, { card: checklist })).isError).toBeFalsy()
    await finish(f, work.payload, 'completed', { text: 'The Q7 wins.' })
    const report = chatOf(f, botId).find((message) => message.activationId === workId && message.kind === 'run_report')!
    expect(report.cards).toEqual([checklist])
    expect(report.text).toBe('The Q7 wins.\n\nSteps\n[x] Find prices\n[-] Read reviews')
  })

  it('holds at most 3 cards; a 4th is refused with what to do', async () => {
    const turn = await chatTurn('More.', 'm')
    for (let i = 0; i < 3; i += 1) expect((await tool('show_card', turn.prepared, turn.payload.threadId, { card: SPECS })).isError).toBeFalsy()
    expect(await tool('show_card', turn.prepared, turn.payload.threadId, { card: SPECS })).toMatchObject({ isError: true, text: expect.stringContaining(CARDS_FULL_TEXT) })
    await finish(f, turn.payload, 'completed', { text: 'Three.' })
    expect(chatOf(f, botId).at(-1)?.cards).toHaveLength(3)
  })

  it('a malformed card is refused and nothing is shown', async () => {
    const turn = await chatTurn('Show me.', 'm')
    expect(await tool('show_card', turn.prepared, turn.payload.threadId, { card: { type: 'facts', rows: [{ label: 'x', value: 'y', onclick: 'z' }] } })).toMatchObject({ isError: true })
    await finish(f, turn.payload, 'completed', { text: 'Done.' })
    expect(chatOf(f, botId).at(-1)?.cards).toBeUndefined()
  })

  it('a question\'s card shows on its bubble, its plain copy before the answers', async () => {
    const turn = await chatTurn('Which should I buy?', 'q')
    const answer = await tool('ask_owner', turn.prepared, turn.payload.threadId, { question: 'Which one?', choices: ['Q7', 'S8'], card: SPECS })
    expect(JSON.parse(answer.text)).toEqual({ asked: true, note: QUESTION_ASKED_TEXT })
    await finish(f, turn.payload, 'completed', { text: '' })
    const bubble = chatOf(f, botId).find((message) => message.question)!
    expect(bubble.cards).toEqual([SPECS])
    expect(bubble.text).toBe('Which one?\n\nRoborock Q7\nSuction: **8,000 Pa**\nPrice: ₹24,999\n\nQ7 · S8 · Something else')
    expect(bubble.plainFrom).toBe('Which one?'.length)
  })

  it('is offered to chat and work turns, never to a consult', async () => {
    const definitions = f.host.definitions
    const current = definitions.revision(botId, f.store.registry(botId)!.revision!)!
    f.store.setPublished(botId, definitions.publishRevision({ ...current, context: [{ key: 'docs', title: 'Docs', agent: { instructions: 'You know the docs.' }, model: { mode: 'auto', depth: 'normal' } }] }).revision!)
    const turn = await chatTurn('Do it.', 'c')
    expect(turn.prepared.authority.appTools.has('show_card')).toBe(true)
    const { workId } = await f.bots.tools.work.start(botId, turn.activation.id, { title: 'Job', brief: 'Do it.', key: 'w1' })
    await finish(f, turn.payload, 'completed', { text: 'On it.' })
    const work = await start(f, workId)
    expect(work.prepared.authority.appTools.has('show_card')).toBe(true)
    const asked = work.prepared.authority.consult!({ context: 'docs', question: 'What does it say?' })
    await flush()
    const consultN = f.store.dispatches(workId).find((dispatch) => dispatch.kind === 'consult')!.n
    const consult = f.bots.prepare(payloadOf(f, workId, consultN))
    if ('refused' in consult) throw new Error(consult.refused)
    expect(consult.authority.appTools.has('show_card')).toBe(false)
    void asked.catch(() => undefined)
  })
})

describe('a gallery', () => {
  const picture = (name: string, bytes: Buffer = PNG) => {
    const path = join(folder, 'images', name)
    writeFileSync(path, bytes)
    return path
  }

  it('shows pictures from the files folder; each is also one of the message\'s files, which another device reads by index', async () => {
    const made = picture('flat-a.png')
    picture('flat-b.png')
    const reply = await shown([{ type: 'gallery', title: 'Flats', files: [{ path: made, caption: 'Flat A' }, { path: 'images/flat-b.png' }] }])
    expect(reply.cards).toEqual([{ type: 'gallery', title: 'Flats', files: [{ path: made, name: 'flat-a.png', caption: 'Flat A' }, { path: join(folder, 'images', 'flat-b.png'), name: 'flat-b.png' }] }])
    expect(reply.attachments).toEqual([{ name: 'flat-a.png', path: made }, { name: 'flat-b.png', path: join(folder, 'images', 'flat-b.png') }])
    expect(reply.text.slice(reply.plainFrom).trim()).toBe('Flats\nflat-a.png (Flat A)\nflat-b.png')
    expect(f.bots.service.attachmentFile(botId, reply.id, 1).path).toBe(join(folder, 'images', 'flat-b.png'))
    // Another device gets no path: the picture's name, caption and its place among the files.
    const remote = remoteBotMessage(reply)
    expect(remote.cards).toEqual([{ type: 'gallery', title: 'Flats', files: [{ name: 'flat-a.png', caption: 'Flat A', index: 0 }, { name: 'flat-b.png', index: 1 }] }])
    expect(JSON.stringify(remote)).not.toContain(folder)
  })

  it('refuses a picture outside the files folder, one reached through a link out of it, and a file that is not a picture', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'mousse-card-out-'))
    try {
      writeFileSync(join(outside, 'secret.png'), PNG)
      symlinkSync(join(outside, 'secret.png'), join(folder, 'images', 'link.png'))
      picture('fake.png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))
      const turn = await chatTurn('Show me.', 'g')
      const refused = async (path: string) => (await tool('show_card', turn.prepared, turn.payload.threadId, { card: { type: 'gallery', files: [{ path }] } }))
      expect(await refused(join(outside, 'secret.png'))).toMatchObject({ isError: true, text: expect.stringMatching(/outside your files folder/) })
      expect(await refused('images/link.png')).toMatchObject({ isError: true, text: expect.stringMatching(/outside your files folder/) })
      expect(await refused('images/fake.png')).toMatchObject({ isError: true, text: expect.stringMatching(/not a PNG, JPEG, GIF or WebP/) })
      expect(await refused('images/missing.png')).toMatchObject({ isError: true })
      await finish(f, turn.payload, 'completed', { text: 'Nothing to show.' })
      const reply = chatOf(f, botId).at(-1)!
      expect(reply.cards).toBeUndefined()
      expect(reply.attachments).toBeUndefined()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('forgetting a message with a card', () => {
  /** A real journal over the same `bots.db` (the fixture's is a stand-in), with one chat row in it. */
  const journaled = (memory: BotMemoryStore, message: BotChatMessage) => {
    f.store.db.transaction(() => memory.appendInTx(f.store.db, { botId, kind: 'bot_msg', lane: 'chat', sourceKey: `bm:${message.id}`, who: 'bot', text: message.text }))
    return `j${f.store.get('SELECT seq FROM bot_journal WHERE source_key = ?', `bm:${message.id}`)!.seq as number}`
  }

  it('removes its cards and the gallery\'s files from it, by the message, however short; another message\'s same card stays', async () => {
    const memory = new BotMemoryStore({ db: f.store.db, clock: () => f.clock.now, timeZone: () => 'UTC' })
    const path = join(folder, 'images', 'b.png')
    writeFileSync(path, PNG)
    const short = { type: 'facts', rows: [{ label: 'Pick', value: 'B' }] }
    const kept = await shown([short], 'First.', 'm1')
    const forgotten = await shown([short, { type: 'gallery', files: [{ path }] }], 'Second.', 'm2')
    expect(memory.forget(botId, { refs: [journaled(memory, forgotten)], by: 'owner_ui' })).not.toHaveProperty('error')
    const after = chatOf(f, botId)
    const gone = after.find((message) => message.id === forgotten.id)!
    expect(gone.cards).toBeUndefined()
    expect(gone.attachments).toBeUndefined()
    expect(gone.text).not.toMatch(/Pick|b\.png/)
    expect(f.store.get('SELECT cards_json FROM bot_messages WHERE id = ?', forgotten.id)?.cards_json).toBeNull()
    expect(after.find((message) => message.id === kept.id)?.cards).toEqual([short])
  })

  it('a show_card call is journaled by its kind alone, so no copy of the card outlives the message', () => {
    const call = { id: 'm1', role: 'assistant', kind: 'tool_call', timestamp: new Date(0).toISOString(), content: '', toolCall: { toolName: 'mcp__mousse__show_card', status: 'completed', input: { card: { type: 'facts', rows: [{ label: 'Code', value: '4417' }] } }, response: '{"shown":true}' } } as unknown as ChatMessage
    const rows = capturedRows(call, { botId, threadId: 't', lane: 'chat', activationId: 'a' })
    expect(rows).toEqual([expect.objectContaining({ kind: 'tool_call', text: 'show_card facts', json: { tool: 'show_card', card: 'facts' } })])
    expect(JSON.stringify(rows)).not.toContain('4417')
  })
})
