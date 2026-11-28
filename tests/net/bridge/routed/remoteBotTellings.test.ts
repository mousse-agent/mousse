/**
 * Notifications here for the bots of another computer (`RemoteBotTellings`), fed by the real registry
 * (`RemoteBotRegistry`, its copy on disk) and the real marks (`BotMarksStore`) over a scripted Bridge, so each feed
 * snapshot, the moment the feed catches up and each way it ends are under the test's control. The same over two real
 * daemons is `tests/netEngine/checks/remoteBotTellings.test.ts`.
 *
 * Inputs: a feed snapshot replayed as the feed opens, the first one after it caught up, live ones; a start, a restart, a
 * computer away and back, a feed that ends and reopens; no window open, then one; `now` and `soon` messages; more than
 * the feed's twenty open messages; a bot muted or hidden here; the read mark passing a message, a message answered
 * elsewhere; a bot the feed drops, a feed refused.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteBotRegistry } from '../../../../src/mms/bridge/routed/RemoteBotRegistry'
import { RemoteBotTellings } from '../../../../src/mms/bridge/routed/RemoteBotTellings'
import { SqliteRemoteBots } from '../../../../src/mms/bridge/routed/remoteBotStore'
import { PRIVATE_BOTS_SUBJECT } from '../../../../src/mms/bridge/remote/privateStreams'
import { BotMarksStore } from '../../../../src/mms/bots/marks/BotMarksStore'
import { TellingSounds } from '../../../../src/mms/bots/chat/tellingPresentation'
import type { BotTelling } from '../../../../src/shared/bots/personal/telling'
import { NetError, newId, type NodeId } from '../../../../src/shared/net'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean()
})

const KEEPER = 'bot-keeper'
const WRITER = 'bot-writer'
type Entry = { id: string; seq: number; tell: 'now' | 'soon' }
const now = (seq: number): Entry => ({ id: `bm_${seq}`, seq, tell: 'now' })
const soon = (seq: number): Entry => ({ id: `bm_${seq}`, seq, tell: 'soon' })
/** The feed lists a bot's open messages newest first, at most twenty (`BotTellings.attention`). */
const row = (id: string, attention: Entry[] = [], readSeq = 0) => ({
  id, name: id === KEEPER ? 'Server keeper' : 'Writer', stateText: 'Idle', readSeq, telling: { attention: [...attention].reverse().slice(0, 20) }
})
const run = (from: number, to: number, skip: number[] = []) =>
  Array.from({ length: to - from + 1 }, (_, n) => soon(from + n)).filter((entry) => !skip.includes(entry.seq))
const feedOf = (...bots: ReturnType<typeof row>[]) => ({ kind: 'mousse.bots', version: 1, bots })

function harness() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'remote-tellings-')))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const node = newId('node') as NodeId
  const online = new Set<NodeId>([node])
  let feed: { update(value: { kind: 'snapshot'; value: unknown }): void; error(code: string): void; caught?(caught: boolean): void } | undefined
  const refuse: { feed?: NetError } = {}
  const hub = {
    attach: vi.fn(async (ref: { entityId: string }, update: never, error: never, options: { open(): Promise<unknown> }, _delta: unknown, catchUp?: (caught: boolean) => void) => {
      await options.open()
      if (ref.entityId === PRIVATE_BOTS_SUBJECT) {
        catchUp?.(false)
        feed = { update, error, caught: catchUp }
      }
      return { close: vi.fn(), descriptor: {} as never }
    }),
    dropCopy: vi.fn(async () => true)
  }
  const client = {
    rpc: vi.fn(async (method: string) => {
      if (method === 'bridge.bots.open' && refuse.feed) throw refuse.feed
      return {}
    })
  }
  const marks = new BotMarksStore(join(dir, 'bots'))
  const told: BotTelling[] = []
  /** What the bot's computer answers `bots.chat.list` with. */
  const chat = new Map<string, unknown>()
  const asked = vi.fn(async (_node: NodeId, _botId: string) => [...chat.values()] as never[])
  const sounds = new TellingSounds()
  const clock = { now: 1_800_000_000_000 }
  let tellings: RemoteBotTellings | undefined
  /** A start of this computer, with `windows` showing notifications (one unless said). */
  const open = ({ windows = 1 } = {}) => {
    tellings = new RemoteBotTellings({
      emit: (telling) => told.push(telling),
      quiet: (ref) => {
        const m = marks.get(ref)
        return m.muted === true || m.hidden === true
      },
      sounds: () => sounds,
      messages: asked,
      clock: { now: () => clock.now }
    })
    tellings.attach(windows)
    const registry = new RemoteBotRegistry({
      hub: hub as never,
      client: () => client as never,
      store: new SqliteRemoteBots(join(dir, 'bots', 'other-computers.db')),
      computers: () => ({ computers: [{ node, name: 'Mac mini' }] }),
      online: (each) => online.has(each),
      enabled: () => true,
      saveSettleMs: 60_000,
      marks,
      tellings
    })
    cleanups.push(() => registry.close())
    return registry
  }
  /**
   * Opens the registry's feed and lets it catch up: the Bridge's copy (`replayed`), then `bots` as the bot's computer
   * sends them to a reader that opens its feed.
   */
  const connect = async (registry: RemoteBotRegistry, bots: ReturnType<typeof row>[], replayed = bots) => {
    feed = undefined
    await registry.reconcile()
    await vi.waitFor(() => expect(feed).toBeDefined())
    feed!.update({ kind: 'snapshot', value: feedOf(...replayed) })
    feed!.update({ kind: 'snapshot', value: feedOf(...bots) })
    feed!.caught?.(true)
  }
  const send = (...bots: ReturnType<typeof row>[]) => feed!.update({ kind: 'snapshot', value: feedOf(...bots) })
  /** What the windows show now: each notification's latest form, withdrawn ones left out. */
  const shown = () => {
    const last = new Map<string, BotTelling>()
    for (const telling of told) last.set(telling.id, telling)
    return [...last.values()].filter((telling) => telling.rows.length)
  }
  const settle = () => vi.waitFor(() => expect(asked.mock.results.every((result) => result.type !== 'incomplete')).toBe(true)).then(() => new Promise((resolve) => setTimeout(resolve, 0)))
  const ref = (botId: string) => `${node}:${botId}`
  /** What each message was told in, in order: the id of every telling that first showed it, and its sound. */
  const firstTold = () => {
    const seen = new Map<string, { id: string; sound: boolean }>()
    for (const telling of told) for (const each of telling.rows) if (!seen.has(each.messageId)) seen.set(each.messageId, { id: telling.id, sound: telling.sound })
    return seen
  }
  return { node, online, hub, client, refuse, marks, told, chat, asked, clock, open, connect, send, shown, settle, firstTold, ref, feed: () => feed!, tellings: () => tellings! }
}

describe('notifications of another computer’s bots', () => {
  it('tell nothing on a start, then tell a new message once, named by the bot’s ref', async () => {
    const h = harness()
    const registry = h.open()
    // What wanted the owner before this computer looked is not news: replayed, or sent as the feed opened.
    await h.connect(registry, [row(KEEPER, [now(3), now(5)])], [row(KEEPER, [now(3)])])
    h.send(row(KEEPER, [now(3), now(5)]))
    await h.settle()
    expect(h.told).toEqual([])
    // A bot newly in reach: what it has is not news either.
    h.send(row(KEEPER, [now(3), now(5)]), row(WRITER, [now(7)]))
    await h.settle()
    expect(h.told).toEqual([])

    h.chat.set('bm_6', { id: 'bm_6', seq: 6, author: 'bot', kind: 'text', text: 'Which flat?', question: { status: 'open', choices: [{ label: 'Flat A' }, { label: 'Flat B' }] } })
    h.send(row(KEEPER, [now(3), now(5), now(6)]), row(WRITER, [now(7)]))
    await h.settle()
    expect(h.told).toEqual([
      { id: expect.any(String), rows: [{ botId: h.ref(KEEPER), messageId: 'bm_6', seq: 6, tell: 'now' }], title: 'Server keeper', body: 'Which flat? — Flat A / Flat B', kind: 'question', sound: true }
    ])
    // The same message in the next snapshot is not told again.
    h.send(row(KEEPER, [now(3), now(5), now(6)]), row(WRITER, [now(7)]))
    await h.settle()
    expect(h.told).toHaveLength(1)
  })

  it('tells each now message alone and folds soon ones into one notification with one sound', async () => {
    const h = harness()
    const registry = h.open()
    await h.connect(registry, [row(KEEPER), row(WRITER)])
    h.send(row(KEEPER, [soon(1)]), row(WRITER))
    h.send(row(KEEPER, [soon(1), soon(2)]), row(WRITER))
    h.send(row(KEEPER, [soon(1), soon(2)]), row(WRITER, [soon(3)]))
    h.send(row(KEEPER, [soon(1), soon(2), now(4)]), row(WRITER, [soon(3)]))
    await h.settle()
    const shown = h.shown()
    expect(shown).toHaveLength(2)
    const fold = shown.find((telling) => telling.rows.length > 1)!
    expect(fold).toMatchObject({ title: 'Server keeper, Writer · 3 messages', body: 'New message' })
    expect(fold.rows.map((each) => each.messageId).sort()).toEqual(['bm_1', 'bm_2', 'bm_3'])
    expect(shown.find((telling) => telling.rows.length === 1)).toMatchObject({ rows: [{ messageId: 'bm_4', tell: 'now' }], sound: true })
    // The fold sounded once per bot within the sound limits: Server keeper first, then Writer; its updates were silent.
    expect(h.told.filter((telling) => telling.id === fold.id).map((telling) => telling.sound)).toEqual([true, false, true])
  })

  it('tell what came while the computer was away or its feed reopened once, folded without a sound, and what follows as usual', async () => {
    const h = harness()
    const registry = h.open()
    await h.connect(registry, [row(KEEPER)])
    // Away, its feed still attached: what came meanwhile and arrives before it is back is one silent fold.
    h.online.delete(h.node)
    registry.nodeOffline(h.node)
    h.send(row(KEEPER, [now(1)]))
    h.send(row(KEEPER, [now(1), now(2)]))
    await h.settle()
    expect(h.shown()).toMatchObject([{ title: 'Server keeper · 2 messages', sound: false, rows: [{ messageId: 'bm_1' }, { messageId: 'bm_2' }] }])
    // Just after it is back: told as usual, and the catch-up is not told again.
    h.online.add(h.node)
    await registry.reconcile()
    h.send(row(KEEPER, [now(1), now(2), now(3)]))
    h.send(row(KEEPER, [now(1), now(2), now(3)]))
    await h.settle()
    expect(h.shown().map((telling) => [telling.rows.map((each) => each.messageId), telling.sound])).toEqual([[['bm_1', 'bm_2'], false], [['bm_3'], true]])

    // The feed ends and is opened again at once: what came meanwhile, replayed or sent as it opens, is one silent fold.
    h.feed().error('stream_unknown')
    await h.connect(registry, [row(KEEPER, [now(1), now(2), now(3), now(4), now(5)])], [row(KEEPER, [now(1), now(2), now(3), now(4)])])
    await h.settle()
    h.send(row(KEEPER, [now(1), now(2), now(3), now(4), now(5), now(6)]))
    await h.settle()
    const first = h.firstTold()
    expect([...first.keys()]).toEqual(['bm_1', 'bm_2', 'bm_3', 'bm_4', 'bm_5', 'bm_6'])
    expect(first.get('bm_4')).toEqual({ id: first.get('bm_5')!.id, sound: false })
    expect(first.get('bm_6')).toMatchObject({ sound: true })
    // Each message was told in one notification only.
    const shownIn = new Map<string, Set<string>>()
    for (const telling of h.told) for (const each of telling.rows) shownIn.set(each.messageId, new Set([...(shownIn.get(each.messageId) ?? []), telling.id]))
    expect([...shownIn.values()].every((ids) => ids.size === 1)).toBe(true)
  })

  it('hold what comes while no window is open, and tell it as one silent fold once one opens', async () => {
    const h = harness()
    const registry = h.open({ windows: 0 })
    await h.connect(registry, [row(KEEPER), row(WRITER)])
    h.chat.set('bm_1', { id: 'bm_1', seq: 1, author: 'bot', kind: 'text', text: 'Which flat?', question: { status: 'open', choices: [{ label: 'Flat A' }] } })
    h.send(row(KEEPER, [now(1)]), row(WRITER))
    h.send(row(KEEPER, [now(1), soon(2)]), row(WRITER, [now(3)]))
    // Read before a window opened: not told.
    h.send(row(KEEPER, [now(1), soon(2)]), row(WRITER, [], 3))
    await h.settle()
    expect(h.told).toEqual([])
    expect(h.asked).not.toHaveBeenCalled()

    h.tellings().attach(1)
    await h.settle()
    expect(h.told).toEqual([
      { id: expect.any(String), rows: [{ botId: h.ref(KEEPER), messageId: 'bm_1', seq: 1, tell: 'now' }, { botId: h.ref(KEEPER), messageId: 'bm_2', seq: 2, tell: 'soon' }], title: 'While Mousse was closed: Server keeper needs you', body: 'Which flat? — Flat A', kind: 'question', sound: false }
    ])
    // Another window, or the same messages again: nothing more.
    h.tellings().attach(2)
    h.send(row(KEEPER, [now(1), soon(2)]), row(WRITER, [], 3))
    await h.settle()
    expect(h.told).toHaveLength(1)

    // Every window closed: a message older than a day by the time one opens is not told.
    h.tellings().attach(0)
    h.send(row(KEEPER, [now(1), soon(2), now(4)]), row(WRITER, [], 3))
    h.clock.now += 86_400_001
    h.tellings().attach(1)
    await h.settle()
    expect(h.told).toHaveLength(1)
  })

  it('hold no more than each bot’s feed still lists, and drop what is read, too old or quieted while no window is open', async () => {
    const h = harness()
    const registry = h.open({ windows: 0 })
    /** What is held for a window: internal, as the claim is what is kept in memory. */
    const held = () => (h.tellings() as unknown as { held: Map<string, unknown> }).held.size
    await h.connect(registry, [row(KEEPER), row(WRITER)])
    // Thirty new messages, one at a time: the feed lists only the newest twenty, and only those are held.
    for (let seq = 1; seq <= 30; seq += 1) h.send(row(KEEPER, run(1, seq)), row(WRITER))
    expect(held()).toBe(20)
    // Read up to 25 on any device: only 26 to 30 stay.
    h.send(row(KEEPER, run(1, 30), 25), row(WRITER, [now(40)]))
    expect(held()).toBe(6)
    // Muted here, with no feed change: its message goes at once.
    h.marks.set(h.ref(WRITER), 'muted', true)
    h.tellings().marksChanged()
    expect(held()).toBe(5)
    // A day later, the next snapshot drops what is too old.
    h.clock.now += 86_400_001
    h.send(row(KEEPER, run(1, 30), 25), row(WRITER, [now(40)]))
    expect(held()).toBe(0)
    h.tellings().attach(1)
    await h.settle()
    expect(h.told).toEqual([])
    expect(h.asked).not.toHaveBeenCalled()
  })

  it('ask no words of a bot read or muted before a window opens, and tell only what still wants the owner once worded', async () => {
    const h = harness()
    const registry = h.open({ windows: 0 })
    const third = 'bot-third'
    const fourth = 'bot-fourth'
    await h.connect(registry, [row(KEEPER), row(WRITER), row(third), row(fourth)])
    h.send(row(KEEPER, [now(1)]), row(WRITER, [now(2)]), row(third, [now(3)]), row(fourth, [now(4)]))
    // Read on its computer, and muted here without a word to the notifications: neither is asked for words.
    h.send(row(KEEPER, [now(1)], 1), row(WRITER, [now(2)]), row(third, [now(3)]), row(fourth, [now(4)]))
    h.marks.set(h.ref(WRITER), 'muted', true)
    // The third bot is worded at once; while the fourth's words are asked for, the third's message is read.
    let answer!: (messages: never[]) => void
    h.asked.mockImplementation(async (_node, botId) => botId === fourth ? new Promise<never[]>((resolve) => { answer = resolve }) : [])
    h.tellings().attach(1)
    await vi.waitFor(() => expect(answer).toBeDefined())
    expect(h.asked.mock.calls.map((call) => call[1])).toEqual([third, fourth])
    h.send(row(KEEPER, [now(1)], 1), row(WRITER, [now(2)]), row(third, [], 3), row(fourth, [now(4)]))
    answer([])
    await h.settle()
    expect(h.told.map((telling) => telling.rows.map((each) => each.messageId))).toEqual([['bm_4']])
  })

  it('hold again what was being worded when the last window closed, and tell it once one opens', async () => {
    const h = harness()
    const registry = h.open()
    await h.connect(registry, [row(KEEPER)])
    let answer!: (messages: never[]) => void
    h.asked.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    h.send(row(KEEPER, [now(1)]))
    await vi.waitFor(() => expect(answer).toBeDefined())
    h.tellings().attach(0)
    answer([])
    await h.settle()
    expect(h.told).toEqual([])

    // A window opens and closes again while the held message is worded: held still.
    let again!: (messages: never[]) => void
    h.asked.mockImplementationOnce(() => new Promise((resolve) => { again = resolve }))
    h.tellings().attach(1)
    await vi.waitFor(() => expect(again).toBeDefined())
    h.tellings().attach(0)
    again([])
    await h.settle()
    expect(h.told).toEqual([])

    h.tellings().attach(1)
    await h.settle()
    expect(h.told).toMatchObject([{ rows: [{ botId: h.ref(KEEPER), messageId: 'bm_1' }], sound: false }])
  })

  it('tell nothing again when an older open message comes back into the feed’s twenty', async () => {
    const h = harness()
    const registry = h.open()
    await h.connect(registry, [row(KEEPER, run(1, 25))])
    // The newest is answered, then one in the middle: 5, then 4, come back into the list.
    h.send(row(KEEPER, run(1, 24)))
    h.send(row(KEEPER, run(1, 24, [20])))
    await h.settle()
    expect(h.told).toEqual([])
    h.send(row(KEEPER, [...run(1, 24, [20]), soon(26)]))
    await h.settle()
    expect(h.shown().map((telling) => telling.rows.map((each) => each.messageId))).toEqual([['bm_26']])
  })

  it('tell nothing after a restart, for what was told before it or came since', async () => {
    const h = harness()
    const first = h.open()
    await h.connect(first, [row(KEEPER)])
    h.send(row(KEEPER, [now(1)]))
    await h.settle()
    expect(h.told).toHaveLength(1)
    first.close()

    h.told.length = 0
    const second = h.open()
    // Listed from the copy on disk first, then the feed: neither is news.
    expect(second.rows().map((each) => each.botId)).toEqual([KEEPER])
    await h.connect(second, [row(KEEPER, [now(1), now(2)])])
    h.send(row(KEEPER, [now(1), now(2)]))
    await h.settle()
    expect(h.told).toEqual([])
    h.send(row(KEEPER, [now(1), now(2), now(3)]))
    await h.settle()
    expect(h.shown().map((telling) => telling.rows[0]!.messageId)).toEqual(['bm_3'])
  })

  it('keep a bot muted or hidden here quiet, and tell its next message once unmuted', async () => {
    const h = harness()
    const registry = h.open()
    await h.connect(registry, [row(KEEPER), row(WRITER)])
    h.marks.set(h.ref(KEEPER), 'muted', true)
    h.marks.set(h.ref(WRITER), 'hidden', true)
    h.send(row(KEEPER, [now(1), soon(2)]), row(WRITER, [now(3)]))
    await h.settle()
    expect(h.told).toEqual([])
    expect(h.asked).not.toHaveBeenCalled()

    // Unmuted: what came while muted stays quiet; the next one is told.
    h.marks.set(h.ref(KEEPER), 'muted', false)
    h.send(row(KEEPER, [now(1), soon(2)]), row(WRITER, [now(3)]))
    h.send(row(KEEPER, [now(1), soon(2), now(4)]), row(WRITER, [now(3)]))
    await h.settle()
    expect(h.shown().map((telling) => telling.rows.map((each) => each.messageId))).toEqual([['bm_4']])
  })

  it('withdraw a notification once its messages are read on any device or answered, and keep one still open', async () => {
    const h = harness()
    const registry = h.open()
    await h.connect(registry, [row(KEEPER), row(WRITER)])
    h.send(row(KEEPER, [now(1), now(2)]), row(WRITER, [now(5)]))
    await h.settle()
    expect(h.shown()).toHaveLength(3)

    // Read on its own computer up to 1: the feed's read mark passes it, and its attention no longer lists it.
    h.send(row(KEEPER, [now(2)], 1), row(WRITER, [now(5)]))
    expect(h.shown().map((telling) => telling.rows[0]!.messageId).sort()).toEqual(['bm_2', 'bm_5'])
    // The read mark alone passing a message withdraws it, whatever the attention list still says.
    h.send(row(KEEPER, [now(2)], 2), row(WRITER, [now(5)]))
    expect(h.shown().map((telling) => telling.rows[0]!.messageId)).toEqual(['bm_5'])
    // Answered elsewhere: it leaves the attention list with the read mark where it was.
    h.send(row(KEEPER, [], 2), row(WRITER, []))
    expect(h.shown()).toEqual([])
    expect(h.told.filter((telling) => !telling.rows.length)).toHaveLength(3)
  })

  it('withdraw a lost bot’s notifications, and every one of a computer whose feed refuses this one', async () => {
    const h = harness()
    const registry = h.open()
    await h.connect(registry, [row(KEEPER), row(WRITER)])
    h.send(row(KEEPER, [now(1)]), row(WRITER, [now(2)]))
    await h.settle()
    expect(h.shown()).toHaveLength(2)

    // The feed no longer lists WRITER: taken from its Devices.
    h.send(row(KEEPER, [now(1)]))
    expect(h.shown().map((telling) => telling.rows[0]!.botId)).toEqual([h.ref(KEEPER)])
    // The bot level goes to Off: the feed ends and its reopening is refused.
    h.refuse.feed = new NetError('forbidden', 'Bots are off for this device.', { details: { reason: 'bots_off' } })
    h.feed().error('stream_unknown')
    await vi.waitFor(() => expect(registry.rows()).toEqual([]))
    expect(h.shown()).toEqual([])
  })
})
