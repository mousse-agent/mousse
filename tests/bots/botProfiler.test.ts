/**
 * The profiler as the bot engine holds it: the heap summary can't be asked for, and grants an older build approved keep
 * their digests. That every bot has the profiler without asking is in tests/bots/botNoAskGroups.test.ts; the tools
 * themselves are in tests/run/botProfilerTools.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { botManifestDigest } from '../../src/mms/bots/grants/compile'
import { botInstructions } from '../../src/mms/bots/instructions'
import { botStarterManifest } from '../../src/shared/bots/personal/manifest'
import { botFixture, chatOf, createBot, finish, start, type BotFixture } from './botFixture'

describe('the profiler in the bot engine', () => {
  let f: BotFixture
  let botId: string
  const cards = () => chatOf(f, botId).filter((message) => message.ask)

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
  // Saved values from 9fba70c9c, not today's starter.
  const starter: ReturnType<typeof botStarterManifest> = {
    tools: ['read', 'list', 'search', 'edit', 'write'],
    appTools: ['web_search', 'web_fetch', 'bot_schedule_add', 'bot_schedule_remove', 'bot_schedule_list',
      'set_profile', 'set_depth', 'use_model', 'escalate', 'memory_search', 'memory_read', 'memory_list',
      'memory_save', 'memory_forget', 'run_report'],
    mcp: [], skills: [], workspace: null, budget: { maxActiveMs: 3_600_000 }, audience: 'owner'
  }
  const grants: Array<[string, ReturnType<typeof botStarterManifest>, string]> = [
    ['the starter grant', starter, 'd0b44cfcf36ff72d65c07d1c6f51f955b0d4bc00ad9f4fd0fb4efe90b321deab'],
    ['with the browser, threads and commands', { ...starter, tools: [...starter.tools, 'shell'], appTools: [...starter.appTools, 'browser', 'threads'] }, '09b62fdfdda331c564ab30f80109c39aefc91f408cbf1e61c867a212b62fb6b9']
  ]
  it.each(grants)('%s keeps its digest', (_name, manifest, digest) => {
    expect(botManifestDigest(manifest)).toBe(digest)
  })
})
