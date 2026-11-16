import { afterEach, expect, it } from 'vitest'
import { BotMcp, callForBot } from '../../src/mms/bots/mcp/BotMcp'
import { getDefaultSettings } from '../../src/shared/settings'
import { botManifestDigest } from '../../src/mms/bots/grants/compile'
import { botFixture, createBot, finish, flush, start, type BotFixture } from './botFixture'

let f: BotFixture
 afterEach(() => f?.close())
async function setup(on: boolean) {
  f = botFixture()
  const settings = getDefaultSettings()
  settings.experimental.botAsksFirst = on
  f.host.settings = { get: () => settings, set: () => undefined } as never
  const calls: unknown[] = []
  const descriptor = { toolName: 'send', providerName: 'mail_send', inputSchema: { type: 'object' }, installationId: 'mail', serverId: 'mail', serverName: 'Mail' }
  const server = { installationId: 'mail', serverName: 'Mail', configDigest: 'config-1', failing: false, tools: [descriptor] }
  const mcp = new BotMcp({ enabled: () => true, catalog: {
    ensure: async () => undefined, listing: () => [{ ...descriptor, name: 'Mail__send' }],
    servers: () => [server]
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
  return { botId, workId, work, args, calls, call, server, descriptor, chatId: chat.id, mcp }
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

// Actors: a second device, changed schema/configuration/grant/device ceiling, restart.
// Orders: answer before/after turn end, double Send, Send versus Not now, approved/running crash.
it.each(['digest', 'schema', 'configuration', 'grant', 'device'] as const)('refuses a stale %s without making a call', async (change) => {
  const t = await setup(true)
  await t.call()
  await finish(f, t.work.payload)
  const action = f.bots.actions.forWork(t.workId)!
  const answer = { actionId: action.id, digest: action.args_digest, answer: 'send' as const }
  if (change === 'digest') answer.digest = 'old-digest'
  if (change === 'schema') t.descriptor.inputSchema = { type: 'object', required: ['extra'] } as never
  if (change === 'configuration') t.server.configDigest = 'changed'
  if (change === 'grant') {
    const grant = f.store.activeGrant(t.botId)!
    f.store.approve(t.botId, grant.digest, grant.manifest)
  }
  if (change === 'device') f.store.narrowOwnerLimit(t.chatId, 'plan')
  await expect(f.bots.actions.answer(answer)).rejects.toThrow('changed since')
  expect(t.calls).toEqual([])
  expect(f.bots.actions.forWork(t.workId)?.status).toBe('open')
})
it('Not now makes no call and resumes with the refusal as data', async () => {
  const t = await setup(true)
  await t.call()
  await finish(f, t.work.payload)
  const a = f.bots.actions.forWork(t.workId)!
  await f.bots.actions.answer({ actionId: a.id, digest: a.args_digest, answer: 'not_now' })
  await flush()
  expect(t.calls).toEqual([])
  expect(f.store.lastMainDispatch(t.workId)?.prompt.text).toContain('chose not to send')
  expect(f.bots.actions.forWork(t.workId)).toMatchObject({ status: 'declined', exec_args: null })
})
it.each(['send', 'not_now'] as const)('Send racing Not now, %s arriving first, never calls twice', async first => {
  const t = await setup(true)
  await t.call()
  await finish(f, t.work.payload)
  const a = f.bots.actions.forWork(t.workId)!
  await Promise.allSettled([first, first === 'send' ? 'not_now' : 'send'].map(answer => f.bots.actions.answer({ actionId: a.id, digest: a.args_digest, answer: answer as 'send' | 'not_now' })))
  expect(t.calls).toEqual(first === 'send' ? [t.args] : [])
  expect(f.bots.actions.forWork(t.workId)?.exec_args).toBeNull()
})
it.each(['approved', 'running'] as const)('restart after %s never repeats a call that might have run', async state => {
  const t = await setup(true)
  await t.call()
  await finish(f, t.work.payload)
  const a = f.bots.actions.forWork(t.workId)!
  expect(a.exec_args).not.toBeNull()
  f.bots.actions.transition(a.id, 'open', 'approved')
  if (state === 'running') f.bots.actions.transition(a.id, 'approved', 'running')
  await f.bots.actions.reconcile()
  await f.bots.actions.reconcile()
  expect(t.calls).toEqual(state === 'approved' ? [t.args] : [])
  expect(f.bots.actions.forWork(t.workId)).toMatchObject({ status: state === 'approved' ? 'done' : 'uncertain', exec_args: null })
})
it('answering before the old turn ends does not dispatch a second turn early', async () => {
  const t = await setup(true)
  await t.call()
  const a = f.bots.actions.forWork(t.workId)!
  await f.bots.actions.answer({ actionId: a.id, digest: a.args_digest, answer: 'send' })
  await flush()
  expect(f.store.lastMainDispatch(t.workId)?.n).toBe(1)
  await finish(f, t.work.payload)
  await flush()
  expect(f.store.lastMainDispatch(t.workId)?.n).toBe(2)
  expect(t.calls).toEqual([t.args])
})
