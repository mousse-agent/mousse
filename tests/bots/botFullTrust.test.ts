/**
 * "Allow everything" (`BotManifest.fullTrust`, issue #1363) and what an approved grant does to the bot's unfinished work,
 * over a real engine and a real `bots.db`.
 *
 * What it must never get past (test-the-claim §4, each a row below): a default the owner switched off (the automation
 * tools), a permission the owner switched off before, Settings and Labs (a tool switched off there, read by the tool
 * registry at the call), what each kind of turn may do (`BOT_TURN_KINDS`). Asks first and a subagent's hold have their
 * rows beside their own fixtures (botActions.test.ts, botWorkSubagentsHold.test.ts).
 *
 * Approving a new grant, by what it does to the old one: wider (a capability added, a limit raised) keeps work going,
 * across a restart, with the higher limit at its next dispatch; narrower (a limit lowered, a capability removed) ends it
 * and refuses its next call.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BOT_ASK_DUPLICATE_TEXT, BotEngine } from '../../src/mms/bots/activation/BotEngine'
import { botManifestDigest } from '../../src/mms/bots/grants/compile'
import type { NormalisedCall } from '../../src/shared/bots/personal/authority'
import type { BotManifest } from '../../src/shared/bots/personal/definition'
import { BOT_AUTOMATIONS_SWITCH, BOT_FULL_TRUST_PERMISSION } from '../../src/shared/bots/personal/manifest'
import { appToolRegistry, appTurn, fakeAppToolHost } from '../run/appToolsFixture'
import { delegationFixture } from '../run/delegationFixture'
import { botFixture, chatOf, createBot, finish, flush, runDispatch, start, type BotFixture } from './botFixture'

const command: NormalisedCall = { kind: 'builtin', tool: 'shell', nativeName: 'bash', args: { command: 'ls' } }
const read: NormalisedCall = { kind: 'builtin', tool: 'read', nativeName: 'read', args: { path: 'notes.md' } }

let f: BotFixture
let botId: string
beforeEach(async () => {
  f = botFixture()
  await f.bots.reconcileOnStartup()
  botId = (await createBot(f, { name: 'Pip', reply: 'Hello.' })).botId
})
afterEach(() => f.close())

/** A run started by hand: activated, its first dispatch not yet sent. */
const activate = async (id: string) => (await f.bots.activate({ botId, input: 'Tidy the notes.', clientRequestId: id })).id
/** The owner publishes `permissions` and approves them, as the definition methods do. */
function approve(permissions: (held: BotManifest) => BotManifest) {
  const entry = f.bots.get(botId)
  const saved = f.bots.save({ ...entry.draft, permissions: permissions(entry.published!.permissions) }, entry.draftHash)
  const published = f.bots.publish(botId, saved.draftHash)
  return f.bots.approve(botId, botManifestDigest(published.permissions))
}
const withLimits = (budget: BotManifest['budget']) => (held: BotManifest): BotManifest => ({ ...held, budget })

describe('Allow everything', () => {
  it('turns on through About\'s switch as its own grant, and gives every capability a bot can be granted', async () => {
    const before = f.store.activeGrant(botId)!
    const plain = await start(f, await activate('plain'))
    expect(plain.prepared.authority.check(command)).toMatchObject({ ok: false })
    await finish(f, plain.payload, 'completed', { text: 'Done.' })
    f.bots.service.setPermission(botId, BOT_FULL_TRUST_PERMISSION, true)
    const after = f.store.activeGrant(botId)!
    expect(after.manifest.fullTrust).toBe(true)
    expect(after.digest).not.toBe(before.digest)
    expect(f.bots.service.get(botId).fullTrust).toBe(true)
    const trusted = await start(f, await activate('trusted'))
    expect(trusted.prepared.authority.check(command)).toEqual({ ok: true })
    expect(trusted.prepared.authority.appTools.has('browser_open')).toBe(true)
    expect(trusted.prepared.authority.appTools.has('thread_create')).toBe(true)
    // Off narrows as Remove does: the next run has none of it.
    await finish(f, trusted.payload, 'completed', { text: 'Done.' })
    f.bots.service.setPermission(botId, BOT_FULL_TRUST_PERMISSION, false)
    expect(f.store.activeGrant(botId)!.manifest.fullTrust).toBeUndefined()
    expect((await start(f, await activate('after'))).prepared.authority.check(command)).toMatchObject({ ok: false })
  })

  it('never gets past a default or a permission the owner switched off', async () => {
    f.bots.setPermission(botId, BOT_AUTOMATIONS_SWITCH, false)
    // Run commands, allowed and then switched off in About before Allow everything.
    const asking = await start(f, await activate('ask'))
    asking.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'Commands.' })
    await finish(f, asking.payload, 'completed', { text: 'Asked.' })
    for (const ask of f.store.openAsks(botId)) await f.bots.service.answer(botId, ask.id, 'allow')
    const shell = f.bots.service.get(botId).permissions.find((item) => /run commands/i.test(item.title))!
    f.bots.setPermission(botId, shell.id, false)
    f.bots.setFullTrust(botId, true)
    const run = await start(f, await activate('run'))
    expect(run.prepared.authority.appTools.has('automation_draft_save')).toBe(false)
    expect(run.prepared.authority.check(command)).toMatchObject({ ok: false })
    // The control: what it did not switch off, it has.
    expect(run.prepared.authority.appTools.has('browser_open')).toBe(true)
  })

  it("Remove can't bring back what the owner switched off: it is refused while Allow everything is on", async () => {
    const asking = await start(f, await activate('ask'))
    asking.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'Commands.' })
    await finish(f, asking.payload, 'completed', { text: 'Asked.' })
    for (const ask of f.store.openAsks(botId)) await f.bots.service.answer(botId, ask.id, 'allow')
    const shell = f.bots.service.get(botId).permissions.find((item) => /run commands/i.test(item.title))!
    f.bots.setPermission(botId, shell.id, false)
    f.bots.setFullTrust(botId, true)
    expect(() => f.bots.service.revokePermission(botId, shell.id)).toThrow(expect.objectContaining({ code: 'permission_full_trust' }))
    expect(f.bots.service.get(botId).permissions.find((item) => item.id === shell.id)).toMatchObject({ enabled: false })
    expect((await start(f, await activate('run'))).prepared.authority.check(command)).toMatchObject({ ok: false })
    // With Allow everything off, Remove removes it.
    f.bots.setFullTrust(botId, false)
    f.bots.service.revokePermission(botId, shell.id)
    expect(f.bots.service.get(botId).permissions.some((item) => item.id === shell.id)).toBe(false)
  })

  it('never gets past what each kind of turn may do', async () => {
    f.bots.setFullTrust(botId, true)
    // A run started by hand asks nobody, waits for nothing and messages no bot (BOT_TURN_KINDS).
    const manual = await start(f, await activate('manual'))
    for (const tool of ['ask_owner', 'work_wait', 'bot_send', 'work_start']) expect(manual.prepared.authority.appTools.has(tool)).toBe(false)
    await finish(f, manual.payload, 'completed', { text: 'Done.' })
    // A chat turn waits for nothing and starts no subagent.
    await f.bots.service.chatSend({ botId, text: 'Hi', clientRequestId: 'hi' })
    const chat = await start(f, f.store.activationByKey('chat:hi')!.id)
    expect(chat.prepared.authority.appTools.has('work_wait')).toBe(false)
    expect(chat.prepared.authority.subagents).toBeUndefined()
  })

  it('never gets past Settings and Labs: a tool switched off there is refused at the call', async () => {
    f.bots.setFullTrust(botId, true)
    const run = await start(f, await activate('web'))
    expect(run.prepared.authority.appTools.has('web_fetch')).toBe(true)
    const fx = delegationFixture()
    try {
      const parent = await fx.runningRun(run.payload.threadId)
      const { registry, turns, request } = appToolRegistry(fx.engine, fakeAppToolHost().host, { bots: () => ({ host: f.bots.tools }) })
      turns.register(appTurn({ threadId: run.payload.threadId, runId: parent.runId, bot: run.prepared.authority, settingsEnabled: (name) => name !== 'web_fetch' }))
      const outcome = await registry.call('web_fetch', { url: 'https://example.com' }, request({ threadId: run.payload.threadId, runId: parent.runId }))
      expect(outcome.isError).toBe(true)
      expect(outcome.text).toMatch(/Settings/)
    } finally {
      fx.dispose()
    }
  })
})

describe('approving a new grant', () => {
  it('a wider one keeps unfinished work, across a restart, with the higher limit at its next dispatch', async () => {
    approve(withLimits({ maxTurns: 3 }))
    const id = await activate('w1')
    expect(f.store.counters(id).limits.maxTurns).toBe(3)
    const { digest } = approve((held) => ({ ...held, tools: [...held.tools, 'shell'], budget: { maxTurns: 10 } }))
    expect(f.store.activation(id)).toMatchObject({ grantDigest: digest })
    expect(f.store.activation(id)!.status).not.toBe('cancelled')
    expect(f.store.counters(id).limits.maxTurns).toBe(10)
    f.bots.close()
    f.bots = new BotEngine(f.host)
    await f.bots.reconcileOnStartup()
    await flush()
    expect(f.store.activation(id)!.status).not.toBe('cancelled')
    const turn = await start(f, id)
    expect(turn.prepared.policy.budget).toMatchObject({ maxTurns: 10 })
    expect(turn.prepared.authority.check(command)).toEqual({ ok: true })
  })

  it('one with Allow everything that leaves out a tool it gives is wider, not narrower: work goes on with the tool', async () => {
    approve((held) => ({ ...held, tools: [...held.tools, 'shell'] }))
    const id = await activate('w1')
    const { digest } = approve((held) => ({ ...held, fullTrust: true, tools: held.tools.filter((tool) => tool !== 'shell') }))
    await flush()
    expect(f.store.activation(id)).toMatchObject({ grantDigest: digest })
    expect(f.store.activation(id)!.status).not.toBe('cancelled')
    expect((await start(f, id)).prepared.authority.check(command)).toEqual({ ok: true })
  })

  it.each([
    ['a lower spend limit', (held: BotManifest): BotManifest => ({ ...held, budget: { maxUsd: 2 } })],
    ['a capability removed', (held: BotManifest): BotManifest => ({ ...held, tools: held.tools.filter((tool) => tool !== 'edit'), budget: { maxUsd: 5 } })]
  ])('%s ends unfinished work, and a running turn\'s next call is refused', async (_name, narrower) => {
    approve(withLimits({ maxUsd: 5 }))
    const waiting = await activate('w1')
    const running = await start(f, await activate('w2'))
    expect(running.prepared.authority.check(read)).toEqual({ ok: true })
    approve(narrower)
    await flush()
    expect(f.store.activation(waiting)).toMatchObject({ status: 'cancelled', endReason: 'grant_replaced' })
    expect(f.store.activation(running.payload.activationId)).toMatchObject({ status: 'cancelled', endReason: 'grant_replaced' })
    expect(running.prepared.authority.check(read)).toMatchObject({ ok: false })
  })

  it('a narrower one ends a chat turn that waits at a card: the card is withdrawn and the chat slot is free', async () => {
    approve(withLimits({ maxUsd: 5 }))
    await f.bots.service.chatSend({ botId, text: 'sort my threads', clientRequestId: 'wall' })
    const turn = await start(f, f.store.activationByKey('chat:wall')!.id)
    turn.prepared.authority.escalate!({ permission: { tool: 'threads' }, reason: 'To read your threads.' })
    await finish(f, turn.payload, 'completed', { text: 'I need your threads first.' })
    const id = turn.payload.activationId
    expect(f.store.activation(id)).toMatchObject({ status: 'waiting_grant' })
    const [ask] = f.store.openAsks(botId)
    expect(ask).toBeDefined()
    approve(withLimits({ maxUsd: 2 }))
    await flush()
    expect(f.store.activation(id)).toMatchObject({ status: 'cancelled', endReason: 'grant_replaced' })
    expect(f.store.escalation(ask!.id)!.status).toBe('withdrawn')
    expect(chatOf(f, botId).some((message) => message.kind === 'notice' && message.text === 'I stopped there: my permissions changed.')).toBe(true)
    // Its slot is free: the owner's next message runs at once.
    await f.bots.service.chatSend({ botId, text: 'never mind', clientRequestId: 'next' })
    await flush()
    expect(f.store.activationByKey('chat:next')!.status).toBe('running')
  })
})

describe('Allow everything, row by row', () => {
  it('each permission it gives is a row of its own: switching one off keeps the rest and Allow everything stays on', async () => {
    f.bots.service.setPermission(botId, BOT_FULL_TRUST_PERMISSION, true)
    // Run commands on a bot that never asked for it: only Allow everything gives it.
    const shell = () => f.bots.service.get(botId).permissions.find((item) => /run commands/i.test(item.title))
    expect(shell()).toMatchObject({ enabled: true, fromFullTrust: true })
    f.bots.service.setPermission(botId, shell()!.id, false)
    expect(shell()).toMatchObject({ enabled: false })
    expect(f.bots.service.get(botId).fullTrust).toBe(true)
    const run = await start(f, await activate('off'))
    expect(run.prepared.authority.check(command)).toMatchObject({ ok: false })
    expect(run.prepared.authority.appTools.has('browser_open')).toBe(true)
    await finish(f, run.payload, 'completed', { text: 'Done.' })
    f.bots.service.setPermission(botId, shell()!.id, true)
    expect((await start(f, await activate('on'))).prepared.authority.check(command)).toEqual({ ok: true })
  })

  it.each([
    ['only Allow everything gave it: it goes with Allow everything', () => {}, false],
    ['the grant named it too: it stays after Allow everything', () => { approve((held) => ({ ...held, tools: [...held.tools, 'shell'] })) }, true]
  ] as const)('switched off and on again, Run commands is as it was: %s', async (_name, setup, stays) => {
    setup()
    f.bots.service.setPermission(botId, BOT_FULL_TRUST_PERMISSION, true)
    const shell = () => f.bots.service.get(botId).permissions.find((item) => /run commands/i.test(item.title))!
    f.bots.service.setPermission(botId, shell().id, false)
    f.bots.service.setPermission(botId, shell().id, true)
    const on = await start(f, await activate('on'))
    expect(on.prepared.authority.check(command)).toEqual({ ok: true })
    await finish(f, on.payload, 'completed', { text: 'Done.' })
    f.bots.service.setPermission(botId, BOT_FULL_TRUST_PERMISSION, false)
    expect((await start(f, await activate('after'))).prepared.authority.check(command)).toMatchObject({ ok: stays })
    expect(f.bots.service.get(botId).permissions.some((item) => /run commands/i.test(item.title))).toBe(stays)
  })
})

describe('approval and the runtime read Allow everything the same way', () => {
  it('a revision that names a tool only Allow everything gives needs no approval, and runs with it', async () => {
    f.bots.setFullTrust(botId, true)
    const entry = f.bots.get(botId)
    const { fullTrust: _on, ...rest } = entry.published!.permissions
    const saved = f.bots.save({ ...entry.draft, permissions: { ...rest, tools: [...rest.tools, 'shell'] } }, entry.draftHash)
    f.bots.publish(botId, saved.draftHash)
    expect(f.bots.list().find((bot) => bot.id === botId)!.needsApproval).toEqual([])
    const run = await start(f, await activate('named'))
    expect(run.prepared.authority.check(command)).toEqual({ ok: true })
    // The revision left Allow everything out, so it narrows: what it does not name, it does not get.
    expect(run.prepared.authority.appTools.has('browser_open')).toBe(false)
  })

  it('an open card is not marked Allowed for a permission the owner switched off, though Allow everything gives it', async () => {
    const asking = await start(f, await activate('ask'))
    asking.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'Commands.' })
    await finish(f, asking.payload, 'completed', { text: 'Asked.' })
    const card = f.store.openAsks(botId).find((ask) => 'tool' in ask.permission && ask.permission.tool === 'shell')!
    f.bots.setFullTrust(botId, true)
    const shell = f.bots.service.get(botId).permissions.find((item) => /run commands/i.test(item.title))!
    f.bots.setPermission(botId, shell.id, false)
    // Any Allow settles the open cards the grant now gives.
    await f.bots.service.chatSend({ botId, text: 'Export your memory', clientRequestId: 'export' })
    const chat = await start(f, f.store.activationByKey('chat:export')!.id)
    chat.prepared.authority.escalate!({ permission: { ask: 'export_memory' }, reason: 'You asked.' })
    await finish(f, chat.payload, 'completed', { text: 'Pick a folder.' })
    const exportAsk = f.store.openAsks(botId).find((ask) => 'ask' in ask.permission)!
    await f.bots.service.answer(botId, exportAsk.id, 'allow')
    expect(f.store.escalation(card.id)!.status).toBe('open')
  })

  it("an open card is marked Allowed only for what the bot's revision gets, not all an Allow everything grant gives", async () => {
    f.bots.setFullTrust(botId, true)
    // A narrower revision, published with no approval: Allow everything left out, so the bot gets only what it names.
    const entry = f.bots.get(botId)
    const { fullTrust: _on, ...rest } = entry.published!.permissions
    f.bots.publish(botId, f.bots.save({ ...entry.draft, permissions: rest }, entry.draftHash).draftHash)
    const asking = await start(f, await activate('ask'))
    expect(asking.prepared.authority.check(command)).toMatchObject({ ok: false })
    asking.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'Commands.' })
    asking.prepared.authority.escalate!({ permission: { tool: 'threads' }, reason: 'Threads.' })
    await finish(f, asking.payload, 'completed', { text: 'Asked.' })
    const card = (tool: string) => f.store.escalations({ botId }).find((ask) => 'tool' in ask.permission && ask.permission.tool === tool)!
    // Allow on the threads card settles every open card the bot now gets: not commands, which its revision leaves out.
    await f.bots.service.answer(botId, card('threads').id, 'allow')
    expect(card('shell').status).toBe('open')
    expect((await start(f, await activate('after'))).prepared.authority.check(command)).toMatchObject({ ok: false })
  })
})

describe('a chat turn waiting at a card ends at every narrowing', () => {
  const shellRow = () => f.bots.service.get(botId).permissions.find((item) => /run commands/i.test(item.title))!
  it.each([
    ['Allow everything off', () => { f.bots.setFullTrust(botId, true) }, () => { f.bots.service.setPermission(botId, BOT_FULL_TRUST_PERMISSION, false) }],
    ['Remove', () => { approve((held) => ({ ...held, tools: [...held.tools, 'shell'] })) }, () => { f.bots.service.revokePermission(botId, shellRow().id) }]
  ])('%s: the card is withdrawn and the chat slot is free', async (_name, setup, narrow) => {
    setup()
    await f.bots.service.chatSend({ botId, text: 'Export your memory', clientRequestId: 'wall' })
    const turn = await start(f, f.store.activationByKey('chat:wall')!.id)
    turn.prepared.authority.escalate!({ permission: { ask: 'export_memory' }, reason: 'You asked.' })
    await finish(f, turn.payload, 'completed', { text: 'Pick a folder.' })
    const id = turn.payload.activationId
    expect(f.store.activation(id)).toMatchObject({ status: 'waiting_grant' })
    const [ask] = f.store.openAsks(botId)
    narrow()
    await flush()
    expect(f.store.activation(id)).toMatchObject({ status: 'cancelled', endReason: 'grant_replaced' })
    expect(f.store.escalation(ask!.id)!.status).toBe('withdrawn')
    await f.bots.service.chatSend({ botId, text: 'never mind', clientRequestId: 'next' })
    await flush()
    expect(f.store.activationByKey('chat:next')!.status).toBe('running')
  })

  const withShell = () => { approve((held) => ({ ...held, tools: [...held.tools, 'shell'] })) }
  const removeShell = () => { f.bots.service.revokePermission(botId, shellRow().id) }
  /** A run asks to use the owner's threads and the owner allows it: a grant change that has nothing to do with the chat. */
  const allowThreads = async () => {
    const run = await start(f, await activate('threads'))
    run.prepared.authority.escalate!({ permission: { tool: 'threads' }, reason: 'To read your threads.' })
    await finish(f, run.payload, 'completed', { text: 'Asked.' })
    const ask = f.store.openAsks(botId).find((open) => 'tool' in open.permission && open.permission.tool === 'threads')!
    await f.bots.service.answer(botId, ask.id, 'allow')
  }
  // What the grant is when the turn reaches its cards, after it changed while the turn was still writing its reply.
  it.each([
    ['Allow everything off', 'ends', () => { f.bots.setFullTrust(botId, true) }, () => { f.bots.service.setPermission(botId, BOT_FULL_TRUST_PERMISSION, false) }],
    ['Remove', 'ends', withShell, removeShell],
    ['Remove, then an Allow of something else', 'ends', withShell, async () => { removeShell(); await allowThreads() }],
    ['Remove, then Allow everything on, which gives it all again', 'waits', withShell, () => { removeShell(); f.bots.setFullTrust(botId, true) }]
  ] as const)('%s while the turn that asked is still finishing: it %s at its card', async (_name, outcome, setup, change) => {
    setup()
    await f.bots.service.chatSend({ botId, text: 'Export your memory', clientRequestId: 'wall' })
    const turn = await start(f, f.store.activationByKey('chat:wall')!.id)
    turn.prepared.authority.escalate!({ permission: { ask: 'export_memory' }, reason: 'You asked.' })
    const ask = f.store.openAsks(botId).find((open) => 'ask' in open.permission)!
    // The card is recorded and the turn is still writing its reply when the grant changes.
    await change()
    await flush()
    const id = turn.payload.activationId
    expect(f.store.activation(id)!.status).toBe('running')
    await finish(f, turn.payload, 'completed', { text: 'Pick a folder.' })
    if (outcome === 'waits') {
      // It waits under the grant in place, so the owner's answer continues it there.
      expect(f.store.activation(id)).toMatchObject({ status: 'waiting_grant', grantDigest: f.store.activeGrant(botId)!.digest })
      await f.bots.service.answer(botId, ask.id, 'not_now')
      await runDispatch(f, id, 2, { text: 'All right.' })
      expect(f.store.activation(id)!.status).toBe('done')
      return
    }
    expect(f.store.activation(id)).toMatchObject({ status: 'cancelled', endReason: 'grant_replaced' })
    expect(f.store.escalation(ask.id)!.status).toBe('withdrawn')
    expect(chatOf(f, botId).some((message) => message.kind === 'notice' && message.text === 'I stopped there: my permissions changed.')).toBe(true)
    // Its slot is free: the owner's next message runs at once.
    await f.bots.service.chatSend({ botId, text: 'never mind', clientRequestId: 'next' })
    await flush()
    expect(f.store.activationByKey('chat:next')!.status).toBe('running')
  })
})

describe('the repeat guard compares what grants give', () => {
  /** A chat asks to save its memory, and the owner says Not now. Returns what the ask told the bot. */
  async function deniedExport(id: string): Promise<string | undefined> {
    await f.bots.service.chatSend({ botId, text: 'Export your memory', clientRequestId: id })
    const turn = await start(f, f.store.activationByKey(`chat:${id}`)!.id)
    const said = turn.prepared.authority.escalate!({ permission: { ask: 'export_memory' }, reason: 'You asked.' })
    await finish(f, turn.payload, 'completed', { text: 'Pick a folder.' })
    for (const ask of f.store.openAsks(botId)) await f.bots.service.answer(botId, ask.id, 'not_now')
    // The chat goes on after the Not now, and ends.
    await runDispatch(f, turn.payload.activationId, 2, { text: 'All right.' })
    return said
  }
  /** A run started by hand asks again. */
  async function asksAgain(id: string): Promise<string | undefined> {
    const run = await start(f, await activate(id))
    return run.prepared.authority.escalate!({ permission: { ask: 'export_memory' }, reason: 'Again.' })
  }

  it('holds after the grant changes and changes back, though a Not now under the other grant came between', async () => {
    // Not now under A, in the chat; then under B, to a run's ask, with no owner message since.
    expect(await deniedExport('a1')).not.toBe(BOT_ASK_DUPLICATE_TEXT)
    approve((held) => ({ ...held, tools: [...held.tools, 'shell'] }))
    expect(await asksAgain('b1')).toMatch(/^Asked the owner/)
    for (const ask of f.store.openAsks(botId)) await f.bots.service.answer(botId, ask.id, 'not_now')
    approve((held) => ({ ...held, tools: held.tools.filter((tool) => tool !== 'shell') }))
    // Past the day a run's Not now holds by itself: only the repeat guard is left.
    f.clock.now += 25 * 60 * 60_000
    expect(await asksAgain('a2')).toBe(BOT_ASK_DUPLICATE_TEXT)
  })

  it('holds when the grant lists again a tool Allow everything already gives', async () => {
    f.bots.setFullTrust(botId, true)
    expect(await deniedExport('t1')).not.toBe(BOT_ASK_DUPLICATE_TEXT)
    const before = f.store.activeGrant(botId)!.digest
    approve((held) => ({ ...held, tools: [...held.tools, 'shell'] }))
    expect(f.store.activeGrant(botId)!.digest).not.toBe(before)
    expect(await asksAgain('t2')).toBe(BOT_ASK_DUPLICATE_TEXT)
  })

  it('holds when the grant drops an older work time, which nothing reads', async () => {
    approve((held) => ({ ...held, budget: { ...held.budget, maxActiveMs: 3_600_000 } }))
    expect(await deniedExport('w1')).not.toBe(BOT_ASK_DUPLICATE_TEXT)
    const before = f.store.activeGrant(botId)!.digest
    approve((held) => { const { maxActiveMs: _gone, ...budget } = held.budget; return { ...held, budget } })
    expect(f.store.activeGrant(botId)!.digest).not.toBe(before)
    expect(await asksAgain('w2')).toBe(BOT_ASK_DUPLICATE_TEXT)
  })

  it('holds however many Not nows under other grants came since the owner last wrote', async () => {
    const first = f.bots.get(botId).published!.permissions
    expect(await deniedExport('a1')).not.toBe(BOT_ASK_DUPLICATE_TEXT)
    // A run's Not now under each of many other grants (a different turn limit each), with no owner message between.
    for (let turns = 1; turns <= 51; turns += 1) {
      approve(withLimits({ maxTurns: turns }))
      f.clock.now += 25 * 60 * 60_000
      const run = await start(f, await activate(`b${turns}`))
      expect(run.prepared.authority.escalate!({ permission: { ask: 'export_memory' }, reason: 'Again.' })).toMatch(/^Asked the owner/)
      await finish(f, run.payload, 'completed', { text: 'Asked.' })
      for (const ask of f.store.openAsks(botId)) await f.bots.service.answer(botId, ask.id, 'not_now')
    }
    approve(() => first)
    f.clock.now += 25 * 60 * 60_000
    expect(await asksAgain('a2')).toBe(BOT_ASK_DUPLICATE_TEXT)
  })
})
