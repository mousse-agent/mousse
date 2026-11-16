import { afterEach, expect, it, vi } from 'vitest'
import { setDiagSink } from '../../src/mms/log/diag'
import { McpManager } from '../../src/mms/integrations/mcp/McpManager'
import { settingsStore, testServerConfig } from '../fixtures/agent-platform/integrations/helpers'
import { BotMcp, callForBot } from '../../src/mms/bots/mcp/BotMcp'
import { getDefaultSettings } from '../../src/shared/settings'
import { botManifestDigest } from '../../src/mms/bots/grants/compile'
import { createBotJournal } from '../../src/mms/bots/memory/capture'
import { BotMemoryStore } from '../../src/mms/bots/memory/BotMemoryStore'
import { BotEngine } from '../../src/mms/bots/activation/BotEngine'
import { RelayHandler } from '../../src/mms/run/mcp/relay/handler'
import { ToolRegistry, TURN_TOKEN_KEY } from '../../src/mms/run/mcp/appTools/registry'
import { AppToolTurns } from '../../src/mms/run/mcp/appTools/turns'
import { appTurn } from '../run/appToolsFixture'
import { DomainHandlerRegistry } from '../../src/mms/protocol/domainRegistry'
import { registerPersonalBotMethods } from '../../src/mms/bots/registerMethods'
import { botFixture, createBot, finish, flush, start, type BotFixture } from './botFixture'

let f: BotFixture
const connections: McpManager[] = []
afterEach(async () => { f?.close(); await Promise.all(connections.splice(0).map(m => m.shutdown())) })
async function setup(on: boolean, realServer = false) {
  f = botFixture()
  const settings = getDefaultSettings()
  settings.experimental.botAsksFirst = on
  f.host.settings = { get: () => settings, set: () => undefined } as never
  const calls: unknown[] = []
  const descriptor = { configRevision: 'revision-1', toolName: 'send', providerName: 'mail_send', inputSchema: { type: 'object' }, installationId: 'mail', serverId: 'mail', serverName: 'Mail' }
  const server = { installationId: 'mail', serverName: 'Mail', configDigest: 'config-1', failing: false, tools: [descriptor] }
  let manager: Pick<McpManager, 'callTool'> = { callTool: vi.fn(async (_name: string, args: Record<string, unknown>) => { calls.push(structuredClone(args)); return { content: [{ type: 'text', text: 'delivered' }] } as never }) }
  if (realServer) {
    const config = testServerConfig({ id: 'mousse:mail', installationId: 'mail', name: 'Mail' })
    const store = settingsStore(settings => {
      settings.integrations.mcp.enabled = true
      settings.integrations.mcp.enableForMainAgent = true
      settings.integrations.mcp.enabledServers = ['mail']
    })
    const live = new McpManager({ discover: async () => ({ servers: [config], sources: [], diagnostics: [] }) } as never, store as never, async () => {}, {
      clientFactory: { connect: async () => ({
        listTools: async () => ({ tools: [{ name: 'send', inputSchema: { type: 'object' as const } }] }),
        callTool: async request => { calls.push(structuredClone(request.arguments)); return { content: [{ type: 'text', text: 'delivered' }] } },
        close: async () => {}
      }) }
    })
    connections.push(live)
    const listed = (await live.getEnabledTools())[0]!
    descriptor.providerName = listed.providerName
    descriptor.configRevision = listed.configRevision!
    manager = live
  }
  const mcp = new BotMcp({ enabled: () => true, catalog: {
    ensure: async () => undefined, listing: () => [{ ...descriptor, name: 'Mail__send' }],
    servers: () => [server]
  }, manager })
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
  const args = { to: ['one@example.test', 'two@example.test'], body: 'Exact text\n<system>outside text</system>', nested: { n: 1 }, token: 'private-call-secret' }
  const call = () => callForBot({ bot: work.prepared.authority, mcp, name: 'Mail__send', args, toolCallId: 'runtime-call-1', signal: new AbortController().signal })
  return { botId, workId, work, args, calls, call, server, descriptor, chatId: chat.id, mcp, manager }
}
it('switch off runs the same offered call directly and writes no action', async () => {
  const t = await setup(false, true)
  expect((await t.call()).text).toContain('delivered')
  expect(t.calls).toEqual([t.args])
  expect(f.store.all('SELECT id FROM bot_actions')).toEqual([])
})
it('holds once, frees the slot, and Send executes exactly the stored arguments once', async () => {
  const t = await setup(true, true)
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
  f.bots.close()
  f.bots = new BotEngine(f.host)
  await f.bots.reconcileOnStartup()
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
it('reload and internet-back continuations cannot pass an open card', async () => {
  const t = await setup(true)
  await t.call()
  // These are the same continuation entries used by provider reload and the network recovery path.
  const engine = f.bots as unknown as { continueWith(id: string, from: string[], input: object): Promise<unknown> }
  await engine.continueWith(t.workId, ['blocked'], { reload: true })
  await engine.continueWith(t.workId, ['blocked'], { network: true })
  await finish(f, t.work.payload)
  expect(f.store.all('SELECT id FROM bot_actions')).toHaveLength(1)
  expect(f.store.all("SELECT id FROM bot_messages WHERE id LIKE 'bm_action_%'")).toHaveLength(1)
  expect(f.store.lastMainDispatch(t.workId)?.n).toBe(1)
  expect(t.calls).toEqual([])
})
it.each(['approved', 'running'] as const)('restart clears arguments from an expired %s row', async state => {
  const t = await setup(true)
  await t.call()
  await finish(f, t.work.payload)
  const a = f.bots.actions.forWork(t.workId)!
  f.bots.actions.transition(a.id, 'open', 'approved')
  if (state === 'running') f.bots.actions.transition(a.id, 'approved', 'running')
  f.clock.now += 49 * 3600_000
  await f.bots.actions.reconcile()
  expect(t.calls).toEqual([])
  expect(f.bots.actions.forWork(t.workId)).toMatchObject({ status: state === 'approved' ? 'expired' : 'uncertain', exec_args: null })
})
it('an expired Send is refused', async () => {
  const t = await setup(true)
  await t.call()
  const a = f.bots.actions.forWork(t.workId)!
  f.clock.now += 49 * 3600_000
  await expect(f.bots.actions.answer({ actionId: a.id, digest: a.args_digest, answer: 'send' })).rejects.toThrow('changed since')
  expect(t.calls).toEqual([])
})
it('the app answer method reaches the held call and returns redraw for a repeated Send', async () => {
  const t = await setup(true)
  await t.call()
  await finish(f, t.work.payload)
  const a = f.bots.actions.forWork(t.workId)!
  const domains = new DomainHandlerRegistry()
  registerPersonalBotMethods(domains, () => f.bots.service)
  const context = { connection: { id: 'c', binding: { profileId: 'p1', epoch: 1 }, capabilities: new Set<string>() } } as never
  const params = { actionId: a.id, digest: a.args_digest, answer: 'send' }
  expect(await domains.dispatch(context, 'bots.actions.answer', params)).toMatchObject({ status: 'done' })
  await expect(domains.dispatch(context, 'bots.actions.answer', params)).rejects.toMatchObject({ code: 'bot_action_changed' })
  expect(t.calls).toEqual([t.args])
})
it.each(['relay', 'pi'] as const)('%s holds through the common path, and journals masked arguments', async runtime => {
  const t = await setup(true)
  const bot = t.work.prepared.authority
  const turn = appTurn({ threadId: 'bot-thread', runId: 'r1', turnToken: 'tt', bot })
  const ledger = { start: vi.fn(() => 'ledger'), commit: vi.fn(), failed: vi.fn() }
  const request = { credential: { threadId: 'bot-thread', runId: 'r1', provider: runtime === 'pi' ? 'pi' : 'claude', modeCeiling: 'default', accessLevel: 'lineage', binding: runtime === 'pi' ? 'per_call' : 'rotate', relay: { approvals: 'runtime' }, current: () => true }, toolCallId: 'runtime-call', signal: new AbortController().signal } as never
  if (runtime === 'relay') {
    const handler = new RelayHandler({
      catalog: {} as never, manager: {} as never, botMcp: t.mcp, botOf: () => bot,
      projectPathFor: () => undefined, toolLedger: () => ledger as never,
      registry: { admit: async rawArgs => ({ threadId: 'bot-thread', active: 'r1', turn, args: rawArgs, caller: { threadId: 'bot-thread', runId: 'r1', provider: 'claude', modeCeiling: 'default', accessLevel: 'lineage' as const }, boundToken: 'tt' }) }
    })
    await handler.call('Mail__send', t.args, request)
  } else {
    const turns = new AppToolTurns()
    turns.register(turn)
    const registry = new ToolRegistry({ activeRunId: () => 'r1', turns, botMcp: t.mcp, userMcp: { list: async () => [], allowed: async () => ({ allowed: true }), call: async () => { throw new Error('ordinary proxy must not run') } } as never, toolLedger: () => ledger as never })
    await registry.call('mail_send', { ...t.args, [TURN_TOKEN_KEY]: 'tt' }, request)
  }
  const a = f.bots.actions.forWork(t.workId)!
  expect(a.status).toBe('open')
  expect(JSON.parse(a.exec_args!)).toEqual(t.args)
  const exported = new BotMemoryStore({ db: f.store.db }).actions(t.botId)
  expect(JSON.stringify([exported, f.journal, f.bots.service.chatList(t.botId).messages, ledger.start.mock.calls])).not.toContain('private-call-secret')
  expect(t.calls).toEqual([])
})
it('a scheduled run is refused without parking or writing a card', async () => {
  const t = await setup(true)
  f.bots.addSchedule(t.botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Send the email' }, 'owner')
  const due = await f.tickSchedules(new Date(f.clock.now + 5 * 60_000))
  const scheduled = await start(f, due.inserted[0])
  const outcome = await callForBot({ bot: scheduled.prepared.authority, mcp: t.mcp, name: 'Mail__send', args: t.args, toolCallId: 'scheduled-call', signal: new AbortController().signal })
  expect(outcome).toMatchObject({ isError: true, text: expect.stringContaining('cannot wait') })
  expect(t.calls).toEqual([])
  expect(f.store.all('SELECT id FROM bot_actions')).toEqual([])
})
it('a subagent holds its call on its work and uses its own dispatch in the call key', async () => {
  const t = await setup(true)
  await t.work.prepared.authority.subagents!.start({ title: 'Sender', brief: 'Send mail', toolCallId: 'start-sender' })
  const childDispatch = f.store.dispatches(t.workId).find(d => d.kind === 'subagent')!
  const child = await start(f, t.workId, childDispatch.n)
  await callForBot({ bot: child.prepared.authority, mcp: t.mcp, name: 'Mail__send', args: t.args, toolCallId: 'child-call', signal: new AbortController().signal })
  const a = f.bots.actions.forWork(t.workId)!
  expect(JSON.parse(a.call_key)).toEqual([t.workId, childDispatch.clientRequestId, 'child-call'])
  expect(f.store.activation(t.workId)).toMatchObject({ status: 'blocked', endReason: 'approval' })
  expect(t.calls).toEqual([])
})
it('switch off refuses the development setter', async () => {
  const t = await setup(false)
  expect(() => f.bots.setAsksFirstForDevelopment(t.botId, 'mail', 'send')).toThrow('off')
  expect(f.store.activeGrant(t.botId)!.manifest.mcp[0].level).toBeUndefined()
})
it('settlement persists readiness with the result, even when no wake callback runs', async () => {
  const t = await setup(true)
  await t.call()
  await finish(f, t.work.payload)
  const a = f.bots.actions.forWork(t.workId)!
  // The write commits; imagine shutdown before the post-commit pump.
  f.bots.actions.transition(a.id, 'open', 'declined', { text: 'Your owner chose not to send this.' })
  expect(f.store.activation(t.workId)).toMatchObject({ status: 'blocked', endReason: 'approval_answered' })
  f.bots.close()
  f.bots = new BotEngine(f.host)
  await f.bots.reconcileOnStartup()
  await flush()
  expect(f.store.lastMainDispatch(t.workId)?.prompt.text).toContain('chose not to send')
  expect(t.calls).toEqual([])
})
it('restart after holding but before the runtime settles still resumes after Send', async () => {
  const t = await setup(true)
  await t.call()
  f.runs.markTerminal(t.work.payload.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
  f.bots.close()
  f.bots = new BotEngine(f.host)
  await f.bots.reconcileOnStartup()
  const a = f.bots.actions.forWork(t.workId)!
  await f.bots.actions.answer({ actionId: a.id, digest: a.args_digest, answer: 'send' })
  await flush()
  expect(t.calls).toEqual([t.args])
  expect(f.store.lastMainDispatch(t.workId)?.n).toBe(2)
})
it('an approved call whose binding changed is withdrawn on restart without retaining arguments', async () => {
  const t = await setup(true)
  await t.call()
  await finish(f, t.work.payload)
  const a = f.bots.actions.forWork(t.workId)!
  f.bots.actions.transition(a.id, 'open', 'approved')
  t.server.configDigest = 'edited'
  await f.bots.actions.reconcile()
  expect(f.bots.actions.forWork(t.workId)).toMatchObject({ status: 'withdrawn', exec_args: null })
  expect(t.calls).toEqual([])
})
it('provider transcript capture never journals executable secrets from a held call', async () => {
  const t = await setup(true)
  await t.call()
  const memory = new BotMemoryStore({ db: f.store.db })
  const ref = { botId: t.botId, activationId: t.workId, lane: 'run' as const, threadId: t.work.payload.threadId }
  const journal = createBotJournal({ store: memory, asksFirstEnabled: () => true, listThreads: () => [ref], readThread: () => ({ messages: [{
    id: 'provider-call', role: 'assistant', kind: 'tool_call', content: '', timestamp: f.store.now(),
    toolCall: { title: 'Mail__send', summary: '', details: [], toolName: 'Mail__send', input: t.args, status: 'complete', response: 'held' }
  }] }) })
  journal.syncNow(ref)
  const rows = f.store.all('SELECT text, json FROM bot_journal WHERE activation_id = ?', t.workId)
  expect(rows.length).toBeGreaterThan(0)
  expect(JSON.stringify(rows)).not.toContain('private-call-secret')
  expect(JSON.stringify(rows)).toContain('held back')
})
it('an ambiguous transport failure settles uncertain and never logs executable arguments', async () => {
  const t = await setup(true)
  await t.call()
  await finish(f, t.work.payload)
  const a = f.bots.actions.forWork(t.workId)!
  const logs: string[] = []
  const attempt = vi.spyOn(t.manager, 'callTool').mockRejectedValueOnce(new Error('private-call-secret'))
  setDiagSink((_level, line) => logs.push(line))
  try {
    await f.bots.actions.answer({ actionId: a.id, digest: a.args_digest, answer: 'send' })
    await flush()
  } finally { setDiagSink(null) }
  expect(attempt).toHaveBeenCalledTimes(1)
  expect(f.bots.actions.forWork(t.workId)).toMatchObject({ status: 'uncertain', exec_args: null })
  expect(f.store.lastMainDispatch(t.workId)?.prompt.text).toContain('check before trying again')
  expect(JSON.stringify(logs)).not.toContain('private-call-secret')
})

it.each(['held', 'stopped', 'switch_off'] as const)('R1 summaries and lists survive an %s action row', async state => {
  const t = await setup(true)
  await t.call()
  await finish(f, t.work.payload)
  if (state === 'stopped') await f.bots.service.workStop(t.botId, t.workId)
  if (state === 'switch_off') f.host.settings!.get().experimental.botAsksFirst = false
  const summary = f.bots.service.list().bots.find(b => b.id === t.botId)!
  expect(() => f.bots.service.get(t.botId)).not.toThrow()
  if (state === 'stopped') expect(summary.needsOwner).not.toBe(true)
  else expect(summary).toMatchObject({ needsOwner: true, stateText: 'Wants to send: Send this action?' })
})
it.each(['plain', 'note', 'permission'] as const)('R2 carries the action outcome beside %s continuation context', async context => {
  const t = await setup(true)
  await t.call()
  const a = f.bots.actions.forWork(t.workId)!
  await f.bots.actions.answer({ actionId: a.id, digest: a.args_digest, answer: 'send' })
  if (context === 'note') expect(f.bots.noteWork(t.botId, t.workId, 'Also record the delivery.')).toBe('noted')
  if (context === 'permission') {
    // A permission refused earlier in the work is now granted; use a starter permission to keep this fixture focused.
    ;(f.bots as unknown as { refused(id: string, permission: object): void }).refused(t.workId, { tool: 'web_fetch' })
  }
  await finish(f, t.work.payload)
  await flush()
  const prompt = f.store.lastMainDispatch(t.workId)!.prompt.text
  expect(prompt).toContain('Your owner sent it. The tool answered:')
  expect(prompt).toContain('delivered')
  expect(prompt).not.toContain('"text":')
  expect(prompt).not.toContain('The owner asked you to continue.')
  if (context === 'note') expect(prompt).toContain('Also record the delivery.')
  if (context === 'permission') expect(prompt).toContain('allowed')
})
it.each(['not_dispatched', 'tool_error', 'timeout', 'dropped'] as const)('R3 distinguishes a %s failure from an unconfirmed send', async kind => {
  const t = await setup(true)
  await t.call()
  await finish(f, t.work.payload)
  const a = f.bots.actions.forWork(t.workId)!
  if (kind === 'tool_error') vi.spyOn(t.manager, 'callTool').mockResolvedValueOnce({ content: [{ type: 'text', text: 'Recipient does not exist' }], isError: true } as never)
  else vi.spyOn(t.manager, 'callTool').mockRejectedValueOnce(Object.assign(new Error('failed'), { category: kind === 'timeout' ? 'timeout' : kind === 'not_dispatched' ? 'unreachable' : 'connection-lost', ...(kind === 'not_dispatched' ? { mcpNotDispatched: true } : {}) }))
  await f.bots.actions.answer({ actionId: a.id, digest: a.args_digest, answer: 'send' })
  await flush()
  const status = kind === 'tool_error' || kind === 'not_dispatched' ? 'failed' : 'uncertain'
  expect(f.bots.actions.forWork(t.workId)).toMatchObject({ status, exec_args: null })
  expect(f.store.message(a.message_id)?.text).toBe(status === 'failed' ? 'Not sent' : "Couldn't tell if it went through")
  if (kind === 'tool_error') expect(f.store.lastMainDispatch(t.workId)!.prompt.text).toContain('Recipient does not exist')
})
it('R4 a question after a settled action ends as a question, not an approval', async () => {
  const t = await setup(true)
  await t.call()
  await finish(f, t.work.payload)
  const a = f.bots.actions.forWork(t.workId)!
  await f.bots.actions.answer({ actionId: a.id, digest: a.args_digest, answer: 'send' })
  await flush()
  const next = await start(f, t.workId, 2)
  expect(f.bots.askOwner(t.botId, t.workId, { question: 'Which next?', choices: [{ label: 'A' }, { label: 'B' }], other: true }).asked).toBe(true)
  const denied = next.prepared.authority.check({ kind: 'app', tool: 'web_fetch', args: {} })
  expect(JSON.stringify(denied)).not.toContain('call is held')
  expect(JSON.stringify(denied)).toContain('question')
  await finish(f, next.payload)
  expect(f.store.activation(t.workId)).toMatchObject({ status: 'blocked', endReason: 'question' })
})
it('R5-slot keeps the slot until the held runtime finishes', async () => {
  const t = await setup(true)
  await f.bots.activate({ botId: t.botId, input: 'Other one', clientRequestId: 'other1' })
  await f.bots.activate({ botId: t.botId, input: 'Other two', clientRequestId: 'other2' })
  await t.call()
  const next = await f.bots.activate({ botId: t.botId, input: 'Next', clientRequestId: 'next' })
  expect(f.store.activation(next.id)?.status).toBe('queued')
  await finish(f, t.work.payload)
  await flush()
  expect(f.store.activation(next.id)?.status).toBe('running')
})
