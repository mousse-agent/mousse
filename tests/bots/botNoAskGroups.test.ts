/**
 * The profiler, Mousse's look, scheduled jobs, secrets and quick actions are no longer permissions: every bot's main turns
 * have their tools with nothing granted, an `escalate` for one makes no card, and a grant an older build approved that
 * still names one loads with the same digest, runs, and lists nothing for it in About. The tools themselves are in
 * tests/run/botProfilerTools.test.ts and tests/run/botThemeTools.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BOT_NO_ASK_NEEDED_TEXT } from '../../src/mms/bots/activation/BotEngine'
import { botManifestDigest } from '../../src/mms/bots/grants/compile'
import { botInstructions } from '../../src/mms/bots/instructions'
import { BOT_DROPPED_PERMISSIONS } from '../../src/shared/bots/personal/manifest'
import { botFixture, chatOf, createBot, finish, start, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string

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

async function work(id: string) {
  const activation = await f.bots.activate({ botId, input: 'Do the job.', clientRequestId: id })
  return { activation, ...(await start(f, activation.id)) }
}

// What each group's tools are in a chat turn the owner's message started, and in work (no "run commands": no secret_run).
const groups: Array<[string, string, string[], string[]]> = [
  ['the profiler', 'profiler', ['profiler_overview'], ['profiler_overview', 'profiler_watch']],
  ["Mousse's look", 'themes', ['theme_read', 'theme_set'], ['theme_read', 'theme_set']],
  ['scheduled jobs', 'schedules', ['schedule_list', 'schedule_create'], ['schedule_list', 'schedule_create']],
  ['secrets', 'secrets', ['secret_request'], ['secret_request', 'secret_fetch']],
  ['quick actions', 'quick_actions', ['create_quick_action'], ['create_quick_action']]
]

describe('every bot has them with nothing granted', () => {
  it.each(groups)('%s: in the chat and in work, and escalate makes no card', async (_name, permission, inChat, inWork) => {
    expect(f.store.activeGrant(botId)!.manifest.appTools).not.toContain(permission)
    const talk = await chat('Help me with Mousse.', 'm1')
    expect(talk.prepared.policy.tools!.allow).toEqual(expect.arrayContaining(inChat))
    for (const tool of inChat) expect(talk.prepared.authority.check({ kind: 'app', tool, args: {} })).toEqual({ ok: true })
    expect(talk.prepared.authority.escalate!({ permission: { tool: permission }, reason: 'You asked.' })).toBe(BOT_NO_ASK_NEEDED_TEXT)
    await finish(f, talk.payload, 'completed', { text: 'Done.' })
    const run = await work('w1')
    expect(run.prepared.policy.tools!.allow).toEqual(expect.arrayContaining(inWork))
    await finish(f, run.payload, 'completed', { text: 'Done.' })
    expect(chatOf(f, botId).filter((message) => message.ask)).toEqual([])
    expect(f.store.openAsks(botId)).toEqual([])
  })
})

it('a grant an older build approved with every one of them loads with the same digest, runs with their tools, and lists none in About', async () => {
  const current = f.host.definitions.revision(botId, f.store.registry(botId)!.revision!)!
  const permissions = { ...current.permissions, appTools: [...current.permissions.appTools, ...BOT_DROPPED_PERMISSIONS] }
  const published = f.host.definitions.publishRevision({ ...current, permissions })
  f.store.setPublished(botId, published.revision!)
  const digest = botManifestDigest(permissions)
  f.store.approve(botId, digest, permissions)

  const run = await work('old-grant')
  expect(f.store.activeGrant(botId)!.digest).toBe(digest)
  expect(run.prepared.policy.authority).toEqual({ kind: 'bot', digest })
  // The names give nothing of their own: only the tools every bot has.
  for (const name of BOT_DROPPED_PERMISSIONS) expect(run.prepared.policy.tools!.allow).not.toContain(name)
  expect(run.prepared.policy.tools!.allow).toEqual(expect.arrayContaining(['profiler_overview', 'theme_set', 'schedule_list', 'secret_request', 'create_quick_action']))
  await finish(f, run.payload, 'completed', { text: 'Done.' })
  expect(f.store.activeGrant(botId)!.digest).toBe(digest)
  expect(f.bots.service.get(botId).permissions.map((item) => item.title).join('\n')).not.toMatch(/profiler|how Mousse looks|schedule work|secrets|quick actions/i)
})
