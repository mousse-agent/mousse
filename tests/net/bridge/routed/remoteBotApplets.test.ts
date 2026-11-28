/**
 * An applet a bot of another computer's message shows, opened on this one (docs/bots.md, "Applets from another
 * computer"): read from the bot's computer through the bot, in pages, its state saved there; only an applet that
 * message of that bot shows, at that revision; while that computer is away the copy kept here, read only; and the copies
 * go with the bot.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NetError, NodeId } from '../../../../src/shared/net'
import { DomainRpcError } from '../../../../src/mms/protocol/domainRegistry'
import type { RpcContext, RpcMethod } from '../../../../src/mms/net/contracts'
import { AppletStore } from '../../../../src/mms/applets/AppletStore'
import { remoteBotMethods } from '../../../../src/mms/bridge/remote/RemoteBots'
import { RemoteBotApplets, type RemoteAppletIds } from '../../../../src/mms/bridge/routed/remoteBotApplets'
import type { AppletReference, AppletSubmission } from '../../../../src/shared/applets'
import type { BotLevel } from '../../../../src/shared/net/local'
import { botFixture, chatOf, createBot, finish, start, type BotFixture } from '../../../bots/botFixture'

const NODE = 'n_laptop' as NodeId
const context = { caller: { node: 'n', user: 'u' } } as unknown as RpcContext

/** Larger than one page (40 KiB), so it is read in several. */
const budget: AppletSubmission = { schemaVersion: 1, title: 'Budget', description: 'Monthly budget.', html: '<output id="t"></output>', css: '', js: `document.getElementById("t").textContent = "4000"\n// ${'x'.repeat(100 * 1024)}`, stateVersion: 1 }
const fence = (submission: unknown) => `\`\`\`mousse-applet\n${JSON.stringify(submission)}\n\`\`\``

/** Calls a method the way the dispatcher does for a new execution: validate, authorize, authorizeNew, handle. */
async function call(methods: RpcMethod[], name: string, params: unknown): Promise<unknown> {
  const method = methods.find((entry) => entry.method === name)!
  const valid = method.validate ? method.validate(params) : params
  method.authorize?.(valid, context)
  method.authorizeNew?.(valid, context)
  return method.handle(valid, context)
}

async function refused(work: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await work
  } catch (error) {
    return error as NetError
  }
  throw new Error('expected a refusal')
}

describe('an applet of another computer’s bot', () => {
  let f: BotFixture
  let dir: string
  let store: AppletStore
  /** What each bot's thread published, by thread. */
  let published: Map<string, AppletReference>
  /** The device's bot level on the bot's computer. */
  let level: BotLevel
  /** Whether the bot's computer is reached: what the Bridge says, and whether a call gets there. */
  let online: boolean
  let reachable: boolean
  let methods: RpcMethod[]
  let viewer: RemoteBotApplets
  let folder: string

  /** A bot whose reply shows Budget, as its thread published it: the bot, the message, and the applet. */
  const botWithApplet = async (name: string): Promise<{ botId: string; threadId: string; ids: RemoteAppletIds }> => {
    const { botId, firstActivation } = await createBot(f, { name })
    const { payload } = await start(f, firstActivation)
    await finish(f, payload, 'completed', { text: `Here is your budget.\n\n${fence(budget)}`, messageId: `msg-${name}` })
    const reply = chatOf(f, botId).filter((message) => message.author === 'bot').at(-1)!
    const reference = published.get(payload.threadId)!
    expect(reply.applets).toEqual([{ threadId: payload.threadId, reference }])
    return { botId, threadId: payload.threadId, ids: { messageId: reply.id, appletId: reference.appletId, revisionId: reference.revisionId } }
  }

  beforeEach(() => {
    f = botFixture()
    dir = mkdtempSync(join(tmpdir(), 'remote-bot-applets-'))
    folder = join(dir, 'remote-applets')
    store = new AppletStore(join(dir, 'owner'), (threadId) => join(dir, 'owner', 'threads', threadId))
    published = new Map()
    f.bots.chat.setReplyParts({
      published: (threadId) => {
        if (!published.has(threadId)) {
          const bundle = store.publish({ threadId, messageId: `pub-${threadId}`, turnId: `turn-${threadId}`, submission: budget })
          published.set(threadId, { appletId: bundle.appletId, revisionId: bundle.revisionId, sourceHash: bundle.sourceHash, title: bundle.title, description: bundle.description })
        }
        return [published.get(threadId)!]
      }
    })
    level = 'use'
    online = true
    reachable = true
    // The bot's computer: its bots and the profile's applet store, for a device at `level`.
    methods = remoteBotMethods({ bots: () => f.bots.service, applets: store, reach: { level: () => level, canReach: () => true } })
    // This computer: each call goes there, unless that computer is away.
    viewer = new RemoteBotApplets({
      folder,
      online: () => online,
      call: async (_node, method, params) => {
        // As the routed client refuses a call to a computer it has no session with.
        if (!online || !reachable) throw new DomainRpcError('computer_offline', 'Laptop is offline.')
        return call(methods, method, params)
      }
    })
  })
  afterEach(() => {
    f.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('opens here from the bot’s computer, in pages, and its state is saved there', async () => {
    const pip = await botWithApplet('Pip')
    const opened = await viewer.open(NODE, pip.botId, pip.ids)
    expect(opened.bundle.source).toMatchObject({ title: 'Budget', js: budget.js })
    expect(opened.state).toBeNull()
    expect(opened.readOnly).toBeUndefined()

    await viewer.save(NODE, pip.botId, pip.ids, { rent: 1200 })
    // Saved on the bot's computer, which owns it.
    expect(store.loadState(pip.threadId, pip.ids.appletId, pip.ids.revisionId)).toEqual({ rent: 1200 })
    expect((await viewer.open(NODE, pip.botId, pip.ids)).state).toEqual({ rent: 1200 })
  })

  it('opens at Use; at Off nothing is read or saved', async () => {
    const pip = await botWithApplet('Pip')
    level = 'off'
    expect(await refused(viewer.open(NODE, pip.botId, pip.ids))).toMatchObject({ code: 'forbidden' })
    expect(await refused(viewer.save(NODE, pip.botId, pip.ids, { rent: 1 }))).toMatchObject({ code: 'forbidden' })
    expect(store.loadState(pip.threadId, pip.ids.appletId, pip.ids.revisionId)).toBeNull()
    level = 'use'
    expect((await viewer.open(NODE, pip.botId, pip.ids)).bundle.source.title).toBe('Budget')
  })

  it('refuses another bot’s applet, an applet the message doesn’t show, and a revision that isn’t the applet’s', async () => {
    const pip = await botWithApplet('Pip')
    const tom = await botWithApplet('Tom')
    const gone = { code: 'stream_unknown' }
    // Tom's message and applet, named through Pip.
    expect(await refused(viewer.open(NODE, pip.botId, tom.ids))).toMatchObject(gone)
    // Pip's message, Tom's applet.
    expect(await refused(viewer.open(NODE, pip.botId, { ...pip.ids, appletId: tom.ids.appletId, revisionId: tom.ids.revisionId }))).toMatchObject(gone)
    // Pip's applet at a revision that isn't the one its message shows: another applet's, or a newer one of its own that
    // its thread published since, which this message doesn't show.
    expect(await refused(viewer.open(NODE, pip.botId, { ...pip.ids, revisionId: tom.ids.revisionId }))).toMatchObject(gone)
    const newer = store.publish({ threadId: pip.threadId, messageId: 'later', turnId: 'later', submission: { ...budget, appletId: pip.ids.appletId, expectedRevision: pip.ids.revisionId, js: '' } })
    expect(newer.appletId).toBe(pip.ids.appletId)
    expect(await refused(viewer.open(NODE, pip.botId, { ...pip.ids, revisionId: newer.revisionId }))).toMatchObject(gone)
    // Nor is another bot's applet saved through this one.
    expect(await refused(viewer.save(NODE, pip.botId, tom.ids, { rent: 1 }))).toMatchObject(gone)
    expect(store.loadState(tom.threadId, tom.ids.appletId, tom.ids.revisionId)).toBeNull()
    // Each answer is the same as for an applet that is not there, and names no thread of that computer.
    const answer = await refused(viewer.open(NODE, pip.botId, tom.ids))
    expect(answer.message).not.toContain(tom.threadId)
  })

  it('while its computer is away, shows the copy kept here, read only; one never opened here is refused', async () => {
    const pip = await botWithApplet('Pip')
    const tom = await botWithApplet('Tom')
    await viewer.open(NODE, pip.botId, pip.ids)
    await viewer.save(NODE, pip.botId, pip.ids, { rent: 900 })

    online = false
    const copy = await viewer.open(NODE, pip.botId, pip.ids)
    expect(copy).toMatchObject({ readOnly: true, state: { rent: 900 }, bundle: { source: { js: budget.js } } })
    expect(await refused(viewer.save(NODE, pip.botId, pip.ids, { rent: 1 }))).toMatchObject({ code: 'computer_offline' })
    expect(await refused(viewer.open(NODE, tom.botId, tom.ids))).toMatchObject({ code: 'computer_offline' })

    // Listed online, but a call doesn't get there: the copy too.
    online = true
    reachable = false
    expect(await viewer.open(NODE, pip.botId, pip.ids)).toMatchObject({ readOnly: true, state: { rent: 900 } })
    expect(store.loadState(pip.threadId, pip.ids.appletId, pip.ids.revisionId)).toEqual({ rent: 900 })
  })

  it('a refusal there never falls back to the copy', async () => {
    const pip = await botWithApplet('Pip')
    await viewer.open(NODE, pip.botId, pip.ids)
    level = 'off'
    expect(await refused(viewer.open(NODE, pip.botId, pip.ids))).toMatchObject({ code: 'forbidden' })
  })

  it('a bot lost here takes its copies; a computer dropped takes all of its bots’', async () => {
    const pip = await botWithApplet('Pip')
    const tom = await botWithApplet('Tom')
    await viewer.open(NODE, pip.botId, pip.ids)
    await viewer.open(NODE, tom.botId, tom.ids)
    expect(existsSync(join(folder, NODE, pip.botId))).toBe(true)

    viewer.dropBots(NODE, [pip.botId])
    expect(existsSync(join(folder, NODE, pip.botId))).toBe(false)
    online = false
    expect(await refused(viewer.open(NODE, pip.botId, pip.ids))).toMatchObject({ code: 'computer_offline' })
    expect(await viewer.open(NODE, tom.botId, tom.ids)).toMatchObject({ readOnly: true })

    viewer.dropComputer(NODE)
    expect(existsSync(join(folder, NODE))).toBe(false)
    expect(await refused(viewer.open(NODE, tom.botId, tom.ids))).toMatchObject({ code: 'computer_offline' })
  })
})
