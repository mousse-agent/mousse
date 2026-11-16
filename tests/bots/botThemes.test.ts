/**
 * "Change how Mousse looks" as the bot engine holds it: not in a new bot's grant, one ask and one card, Allow gives the
 * chat and work theme_read and theme_set, About lists it, and Remove takes it away. The tools themselves are in
 * tests/run/botThemeTools.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { botInstructions } from '../../src/mms/bots/instructions'
import { askText } from '../../src/shared/bots/personal/askText'
import { BOT_THEME_TOOLS, botStarterManifest } from '../../src/shared/bots/personal/manifest'
import { botFixture, chatOf, createBot, finish, start, type BotFixture } from './botFixture'

const themeTools = (allow: readonly string[] | undefined) => (allow ?? []).filter((name) => name.startsWith('theme_')).sort()

describe('"change how Mousse looks" in the bot engine', () => {
  let f: BotFixture
  let botId: string
  const cards = () => chatOf(f, botId).filter((message) => message.ask)
  const line = (text: string | undefined) => text!.slice(text!.indexOf('What your owner allows now')).split('\n').find((row) => row.startsWith('- Change how Mousse looks'))

  beforeEach(async () => {
    f = botFixture()
    f.host.instructions = (bot) => botInstructions(bot)
    await f.bots.reconcileOnStartup()
    botId = (await createBot(f, { name: 'Alpha', description: 'Help me with my work.', reply: 'Hello.' })).botId
  })
  afterEach(() => f.close())

  async function chat(text: string, id: string) {
    await f.bots.service.chatSend({ botId, text, clientRequestId: id })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    return { activation, ...(await start(f, activation.id)) }
  }

  it('a new bot has no theme tools; asked from the chat, one card; Allow gives the chat and work both tools; About lists it; Remove takes it away', async () => {
    expect(botStarterManifest().appTools).not.toContain('themes')
    const turn = await chat('Make Mousse dark blue with my beach photo behind the chat.', 'm1')
    expect(themeTools(turn.prepared.policy.tools!.allow)).toEqual([])
    expect(turn.prepared.instructions).toContain('You can ask for "change how Mousse looks" (escalate with the tool themes)')
    expect(line(turn.prepared.instructions)).toMatch(/: no$/)
    turn.prepared.authority.escalate!({ permission: { tool: 'themes' }, reason: 'You asked me to change the theme.' })
    // A call of one of its tools in the same turn is the same ask.
    turn.prepared.authority.check({ kind: 'app', tool: 'theme_set', args: {} })
    await finish(f, turn.payload, 'completed', { text: 'I asked to change how Mousse looks.' })
    expect(cards()).toHaveLength(1)
    const card = cards()[0]!.ask!
    expect(card).toMatchObject({ title: 'change how Mousse looks', status: 'open' })
    await f.bots.service.answer(botId, card.askId, 'allow')
    expect(f.store.activeGrant(botId)!.manifest.appTools).toContain('themes')

    // The answer continues the owner's turn, now with the theme tools.
    const continued = await start(f, turn.activation.id, 2)
    expect(themeTools(continued.prepared.policy.tools!.allow)).toEqual([...BOT_THEME_TOOLS].sort())
    expect(line(continued.prepared.instructions)).toMatch(/: yes$/)
    await finish(f, continued.payload, 'completed', { text: 'Done: Mousse is dark blue now.' })
    const item = f.bots.service.get(botId).permissions.find((entry) => entry.title === 'change how Mousse looks')!
    expect(item.note).toBe(askText({ tool: 'themes' }).tip)

    // Work has them too.
    const work = await f.bots.activate({ botId, input: 'Switch Mousse to the light theme at sunrise.', clientRequestId: 'w1' })
    const run = await start(f, work.id)
    expect(themeTools(run.prepared.policy.tools!.allow)).toEqual([...BOT_THEME_TOOLS].sort())
    await finish(f, run.payload, 'completed', { text: 'Done.' })

    // Remove takes it away.
    f.bots.service.revokePermission(botId, item.id)
    const after = await chat('Change it again.', 'm2')
    expect(themeTools(after.prepared.policy.tools!.allow)).toEqual([])
    await finish(f, after.payload, 'completed', { text: 'I can\'t now.' })
  })
})
