/**
 * What bots may do here (Settings → Agents): each computer's ceiling over every bot's grant. A switch that is off gives
 * no bot that permission: on the next call of a turn already running and on every later turn, in the chat, in work and
 * in a consult. An ask for it makes no card and the bot is told it is not on this computer; About marks a permission the
 * bot holds; the grant is kept, so switching it on gives it back with no new ask. The service enforces it; how the
 * setting is stored and read, once for the whole installation, is in botsHereSetting.test.ts.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotBrowserHost } from '../../src/mms/bots/activation/dispatcher'
import { BotEngine } from '../../src/mms/bots/activation/BotEngine'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import { botManifestDigest, compileBotThread } from '../../src/mms/bots/grants/compile'
import { botInstructions } from '../../src/mms/bots/instructions'
import { PI_NATIVE_TOOLS } from '../../src/mms/harness/pi/nativeTools'
import type { BotCheck, NormalisedCall } from '../../src/shared/bots/personal/authority'
import { BOT_COMPUTER_OPEN, BOT_COMPUTER_SHUT, BOT_OFF_HERE_MARK, type BotComputerLimit } from '../../src/shared/bots/personal/computerLimit'
import type { BotManifest } from '../../src/shared/bots/personal/definition'
import { BOT_BROWSER_PERMISSION, botStarterManifest } from '../../src/shared/bots/personal/manifest'
import { checkMessage } from '../../src/shared/bots/personal/walls'
import { toolArgsDigest } from '../../src/mms/run/tools/argsDigest'
import { appToolRegistry, appTurn, fakeAppToolHost } from '../run/appToolsFixture'
import { delegationFixture } from '../run/delegationFixture'
import { botFixture, chatOf, createBot, finish, flush, payloadOf, start, type BotFixture } from './botFixture'

const NOT_HERE = /^Not on this computer: "(run commands|use files on this computer|use the browser)" is switched off here/
const command = (text: string): NormalisedCall => ({ kind: 'builtin', tool: 'shell', nativeName: 'bash', args: { command: text } })
const read = (path: string): NormalisedCall => ({ kind: 'builtin', tool: 'read', nativeName: 'read', args: { path } })
const write = (path: string): NormalisedCall => ({ kind: 'builtin', tool: 'write', nativeName: 'write', args: { path } })
const app = (tool: string): NormalisedCall => ({ kind: 'app', tool, args: {} })
const off = (patch: Partial<BotComputerLimit>): BotComputerLimit => ({ ...BOT_COMPUTER_OPEN, ...patch })

describe('the authority decides on every call', () => {
  let base: string
  let profile: string
  let scratch: string
  let files: string
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bot-limit-')))
    profile = join(base, 'profile')
    scratch = join(profile, 'bots', 'scratch', 'act-1')
    files = join(profile, 'bots', 'files', 'b1')
    for (const dir of [scratch, files, join(base, 'elsewhere')]) mkdirSync(dir, { recursive: true })
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  const starter = botStarterManifest()
  const full: BotManifest = { ...starter, tools: [...starter.tools, 'shell'], appTools: [...starter.appTools, BOT_BROWSER_PERMISSION], workspace: { roots: ['/'], access: 'write' } }

  /** A run turn of `grant`, compiled under `compiledWith`; `now` is what the computer allows at each call. */
  function turn(grant: BotManifest, compiledWith: BotComputerLimit, now: () => BotComputerLimit) {
    const compiled = compileBotThread({
      grant, digest: botManifestDigest(grant), thread: {}, scratch, profileHome: profile, filesFolder: files, limit: compiledWith,
      nativeNames: (tools) => ({ ok: true, names: tools.flatMap((tool) => [...(PI_NATIVE_TOOLS[tool] ?? [])]) }),
      remaining: { deadlineMs: 600_000 }, botTools: { escalate: true, consult: false, memory: true }
    })
    if (!compiled.ok) throw new Error(compiled.error.message)
    const authority = createBotAuthority({
      activationId: 'act-1', role: 'activation', permissions: compiled.permissions, waiting: () => false, limit: now,
      counters: { charge: () => ({ ok: true, count: 1 }) }, time: { deadline: () => 0, signal: new AbortController().signal }, spend: null
    })
    return { compiled, authority }
  }

  it('compiles no commands, no file access and no browser for what is switched off, whatever the grant holds', () => {
    const open = turn(full, BOT_COMPUTER_OPEN, () => BOT_COMPUTER_OPEN).compiled
    const shut = turn(full, BOT_COMPUTER_SHUT, () => BOT_COMPUTER_SHUT).compiled
    expect(open.ok && open.policy.tools!.allow).toEqual(expect.arrayContaining(['bash', 'browser_open']))
    expect(open.ok && open.permissions.workspace?.computer).toBeDefined()
    if (!shut.ok) throw new Error('not compiled')
    expect(shut.policy.tools!.allow).not.toContain('bash')
    expect(shut.policy.tools!.allow!.filter((name) => name.startsWith('browser_'))).toEqual([])
    expect(shut.permissions.browser).toBeUndefined()
    expect(shut.permissions.workspace?.computer).toBeUndefined()
    // The bot's own folders are not file access: they stay.
    expect(shut.permissions.workspace?.files).toBe(realpathSync(files))
    // One switch takes out only its own permission.
    const noBrowser = turn(full, off({ browser: false }), () => BOT_COMPUTER_OPEN).compiled
    expect(noBrowser.ok && noBrowser.policy.tools!.allow).toContain('bash')
    expect(noBrowser.ok && noBrowser.permissions.browser).toBeUndefined()
  })

  // Which grant, what the turn was compiled under, what the computer allows at the call, the call, and the outcome.
  const outside = () => join(base, 'elsewhere', 'notes.md')
  const inFiles = () => join(files, 'list.md')
  const rows: Array<[string, () => BotManifest, BotComputerLimit, BotComputerLimit, () => NormalisedCall, BotCheck | 'computer:shell' | 'computer:files' | 'computer:browser']> = [
    ['all on: a command runs', () => full, BOT_COMPUTER_OPEN, BOT_COMPUTER_OPEN, () => command('ls'), { ok: true }],
    ['all on: a file anywhere', () => full, BOT_COMPUTER_OPEN, BOT_COMPUTER_OPEN, () => read(outside()), { ok: true }],
    ['all on: the browser', () => full, BOT_COMPUTER_OPEN, BOT_COMPUTER_OPEN, () => app('browser_open'), { ok: true }],
    ['commands off mid-turn: the next command', () => full, BOT_COMPUTER_OPEN, off({ shell: false }), () => command('ls'), 'computer:shell'],
    ['commands off: files still open', () => full, BOT_COMPUTER_OPEN, off({ shell: false }), () => read(outside()), { ok: true }],
    ['files off mid-turn: a file outside', () => full, BOT_COMPUTER_OPEN, off({ files: false }), () => read(outside()), 'computer:files'],
    ['files off mid-turn: a write outside', () => full, BOT_COMPUTER_OPEN, off({ files: false }), () => write(outside()), 'computer:files'],
    ['files off: its files folder still works', () => full, BOT_COMPUTER_OPEN, off({ files: false }), () => write(inFiles()), { ok: true }],
    ['files off: its scratch still works', () => full, BOT_COMPUTER_OPEN, off({ files: false }), () => write(join(scratch, 'x.md')), { ok: true }],
    ['files off mid-turn: commands opened over every folder wait', () => full, BOT_COMPUTER_OPEN, off({ files: false }), () => command('ls'), 'computer:files'],
    ['files off from the start: commands run, in their narrow sandbox', () => full, off({ files: false }), off({ files: false }), () => command('ls'), { ok: true }],
    ['browser off mid-turn: any browser tool', () => full, BOT_COMPUTER_OPEN, off({ browser: false }), () => app('browser_act'), 'computer:browser'],
    ['all off: the web still works', () => full, BOT_COMPUTER_SHUT, BOT_COMPUTER_SHUT, () => app('web_fetch'), { ok: true }],
    ['all off, no grant: a command is no ask', () => starter, BOT_COMPUTER_OPEN, BOT_COMPUTER_SHUT, () => command('ls'), 'computer:shell'],
    ['all off, no grant: a file outside is no ask', () => starter, BOT_COMPUTER_OPEN, BOT_COMPUTER_SHUT, () => read(outside()), 'computer:files'],
    ['all off, no grant: the browser is no ask', () => starter, BOT_COMPUTER_OPEN, BOT_COMPUTER_SHUT, () => app('browser_open'), 'computer:browser'],
    // Controls: with the switches on, what the grant lacks is a wall the engine turns into an ask, as before.
    ['all on, no grant: a command is a wall', () => starter, BOT_COMPUTER_OPEN, BOT_COMPUTER_OPEN, () => command('ls'), { ok: false, wall: { kind: 'tool', tool: 'bash' } }],
    ['all on, no grant: a file outside is a wall', () => starter, BOT_COMPUTER_OPEN, BOT_COMPUTER_OPEN, () => read(outside()), { ok: false, wall: { kind: 'path', tool: 'read', access: 'read' } }],
    // Switched on mid-turn: the turn still lacks it (it continues with it once it ends, see below).
    ['commands on mid-turn: this turn has none', () => full, off({ shell: false }), BOT_COMPUTER_OPEN, () => command('ls'), { ok: false, wall: { kind: 'tool', tool: 'bash' } }]
  ]

  it.each(rows)('%s', (_name, grant, compiledWith, now, call, expected) => {
    const { authority } = turn(grant(), compiledWith, () => now)
    const decided = authority.check(call())
    if (typeof expected !== 'string') return expect(decided).toMatchObject(expected)
    expect(decided).toMatchObject({ ok: false, wall: { kind: 'computer', off: expected.slice('computer:'.length) } })
    expect(checkMessage(decided as Exclude<BotCheck, { ok: true }>)).toMatch(NOT_HERE)
  })

  it('reads the switches at every call of one turn', () => {
    let now = BOT_COMPUTER_OPEN
    const { authority } = turn(full, BOT_COMPUTER_OPEN, () => now)
    expect(authority.check(command('ls'))).toEqual({ ok: true })
    now = off({ shell: false })
    expect(authority.check(command('ls'))).toMatchObject({ ok: false, wall: { kind: 'computer', off: 'shell' } })
    now = BOT_COMPUTER_OPEN
    expect(authority.check(command('ls'))).toEqual({ ok: true })
  })
})

describe('a bot on this computer', () => {
  let f: BotFixture
  let botId: string
  let limit: BotComputerLimit
  const cards = () => chatOf(f, botId).filter((message) => message.ask)
  const line = (text: string | undefined, what: string) => text!.slice(text!.indexOf('What your owner allows now')).split('\n').find((row) => row.startsWith(`- ${what}`))

  beforeEach(async () => {
    f = botFixture()
    limit = { ...BOT_COMPUTER_OPEN }
    f.host.computerLimit = () => limit
    f.host.instructions = (bot) => botInstructions(bot)
    const browser: BotBrowserHost = {
      turn: () => ({ binding: { mode: 'structured' } as never, runtime: { resolveTarget: () => ({ backend: 'managed-chromium' }), dispatch: async () => ({}) } }),
      activationEnded: () => {}
    }
    f.host.browser = browser
    await f.bots.reconcileOnStartup()
    botId = (await createBot(f, { name: 'Pip', description: 'Look things up for me.', reply: 'Hello.' })).botId
  })
  afterEach(() => f.close())

  async function chat(text: string, id: string) {
    await f.bots.service.chatSend({ botId, text, clientRequestId: id })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    return { activation, ...(await start(f, activation.id)) }
  }

  /** A run of the bot's work lane, started by hand. */
  async function run(id: string) {
    const activation = await f.bots.activate({ botId, input: 'Check it.', clientRequestId: id })
    return { id: activation.id, ...(await start(f, activation.id)) }
  }

  /** The owner allows commands, files and the browser from work's cards while every switch is on. */
  async function allowAll() {
    const work = await run('grant')
    for (const permission of [{ tool: 'shell' }, { tool: 'browser' }, { path: f.base, access: 'write' as const }])
      work.prepared.authority.escalate!({ permission, reason: 'The owner asked.' })
    await finish(f, work.payload, 'completed', { text: 'Asked.' })
    for (const ask of f.store.openAsks(botId)) await f.bots.service.answer(botId, ask.id, 'allow')
    expect(f.bots.service.get(botId).permissions.map((item) => item.title).sort()).toEqual(['run commands', 'use files on this computer', 'use the browser'])
  }

  it('a bot switch stops commands, continues without them, and restores without a card; old builds see no power', async () => {
    await allowAll()
    const id = f.bots.service.get(botId).permissions.find((item) => item.title === 'run commands')!.id
    const work = await run('switch-work')
    expect(work.prepared.authority.check(command('ls')).ok).toBe(true)
    f.bots.service.setPermission(botId, id, false)
    expect(work.prepared.authority.time.signal.aborted).toBe(true)
    expect(chatOf(f, botId).at(-1)).toMatchObject({ systemLine: true, author: 'bot' })
    expect(f.bots.service.get(botId).permissions.find((item) => item.id === id)?.enabled).toBe(false)
    // This is the query an older build uses; neither its grant nor the published definition contains commands.
    const old = f.store.get('SELECT manifest_json FROM bot_grants WHERE bot_id = ? AND revoked_at IS NULL ORDER BY grant_id DESC LIMIT 1', botId)!
    expect(JSON.parse(old.manifest_json as string).tools).not.toContain('shell')
    expect(f.bots.definitionOf(botId).permissions.tools).not.toContain('shell')
    await finish(f, work.payload, 'interrupted', { outcome: { interruptedBy: 'bot_wall' } })
    const next = await start(f, work.id, 2)
    expect(next.prepared.policy.tools!.allow).not.toContain('bash')
    expect(next.prepared.authority.check(command('ls')).ok).toBe(false)
    expect(next.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'Run it' })).toMatch(/switched.*off/)
    expect(next.prepared.instructions).not.toContain('You can ask for "run commands"')
    await finish(f, next.payload, 'completed', { text: 'Skipped it.' })
    const before = cards().length
    f.bots.service.setPermission(botId, id, true)
    const again = await run('switch-again')
    expect(again.prepared.policy.tools!.allow).toContain('bash')
    expect(again.prepared.authority.check(command('ls')).ok).toBe(true)
    expect(cards()).toHaveLength(before)
    await finish(f, again.payload, 'completed', { text: 'Ran it.' })
    f.bots.service.setPermission(botId, id, false)
    f.bots.service.revokePermission(botId, id)
    expect(f.bots.service.get(botId).permissions.some((item) => item.id === id)).toBe(false)
    expect(() => f.bots.service.setPermission(botId, id, true)).toThrow()
  })

  it('a bot browser switch refuses an already running call and ask without stopping unrelated work', async () => {
    await allowAll()
    const id = f.bots.service.get(botId).permissions.find((item) => item.title === 'use the browser')!.id
    const work = await run('browser-switch')
    expect(work.prepared.authority.check(app('browser_open')).ok).toBe(true)
    const before = cards().length
    f.bots.service.setPermission(botId, id, false)
    expect(work.prepared.authority.time.signal.aborted).toBe(false)
    expect(work.prepared.authority.check(app('browser_open')).ok).toBe(false)
    expect(work.prepared.authority.escalate!({ permission: { tool: 'browser' }, reason: 'Open it' })).toMatch(/switched.*off/)
    expect(cards()).toHaveLength(before)
    expect(work.prepared.authority.check(command('ls')).ok).toBe(true)
    f.bots.service.setPermission(botId, id, true)
    expect(work.prepared.authority.check(app('browser_open')).ok).toBe(false)
    f.bots.service.setPermission(botId, id, false)
    f.bots.service.revokePermission(botId, id)
    expect(work.prepared.authority.check(app('browser_open')).ok).toBe(false)
    // Give it back through an explicit ask, then the same computer-limit combination still holds.
    await finish(f, work.payload, 'completed', { text: 'Skipped the browser.' })
    const asking = await run('browser-ask-again')
    asking.prepared.authority.escalate!({ permission: { tool: 'browser' }, reason: 'Open it again.' })
    await finish(f, asking.payload, 'completed', { text: 'Asked again.' })
    for (const ask of f.store.openAsks(botId)) await f.bots.service.answer(botId, ask.id, 'allow')
    limit = { ...limit, browser: false }
    f.bots.service.setPermission(botId, id, true)
    expect(f.bots.service.get(botId).permissions.find((item) => item.id === id)).toMatchObject({ enabled: true, mark: BOT_OFF_HERE_MARK })
    const again = await run('browser-computer-off')
    expect(again.prepared.authority.check(app('browser_open')).ok).toBe(false)
    await finish(f, again.payload, 'completed', { text: 'Still off here.' })
  })

  it('a disabled permission survives reopening the service and refuses an old Allow card', async () => {
    await allowAll()
    const id = f.bots.service.get(botId).permissions.find((item) => item.title === 'run commands')!.id
    f.bots.service.setPermission(botId, id, false)
    f.bots.close()
    f.bots = new BotEngine(f.host)
    await f.bots.reconcileOnStartup()
    expect(f.bots.service.get(botId).permissions.find((item) => item.id === id)?.enabled).toBe(false)
    const work = await run('after-switch-restart')
    expect(work.prepared.policy.tools!.allow).not.toContain('bash')
    expect(work.prepared.authority.check(command('ls')).ok).toBe(false)
    expect(work.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'Run' })).toMatch(/switched.*off/)
    await finish(f, work.payload, 'completed', { text: 'No command.' })
  })

  it('an old ask and Allow this time cannot restore a disabled permission', async () => {
    const work = await run('old-card')
    work.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'Run it.' })
    await finish(f, work.payload, 'completed', { text: 'Asked.' })
    const ask = f.store.openAsks(botId)[0]!
    // A card left by an older build, whose grant was widened without settling that card.
    const definition = f.bots.definitionOf(botId)
    const manifest = { ...definition.permissions, tools: [...definition.permissions.tools, 'shell' as const] }
    const revision = f.host.definitions.publishRevision({ ...definition, permissions: manifest })
    f.store.setPublished(botId, revision.revision!)
    f.store.approve(botId, botManifestDigest(manifest), manifest)
    const id = f.bots.service.get(botId).permissions.find((item) => item.title === 'run commands')!.id
    f.bots.service.setPermission(botId, id, false)
    await expect(f.bots.service.answer(botId, ask.id, 'allow')).rejects.toMatchObject({ code: 'permission_off' })
    f.store.run("UPDATE bot_activations SET status = 'waiting_grant' WHERE id = ?", work.id)
    await expect(f.bots.respond({ escalationId: ask.id, answer: 'allow_once' })).rejects.toMatchObject({ code: 'permission_off' })
    f.store.run("UPDATE bot_activations SET status = 'done' WHERE id = ?", work.id)
    const later = await f.bots.activate({ botId, input: 'Run', clientRequestId: 'old-overlay' })
    f.store.putOverlay(later.id, 'old-overlay', { tool: 'shell' })
    const turn = await start(f, later.id)
    expect(turn.prepared.policy.tools!.allow).not.toContain('bash')
    expect(turn.prepared.authority.check(command('ls')).ok).toBe(false)
    await finish(f, turn.payload, 'completed', { text: 'Skipped.' })
  })

  it('a skill switched off is neither listed nor loaded from a running turn, even by its name', async () => {
    const initial = await run('skill-grant')
    initial.prepared.authority.escalate!({ permission: { skill: 'review' }, reason: 'Review' })
    await finish(f, initial.payload, 'completed', { text: 'Asked.' })
    for (const ask of f.store.openAsks(botId)) await f.bots.service.answer(botId, ask.id, 'allow')
    const permission = f.bots.service.get(botId).permissions.find((item) => item.id.includes('review'))!
    const work = await run('skill-work')
    const fx = delegationFixture()
    try {
      const running = await fx.runningRun('bot-skill')
      const descriptor = { id: 'review', installationId: 'inst-review', name: 'Review changes', description: 'Review', rootPath: '/skills/review', skillPath: '/skills/review/SKILL.md', scope: 'global' as const, source: 'mousse-profile' as const, managed: true }
      const readSkill = vi.fn(async () => ({ skill: descriptor, content: 'Review instructions' }))
      const { registry, turns, request } = appToolRegistry(fx.engine, fakeAppToolHost({ skills: () => ({ readSkill }) as never }).host)
      turns.register(appTurn({ threadId: 'bot-skill', runId: running.runId, bot: work.prepared.authority, enabledSkills: [descriptor] }))
      const call = (name: string, args = {}) => registry.call(name, args, request({ threadId: 'bot-skill', runId: running.runId }))
      expect(await call('load_skill', { skill: 'Review changes' })).toMatchObject({ text: 'Review instructions' })
      f.bots.service.setPermission(botId, permission.id, false)
      expect(await call('list_skills')).toMatchObject({ text: '[]' })
      expect(await call('load_skill', { skill: 'Review changes' })).toMatchObject({ isError: true })
      expect(readSkill).toHaveBeenCalledTimes(1)
      expect(f.store.openAsks(botId)).toHaveLength(0)
    } finally { fx.dispose() }
    await finish(f, work.payload, 'completed', { text: 'Skipped the skill.' })
    f.bots.service.setPermission(botId, permission.id, true)
    const again = await run('skill-restored')
    expect(again.prepared.authority.check({ kind: 'skill', skill: 'review' }).ok).toBe(true)
    expect(f.store.openAsks(botId)).toHaveLength(0)
    await finish(f, again.payload, 'completed', { text: 'Reviewed.' })
  })

  it.each(['web_search', 'web_fetch'] as const)('the %s row restores both the native and app tool with no ask', async (tool) => {
    const initial = await run('web-grant')
    initial.prepared.authority.escalate!({ permission: { tool }, reason: 'Use the web.' })
    await finish(f, initial.payload, 'completed', { text: 'Asked.' })
    // Older grants can hold the same web tool in both lists. Keep both when restoring it.
    const definition = f.bots.definitionOf(botId)
    const manifest = { ...definition.permissions, tools: [...definition.permissions.tools, tool] }
    const revision = f.host.definitions.publishRevision({ ...definition, permissions: manifest })
    f.store.setPublished(botId, revision.revision!)
    f.store.approve(botId, botManifestDigest(manifest), manifest)
    const item = f.bots.service.get(botId).permissions.find((item) => item.id.includes(tool))!
    f.bots.service.setPermission(botId, item.id, false)
    const off = await run('web-off')
    expect(off.prepared.authority.check(app(tool)).ok).toBe(false)
    expect(off.prepared.authority.check({ kind: 'builtin', tool, nativeName: tool, args: {} }).ok).toBe(false)
    await finish(f, off.payload, 'completed', { text: 'Skipped.' })
    const before = cards().length
    f.bots.service.setPermission(botId, item.id, true)
    const on = await run('web-on')
    expect(on.prepared.authority.check(app(tool)).ok).toBe(true)
    expect(on.prepared.authority.check({ kind: 'builtin', tool, nativeName: tool, args: {} }).ok).toBe(true)
    expect(cards()).toHaveLength(before)
    await finish(f, on.payload, 'completed', { text: 'Read it.' })
  })

  it('commands switched off: running work\'s next command is refused with no card; later turns have none; on again, they are back with no new ask', async () => {
    await allowAll()
    const before = cards().length
    const work = await run('w1')
    expect(work.prepared.authority.check(command('ls'))).toEqual({ ok: true })
    limit = { ...limit, shell: false }
    const refused = work.prepared.authority.check(command('ls'))
    expect(refused).toMatchObject({ ok: false, wall: { kind: 'computer', off: 'shell' } })
    expect(checkMessage(refused as Exclude<BotCheck, { ok: true }>)).toMatch(NOT_HERE)
    expect(work.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'To run it.' })).toMatch(NOT_HERE)
    expect(f.store.activation(work.id)!.status).toBe('running')
    await finish(f, work.payload, 'completed', { text: 'I could not run it here.' })

    // The grant is kept; About says it is off here, in a short mark with the details in its tooltip.
    expect(f.store.activeGrant(botId)!.manifest.tools).toContain('shell')
    const items = f.bots.service.get(botId).permissions
    expect(items.find((item) => item.title === 'run commands')).toMatchObject({ mark: BOT_OFF_HERE_MARK })
    expect(items.find((item) => item.title === 'run commands')!.note).toMatch(/What bots may do here/)
    expect(items.filter((item) => item.mark).map((item) => item.title)).toEqual(['run commands'])

    const next = await run('w2')
    expect(next.prepared.policy.tools!.allow).not.toContain('bash')
    expect(line(next.prepared.instructions, 'Run commands')).toMatch(/off on this computer/)
    expect(next.prepared.instructions).not.toContain('You can ask for "run commands"')
    expect(next.prepared.instructions).toContain('You can ask for "use the browser"')
    await finish(f, next.payload, 'completed', { text: 'Done.' })

    limit = { ...limit, shell: true }
    const again = await run('w3')
    expect(again.prepared.policy.tools!.allow).toContain('bash')
    expect(again.prepared.authority.check(command('ls'))).toEqual({ ok: true })
    expect(line(again.prepared.instructions, 'Run commands')).toMatch(/: yes$/)
    expect(f.bots.service.get(botId).permissions.filter((item) => item.mark)).toEqual([])
    await finish(f, again.payload, 'completed', { text: 'Ran it.' })
    expect(cards()).toHaveLength(before)
  })

  it('an ask for what is switched off makes no card, in the chat and in work, and the bot is never told it can ask', async () => {
    limit = { ...BOT_COMPUTER_SHUT }
    const asks: Array<{ tool: string } | { path: string; access: 'write' }> = [{ tool: 'shell' }, { tool: 'browser' }, { tool: 'browser_act' }, { path: f.base, access: 'write' }]
    const turn = await chat('Run ls in my home folder', 'm1')
    for (const permission of asks) expect(turn.prepared.authority.escalate!({ permission, reason: 'The owner asked.' }), JSON.stringify(permission)).toMatch(NOT_HERE)
    for (const call of [command('ls'), read(join(f.base, 'a.md')), app('browser_open')]) expect(turn.prepared.authority.check(call)).toMatchObject({ ok: false, wall: { kind: 'computer' } })
    for (const ask of ['use files on this computer', 'run commands', 'use the browser']) expect(turn.prepared.instructions).not.toContain(`You can ask ${ask === 'use files on this computer' ? 'to' : 'for'} "${ask}"`)
    expect(line(turn.prepared.instructions, 'Use files on this computer')).toMatch(/off on this computer/)
    await finish(f, turn.payload, 'completed', { text: 'That is off on this computer.' })
    expect(f.store.activation(turn.activation.id)!.status).toBe('done')

    const work = await run('w1')
    for (const permission of asks) expect(work.prepared.authority.escalate!({ permission, reason: 'The owner asked.' })).toMatch(NOT_HERE)
    for (const call of [command('ls'), read(join(f.base, 'a.md')), app('browser_open')]) expect(work.prepared.authority.check(call)).toMatchObject({ ok: false, wall: { kind: 'computer' } })
    // A browser tool the turn was never offered, called through the app tools as in the app: not on this computer.
    const fx = delegationFixture()
    try {
      const running = await fx.runningRun('bot-run')
      const { registry, turns, request } = appToolRegistry(fx.engine, fakeAppToolHost().host)
      turns.register(appTurn({ threadId: 'bot-run', runId: running.runId, bot: work.prepared.authority }))
      const opened = await registry.call('browser_open', { url: 'https://example.com' }, request({ threadId: 'bot-run', runId: running.runId }))
      expect(opened).toMatchObject({ isError: true })
      expect((opened as { text: string }).text).toMatch(NOT_HERE)
    } finally {
      fx.dispose()
    }
    await finish(f, work.payload, 'completed', { text: 'Skipped them.' })
    expect(f.store.escalations({ botId })).toEqual([])
    expect(cards()).toEqual([])
  })

  it('file access switched off: work that started with it keeps only its own folders from the next call, and later turns start without it', async () => {
    await allowAll()
    const work = await run('w1')
    const outside = join(f.base, 'notes.md')
    const own = join(f.profile, 'bots', 'files', botId, 'list.md')
    expect(work.prepared.authority.workspace?.computer).toBeDefined()
    expect(work.prepared.authority.check(read(outside))).toEqual({ ok: true })
    limit = { ...limit, files: false }
    expect(work.prepared.authority.check(read(outside))).toMatchObject({ ok: false, wall: { kind: 'computer', off: 'files' } })
    expect(work.prepared.authority.check(write(own))).toEqual({ ok: true })
    // Its commands were set up over every folder: they wait for a turn without file access.
    expect(work.prepared.authority.check(command('ls'))).toMatchObject({ ok: false, wall: { kind: 'computer', off: 'files' } })
    // About never says files are closed while commands are on: a command may still read them.
    const filesItem = () => f.bots.service.get(botId).permissions.find((item) => item.title === 'use files on this computer')!
    expect(filesItem()).toMatchObject({ mark: BOT_OFF_HERE_MARK, note: expect.stringMatching(/commands may still read files/) })
    limit = { ...limit, shell: false }
    expect(filesItem().note).not.toMatch(/commands may still read files/)
    limit = { ...limit, shell: true }
    await finish(f, work.payload, 'completed', { text: 'Done.' })
    const next = await run('w2')
    expect(next.prepared.authority.workspace?.computer).toBeUndefined()
    expect(next.prepared.authority.check(command('ls'))).toEqual({ ok: true })
    expect(next.prepared.authority.check(read(outside))).toMatchObject({ ok: false, wall: { kind: 'computer', off: 'files' } })
    await finish(f, next.payload, 'completed', { text: 'Done.' })
  })

  it('the browser switched off: running work\'s next browser call is refused through the app tools, and later turns get no browser', async () => {
    await allowAll()
    const work = await run('w1')
    expect(work.prepared.browser).toBeDefined()
    limit = { ...limit, browser: false }
    const fx = delegationFixture()
    try {
      const running = await fx.runningRun('bot-run')
      const { registry, turns, request } = appToolRegistry(fx.engine, fakeAppToolHost().host)
      // The turn as the orchestrator registers it: its bot authority and the browser it started with.
      turns.register(appTurn({ threadId: 'bot-run', runId: running.runId, bot: work.prepared.authority, browser: work.prepared.browser!.binding, browserRuntime: work.prepared.browser!.runtime }))
      const opened = await registry.call('browser_open', { url: 'https://example.com' }, request({ threadId: 'bot-run', runId: running.runId }))
      expect(opened).toMatchObject({ isError: true })
      expect((opened as { text: string }).text).toMatch(NOT_HERE)
    } finally {
      fx.dispose()
    }
    await finish(f, work.payload, 'completed', { text: 'Done.' })
    const next = await run('w2')
    expect(next.prepared.browser).toBeUndefined()
    expect(next.prepared.policy.tools!.allow!.filter((name) => name.startsWith('browser_'))).toEqual([])
    await finish(f, next.payload, 'completed', { text: 'Done.' })
  })

  it('a grant made while switched off gives nothing here: an Allow on a card from before, and Allow this time', async () => {
    const work = await run('w1')
    work.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'To run it.' })
    await finish(f, work.payload, 'completed', { text: 'Asked.' })
    expect(cards()).toHaveLength(1)
    limit = { ...limit, shell: false }
    await f.bots.service.answer(botId, f.store.openAsks(botId)[0]!.id, 'allow')
    expect(f.store.activeGrant(botId)!.manifest.tools).toContain('shell')
    const next = await run('w2')
    expect(next.prepared.policy.tools!.allow).not.toContain('bash')
    expect(next.prepared.authority.check(command('ls'))).toMatchObject({ ok: false, wall: { kind: 'computer', off: 'shell' } })
    await finish(f, next.payload, 'completed', { text: 'Done.' })
    // "Allow this time" for one activation is under the ceiling too.
    const once = await f.bots.activate({ botId, input: 'Check it.', clientRequestId: 'w3' })
    f.store.putOverlay(once.id, 'e-once', { tool: 'shell' })
    const overlaid = await start(f, once.id)
    expect(overlaid.prepared.policy.tools!.allow).not.toContain('bash')
    await finish(f, overlaid.payload, 'completed', { text: 'Done.' })
    expect(cards()).toHaveLength(1)
  })

  it.each(['computer', 'bot'] as const)('a consult is under the same ceiling', async (source) => {
    await allowAll()
    const definitions = f.host.definitions
    const current = definitions.revision(botId, f.store.registry(botId)!.revision!)!
    const published = definitions.publishRevision({ ...current, context: [{ key: 'docs', title: 'Docs expert', agent: { instructions: 'You know the docs.' }, model: { mode: 'auto', depth: 'normal' } }] })
    f.store.setPublished(botId, published.revision!)
    if (source === 'computer') limit = { ...BOT_COMPUTER_SHUT }
    else for (const permission of f.bots.service.get(botId).permissions) f.bots.service.setPermission(botId, permission.id, false)
    const turn = await chat('What does the doc say?', 'm1')
    const asked = turn.prepared.authority.consult!({ context: 'docs', question: 'What does it say?' })
    await flush()
    const consultN = f.store.dispatches(turn.activation.id).find((dispatch) => dispatch.kind === 'consult')!.n
    const consult = f.bots.prepare(payloadOf(f, turn.activation.id, consultN))
    if ('refused' in consult) throw new Error(consult.refused)
    expect(consult.authority.check(command('ls'))).toMatchObject({ ok: false })
    expect(consult.authority.check(read(join(f.base, 'a.md')))).toMatchObject({ ok: false })
    expect(consult.authority.escalate!({ permission: { tool: 'shell' }, reason: 'To run it.' })).toMatch(source === 'computer' ? NOT_HERE : /switched.*off/)
    expect(consult.instructions).not.toContain('You can ask for "run commands"')
    void asked.catch(() => undefined)
  })

  it('a setting that can\'t be read gives nothing', async () => {
    await allowAll()
    f.host.computerLimit = () => { throw new Error('unreadable') }
    const work = await run('w1')
    expect(work.prepared.policy.tools!.allow).not.toContain('bash')
    expect(work.prepared.authority.workspace?.computer).toBeUndefined()
    expect(work.prepared.browser).toBeUndefined()
    await finish(f, work.payload, 'completed', { text: 'Done.' })
  })

  /** What a turn that holds everything was prepared with, under a computer that has everything off. */
  function heldToNothing(prepared: Awaited<ReturnType<typeof start>>['prepared']) {
    expect(prepared.policy.tools!.allow).not.toContain('bash')
    expect(prepared.policy.tools!.allow!.filter((name) => name.startsWith('browser_'))).toEqual([])
    expect(prepared.authority.workspace?.computer).toBeUndefined()
    expect(prepared.browser).toBeUndefined()
    expect(prepared.authority.check(command('ls')).ok).toBe(false)
    expect(prepared.authority.check(read(join(f.base, 'a.md')))).toMatchObject({ ok: false, wall: { kind: 'computer', off: 'files' } })
  }

  it.each(['computer', 'bot'] as const)('a scheduled run and a reminder\'s work start under the same ceiling, with no card', async (source) => {
    await allowAll()
    const before = cards().length
    if (source === 'computer') limit = { ...BOT_COMPUTER_SHUT }
    else for (const permission of f.bots.service.get(botId).permissions) f.bots.service.setPermission(botId, permission.id, false)
    const scheduled = f.bots.runScheduledOccurrence({ botId, scheduleId: 'sched-1', prompt: 'Tidy the notes.', occurrenceAt: new Date(f.clock.now).toISOString() })
    if (scheduled.kind !== 'started') throw new Error(`not started: ${scheduled.kind}`)
    await flush()
    const run = await start(f, scheduled.activationId)
    heldToNothing(run.prepared)
    expect(run.prepared.authority.escalate!({ permission: { tool: 'shell' }, reason: 'To tidy.' })).toMatch(source === 'computer' ? NOT_HERE : /switched.*off/)
    await finish(f, run.payload, 'completed', { text: 'Tidied what I could.' })

    const turn = await chat('Remind me in a minute and check the weather then', 'm1')
    f.bots.tools.reminders.add(botId, turn.activation.id, { dueAt: new Date(f.clock.now + 60_000).toISOString(), text: 'Checking.', work: { title: 'Weather', brief: 'Check the weather.' } })
    await finish(f, turn.payload, 'completed', { text: 'I will.' })
    f.clock.now += 2 * 60_000
    await f.bots.deliverDueReminders()
    const reminderWork = f.store.laneActivations(botId, 'run', ['running']).find((row) => row.idempotencyKey.startsWith('reminder:'))!
    const reminded = await start(f, reminderWork.id)
    heldToNothing(reminded.prepared)
    await finish(f, reminded.payload, 'completed', { text: 'Checked.' })
    expect(cards()).toHaveLength(before)
  })

  it('a turn resumed after Mousse restarts is held to what this computer allows now', async () => {
    await allowAll()
    const work = await run('w1')
    expect(work.prepared.authority.check(command('ls'))).toEqual({ ok: true })
    // Mousse stops mid-turn; while it is down the owner switches everything off.
    f.runs.markTerminal(work.payload.runId, 'interrupted', { interruptedBy: 'daemon_restart' })
    f.bots.close()
    limit = { ...BOT_COMPUTER_SHUT }
    f.bots = new BotEngine(f.host)
    await f.bots.reconcileOnStartup()
    await flush(12)
    const resumed = await start(f, work.id, 2)
    expect(resumed.prepared.prompt).toContain('Mousse restarted')
    heldToNothing(resumed.prepared)
    await finish(f, resumed.payload, 'completed', { text: 'Done what I could.' })
  })

  it('the bot is never told it has, or can ask for, what is switched off: its instructions and the answer to a wrong ask', async () => {
    limit = { ...BOT_COMPUTER_OPEN, files: false, browser: false }
    const turn = await chat('Hello', 'm1')
    const text = turn.prepared.instructions!
    expect(text).not.toMatch(/With the browser|the browser,|use files on this computer"/)
    expect(line(text, 'Use the browser')).toMatch(/off on this computer/)
    // What is on is still offered.
    expect(text).toContain('You can ask for "run commands"')
    // An ask written wrongly is answered with what can be asked for: never file access while files are off.
    const answer = turn.prepared.authority.escalate!({ permission: { nonsense: true } as never, reason: 'x' })
    expect(answer).toMatch(/Ask for a tool, a skill/)
    expect(answer).not.toMatch(/file access|folder path/)
    await finish(f, turn.payload, 'completed', { text: 'Hi.' })
    // The control: with files on, the same answer offers file access.
    limit = { ...BOT_COMPUTER_OPEN }
    const again = await chat('Hello again', 'm2')
    expect(again.prepared.authority.escalate!({ permission: { nonsense: true } as never, reason: 'x' })).toMatch(/file access \(any full folder path\)/)
    expect(again.prepared.instructions).toMatch(/With the browser/)
    await finish(f, again.payload, 'completed', { text: 'Hi.' })
  })

  it('commands or file access switched off: a turn that started with it stops at once, its chat says why, and the work goes on in a new turn without it', async () => {
    await allowAll()
    const work = await run('w1')
    const chatTurn = await chat('Hello', 'm1')
    const stopped = () => work.prepared.authority.time.signal.aborted
    // The browser is checked at every call of every runtime: switching it off stops nothing.
    limit = { ...limit, browser: false }
    f.bots.computerLimitChanged()
    expect(stopped()).toBe(false)
    // A command is running when the switch goes off: the stop cuts it off, its effect unknown.
    f.runs.tools.start({ invocationId: 'inv-bash', runId: work.payload.runId, attemptId: f.runs.getRun(work.payload.runId)!.activeAttemptId!, tool: 'bash', argsDigest: 'd', now: 'n', idempotent: false })
    // Commands off: the work started with them, so it stops now; the chat turn never holds commands and goes on.
    limit = { ...limit, shell: false }
    f.bots.computerLimitChanged()
    expect(stopped()).toBe(true)
    expect(chatTurn.prepared.authority.time.signal.aborted).toBe(false)
    expect(chatOf(f, botId).filter((message) => message.kind === 'notice').at(-1)).toMatchObject({ text: 'Stopped: "run commands" was switched off on this computer.' })
    // The runtime ends the turn as it does at a wall; the work goes on in its next turn, without commands. The command
    // the switch cut off holds nothing up: the next turn is told it was interrupted.
    await finish(f, work.payload, 'interrupted', { outcome: { interruptedBy: 'bot_wall' } })
    expect(f.store.activation(work.id)!.status).toBe('running')
    const next = await start(f, work.id, 2)
    expect(next.prepared.prompt).toMatch(/^\[Mousse\] "run commands" was switched off on this computer while you worked, so Mousse stopped your turn; you no longer have it here\. .*Continue where you left off, without it\. Interrupted tool calls .*bash/s)
    expect(next.prepared.policy.tools!.allow).not.toContain('bash')
    // File access off: the new turn started with it (a sandbox over every folder), so it stops too.
    limit = { ...limit, files: false }
    f.bots.computerLimitChanged()
    expect(next.prepared.authority.time.signal.aborted).toBe(true)
    await finish(f, next.payload, 'interrupted', { outcome: { interruptedBy: 'bot_wall' } })
    const third = await start(f, work.id, 3)
    expect(third.prepared.authority.workspace?.computer).toBeUndefined()
    // Switched off again while nothing holds it: nothing more stops.
    f.bots.computerLimitChanged()
    expect(third.prepared.authority.time.signal.aborted).toBe(false)
    await finish(f, third.payload, 'completed', { text: 'Done without them.' })
    expect(f.store.activation(work.id)!.status).toBe('done')
    await finish(f, chatTurn.payload, 'completed', { text: 'Hi.' })
  })

  it('a call of another power the stop cut off still holds the work for the owner, as after any interruption', async () => {
    await allowAll()
    const work = await run('w1')
    f.runs.tools.start({ invocationId: 'inv-edit', runId: work.payload.runId, attemptId: f.runs.getRun(work.payload.runId)!.activeAttemptId!, tool: 'edit', argsDigest: 'd', now: 'n', idempotent: false })
    limit = { ...limit, shell: false }
    f.bots.computerLimitChanged()
    await finish(f, work.payload, 'interrupted', { outcome: { interruptedBy: 'bot_wall' } })
    expect(f.store.activation(work.id)).toMatchObject({ status: 'paused', endReason: 'unknown_calls' })
  })

  /** The bot's published definition gains a context thread, so its turns can consult it. */
  function withDocsContext() {
    const definitions = f.host.definitions
    const current = definitions.revision(botId, f.store.registry(botId)!.revision!)!
    const published = definitions.publishRevision({ ...current, context: [{ key: 'docs', title: 'Docs expert', agent: { instructions: 'You know the docs.' }, model: { mode: 'auto', depth: 'normal' } }] })
    f.store.setPublished(botId, published.revision!)
  }

  it('commands switched off: a consult that holds them is stopped with its chat turn, which holds none, and the command it started holds nothing up', async () => {
    await allowAll()
    withDocsContext()
    const turn = await chat('What does the doc say?', 'm1')
    const stopped = () => turn.prepared.authority.time.signal.aborted
    expect(turn.prepared.policy.tools!.allow).not.toContain('bash')
    // Off and on again before any consult: the chat turn holds no commands, so nothing stops.
    limit = { ...limit, shell: false }
    f.bots.computerLimitChanged()
    limit = { ...limit, shell: true }
    f.bots.computerLimitChanged()
    expect(stopped()).toBe(false)
    // The consult starts now, with commands, and runs one.
    const asked = turn.prepared.authority.consult!({ context: 'docs', question: 'What does it say?' })
    void asked.catch(() => undefined)
    await flush()
    const consultN = f.store.dispatches(turn.activation.id).find((dispatch) => dispatch.kind === 'consult')!.n
    const consult = await start(f, turn.activation.id, consultN)
    expect(consult.prepared.authority.check(command('ls'))).toEqual({ ok: true })
    f.runs.tools.start({ invocationId: 'inv-consult-bash', runId: consult.payload.runId, attemptId: f.runs.getRun(consult.payload.runId)!.activeAttemptId!, tool: 'bash', argsDigest: 'd', now: 'n', idempotent: false })
    // Off again: the consult, and its turn with it, stop at once.
    limit = { ...limit, shell: false }
    f.bots.computerLimitChanged()
    expect(consult.prepared.authority.time.signal.aborted).toBe(true)
    expect(stopped()).toBe(true)
    expect(chatOf(f, botId).filter((message) => message.kind === 'notice').at(-1)).toMatchObject({ text: 'Stopped: "run commands" was switched off on this computer.' })
    await finish(f, consult.payload, 'interrupted', { outcome: { interruptedBy: 'bot_wall' } })
    await finish(f, turn.payload, 'interrupted', { outcome: { interruptedBy: 'bot_wall' } })
    // The consult's cut-off command was the switch's: the chat goes on in a new turn, told it was interrupted.
    expect(f.store.activation(turn.activation.id)!.status).toBe('running')
    const next = await start(f, turn.activation.id, f.store.lastMainDispatch(turn.activation.id)!.n)
    expect(next.prepared.prompt).toMatch(/switched off on this computer while you worked.*Interrupted tool calls .*bash \(consult run/s)
    await finish(f, next.payload, 'completed', { text: 'Here is what I know.' })
  })

  // Use files off clears only a cut-off file change it took away: one outside the bot's own folders. The rest keep the
  // rule of any interruption and wait for the owner.
  it.each([
    ['a change outside the bot\'s folders', 'write', 'outside', false],
    ['a change of the bot\'s own files', 'write', 'own', true],
    ['a change whose arguments differ from the one allowed', 'write', 'other', true],
    ['a command (Run commands is still on)', 'bash', 'outside', true]
  ] as const)('file access switched off: %s cut off by the stop', async (_name, tool, where, holds) => {
    await allowAll()
    const work = await run('w1')
    const outside = join(f.base, 'notes.md')
    const own = join(f.profile, 'bots', 'files', botId, 'list.md')
    for (const path of [outside, own]) expect(work.prepared.authority.check(write(path))).toEqual({ ok: true })
    const args = where === 'outside' ? { path: outside } : where === 'own' ? { path: own } : { path: outside, content: 'x' }
    f.runs.tools.start({ invocationId: 'inv-cut', runId: work.payload.runId, attemptId: f.runs.getRun(work.payload.runId)!.activeAttemptId!, tool, argsDigest: toolArgsDigest(tool === 'bash' ? { command: 'ls' } : args), now: 'n', idempotent: false })
    limit = { ...limit, files: false }
    f.bots.computerLimitChanged()
    expect(work.prepared.authority.time.signal.aborted).toBe(true)
    await finish(f, work.payload, 'interrupted', { outcome: { interruptedBy: 'bot_wall' } })
    if (holds) expect(f.store.activation(work.id)).toMatchObject({ status: 'paused', endReason: 'unknown_calls' })
    else expect(f.store.activation(work.id)!.status).toBe('running')
  })

  it('a turn that finished before the stop reached it is done, with nothing carried on', async () => {
    await allowAll()
    const work = await run('w1')
    limit = { ...limit, shell: false }
    f.bots.computerLimitChanged()
    await finish(f, work.payload, 'completed', { text: 'Done first.' })
    expect(f.store.activation(work.id)!.status).toBe('done')
    expect(f.store.dispatches(work.id).filter((dispatch) => dispatch.kind !== 'consult')).toHaveLength(1)
  })

  it('About reads again when a switch changes, and not on other saves', () => {
    const changed = vi.fn()
    f.host.changed = changed
    f.bots.computerLimitChanged()
    expect(changed).not.toHaveBeenCalled()
    limit = { ...limit, browser: false }
    f.bots.computerLimitChanged()
    expect(changed).toHaveBeenCalledWith({ botId })
  })
})
