/**
 * "Use the browser": one bot permission for every browser tool, asked for once in plain words and
 * remembered. A bot with it gets the browser tools on its own browser and no refusal; without it,
 * one ask whatever browser tool it names; other Mousse tools that reach other threads stay refused.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BOT_ASK_DEFERRED_TEXT, BOT_ASK_REFUSED_TEXT } from '../../src/mms/bots/activation/BotEngine'
import type { BotBrowserHost } from '../../src/mms/bots/activation/dispatcher'
import { askFingerprintOf } from '../../src/mms/bots/chat/projection'
import { compileBotThread } from '../../src/mms/bots/grants/compile'
import { askText } from '../../src/shared/bots/personal/askText'
import { chipForCall, rollUpChips } from '../../src/shared/bots/personal/chips'
import { grantRequestOf, permissionText, withPermission } from '../../src/shared/bots/personal/escalation'
import { BOT_BROWSER_TOOLS, botStarterManifest, describeManifest, manifestProblem } from '../../src/shared/bots/personal/manifest'
import type { NormalisedCall } from '../../src/shared/bots/personal/authority'
import { BROWSER_AUTOMATION_TOOLS } from '../../src/shared/browser/automation'
import { botFixture, chatOf, createBot, finish, start, type BotFixture } from './botFixture'

const browserFingerprint = askFingerprintOf({ tool: 'browser' })
const act: NormalisedCall = { kind: 'app', tool: 'browser_act', args: { action: { type: 'click' } } }

describe('the browser permission, in plain words', () => {
  it('every browser tool is the one "use the browser" ask, never "the browser act tool"', () => {
    for (const tool of [...BROWSER_AUTOMATION_TOOLS, 'browser']) {
      expect(askText({ tool }).title, tool).toBe('use the browser')
      expect(askText({ tool }).title).not.toMatch(/act|tool/)
      expect(grantRequestOf({ tool })).toEqual({ tool: 'browser' })
      expect(permissionText({ tool })).toBe('Use the browser')
    }
    expect(askText({ tool: 'browser' }).note).toMatch(/apart from your tabs/)
    expect(grantRequestOf({ tool: 'shell' })).toEqual({ tool: 'shell' })
  })

  it('allowing any browser tool grants the browser as a whole, and the grant is valid', () => {
    const granted = withPermission(botStarterManifest(), { tool: 'browser_act' })
    expect(granted.appTools).toContain('browser')
    expect(granted.appTools.filter((tool) => tool.startsWith('browser'))).toEqual(['browser'])
    expect(manifestProblem(granted)).toBeUndefined()
    expect(describeManifest(granted).map((line) => line.text)).toContain('Use the browser')
    // A raw browser tool is not a grant of its own: only "browser" is.
    expect(manifestProblem({ ...botStarterManifest(), appTools: [...botStarterManifest().appTools, 'browser_act'] })).toMatch(/can't be given the Mousse tool browser_act/)
  })

  it('compiles to the browser tools, without the handoff tool; nothing without it', () => {
    const compile = (appTools: string[]) => compileBotThread({
      grant: { ...botStarterManifest(), appTools }, digest: 'd', thread: {}, scratch: '/tmp/mousse-browser-grant-scratch', profileHome: '/tmp/mousse-browser-grant-home',
      nativeNames: (tools) => ({ ok: true, names: [...tools] }), remaining: { deadlineMs: 60_000 }
    })
    const withBrowser = compile([...botStarterManifest().appTools, 'browser'])
    if (!withBrowser.ok) throw new Error(withBrowser.error.message)
    expect(withBrowser.permissions.browser).toBe(true)
    for (const tool of BOT_BROWSER_TOOLS) {
      expect(withBrowser.permissions.appTools).toContain(tool)
      expect(withBrowser.policy.tools!.allow).toContain(tool)
    }
    expect(withBrowser.permissions.appTools).not.toContain('browser')
    expect(withBrowser.permissions.appTools).not.toContain('browser_request_human')
    const without = compile(botStarterManifest().appTools)
    if (!without.ok) throw new Error(without.error.message)
    expect(without.permissions.browser).toBeUndefined()
    expect(without.permissions.appTools.some((tool) => tool.startsWith('browser'))).toBe(false)
  })

  it('shows as an activity chip with the site it went to', () => {
    expect(chipForCall('browser_open', { url: 'https://www.example.com/a' })).toEqual({ icon: 'web', text: 'using the browser', highlight: 'example.com', live: true })
    expect(chipForCall('browser_act', { action: { type: 'navigate', url: 'https://news.example.org/' } })).toMatchObject({ highlight: 'news.example.org' })
    expect(rollUpChips([{ tool: 'browser_open', input: { url: 'https://example.com' } }, { tool: 'browser_act', input: { action: { type: 'click' } } }]))
      .toEqual([{ icon: 'web', text: 'used the browser', highlight: 'example.com' }])
  })
})

describe('a bot asking for and using the browser', () => {
  let f: BotFixture
  let botId: string
  let turns: Array<{ botId: string; activationId: string; lane: string; homeThreadId: string }>
  let ended: string[]

  beforeEach(async () => {
    f = botFixture()
    turns = []
    ended = []
    const browser: BotBrowserHost = {
      turn: (input) => {
        turns.push({ botId: input.botId, activationId: input.activationId, lane: input.lane, homeThreadId: input.homeThreadId })
        return { binding: { mode: 'structured' } as never, runtime: { resolveTarget: () => ({ backend: 'managed-chromium' }), dispatch: async () => ({}) } }
      },
      activationEnded: (input) => { ended.push(input.activationId) }
    }
    f.host.browser = browser
    botId = (await createBot(f, { name: 'Noobesh', reply: 'Hello.' })).botId
  })

  afterEach(() => f.close())

  const chat = async (text: string, id: string) => {
    await f.bots.service.chatSend({ botId, text, clientRequestId: id })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    return { activation, ...(await start(f, activation.id)) }
  }
  const run = async (id: string) => {
    const activation = await f.bots.activate({ botId, input: 'Check the site', clientRequestId: id })
    return { activation, ...(await start(f, activation.id)) }
  }

  it('without the grant: no browser for the turn, one human-worded ask, then Allow is remembered across chats and runs', async () => {
    const first = await chat('Look at my bank statement page', 'm1')
    expect(first.prepared.browser).toBeUndefined()
    expect(first.prepared.authority.appTools.has('browser_act')).toBe(false)
    // The bot asks for the tool it saw named: it is the browser as a whole.
    expect(first.prepared.authority.escalate!({ permission: { tool: 'browser_act' }, reason: 'To click through the page.' })).toBe(BOT_ASK_DEFERRED_TEXT)
    await finish(f, first.payload, 'completed', { text: 'I\'ve asked to use the browser.' })
    const reply = chatOf(f, botId).at(-1)!
    expect(reply.ask).toMatchObject({ status: 'open', title: 'use the browser' })
    expect(f.store.openAsks(botId)).toMatchObject([{ fingerprint: browserFingerprint, title: 'use the browser' }])
    expect(JSON.stringify(chatOf(f, botId))).not.toMatch(/browser act|browser_act|can't be given/)

    const { message } = await f.bots.service.answer(botId, reply.ask!.askId, 'allow')
    expect(message.ask).toMatchObject({ status: 'allowed' })
    expect(message.error).toBeUndefined()
    expect(f.store.activeGrant(botId)!.manifest.appTools).toContain('browser')
    expect(f.host.definitions.get(botId)!.published!.permissions.appTools).toContain('browser')
    // The turn continues with the browser.
    const continued = await start(f, first.activation.id, 2)
    expect(continued.prepared.browser).toBeDefined()
    expect(continued.prepared.authority.check(act)).toEqual({ ok: true })
    await finish(f, continued.payload, 'completed', { text: 'Here it is.' })

    // Every later chat and run has the browser, with no new ask.
    const later = await chat('And again', 'm2')
    expect(later.prepared.browser).toBeDefined()
    expect(later.prepared.authority.check(act)).toEqual({ ok: true })
    for (const tool of BOT_BROWSER_TOOLS) expect(later.prepared.policy.tools!.allow).toContain(tool)
    await finish(f, later.payload, 'completed', { text: 'Done.' })
    const scheduled = await run('r1')
    expect(scheduled.prepared.browser).toBeDefined()
    expect(scheduled.prepared.authority.check(act)).toEqual({ ok: true })
    await finish(f, scheduled.payload, 'completed', { text: 'Report.' })
    expect(f.store.openAsks(botId)).toEqual([])
    // Asking again for what it holds is no new card.
    const again = await chat('Once more', 'm3')
    expect(again.prepared.authority.escalate!({ permission: { tool: 'browser_open' }, reason: 'Again.' })).toBe('The owner already allowed this (use the browser). Use it now.')
    await finish(f, again.payload, 'completed', { text: 'Done.' })
    expect(f.store.openAsks(botId)).toEqual([])
    expect(turns.map((turn) => turn.lane)).toEqual(['chat', 'chat', 'run', 'chat'])
    // Both lanes drive the one browser its home thread owns.
    expect(new Set(turns.map((turn) => turn.homeThreadId)).size).toBe(1)
    expect(ended).toEqual(expect.arrayContaining([later.activation.id, scheduled.activation.id]))
  })

  it('a browser call without the grant is a wall in the chat and one ask in a run, both "use the browser"', async () => {
    const chatTurn = await chat('Open the site', 'm1')
    expect(chatTurn.prepared.authority.check(act)).toMatchObject({ ok: false, wall: { kind: 'escalated', permission: 'use the browser' } })
    await finish(f, chatTurn.payload, 'interrupted', { text: 'May I use the browser?', outcome: { interruptedBy: 'bot_wall' } })
    expect(chatOf(f, botId).at(-1)!.ask).toMatchObject({ title: 'use the browser' })
    await f.bots.service.answer(botId, chatOf(f, botId).at(-1)!.ask!.askId, 'not_now')
    const runTurn = await run('r1')
    expect(runTurn.prepared.authority.check(act)).toMatchObject({ ok: false, refused: { text: BOT_ASK_REFUSED_TEXT } })
    expect(runTurn.prepared.authority.check({ kind: 'app', tool: 'browser_observe', args: {} })).toMatchObject({ ok: false, refused: { askId: f.store.openAsks(botId)[0]!.id } })
    await finish(f, runTurn.payload, 'completed', { text: 'Report: skipped the site.' })
    expect(f.store.openAsks(botId)).toMatchObject([{ fingerprint: browserFingerprint, title: 'use the browser' }])
  })

  it('About lists "use the browser" with Remove; Remove takes the browser away', async () => {
    const first = await chat('Open the site', 'm1')
    first.prepared.authority.escalate!({ permission: { tool: 'browser' }, reason: 'To open it.' })
    await finish(f, first.payload, 'completed', { text: 'Asked.' })
    await f.bots.service.answer(botId, chatOf(f, botId).at(-1)!.ask!.askId, 'allow')
    const continued = await start(f, first.activation.id, 2)
    await finish(f, continued.payload, 'completed', { text: 'Done.' })
    const detail = f.bots.service.get(botId)
    expect(detail.permissions).toMatchObject([{ id: browserFingerprint, title: 'use the browser' }])
    expect(f.bots.service.revokePermission(botId, browserFingerprint).permissions).toEqual([])
    const after = await chat('Again', 'm2')
    expect(after.prepared.browser).toBeUndefined()
    await finish(f, after.payload, 'completed', { text: 'Done.' })
  })

  it('a Mousse tool no bot can hold is refused at once, with no card to allow', async () => {
    const turn = await chat('Start a thread for this', 'm1')
    expect(turn.prepared.authority.escalate!({ permission: { tool: 'delegate_task' }, reason: 'To delegate.' })).toMatch(/can't be given the Mousse tool delegate_task/)
    await finish(f, turn.payload, 'completed', { text: 'I can\'t do that.' })
    expect(f.store.openAsks(botId)).toEqual([])
    expect(chatOf(f, botId).some((message) => message.ask)).toBe(false)
  })
})
