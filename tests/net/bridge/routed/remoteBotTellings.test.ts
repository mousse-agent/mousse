/**
 * Notifications here for the bots of another computer (`RemoteBotTellings`), fed by the real registry
 * (`RemoteBotRegistry`, its copy on disk) and the real marks (`BotMarksStore`) over a scripted Bridge, so each feed
 * snapshot, the moment the feed catches up and each way it ends are under the test's control. The same over two real
 * daemons is `tests/netEngine/checks/remoteBotTellings.test.ts`.
 *
 * Inputs: a feed snapshot replayed as the feed opens, the first one after it caught up, live ones; a start, a restart, a
 * computer away and back, a feed that ends and reopens; `now` and `soon` messages; a bot muted or hidden here; the read
 * mark passing a message, a message answered elsewhere; a bot the feed drops, a feed refused.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteBotRegistry } from '../../../../src/mms/bridge/routed/RemoteBotRegistry'
import { OPEN_SETTLE_MS, RemoteBotTellings } from '../../../../src/mms/bridge/routed/RemoteBotTellings'
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
const row = (id: string, attention: Entry[] = [], readSeq = 0) => ({
  id, name: id === KEEPER ? 'Server keeper' : 'Writer', stateText: 'Idle', readSeq, telling: { attention: [...attention].reverse() }
})
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
  /** The notifications' clock: a feed live again only sets what is known for `OPEN_SETTLE_MS`. */
  const clock = { now: 1_800_000_000_000 }
  const settled = () => { clock.now += OPEN_SETTLE_MS }
  const open = () => {
    const tellings = new RemoteBotTellings({
      emit: (telling) => told.push(telling),
      quiet: (ref) => {
        const m = marks.get(ref)
        return m.muted === true || m.hidden === true
      },
      sounds: () => sounds,
      messages: asked,
      clock: { now: () => clock.now }
    })
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
   * Opens the registry's feed and lets it catch up with `bots`, as a start does, then sends them again as the bot's
   * computer does for a reader that opens its feed. `settle` lets the settling time pass after it.
   */
  const connect = async (registry: RemoteBotRegistry, bots: ReturnType<typeof row>[], settle = true) => {
    feed = undefined
    await registry.reconcile()
    await vi.waitFor(() => expect(feed).toBeDefined())
    feed!.update({ kind: 'snapshot', value: feedOf(...bots) })
    feed!.caught?.(true)
    feed!.update({ kind: 'snapshot', value: feedOf(...bots) })
    if (settle) settled()
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
  return { node, online, hub, client, refuse, marks, told, chat, asked, open, connect, send, shown, settle, settled, ref, feed: () => feed! }
}

describe('notifications of another computer’s bots', () => {
  it('tell nothing on a start, then tell a new message once, named by the bot’s ref', async () => {
    const h = harness()
    const registry = h.open()
    // What wanted the owner before this computer looked is not news: replayed, sent as the feed opened, or a moment later.
    await h.connect(registry, [row(KEEPER, [now(3)])], false)
    h.send(row(KEEPER, [now(3), now(5)]))
    await h.settle()
    expect(h.told).toEqual([])
    h.settled()
    // A bot newly in reach: what it has is not news either.
    h.send(row(KEEPER, [now(3), now(5)]), row(WRITER, [now(7)]))
    await h.settle()
    expect(h.told).toEqual([])

    h.chat.set('bm_4', { id: 'bm_4', seq: 4, author: 'bot', kind: 'text', text: 'Which flat?', question: { status: 'open', choices: [{ label: 'Flat A' }, { label: 'Flat B' }] } })
    h.send(row(KEEPER, [now(3), now(4), now(5)]), row(WRITER, [now(7)]))
    await h.settle()
    expect(h.told).toEqual([
      { id: expect.any(String), rows: [{ botId: h.ref(KEEPER), messageId: 'bm_4', seq: 4, tell: 'now' }], title: 'Server keeper', body: 'Which flat? — Flat A / Flat B', kind: 'question', sound: true }
    ])
    // The same message in the next snapshot is not told again.
    h.send(row(KEEPER, [now(3), now(4), now(5)]), row(WRITER, [now(7)]))
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

  it('tell nothing for what came while the computer was away, nor when the feed reopens, and tell again after', async () => {
    const h = harness()
    const registry = h.open()
    await h.connect(registry, [row(KEEPER)])
    // Away, its feed still attached: what came meanwhile arrives while it is away or just after it is back.
    h.online.delete(h.node)
    registry.nodeOffline(h.node)
    h.send(row(KEEPER, [now(1)]))
    h.online.add(h.node)
    await registry.reconcile()
    h.send(row(KEEPER, [now(1), now(2)]))
    await h.settle()
    expect(h.told).toEqual([])
    h.settled()
    h.send(row(KEEPER, [now(1), now(2), now(3)]))
    await h.settle()
    expect(h.shown().map((telling) => telling.rows[0]!.messageId)).toEqual(['bm_3'])
    // The feed ends and is opened again at once: what it replays and sends as it opens sets what is known.
    h.feed().error('stream_unknown')
    await h.connect(registry, [row(KEEPER, [now(1), now(2), now(3), now(4)])])
    await h.settle()
    expect(h.shown().map((telling) => telling.rows[0]!.messageId)).toEqual(['bm_3'])
    h.send(row(KEEPER, [now(1), now(2), now(3), now(4), now(6)]))
    await h.settle()
    expect(h.shown().map((telling) => telling.rows[0]!.messageId)).toEqual(['bm_3', 'bm_6'])
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
