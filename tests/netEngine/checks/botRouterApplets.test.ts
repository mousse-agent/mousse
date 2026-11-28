/**
 * A window's applet of a bot of another computer, over two real daemons paired through the engine (docs/bots.md,
 * "Applets from another computer"): the viewer's window opens the owner's bot's applet and saves its state there, through
 * `bots.remote.applet` / `bots.remote.appletState` (the bot router, past the thread router), and the copy kept here
 * follows the bot.
 *
 * - opened and saved by a window; ids inside the state arrive as they were written;
 * - the command line and a bot this computer doesn't list are refused, and nothing is sent;
 * - a state over 40 KiB is refused here before sending, and by the owner when sent anyway;
 * - a save to a revision the owner has replaced is refused as stale;
 * - with networking off here, the applet still opens;
 * - the bot lost here, or its computer forgotten, takes the copy.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NodeId } from '../../../src/shared/net'
import { qualifyId } from '../../../src/shared/threadRef'
import { dispatchMethod } from '../../../src/mms/protocol/handlers'
import type { AppletStore } from '../../../src/mms/applets/AppletStore'
import type { AppletSubmission } from '../../../src/shared/applets'
import type { BotRouter } from '../../../src/mms/bridge/routed/BotRouter'
import type { RemoteBotRegistry } from '../../../src/mms/bridge/routed/RemoteBotRegistry'
import { Fabric, codeOf, type Computer } from './harness'

const counter: AppletSubmission = { schemaVersion: 1, title: 'Counter', description: 'Counts taps.', html: '<b id="n">0</b>', css: '', js: '', stateVersion: 1 }
const fence = (submission: unknown) => `\`\`\`mousse-applet\n${JSON.stringify(submission)}\n\`\`\``

describe('a window’s applet of a bot of another computer', () => {
  const fabric = new Fabric()
  let owner: Computer
  let viewer: Computer
  let viewerOnOwner: NodeId
  let ownerOnViewer: NodeId
  let keeper: string
  let q: string
  let home: string
  let ids: { messageId: string; appletId: string; revisionId: string }
  const registry = (): RemoteBotRegistry => viewer.mms.bridge.remoteBots
  const router = (): BotRouter => viewer.mms.bridge.botRouter
  const store = (): AppletStore => owner.mms.applets
  const copies = (): string => join(viewer.mms.getProfileHomeDir(), 'bots', 'remote-applets')
  const refused = async (call: Promise<unknown>): Promise<{ code?: string; details?: any }> => {
    try {
      await call
    } catch (error) {
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

  beforeAll(async () => {
    owner = await fabric.computer('owner')
    viewer = await fabric.computer('viewer')
    const paired = await fabric.pair(owner, viewer)
    viewerOnOwner = paired.callerOnOwner
    ownerOnViewer = paired.ownerOnCaller
    await fabric.settle()
    await fabric.connect(viewer, ownerOnViewer)
    vi.spyOn(owner.mms.personalBots!, 'enqueueChat').mockResolvedValue(undefined as never)
    keeper = (await owner.mms.personalBots!.service.create({ look: { colour: 'teal', accessory: 'cap' }, name: 'Counter keeper', description: 'keeper', clientRequestId: 'applets-bot-1' })).bot.id
    owner.mms.botDeviceAccess.set(keeper, { mode: 'chosen', nodes: [viewerOnOwner] })
    q = qualifyId(ownerOnViewer, keeper)
    await vi.waitFor(() => {
      const row = registry().row(ownerOnViewer, keeper)
      expect(row).toBeDefined()
      expect(row?.offline).toBeUndefined()
    }, { timeout: 30_000 })

    // The bot's reply shows Counter, as its thread published it.
    home = owner.mms.personalBots!.service.get(keeper).summary.homeThreadId!
    const bundle = store().publish({ threadId: home, messageId: 'pub-1', turnId: 'turn-1', submission: counter })
    const reference = { appletId: bundle.appletId, revisionId: bundle.revisionId, sourceHash: bundle.sourceHash, title: bundle.title, description: bundle.description }
    owner.mms.personalBots!.chat.setReplyParts({ published: () => [reference] })
    const message = owner.mms.personalBots!.chat.post({ botId: keeper, author: 'bot', kind: 'text', text: `Here it is.\n\n${fence(counter)}`, threadId: home })
    ids = { messageId: message.id, appletId: bundle.appletId, revisionId: bundle.revisionId }
  }, 300_000)
  afterAll(() => fabric.close(), 60_000)

  it('opens in a window and saves its state on the bot’s computer; ids inside the state arrive as written', async () => {
    const opened = await viewer.dispatch('bots.remote.applet', { botId: q, ...ids })
    expect(opened.bundle.source).toMatchObject({ title: 'Counter', html: counter.html })
    expect(opened.state).toBeNull()
    expect(opened.readOnly).toBeUndefined()
    // State that looks like ids of this computer's threads: the applet's own words, never routed or rewritten.
    const state = { count: 3, threadId: qualifyId(ownerOnViewer, 'thread-1'), projectId: qualifyId(ownerOnViewer, 'project-1') }
    expect(await viewer.dispatch('bots.remote.appletState', { botId: q, ...ids, state })).toEqual({ saved: true })
    expect(store().loadState(home, ids.appletId, ids.revisionId)).toEqual(state)
    expect((await viewer.dispatch('bots.remote.applet', { botId: q, ...ids })).state).toEqual(state)
    expect(readdirSync(join(copies(), ownerOnViewer, keeper))).toHaveLength(1)
  }, 60_000)

  it('refuses the command line and a bot this computer doesn’t list, and sends nothing', async () => {
    const from = fabric.crossed.length
    expect(await refused(fromCli('bots.remote.applet', { botId: q, ...ids }))).toMatchObject({ code: 'forbidden' })
    expect(await refused(fromCli('bots.remote.appletState', { botId: q, ...ids, state: { count: 9 } }))).toMatchObject({ code: 'forbidden' })
    const unlisted = qualifyId(ownerOnViewer, 'bot-000000000000')
    expect(await refused(viewer.dispatch('bots.remote.applet', { botId: unlisted, ...ids }))).toMatchObject({ code: 'bot_not_found' })
    expect(await refused(viewer.dispatch('bots.remote.appletState', { botId: unlisted, ...ids, state: { count: 9 } }))).toMatchObject({ code: 'bot_not_found' })
    expect(sent(from)).toEqual([])
    expect(store().loadState(home, ids.appletId, ids.revisionId)).toMatchObject({ count: 3 })
  }, 60_000)

  it('refuses a state over 40 KiB here before sending, and on the bot’s computer when sent anyway', async () => {
    const big = { text: 'x'.repeat(41 * 1024) }
    const from = fabric.crossed.length
    expect(await refused(viewer.dispatch('bots.remote.appletState', { botId: q, ...ids, state: big }))).toMatchObject({ code: 'applet_state_too_large' })
    expect(sent(from)).toEqual([])
    // Past this computer's check, straight to the owner: it refuses too, and keeps what it had.
    const client = (viewer.mms.bridge as unknown as { router: { client: { callBot(node: NodeId, method: string, params: unknown, options: { write: boolean }): Promise<unknown> } } }).router.client
    const there = await refused(client.callBot(ownerOnViewer, 'bots.applets.state.save', { botId: keeper, ...ids, state: big }, { write: true }))
    expect(there).toMatchObject({ code: 'too_large' })
    expect(sent(from)).toEqual(['bots.applets.state.save'])
    expect(store().loadState(home, ids.appletId, ids.revisionId)).toMatchObject({ count: 3 })
  }, 60_000)

  it('opens with networking off here, as the chat’s files do', async () => {
    const options = (router() as unknown as { options: { enabled(): boolean } }).options
    const enabled = options.enabled
    options.enabled = () => false
    try {
      expect((await viewer.dispatch('bots.remote.applet', { botId: q, ...ids })).bundle.source).toMatchObject({ title: 'Counter' })
    } finally {
      options.enabled = enabled
    }
  }, 60_000)

  it('refuses a save to a revision the bot’s computer has replaced as stale', async () => {
    store().publish({ threadId: home, messageId: 'pub-2', turnId: 'turn-2', submission: { ...counter, appletId: ids.appletId, expectedRevision: ids.revisionId, html: '<i>2</i>' } })
    const no = await refused(viewer.dispatch('bots.remote.appletState', { botId: q, ...ids, state: { count: 4 } }))
    expect(no).toMatchObject({ code: 'conflict', details: { reason: 'applet_stale' } })
  }, 60_000)

  it('drops the copy with the bot lost here, and every copy of a computer no longer known', async () => {
    expect(existsSync(join(copies(), ownerOnViewer, keeper))).toBe(true)
    owner.mms.botDeviceAccess.set(keeper, { mode: 'chosen', nodes: [] })
    await vi.waitFor(() => expect(registry().row(ownerOnViewer, keeper)).toBeUndefined(), { timeout: 30_000 })
    await vi.waitFor(() => expect(existsSync(join(copies(), ownerOnViewer, keeper))).toBe(false), { timeout: 10_000 })
    expect(await refused(viewer.dispatch('bots.remote.applet', { botId: q, ...ids }))).toMatchObject({ code: 'bot_not_found' })

    // Copies of a computer this one no longer lists (it left while this one was not running) go on the next look.
    const gone = join(copies(), 'nod_0000000000000000000000000', 'bot-000000000000')
    mkdirSync(gone, { recursive: true })
    await registry().reconcile()
    expect(existsSync(join(copies(), 'nod_0000000000000000000000000'))).toBe(false)
    expect(existsSync(join(copies(), ownerOnViewer))).toBe(true)
  }, 60_000)
})
