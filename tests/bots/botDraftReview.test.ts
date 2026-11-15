/** Review regressions: late text × Stop; restart × pause/wall; authority checks without a
 * runtime ledger; reply applet/card/picture; failure ordering. All observations are chat rows. */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { BotEngine } from '../../src/mms/bots/activation/BotEngine'
import { keepReplyCard } from '../../src/mms/bots/chat/replyCards'
import { keepToolImages } from '../../src/mms/bots/chat/toolImages'
import { botFixture, chatOf, createBot, finish, flush, start, T0, type BotFixture } from './botFixture'
let f: BotFixture
let botId: string
beforeEach(async () => { f = botFixture(); ({ botId } = await createBot(f, { reply: 'Hi.' })) })
afterEach(() => f.close())
const texts = (id: string) => chatOf(f, botId).filter(m => m.activationId === id && m.author === 'bot' && m.kind === 'text')
async function joined() {
  const first = await f.bots.service.chatSend({ botId, text: 'hi', clientRequestId: 'hi' })
  const id = first.message.activationId!
  const turn = await start(f, id)
  await f.bots.service.chatSend({ botId, text: 'check the flat', clientRequestId: 'flat' })
  return { id, first, ...turn }
}
it('Stop while final words are pending still posts the late reply to its original message', async () => {
  const one = await joined()
  f.runs.markTerminal(one.payload.runId, 'completed')
  f.bots.settle(one.payload, {})
  await flush()
  await f.bots.service.chatStop(botId)
  f.bots.settle(one.payload, { text: 'Hi! What can I do?' })
  await flush()
  expect(texts(one.id)).toHaveLength(1)
  expect(texts(one.id)[0]).toMatchObject({ text: 'Hi! What can I do?', replyTo: { id: one.first.message.id } })
})
it.each(['paused', 'waiting_grant'] as const)('restart preserves an unsent draft while its continuation is %s', async status => {
  const one = await joined()
  await finish(f, one.payload, 'completed', { text: 'Hi! What can I do?' })
  f.store.moveActivation(one.id, ['running'], status, { endReason: status === 'paused' ? 'unknown_calls' : 'wall' })
  f.bots.close()
  f.bots = new BotEngine(f.host)
  await f.bots.reconcileOnStartup()
  expect(texts(one.id)).toHaveLength(0)
  // The interrupted continuation is released with the same saved request.
  f.store.moveActivation(one.id, [f.store.activation(one.id)!.status], 'running', { endReason: null })
  await finish(f, (await start(f, one.id, f.store.lastMainDispatch(one.id)!.n)).payload, 'completed', { text: 'Hi — the flat is free.' })
  expect(texts(one.id).map(m => m.text)).toEqual(['Hi — the flat is free.'])
})
it.each(['read', 'edit'] as const)('Codex authority %s without a tool ledger decides whether to hold', async tool => {
  f.host.activity = undefined
  f.candidates = [{ instanceId: 'codex:test', model: 'test' }]
  const one = await joined()
  expect(one.prepared.authority.check({ kind: 'builtin', tool, nativeName: tool === 'edit' ? 'apply_patch' : 'read', args: { path: join(one.prepared.authority.workspace!.scratch, 'note.txt') } })).toMatchObject({ ok: true })
  expect(f.runs.tools.listForRun(one.payload.runId)).toEqual([])
  await finish(f, one.payload, 'completed', { text: 'Here is what I found.' })
  expect(texts(one.id)).toHaveLength(tool === 'read' ? 0 : 1)
})
it.each(['applet', 'card', 'picture', 'markdown-picture', 'picture-path'] as const)('a reply carrying a %s without a recorded tool is posted before continuing', async part => {
  const one = await joined()
  let text = 'Here is the result.'
  if (part === 'markdown-picture') text += '\n![Flat](file:///tmp/flat.png)'
  if (part === 'picture-path') text += '\n/tmp/flat.png'
  if (part === 'applet') text += '\n```mousse-applet\n'+JSON.stringify({schemaVersion:1,title:'Flat',description:'Availability',html:'<p>Free</p>',css:'',js:''})+'\n```'
  if (part === 'card') expect(keepReplyCard(one.id, { type: 'facts', title: 'Flat', rows: [{ label: 'Status', value: 'Free' }] })).toMatchObject({ kept: true })
  if (part === 'picture') expect(keepToolImages({ activationId: one.id, filesFolder: one.prepared.authority.workspace!.scratch, source: 'flat', images: [{ data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvXcAAAAASUVORK5CYII=' }] })).toBeTruthy()
  await finish(f, one.payload, 'completed', { text })
  expect(texts(one.id)).toHaveLength(1)
  if (part === 'card') expect(texts(one.id)[0]?.cards).toMatchObject([{ type: 'facts' }])
  if (part === 'picture') expect(texts(one.id)[0]?.attachments).toHaveLength(1)
  expect(f.store.dispatch(one.id, 2)?.prompt.text).toContain('already sent')
})
it('a failed continuation posts the held draft before its error in one transaction', async () => {
  const one = await joined()
  await finish(f, one.payload, 'completed', { text: 'Hi! What can I do?' })
  await finish(f, (await start(f, one.id, 2)).payload, 'failed', { outcome: { error: 'boom' } })
  const rows = chatOf(f, botId).filter(m => m.activationId === one.id && m.author === 'bot')
  expect(rows.map(m => m.kind)).toEqual(['text', 'error'])
  expect(rows[0]).toMatchObject({ text: 'Hi! What can I do?' })
})

it('a code example naming a picture remains an unsent draft', async () => {
  const one = await joined()
  await finish(f, one.payload, 'completed', { text: 'Example:\n```text\n![Flat](file:///tmp/flat.png)\n```' })
  expect(texts(one.id)).toHaveLength(0)
  expect(f.store.dispatch(one.id, 2)?.prompt.text).toContain('Your draft, not sent')
})

// A removed schedule ends in the run lane; its wall or request cap must leave the
// independently held chat draft intact, and the chat's later end must consume it.
it.each([
  ['removed schedule wall', 'reply'], ['removed schedule wall', 'stop'],
  ['removed schedule turn cap', 'reply'], ['removed schedule turn cap', 'stop'],
  ['chat turn cap', 'reply'], ['chat turn cap', 'stop']
] as const)('%s composes with a held chat draft ending by %s', async (path, end) => {
  await f.bots.reconcileOnStartup()
  const one = await joined()
  await finish(f, one.payload, 'completed', { text: 'Hi! What can I do?' })
  const draft = () => f.store.get('SELECT value FROM bot_memory_state WHERE bot_id = ? AND key = ?', botId, `draft:${one.id}`)
  expect(draft()).toBeDefined()
  let chatN = 2
  if (path === 'chat turn cap') {
    await finish(f, (await start(f, one.id, 2)).payload, 'failed', { text: 'Still checking.', outcome: { error: '[provider_turn_cap] Claude Code reached the most steps one turn may take.' } })
    chatN = f.store.lastMainDispatch(one.id)!.n
    expect(chatN).toBeGreaterThan(2)
  } else {
    const schedule = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Check price' }, 'owner')
    await f.tickSchedules(new Date(T0 + 5 * 60_000))
    const row = f.store.listActivations(botId).find(a => a.trigger.kind === 'schedule')!
    const run = await start(f, row.id)
    f.bots.removeSchedule(botId, schedule.scheduleId)
    if (path === 'removed schedule wall') {
      f.bots.raiseWall(row.id, { dispatchN: 1, kind: 'gate', permission: { tool: 'write' }, reason: 'Need write.' })
      await finish(f, run.payload, 'interrupted', { text: 'Checked the price.', outcome: { interruptedBy: 'bot_wall' } })
    } else {
      f.store.setLimits(row.id, { ...f.store.counters(row.id).limits, maxTurns: f.store.counters(row.id).requests })
      await finish(f, run.payload, 'failed', { text: 'Checked the price.', outcome: { error: '[provider_turn_cap] Claude Code reached the most steps one turn may take.' } })
    }
    expect(f.store.activation(row.id)?.status).toBe('done')
    const reports = chatOf(f, botId).filter(m => m.activationId === row.id)
    expect(reports.some(m => m.kind === 'run_report' && m.text.includes('Checked the price.'))).toBe(true)
    expect(reports.some(m => m.ask)).toBe(false)
    expect(f.store.get('SELECT value FROM bot_memory_state WHERE bot_id = ? AND key = ?', botId, `draft:${row.id}`)).toBeUndefined()
  }
  expect(draft()).toBeDefined()
  expect(texts(one.id)).toHaveLength(0)
  const continuation = await start(f, one.id, chatN)
  if (end === 'stop') {
    await f.bots.service.chatStop(botId)
    await finish(f, continuation.payload, 'interrupted', { outcome: { interruptedBy: 'user' } })
  } else await finish(f, continuation.payload, 'completed', { text: 'Hi — the flat is free.' })
  expect(texts(one.id).map(m => m.text)).toEqual([end === 'stop' ? 'Hi! What can I do?' : 'Hi — the flat is free.'])
  expect(draft()).toBeUndefined()
})
