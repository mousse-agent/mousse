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
import { BotEngine } from '../../src/mms/bots/activation/BotEngine'
import { botManifestDigest } from '../../src/mms/bots/grants/compile'
import type { NormalisedCall } from '../../src/shared/bots/personal/authority'
import type { BotManifest } from '../../src/shared/bots/personal/definition'
import { BOT_AUTOMATIONS_SWITCH, BOT_FULL_TRUST_PERMISSION } from '../../src/shared/bots/personal/manifest'
import { appToolRegistry, appTurn, fakeAppToolHost } from '../run/appToolsFixture'
import { delegationFixture } from '../run/delegationFixture'
import { botFixture, createBot, finish, flush, start, type BotFixture } from './botFixture'

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
})
