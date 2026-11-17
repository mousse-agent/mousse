/**
 * "Use files on this computer" was removed: a bot uses only its own files folder (and its scratch folder). Bots made
 * before keep running on the real `bots.db` shapes an older build wrote: a grant and a published revision holding
 * `workspace: { roots: ['C:\\'], access: 'write' }`, open and answered file asks, and a chat waiting at one. Nothing is
 * migrated: the stored grant keeps its digest, so nothing asks for approval again, and the stored folders open nothing.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BOT_FILE_ASK_GONE_TEXT, BotEngine } from '../../src/mms/bots/activation/BotEngine'
import { botFilesFolder, botManifestDigest } from '../../src/mms/bots/grants/compile'
import { localPathOf, type ThisComputer } from '../../src/mms/data/closedPlaces'
import type { BotManifest } from '../../src/shared/bots/personal/definition'
import { BOT_NO_FOLDER_ASK_TEXT, type BotPermissionRequest } from '../../src/shared/bots/personal/escalation'
import { botFixture, chatOf, createBot, finish, flush, start, type BotFixture } from './botFixture'

/** File access as an older build's Allow wrote it, on this computer's platform (the real profile's `C:\`). */
const OLD_FILES: NonNullable<BotManifest['workspace']> = { roots: [process.platform === 'win32' ? 'C:\\' : '/'], access: 'write' }
const OLD_FILES_ASK: BotPermissionRequest = { path: OLD_FILES.roots[0]!, access: 'write' }

describe('a bot an older build let use files on this computer', () => {
  let f: BotFixture
  let botId: string

  beforeEach(async () => {
    f = botFixture()
    botId = (await createBot(f, { name: 'Plusy', reply: 'Hello.' })).botId
  })

  afterEach(() => f.close())

  /**
   * What an older build's Allow did: a revision with file access published, and its grant approved. `revision` and
   * `grant` say which of the two hold it (an older build could leave them apart once a grant was narrowed).
   */
  function olderFileAccess(where: { revision: boolean; grant: boolean } = { revision: true, grant: true }): { digest: string; manifest: BotManifest } {
    const published = f.host.definitions.revision(botId, f.store.registry(botId)!.revision!)!
    const withFiles: BotManifest = { ...published.permissions, tools: [...published.permissions.tools, 'shell'], workspace: OLD_FILES }
    const revision = f.host.definitions.publishRevision({ ...published, permissions: where.revision ? withFiles : { ...withFiles, workspace: null } })
    const granted = where.grant ? withFiles : { ...withFiles, workspace: null }
    f.store.db.transaction(() => {
      f.store.setPublished(botId, revision.revision!)
      f.store.approve(botId, botManifestDigest(granted), granted)
    })
    return { digest: botManifestDigest(granted), manifest: granted }
  }

  /** An ask as an older build wrote it (the one file ask, or an earlier build's ask for one folder), with its card's words. */
  function olderAsk(id: string, activationId: string, mode: 'ask' | 'wall' = 'ask', status?: 'allowed_bot' | 'denied', permission: BotPermissionRequest = OLD_FILES_ASK): void {
    f.store.insertEscalation({
      id, botId, activationId, dispatchN: 1, toolCallId: null, kind: 'gate', permission, reason: 'r', createdAt: f.store.now(), expiresAt: null,
      mode, fingerprint: JSON.stringify(permission), title: 'use files on this computer', note: "Read and change any file or folder, except Mousse's own data.", messageId: null
    })
    if (status) f.store.answerEscalation(id, status)
  }

  /** Mousse opens the profile again, as `openBots` does, then the startup pass runs. */
  async function reopen(): Promise<void> {
    f.bots.close()
    f.bots = new BotEngine(f.host)
    f.bots.withdrawFileAsks()
    await f.bots.reconcileOnStartup()
    await flush()
  }

  /** A chat turn that stops at a wall, written back as an older build's file ask. */
  async function walledChat(): Promise<string> {
    await f.bots.service.chatSend({ botId, text: 'Read my Documents folder', clientRequestId: 'm-walled' })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    f.clock.now += 1_000
    const { payload, prepared } = await start(f, activation.id)
    prepared.authority.check({ kind: 'app', tool: 'browser_open', args: {} })
    await finish(f, payload, 'interrupted', { text: 'I need your files.', outcome: { interruptedBy: 'bot_wall' } })
    const wall = f.store.openAsks(botId).find((ask) => ask.activationId === activation.id)!
    f.store.run('UPDATE bot_escalations SET permission_json = ?, fingerprint = ?, title = ? WHERE id = ?', JSON.stringify(OLD_FILES_ASK), JSON.stringify(OLD_FILES_ASK), 'use files on this computer', wall.id)
    return activation.id
  }

  it('keeps its grant as approved (same digest, nothing to approve again), runs, and reaches only its own folders', async () => {
    const before = olderFileAccess()
    await reopen()
    // Nothing was migrated or approved again: the stored grant, with its folders, is the one the owner approved.
    expect(f.store.activeGrant(botId)).toMatchObject({ digest: before.digest, manifest: { workspace: OLD_FILES } })
    const detail = f.bots.service.get(botId)
    expect(detail.needsApproval ?? []).toEqual([])
    // About → Can use lists what it still gives, never file access.
    expect(detail.permissions.map((item) => item.title)).toEqual(['run commands'])
    await f.bots.service.chatSend({ botId, text: 'What is in my Documents?', clientRequestId: 'm-1' })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    expect(activation.grantDigest).toBe(before.digest)
    const { prepared } = await start(f, activation.id)
    const files = botFilesFolder(f.profile, botId)
    mkdirSync(files, { recursive: true })
    writeFileSync(join(files, 'notes.md'), 'x')
    const outside = join(f.base, 'Documents', 'a.md')
    expect(prepared.authority.workspace).toMatchObject({ roots: [files], writeRoots: [files], files })
    expect(prepared.authority.check({ kind: 'builtin', tool: 'read', nativeName: 'read', args: { path: join(files, 'notes.md') } })).toEqual({ ok: true })
    expect(prepared.authority.check({ kind: 'builtin', tool: 'write', nativeName: 'write', args: { path: join(files, 'report.md') } })).toEqual({ ok: true })
    // Outside its folders: refused, and nobody is asked (there is nothing left to allow).
    for (const tool of ['read', 'write'] as const)
      expect(prepared.authority.check({ kind: 'builtin', tool, nativeName: tool, args: { path: outside } })).toMatchObject({ ok: false, wall: { kind: 'path' } })
    expect(f.store.openAsks(botId)).toEqual([])
  })

  it('a published revision that still names folders is not held back, whether or not the grant names them', async () => {
    olderFileAccess({ revision: true, grant: false })
    await reopen()
    expect(f.bots.service.get(botId).needsApproval ?? []).toEqual([])
    await f.bots.service.chatSend({ botId, text: 'Hi', clientRequestId: 'm-2' })
    expect(f.store.laneActivations(botId, 'chat', ['running'])).toHaveLength(1)
  })

  it('escalate for a folder is refused with no card', async () => {
    olderFileAccess()
    await f.bots.service.chatSend({ botId, text: 'Read C:\\Users', clientRequestId: 'm-3' })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    const { prepared } = await start(f, activation.id)
    expect(prepared.authority.escalate!({ permission: { path: join(f.base, 'Documents'), access: 'read' }, reason: 'To read it.' })).toContain(BOT_NO_FOLDER_ASK_TEXT)
    expect(f.store.openAsks(botId)).toEqual([])
  })

  it('an open file ask is withdrawn when bots open: its card stays as history, a chat waiting at it stops waiting, and Allow gives nothing', async () => {
    const before = olderFileAccess({ revision: false, grant: false })
    const first = f.store.listActivations(botId)[0]!.id
    // An earlier build asked for one folder at a time.
    olderAsk('esc_run', first, 'ask', undefined, { path: join(f.base, 'Invoices'), access: 'read' })
    const walled = await walledChat()
    // Allowing it before bots open again is refused and changes nothing.
    await expect(f.bots.service.answer(botId, 'esc_run', 'allow')).rejects.toThrow(BOT_FILE_ASK_GONE_TEXT)
    const wall = f.store.openAsks(botId).find((ask) => ask.activationId === walled)!
    await expect(f.bots.respond({ escalationId: wall.id, answer: 'allow_bot' })).rejects.toThrow(BOT_FILE_ASK_GONE_TEXT)
    expect(f.store.activeGrant(botId)!.digest).toBe(before.digest)
    await reopen()
    expect(f.store.escalation('esc_run')).toMatchObject({ status: 'withdrawn' })
    expect(f.store.escalation(wall.id)).toMatchObject({ status: 'withdrawn' })
    expect(f.store.openAsks(botId)).toEqual([])
    // The chat keeps the card, worded as it was, no longer open.
    const cards = chatOf(f, botId).filter((message) => message.ask?.title === 'use files on this computer').map((message) => message.ask!.status)
    expect(cards.length).toBeGreaterThan(0)
    expect(cards).not.toContain('open')
    // The chat no longer waits at it: the owner decides how it goes on.
    expect(f.store.activation(walled)!.status).not.toBe('waiting_grant')
    expect(f.store.activeGrant(botId)!.digest).toBe(before.digest)
    // Answering it now changes nothing either.
    await expect(f.bots.service.answer(botId, 'esc_run', 'allow')).rejects.toThrow()
    expect(f.store.activeGrant(botId)!.digest).toBe(before.digest)
  })

  it('answered file asks stay as they were, and nothing is listed or asked for them', async () => {
    olderFileAccess()
    const first = f.store.listActivations(botId)[0]!.id
    olderAsk('esc_allowed', first, 'ask', 'allowed_bot')
    f.clock.now += 1_000
    olderAsk('esc_denied', first, 'ask', 'denied')
    await reopen()
    expect(f.store.escalation('esc_allowed')).toMatchObject({ status: 'allowed_bot', title: 'use files on this computer' })
    expect(f.store.escalation('esc_denied')).toMatchObject({ status: 'denied' })
    expect(f.bots.service.get(botId).permissions.map((item) => item.title)).toEqual(['run commands'])
  })

  it('Remove in About still takes away what the grant gives, and the bot keeps running without asking', async () => {
    olderFileAccess()
    const shell = f.bots.service.get(botId).permissions.find((item) => item.title === 'run commands')!
    f.bots.service.revokePermission(botId, shell.id)
    const after = f.store.activeGrant(botId)!
    expect(after.manifest.tools).not.toContain('shell')
    expect(f.bots.service.get(botId).permissions).toEqual([])
    expect(f.bots.service.get(botId).needsApproval ?? []).toEqual([])
    await f.bots.service.chatSend({ botId, text: 'Hi', clientRequestId: 'm-4' })
    expect(f.store.laneActivations(botId, 'chat', ['running'])).toHaveLength(1)
  })
})

describe('network paths to this computer', () => {
  // Every form a path to this computer over the network takes on Windows, and what the check makes of it: the local path
  // it means, refused when that can't be known, or an ordinary network file on another computer.
  const computer: ThisComputer = { names: ['localhost', 'owner-pc'], addresses: ['192.168.1.20', 'fe80::1c2b:3a4d:5e6f:7081'], windows: 'C:\\Windows' }
  it.each([
    ['a plain path', 'C:\\Users\\o\\a.txt', { kind: 'plain' }],
    ['localhost, drive share', '\\\\localhost\\C$\\Users\\o\\.mousse\\auth.json', { kind: 'local', path: 'C:\\Users\\o\\.mousse\\auth.json' }],
    ['forward slashes, lower-case share', '//LOCALHOST/c$/Users/o/.mousse', { kind: 'local', path: 'C:\\Users\\o\\.mousse' }],
    ['a final dot on the name', '\\\\localhost.\\C$\\x', { kind: 'local', path: 'C:\\x' }],
    ['127.0.0.1', '\\\\127.0.0.1\\D$\\data', { kind: 'local', path: 'D:\\data' }],
    ['another loopback address', '\\\\127.8.9.10\\C$\\x', { kind: 'local', path: 'C:\\x' }],
    ['0.0.0.0', '\\\\0.0.0.0\\C$\\x', { kind: 'local', path: 'C:\\x' }],
    ['[::1]', '\\\\[::1]\\C$\\x', { kind: 'local', path: 'C:\\x' }],
    ['::1 written out', '\\\\[0:0:0:0:0:0:0:1]\\C$\\x', { kind: 'local', path: 'C:\\x' }],
    ['IPv6 literal name', '\\\\0--1.ipv6-literal.net\\C$\\x', { kind: 'local', path: 'C:\\x' }],
    ['IPv4 carried in IPv6', '\\\\[::ffff:127.0.0.1]\\C$\\x', { kind: 'local', path: 'C:\\x' }],
    ['IPv4 carried in IPv6, as hex', '\\\\[::ffff:7f00:1]\\C$\\x', { kind: 'local', path: 'C:\\x' }],
    ['the computer\'s name', '\\\\OWNER-PC\\C$\\x', { kind: 'local', path: 'C:\\x' }],
    ['its name with a domain', '\\\\owner-pc.corp.example\\C$\\x', { kind: 'local', path: 'C:\\x' }],
    ['its own address', '\\\\192.168.1.20\\C$\\x', { kind: 'local', path: 'C:\\x' }],
    ['its own address carried in IPv6', '\\\\[::ffff:192.168.1.20]\\C$\\x', { kind: 'local', path: 'C:\\x' }],
    ['its own IPv6 address with a zone', '\\\\fe80--1c2b-3a4d-5e6f-7081s12.ipv6-literal.net\\C$\\x', { kind: 'local', path: 'C:\\x' }],
    ['ADMIN$', '\\\\localhost\\ADMIN$\\System32', { kind: 'local', path: 'C:\\Windows\\System32' }],
    ['\\\\?\\UNC\\', '\\\\?\\UNC\\localhost\\C$\\x', { kind: 'local', path: 'C:\\x' }],
    ['\\\\.\\UNC\\', '\\\\.\\UNC\\127.0.0.1\\C$\\x', { kind: 'local', path: 'C:\\x' }],
    ['a device path to a drive', '\\\\?\\C:\\x', { kind: 'local', path: 'C:\\x' }],
    ['a device path to a drive, dot form', '\\\\.\\C:\\x', { kind: 'local', path: 'C:\\x' }],
    ['an ordinary share on this computer', '\\\\localhost\\Shared\\x', { kind: 'refused' }],
    ['127.1', '\\\\127.1\\C$\\x', { kind: 'refused' }],
    ['a decimal address', '\\\\2130706433\\C$\\x', { kind: 'refused' }],
    ['a hex address', '\\\\0x7f.0.0.1\\C$\\x', { kind: 'refused' }],
    ['an octal address', '\\\\0177.0.0.1\\C$\\x', { kind: 'refused' }],
    ['another device path', '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume3\\x', { kind: 'refused' }],
    ['a volume path', '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\x', { kind: 'refused' }],
    ['no share', '\\\\localhost', { kind: 'refused' }],
    ['another computer', '\\\\nas\\photos\\a.jpg', { kind: 'remote' }],
    ['another computer by address', '\\\\192.168.1.30\\photos\\a.jpg', { kind: 'remote' }],
    ['another computer, \\\\?\\UNC\\', '\\\\?\\UNC\\nas\\photos\\a.jpg', { kind: 'remote' }]
  ] as const)('localPathOf: %s', (_name, path, expected) => {
    expect(localPathOf(path, computer)).toEqual(expected)
  })

  it('localPathOf: a host it doesn\'t know as this computer is refused when the path is on one of this computer\'s volumes (a name that points back to it)', () => {
    const seen: string[] = []
    const ownVolume = (path: string) => (seen.push(path), path.startsWith('\\\\self-alias\\'))
    expect(localPathOf('\\\\self-alias\\C$\\Users\\o\\.mousse', { ...computer, ownVolume })).toEqual({ kind: 'refused' })
    expect(localPathOf('\\\\nas\\photos\\a.jpg', { ...computer, ownVolume })).toEqual({ kind: 'remote' })
    expect(seen).toEqual(['\\\\self-alias\\C$\\Users\\o\\.mousse', '\\\\nas\\photos\\a.jpg'])
  })

})
