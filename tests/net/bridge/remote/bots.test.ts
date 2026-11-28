/**
 * The owner's personal bots from a phone: the `bots.*` remote methods (exact params, files only staged or by their place
 * in the bot's files folder, plain refusals, no paths or instance ids in what they return) and the bots in the lists
 * stream.
 */
import { EventEmitter } from 'node:events'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NetError, newId } from '../../../../src/shared/net'
import type { RpcContext, RpcMethod } from '../../../../src/mms/net/contracts'
import { systemClock } from '../../../../src/mms/net/clock'
import { NetDatabase } from '../../../../src/mms/net/store/database'
import { SqliteNodePolicy } from '../../../../src/mms/net/store/nodePolicy'
import {
  botDeviceLimitFrom,
  REMOTE_BOT_METHODS,
  remoteBotMessage,
  remoteBotMethods,
  remoteBotSummary,
  validateRemoteBotParams,
  type RemoteBotMethod,
  type RemoteBotsPort
} from '../../../../src/mms/bridge/remote/RemoteBots'
import { MmsListsSource, type ListsServices } from '../../../../src/mms/bridge/remote/MmsListsSource'
import { BotStaging, stagedFileLost } from '../../../../src/mms/bridge/remote/botStaging'
import { looksLikeSvg, openInside } from '../../../../src/mms/bridge/remote/botFiles'
import { isSvgName } from '../../../../src/shared/bots/personal/remoteFiles'
import type { BotChatMessage, BotLaunchedThread, BotSummary } from '../../../../src/shared/bots/personal/chat'
import { qualifyId } from '../../../../src/shared/threadRef'
import type { PermissionMode } from '../../../../src/shared/permissionMode'
import { botFixture, chatOf, createBot, finish, start, type BotFixture } from '../../../bots/botFixture'
import { actionDigest } from '../../../../src/mms/bots/actions/BotActions'
import { aloneKey, argumentContract } from '../../../../src/mms/bots/actions/BotAlone'
import { botManifestDigest } from '../../../../src/mms/bots/grants/compile'
import { getDefaultSettings } from '../../../../src/shared/settings'
import { BotDeviceAccessStore } from '../../../../src/mms/bots/definitions/BotDeviceAccessStore'
import { BOT_FULL_TRUST_PERMISSION } from '../../../../src/shared/bots/personal/manifest'
import type { BotLevel } from '../../../../src/shared/net/local'

const at = '2026-11-07T09:00:00.000Z'
const BOT = 'bot-0123456789ab'
const ASK = 'esc_00000000-0000-0000-0000-000000000000'
const context = { caller: { node: 'n', user: 'u' } } as unknown as RpcContext

/** Calls a method the way the dispatcher does for a new execution: validate, authorize, authorizeNew, handle. */
async function call(methods: RpcMethod[], name: RemoteBotMethod, params: unknown, caller: RpcContext = context): Promise<unknown> {
  const method = methods.find((entry) => entry.method === name)!
  const valid = method.validate ? method.validate(params) : params
  method.authorize?.(valid, caller)
  method.authorizeNew?.(valid, caller)
  return method.handle(valid, caller)
}

async function refused(work: () => Promise<unknown>): Promise<NetError> {
  try {
    await work()
  } catch (error) {
    expect(error).toBeInstanceOf(NetError)
    return error as NetError
  }
  throw new Error('expected a refusal')
}

describe('bot method params', () => {
  const bad = (method: RemoteBotMethod, params: unknown) =>
    expect(() => validateRemoteBotParams(method, params)).toThrow(NetError)

  it('takes exactly the documented keys', () => {
    expect(validateRemoteBotParams('bots.chat.list', { botId: BOT, beforeSeq: 4, limit: 100 })).toBeTruthy()
    expect(validateRemoteBotParams('bots.chat.send', { botId: BOT, text: 'Hi', clientRequestId: 'r-1', replyTo: 'm1' })).toBeTruthy()
    expect(validateRemoteBotParams('bots.asks.answer', { botId: BOT, askId: ASK, answer: 'not_now' })).toBeTruthy()
    expect(validateRemoteBotParams('bots.work.stop', { botId: BOT, workId: 'act_00000000-0000-0000-0000-000000000000' })).toBeTruthy()
    expect(validateRemoteBotParams('bots.create', { look: { colour: 'teal', accessory: 'cap' }, description: 'Tidy notes', clientRequestId: 'c1' })).toBeTruthy()
    bad('bots.get', { botId: BOT, profileId: 'p' })
    bad('bots.get', { botId: '../etc' })
    bad('bots.chat.stop', {})
    bad('bots.chat.list', { botId: BOT, limit: 101 })
    bad('bots.chat.list', { botId: BOT, beforeSeq: 0 })
    bad('bots.chat.markRead', { botId: BOT, seq: -1 })
    bad('bots.asks.answer', { botId: BOT, askId: ASK, answer: 'allow_bot' })
    bad('bots.work.stop', { botId: BOT, workId: 'w1' })
    bad('bots.create', { look: { colour: 'teal', accessory: 'cap', model: 'x' }, description: 'Tidy', clientRequestId: 'c1' })
    bad('bots.create', { look: { colour: 'teal', accessory: 'cap' }, description: 'x'.repeat(501), clientRequestId: 'c1' })
    bad('bots.personal.pause', { botId: BOT, extra: true })
  })

  it('checks the About and image methods', () => {
    const REM = 'rem_00000000-0000-0000-0000-000000000000'
    expect(validateRemoteBotParams('bots.chat.attachment', { botId: BOT, messageId: 'm1', index: 0, offset: 40_960 })).toBeTruthy()
    bad('bots.chat.attachment', { botId: BOT, messageId: 'm1', index: 10 })
    bad('bots.chat.attachment', { botId: BOT, messageId: 'm1', index: 0, offset: -1 })
    bad('bots.chat.attachment', { botId: BOT, messageId: 'm1', index: 0, path: '/etc/passwd' })
    expect(validateRemoteBotParams('bots.chat.file', { botId: BOT, path: 'images/a b.png', offset: 40_960 })).toBeTruthy()
    expect(validateRemoteBotParams('bots.update', { botId: BOT, name: 'Pip' })).toBeTruthy()
    expect(validateRemoteBotParams('bots.reminders.cancel', { botId: BOT, reminderId: REM })).toBeTruthy()
    expect(validateRemoteBotParams('bots.schedules.remove', { botId: BOT, scheduleId: 'daily-1' })).toBeTruthy()
    expect(validateRemoteBotParams('bots.memory.forget', { botId: BOT, id: 'm12' })).toBeTruthy()
    expect(validateRemoteBotParams('bots.memory.edit', { botId: BOT, id: 'm12v2', text: 'Call me Sam.' })).toBeTruthy()
    // A file is named by its place inside the bot's files folder: never a way out of it.
    // Nor a name Windows reads as another: a stream (`:`), or a part ending in a dot or a space (`pic.svg.` is `pic.svg`).
    for (const path of ['../other/a.png', 'images/../../a.png', './a.png', '/etc/passwd', '~/a.png', 'C:/a.png', 'images\\a.png', 'images//a.png', '',
      'pic.png:secret', 'C:a.png', 'pic.svg.', 'pic.svg ', 'images./a.png', 'images /a.png'])
      bad('bots.chat.file', { botId: BOT, path })
    bad('bots.chat.file', { botId: BOT, path: 'a.png', offset: -1 })
    bad('bots.chat.file', { botId: BOT, path: 'a.png', messageId: 'm1' })
    bad('bots.memory.list', { botId: BOT, history: true })
    bad('bots.update', { botId: BOT })
    bad('bots.update', { botId: BOT, name: ' ' })
    bad('bots.update', { botId: BOT, look: { colour: 'teal' } })
    bad('bots.reminders.cancel', { botId: BOT, reminderId: 'r1' })
    bad('bots.schedules.remove', { botId: BOT, scheduleId: '../x' })
    bad('bots.permissions.revoke', { botId: BOT, permissionId: '' })
    bad('bots.memory.forget', { botId: BOT, id: 'all' })
    bad('bots.memory.edit', { botId: BOT, id: 'm12', text: ' ' })
    bad('bots.memory.edit', { botId: BOT, id: 'j3', text: 'Call me Sam.' })
  })

  it('takes staged files by their ids, and file parts of their size', () => {
    const STAGE = `bst_${'a'.repeat(32)}`
    expect(validateRemoteBotParams('bots.chat.send', { botId: BOT, text: '', clientRequestId: 'r1', staged: [STAGE] })).toBeTruthy()
    expect(validateRemoteBotParams('bots.stage', { botId: BOT, clientRequestId: 's1', offset: 0, dataB64: 'aGk=', name: 'a.png', size: 2 })).toBeTruthy()
    expect(validateRemoteBotParams('bots.stage', { botId: BOT, clientRequestId: 's2', offset: 2, dataB64: 'aGk=', stage: STAGE })).toBeTruthy()
    bad('bots.chat.send', { botId: BOT, text: '', clientRequestId: 'r1' })
    bad('bots.chat.send', { botId: BOT, text: 'Hi', clientRequestId: 'r1', staged: ['/a.png'] })
    bad('bots.chat.send', { botId: BOT, text: 'Hi', clientRequestId: 'r1', staged: [STAGE, STAGE] })
    bad('bots.chat.send', { botId: BOT, text: 'Hi', clientRequestId: 'r1', staged: Array.from({ length: 11 }, (_, index) => `bst_${String(index).padStart(32, '0')}`) })
    // A first part names the file and its size; a later one only the file it adds to.
    bad('bots.stage', { botId: BOT, clientRequestId: 's1', offset: 0, dataB64: 'aGk=' })
    bad('bots.stage', { botId: BOT, clientRequestId: 's1', offset: 2, dataB64: 'aGk=', name: 'a.png', size: 2 })
    bad('bots.stage', { botId: BOT, clientRequestId: 's1', offset: 2, dataB64: 'aGk=', stage: STAGE, name: 'a.png' })
    bad('bots.stage', { botId: BOT, clientRequestId: 's1', offset: 0, dataB64: 'aGk=', name: 'a.png', size: 25 * 1024 * 1024 + 1 })
    bad('bots.stage', { botId: BOT, clientRequestId: 's1', offset: 0, dataB64: 'not base64!', name: 'a.png', size: 2 })
    bad('bots.stage', { botId: BOT, clientRequestId: 's1', offset: 0, dataB64: 'A'.repeat(43_692), name: 'a.png', size: 32_769 })
    // Every part carries bytes, and a first part is no longer than the file it names: refused before the call is taken.
    bad('bots.stage', { botId: BOT, clientRequestId: 's1', offset: 0, dataB64: '', name: 'a.png', size: 2 })
    bad('bots.stage', { botId: BOT, clientRequestId: 's2', offset: 2, dataB64: '', stage: STAGE })
    bad('bots.stage', { botId: BOT, clientRequestId: 's1', offset: 0, dataB64: 'aGk=', name: 'a.png', size: 1 })
  })

  it('tells an SVG by its name as a file system keeps it, and by its bytes however they are written', () => {
    for (const name of ['a.svg', 'evil.svg.', 'EVIL.SVG ', 'a.svgz..', 'x.SvG. .']) expect(isSvgName(name)).toBe(true)
    for (const name of ['x.svg.png', 'svg', 'a.png.']) expect(isSvgName(name)).toBe(false)
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>'
    const utf16be = Buffer.from(svg, 'utf16le').swap16()
    const svgFiles: Array<[string, Buffer, boolean]> = [
      ['plain', Buffer.from(svg), true],
      ['UTF-8 mark', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(svg)]), true],
      ['UTF-16 LE mark', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(svg, 'utf16le')]), true],
      ['UTF-16 BE, no mark', utf16be, true],
      ['declaration, comment, doctype with its own declarations', Buffer.from(`<?xml version="1.0"?>\n<!--${'c'.repeat(5000)}-->\n<!DOCTYPE x [ <!ENTITY a "b>c"> ]>\n${svg}`), true],
      ['namespace prefix', Buffer.from('<x:svg xmlns:x="http://www.w3.org/2000/svg"/>'), true],
      ['SVG doctype', Buffer.from('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x"><g/>'), true],
      ['gzip', gzipSync(Buffer.from(svg)), true],
      ['start of a longer file, all white space', Buffer.alloc(64 * 1024, 0x20), false]
    ]
    for (const [label, bytes, whole] of svgFiles) expect([label, looksLikeSvg(bytes, whole)]).toEqual([label, true])
    const others: Array<[string, Buffer]> = [
      ['PNG', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(svg)])],
      ['PDF with an svg inside', Buffer.from(`%PDF-1.7\n${svg}`)],
      ['HTML with an inline svg', Buffer.from(`<!doctype html><html><body>${svg}</body></html>`)],
      ['Markdown starting with a comment', Buffer.from(`<!-- notes -->\n# Title\n${svg}`)],
      ['gzip of text', gzipSync(Buffer.from('hello, world'))],
      ['a whole file of white space', Buffer.from('   \n')]
    ]
    for (const [label, bytes] of others) expect([label, looksLikeSvg(bytes, true)]).toEqual([label, false])
  })

  it('refuses paths, an empty or oversized message and a bad request id', () => {
    bad('bots.chat.send', { botId: BOT, text: 'Hi', clientRequestId: 'r1', attachments: [{ name: 'a.txt', path: '/a.txt' }] })
    bad('bots.chat.send', { botId: BOT, text: '  ', clientRequestId: 'r1' })
    bad('bots.chat.send', { botId: BOT, text: 'é'.repeat(20_000), clientRequestId: 'r1' })
    bad('bots.chat.send', { botId: BOT, text: 'Hi', clientRequestId: 'has space' })
    bad('bots.chat.send', { botId: BOT, text: 'Hi' })
  })

  it('lists every method with its capability', () => {
    expect(REMOTE_BOT_METHODS).toMatchObject({
      'bots.chat.list': { capability: 'read', mutating: false },
      'bots.get': { capability: 'read', mutating: false },
      'bots.chat.send': { capability: 'chat', mutating: true },
      'bots.asks.answer': { capability: 'chat', mutating: true },
      'bots.questions.answer': { capability: 'chat', mutating: true },
      'bots.personal.pause': { capability: 'write', mutating: true },
      'bots.create': { capability: 'write', mutating: true }
    })
    const methods = remoteBotMethods({ bots: () => undefined })
    expect(methods.map((entry) => entry.method).sort()).toEqual(Object.keys(REMOTE_BOT_METHODS).sort())
    // A read's result (the chat, the model rows, the devices) is never kept in the request ledger.
    expect(methods.filter((entry) => entry.ephemeral).map((entry) => entry.method).sort()).toEqual(['bots.applets.get', 'bots.applets.state.get', 'bots.chat.attachment', 'bots.chat.file', 'bots.chat.list', 'bots.devices.get', 'bots.get', 'bots.memory.list', 'bots.model.choices', 'bots.model.get'])
    expect(REMOTE_BOT_METHODS).toMatchObject({
      'bots.chat.attachment': { capability: 'read', mutating: false },
      'bots.chat.file': { capability: 'read', mutating: false },
      'bots.stage': { capability: 'chat', mutating: true },
      // An applet a message shows: read there, and its state saved there.
      'bots.applets.get': { capability: 'read', mutating: false },
      'bots.applets.state.get': { capability: 'read', mutating: false },
      'bots.applets.state.save': { capability: 'chat', mutating: true },
      'bots.memory.list': { capability: 'read', mutating: false },
      'bots.update': { capability: 'write', mutating: true },
      'bots.reminders.cancel': { capability: 'write', mutating: true },
      'bots.schedules.remove': { capability: 'write', mutating: true },
      'bots.permissions.revoke': { capability: 'write', mutating: true },
      'bots.memory.forget': { capability: 'write', mutating: true },
      'bots.memory.edit': { capability: 'write', mutating: true }
    })
    // Setting a bot up from another computer: write rows, and the reads behind About.
    expect(REMOTE_BOT_METHODS).toMatchObject({
      'bots.delete': { capability: 'write', mutating: true },
      'bots.model.get': { capability: 'read', mutating: false },
      'bots.model.choices': { capability: 'read', mutating: false },
      'bots.model.setSlots': { capability: 'write', mutating: true },
      'bots.model.setImage': { capability: 'write', mutating: true },
      'bots.devices.get': { capability: 'read', mutating: false },
      'bots.devices.set': { capability: 'write', mutating: true }
    })
    // What stays on the bot's own computer: the old single model, memory export, a new schedule, and its own list.
    for (const name of ['bots.model.set', 'bots.memory.export', 'bots.schedules.add', 'bots.personal.list'])
      expect(Object.keys(REMOTE_BOT_METHODS)).not.toContain(name)
  })
})

describe('what a phone sees of a bot', () => {
  it('drops attachment paths and instance ids', () => {
    const message: BotChatMessage = {
      seq: 1, id: 'm1', at, author: 'owner', kind: 'error', text: 'x', chips: [],
      attachments: [{ name: 'list.txt', path: '/home/me/bots/files/list.txt' }],
      error: { text: 'Sign in again', action: { kind: 'sign_in', label: 'Sign in', instanceId: 'claude:bots' } }
    }
    const seen = remoteBotMessage(message, BOT)
    expect(seen.attachments).toEqual([{ name: 'list.txt', mime: 'text/plain' }])
    expect(remoteBotMessage({ ...message, attachments: [{ name: 'Shot.PNG', path: '/home/me/bots/files/Shot.PNG' }, { name: 'x.svg', path: '/x.svg' }] }, BOT).attachments)
      .toEqual([{ name: 'Shot.PNG', mime: 'image/png', image: true }, { name: 'x.svg', mime: 'application/octet-stream' }])
    // A file's place is named only in the folder of the bot whose chat it is: another bot's file is named by its name.
    const OTHER = 'bot-ba9876543210'
    const placed = { ...message, attachments: [{ name: 'a.png', path: `/home/me/bots/files/${BOT}/a.png` }, { name: 'b.png', path: `/home/me/bots/files/${OTHER}/b.png` }] }
    expect(remoteBotMessage(placed, BOT).attachments).toEqual([{ name: 'a.png', mime: 'image/png', image: true, path: 'a.png' }, { name: 'b.png', mime: 'image/png', image: true }])
    expect(seen.error).toEqual({ text: 'Sign in again', action: { kind: 'sign_in', label: 'Sign in' } })
    expect(JSON.stringify(seen)).not.toMatch(/home\/me|claude:bots/)
    const summary = { id: BOT, name: 'Penny', error: { text: 'e', action: { kind: 'sign_in', label: 'Sign in', instanceId: 'claude:bots' } } } as BotSummary
    expect(remoteBotSummary(summary).error).toEqual({ text: 'e', action: { kind: 'sign_in', label: 'Sign in' } })
  })

  it("never carries a thread the bot started on a further computer, which that computer may not share with the device", () => {
    const thread = (threadId: string, title: string): BotLaunchedThread => ({ threadId, title, status: 'running', startedAt: at, updatedAt: at })
    const farNode = qualifyId(newId('node'), 'far')
    const summary = { id: BOT, name: 'Penny', state: 'working', stateText: 'Managing 2 threads: Here, Secret', threads: [thread('here', 'Here'), thread(farNode, 'Secret')] } as BotSummary
    const seen = remoteBotSummary(summary)
    expect(seen.threads?.map((listed) => listed.threadId)).toEqual(['here'])
    expect(seen.stateText).toBe('Managing Here')
    expect(JSON.stringify(seen)).not.toContain('Secret')
    // Only threads here: the summary goes as it is.
    expect(remoteBotSummary({ ...summary, threads: [thread('here', 'Here')], stateText: 'Managing Here' }).stateText).toBe('Managing Here')
  })

  it('a page fits one reply: the newest messages, the older ones on the next page', async () => {
    const messages = Array.from({ length: 10 }, (_, n): BotChatMessage => ({ seq: n + 1, id: `m${n + 1}`, at, author: 'bot', kind: 'text', text: 'x'.repeat(10_000), chips: [] }))
    const port = { get: () => ({}), chatList: () => ({ messages }) } as unknown as RemoteBotsPort
    const page = (await call(remoteBotMethods({ bots: () => port }), 'bots.chat.list', { botId: BOT })) as { messages: BotChatMessage[] }
    expect(page.messages.length).toBeGreaterThan(0)
    expect(page.messages.length).toBeLessThan(10)
    expect(page.messages.at(-1)!.seq).toBe(10)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(63 * 1024)
    // One message larger than a reply is cut.
    const huge = { get: () => ({}), chatList: () => ({ messages: [{ ...messages[0]!, text: 'y'.repeat(100_000) }] }) } as unknown as RemoteBotsPort
    const one = (await call(remoteBotMethods({ bots: () => huge }), 'bots.chat.list', { botId: BOT })) as { messages: BotChatMessage[] }
    expect(one.messages).toHaveLength(1)
    expect(one.messages[0]!.text).toMatch(/the rest is on the computer\)$/)
    expect(Buffer.byteLength(JSON.stringify(one))).toBeLessThan(63 * 1024)
  })

  it('without bots on the computer, every method refuses plainly', async () => {
    const methods = remoteBotMethods({ bots: () => undefined })
    const error = await refused(() => call(methods, 'bots.get', { botId: BOT }))
    expect(error.code).toBe('conflict')
  })
})

describe('bot methods on a real bot', () => {
  let f: BotFixture
  let botId: string
  let methods: RpcMethod[]
  beforeEach(async () => {
    f = botFixture()
    botId = (await createBot(f, { name: 'Penny', reply: 'Hello.' })).botId
    methods = remoteBotMethods({ bots: () => f.bots.service })
  })
  afterEach(() => f.close())

  it('chats: list, send (once per request id), mark read, and the bot detail', async () => {
    const sent = (await call(methods, 'bots.chat.send', { botId, text: 'Sort my notes', clientRequestId: 'phone-1' })) as { message: BotChatMessage }
    expect(sent.message).toMatchObject({ author: 'owner', text: 'Sort my notes' })
    await call(methods, 'bots.chat.send', { botId, text: 'Sort my notes', clientRequestId: 'phone-1' })
    const page = (await call(methods, 'bots.chat.list', { botId })) as { messages: BotChatMessage[] }
    expect(page.messages.filter((message) => message.text === 'Sort my notes')).toHaveLength(1)
    expect(page.messages).toEqual(chatOf(f, botId).map(remoteBotMessage))
    expect(await call(methods, 'bots.chat.markRead', { botId, seq: page.messages.at(-1)!.seq })).toEqual({})
    const detail = (await call(methods, 'bots.get', { botId })) as { summary: BotSummary }
    expect(detail.summary).toMatchObject({ id: botId, name: 'Penny', unread: 0 })
    expect(JSON.stringify(detail)).not.toMatch(/instanceId|some\/model/)
  })

  it('a device switches a permission off and restores it without another ask', async () => {
    const work = await f.bots.activate({ botId, input: 'Run', clientRequestId: 'switch-grant' })
    const turn = await start(f, work.id)
    turn.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'Run' })
    await finish(f, turn.payload, 'completed', { text: 'Asked.' })
    for (const ask of f.store.openAsks(botId)) await f.bots.service.answer(botId, ask.id, 'allow')
    const permissionId = f.bots.service.get(botId).permissions.find((item) => item.title === 'run commands')!.id
    await call(methods, 'bots.permissions.set', { botId, permissionId, enabled: false })
    expect(f.store.activeGrant(botId)!.manifest.tools).not.toContain('shell')
    await call(methods, 'bots.permissions.set', { botId, permissionId, enabled: true })
    expect(f.store.activeGrant(botId)!.manifest.tools).toContain('shell')
    expect(f.store.openAsks(botId)).toHaveLength(0)
  })

  it('only a Full access device can switch Use your threads on; any reachable device can switch it off', async () => {
    const work = await f.bots.activate({ botId, input: 'Threads', clientRequestId: 'threads-switch-grant' })
    const turn = await start(f, work.id)
    turn.prepared.authority.escalate!({ permission: { tool: 'threads' }, reason: 'Threads' })
    await finish(f, turn.payload, 'completed', { text: 'Asked.' })
    for (const ask of f.store.openAsks(botId)) await f.bots.service.answer(botId, ask.id, 'allow')
    const permissionId = f.bots.service.get(botId).permissions.find((item) => item.title === 'use your threads')!.id
    await call(methods, 'bots.permissions.set', { botId, permissionId, enabled: false })
    expect((await refused(() => call(methods, 'bots.permissions.set', { botId, permissionId, enabled: true }))).code).toBe('forbidden')
    expect(f.bots.service.get(botId).permissions.find((item) => item.id === permissionId)?.enabled).toBe(false)
    const full = remoteBotMethods({ bots: () => f.bots.service, deviceLimit: () => 'full' })
    await call(full, 'bots.permissions.set', { botId, permissionId, enabled: true })
    expect(f.bots.service.get(botId).permissions.find((item) => item.id === permissionId)?.enabled).toBe(true)
  })

  it('pauses, resumes and creates a bot', async () => {
    expect(await call(methods, 'bots.personal.pause', { botId })).toMatchObject({ bot: { id: botId, state: 'paused' } })
    expect(await call(methods, 'bots.personal.resume', { botId })).toMatchObject({ bot: { id: botId } })
    // A bot made from another device reaches that device, so the computer keeps its Devices and the caller is a real node.
    const dir = mkdtempSync(join(tmpdir(), 'bots-create-reach-'))
    const store = new BotDeviceAccessStore(dir)
    const maker = botFixture({ deviceAccess: store })
    try {
      const phone = { caller: { node: newId('node'), user: 'u' } } as unknown as RpcContext
      const making = remoteBotMethods({ bots: () => maker.bots.service })
      const params = { look: { colour: 'teal', accessory: 'cap' }, name: 'Notes', description: 'Tidy my notes', clientRequestId: 'phone-c1' }
      const made = (await call(making, 'bots.create', params, phone)) as { bot: BotSummary }
      expect(made.bot).toMatchObject({ name: 'Notes', description: 'Tidy my notes' })
      const again = (await call(making, 'bots.create', params, phone)) as { bot: BotSummary }
      expect(again.bot.id).toBe(made.bot.id)
    } finally {
      maker.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses an unknown bot before the call is admitted', async () => {
    const error = await refused(() => call(methods, 'bots.chat.stop', { botId: 'bot-ffffffffffff' }))
    expect(error.code).toBe('stream_unknown')
  })

  it('stopping work the bot does not have stops nothing', async () => {
    expect(await call(methods, 'bots.work.stop', { botId, workId: 'act_00000000-0000-0000-0000-000000000000' })).toEqual({ stopped: false })
  })

  it('answers a permission ask, and leaves memory export to the computer', async () => {
    await f.bots.service.chatSend({ botId, text: 'Export your memory', clientRequestId: 'm1' })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    const { payload, prepared } = await start(f, activation.id)
    prepared.authority.escalate!({ permission: { ask: 'export_memory' }, reason: 'You asked.' })
    await finish(f, payload, 'completed', { text: 'Pick a folder.' })
    const card = chatOf(f, botId).at(-1)!.ask!
    expect(card.kind).toBe('export_memory')
    const error = await refused(() => call(methods, 'bots.asks.answer', { botId, askId: card.askId, answer: 'allow' }))
    expect(error).toMatchObject({ code: 'forbidden', message: 'Answer this on the computer.' })
    expect(chatOf(f, botId).at(-1)!.ask!.status).toBe('open')
    // An ask that is not there is a plain refusal too.
    const missing = await refused(() => call(methods, 'bots.asks.answer', { botId, askId: ASK, answer: 'allow' }))
    expect(missing.code).toBe('stream_unknown')
  })

  it('a phone can remove one automation exception without widening a grant', async () => {
    f.host.settings = { get: getDefaultSettings } as never
    const binding = { identity: 'mail', configDigest: 'same', schemaDigest: 'same' }
    f.host.mcp = { binding: () => binding, servers: () => [], offered: () => [] } as never
    const schedule = f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Send digest' }, 'owner')
    const manifest = { ...f.store.activeGrant(botId)!.manifest, mcp: [{ serverId: 'mail', tool: 'send', level: 'asks_first' as const }] }
    f.store.approve(botId, botManifestDigest(manifest), manifest)
    const request = { scheduleId: schedule.scheduleId, serverId: 'mail', tool: 'send' }
    const key = aloneKey(request)
    const place = { to: 'inbox@example.test' }
    const entry = { ...request, place, placeDigest: actionDigest(place), binding, promptDigest: actionDigest('Send digest'),
      arguments: argumentContract({ ...place, body: 'A plain message' }, 'phone-test-key'), grantedAt: f.store.now(),
      title: '‘Send digest’ sends to Inbox in Mail without asking', askTitle: 'let ‘Send digest’ send to Inbox in Mail without asking' }
    f.store.run('INSERT INTO bot_memory_state(bot_id, key, value) VALUES(?, ?, ?)', botId, key, JSON.stringify(entry))
    expect(f.bots.service.get(botId).permissions.some(item => item.id === key)).toBe(true)
    const before = f.store.activeGrant(botId)!.digest
    await call(methods, 'bots.permissions.revoke', { botId, permissionId: key })
    expect(f.store.get('SELECT value FROM bot_memory_state WHERE bot_id = ? AND key = ?', botId, key)).toBeUndefined()
    expect(f.store.activeGrant(botId)!.digest).toBe(before)
  })

  it('refuses a let-alone answer on a phone without changing authority', async () => {
    await f.bots.service.chatSend({ botId, text: 'Ask', clientRequestId: 'alone' })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    const { payload, prepared } = await start(f, activation.id)
    prepared.authority.escalate!({ permission: { ask: 'export_memory' }, reason: 'Ask' })
    await finish(f, payload, 'completed', { text: 'Allow?' })
    const ask = f.store.openAsks(botId)[0]!
    f.store.run('UPDATE bot_escalations SET permission_json = ? WHERE id = ?', JSON.stringify({ ask: 'let_alone', scheduleId: 's', serverId: 'mail', tool: 'send' }), ask.id)
    const before = f.store.all('SELECT * FROM bot_memory_state')
    const error = await refused(() => call(methods, 'bots.asks.answer', { botId, askId: ask.id, answer: 'allow' }))
    expect(error).toMatchObject({ code: 'forbidden', message: 'Answer this on the computer.' })
    expect(f.store.escalation(ask.id)?.status).toBe('open')
    expect(f.store.all('SELECT * FROM bot_memory_state')).toEqual(before)
  })

  it('"use your threads" from a device: its message holds the turn to its own limit, and only a Full access device may Allow the card', async () => {
    let limit: PermissionMode = 'ask'
    methods = remoteBotMethods({ bots: () => f.bots.service, deviceLimit: (node) => (node === 'n' ? limit : 'full') })
    await call(methods, 'bots.chat.send', { botId, text: 'Start a thread to fix the login page', clientRequestId: 'phone-t1' })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    expect(f.bots.ownerTurn(activation.id)).toEqual({ limit: 'ask' })
    const { payload, prepared } = await start(f, activation.id)
    prepared.authority.escalate!({ permission: { tool: 'threads' }, reason: 'You asked me to start one.' })
    await finish(f, payload, 'completed', { text: 'May I?' })
    const card = chatOf(f, botId).at(-1)!.ask!
    const error = await refused(() => call(methods, 'bots.asks.answer', { botId, askId: card.askId, answer: 'allow' }))
    expect(error).toMatchObject({ code: 'forbidden', message: 'Allow this on the computer.' })
    expect(f.store.activeGrant(botId)!.manifest.appTools).not.toContain('threads')
    // A device whose own limit here is Full access may allow it.
    limit = 'full'
    const answered = (await call(methods, 'bots.asks.answer', { botId, askId: card.askId, answer: 'allow' })) as { message: BotChatMessage }
    expect(answered.message.ask).toMatchObject({ askId: card.askId, status: 'allowed' })
    expect(f.store.activeGrant(botId)!.manifest.appTools).toContain('threads')
  })

  it('"use your threads": a device with no limit on record is held to Accept edits, the device settings\' default, as the service wires it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bots-device-limit-'))
    const db = new NetDatabase({ profileDir: dir })
    try {
      const policy = new SqliteNodePolicy(db, systemClock)
      methods = remoteBotMethods({ bots: () => f.bots.service, deviceLimit: botDeviceLimitFrom(policy) })
      await call(methods, 'bots.chat.send', { botId, text: 'Start a thread', clientRequestId: 'phone-t3' })
      const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
      expect(f.bots.ownerTurn(activation.id)).toEqual({ limit: 'accept_edits' })
      // A device whose limit is on record is held to it.
      const phone = newId('node')
      policy.set(phone, { maxPermissionMode: 'ask' })
      expect(botDeviceLimitFrom(policy)(phone)).toBe('ask')
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('"use your threads": Not now works from any device, and with no device settings wired at all a device is held to Ask', async () => {
    methods = remoteBotMethods({ bots: () => f.bots.service })
    await call(methods, 'bots.chat.send', { botId, text: 'Start a thread', clientRequestId: 'phone-t2' })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    expect(f.bots.ownerTurn(activation.id)).toEqual({ limit: 'ask' })
    const { payload, prepared } = await start(f, activation.id)
    prepared.authority.escalate!({ permission: { tool: 'threads' }, reason: 'You asked.' })
    await finish(f, payload, 'completed', { text: 'May I?' })
    const card = chatOf(f, botId).at(-1)!.ask!
    expect((await refused(() => call(methods, 'bots.asks.answer', { botId, askId: card.askId, answer: 'allow' }))).code).toBe('forbidden')
    const answered = (await call(methods, 'bots.asks.answer', { botId, askId: card.askId, answer: 'not_now' })) as { message: BotChatMessage }
    expect(answered.message.ask).toMatchObject({ status: 'not_now' })
  })

  it('answers a question with a tap, as a message from that device, and refuses one answered elsewhere before anything is written', async () => {
    methods = remoteBotMethods({ bots: () => f.bots.service, deviceLimit: () => 'accept_edits' })
    await f.bots.service.chatSend({ botId, text: 'Find me a flat', clientRequestId: 'q-1' })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    const { payload } = await start(f, activation.id)
    expect(f.bots.tools.questions!.ask(botId, activation.id, [{ spec: { question: 'Which flat?', choices: [{ label: 'Flat A' }, { label: 'Flat B' }], other: true } }]).asked).toBe(true)
    await finish(f, payload, 'completed', { text: 'Two to pick from.' })
    const bubble = chatOf(f, botId).find((message) => message.question)!
    const questionId = bubble.question!.questionId
    const tapped = (await call(methods, 'bots.questions.answer', { botId, questionId, choice: 'Flat B', clientRequestId: 'phone-q1' })) as { message: BotChatMessage; question: BotChatMessage }
    expect(tapped.message).toMatchObject({ author: 'owner', text: 'Flat B', answers: { questionId, tapped: true } })
    expect(tapped.question.question).toMatchObject({ status: 'answered', answer: 'Flat B' })
    // Its turn is the device's message: held to the device's limit, and dropped if the device loses the bot.
    const turn = f.store.activation(tapped.message.activationId!)!
    expect(turn.trigger).toMatchObject({ kind: 'manual', owner: { limit: 'accept_edits', node: 'n' } })
    // Answered: another device's tap is refused plainly, and nothing more is written.
    const rows = chatOf(f, botId).length
    const error = await refused(() => call(methods, 'bots.questions.answer', { botId, questionId, choice: 'Flat A', clientRequestId: 'phone-q2' }))
    expect(error).toMatchObject({ code: 'conflict', message: 'This was already answered.' })
    expect(chatOf(f, botId)).toHaveLength(rows)
    const missing = await refused(() => call(methods, 'bots.questions.answer', { botId, questionId: 'q_00000000-0000-0000-0000-000000000000', choice: 'Flat A', clientRequestId: 'phone-q3' }))
    expect(missing.code).toBe('stream_unknown')
    expect(() => validateRemoteBotParams('bots.questions.answer', { botId, questionId, choice: 'x'.repeat(41), clientRequestId: 'r' })).toThrow(NetError)
    expect(() => validateRemoteBotParams('bots.questions.answer', { botId, questionId: 'nope', choice: 'Flat A', clientRequestId: 'r' })).toThrow(NetError)
  })

  it('the lists carry the bots, and push again when a bot changes', async () => {
    const services = {
      threads: Object.assign(new EventEmitter(), { listAllThreads: () => [] }),
      projects: { listProjects: () => [] },
      orchestrator: Object.assign(new EventEmitter(), { getTurnSnapshot: () => ({}) }),
      threadRuntimes: Object.assign(new EventEmitter(), { getActivitySnapshot: () => ({}) }),
      questions: new EventEmitter(),
      events: new EventEmitter(),
      platform: { chats: { snapshot: () => ({ chats: [] }), onChange: () => () => undefined } },
      personalBots: f.bots
    } as unknown as ListsServices
    const timeouts: Array<() => void> = []
    const timers = {
      setTimeout: (run: () => void) => timeouts.push(run),
      clearTimeout: () => undefined,
      setInterval: () => 0,
      clearInterval: () => undefined
    }
    const lists = new MmsListsSource(services, timers)
    expect(lists.snapshot().bots).toMatchObject([{ id: botId, name: 'Penny', state: 'idle', last: { text: 'Hello.', author: 'bot' } }])
    expect(new MmsListsSource({ ...services, personalBots: null } as ListsServices).snapshot().bots).toEqual([])
    let pushes = 0
    const stop = lists.watch(() => pushes++)
    f.bots.service.pause(botId)
    timeouts.splice(0).forEach((run) => run())
    expect(pushes).toBe(1)
    expect(lists.snapshot().bots[0]).toMatchObject({ state: 'paused' })
    // A live chip of the bot's working activation, cleared with null.
    await f.bots.service.resume(botId)
    await f.bots.service.chatSend({ botId, text: 'Look it up', clientRequestId: 'm3' })
    const working = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    timeouts.splice(0).forEach((run) => run())
    f.bots.publishActivity({ botId, activationId: working.id, chip: { icon: 'web', text: 'Searching', live: true } })
    timeouts.splice(0).forEach((run) => run())
    expect(lists.snapshot().bots[0]!.activity).toEqual({ icon: 'web', text: 'Searching', live: true })
    f.bots.publishActivity({ botId, activationId: working.id, chip: null })
    timeouts.splice(0).forEach((run) => run())
    expect(lists.snapshot().bots[0]!.activity).toBeUndefined()
    expect(pushes).toBeGreaterThanOrEqual(4)
    stop()
    expect(f.bots.events.listenerCount('activity')).toBe(0)
  })
})

describe('the bot level of the calling device', () => {
  const params: Record<RemoteBotMethod, unknown> = {
      'bots.get': { botId: BOT },
      'bots.chat.list': { botId: BOT },
      'bots.chat.attachment': { botId: BOT, messageId: 'm1', index: 0 },
      'bots.chat.file': { botId: BOT, path: 'a.png' },
      'bots.stage': { botId: BOT, clientRequestId: 's1', offset: 0, dataB64: 'aGk=', name: 'a.png', size: 2 },
      'bots.applets.get': { botId: BOT, messageId: 'm1', appletId: 'a1', revisionId: 'r1' },
      'bots.applets.state.get': { botId: BOT, messageId: 'm1', appletId: 'a1', revisionId: 'r1' },
      'bots.applets.state.save': { botId: BOT, messageId: 'm1', appletId: 'a1', revisionId: 'r1', state: { n: 1 } },
      'bots.memory.list': { botId: BOT },
      'bots.chat.send': { botId: BOT, text: 'Hi', clientRequestId: 'r1' },
      'bots.chat.stop': { botId: BOT },
      'bots.work.stop': { botId: BOT, workId: 'act_00000000-0000-0000-0000-000000000000' },
      'bots.chat.markRead': { botId: BOT, seq: 1 },
      'bots.asks.answer': { botId: BOT, askId: ASK, answer: 'allow' },
      'bots.actions.answer': { botId: BOT, actionId: 'action_1', digest: 'digest', answer: 'send' },
      'bots.questions.answer': { botId: BOT, questionId: 'q_00000000-0000-0000-0000-000000000000', choice: 'Yes', clientRequestId: 'r-q' },
      'bots.personal.pause': { botId: BOT },
      'bots.personal.resume': { botId: BOT },
      'bots.create': { look: { colour: 'teal', accessory: 'cap' }, description: 'Tidy', clientRequestId: 'c1' },
      'bots.update': { botId: BOT, name: 'Pip' },
      'bots.reminders.snooze': { botId: BOT, messageId: 'm1', choice: '10m' },
      'bots.reminders.cancel': { botId: BOT, reminderId: 'rem_00000000-0000-0000-0000-000000000000' },
      'bots.schedules.remove': { botId: BOT, scheduleId: 'daily' },
      'bots.permissions.set': { botId: BOT, permissionId: 'p1', enabled: false },
      'bots.permissions.revoke': { botId: BOT, permissionId: 'p1' },
      'bots.memory.forget': { botId: BOT, id: 'm1' },
      'bots.memory.edit': { botId: BOT, id: 'm1', text: 'Call me Sam.' },
      'bots.delete': { botId: BOT },
      'bots.model.get': { botId: BOT },
      'bots.model.choices': {},
      'bots.model.setSlots': { botId: BOT, oneWork: true },
      'bots.model.setImage': { botId: BOT, pick: null },
      'bots.devices.get': { botId: BOT },
      'bots.devices.set': { botId: BOT, access: { mode: 'this_computer' } }
  }
  const names = Object.keys(REMOTE_BOT_METHODS) as RemoteBotMethod[]
  /** The rows another device may call at Use; every other remote row needs Full. */
  const USE_ROWS = ['bots.get', 'bots.chat.list', 'bots.chat.attachment', 'bots.chat.file', 'bots.stage', 'bots.applets.get', 'bots.applets.state.get', 'bots.applets.state.save', 'bots.memory.list', 'bots.chat.send', 'bots.chat.stop', 'bots.work.stop', 'bots.chat.markRead', 'bots.questions.answer', 'bots.reminders.snooze', 'bots.actions.answer']
  /** Methods over a port that counts every read, for a device at `level`. */
  const counted = (level: BotLevel) => {
    const seen = { reads: 0 }
    const port = new Proxy({}, { get: () => () => { seen.reads++; return {} } }) as RemoteBotsPort
    return { seen, methods: remoteBotMethods({ bots: () => port, reach: { level: () => level, canReach: () => true } }) }
  }
  /** The gate's refusal of `name`, at every way in: a new call, its run, and its saved result's lookup. */
  const gateRefusals = async (methods: RpcMethod[], name: RemoteBotMethod): Promise<unknown[]> => {
    const method = methods.find((entry) => entry.method === name)!
    const reasons: unknown[] = []
    const reason = (error: unknown) => (error as NetError).details && ((error as NetError).details as { reason?: unknown }).reason
    await call(methods, name, params[name]).catch((error) => reasons.push(reason(error)))
    // The handler refuses too, for a call admitted just before the level went down.
    await Promise.resolve().then(() => method.handle(params[name], context)).catch((error) => reasons.push(reason(error)))
    try {
      method.authorizeResult!('exec-1', context.caller)
    } catch (error) {
      reasons.push(reason(error))
    }
    return reasons
  }

  it('Off: every method refuses before it reads anything', async () => {
    const { seen, methods } = counted('off')
    for (const name of names) {
      const error = await refused(() => call(methods, name, params[name]))
      expect(error).toMatchObject({ code: 'forbidden', details: { reason: 'bots_off' } })
      expect(await gateRefusals(methods, name), name).toEqual(['bots_off', 'bots_off', 'bots_off'])
    }
    expect(seen.reads).toBe(0)
  })

  it('Use: chat, answers, stop and reading pass; every other row refuses with its own reason before it reads anything', async () => {
    const { seen, methods } = counted('use')
    for (const name of names.filter((item) => !USE_ROWS.includes(item))) {
      const error = await refused(() => call(methods, name, params[name]))
      expect(error, name).toMatchObject({ code: 'forbidden', details: { reason: 'bots_full_needed' } })
      expect(await gateRefusals(methods, name), name).toEqual(['bots_full_needed', 'bots_full_needed', 'bots_full_needed'])
    }
    expect(seen.reads).toBe(0)
    for (const name of USE_ROWS as RemoteBotMethod[]) {
      // Past the gate the fake port answers nonsense, so a call may still fail, but never on the device's level.
      for (const reason of await gateRefusals(methods, name)) expect(String(reason), name).not.toMatch(/^bots_/)
    }
    expect(seen.reads).toBeGreaterThan(0)
  })

  it('Full: no row is refused for the level', async () => {
    const { methods } = counted('full')
    for (const name of names) for (const reason of await gateRefusals(methods, name)) expect(String(reason), name).not.toMatch(/^bots_/)
  })

  it('reads the level on every call, so a lowered level applies to the next request', async () => {
    let level: BotLevel = 'full'
    const port = new Proxy({}, { get: () => () => ({}) }) as RemoteBotsPort
    const methods = remoteBotMethods({ bots: () => port, reach: { level: () => level, canReach: () => true } })
    const pause = methods.find((entry) => entry.method === 'bots.personal.pause')!
    pause.authorize!(params['bots.personal.pause'], context)
    level = 'use'
    await expect(Promise.resolve().then(() => pause.handle(params['bots.personal.pause'], context))).rejects.toMatchObject({ details: { reason: 'bots_full_needed' } })
  })
})

describe('Full bot access never widens thread access', () => {
  let f: BotFixture
  let botId: string
  beforeEach(async () => {
    f = botFixture()
    botId = (await createBot(f, { name: 'Penny', reply: 'Hello.' })).botId
  })
  afterEach(() => f.close())
  const at = (level: BotLevel, limit: PermissionMode) =>
    remoteBotMethods({ bots: () => f.bots.service, deviceLimit: () => limit, reach: { level: () => level, canReach: () => true } })

  it('a Full device whose thread ceiling is below Full access sets the bot up, but cannot turn on Allow everything', async () => {
    const methods = at('full', 'accept_edits')
    expect(await call(methods, 'bots.update', { botId, name: 'Pip' })).toMatchObject({ bot: { name: 'Pip' } })
    expect(await call(methods, 'bots.personal.pause', { botId })).toMatchObject({ bot: { state: 'paused' } })
    const error = await refused(() => call(methods, 'bots.permissions.set', { botId, permissionId: BOT_FULL_TRUST_PERMISSION, enabled: true }))
    expect(error).toMatchObject({ code: 'forbidden', message: 'Allow this on the computer.' })
    expect(f.bots.service.get(botId).fullTrust).not.toBe(true)
    // With a Full access ceiling it may, and turning it off needs no ceiling.
    await call(at('full', 'full'), 'bots.permissions.set', { botId, permissionId: BOT_FULL_TRUST_PERMISSION, enabled: true })
    expect(f.bots.service.get(botId).fullTrust).toBe(true)
    await call(methods, 'bots.permissions.set', { botId, permissionId: BOT_FULL_TRUST_PERMISSION, enabled: false })
    expect(f.bots.service.get(botId).fullTrust).toBe(false)
    // A Use device cannot, whatever its ceiling.
    const use = await refused(() => call(at('use', 'full'), 'bots.permissions.set', { botId, permissionId: BOT_FULL_TRUST_PERMISSION, enabled: true }))
    expect(use).toMatchObject({ code: 'forbidden', details: { reason: 'bots_full_needed' } })
  })

  it('a Full device whose thread ceiling is below Full access cannot Allow "use your threads"; a Use device answers no ask', async () => {
    await f.bots.service.chatSend({ botId, text: 'Start a thread', clientRequestId: 'ceiling-1' })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    const { payload, prepared } = await start(f, activation.id)
    prepared.authority.escalate!({ permission: { tool: 'threads' }, reason: 'You asked me to start one.' })
    await finish(f, payload, 'completed', { text: 'May I?' })
    const card = chatOf(f, botId).at(-1)!.ask!
    const allow = { botId, askId: card.askId, answer: 'allow' }
    expect(await refused(() => call(at('full', 'auto'), 'bots.asks.answer', allow))).toMatchObject({ code: 'forbidden', message: 'Allow this on the computer.' })
    expect(await refused(() => call(at('use', 'full'), 'bots.asks.answer', allow))).toMatchObject({ details: { reason: 'bots_full_needed' } })
    expect(f.store.activeGrant(botId)!.manifest.appTools).not.toContain('threads')
    const answered = (await call(at('full', 'full'), 'bots.asks.answer', allow)) as { message: BotChatMessage }
    expect(answered.message.ask).toMatchObject({ askId: card.askId, status: 'allowed' })
  })
})

describe('files and About from another device', () => {
  let f: BotFixture
  let botId: string
  let methods: RpcMethod[]
  let dir: string
  beforeEach(async () => {
    f = botFixture()
    botId = (await createBot(f, { name: 'Penny', reply: 'Hello.' })).botId
    methods = remoteBotMethods({ bots: () => f.bots.service })
    dir = mkdtempSync(join(tmpdir(), 'remote-bot-files-'))
  })
  afterEach(() => {
    f.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const png = (size: number): Buffer => {
    const data = Buffer.alloc(size, 7)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data)
    return data
  }
  const sendWith = async (files: Array<{ name: string; data: Buffer }>): Promise<BotChatMessage> => {
    const attachments = files.map((file) => {
      const path = join(dir, file.name)
      writeFileSync(path, file.data)
      return { name: file.name, path }
    })
    const { message } = await f.bots.service.chatSend({ botId, text: 'Look', attachments, clientRequestId: `img-${files.length}-${files[0]!.name}` })
    return message
  }

  type FilePage = { name: string; mime: string; size: number; offset: number; dataB64: string; image?: true }
  /** Reads a whole file of the bot's files folder the way another device does, a page at a time. */
  const readFile = async (path: string, from = methods, id = botId): Promise<{ first: FilePage; data: Buffer; pages: number }> => {
    const parts: Buffer[] = []
    let first: FilePage | undefined
    for (let offset = 0; ;) {
      const page = (await call(from, 'bots.chat.file', { botId: id, path, ...(offset ? { offset } : {}) })) as FilePage
      first ??= page
      expect(page.offset).toBe(offset)
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(63 * 1024)
      const bytes = Buffer.from(page.dataB64, 'base64')
      parts.push(bytes)
      offset += bytes.length
      if (offset >= page.size) break
    }
    return { first: first!, data: Buffer.concat(parts), pages: parts.length }
  }

  it('reads any file of the bot\'s files folder in pages, by its place there, never its path', async () => {
    const data = png(100 * 1024)
    const message = await sendWith([{ name: 'shot.png', data }, { name: 'notes.txt', data: Buffer.from('hi') }])
    const page = (await call(methods, 'bots.chat.list', { botId })) as { messages: Array<{ id: string; attachments?: Array<{ path?: string }> }> }
    const row = page.messages.find((entry) => entry.id === message.id)!
    expect(row.attachments).toEqual([
      { name: 'shot.png', mime: 'image/png', image: true, path: expect.stringMatching(/^attachments\/\d{4}-\d\d-\d\d\/shot\.png$/) },
      { name: 'notes.txt', mime: 'text/plain', path: expect.stringMatching(/^attachments\/\d{4}-\d\d-\d\d\/notes\.txt$/) }
    ])
    // Its place inside the folder, never where the folder or the owner's file is on this computer.
    expect(JSON.stringify(page)).not.toContain(dir)
    expect(JSON.stringify(page)).not.toContain(f.bots.service.filesFolderOf(botId))
    const picture = await readFile(row.attachments![0]!.path!)
    expect(picture.first).toMatchObject({ name: 'shot.png', mime: 'image/png', size: data.length, image: true })
    expect(picture.pages).toBe(3)
    expect(picture.data.equals(data)).toBe(true)
    // Any file, not only pictures.
    const notes = await readFile(row.attachments![1]!.path!)
    expect(notes.first).toMatchObject({ name: 'notes.txt', mime: 'text/plain', size: 2 })
    expect(notes.first.image).toBeUndefined()
    expect(notes.data.toString()).toBe('hi')
  })

  // `bots.chat.attachment` stays for the phone app until it moves to `bots.chat.file` (#2023).
  it('reads an image of the chat in parts by its message and place among its files, never its path', async () => {
    const data = png(100 * 1024)
    const message = await sendWith([{ name: 'shot.png', data }, { name: 'notes.txt', data: Buffer.from('hi') }])
    const page = (await call(methods, 'bots.chat.list', { botId })) as { messages: Array<{ id: string; attachments?: unknown }> }
    expect(JSON.stringify(page)).not.toContain(dir)
    const parts: Buffer[] = []
    for (let offset = 0; ;) {
      const part = (await call(methods, 'bots.chat.attachment', { botId, messageId: message.id, index: 0, offset })) as { name: string; mime: string; size: number; offset: number; dataB64: string }
      expect(part).toMatchObject({ name: 'shot.png', mime: 'image/png', size: data.length, offset })
      expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThan(63 * 1024)
      const bytes = Buffer.from(part.dataB64, 'base64')
      parts.push(bytes)
      offset += bytes.length
      if (offset >= part.size) break
    }
    expect(parts.length).toBe(3)
    expect(Buffer.concat(parts).equals(data)).toBe(true)
    // A file that is not an image, and a file past the list, are refused.
    expect((await refused(() => call(methods, 'bots.chat.attachment', { botId, messageId: message.id, index: 1 }))).code).toBe('conflict')
    expect((await refused(() => call(methods, 'bots.chat.attachment', { botId, messageId: message.id, index: 2 }))).code).toBe('stream_unknown')
    expect((await refused(() => call(methods, 'bots.chat.attachment', { botId, messageId: 'nope', index: 0 }))).code).toBe('stream_unknown')
  })

  it('refuses an image by message that is too large, not what its name says, or outside the bot\'s files', async () => {
    const big = await sendWith([{ name: 'big.png', data: png(1536 * 1024 + 1) }])
    expect((await refused(() => call(methods, 'bots.chat.attachment', { botId, messageId: big.id, index: 0 }))).code).toBe('too_large')
    const fake = await sendWith([{ name: 'fake.png', data: Buffer.from('<svg onload="x()"/>') }])
    expect((await refused(() => call(methods, 'bots.chat.attachment', { botId, messageId: fake.id, index: 0 }))).code).toBe('conflict')
    // A row that names a file anywhere else (it never does) is not read.
    const outside = join(dir, 'outside.png')
    writeFileSync(outside, png(100))
    f.store.run('UPDATE bot_messages SET attachments_json = ? WHERE id = ?', JSON.stringify([{ name: 'outside.png', path: outside }]), fake.id)
    expect((await refused(() => call(methods, 'bots.chat.attachment', { botId, messageId: fake.id, index: 0 }))).code).toBe('stream_unknown')
  })

  it('refuses a way out of the folder, a link out of it, another bot\'s file, an SVG and a file over the limit', async () => {
    const folder = f.bots.service.filesFolderOf(botId)
    mkdirSync(folder, { recursive: true })
    const outside = join(dir, 'outside.png')
    writeFileSync(outside, png(100))
    const code = async (path: string): Promise<string> => (await refused(() => call(methods, 'bots.chat.file', { botId, path }))).code
    // A path that climbs out or starts anywhere else is refused as it comes.
    expect(await code('../outside.png')).toBe('bad_request')
    expect(await code(outside)).toBe('bad_request')
    // A link in the folder to a file or a folder outside it is not followed out.
    symlinkSync(outside, join(folder, 'link.png'))
    symlinkSync(dir, join(folder, 'away'))
    expect(await code('link.png')).toBe('stream_unknown')
    expect(await code('away/outside.png')).toBe('stream_unknown')
    // Another bot's file is not this bot's, whatever its place.
    const other = (await createBot(f, { name: 'Otto', reply: 'Hi.' })).botId
    const theirs = f.bots.service.filesFolderOf(other)
    mkdirSync(theirs, { recursive: true })
    writeFileSync(join(theirs, 'secret.png'), png(100))
    expect(await code('secret.png')).toBe('stream_unknown')
    expect(await code(`../${other}/secret.png`)).toBe('bad_request')
    expect((await readFile('secret.png', methods, other)).first.name).toBe('secret.png')
    // An SVG never goes, by its name or by its first bytes.
    writeFileSync(join(folder, 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    writeFileSync(join(folder, 'fake.png'), '<svg onload="x()"/>')
    expect(await refused(() => call(methods, 'bots.chat.file', { botId, path: 'pic.svg' }))).toMatchObject({ code: 'conflict', details: { reason: 'svg' } })
    expect(await refused(() => call(methods, 'bots.chat.file', { botId, path: 'fake.png' }))).toMatchObject({ code: 'conflict', details: { reason: 'svg' } })
    // Over 25 MiB is refused before anything is read.
    const big = join(folder, 'big.bin')
    writeFileSync(big, '')
    truncateSync(big, 25 * 1024 * 1024 + 1)
    expect(await code('big.bin')).toBe('too_large')
    expect(await code('gone.png')).toBe('stream_unknown')
  })

  it('reads no file that has another name (a hard link, which can be outside), by its place or by its message', async () => {
    const folder = f.bots.service.filesFolderOf(botId)
    mkdirSync(folder, { recursive: true })
    const outside = join(dir, 'secret.png')
    writeFileSync(outside, png(100))
    linkSync(outside, join(folder, 'hard.png'))
    expect(await refused(() => call(methods, 'bots.chat.file', { botId, path: 'hard.png' }))).toMatchObject({ code: 'conflict', details: { reason: 'linked' } })
    // The phone's read by message refuses it too.
    const message = await sendWith([{ name: 'ok.png', data: png(100) }])
    const copy = f.bots.service.attachmentFile(botId, message.id, 0).path
    rmSync(copy)
    linkSync(outside, copy)
    expect(await refused(() => call(methods, 'bots.chat.attachment', { botId, messageId: message.id, index: 0 }))).toMatchObject({ code: 'conflict', details: { reason: 'linked' } })
  })

  it('opens a checked file only while it is that file: a link put at its name since is not followed', async () => {
    // As `openInside` compares it: the native form (a Windows temp folder can be named in its short 8.3 form).
    const root = realpathSync.native(dir)
    const away = mkdtempSync(join(tmpdir(), 'remote-bot-outside-'))
    const outside = join(away, 'secret.png')
    writeFileSync(outside, png(100))
    writeFileSync(join(root, 'other.png'), png(50))
    const checked = join(root, 'checked.png')
    const opens = async (): Promise<boolean> => {
      const opened = await openInside(root, checked)
      await opened?.handle.close()
      return Boolean(opened)
    }
    writeFileSync(checked, png(100))
    expect(await opens()).toBe(true)
    // Swapped for a link after the check, to a file out of the folder or to another inside it: neither is read.
    for (const target of [outside, join(root, 'other.png')]) {
      rmSync(checked)
      symlinkSync(target, checked)
      expect(await opens()).toBe(false)
    }
    rmSync(away, { recursive: true, force: true })
  })

  describe('files from another device', () => {
    const PHONE = { caller: { node: 'phone', user: 'u' } } as unknown as RpcContext
    const TABLET = { caller: { node: 'tablet', user: 'u' } } as unknown as RpcContext
    let staging: BotStaging
    let staged: RpcMethod[]
    beforeEach(() => {
      staging = new BotStaging({ folder: join(dir, 'staging'), limits: { callerFiles: 3, callerBytes: 200 * 1024 } })
      staged = remoteBotMethods({ bots: () => f.bots.service, staging })
    })
    afterEach(async () => {
      staging.close()
      await staging.settled()
    })

    /** Sends `data` a part at a time; answers its staged id. */
    const stage = async (data: Buffer, name = 'pic.png', caller = PHONE, id = botId): Promise<string> => {
      let stageId: string | undefined
      for (let offset = 0; offset < data.length;) {
        const part = data.subarray(offset, offset + 32 * 1024)
        const reply = (await call(staged, 'bots.stage', {
          botId: id, clientRequestId: `s-${offset}`, offset, dataB64: part.toString('base64'),
          ...(stageId ? { stage: stageId } : { name, size: data.length })
        }, caller)) as { stage: string; received: number }
        expect(reply.received).toBe(offset + part.length)
        stageId = reply.stage
        offset += part.length
      }
      return stageId!
    }

    it('a staged picture becomes the message\'s file in the bot\'s folder, read back the same', async () => {
      const data = png(70 * 1024)
      const id = await stage(data)
      expect(staging.count()).toBe(1)
      const { message } = (await call(staged, 'bots.chat.send', { botId, text: '', clientRequestId: 'with-pic', staged: [id] }, PHONE)) as { message: { attachments: Array<{ name: string; path: string; image?: true }> } }
      expect(message.attachments).toEqual([{ name: 'pic.png', mime: 'image/png', image: true, path: expect.stringMatching(/^attachments\/.+\/pic\.png$/) }])
      expect(readFileSync(join(f.bots.service.filesFolderOf(botId), message.attachments[0]!.path)).equals(data)).toBe(true)
      expect((await readFile(message.attachments[0]!.path, staged)).data.equals(data)).toBe(true)
      // Used once: the staged copy is gone, and naming it again is refused.
      expect(staging.count()).toBe(0)
      expect(await refused(() => call(staged, 'bots.chat.send', { botId, text: 'Again', clientRequestId: 'again', staged: [id] }, PHONE))).toMatchObject({ code: 'stream_unknown', details: { reason: 'stage_not_found' } })
    })

    it('refuses another device\'s or another bot\'s staged file, one not all there, and an SVG', async () => {
      const id = await stage(png(1000))
      const other = (await createBot(f, { name: 'Otto', reply: 'Hi.' })).botId
      // Neither the file nor that it exists reaches another device or another bot's message.
      expect(await refused(() => call(staged, 'bots.chat.send', { botId, text: 'Mine', clientRequestId: 't1', staged: [id] }, TABLET))).toMatchObject({ code: 'stream_unknown', details: { reason: 'stage_not_found' } })
      expect(await refused(() => call(staged, 'bots.chat.send', { botId: other, text: 'Mine', clientRequestId: 't2', staged: [id] }, PHONE))).toMatchObject({ code: 'stream_unknown', details: { reason: 'stage_not_found' } })
      expect(await refused(() => call(staged, 'bots.stage', { botId, clientRequestId: 't3', offset: 1000, dataB64: 'aGk=', stage: id }, TABLET))).toMatchObject({ code: 'stream_unknown' })
      // Refused before anything ran: the file is still the phone's, whole and unused.
      expect(staging.count('phone')).toBe(1)
      const half = (await call(staged, 'bots.stage', { botId, clientRequestId: 'h1', offset: 0, dataB64: png(10).toString('base64'), name: 'half.png', size: 20 }, PHONE)) as { stage: string }
      expect(await refused(() => call(staged, 'bots.chat.send', { botId, text: 'Half', clientRequestId: 't4', staged: [half.stage] }, PHONE))).toMatchObject({ code: 'conflict', details: { reason: 'stage_incomplete' } })
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
      // By its name as a file system keeps it (`evil.svg.` is saved as `evil.svg`), or by its bytes in UTF-16.
      for (const [name, data] of [['a.svg', png(10)], ['a.png', svg], ['evil.svg.', png(10)], ['notes.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(svg.toString(), 'utf16le')])]] as const) {
        expect(await refused(() => call(staged, 'bots.stage', { botId, clientRequestId: `svg-${name}`, offset: 0, dataB64: data.toString('base64'), name, size: data.length }, PHONE))).toMatchObject({ code: 'conflict', details: { reason: 'svg' } })
      }
      expect(staging.count('phone')).toBe(2)
    })

    it('holds a device to its share of files and bytes', async () => {
      // 200 KiB per device here: a file that would pass it is refused at its first part, before anything is kept.
      expect(await refused(() => call(staged, 'bots.stage', { botId, clientRequestId: 'big', offset: 0, dataB64: 'aGk=', name: 'big.png', size: 201 * 1024 }, PHONE))).toMatchObject({ code: 'conflict', details: { reason: 'stage_full' } })
      for (let index = 0; index < 3; index += 1) await stage(png(100), `p${index}.png`)
      expect(await refused(() => call(staged, 'bots.stage', { botId, clientRequestId: 'fourth', offset: 0, dataB64: 'aGk=', name: 'p4.png', size: 2 }, PHONE))).toMatchObject({ code: 'conflict', details: { reason: 'stage_full' } })
      // Another device has its own share.
      expect(await stage(png(100), 'q.png', TABLET)).toMatch(/^bst_/)
    })

    it('holds all devices together to the area\'s bytes', async () => {
      staging = new BotStaging({ folder: join(dir, 'staging'), limits: { callerBytes: 200 * 1024, totalBytes: 300 * 1024 } })
      staged = remoteBotMethods({ bots: () => f.bots.service, staging })
      await stage(png(150 * 1024), 'a.png', PHONE)
      await stage(png(100 * 1024), 'b.png', TABLET)
      // Within the tablet's own share, past what all devices may hold.
      expect(await refused(() => call(staged, 'bots.stage', { botId, clientRequestId: 'more', offset: 0, dataB64: 'aGk=', name: 'c.png', size: 60 * 1024 }, TABLET))).toMatchObject({ code: 'conflict', details: { reason: 'stage_full' } })
      expect(staging.count()).toBe(2)
    })

    it('drops a file unused for its hour, off the disk too', async () => {
      let now = 1_000_000
      staging = new BotStaging({ folder: join(dir, 'staging'), clock: { now: () => now }, limits: { ttlMs: 60_000 } })
      staged = remoteBotMethods({ bots: () => f.bots.service, staging })
      const id = await stage(png(100))
      now += 60_001
      expect(await refused(() => call(staged, 'bots.chat.send', { botId, text: 'Late', clientRequestId: 'late', staged: [id] }, PHONE))).toMatchObject({ code: 'stream_unknown', details: { reason: 'stage_not_found' } })
      expect(staging.count()).toBe(0)
      await staging.settled()
      expect(readdirSync(staging.area)).toEqual([])
    })

    it('looks at the whole file when its last part is in: an SVG behind a long comment is not kept', async () => {
      const data = Buffer.from(`<!--${'x'.repeat(40 * 1024)}--><svg xmlns="http://www.w3.org/2000/svg"/>`)
      const { stage: id } = await staging.begin('phone', botId, 'notes.txt', data.length, data.subarray(0, 32 * 1024))
      await expect(staging.append('phone', botId, id, 32 * 1024, data.subarray(32 * 1024))).rejects.toMatchObject({ code: 'conflict', details: { reason: 'svg' } })
      expect(staging.count()).toBe(0)
      await staging.settled()
      expect(readdirSync(staging.area)).toEqual([])
    })

    it('keeps nothing of a file a part of which fails', async () => {
      await expect(staging.begin('phone', botId, 'a.png', 10, png(20))).rejects.toMatchObject({ code: 'bad_request' })
      expect(staging.count()).toBe(0)
      const { stage: id } = await staging.begin('phone', botId, 'b.png', 200, png(100))
      await expect(staging.append('phone', botId, id, 50, png(50))).rejects.toMatchObject({ code: 'conflict', details: { reason: 'stage_offset' } })
      expect(staging.count()).toBe(0)
      await staging.settled()
      expect(readdirSync(staging.area)).toEqual([])
    })

    it('a part still being written when its file is dropped does not make the file again', async () => {
      const { stage: id } = await staging.begin('phone', botId, 'b.png', 200, png(100))
      const writing = staging.append('phone', botId, id, 100, png(100))
      expect(staging.dropWhere(() => true)).toBe(1)
      await expect(writing).rejects.toMatchObject({ code: 'stream_unknown', details: { reason: 'stage_not_found' } })
      await staging.settled()
      expect(readdirSync(staging.area)).toEqual([])
    })

    it('drops a device\'s files when it is blocked, leaves the account, no longer reaches the bot, or the bot goes', async () => {
      const OTHER = 'bot-ba9876543210'
      const lost = stagedFileLost({ bots: [botId], canReach: (_bot, node) => node !== 'far', blocked: (node) => node === 'bad', present: ['phone', 'bad', 'far'] })
      expect(lost(botId, 'phone')).toBe(false)
      expect([lost(botId, 'bad'), lost(botId, 'gone'), lost(botId, 'far'), lost(OTHER, 'phone')]).toEqual([true, true, true, true])
      // Without the account's devices known, only what is known drops a file.
      expect(stagedFileLost({ canReach: () => true, blocked: () => false })(botId, 'gone')).toBe(false)
      await stage(png(100))
      await stage(png(100), 'q.png', TABLET)
      expect(staging.dropWhere(stagedFileLost({ canReach: () => true, blocked: (node) => node === 'tablet' }))).toBe(1)
      expect(staging.count('tablet')).toBe(0)
      expect(staging.count('phone')).toBe(1)
    })

    it('leaves what earlier runs staged at the start, and tidies it in the background, never this run\'s files', async () => {
      const folder = join(dir, 'staging')
      mkdirSync(join(folder, 'run-old'), { recursive: true })
      writeFileSync(join(folder, 'run-old', 'bst_old'), 'x')
      writeFileSync(join(folder, 'loose'), 'x')
      const fresh = new BotStaging({ folder, limits: { tidyDelayMs: 60_000 } })
      const stop = fresh.start()
      expect(readdirSync(folder).sort()).toEqual(['loose', 'run-old'])
      await fresh.begin('phone', botId, 'p.png', 100, png(100))
      expect(await fresh.tidy()).toBe(2)
      expect(readdirSync(folder)).toEqual([basename(fresh.area)])
      expect(readdirSync(fresh.area)).toHaveLength(1)
      stop()
      fresh.close()
      await fresh.settled()
    })
  })

  it('renames a bot, lists its memory, and refuses to remove what it does not have before anything changes', async () => {
    expect(await call(methods, 'bots.update', { botId, name: 'Pip' })).toMatchObject({ bot: { id: botId, name: 'Pip' } })
    const memory = (await call(methods, 'bots.memory.list', { botId })) as { entries: unknown[]; gauge: string }
    expect(memory).toMatchObject({ entries: expect.any(Array), gauge: expect.any(String) })
    for (const [name, params] of [
      ['bots.reminders.cancel', { botId, reminderId: 'rem_00000000-0000-0000-0000-000000000000' }],
      ['bots.schedules.remove', { botId, scheduleId: 'nope' }],
      ['bots.permissions.revoke', { botId, permissionId: 'nope' }],
      ['bots.memory.forget', { botId, id: 'm999' }],
      ['bots.memory.edit', { botId, id: 'm999', text: 'Call me Sam.' }]
    ] as const) {
      const method = methods.find((entry) => entry.method === name)!
      // Refused by \`authorizeNew\`, before the dispatcher admits the call, so it is never an uncertain outcome.
      expect(() => method.authorizeNew!(params, context)).toThrow(NetError)
      expect((await refused(() => call(methods, name, params))).code).toBe('stream_unknown')
    }
  })
})

function fakeTimers(timeouts: Array<() => void>) {
  return {
    setTimeout: (run: () => void) => timeouts.push(run),
    clearTimeout: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined
  }
}

function listsServices(bots: unknown): ListsServices {
  return {
    threads: Object.assign(new EventEmitter(), { listAllThreads: () => [] }),
    projects: { listProjects: () => [] },
    orchestrator: Object.assign(new EventEmitter(), { getTurnSnapshot: () => ({}) }),
    threadRuntimes: Object.assign(new EventEmitter(), { getActivitySnapshot: () => ({}) }),
    questions: new EventEmitter(),
    events: new EventEmitter(),
    platform: { chats: { snapshot: () => ({ chats: [] }), onChange: () => () => undefined } },
    personalBots: bots
  } as unknown as ListsServices
}
