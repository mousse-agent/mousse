/**
 * A window's calls about a bot of another computer (`BotRouter`, `AttachedBots`), over two real daemons paired through
 * the engine: the viewer's window names the owner's bot by its qualified id and the call runs on the owner, under the
 * owner's gate. "Work on threads" stays off on the owner throughout: bots stand apart from thread sharing.
 *
 * What is routed, and what is not:
 * - a qualified id from a window: routed; the same id from the command line: refused, nothing sent;
 * - a plain id: this computer's bot, nothing sent;
 * - a row kept to the bot's own computer (`local`): refused, nothing sent;
 * - a row above the viewer's bot level: the owner's refusal, and nothing changes there;
 * - a write while the owner is away: refused at once, nothing kept to send later; a read of the chat answers the copy;
 * - a write whose reply is lost: asked for again by its request id, and run once.
 */
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NodeId } from '../../../src/shared/net'
import { qualifyId } from '../../../src/shared/threadRef'
import { dispatchMethod } from '../../../src/mms/protocol/handlers'
import type { BotRouter } from '../../../src/mms/bridge/routed/BotRouter'
import type { RemoteBotRegistry } from '../../../src/mms/bridge/routed/RemoteBotRegistry'
import { Fabric, codeOf, type Computer } from './harness'

describe('a window’s calls about a bot of another computer', () => {
  const fabric = new Fabric()
  let owner: Computer
  let viewer: Computer
  let viewerOnOwner: NodeId
  let ownerOnViewer: NodeId
  let keeper: string
  let q: string
  const registry = (): RemoteBotRegistry => viewer.mms.bridge.remoteBots
  const router = (): BotRouter => viewer.mms.bridge.botRouter
  const refused = async (call: Promise<unknown>): Promise<{ code?: string; details?: any }> => {
    try {
      await call
    } catch (error) {
      // The error's own code: the harness's `codeOf` prefers a refusal's reason over it.
      const code = (error as { code?: unknown }).code
      return { code: typeof code === 'string' ? code : codeOf(error), details: (error as { details?: unknown }).details }
    }
    throw new Error('The call was not refused.')
  }
  /** The bot calls the viewer's app sent the owner since `from`, by method. */
  const sent = (from: number): string[] =>
    fabric.crossed
      .slice(from)
      .filter((row) => row.from === viewer.endpoint && row.label === 'mousse.rpc' && row.header.t === 'call' && String(row.header.method).startsWith('bots.'))
      .map((row) => String(row.header.method))
  /** A call from this computer's command line. */
  const fromCli = (method: string, params: unknown) =>
    dispatchMethod(
      {
        mms: viewer.mms,
        connection: { id: 'cli-1', clientType: 'cli', capabilities: new Set(), binding: { profileId: viewer.mms.profileId, epoch: 1 } },
        globalSequence: () => 0
      },
      method,
      params
    )
  const say = (botId: string, seq: number, text: string) =>
    owner.mms.personalBots!.events.emit('message', {
      botId,
      message: { id: `bm_${botId}_${seq}`, seq, at: new Date().toISOString(), author: 'bot', kind: 'reply', text, chips: [] },
      botName: 'bot',
      quiet: false
    })
  const ownerChat = () => owner.mms.personalBots!.service.chatList(keeper, {}).messages.map((message) => message.text)

  beforeAll(async () => {
    owner = await fabric.computer('owner')
    viewer = await fabric.computer('viewer')
    const paired = await fabric.pair(owner, viewer)
    viewerOnOwner = paired.callerOnOwner
    ownerOnViewer = paired.ownerOnCaller
    await fabric.settle()
    await fabric.connect(viewer, ownerOnViewer)
    // A real bot starts its first turn on the computer's own providers; what is tested here is what crosses the wire.
    vi.spyOn(owner.mms.personalBots!, 'enqueueChat').mockResolvedValue(undefined as never)
    vi.spyOn(viewer.mms.personalBots!, 'enqueueChat').mockResolvedValue(undefined as never)
    keeper = (await owner.mms.personalBots!.service.create({ look: { colour: 'teal', accessory: 'cap' }, name: 'Server keeper', description: 'keeper', clientRequestId: 'router-bot-1' })).bot.id
    owner.mms.botDeviceAccess.set(keeper, { mode: 'chosen', nodes: [viewerOnOwner] })
    await owner.dispatch('netEngine.workOnThreads', { enabled: false }, true)
    q = qualifyId(ownerOnViewer, keeper)
    await vi.waitFor(() => expect(registry().row(ownerOnViewer, keeper)?.offline).toBeUndefined(), { timeout: 30_000 })
  }, 300_000)
  afterAll(() => fabric.close(), 60_000)

  it('runs a window’s call on the bot’s computer and names the bot as the window does; the command line is refused', async () => {
    const detail = await viewer.dispatch('bots.get', { botId: q })
    expect(detail.summary).toMatchObject({ id: q, name: 'Server keeper' })

    const from = fabric.crossed.length
    expect(await refused(fromCli('bots.get', { botId: q }))).toMatchObject({ code: 'forbidden' })
    expect(await refused(fromCli('bots.chat.send', { botId: q, text: 'from the shell', clientRequestId: 'cli-send-1' }))).toMatchObject({ code: 'forbidden' })
    expect(sent(from)).toEqual([])
    expect(ownerChat()).not.toContain('from the shell')
  }, 60_000)

  it('keeps a plain id on this computer, and never sends a row kept to the bot’s own computer', async () => {
    const mine = (await viewer.mms.personalBots!.service.create({ look: { colour: 'red', accessory: 'hat' }, name: 'Local one', description: 'local', clientRequestId: 'router-local-1' })).bot.id
    const from = fabric.crossed.length
    expect((await viewer.dispatch('bots.get', { botId: mine })).summary).toMatchObject({ id: mine, name: 'Local one' })
    expect(await refused(viewer.dispatch('bots.memory.export', { botId: q, dir: viewer.home }))).toMatchObject({ code: 'not_available_remotely' })
    expect(await refused(viewer.dispatch('bots.chainHold.answer', { botId: q, holdId: 'hold-1', answer: 'continue' }))).toMatchObject({ code: 'not_available_remotely' })
    expect(sent(from)).toEqual([])
    // And a row the owner does offer goes there.
    expect((await viewer.dispatch('bots.get', { botId: q })).summary.id).toBe(q)
    expect(sent(from)).toEqual(['bots.get'])
  }, 60_000)

  it('passes on the owner’s refusal of a row above the viewer’s bot level, and nothing changes there', async () => {
    // A device starts at Use: it chats with the owner's bots, and sets none of them up.
    const no = await refused(viewer.dispatch('bots.personal.pause', { botId: q }))
    expect(no).toMatchObject({ code: 'computer_forbidden', details: { reason: 'bots_full_needed', node: ownerOnViewer } })
    expect(owner.mms.personalBots!.service.get(keeper).summary.paused).toBeFalsy()
  }, 60_000)

  it('streams a shown chat to the windows while one shows it, and closes the stream when the last lets go', async () => {
    const before = viewer.events.length
    expect(await viewer.dispatch('bots.focus', { botId: q, focused: true })).toEqual({ routed: true, focused: true })
    expect(registry().chats.openChats()).toEqual([{ node: ownerOnViewer, botId: keeper, attached: true }])
    say(keeper, 1, 'The servers are up.')
    await vi.waitFor(
      () => expect(viewer.events.slice(before).some((event) => event.type === 'bots.message' && event.data.botId === q && event.data.message.text === 'The servers are up.')).toBe(true),
      { timeout: 20_000 }
    )
    // A second window on the same chat, then both let go: the stream closes with the last.
    const second = { id: 'window-2', clientType: 'gui' as const, capabilities: new Set<string>(), binding: { profileId: viewer.mms.profileId, epoch: 1 } }
    await dispatchMethod({ mms: viewer.mms, connection: second, globalSequence: () => 0 }, 'bots.focus', { botId: q, focused: true })
    await viewer.dispatch('bots.focus', { botId: q, focused: false })
    expect(registry().chats.openChats()).toHaveLength(1)
    await dispatchMethod({ mms: viewer.mms, connection: second, globalSequence: () => 0 }, 'bots.focus', { botId: q, focused: false })
    expect(registry().chats.openChats()).toEqual([])
    expect(router().attached.state()).toEqual([])
    // Nothing more reaches the windows from a chat nobody shows.
    const after = viewer.events.length
    say(keeper, 2, 'Nobody is looking.')
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(viewer.events.slice(after).filter((event) => event.type === 'bots.message')).toEqual([])
  }, 60_000)

  it('lists the other computers’ bots to a window under their qualified ids, with the computer each lives on; the command line is refused', async () => {
    const home = owner.mms.personalBots!.service.get(keeper).summary.homeThreadId
    expect(home).toEqual(expect.any(String))
    const { bots } = await viewer.dispatch('bots.remote.list', {})
    expect(bots).toEqual([expect.objectContaining({ id: q, name: 'Server keeper', homeThreadId: qualifyId(ownerOnViewer, home!), lives: { node: ownerOnViewer, name: expect.any(String) } })])
    // What the feed adds for this computer's own reading stays here.
    for (const key of ['botId', 'readSeq', 'telling', 'activity']) expect(bots[0]).not.toHaveProperty(key)
    expect(await refused(fromCli('bots.remote.list', {}))).toMatchObject({ code: 'forbidden' })
  }, 60_000)

  it('has a window read a shown chat again when its stream opens, and passes on the reply as the bot writes it', async () => {
    const home = owner.mms.personalBots!.service.get(keeper).summary.homeThreadId!
    const before = viewer.events.length
    const heard = (match: (event: (typeof viewer.events)[number]) => boolean) => viewer.events.slice(before).some(match)
    await viewer.dispatch('bots.focus', { botId: q, focused: true })
    try {
      await vi.waitFor(() => expect(heard((event) => event.type === 'bots.changed' && event.data.botId === q && event.data.reread === true)).toBe(true), { timeout: 20_000 })
      owner.mms.orchestrator.emit('thread-message-updated', { threadId: home, message: { id: 'm_reply_1', role: 'assistant', content: 'Checking the disks', hidden: false } })
      await vi.waitFor(() => expect(viewer.events.slice(before).filter((event) => event.type === 'bots.reply').map((event) => event.data)).toEqual([
        { botId: q, messageId: 'm_reply_1', role: 'assistant', text: 'Checking the disks', added: false }
      ]), { timeout: 20_000 })
    } finally {
      await viewer.dispatch('bots.focus', { botId: q, focused: false })
    }
  }, 60_000)

  it('sends a write once when its reply is lost: asked for again by the same request id', async () => {
    const send = vi.spyOn(owner.mms.personalBots!.service, 'chatSend')
    try {
      const dropped = new Promise<void>((resolve) => {
        fabric.decide = (row) => {
          if (row.from !== owner.endpoint || row.method !== 'bots.chat.send' || row.header.t !== 'result') return
          fabric.decide = undefined
          viewer.kill()
          resolve()
          return 'drop'
        }
      })
      const call = viewer.dispatch('bots.chat.send', { botId: q, text: 'once only', clientRequestId: 'router-lost-1' })
      await dropped
      const from = fabric.crossed.length
      await fabric.restartHelper(viewer)
      await fabric.connect(viewer, ownerOnViewer)
      const result = await call
      expect(result.message).toMatchObject({ text: 'once only' })
      // Its result was asked for by the same request id; the call was not sent again.
      const asked = fabric.crossed
        .slice(from)
        .filter((row) => row.from === viewer.endpoint && row.label === 'mousse.rpc')
        .map((row) => (row.header.t === 'call' ? `call ${String(row.header.method)}` : String(row.header.t)))
        .filter((line) => line === 'result.get' || line === 'call bots.chat.send')
      expect(asked[0]).toBe('result.get')
      expect(send).toHaveBeenCalledTimes(1)
      expect(ownerChat().filter((text) => text === 'once only')).toHaveLength(1)
    } finally {
      send.mockRestore()
    }
  }, 120_000)

  it('refuses a write at once while the owner is away and keeps nothing to send; the chat reads from the copy', async () => {
    // The chat was shown once, so the viewer holds its copy.
    await viewer.dispatch('bots.focus', { botId: q, focused: true })
    await vi.waitFor(() => expect(registry().chats.messages(ownerOnViewer, keeper).length).toBeGreaterThan(0), { timeout: 20_000 })
    await viewer.dispatch('bots.focus', { botId: q, focused: false })

    const heardFrom = viewer.events.length
    await fabric.restartHelper(owner)
    await vi.waitFor(() => expect(registry().row(ownerOnViewer, keeper)?.offline).toBe(true), { timeout: 30_000 })
    // The windows are told to list again, and list the bot as offline.
    expect(viewer.events.slice(heardFrom).some((event) => event.type === 'bots.changed' && event.data.remote === true)).toBe(true)
    expect((await viewer.dispatch('bots.remote.list', {})).bots).toEqual([expect.objectContaining({ id: q, lives: { node: ownerOnViewer, name: expect.any(String), offline: true } })])
    const from = fabric.crossed.length
    const started = Date.now()
    expect(await refused(viewer.dispatch('bots.chat.send', { botId: q, text: 'while away', clientRequestId: 'router-away-1' }))).toMatchObject({ code: 'computer_offline' })
    expect(Date.now() - started).toBeLessThan(1_000)
    const copy = await viewer.dispatch('bots.chat.list', { botId: q })
    expect(copy.stale).toBe(true)
    expect(copy.messages.map((message: { text: string }) => message.text)).toContain('The servers are up.')

    // Back: the refused message was never kept to send.
    await fabric.connect(viewer, ownerOnViewer)
    await vi.waitFor(() => expect(registry().row(ownerOnViewer, keeper)?.offline).toBeUndefined(), { timeout: 30_000 })
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(sent(from).filter((method) => method === 'bots.chat.send')).toEqual([])
    expect(ownerChat()).not.toContain('while away')
    const live = await viewer.dispatch('bots.chat.list', { botId: q })
    expect(live.stale).toBeUndefined()
    expect((await viewer.dispatch('bots.remote.list', {})).bots[0].lives).toEqual({ node: ownerOnViewer, name: expect.any(String) })
  }, 120_000)

  it('answers a chat read from the copy when the owner is connected but does not answer in time', async () => {
    const options = (router() as unknown as { options: { readWaitMs?: number } }).options
    options.readWaitMs = 500
    // The call never reaches the owner, and the link stays up: the viewer hears nothing back, as from a slow owner.
    fabric.decide = (row) =>
      row.from === viewer.endpoint && row.label === 'mousse.rpc' && row.header.t === 'call' && row.header.method === 'bots.chat.list' ? 'drop' : undefined
    try {
      expect(registry().row(ownerOnViewer, keeper)?.offline).toBeUndefined()
      const started = Date.now()
      const copy = await viewer.dispatch('bots.chat.list', { botId: q })
      expect(Date.now() - started).toBeLessThan(4_000)
      expect(copy.stale).toBe(true)
      expect(copy.messages.map((message: { text: string }) => message.text)).toContain('The servers are up.')
    } finally {
      fabric.decide = undefined
      delete options.readWaitMs
    }
  }, 60_000)

  it('passes on why the bot’s computer refused an action, and only that', async () => {
    const no = await refused(viewer.dispatch('bots.actions.answer', { botId: q, actionId: 'act_missing', digest: 'none', answer: 'send' }))
    expect(no.code).toBe('conflict')
    expect(no.details).toEqual({ node: ownerOnViewer, name: expect.any(String), reason: 'bot_action_gone' })
  }, 60_000)

  it('lets go of what a window showed when its connection ends or drops', async () => {
    const ended = new AbortController()
    const first = { id: 'window-ends', clientType: 'gui' as const, capabilities: new Set<string>(), binding: { profileId: viewer.mms.profileId, epoch: 1 }, lifetime: ended.signal }
    await dispatchMethod({ mms: viewer.mms, connection: first, globalSequence: () => 0 }, 'bots.focus', { botId: q, focused: true })
    expect(registry().chats.openChats()).toHaveLength(1)
    ended.abort()
    expect(registry().chats.openChats()).toEqual([])

    // A window whose socket drops: the server says the connection closed.
    const dropped = { id: 'window-drops', clientType: 'gui' as const, capabilities: new Set<string>(), binding: { profileId: viewer.mms.profileId, epoch: 1 } }
    await dispatchMethod({ mms: viewer.mms, connection: dropped, globalSequence: () => 0 }, 'bots.focus', { botId: q, focused: true })
    expect(registry().chats.openChats()).toHaveLength(1)
    viewer.mms.domains!.notifyConnectionClosed('window-drops')
    expect(registry().chats.openChats()).toEqual([])
    expect(router().attached.state()).toEqual([])
  }, 60_000)

  it('refuses a call too large to send, and sends nothing', async () => {
    const from = fabric.crossed.length
    const no = await refused(viewer.dispatch('bots.chat.send', { botId: q, text: 'x'.repeat(50 * 1024), clientRequestId: 'router-large-1' }))
    expect(no.code).toBe('too_large')
    expect(sent(from)).toEqual([])
  }, 60_000)

  it('sends a picture to the bot, a part at a time, and shows the bot’s pictures here from a copy read from its files', async () => {
    const png = (size: number, fill: number): Buffer => {
      const data = Buffer.alloc(size, fill)
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data)
      return data
    }
    const mine = join(viewer.home, 'outbox')
    mkdirSync(mine, { recursive: true })
    const picture = png(70 * 1024, 1)
    writeFileSync(join(mine, 'pic.png'), picture)
    const from = fabric.crossed.length
    const { message } = await viewer.dispatch('bots.chat.send', { botId: q, text: 'Look', clientRequestId: 'router-pic-1', attachments: [{ name: 'pic.png', path: join(mine, 'pic.png') }] })
    // The file went first, in 32 KiB parts, then the message naming it; the bot's computer has it in the bot's files.
    expect(sent(from)).toEqual(['bots.stage', 'bots.stage', 'bots.stage', 'bots.chat.send'])
    expect(message.attachments).toEqual([{ name: 'pic.png', mime: 'image/png', image: true, path: expect.stringMatching(/^attachments\/.+\/pic\.png$/) }])
    const folder = owner.mms.personalBots!.service.filesFolderOf(keeper)
    const there = owner.mms.personalBots!.service.chatList(keeper, {}).messages.find((row) => row.text === 'Look')!
    expect(there.attachments).toEqual([{ name: 'pic.png', path: join(folder, message.attachments[0].path) }])
    expect(readFileSync(there.attachments![0]!.path).equals(picture)).toBe(true)
    // The window shows it from a file of this computer, the same bytes.
    const shown = await viewer.dispatch('bots.remote.file', { botId: q, path: message.attachments[0].path })
    expect(shown).toMatchObject({ name: 'pic.png', size: picture.length })
    expect(shown.path.startsWith(viewer.home)).toBe(true)
    expect(readFileSync(shown.path).equals(picture)).toBe(true)

    // The bot's picture: read from its files folder there, a page at a time, into a copy here.
    const made = png(90 * 1024, 2)
    mkdirSync(join(folder, 'images'), { recursive: true })
    writeFileSync(join(folder, 'images', 'chart.png'), made)
    owner.mms.personalBots!.chat.post({ botId: keeper, author: 'bot', kind: 'text', text: 'Here is the chart.', attachments: [{ name: 'chart.png', path: join(folder, 'images', 'chart.png') }] })
    const page = await viewer.dispatch('bots.chat.list', { botId: q })
    const reply = page.messages.find((row: { text: string }) => row.text === 'Here is the chart.')
    expect(reply.attachments).toEqual([{ name: 'chart.png', mime: 'image/png', image: true, path: 'images/chart.png' }])
    expect(JSON.stringify(page)).not.toContain(folder)
    const before = fabric.crossed.length
    const copy = await viewer.dispatch('bots.remote.file', { botId: q, path: 'images/chart.png' })
    expect(readFileSync(copy.path).equals(made)).toBe(true)
    expect(sent(before)).toEqual(['bots.chat.file', 'bots.chat.file', 'bots.chat.file'])
  }, 60_000)

  it('refuses an SVG, a way out of the bot’s files and a link out of them, from either side', async () => {
    const mine = join(viewer.home, 'outbox')
    mkdirSync(mine, { recursive: true })
    writeFileSync(join(mine, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    const from = fabric.crossed.length
    expect(await refused(viewer.dispatch('bots.chat.send', { botId: q, text: 'Logo', clientRequestId: 'router-svg-1', attachments: [{ name: 'logo.svg', path: join(mine, 'logo.svg') }] })))
      .toMatchObject({ code: 'bot_attachment_refused' })
    expect(sent(from)).toEqual([])
    // One that names itself a picture goes up, and the bot's computer refuses it at its first part: certainly, not as a
    // change that may have happened, and nothing reaches the bot.
    writeFileSync(join(mine, 'sneaky.png'), '<svg xmlns="http://www.w3.org/2000/svg" onload="x()"/>')
    const sneaky = await refused(viewer.dispatch('bots.chat.send', { botId: q, text: 'Sneaky', clientRequestId: 'router-svg-2', attachments: [{ name: 'sneaky.png', path: join(mine, 'sneaky.png') }] }))
    expect(sneaky).toMatchObject({ code: 'conflict', details: { reason: 'svg' } })
    expect(sent(from)).toEqual(['bots.stage'])
    expect(ownerChat()).not.toContain('Sneaky')
    expect(await refused(viewer.dispatch('bots.remote.file', { botId: q, path: '../../secret.png' }))).toMatchObject({ code: 'invalid_params' })
    expect(await refused(viewer.dispatch('bots.remote.file', { botId: q, path: '/etc/hosts' }))).toMatchObject({ code: 'invalid_params' })
    const folder = owner.mms.personalBots!.service.filesFolderOf(keeper)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'drawing.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    writeFileSync(join(owner.home, 'outside.png'), 'not the bot’s')
    symlinkSync(join(owner.home, 'outside.png'), join(folder, 'link.png'))
    expect(await refused(viewer.dispatch('bots.remote.file', { botId: q, path: 'drawing.svg' }))).toMatchObject({ code: 'conflict', details: { reason: 'svg' } })
    expect(await refused(viewer.dispatch('bots.remote.file', { botId: q, path: 'link.png' }))).toMatchObject({ code: 'stream_unknown' })
  }, 60_000)

  it('refuses a key the bot’s computer does not take from another device, and sends nothing', async () => {
    const from = fabric.crossed.length
    const no = await refused(viewer.dispatch('bots.chat.send', { botId: q, text: 'hi', clientRequestId: 'router-key-1', ceiling: 'full' }))
    expect(no.code).toBe('invalid_params')
    expect(sent(from)).toEqual([])
    expect(ownerChat()).not.toContain('hi')
  }, 60_000)
})
