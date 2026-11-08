/**
 * bot-architecture.md §3.7: file access is one permission, asked once and kept. An older build's
 * open folder asks become the one file ask when bots open, and a bot that already holds a folder
 * holds file access. Each runtime compiles it to the whole file system but Mousse's own data:
 * Claude Code's sandbox, Codex's writable roots, and the gate's path check on Pi.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BotEngine } from '../../src/mms/bots/activation/BotEngine'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import { askFingerprintOf } from '../../src/mms/bots/chat/projection'
import { botFilesFolder, botManifestDigest, compileBotThread, entriesBeside, type BotPermissions } from '../../src/mms/bots/grants/compile'
import { claudeLockedSandbox } from '../../src/mms/harness/claude/locked'
import { PI_NATIVE_TOOLS } from '../../src/mms/harness/pi/nativeTools'
import { codexBotSandbox, codexTurnPolicy } from '../../src/mms/harness/vendors/codex/childPolicy'
import type { BotManifest } from '../../src/shared/bots/personal/definition'
import { filesAsk, type BotPermissionRequest } from '../../src/shared/bots/personal/escalation'
import { botStarterManifest } from '../../src/shared/bots/personal/manifest'
import { checkBuiltinCall } from '../../src/shared/bots/personal/walls'
import { botFixture, chatOf, createBot, finish, flush, start, type BotFixture } from './botFixture'

describe('asks an older build wrote for one folder', () => {
  let f: BotFixture
  let botId: string

  beforeEach(async () => {
    f = botFixture()
    botId = (await createBot(f, { name: 'Penny', reply: 'Hello.' })).botId
  })

  afterEach(() => f.close())

  /** An open ask as an older build wrote it: for one folder, with that folder in its card. */
  function olderAsk(id: string, activationId: string, path: string, access: 'read' | 'write', mode: 'ask' | 'wall' = 'ask'): void {
    const permission: BotPermissionRequest = { path, access }
    f.store.insertEscalation({
      id, botId, activationId, dispatchN: 1, toolCallId: null, kind: 'gate', permission, reason: 'r', createdAt: f.store.now(), expiresAt: null,
      mode, fingerprint: JSON.stringify({ access, path }), title: `${access === 'write' ? 'change' : 'read'} files in ${path}`, note: 'Only this folder.', messageId: null
    })
  }

  /** Mousse opens the profile again: the open asks are upgraded, then the startup pass runs. */
  async function reopen(): Promise<void> {
    f.bots.close()
    f.bots = new BotEngine(f.host)
    f.bots.upgradeFileAsks()
    await f.bots.reconcileOnStartup()
    await flush()
  }

  /** A chat turn that stops at a wall an older build wrote for `folder`. */
  async function walledChat(folder: string): Promise<string> {
    await f.bots.service.chatSend({ botId, text: 'Read my folder', clientRequestId: `m-${folder}` })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    f.clock.now += 1_000
    const { payload, prepared } = await start(f, activation.id)
    // Any wall will do: it is written back as an older build had it, for the folder.
    prepared.authority.check({ kind: 'builtin', tool: 'shell', nativeName: 'bash', args: { command: `ls ${folder}` } })
    await finish(f, payload, 'interrupted', { text: 'I need that folder.', outcome: { interruptedBy: 'bot_wall' } })
    const wall = f.store.openAsks(botId).find((ask) => ask.activationId === activation.id)!
    f.store.run('UPDATE bot_escalations SET permission_json = ?, fingerprint = ?, title = ? WHERE id = ?', JSON.stringify({ path: folder, access: 'read' }), JSON.stringify({ access: 'read', path: folder }), `read files in ${folder}`, wall.id)
    return activation.id
  }

  it('become the one file ask: the chat\'s wall keeps its card, the run\'s copies are withdrawn, and one Allow grants file access', async () => {
    const first = f.store.listActivations(botId)[0]!.id
    olderAsk('esc_a', first, join(f.base, 'Invoices'), 'read')
    olderAsk('esc_b', first, join(f.base, 'Notes'), 'write')
    const walled = await walledChat(join(f.base, 'Docs'))
    await reopen()
    const ask = filesAsk()
    expect(f.store.escalation('esc_a')).toMatchObject({ status: 'withdrawn' })
    expect(f.store.escalation('esc_b')).toMatchObject({ status: 'withdrawn' })
    const [wall] = f.store.openAsks(botId)
    expect(f.store.openAsks(botId)).toHaveLength(1)
    expect(wall).toMatchObject({ mode: 'wall', activationId: walled, permission: ask, fingerprint: askFingerprintOf(ask), title: 'use files on this computer', note: "Read and change any file or folder, except Mousse's own data." })
    // The card reads what Allow now grants.
    expect(chatOf(f, botId).filter((message) => message.ask?.status === 'open').map((message) => message.ask!.title)).toEqual(['use files on this computer'])
    expect(f.store.activation(walled)!.status).toBe('waiting_grant')
    await f.bots.service.answer(botId, wall!.id, 'allow')
    expect(f.store.activeGrant(botId)!.manifest.workspace).toEqual({ roots: [ask.path], access: 'write' })
    expect(f.store.openAsks(botId)).toEqual([])
    expect(f.store.dispatch(walled, 2)!.prompt.text).toBe('[Mousse] The owner allowed: use files on this computer. Continue.')
  })

  it('with no wall, the oldest run ask becomes the one file ask', async () => {
    const first = f.store.listActivations(botId)[0]!.id
    olderAsk('esc_a', first, join(f.base, 'Invoices'), 'read')
    f.clock.now += 1_000
    olderAsk('esc_b', first, join(f.base, 'Notes'), 'write')
    await reopen()
    expect(f.store.escalation('esc_a')).toMatchObject({ status: 'open', mode: 'ask', permission: filesAsk(), title: 'use files on this computer' })
    expect(f.store.escalation('esc_b')).toMatchObject({ status: 'withdrawn' })
  })

  it('a bot that already holds a folder holds file access: its open folder asks are settled, and a walled chat goes on', async () => {
    const granted = join(f.base, 'tool-results')
    mkdirSync(granted)
    // An older build's grant: one folder, read only (as the tool-results folder was allowed).
    f.bots.narrowGrant(botId, (manifest) => ({ ...manifest, workspace: { roots: [granted], access: 'read' } }))
    const before = f.store.activeGrant(botId)!
    const walled = await walledChat(join(f.base, 'Docs'))
    olderAsk('esc_run', f.store.listActivations(botId)[0]!.id, join(f.base, 'Notes'), 'write')
    await reopen()
    expect(f.store.escalation('esc_run')).toMatchObject({ status: 'allowed_bot', permission: filesAsk(), title: 'use files on this computer' })
    expect(f.store.openAsks(botId)).toEqual([])
    // Nothing was approved again: the stored grant is the one the owner approved.
    expect(f.store.activeGrant(botId)!.digest).toBe(before.digest)
    expect(f.store.dispatch(walled, 2)!.prompt.text).toBe('[Mousse] The owner allowed: use files on this computer. Continue.')
    const continued = await start(f, walled, 2)
    for (const path of [join(f.base, 'Docs', 'a.md'), join(f.base, 'Notes', 'b.md'), join(f.base, 'anything', 'c.txt')]) {
      expect(continued.prepared.authority.check({ kind: 'builtin', tool: 'read', nativeName: 'read', args: { path } })).toEqual({ ok: true })
      expect(continued.prepared.authority.check({ kind: 'builtin', tool: 'write', nativeName: 'write', args: { path } })).toEqual({ ok: true })
    }
    expect(f.bots.service.get(botId).permissions.map((item) => item.title)).toEqual(['use files on this computer'])
  })

  it('an ask in the current form is left as it is', async () => {
    const first = f.store.listActivations(botId)[0]!.id
    const ask = filesAsk()
    f.store.insertEscalation({ id: 'esc_now', botId, activationId: first, dispatchN: 1, toolCallId: null, kind: 'gate', permission: ask, reason: 'r', createdAt: f.store.now(), expiresAt: null, mode: 'ask', fingerprint: askFingerprintOf(ask), title: 'use files on this computer', note: 'n', messageId: null })
    await reopen()
    expect(f.store.escalation('esc_now')).toMatchObject({ status: 'open', note: 'n' })
  })
})

describe('each runtime compiles file access to the whole file system but Mousse\'s own data', () => {
  let base: string
  let mousse: string
  let profile: string
  let files: string
  let scratch: string

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bot-files-access-')))
    mousse = join(base, '.mousse')
    profile = join(mousse, 'profiles', 'p1')
    files = botFilesFolder(profile, 'bot-1')
    scratch = join(profile, 'bots', 'scratch', 'act-1')
    for (const dir of [files, scratch, join(profile, 'harness', 'claude_bots'), join(mousse, 'profiles', 'p2'), join(base, 'Documents')]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(mousse, 'auth.json'), '{}')
    writeFileSync(join(profile, 'bots', 'bots.db'), '')
  })

  afterEach(() => rmSync(base, { recursive: true, force: true }))

  function permissions(workspace: BotManifest['workspace'], tools: BotManifest['tools'] = ['read', 'list', 'search', 'edit', 'write', 'shell']): BotPermissions {
    const grant: BotManifest = { ...botStarterManifest(), tools, workspace }
    const compiled = compileBotThread({ grant, digest: botManifestDigest(grant), thread: {}, scratch, profileHome: profile, filesFolder: files, computer: [base], nativeNames: (names) => ({ ok: true, names: [...names] }), remaining: { deadlineMs: 60_000 } })
    if (!compiled.ok) throw new Error(compiled.error.message)
    return compiled.permissions
  }

  /** File access as Allow writes it. */
  const everywhere = (): BotManifest['workspace'] => ({ roots: [filesAsk().path], access: 'write' })

  const authorityOf = (granted: BotPermissions) => createBotAuthority({
    activationId: 'act-1', role: 'activation', permissions: granted, waiting: () => false,
    counters: { charge: () => ({ ok: true, count: 1 }) }, time: { deadline: () => 0, signal: new AbortController().signal }, spend: null
  })

  it('closes the Mousse home, every profile in it, but for the bot\'s files folder and scratch', () => {
    expect(permissions(everywhere()).workspace).toEqual({ roots: [base], access: 'write', writeRoots: [base], scratch, files, computer: { closed: mousse } })
    expect(permissions(null).workspace).toEqual({ roots: [], access: 'read', writeRoots: [], scratch, files })
  })

  it('entriesBeside: every entry on the way down but the ones kept', () => {
    expect(entriesBeside(mousse, [files, scratch]).sort()).toEqual([
      join(mousse, 'auth.json'),
      join(mousse, 'profiles', 'p2'),
      join(profile, 'bots', 'bots.db'),
      join(profile, 'harness')
    ].sort())
    expect(entriesBeside(base, [mousse])).toEqual([join(base, 'Documents')])
    expect(entriesBeside(mousse, [join(base, 'Documents')])).toEqual([mousse])
  })

  it('Claude Code: commands read and write the whole file system, Mousse\'s data closed but for the bot\'s own folders', () => {
    const granted = authorityOf(permissions(everywhere()))
    const sandbox = claudeLockedSandbox({ workspace: granted.workspace!, temps: ['/tmp'], home: base }) as unknown as { filesystem: Record<string, string[]> }
    expect(sandbox.filesystem.allowWrite).toEqual([base, files, scratch])
    expect(sandbox.filesystem.denyRead).toEqual([mousse])
    expect(sandbox.filesystem.allowRead).toEqual([files, scratch])
    expect(sandbox.filesystem.denyWrite.sort()).toEqual([join(mousse, 'auth.json'), join(mousse, 'profiles', 'p2'), join(profile, 'bots', 'bots.db'), join(profile, 'harness')].sort())
    // Without file access the home stays unreadable but for its own folders, and Claude Code's storage.
    const own = join(base, '.claude', 'projects', 'x')
    const without = claudeLockedSandbox({ workspace: authorityOf(permissions(null)).workspace!, temps: ['/tmp'], home: base, own: [own] }) as unknown as { filesystem: Record<string, string[]> }
    expect(without.filesystem).toMatchObject({ denyRead: [base], allowRead: [files, scratch, own], allowWrite: [files, scratch] })
  })

  it('Codex: writable roots cover everything beside Mousse\'s data, and the bot\'s own folders in it', () => {
    const sandbox = codexBotSandbox(authorityOf(permissions(everywhere())))
    expect(sandbox).toEqual({ shell: true, writableRoots: [join(base, 'Documents'), files, scratch] })
    expect(codexTurnPolicy('default', undefined, 'ask', sandbox).sandboxPolicy).toMatchObject({ type: 'workspaceWrite', writableRoots: [join(base, 'Documents'), files, scratch], networkAccess: false })
    expect(codexBotSandbox(authorityOf(permissions(null)))).toEqual({ shell: true, writableRoots: [files, scratch] })
    // On the real file system: never the kernel's own folders, never Mousse's data.
    const whole = codexBotSandbox({ tools: new Set(['shell'] as const), workspace: { roots: ['/'], access: 'write', scratch, files, computer: { closed: mousse } } })
    for (const kernel of ['/proc', '/sys', '/dev']) expect(whole.writableRoots).not.toContain(kernel)
    expect(whole.writableRoots).toContain(files)
  })

  it('Pi: the gate allows its file tools anywhere but Mousse\'s data, and never asks again', () => {
    const granted = authorityOf(permissions(everywhere(), ['read', 'list', 'search', 'edit', 'write']))
    for (const [name, args] of [['read', { path: join(base, 'Documents', 'a.md') }], ['write', { path: join(base, 'new', 'b.md'), content: 'x' }], ['edit', { path: join(base, 'Documents', 'a.md') }], ['grep', { pattern: 'x', path: base }], ['ls', { path: join(base, 'Documents') }]] as const)
      expect(checkBuiltinCall(granted, PI_NATIVE_TOOLS, name, args), name).toEqual({ ok: true })
    expect(checkBuiltinCall(granted, PI_NATIVE_TOOLS, 'read', { path: join(mousse, 'auth.json') })).toMatchObject({ ok: false, wall: { kind: 'closed' } })
    expect(checkBuiltinCall(granted, PI_NATIVE_TOOLS, 'write', { path: join(files, 'report.md'), content: 'x' })).toEqual({ ok: true })
  })
})
