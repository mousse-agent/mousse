/**
 * PR 6 §4 "Compile" and "Bot authority": a thread's grant compiles to the binding's policy (an
 * exact allowlist, host approvals, the bot authority's digest) and to the authority every check
 * point applies on every call. Nothing asks a person; a call outside the grant stops at a wall.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBotAuthority, pathFormWall, runtimeExpandedPath } from '../../src/mms/bots/authority/botAuthority'
import { botManifestDigest, compileBotThread, type CompileInput, type CompileResult } from '../../src/mms/bots/grants/compile'
import { BOT_ASKING_MODE_REQUIRED, BOT_RUNTIME_GAPS, botRuntimeGapReason, checkPolicy } from '../../src/mms/harness/policy'
import { PI_NATIVE_TOOLS } from '../../src/mms/harness/pi/nativeTools'
import type { BotAuthority } from '../../src/shared/bots/personal/authority'
import type { BotManifest } from '../../src/shared/bots/personal/definition'
import { botStarterManifest } from '../../src/shared/bots/personal/manifest'
import { botAppToolRefusal, checkBuiltinCall, wallMessage } from '../../src/shared/bots/personal/walls'
import type { HarnessCaps, RunPolicy } from '../../src/shared/harness/types'
import type { NeutralTool } from '../../src/shared/harness/tools'

let base: string
let root: string
let other: string
let scratch: string
let profile: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bot-authority-')))
  other = join(base, 'docs')
  profile = join(base, 'profile')
  // The bot's files folder: the one folder a bot has beside its scratch.
  root = join(profile, 'bots', 'files', 'b1')
  scratch = join(profile, 'bots', 'scratch', 'act-1')
  for (const dir of [root, other, join(scratch, 'tmp')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(root, 'index.html'), 'hi')
  writeFileSync(join(base, 'secret.txt'), 'no')
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

const manifest = (patch: Partial<BotManifest> = {}): BotManifest => ({
  tools: ['read', 'list', 'search', 'edit', 'write'],
  appTools: ['web_search'],
  mcp: [],
  skills: ['release-notes'],
  workspace: null,
  budget: { maxTurns: 40 },
  audience: 'owner',
  ...patch
})

const piNames = (tools: readonly NeutralTool[]) => ({ ok: true as const, names: tools.flatMap((tool) => [...(PI_NATIVE_TOOLS[tool] ?? [])]) })

const compile = (patch: Partial<CompileInput> = {}) => {
  const grant = patch.grant ?? manifest()
  return compileBotThread({
    grant,
    digest: botManifestDigest(grant),
    thread: {},
    scratch,
    filesFolder: root,
    profileHome: profile,
    nativeNames: piNames,
    remaining: { maxTurns: 40, deadlineMs: 600_000 },
    ...patch
  })
}

const authorityFor = (grant: BotManifest = manifest(), waiting = false, narrow?: CompileInput['thread']['narrow'], mcp: Array<`${string}::${string}`> = []): BotAuthority =>
  authorityOf(compile({ grant, thread: { narrow } }), waiting, mcp)

const authorityOf = (compiled: CompileResult, waiting = false, mcp: Array<`${string}::${string}`> = []): BotAuthority => {
  if (!compiled.ok) throw new Error(compiled.error.message)
  return createBotAuthority({
    activationId: 'act-1',
    role: 'activation',
    permissions: { ...compiled.permissions, mcp },
    waiting: () => waiting,
    counters: { charge: () => ({ ok: true, count: 1 }) },
    time: { deadline: () => 0, signal: new AbortController().signal },
    spend: null
  })
}

describe('compileBotThread', () => {
  it('compiles an exact allowlist, host approvals, the remaining budget and the bot authority', () => {
    const compiled = compile()
    if (!compiled.ok) throw new Error(compiled.error.message)
    expect(compiled.policy).toEqual({
      // Granted skills bring the skill tools.
      tools: { allow: ['edit', 'find', 'grep', 'skill_list', 'skill_load', 'ls', 'read', 'running_list', 'web_search', 'write'] },
      approvals: 'grants',
      approve: 'host',
      budget: { maxWallMs: 600_000, maxTurns: 40 },
      authority: { kind: 'bot', digest: botManifestDigest(manifest()) }
    })
    // Only the bot's own folders: its files folder and scratch, no root beyond them.
    expect(compiled.permissions.workspace).toEqual({ roots: [], access: 'read', writeRoots: [], scratch: realpathSync(scratch), files: root })
  })

  it('compiles "run commands" (shell) like any tool: the runtime\'s shell is on the allowlist', () => {
    const compiled = compile({ grant: manifest({ tools: ['read', 'shell'] }) })
    if (!compiled.ok) throw new Error(compiled.error.message)
    expect(compiled.policy.tools?.allow).toContain('bash')
    expect(compiled.permissions.tools).toEqual(['read', 'shell'])
  })

  it('a stored workspace opens no folder: it compiles as the grant without one', () => {
    const none = compile()
    if (!none.ok) throw new Error(none.error.message)
    for (const roots of [[other], [base], [join(profile, 'bots')], [process.platform === 'win32' ? 'C:\\' : '/']]) {
      const compiled = compile({ grant: manifest({ workspace: { roots, access: 'write' } }) })
      if (!compiled.ok) throw new Error(compiled.error.message)
      expect(compiled.permissions.workspace, roots[0]).toEqual(none.permissions.workspace)
    }
    // Without a files folder (a bot made before them), a stored workspace still gives no folder at all.
    expect(compile({ grant: manifest({ workspace: { roots: [other], access: 'write' } }), filesFolder: undefined })).toMatchObject({ ok: true, permissions: { workspace: null } })
  })

  it('refuses delegation and thread tools, even in a stored grant', () => {
    for (const tool of ['delegate_task', 'thread_fork', 'queue_enqueue', 'create_subagent', 'ask_user'])
      expect(compile({ grant: manifest({ appTools: [tool] }) }), tool).toMatchObject({ ok: false, error: { code: 'policy_unenforceable', reason: expect.stringContaining(tool) } })
  })

  it('compiles the owner\'s MCP tools for work and for a chat turn, which calls them within its budgets', () => {
    const grant = manifest({ mcp: [{ serverId: 'srv-1', tool: 'create_issue' }, { serverId: 'srv-1', tool: 'list_issues' }] })
    const work = compile({ grant })
    if (!work.ok) throw new Error(work.error.message)
    expect(work.permissions.mcp).toEqual(['srv-1::create_issue', 'srv-1::list_issues'])
    const chat = compile({ grant, botTools: { escalate: true, consult: false, memory: true, frontDesk: true } })
    if (!chat.ok) throw new Error(chat.error.message)
    expect(chat.permissions.mcp).toEqual(['srv-1::create_issue', 'srv-1::list_issues'])
    // The listing of the owner's servers is always on, in both lanes, and never in the grant.
    expect(chat.permissions.appTools).toContain('mcp_servers')
  })

  it('every skill unless switched off for the bot, and a thread narrowed to some skills has just those', () => {
    const all = compile({ grant: manifest({ skills: [] }), allSkills: true })
    if (!all.ok) throw new Error(all.error.message)
    expect(all.permissions).toMatchObject({ allSkills: true, skills: [], appTools: expect.arrayContaining(['skill_list', 'skill_load']) })
    expect(authorityOf(all).check({ kind: 'skill', skill: 'any-skill' })).toEqual({ ok: true })
    const narrowed = compile({ grant: manifest({ skills: [] }), allSkills: true, thread: { narrow: { skills: ['release-notes'] } } })
    if (!narrowed.ok) throw new Error(narrowed.error.message)
    expect(narrowed.permissions.allSkills).toBeUndefined()
    expect(narrowed.permissions.skills).toEqual(['release-notes'])
    expect(authorityOf(narrowed).check({ kind: 'skill', skill: 'any-skill' }).ok).toBe(false)
    const off = compile({ grant: manifest({ skills: [] }), thread: { narrow: { skills: ['release-notes'] } } })
    if (!off.ok) throw new Error(off.error.message)
    expect(off.permissions).toMatchObject({ skills: [], appTools: expect.not.arrayContaining(['skill_list']) })
  })

  it('offers secret_fetch with no grant, in work and in the chat', () => {
    const grant = manifest()
    for (const frontDesk of [false, true]) {
      const compiled = compile({ grant, botTools: { escalate: true, consult: false, memory: true, owner: true, frontDesk } })
      if (!compiled.ok) throw new Error(compiled.error.message)
      expect(compiled.permissions.appTools.includes('secret_fetch')).toBe(true)
    }
  })

  it('compiles the published revision held inside the grant: a narrower revision really narrows', () => {
    const grant = manifest({ budget: { maxTurns: 100 } })
    const revision = manifest({ tools: ['read'], appTools: [], budget: { maxTurns: 10 } })
    const compiled = compile({ grant, revision })
    if (!compiled.ok) throw new Error(compiled.error.message)
    expect(compiled.policy.tools).toEqual({ allow: ['skill_list', 'skill_load', 'read', 'running_list'] })
    expect(compiled.permissions).toMatchObject({ tools: ['read'], appTools: ['skill_list', 'skill_load', 'running_list'] })
    // A revision can never name more than the grant: what the grant lacks is dropped.
    const wider = compile({ grant: manifest({ tools: ['read'], appTools: [] }), revision: manifest({ tools: ['read', 'edit'] }) })
    if (!wider.ok) throw new Error(wider.error.message)
    expect(wider.permissions.tools).toEqual(['read'])
  })

  it('passes a runtime that lacks a tool through as its refusal', () => {
    const compiled = compile({
      grant: manifest({ tools: ['web_fetch'] }),
      nativeNames: () => ({ ok: false, error: { code: 'policy_unenforceable', message: 'no web_fetch', missing: ['toolControl'], reason: 'Pi has no tool for web_fetch.' } })
    })
    expect(compiled).toMatchObject({ ok: false, error: { reason: 'Pi has no tool for web_fetch.' } })
  })
})

describe('host approvals in checkPolicy', () => {
  const exact = { toolControl: 'exact', budgets: 'hard', spendLimits: 'reserved', planMode: false } as unknown as HarnessCaps
  const policy = (): RunPolicy => {
    const compiled = compile()
    if (!compiled.ok) throw new Error('compile')
    return { mode: 'default', origin: 'bot', ...compiled.policy }
  }

  it('holds only where the runtime holds every call to the bot authority', () => {
    expect(checkPolicy(exact, policy(), 'pi:x', undefined, { hostApprovals: true, botRuntimeGaps: [] })).toEqual({ ok: true })
    expect(checkPolicy(exact, policy(), 'pi:x', undefined, { botRuntimeGaps: [] })).toMatchObject({ ok: false, error: { missing: ['toolControl'] } })
    // A definition authority asking the host is still refused: nothing answers it there.
    expect(checkPolicy(exact, { ...policy(), authority: { kind: 'definition', digest: 'd' } }, 'pi:x', undefined, { hostApprovals: true, botRuntimeGaps: [] })).toMatchObject({ ok: false })
  })

  it('holds on an approval-based runtime only where the bot authority answers its approvals, and never on one that approves tools itself', () => {
    const approvalOnly = { ...exact, toolControl: 'approval_only' } as HarnessCaps
    // Claude Code and Codex: every approval they raise in a bot turn is answered by the authority.
    expect(checkPolicy(approvalOnly, policy(), 'claude', undefined, { hostApprovals: true, botApprovals: true, botRuntimeGaps: [] })).toEqual({ ok: true })
    // Without the driver answering them, nothing would: refused.
    expect(checkPolicy(approvalOnly, policy(), 'claude', undefined, { botRuntimeGaps: [] })).toMatchObject({ ok: false, error: { missing: ['toolControl'] } })
    // A runtime that holds bots only exactly (a locked entry on a version with no record) is refused there.
    expect(checkPolicy(approvalOnly, policy(), 'claude:locked', undefined, { hostApprovals: true, botRuntimeGaps: [] })).toMatchObject({ ok: false, error: { missing: ['toolControl'] } })
    // A runtime that approves tools itself never holds a bot, whatever its driver claims.
    const uncontrolled = { ...exact, toolControl: 'uncontrolled' } as HarnessCaps
    expect(checkPolicy(uncontrolled, policy(), 'cursor', undefined, { hostApprovals: true, botApprovals: true, botRuntimeGaps: [] })).toMatchObject({ ok: false, error: { missing: ['toolControl'] } })
    // A definition's authority still needs exact control there.
    expect(checkPolicy(approvalOnly, { ...policy(), authority: { kind: 'definition', digest: 'd' }, approve: undefined }, 'claude', undefined, { hostApprovals: true, botApprovals: true, botRuntimeGaps: [] })).toMatchObject({ ok: false, error: { missing: ['toolControl'] } })
  })

  it('runs a bot turn only in the asking mode, never a mode that runs calls without asking', () => {
    const approvalOnly = { ...exact, toolControl: 'approval_only' } as HarnessCaps
    expect(checkPolicy(approvalOnly, { ...policy(), permissionMode: 'ask' }, 'codex', undefined, { hostApprovals: true, botApprovals: true, botRuntimeGaps: [] })).toEqual({ ok: true })
    for (const mode of ['accept_edits', 'auto', 'full'] as const)
      expect(checkPolicy(approvalOnly, { ...policy(), permissionMode: mode }, 'codex', undefined, { hostApprovals: true, botApprovals: true, botRuntimeGaps: [] }), mode).toMatchObject({ ok: false, error: { missing: ['toolControl'], reason: BOT_ASKING_MODE_REQUIRED } })
  })

  it('a shell grant holds wherever a bot holds: Pi exactly, Claude Code and Codex through their approvals', () => {
    const compiled = compile({ grant: manifest({ tools: ['read', 'shell'] }) })
    if (!compiled.ok) throw new Error(compiled.error.message)
    const shell: RunPolicy = { mode: 'default', origin: 'bot', ...compiled.policy }
    expect(checkPolicy(exact, shell, 'pi:x', undefined, { hostApprovals: true })).toEqual({ ok: true })
    const approvalOnly = { ...exact, toolControl: 'approval_only' } as HarnessCaps
    for (const instance of ['claude', 'codex']) expect(checkPolicy(approvalOnly, { ...shell, permissionMode: 'ask' }, instance, undefined, { hostApprovals: true, botApprovals: true }), instance).toEqual({ ok: true })
  })

  it('still needs hard budgets for count limits', () => {
    const observed = { ...exact, budgets: 'observed' } as HarnessCaps
    expect(checkPolicy(observed, policy(), 'pi:x', undefined, { hostApprovals: true, botRuntimeGaps: [] })).toMatchObject({ ok: false, error: { missing: ['budgets'] } })
  })

  it('fail closed: no runtime runs a bot while bot runtimes still lack a piece, whatever its caps', () => {
    // None is missing since Bot Phase 1 (§5.9); the switch stays for a piece a later change needs.
    expect(BOT_RUNTIME_GAPS).toEqual([])
    expect(checkPolicy(exact, policy(), 'pi:x', undefined, { hostApprovals: true })).toEqual({ ok: true })
    const gaps = ['a piece bots rely on']
    const refused = checkPolicy(exact, policy(), 'pi:x', undefined, { hostApprovals: true, botRuntimeGaps: gaps })
    expect(refused).toMatchObject({ ok: false, error: { code: 'policy_unenforceable', missing: ['containment'], reason: botRuntimeGapReason(gaps) } })
    // Policies without a bot authority are untouched.
    expect(checkPolicy(exact, { mode: 'default', approvals: 'grants' })).toEqual({ ok: true })
  })
})

describe('the files folder under the starter grant', () => {
  it('the chat and its work both read, list, search, edit and write there, and nothing outside', () => {
    const files = join(profile, 'bots', 'files', 'b1')
    mkdirSync(files, { recursive: true })
    const list = join(files, 'lists', 'shopping.md')
    for (const frontDesk of [true, false]) {
      const grant = botStarterManifest()
      const compiled = compile({ grant, filesFolder: files, botTools: { escalate: true, consult: false, memory: true, frontDesk } })
      if (!compiled.ok) throw new Error(compiled.error.message)
      const bot = createBotAuthority({
        activationId: 'act-1', role: 'activation', permissions: compiled.permissions, waiting: () => false,
        counters: { charge: () => ({ ok: true, count: 1 }) }, time: { deadline: () => 0, signal: new AbortController().signal }, spend: null
      })
      for (const tool of ['read', 'list', 'search', 'edit', 'write'] as const)
        expect(bot.check({ kind: 'builtin', tool, nativeName: tool, args: { path: list } }), `${tool} frontDesk=${frontDesk}`).toEqual({ ok: true })
      expect(bot.check({ kind: 'builtin', tool: 'write', nativeName: 'write', args: { path: join(base, 'elsewhere.md') } })).toMatchObject({ ok: false, wall: { kind: 'path' } })
    }
  })
})

describe('BotAuthority.check', () => {
  const read = (path: string) => ({ kind: 'builtin' as const, tool: 'read' as const, nativeName: 'read', args: { path } })
  const edit = (path: string) => ({ kind: 'builtin' as const, tool: 'edit' as const, nativeName: 'edit', args: { path } })

  it('"run commands" is granted as a whole: any command, wherever it says it runs; without it, a wall on the tool', () => {
    const command = (args: Record<string, unknown>) => ({ kind: 'builtin' as const, tool: 'shell' as const, nativeName: 'bash', args })
    const granted = authorityFor(manifest({ tools: ['read', 'shell'] }))
    for (const args of [{ command: 'ls -la' }, { command: 'rm -rf build', cwd: join(base, 'elsewhere') }, { command: 'cat ~/.profile', cwd: '~' }])
      expect(granted.check(command(args)), JSON.stringify(args)).toEqual({ ok: true })
    // A bot with no folder at all still runs commands once it holds them.
    expect(authorityOf(compile({ grant: manifest({ tools: ['shell'] }), filesFolder: undefined })).check(command({ command: 'date' }))).toEqual({ ok: true })
    expect(authorityFor().check(command({ command: 'ls' }))).toEqual({ ok: false, wall: { kind: 'tool', tool: 'bash' } })
    // Waiting for the owner still stops it.
    expect(authorityFor(manifest({ tools: ['shell'] }), true).check(command({ command: 'ls' }))).toEqual({ ok: false, wall: { kind: 'waiting' } })
  })

  it('allows granted tools inside its files folder and inside scratch', () => {
    const bot = authorityFor()
    expect(bot.check(read(join(root, 'index.html')))).toEqual({ ok: true })
    expect(bot.check(edit(join(root, 'new.html')))).toEqual({ ok: true })
    expect(bot.check(edit(join(scratch, 'notes.md')))).toEqual({ ok: true })
    // A relative path is the scratch folder's (the turn's working directory).
    expect(bot.check(edit('notes.md'))).toEqual({ ok: true })
  })

  it('outside its files folder and scratch every file call is a path wall, even with a stored workspace', () => {
    const bot = authorityFor(manifest({ workspace: { roots: [other, base], access: 'write' } }))
    expect(bot.check(read(join(root, 'index.html')))).toEqual({ ok: true })
    for (const path of [join(other, 'a.md'), join(base, 'secret.txt'), join(profile, 'profile.json'), join(profile, 'bots', 'bots.db'), join(scratch, '..', 'act-2', 'x'), profile])
      for (const call of [read(path), edit(path)])
        expect(bot.check(call), `${call.tool} ${path}`).toMatchObject({ ok: false, wall: { kind: 'path', path } })
    // Git metadata in its own folder is never a file tool's to change.
    expect(bot.check(edit(join(root, '.git', 'config')))).toMatchObject({ ok: false, wall: { kind: 'path' } })
  })

  it('follows links: a link in its files folder that leads out is refused', () => {
    const link = join(root, 'escape')
    try {
      symlinkSync(profile, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      return // The platform does not let this process make links.
    }
    const bot = authorityFor()
    expect(bot.check(read(join(link, 'profile.json')))).toMatchObject({ ok: false, wall: { kind: 'path' } })
    expect(bot.check(edit(join(link, 'new.md')))).toMatchObject({ ok: false, wall: { kind: 'path' } })
  })

  it('Claude Code\'s own storage, recognised by its gate, is allowed outside the bot\'s folders', () => {
    const bot = authorityFor()
    const saved = '/home/me/.claude/projects/-x/session/tool-results/out.txt'
    expect(bot.check(read(saved))).toMatchObject({ ok: false, wall: { kind: 'path' } })
    expect(bot.check({ ...read(saved), own: true })).toEqual({ ok: true })
    // The tool must still be granted, and nothing runs while the activation waits.
    expect(authorityFor(manifest({ tools: ['web_search'] })).check({ ...read(saved), own: true })).toMatchObject({ ok: false, wall: { kind: 'tool' } })
    expect(authorityFor(manifest(), true).check({ ...read(saved), own: true })).toEqual({ ok: false, wall: { kind: 'waiting' } })
  })

  it('refuses an ungranted tool, skill, app tool and a same-named MCP tool on another server', () => {
    const bot = authorityFor(manifest({ tools: ['read'] }), false, undefined, ['github::create_issue'])
    expect(bot.check(edit(join(root, 'a')))).toEqual({ ok: false, wall: { kind: 'tool', tool: 'edit' } })
    expect(bot.check({ kind: 'skill', skill: 'deploy' })).toEqual({ ok: false, wall: { kind: 'skill', skill: 'deploy' } })
    expect(bot.check({ kind: 'skill', skill: 'release-notes' })).toEqual({ ok: true })
    expect(bot.check({ kind: 'app', tool: 'delegate_task', args: {} })).toEqual({ ok: false, wall: { kind: 'tool', tool: 'delegate_task' } })
    expect(bot.check({ kind: 'mcp', server: 'github', tool: 'create_issue', args: {} })).toEqual({ ok: true })
    expect(bot.check({ kind: 'mcp', server: 'gitlab', tool: 'create_issue', args: {} })).toEqual({ ok: false, wall: { kind: 'mcp', server: 'gitlab', tool: 'create_issue' } })
    // A separator in a call's parts never matches another pair.
    expect(bot.check({ kind: 'mcp', server: 'github::create', tool: 'issue', args: {} })).toMatchObject({ ok: false })
  })

  it('refuses everything while the activation waits for its owner', () => {
    expect(authorityFor(manifest(), true).check(read(join(root, 'index.html')))).toEqual({ ok: false, wall: { kind: 'waiting' } })
  })

  it('without a files folder (a bot made before them), file tools have no folder at all', () => {
    const bot = authorityOf(compile({ filesFolder: undefined }))
    expect(bot.check(read('notes.md'))).toMatchObject({ ok: false, wall: { kind: 'path' } })
  })

  it('a narrower thread holds only what is left, on every call', () => {
    const bot = authorityFor(manifest(), false, { tools: ['read'], skills: [] })
    expect(bot.check(read(join(root, 'index.html')))).toEqual({ ok: true })
    expect(bot.check(edit(join(root, 'index.html')))).toMatchObject({ ok: false, wall: { kind: 'tool' } })
    expect(bot.check({ kind: 'skill', skill: 'release-notes' })).toMatchObject({ ok: false })
  })
})

describe('the check points', () => {
  it('a runtime built-in is held to its neutral tool; one with no neutral name is never granted', () => {
    const bot = authorityFor(manifest({ tools: ['search'] }))
    expect(checkBuiltinCall(bot, PI_NATIVE_TOOLS, 'grep', { path: root })).toEqual({ ok: true })
    expect(checkBuiltinCall(bot, PI_NATIVE_TOOLS, 'find', { path: join(base, 'secret.txt') })).toMatchObject({ ok: false, wall: { kind: 'path' } })
    expect(checkBuiltinCall(bot, PI_NATIVE_TOOLS, 'powershell', {})).toEqual({ ok: false, wall: { kind: 'tool', tool: 'powershell' } })
    expect(checkBuiltinCall(bot, PI_NATIVE_TOOLS, 'read', { path: join(root, 'index.html') })).toEqual({ ok: false, wall: { kind: 'tool', tool: 'read' } })
  })

  it('the registry refuses an ungranted app tool and skill, in plain words', () => {
    const bot = authorityFor()
    expect(botAppToolRefusal(bot, 'web_search', {})).toBeUndefined()
    expect(botAppToolRefusal(bot, 'delegate_task', {})).toBe('This bot is not allowed to use delegate_task.')
    expect(botAppToolRefusal(bot, 'skill_load', { skill: 'release-notes' })).toBeUndefined()
    // Which skill loads is held by the turn's own skills (granted ids only), by id or by name.
    expect(botAppToolRefusal(bot, 'skill_load', { skill: 'Release Notes' })).toBeUndefined()
    expect(botAppToolRefusal(authorityFor(manifest({ skills: [] })), 'skill_load', { skill: 'release-notes' })).toBe('This bot is not allowed to use skill_load.')
    expect(botAppToolRefusal(authorityFor(manifest({ skills: [] })), 'skill_list', {})).toBe('This bot is not allowed to use skill_list.')
  })
})

describe('paths a runtime rewrites before it opens them (PR 6 review M1)', () => {
  it('a home-folder, `@` or variable path is walled for every built-in, on Pi and on Claude Code', () => {
    const bot = authorityFor()
    const claude = { read: ['Read'], list: ['Glob'], search: ['Glob', 'Grep'], edit: ['Edit'], write: ['Write'] }
    const cases: Array<[typeof PI_NATIVE_TOOLS | typeof claude, string, Record<string, unknown>]> = [
      // Claude Code expands `~` in Grep's and Glob's `path`; for a bot it would resolve into scratch here.
      [claude, 'Grep', { pattern: 'x', path: '~' }],
      [claude, 'Glob', { pattern: '*', path: '~/.ssh' }],
      [claude, 'Read', { file_path: '~\\secret.txt' }],
      [claude, 'Edit', { file_path: '~/x', old_string: 'a', new_string: 'b' }],
      [claude, 'Write', { file_path: '~other/x', content: 'x' }],
      [claude, 'Read', { file_path: '$HOME/.aws/credentials' }],
      [claude, 'Read', { file_path: '${HOME}/x' }],
      // Pi expands `~` and strips a leading `@`.
      [PI_NATIVE_TOOLS, 'read', { path: '@/etc/passwd' }],
      [PI_NATIVE_TOOLS, 'grep', { pattern: 'x', path: '~' }],
      [PI_NATIVE_TOOLS, 'write', { path: '@notes.md', content: 'x' }]
    ]
    // A path to give in full, with or without a files folder: no permission would let the bot use it as written.
    const without = authorityOf(compile({ filesFolder: undefined }))
    for (const [table, name, args] of cases) {
      expect(checkBuiltinCall(bot, table, name, args), `${name} ${JSON.stringify(args)}`).toMatchObject({ ok: false, wall: { kind: 'path_form' } })
      expect(checkBuiltinCall(without, table, name, args), `${name} ${JSON.stringify(args)}`).toMatchObject({ ok: false, wall: { kind: 'path_form' } })
    }
    // A real path outside the bot's folders is a path wall.
    expect(checkBuiltinCall(without, claude, 'Read', { file_path: join(base, 'elsewhere', 'x.txt') })).toMatchObject({ ok: false, wall: { kind: 'path' } })
    // A real path in scratch or the root still passes.
    expect(checkBuiltinCall(bot, claude, 'Grep', { pattern: 'x', path: root })).toEqual({ ok: true })
    expect(checkBuiltinCall(bot, PI_NATIVE_TOOLS, 'write', { path: join(scratch, 'notes.md'), content: 'x' })).toEqual({ ok: true })
  })

  it('the refusal gives the owner’s home folder, and the full path for ~ and $HOME', () => {
    const home = join(base, 'home', 'ada')
    const text = (path: string) => wallMessage(pathFormWall('Read', path, home))
    expect(text('~/Notes/todo.md')).toBe(`Give ~/Notes/todo.md as a full path, without ~ or variables: ${join(home, 'Notes', 'todo.md')}`)
    expect(text('~')).toBe(`Give ~ as a full path, without ~ or variables: ${home}`)
    expect(text('$HOME/x')).toBe(`Give $HOME/x as a full path, without ~ or variables: ${join(home, 'x')}`)
    expect(text('${HOME}/x')).toBe(`Give \${HOME}/x as a full path, without ~ or variables: ${join(home, 'x')}`)
    expect(text('~other/x')).toBe(`Give ~other/x as a full path, without ~ or variables. Your owner's home folder is ${home}.`)
    expect(text('$TMPDIR/x')).toBe(`Give $TMPDIR/x as a full path, without ~ or variables. Your owner's home folder is ${home}.`)
    expect(text('@notes.md')).toBe('Give @notes.md as a full path, without ~ or variables.')
    // The live check names the real home folder of this computer.
    expect(checkBuiltinCall(authorityFor(), PI_NATIVE_TOOLS, 'read', { path: '~/x' })).toMatchObject({ ok: false, wall: { kind: 'path_form', home: homedir(), full: join(homedir(), 'x') } })
  })

  it('names what each runtime rewrites, by platform', () => {
    for (const path of ['~', '~/x', '~\\x', '~user/x', '@x', ' ~/x', '$HOME/x', '${HOME}/x'])
      expect(runtimeExpandedPath(path, 'linux'), path).toBe(true)
    for (const path of ['%USERPROFILE%\\x', '/c/Users/x', '/C'])
      expect([path, runtimeExpandedPath(path, 'win32'), runtimeExpandedPath(path, 'linux')], path).toEqual([path, true, false])
    for (const path of ['/srv/site/a~b', 'notes@2.md', 'cost$.txt', 'a/b', '.', '..', '../x', 'a/./b', '.hidden/x', 'file.txt'])
      expect(runtimeExpandedPath(path, 'win32'), path).toBe(false)
  })

  it('a path padded with whitespace, holding a control character, or with a segment ending in a space or dot is walled (review r2)', () => {
    // Claude Code's resolver trims (JS `trim`, every Unicode space); Windows drops trailing spaces and dots.
    const padded = [' /etc', '/etc ', '\t../outside', ' ../outside', '..\n', '.. ', `${root}${sep}.. `, `\n${base}\n`, ' /etc', '﻿/etc', 'a\u0000b', 'a\u001fb', 'sub/.. /x', 'x.', 'dir./a', 'a /b', '...']
    for (const path of padded) expect(runtimeExpandedPath(path, 'linux'), JSON.stringify(path)).toBe(true)
    const bot = authorityFor()
    const claude = { search: ['Glob', 'Grep'], read: ['Read'] }
    for (const path of [` ${base}`, `${root}${sep}.. `, ' ../secret.txt', '\t..', '.. ', `\n${base}\n`]) {
      expect(checkBuiltinCall(bot, claude, 'Grep', { pattern: 'x', path }), JSON.stringify(path)).toMatchObject({ ok: false, wall: { kind: 'path_form' } })
      expect(checkBuiltinCall(bot, PI_NATIVE_TOOLS, 'read', { path }), JSON.stringify(path)).toMatchObject({ ok: false, wall: { kind: 'path_form' } })
    }
  })
})

describe('onAllowed (Bot Phase 1 §5.8)', () => {
  const observed = (onAllowed: (call: unknown) => void) => {
    const compiled = compile()
    if (!compiled.ok) throw new Error(compiled.error.message)
    return createBotAuthority({
      activationId: 'act-1',
      role: 'activation',
      permissions: compiled.permissions,
      waiting: () => false,
      counters: { charge: () => ({ ok: true, count: 1 }) },
      time: { deadline: () => 0, signal: new AbortController().signal },
      spend: null,
      onAllowed
    })
  }

  it('is told of every allowed call, on any runtime, and of no refused one', () => {
    const calls: unknown[] = []
    const authority = observed((call) => calls.push(call))
    const read = { kind: 'builtin' as const, tool: 'read' as const, nativeName: 'read', args: { path: join(root, 'index.html') } }
    expect(authority.check(read)).toEqual({ ok: true })
    expect(authority.check({ kind: 'app', tool: 'web_search', args: { query: 'x' } })).toEqual({ ok: true })
    expect(authority.check({ kind: 'builtin', tool: 'read', nativeName: 'read', args: { path: join(profile, 'profile.json') } }).ok).toBe(false)
    expect(authority.check({ kind: 'app', tool: 'delegate_task', args: {} }).ok).toBe(false)
    expect(calls).toEqual([read, { kind: 'app', tool: 'web_search', args: { query: 'x' } }])
  })

  it('never fails the call it watched', () => {
    const authority = observed(() => {
      throw new Error('broken sink')
    })
    expect(authority.check({ kind: 'app', tool: 'web_search', args: {} })).toEqual({ ok: true })
  })
})
