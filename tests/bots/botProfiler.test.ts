/**
 * "Use the profiler" as the bot engine holds it: one ask and one card, Allow gives the chat its quick profiler tools and
 * work all of them, About lists it, the heap summary can't be asked for, and adding the permission leaves every existing
 * grant's digest as it was. The tools themselves are in tests/run/botProfilerTools.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { botManifestDigest } from '../../src/mms/bots/grants/compile'
import { botInstructions } from '../../src/mms/bots/instructions'
import { askText } from '../../src/shared/bots/personal/askText'
import { BOT_PROFILER_CHAT_TOOLS, BOT_PROFILER_TOOLS, botStarterManifest } from '../../src/shared/bots/personal/manifest'
import { botFixture, chatOf, createBot, finish, start, type BotFixture } from './botFixture'

const profilerTools = (allow: readonly string[] | undefined) => (allow ?? []).filter((name) => name.startsWith('profiler_')).sort()

describe('"use the profiler" in the bot engine', () => {
  let f: BotFixture
  let botId: string
  const cards = () => chatOf(f, botId).filter((message) => message.ask)
  const line = (text: string | undefined) => text!.slice(text!.indexOf('What your owner allows now')).split('\n').find((row) => row.startsWith("- Read Mousse's profiler"))

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

  it('asked from the chat: one card; Allow gives the chat the quick tools and work every read and sample tool; About lists it', async () => {
    const turn = await chat('Why is Mousse so slow today?', 'm1')
    expect(profilerTools(turn.prepared.policy.tools!.allow)).toEqual([])
    expect(turn.prepared.instructions).toContain('You can ask for "use the profiler" (escalate with the tool profiler)')
    expect(line(turn.prepared.instructions)).toMatch(/: no$/)
    turn.prepared.authority.escalate!({ permission: { tool: 'profiler' }, reason: 'You asked why Mousse is slow.' })
    // A call of one of its tools in the same turn is the same ask.
    turn.prepared.authority.check({ kind: 'app', tool: 'profiler_overview', args: {} })
    await finish(f, turn.payload, 'completed', { text: 'I asked to use the profiler.' })
    expect(cards()).toHaveLength(1)
    const card = cards()[0]!.ask!
    expect(card).toMatchObject({ title: 'use the profiler', status: 'open' })
    await f.bots.service.answer(botId, card.askId, 'allow')
    expect(f.store.activeGrant(botId)!.manifest.appTools).toContain('profiler')

    // The answer continues the owner's turn, now with the profiler's quick tools.
    const continued = await start(f, turn.activation.id, 2)
    expect(profilerTools(continued.prepared.policy.tools!.allow)).toEqual([...BOT_PROFILER_CHAT_TOOLS].sort())
    expect(line(continued.prepared.instructions)).toMatch(/: yes/)
    await finish(f, continued.payload, 'completed', { text: 'Mousse uses 1.2 GB.' })
    const item = f.bots.service.get(botId).permissions.find((entry) => entry.title === 'use the profiler')!
    expect(item.note).toBe(askText({ tool: 'profiler' }).tip)

    // Work has every read and sample tool, the watch included; never the heap summary.
    const work = await f.bots.activate({ botId, input: 'Watch Mousse\'s memory for two minutes.', clientRequestId: 'w1' })
    const run = await start(f, work.id)
    expect(profilerTools(run.prepared.policy.tools!.allow)).toEqual([...BOT_PROFILER_TOOLS].sort())
    expect(run.prepared.policy.tools!.allow).not.toContain('profiler_heap_summary')
    await finish(f, run.payload, 'completed', { text: 'Done.' })

    // Remove takes it away.
    f.bots.service.revokePermission(botId, item.id)
    const after = await chat('Check again.', 'm2')
    expect(profilerTools(after.prepared.policy.tools!.allow)).toEqual([])
    await finish(f, after.payload, 'completed', { text: 'I can\'t now.' })
  })

  it('the heap summary can\'t be asked for: escalate and a call of it are refused, with no card', async () => {
    const turn = await chat('Take a heap snapshot.', 'm1')
    expect(turn.prepared.authority.escalate!({ permission: { tool: 'profiler_heap_summary' }, reason: 'You asked.' })).toBe("A bot can't be given the Mousse tool profiler_heap_summary. Carry on without it.")
    expect(turn.prepared.authority.check({ kind: 'app', tool: 'profiler_heap_summary', args: {} })).toMatchObject({ ok: false, wall: { kind: 'tool' } })
    await finish(f, turn.payload, 'completed', { text: 'I can\'t do that.' })
    expect(cards()).toHaveLength(0)
  })
})

describe('existing grants', () => {
  // Digests of grants an earlier build approved, computed on master before "use the profiler" existed (9fba70c9c): a new permission must not
  // change them, or every bot would be asked to approve again.
  const starter = botStarterManifest()
  const grants: Array<[string, ReturnType<typeof botStarterManifest>, string]> = [
    ['the starter grant', starter, 'd0b44cfcf36ff72d65c07d1c6f51f955b0d4bc00ad9f4fd0fb4efe90b321deab'],
    ['with the browser, threads and commands', { ...starter, tools: [...starter.tools, 'shell'], appTools: [...starter.appTools, 'browser', 'threads'] }, '09b62fdfdda331c564ab30f80109c39aefc91f408cbf1e61c867a212b62fb6b9']
  ]
  it.each(grants)('%s keeps its digest', (_name, manifest, digest) => {
    expect(botManifestDigest(manifest)).toBe(digest)
  })
})
