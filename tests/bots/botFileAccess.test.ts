/**
 * bot-architecture.md §3.7: file access is one permission, asked once and kept. An older build's
 * open folder asks become the one file ask when bots open, and a bot that already holds a folder
 * holds file access. Each runtime compiles it to the whole file system but Mousse's own data:
 * Claude Code's sandbox, Codex's writable roots, and the gate's path check on Pi.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BotEngine } from '../../src/mms/bots/activation/BotEngine'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import { askFingerprintOf } from '../../src/mms/bots/chat/projection'
import { botFilesFolder, botManifestDigest, compileBotThread, entriesBeside, type BotPermissions } from '../../src/mms/bots/grants/compile'
import { claudeLockedOptions, claudeLockedSandbox, type ClaudeLockedTurn } from '../../src/mms/harness/claude/locked'
import { botClosedPlaces, ClosedPlacesUnknown, CLAUDE_COMMAND_WRITE_LIMIT_TEXT, closedBeside, linuxCommandLayout, localPathOf, onLocalVolume, type ThisComputer } from '../../src/mms/data/closedPlaces'
import { PI_NATIVE_TOOLS } from '../../src/mms/harness/pi/nativeTools'
import { CODEX_BOT_PROFILE, codexBotInstructionsNote, codexBotSandbox, codexBotSandboxConfig, codexTurnPolicy } from '../../src/mms/harness/vendors/codex/childPolicy'
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

  it('closes the Mousse home, every profile in it, but for the bot\'s files folder and scratch, and every other place botClosedPlaces lists', () => {
    const compiled = permissions(everywhere()).workspace!
    expect(compiled).toEqual({ roots: [base], access: 'write', writeRoots: [base], scratch, files, computer: { closed: mousse, outside: expect.any(Array) } })
    // Compiled from this process's environment: the test setup's own CLI homes and Electron user data.
    expect(compiled.computer!.outside).toEqual(expect.arrayContaining([process.env.MOUSSE_ELECTRON_USER_DATA, join(process.env.CODEX_HOME!, 'auth.json'), join(process.env.CLAUDE_CONFIG_DIR!, '.credentials.json')]))
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

  /** The owner's home of this test, with the places closed to bots in it and ordinary files beside them. */
  function ownerHome() {
    const user = join(base, 'user')
    const at = {
      user,
      electron: join(user, '.config', 'mousse'),
      cookies: join(user, '.config', 'mousse', 'Partitions', 'mousse-browser', 'Cookies'),
      otherBot: join(mousse, 'browser', 'user-data', 'p1', 'workspaces', 'botbrowser_other', 'Cookies'),
      codexAuth: join(user, '.codex', 'auth.json'),
      codexConfig: join(user, '.codex', 'config.toml'),
      claudeCredentials: join(user, '.claude', '.credentials.json'),
      claudeSettings: join(user, '.claude', 'settings.json'),
      claudeJson: join(user, '.claude.json'),
      temp: join(base, 'tmp'),
      ordinary: join(base, 'Documents', 'a.md')
    }
    for (const file of [at.cookies, at.otherBot, at.codexAuth, at.codexConfig, at.claudeCredentials, at.claudeSettings, at.claudeJson, at.ordinary]) {
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, 'x\n')
    }
    for (const dir of [join(at.temp, 'mousse-pr-1'), join(at.temp, 'other')]) mkdirSync(dir, { recursive: true })
    const outside = botClosedPlaces({ mousseHome: mousse, env: { MOUSSE_ELECTRON_USER_DATA: at.electron }, userHome: user, temps: [at.temp], entryEnvs: [] })
    return { at, outside }
  }

  /** A bot with file access whose closed places are this test's (as compile makes them for the computer it runs on). */
  function withOutside(granted: BotPermissions, outside: string[]): BotPermissions {
    return { ...granted, workspace: { ...granted.workspace!, computer: { closed: mousse, outside } } }
  }

  // What `botClosedPlaces` lists, by the inputs that move it: the platform's defaults, every variable that moves a CLI's
  // home or Mousse's Electron user data, an entry's own variables, a relative value, a place inside the Mousse home.
  it.each([
    ['Linux defaults', 'linux', {}, [], ['.config/mousse', '.codex/auth.json', '.codex/.credentials.json', '.claude/.credentials.json', '.claude/.device-keys.json', '.claude/.session_ingress_token', '.claude/.config.json', '.claude/.config.json.backup', '.claude/backups', '.claude.json', '.claude.json.backup', '.config/anthropic', '.grok/auth.json'], ['.codex', '.codex/config.toml', '.claude', '.claude/settings.json', '.config', '.grok', '.grok/config.toml']],
    ['macOS defaults', 'darwin', {}, [], ['Library/Application Support/mousse', '.codex/auth.json', '.claude/.credentials.json', '.config/anthropic'], ['Library/Application Support']],
    ['Windows defaults', 'win32', {}, [], ['AppData/Roaming/mousse', '.codex/auth.json', '.claude/.credentials.json', 'AppData/Roaming/Anthropic'], ['AppData/Roaming']],
    ['moved homes', 'linux', { CODEX_HOME: '<x>/codex', CLAUDE_CONFIG_DIR: '<x>/claude', CLAUDE_SECURESTORAGE_CONFIG_DIR: '<x>/secure', ANTHROPIC_CONFIG_DIR: '<x>/anthropic', CLAUDE_CODE_FEDERATION_CACHE_DIR: '<x>/federation', MOUSSE_ELECTRON_USER_DATA: '<x>/eud', GROK_HOME: '<x>/grok' }, [], ['<x>/codex/auth.json', '<x>/codex/.credentials.json', '.codex/auth.json', '<x>/claude/.credentials.json', '<x>/claude/.claude.json', '<x>/claude/.config.json', '<x>/claude/backups', '<x>/secure/.credentials.json', '<x>/anthropic', '<x>/federation', '<x>/eud', '.claude/.credentials.json', '<x>/grok/auth.json', '.grok/auth.json'], ['<x>/claude', '<x>/codex', '<x>/grok', '.config/mousse']],
    ['an entry\'s own variables', 'linux', {}, [{ CODEX_HOME: '<x>/entry-codex', CLAUDE_CONFIG_DIR: '<x>/entry-claude', GROK_HOME: '<x>/entry-grok' }], ['<x>/entry-codex/auth.json', '<x>/entry-claude/.credentials.json', '<x>/entry-claude/.config.json', '<x>/entry-grok/auth.json'], []],
    ['a place inside the Mousse home is not listed again', 'linux', { MOUSSE_ELECTRON_USER_DATA: '<mousse>/electron-user-data' }, [], [], ['<mousse>/electron-user-data']]
  ] as const)('botClosedPlaces: %s', (_name, platform, env, entryEnvs, listed, notListed) => {
    const user = join(base, 'user')
    const x = join(base, 'x')
    const at = (spelled: string) => spelled.startsWith('<x>') ? join(x, spelled.slice(4)) : spelled.startsWith('<mousse>') ? join(mousse, spelled.slice(9)) : spelled.startsWith('relative') ? resolve(spelled) : join(user, spelled)
    const fill = (vars: Readonly<Record<string, string>>) => Object.fromEntries(Object.entries(vars).map(([key, value]) => [key, value.startsWith('relative') ? value : at(value)]))
    const places = botClosedPlaces({ mousseHome: mousse, env: fill(env), userHome: user, platform, temps: [], entryEnvs: entryEnvs.map(fill) })
    for (const place of listed) expect(places, place).toContain(at(place))
    for (const place of notListed) expect(places, place).not.toContain(at(place))
  })

  /** A profile's stored settings with these provider entries (Settings → Providers), as `mousse.conf` keeps them. */
  function storeEntries(profileHome: string, instances: Record<string, unknown>): void {
    mkdirSync(profileHome, { recursive: true })
    writeFileSync(join(profileHome, 'mousse.conf'), JSON.stringify({ providers: { instances } }))
  }

  it('compile closes the sign-ins of every Codex, Claude Code and Grok entry stored in the profile\'s settings, and in the other profiles\', whether it ran or not; an entry with a Mousse-owned home adds none', () => {
    const x = (name: string) => join(base, 'x', name)
    storeEntries(profile, {
      'codex:work': { driver: 'codex', enabled: true, config: { env: { CODEX_HOME: x('work-codex') } } },
      'claude:work': { driver: 'claude', enabled: false, config: { env: { CLAUDE_CONFIG_DIR: x('work-claude') } } },
      'grok:work': { driver: 'grok', config: { env: { GROK_HOME: x('work-grok') } } },
      'codex:private': { driver: 'codex', config: { home: 'private', env: { CODEX_HOME: x('private-codex') } } },
      'pi:other': { driver: 'pi', config: { env: { CODEX_HOME: x('pi-codex') } } }
    })
    storeEntries(join(mousse, 'profiles', 'p2'), { 'codex:p2': { driver: 'codex', config: { env: { CODEX_HOME: x('p2-codex') } } } })
    const outside = permissions(everywhere()).workspace!.computer!.outside!
    for (const place of [join(x('work-codex'), 'auth.json'), join(x('work-claude'), '.credentials.json'), join(x('work-claude'), '.claude.json'), join(x('work-grok'), 'auth.json'), join(x('p2-codex'), 'auth.json')]) expect(outside, place).toContain(place)
    for (const place of [join(x('private-codex'), 'auth.json'), join(x('pi-codex'), 'auth.json')]) expect(outside, place).not.toContain(place)
    // Any unreadable profile refuses file access rather than compiling an incomplete list.
    writeFileSync(join(mousse, 'profiles', 'p2', 'mousse.conf'), '{ not json')
    expect(() => permissions(everywhere())).toThrow('provider settings')
    writeFileSync(join(profile, 'mousse.conf'), '{ not json')
    const grant: BotManifest = { ...botStarterManifest(), tools: ['read', 'shell'], workspace: everywhere() }
    const compiled = compileBotThread({ grant, digest: botManifestDigest(grant), thread: {}, scratch, profileHome: profile, filesFolder: files, computer: [base], nativeNames: (names) => ({ ok: true, names: [...names] }), remaining: { deadlineMs: 60_000 } })
    expect(compiled).toMatchObject({ ok: false, error: { message: expect.stringContaining('provider settings') } })
    // Without file access, nothing to close: the turn runs.
    const without: BotManifest = { ...botStarterManifest(), tools: ['read', 'shell'], workspace: null }
    expect(compileBotThread({ grant: without, digest: botManifestDigest(without), thread: {}, scratch, profileHome: profile, filesFolder: files, computer: [base], nativeNames: (names) => ({ ok: true, names: [...names] }), remaining: { deadlineMs: 60_000 } }).ok).toBe(true)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('closedBeside: a folder on the way down that can\'t be listed is closed whole, the bot\'s folders in it included', () => {
    const bots = join(profile, 'bots')
    chmodSync(bots, 0o300)
    try {
      expect(closedBeside(mousse, [files, scratch])).toContain(bots)
    } finally {
      chmodSync(bots, 0o755)
    }
    expect(closedBeside(mousse, [files, scratch])).not.toContain(bots)
  })

  it.each(['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'ANTHROPIC_CONFIG_DIR', 'CLAUDE_CODE_FEDERATION_CACHE_DIR', 'GROK_HOME'])('a relative %s refuses an incomplete closed list', (key) => {
    expect(() => botClosedPlaces({ mousseHome: mousse, env: { [key]: 'relative/home' }, temps: [], entryEnvs: [] })).toThrow(ClosedPlacesUnknown)
  })

  it('includes stored CLI homes in a profile reached through a directory link', () => {
    const target = join(base, 'linked-profile')
    const cliHome = join(base, 'linked-codex')
    storeEntries(target, { 'codex:linked': { driver: 'codex', config: { env: { CODEX_HOME: cliHome } } } })
    symlinkSync(target, join(mousse, 'profiles', 'linked'), 'junction')
    expect(botClosedPlaces({ mousseHome: mousse, profileHome: profile, env: {}, temps: [] })).toContain(join(cliHome, 'auth.json'))
  })

  it('an unreadable temporary folder or corrupt sibling profile refuses an incomplete closed list', () => {
    const notFolder = join(base, 'not-a-folder')
    writeFileSync(notFolder, 'x')
    expect(() => botClosedPlaces({ mousseHome: mousse, temps: [notFolder], entryEnvs: [] })).toThrow(ClosedPlacesUnknown)
    const other = join(mousse, 'profiles', 'other')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'mousse.conf'), '{broken')
    expect(() => botClosedPlaces({ mousseHome: mousse, profileHome: profile, temps: [] })).toThrow(ClosedPlacesUnknown)
  })

  it.skipIf(process.platform !== 'win32')('file tools refuse alternate streams of closed files', () => {
    const { at, outside } = ownerHome()
    const granted = authorityOf(withOutside(permissions(everywhere()), outside))
    for (const suffix of [':stream', '::$DATA'])
      expect(checkBuiltinCall(granted, PI_NATIVE_TOOLS, 'read', { path: at.codexAuth + suffix }).ok).toBe(false)
  })

  it('the file tools, on every platform: each place closed to bots refused, directly and through a link; the files beside them open', () => {
    const { at, outside } = ownerHome()
    const granted = authorityOf(withOutside(permissions(everywhere()), outside))
    const closed = [at.cookies, at.otherBot, at.codexAuth, at.claudeCredentials, at.claudeJson, join(at.temp, 'mousse-pr-1', 'body.md')]
    for (const path of closed)
      for (const [name, args] of [['read', { path }], ['write', { path, content: 'x' }], ['edit', { path }]] as const)
        expect(checkBuiltinCall(granted, PI_NATIVE_TOOLS, name, args), `${name} ${path}`).toMatchObject({ ok: false, wall: { kind: 'closed' } })
    for (const path of [at.codexConfig, at.claudeSettings, at.ordinary, join(at.temp, 'other', 'x.md')])
      expect(checkBuiltinCall(granted, PI_NATIVE_TOOLS, 'read', { path }), path).toEqual({ ok: true })
    // A link to a folder (a junction on Windows) and, where this system lets a test make one, a link to a file.
    const folderLink = join(base, 'Documents', 'claude-link')
    symlinkSync(join(at.user, '.claude'), folderLink, 'junction')
    expect(checkBuiltinCall(granted, PI_NATIVE_TOOLS, 'read', { path: join(folderLink, '.credentials.json') })).toMatchObject({ ok: false, wall: { kind: 'closed' } })
    expect(checkBuiltinCall(granted, PI_NATIVE_TOOLS, 'read', { path: join(folderLink, 'settings.json') })).toEqual({ ok: true })
    const fileLink = join(base, 'Documents', 'cookie-link')
    let linked = true
    try {
      symlinkSync(at.cookies, fileLink, 'file')
    } catch {
      linked = false // Windows without the privilege to make a file link
    }
    if (linked) expect(checkBuiltinCall(granted, PI_NATIVE_TOOLS, 'read', { path: fileLink })).toMatchObject({ ok: false, wall: { kind: 'closed' } })
  })

  /** The closed places that exist: a sandbox denies only those (`linuxCommandLayout`); the file tool's check holds them all. */
  const existing = (places: readonly string[]) => places.filter((place) => existsSync(place))

  /** The folders of this test among `paths` (the layout also opens the drives of the computer it runs on). */
  const ours = (paths: readonly string[]) => paths.filter((path) => path === base || path.startsWith(`${base}${sep}`)).sort()

  it('linuxCommandLayout: commands write the home folder, the folders beside the way and the drives, with every closed place denied inside them and each folder above one a mount of its own; system folders and, for Codex, WSL\'s Windows drives stay read-only', () => {
    const { at, outside } = ownerHome()
    const drives: Record<string, string[]> = { '/mnt': ['c', 'wsl', 'data'], '/media': ['owner'], [join('/media', 'owner')]: ['usb'], [join('/run/media', 'owner')]: [] }
    const system = join(base, 'usr')
    mkdirSync(system)
    const layoutOf = (windowsDrives: boolean) => linuxCommandLayout({
      roots: [base], mousseHome: mousse, outside, mine: [files, scratch], userHome: at.user, user: 'owner', windowsDrives, wsl: true,
      writable: (path) => path !== system && (Object.keys(drives).some((parent) => path.startsWith(`${join(parent)}${sep}`)) || (path.startsWith(base) && existsSync(path))),
      list: (path) => drives[path] ?? readdirSync(path)
    })
    const layout = layoutOf(true)
    // The home folder itself, the folders beside the way down to the Mousse home, every folder between them and a closed
    // place (each a mount: a command can't rename one away), and the bot's own folders. Not a system folder.
    expect(ours(layout.write)).toEqual([at.user, join(at.user, '.claude'), join(at.user, '.codex'), join(at.user, '.config'), join(base, 'Documents'), at.temp, files, scratch].sort())
    expect(layout.write).not.toContain(system)
    // The drives, and on WSL its Windows drives too unless the runtime keeps them read-only (Codex).
    const drive = (path: string) => join(path)
    expect(layout.write).toEqual(expect.arrayContaining([drive('/mnt/c'), drive('/mnt/wsl'), drive('/mnt/data'), drive('/media/owner/usb')]))
    const codex = layoutOf(false)
    expect(codex.write).not.toContain(drive('/mnt/c'))
    expect(codex.write).toEqual(expect.arrayContaining([drive('/mnt/wsl'), drive('/mnt/data'), drive('/media/owner/usb')]))
    // Closed: the Mousse home but the way down to the bot's folders, and every other place on the list.
    expect([...layout.deny].sort()).toEqual([join(mousse, 'auth.json'), join(mousse, 'browser'), join(mousse, 'profiles', 'p2'), join(profile, 'bots', 'bots.db'), join(profile, 'harness'), ...existing(outside)].sort())
    // A closed place that doesn't exist (Grok's sign-in here) is left to the file tool's check: a sandbox would make a
    // stand-in for it on the disk.
    expect(outside).toContain(join(at.user, '.grok', 'auth.json'))
    expect(layout.deny).not.toContain(join(at.user, '.grok', 'auth.json'))
    // The way down is read-only: nothing can be made or renamed on it.
    expect(layout.read).toEqual(expect.arrayContaining([mousse, join(mousse, 'profiles'), profile, join(profile, 'bots')]))
    for (const folder of layout.read) expect(layout.write).not.toContain(folder)
  })

  it('Claude Code on Linux: commands read every file but the closed places and write as the layout says; Claude Code\'s own storage and the way down are read-only to them', () => {
    const { at, outside } = ownerHome()
    const granted = authorityOf(withOutside(permissions(everywhere()), outside))
    const ownStorage = join(base, 'claude-home', 'projects', 'p')
    const sandbox = claudeLockedSandbox({ workspace: granted.workspace!, temps: [at.temp], home: at.user, own: [ownStorage], platform: 'linux', user: 'owner' }) as unknown as { filesystem: Record<string, string[]> }
    // Only folders this user can write: `/` itself would make Claude Code's sandbox fail every command.
    expect(ours(sandbox.filesystem.allowWrite)).toEqual([at.user, join(at.user, '.claude'), join(at.user, '.codex'), join(at.user, '.config'), join(base, 'Documents'), at.temp, files, scratch].sort())
    expect([...sandbox.filesystem.denyRead].sort()).toEqual([join(mousse, 'auth.json'), join(mousse, 'browser'), join(mousse, 'profiles', 'p2'), join(profile, 'bots', 'bots.db'), join(profile, 'harness'), ...existing(outside)].sort())
    expect(sandbox.filesystem.denyRead).toEqual(expect.arrayContaining([at.electron, at.codexAuth, at.claudeCredentials, at.claudeJson, join(at.temp, 'mousse-pr-1')]))
    expect(sandbox.filesystem.allowRead).toEqual([files, scratch])
    expect(sandbox.filesystem.denyWrite).toEqual(expect.arrayContaining([...sandbox.filesystem.denyRead, mousse, join(mousse, 'profiles'), profile, ownStorage]))
    // What the bot is told: what its commands can't change, when they run in the sandbox with file access, on Linux only.
    const turn = (shellContained: boolean): ClaudeLockedTurn => ({ authority: granted, ownerEntry: true, ledger: { start: () => 'row', commit: () => {}, failed: () => {} }, cwd: files, shellContained, temps: [], systemPrompt: 'You are a bot.' })
    const told = (shellContained: boolean) => (claudeLockedOptions(turn(shellContained), { env: {}, mousseTools: false }).systemPrompt as { prompt: string }).prompt
    expect(told(true)).toBe(process.platform === 'linux' ? `You are a bot.\n\n${CLAUDE_COMMAND_WRITE_LIMIT_TEXT}` : 'You are a bot.')
    expect(told(false)).toBe('You are a bot.')
    // macOS keeps its sandbox as before: the Mousse home closed whole but the bot's folders, every other folder writable.
    const mac = claudeLockedSandbox({ workspace: granted.workspace!, temps: [at.temp], home: at.user, platform: 'darwin' }) as unknown as { filesystem: Record<string, string[]> }
    expect(mac.filesystem).toMatchObject({ denyRead: [mousse], allowRead: [files, scratch], allowWrite: [base, files, scratch] })
    // Without file access, on macOS as before: the home unreadable but for its own folders and Claude Code's storage.
    // On Linux it closes more, Mousse's folders in the temporary folder included (botApprovalRuntimes.test.ts, below).
    const own = join(base, '.claude', 'projects', 'x')
    const without = claudeLockedSandbox({ workspace: authorityOf(permissions(null)).workspace!, temps: [at.temp], home: base, own: [own], platform: 'darwin' }) as unknown as { filesystem: Record<string, string[]> }
    expect(without.filesystem).toMatchObject({ denyRead: [base], allowRead: [files, scratch, own], allowWrite: [files, scratch] })
    const linuxWithout = claudeLockedSandbox({ workspace: authorityOf(permissions(null)).workspace!, temps: [at.temp], home: base, own: [own], platform: 'linux', tops: () => [] }) as unknown as { filesystem: Record<string, string[]> }
    expect(linuxWithout.filesystem.denyRead).toContain(join(at.temp, 'mousse-pr-1'))
  })

  it('Codex on Linux: commands read every file but the closed places and write as the layout says, without WSL\'s Windows drives; macOS and Windows keep their earlier sandbox', () => {
    const { at, outside } = ownerHome()
    const granted = authorityOf(withOutside(permissions(everywhere()), outside))
    const sandbox = codexBotSandbox(granted, { platform: 'linux', userHome: at.user, user: 'owner', wsl: true })
    const layout = linuxCommandLayout({ roots: [base], mousseHome: mousse, outside, mine: [files, scratch], userHome: at.user, user: 'owner', windowsDrives: false, wsl: true })
    expect(sandbox).toEqual({ shell: true, writableRoots: layout.write, profile: { base: ':root', readable: layout.read, closed: layout.deny } })
    expect(ours(sandbox.writableRoots)).toEqual([at.user, join(at.user, '.claude'), join(at.user, '.codex'), join(at.user, '.config'), join(base, 'Documents'), at.temp, files, scratch].sort())
    expect(sandbox.profile!.closed).toEqual(expect.arrayContaining([at.electron, at.codexAuth, at.claudeCredentials, at.claudeJson, join(at.temp, 'mousse-pr-1')]))
    expect(codexTurnPolicy('default', undefined, 'ask', sandbox)).toEqual({ approvalPolicy: 'untrusted', permissions: CODEX_BOT_PROFILE })
    expect(codexBotSandboxConfig(sandbox)[`permissions.${CODEX_BOT_PROFILE}`]).toEqual({
      filesystem: { ':root': 'read', ...Object.fromEntries(layout.read.map((folder) => [folder, 'read'])), ...Object.fromEntries(layout.write.map((root) => [root, 'write'])), ...Object.fromEntries(layout.deny.map((entry) => [entry, 'deny'])) },
      network: { enabled: false }
    })
    // What the bot is told: on Linux only, and only with commands and file access.
    expect(codexBotInstructionsNote(granted, 'linux')).toMatch(/can't change files in folders only the system may change/)
    for (const platform of ['darwin', 'win32'] as const) expect(codexBotInstructionsNote(granted, platform)).toBeUndefined()
    expect(codexBotInstructionsNote(authorityOf(permissions(null)), 'linux')).toBeUndefined()
    // macOS: as before this change, the `workspaceWrite` sandbox (every file readable, every entry beside Mousse's data writable).
    const mac = codexBotSandbox(granted, { platform: 'darwin' })
    expect(mac.profile).toBeUndefined()
    expect(mac.writableRoots).toEqual(expect.arrayContaining([join(base, 'Documents'), files, scratch]))
    // An entry Mousse manages keeps its Codex in the home: every entry beside the way down to it is denied instead of the
    // home, since Codex doesn't open a folder for reading again inside a denied one. The bot's folders are opened again
    // for writing inside `profiles`.
    const codexPackage = join(mousse, 'managed', 'codex', '0.162.1')
    mkdirSync(codexPackage, { recursive: true })
    const managed = codexBotSandbox(granted, { platform: 'linux', codexPackage, userHome: at.user, user: 'owner', wsl: true })
    expect(managed.profile!.closed).toEqual(expect.arrayContaining([join(mousse, 'auth.json'), join(mousse, 'browser'), join(mousse, 'profiles', 'p2'), ...existing(outside)]))
    expect(managed.profile!.closed).not.toContain(mousse)
    expect(managed.profile!.readable).toContain(codexPackage)
    // Windows: the `workspaceWrite` sandbox as before this change (every entry beside Mousse's data writable, every file
    // readable): no profile, and the turn runs.
    const windows = codexBotSandbox(granted, { platform: 'win32' })
    expect(windows.profile).toBeUndefined()
    expect(windows.writableRoots).toEqual(expect.arrayContaining([join(base, 'Documents'), files, scratch]))
    expect(codexTurnPolicy('default', undefined, 'ask', windows)).toMatchObject({ sandbox: 'workspace-write' })
    expect(codexBotSandbox(authorityOf(permissions(null)), { platform: 'win32' })).toEqual({ shell: true, writableRoots: [files, scratch] })
    // On the real file system: never the kernel's own folders, never Mousse's data.
    const whole = codexBotSandbox({ tools: new Set(['shell'] as const), workspace: { roots: ['/'], access: 'write', scratch, files, computer: { closed: mousse } } }, { platform: 'linux' })
    for (const kernel of ['/proc', '/sys', '/dev']) expect(whole.writableRoots).not.toContain(kernel)
    expect(whole.writableRoots).toContain(files)
    expect(whole.profile?.closed).toEqual(expect.arrayContaining([join(mousse, 'auth.json'), join(profile, 'harness')]))
  })

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

  it.runIf(process.platform === 'win32')('Windows, the real file system: the file tools check a path to this computer over the network as the local path it means', () => {
    const { outside } = ownerHome()
    const granted = authorityOf(withOutside(permissions(everywhere()), outside))
    const drive = base.slice(0, 1)
    const rest = base.slice(3)
    const forms = [
      `\\\\localhost\\${drive}$\\${rest}`,
      `\\\\127.0.0.1\\${drive.toLowerCase()}$\\${rest}`,
      `\\\\[::1]\\${drive}$\\${rest}`,
      `\\\\0--1.ipv6-literal.net\\${drive}$\\${rest}`,
      `\\\\?\\UNC\\localhost\\${drive}$\\${rest}`,
      `//localhost/${drive}$/${rest.replace(/\\/g, '/')}`,
      `\\\\?\\${base}`
    ]
    for (const form of forms) {
      const closed = (name: string) => checkBuiltinCall(granted, PI_NATIVE_TOOLS, 'read', { path: `${form}\\${name}` })
      expect(closed('.mousse\\auth.json'), form).toMatchObject({ ok: false, wall: { kind: 'closed' } })
      expect(closed('user\\.codex\\auth.json'), form).toMatchObject({ ok: false, wall: { kind: 'closed' } })
      expect(closed('Documents\\a.md'), form).toEqual({ ok: true })
    }
    // Forms that can't be turned into a local path with certainty are refused, with a plain reason.
    for (const form of [`\\\\127.1\\${drive}$\\${rest}\\Documents\\a.md`, `\\\\localhost\\SomeShare\\a.md`])
      expect(checkBuiltinCall(granted, PI_NATIVE_TOOLS, 'read', { path: form }), form).toMatchObject({ ok: false, wall: { kind: 'network_path' } })
    // The volume check, on this computer's real drives: a path through the loopback share is on one of them.
    expect(onLocalVolume(`\\\\localhost\\${drive}$\\${rest}`)).toBe(true)
  })

  it('Pi: the gate allows its file tools anywhere but Mousse\'s data, and never asks again', () => {
    const granted = authorityOf(permissions(everywhere(), ['read', 'list', 'search', 'edit', 'write']))
    for (const [name, args] of [['read', { path: join(base, 'Documents', 'a.md') }], ['write', { path: join(base, 'new', 'b.md'), content: 'x' }], ['edit', { path: join(base, 'Documents', 'a.md') }], ['grep', { pattern: 'x', path: base }], ['ls', { path: join(base, 'Documents') }]] as const)
      expect(checkBuiltinCall(granted, PI_NATIVE_TOOLS, name, args), name).toEqual({ ok: true })
    expect(checkBuiltinCall(granted, PI_NATIVE_TOOLS, 'read', { path: join(mousse, 'auth.json') })).toMatchObject({ ok: false, wall: { kind: 'closed' } })
    expect(checkBuiltinCall(granted, PI_NATIVE_TOOLS, 'write', { path: join(files, 'report.md'), content: 'x' })).toEqual({ ok: true })
  })
})
