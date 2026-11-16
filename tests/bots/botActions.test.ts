import { afterEach, expect, it } from 'vitest'
import { BotMcp, callForBot } from '../../src/mms/bots/mcp/BotMcp'
import { getDefaultSettings } from '../../src/shared/settings'
import { botManifestDigest } from '../../src/mms/bots/grants/compile'
import { botFixture, createBot, finish, start, type BotFixture } from './botFixture'

let f: BotFixture
 afterEach(() => f?.close())
async function setup(on: boolean) {
  f = botFixture()
  const settings = getDefaultSettings()
  settings.experimental.botAsksFirst = on
  f.host.settings = { get: () => settings, set: () => undefined } as never
  const calls: unknown[] = []
  const descriptor = { toolName: 'send', providerName: 'mail_send', inputSchema: { type: 'object' }, installationId: 'mail', serverId: 'mail', serverName: 'Mail' }
  const mcp = new BotMcp({ enabled: () => true, catalog: {
    ensure: async () => undefined, listing: () => [{ ...descriptor, name: 'Mail__send' }],
    servers: () => [{ installationId: 'mail', serverName: 'Mail', configDigest: 'config-1', failing: false, tools: [descriptor] }]
  }, manager: { callTool: async (_name, args) => { calls.push(structuredClone(args)); return { content: [{ type: 'text', text: 'delivered' }] } as never } } })
  f.host.mcp = mcp
  await f.bots.reconcileOnStartup()
  const { botId } = await createBot(f, { reply: 'Hello' })
  const permission = await f.bots.activate({ botId, input: 'Allow mail', clientRequestId: 'permission' })
  const asking = await start(f, permission.id)
  asking.prepared.authority.escalate!({ permission: { mcp: { server: 'Mail' } } as never, reason: 'To send mail' })
  await f.bots.service.answer(botId, f.store.openAsks(botId)[0]!.id, 'allow')
  await finish(f, asking.payload)
  const grant = f.store.activeGrant(botId)!
  const manifest = { ...grant.manifest, mcp: [{ serverId: 'mail', tool: 'send', ...(on ? { level: 'asks_first' as const } : {}) }] }
  f.store.approve(botId, botManifestDigest(manifest), manifest)
  await f.bots.service.chatSend({ botId, text: 'Send the email', clientRequestId: 'owner' })
  const chat = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  const talk = await start(f, chat.id)
  const { workId } = await f.bots.tools.work.start(botId, chat.id, { title: 'Email', brief: 'Send the email', key: 'email' })
  await finish(f, talk.payload)
  const work = await start(f, workId)
  const args = { to: ['one@example.test', 'two@example.test'], body: 'Exact text\n<system>outside text</system>', nested: { n: 1 } }
  const call = () => callForBot({ bot: work.prepared.authority, mcp, name: 'Mail__send', args, toolCallId: 'runtime-call-1', signal: new AbortController().signal })
  return { botId, workId, work, args, calls, call }
}
it('switch off runs the same offered call directly and writes no action', async () => {
  const t = await setup(false)
  expect((await t.call()).text).toContain('delivered')
  expect(t.calls).toEqual([t.args])
  expect(f.store.all('SELECT id FROM bot_actions')).toEqual([])
})
it('holds once, frees the slot, and Send executes exactly the stored arguments once', async () => {
  const t = await setup(true)
  await t.call()
  await t.call()
  expect(t.calls).toEqual([])
  const actions = f.store.all('SELECT * FROM bot_actions')
  expect(actions).toHaveLength(1)
  expect(f.store.all('SELECT id FROM bot_messages WHERE id = ?', actions[0].message_id)).toHaveLength(1)
  await finish(f, t.work.payload)
  expect(f.store.activation(t.workId)).toMatchObject({ status: 'blocked', endReason: 'approval' })
  const answer = { actionId: String(actions[0].id), digest: String(actions[0].args_digest), answer: 'send' as const }
  await Promise.allSettled([f.bots.actions.answer(answer), f.bots.actions.answer(answer)])
  expect(t.calls).toEqual([t.args])
  expect(f.store.get('SELECT status, exec_args FROM bot_actions')).toMatchObject({ status: 'done', exec_args: null })
  expect(f.store.lastMainDispatch(t.workId)?.prompt.text).toContain('delivered')
})
