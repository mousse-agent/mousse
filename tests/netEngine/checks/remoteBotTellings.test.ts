/**
 * Notifications of another computer's bot on the viewing computer, over two real daemons paired through the engine: the
 * owner's bot posts in its chat (the real store classifies it and lists it in the bots feed), and the viewer's windows
 * are told (`bots.tell`) as they are of the viewer's own bots, or not: nothing of what a bot had when it came into
 * reach, what came while the owner was away once and silently, what came while no window was open once one opens,
 * nothing for a bot muted here, and a notification is withdrawn once the owner's computer marks the chat read. A bot of
 * the viewer's own, muted there, tells nothing either. The same rules with a scripted Bridge, a start and a restart
 * included, are `tests/net/bridge/routed/remoteBotTellings.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NodeId } from '../../../src/shared/net'
import type { BotTelling } from '../../../src/shared/bots/personal/telling'
import { Fabric, type Computer } from './harness'

describe('notifications of another computer’s bots', () => {
  const fabric = new Fabric()
  let owner: Computer
  let viewer: Computer
  let viewerOnOwner: NodeId
  let ownerOnViewer: NodeId
  let keeper: string
  const ref = (botId: string) => `${ownerOnViewer}:${botId}`
  /** What the viewer's windows were told, in order. */
  const told = (): BotTelling[] => viewer.events.filter((event) => event.type === 'bots.tell').map((event) => event.data as BotTelling)
  /** What the viewer shows now: each notification's latest form, withdrawn ones left out. */
  const shown = () => {
    const last = new Map<string, BotTelling>()
    for (const telling of told()) last.set(telling.id, telling)
    return [...last.values()].filter((telling) => telling.rows.length)
  }
  /** The owner's bot says something, told `now` (a reply to the owner) or `soon`. */
  const say = (text: string, tell: 'now' | 'soon') => {
    const store = owner.mms.botStore!
    let id = ''
    store.db.transaction(() => {
      id = owner.mms.personalBots!.chat.post({ botId: keeper, author: 'bot', kind: 'text', text }).id
      store.run('UPDATE bot_messages SET tell = ? WHERE id = ?', tell, id)
    })
    return store.message(id)!
  }
  /** The viewer's copy of the owner's feed lists the bot with `messageId` as its newest message. */
  const listedUpTo = (messageId: string) =>
    vi.waitFor(() => expect(viewer.mms.bridge.remoteBots.row(ownerOnViewer, keeper)?.telling.latest?.id).toBe(messageId), { timeout: 30_000 })
  /** A moment for a notification that should not come to have come. */
  const quietFor = () => new Promise((resolve) => setTimeout(resolve, 1_000))

  beforeAll(async () => {
    owner = await fabric.computer('owner')
    viewer = await fabric.computer('viewer')
    const paired = await fabric.pair(owner, viewer)
    viewerOnOwner = paired.callerOnOwner
    ownerOnViewer = paired.ownerOnCaller
    await fabric.settle()
    await fabric.connect(viewer, ownerOnViewer)
    vi.spyOn(owner.mms.personalBots!, 'enqueueChat').mockResolvedValue(undefined as never)
    // Out of the viewer's reach until the first test adds it.
    keeper = (await owner.mms.personalBots!.service.create({ look: { colour: 'teal', accessory: 'cap' }, name: 'Server keeper', description: 'keeper', clientRequestId: 'tellings-bot-1' })).bot.id
    owner.mms.botDeviceAccess.set(keeper, { mode: 'chosen', nodes: [] })
    await owner.dispatch('netEngine.workOnThreads', { enabled: false }, true)
    // A window that shows notifications is open on the viewer.
    viewer.mms.setTellingWindows(1)
  }, 300_000)
  afterAll(() => fabric.close(), 60_000)

  it('tells nothing of what a bot had when it came into reach, tells a new message once, and withdraws it once read on the owner', async () => {
    const before = say('Restarted the web server.', 'now')
    owner.mms.botDeviceAccess.set(keeper, { mode: 'chosen', nodes: [viewerOnOwner] })
    await listedUpTo(before.id)
    expect(viewer.mms.bridge.remoteBots.row(ownerOnViewer, keeper)?.telling.attention.map((entry) => entry.id)).toEqual([before.id])
    await quietFor()
    expect(told()).toEqual([])

    const asked = say('Restart the database too?', 'now')
    await vi.waitFor(() => expect(shown()).toHaveLength(1), { timeout: 30_000 })
    expect(shown()[0]).toMatchObject({ title: 'Server keeper', body: 'Restart the database too?', kind: 'completed', sound: true, rows: [{ botId: ref(keeper), messageId: asked.id, tell: 'now' }] })

    // Read on the bot's own computer: the read mark crosses in the feed and the notification is taken back here.
    owner.mms.personalBots!.markRead(keeper, asked.seq)
    await vi.waitFor(() => expect(shown()).toEqual([]), { timeout: 30_000 })
    expect(told().map((telling) => telling.rows.length)).toEqual([1, 0])
  }, 120_000)

  it('tells what came while the owner was away once, without a sound, and what follows as usual', async () => {
    const count = told().length
    await fabric.restartHelper(owner)
    await vi.waitFor(() => expect(viewer.mms.bridge.remoteBots.row(ownerOnViewer, keeper)?.offline).toBe(true), { timeout: 30_000 })
    const away = say('Restore the backup now?', 'now')
    await fabric.connect(viewer, ownerOnViewer)
    await listedUpTo(away.id)
    await vi.waitFor(() => expect(shown()).toHaveLength(1), { timeout: 30_000 })
    expect(shown()[0]).toMatchObject({ title: 'Server keeper', body: 'Restore the backup now?', sound: false, rows: [{ botId: ref(keeper), messageId: away.id }] })

    // Just after it is back: told as usual, and what came while away is not told again.
    const next = say('The disk is nearly full.', 'now')
    await vi.waitFor(() => expect(shown()).toHaveLength(2), { timeout: 30_000 })
    await quietFor()
    expect(told().slice(count).map((telling) => [telling.rows.map((each) => each.messageId), telling.sound])).toEqual([[[away.id], false], [[next.id], true]])
    owner.mms.personalBots!.markRead(keeper, next.seq)
    await vi.waitFor(() => expect(shown()).toEqual([]), { timeout: 30_000 })
  }, 180_000)

  it('holds what comes while no window is open on the viewer, and tells it once one opens', async () => {
    viewer.mms.setTellingWindows(0)
    const count = told().length
    const asked = say('Which disk should I clear?', 'now')
    await listedUpTo(asked.id)
    await quietFor()
    expect(told()).toHaveLength(count)

    viewer.mms.setTellingWindows(1)
    await vi.waitFor(() => expect(told()).toHaveLength(count + 1), { timeout: 30_000 })
    expect(told()[count]).toMatchObject({ title: 'Server keeper', body: 'Which disk should I clear?', sound: false, rows: [{ botId: ref(keeper), messageId: asked.id }] })
    owner.mms.personalBots!.markRead(keeper, asked.seq)
    await vi.waitFor(() => expect(shown()).toEqual([]), { timeout: 30_000 })
  }, 120_000)

  it('tells nothing for a bot muted on the viewer, its own bots included', async () => {
    await viewer.dispatch('bots.marks.set', { botId: ref(keeper), mark: 'muted', on: true })
    const count = told().length
    const quiet = say('Nobody needs to hear this.', 'now')
    await listedUpTo(quiet.id)
    // A later message is listed too, so the muted one had every chance to be told.
    const later = say('Nor this.', 'soon')
    await listedUpTo(later.id)
    expect(told()).toHaveLength(count)

    // The viewer's own bot, muted there, stays quiet as well; its other bot still tells.
    vi.spyOn(viewer.mms.personalBots!, 'enqueueChat').mockResolvedValue(undefined as never)
    // The pass a running app makes once it is up; the checks' daemons skip it.
    await viewer.mms.personalBots!.reconcileOnStartup()
    const create = (name: string, request: string) =>
      viewer.mms.personalBots!.service.create({ look: { colour: 'teal', accessory: 'cap' }, name, description: name, clientRequestId: request })
    const mine = (await create('Muted helper', 'tellings-local-1')).bot.id
    const other = (await create('Loud helper', 'tellings-local-2')).bot.id
    await viewer.dispatch('bots.marks.set', { botId: mine, mark: 'muted', on: true })
    const local: BotTelling[] = []
    viewer.mms.personalBots!.events.on('tell', (telling: BotTelling) => local.push(telling))
    viewer.mms.personalBots!.setTellingWindows(1)
    viewer.mms.personalBots!.chat.post({ botId: mine, author: 'bot', kind: 'text', text: 'Muted here' })
    const loud = viewer.mms.personalBots!.chat.post({ botId: other, author: 'bot', kind: 'text', text: 'Heard here' })
    await viewer.mms.personalBots!.deliverDueReminders()
    expect(local.flatMap((telling) => telling.rows.map((each) => each.messageId))).toEqual([loud.id])
  }, 120_000)
})
