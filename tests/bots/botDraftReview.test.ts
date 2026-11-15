/** Review regressions: late text × Stop; restart × pause/wall; authority checks without a
 * runtime ledger; reply applet/card/picture; failure ordering. All observations are chat rows. */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { BotEngine } from '../../src/mms/bots/activation/BotEngine'
import { keepReplyCard } from '../../src/mms/bots/chat/replyCards'
import { keepToolImages } from '../../src/mms/bots/chat/toolImages'
import { botFixture, chatOf, createBot, finish, flush, start, type BotFixture } from './botFixture'
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
