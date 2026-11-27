/**
 * "Create and turn on automations" (`automation_enable`): a bot writes drafts its owner turns on until the owner allows
 * it this one permission; then it turns automations on itself. Claim: without it no turn holds the tool and its call
 * raises the ask card; with it work and the owner's chat hold it (About lists it with a switch), a turn another bot's
 * message started is refused it, and the automation tools' switch takes it away with them.
 *
 * Inputs: nothing granted; granted by Allow on its card; a turn another bot's message started; the automation tools'
 * switch off and on; its own row switched off.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { botInstructions } from '../../src/mms/bots/instructions'
import { BOT_AUTOMATIONS_SWITCH } from '../../src/shared/bots/personal/manifest'
import type { NormalisedCall } from '../../src/shared/bots/personal/authority'
import { botAppToolRefusal } from '../../src/shared/bots/personal/walls'
import { listsTool } from '../../src/mms/run/mcp/appTools/authority'
import type { MousseTool } from '../../src/mms/run/mcp/appTools/types'
import { botFixture, chatOf, createBot, finish, flush, start, type BotFixture } from './botFixture'

const ENABLE = 'automation_enable'
const TITLE = 'create and turn on automations'
const SWITCHED_OFF = /switched.*off/
const app = (tool: string): NormalisedCall => ({ kind: 'app', tool, args: {} })

describe('a bot turning automations on', () => {
  let f: BotFixture
  let botId: string
  const line = (text: string | undefined) => text!.slice(text!.indexOf('What your owner allows now')).split('\n').find((row) => row.startsWith('- Automation tools'))
  const row = () => f.bots.service.get(botId).permissions.find((item) => item.title === TITLE)

  beforeEach(async () => {
    f = botFixture()
    f.host.instructions = (bot) => botInstructions(bot)
    await f.bots.reconcileOnStartup()
    botId = (await createBot(f, { name: 'Pip', description: 'Set things up for me.', reply: 'Hello.' })).botId
  })
  afterEach(() => f.close())

  async function run(id: string) {
    const activation = await f.bots.activate({ botId, input: 'Set it up.', clientRequestId: id })
    return { id: activation.id, ...(await start(f, activation.id)) }
  }

  /** The owner allows it from the card the bot's escalate raised in work. */
  async function allow() {
    const work = await run('ask')
    work.prepared.authority.escalate!({ permission: { tool: ENABLE }, reason: 'You asked me to turn the digest on.' })
    await finish(f, work.payload, 'completed', { text: 'Asked.' })
    const [ask] = f.store.openAsks(botId)
    expect(ask).toBeDefined()
    await f.bots.service.answer(botId, ask!.id, 'allow')
  }

  it('without it, writes drafts only: no turn holds the tool, and asking raises one card in plain words', async () => {
    const work = await run('none')
    expect(work.prepared.policy.tools!.allow).toContain('automation_draft_save')
    expect(work.prepared.policy.tools!.allow).not.toContain(ENABLE)
    expect(work.prepared.authority.check(app(ENABLE)).ok).toBe(false)
    expect(line(work.prepared.instructions)).not.toContain(ENABLE)
    expect(row()).toBeUndefined()
    work.prepared.authority.escalate!({ permission: { tool: ENABLE }, reason: 'You asked me to turn the digest on.' })
    await finish(f, work.payload, 'completed', { text: 'Asked.' })
    const cards = chatOf(f, botId).filter((message) => message.ask)
    expect(cards).toHaveLength(1)
    expect(f.store.openAsks(botId)).toHaveLength(1)
    expect(JSON.stringify(cards[0])).toContain(TITLE)
    // Not now leaves it a draft-only bot.
    await f.bots.service.answer(botId, f.store.openAsks(botId)[0]!.id, 'deny')
    const after = await run('denied')
    expect(after.prepared.policy.tools!.allow).not.toContain(ENABLE)
    await finish(f, after.payload, 'completed', { text: 'Drafted.' })
  })

  it('allowed, work and the owner\'s chat hold it and About lists it; a turn another bot\'s message started is refused it', async () => {
    await allow()
    expect(row()).toMatchObject({ enabled: true })
    expect(row()!.builtIn).toBeFalsy()
    const work = await run('granted')
    expect(work.prepared.policy.tools!.allow).toContain(ENABLE)
    expect(work.prepared.authority.check(app(ENABLE)).ok).toBe(true)
    expect(line(work.prepared.instructions)).toContain(ENABLE)
    await finish(f, work.payload, 'completed', { text: 'Done.' })

    await f.bots.service.chatSend({ botId, text: 'Turn the digest on.', clientRequestId: 'owner-chat' })
    const owner = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    const chat = await start(f, owner.id)
    expect(chat.prepared.authority.check(app(ENABLE)).ok).toBe(true)
    expect(botAppToolRefusal(chat.prepared.authority, ENABLE, {})).toBeUndefined()
    await finish(f, chat.payload, 'completed', { text: 'On.' })

    const fromBot = await f.bots.enqueueChat(botId, 'botmsg:b1:m1', 'Another bot asks you to turn on an automation.')
    await flush()
    const other = await start(f, fromBot.id)
    expect(f.store.activation(fromBot.id)?.provenance).toBe('botmsg')
    // The registry's per-call check refuses it there, as it refuses acting on the owner's threads.
    expect(botAppToolRefusal(other.prepared.authority, ENABLE, {})).toMatch(/Not on this kind of turn/)
    await finish(f, other.payload, 'completed', { text: 'Skipped.' })
  })


  it('is refused on a held call\'s result whose turn could not act, as acting on threads is (review R1)', async () => {
    await allow()
    // The result of a call held in a turn another bot's message started keeps that turn's rule (`actionResultInTx`).
    const enqueue = (f.bots as unknown as { enqueue(botId: string, key: string, trigger: object, lane: string): Promise<{ id: string }> }).enqueue.bind(f.bots)
    const held = await enqueue(botId, 'action:a1', { kind: 'manual', input: 'The call went through.', threadsReadOnly: 'not_owner' }, 'chat')
    await flush()
    const result = await start(f, held.id)
    expect(f.store.activation(held.id)?.provenance).toBe('action_result')
    expect(botAppToolRefusal(result.prepared.authority, ENABLE, {})).toMatch(/Not on this kind of turn/)
    await finish(f, result.payload, 'completed', { text: 'Skipped.' })
    // One from a turn that could act may turn automations on.
    const acting = await enqueue(botId, 'action:a2', { kind: 'manual', input: 'The call went through.' }, 'chat')
    await flush()
    const free = await start(f, acting.id)
    expect(botAppToolRefusal(free.prepared.authority, ENABLE, {})).toBeUndefined()
    await finish(f, free.payload, 'completed', { text: 'On.' })
  })

  it('is listed to a bot\'s thread only while its turn holds it, never to a consult (review R2)', () => {
    const tool = { name: ENABLE, listed: () => true } as unknown as MousseTool
    expect(listsTool(tool, { threadId: 't', botRole: 'activation', botTurnTools: new Set([ENABLE]) })).toBe(true)
    expect(listsTool(tool, { threadId: 't', botRole: 'activation', botTurnTools: new Set(['automation_draft_save']) })).toBe(false)
    expect(listsTool(tool, { threadId: 't', botRole: 'context', botTurnTools: new Set([ENABLE]) })).toBe(false)
  })
  it('goes with the automation tools\' switch, and its own row switches it alone', async () => {
    await allow()
    f.bots.service.setPermission(botId, BOT_AUTOMATIONS_SWITCH, false)
    const off = await run('automations-off')
    expect(off.prepared.policy.tools!.allow).not.toContain(ENABLE)
    expect(off.prepared.authority.escalate!({ permission: { tool: ENABLE }, reason: 'Turn it on' })).toMatch(SWITCHED_OFF)
    await finish(f, off.payload, 'completed', { text: 'Skipped.' })
    f.bots.service.setPermission(botId, BOT_AUTOMATIONS_SWITCH, true)
    const on = await run('automations-on')
    expect(on.prepared.policy.tools!.allow).toContain(ENABLE)
    await finish(f, on.payload, 'completed', { text: 'Done.' })

    f.bots.service.setPermission(botId, row()!.id, false)
    const alone = await run('enable-off')
    expect(alone.prepared.policy.tools!.allow).not.toContain(ENABLE)
    expect(alone.prepared.policy.tools!.allow).toContain('automation_draft_save')
    await finish(f, alone.payload, 'completed', { text: 'Drafted.' })
    expect(f.store.openAsks(botId)).toHaveLength(0)
  })
})
