/**
 * PR 6 §4 "Compile" and "Bot authority": a thread's grant compiles to the binding's policy (an
 * exact allowlist, host approvals, the bot authority's digest) and to the authority every check
 * point applies on every call. Nothing asks a person; a call outside the grant stops at a wall.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBotAuthority, runtimeExpandedPath } from '../../src/mms/bots/authority/botAuthority'
import { botManifestDigest, compileBotThread, type CompileInput } from '../../src/mms/bots/grants/compile'
import { BOT_RUNTIME_GAPS, botRuntimeGapReason, checkPolicy } from '../../src/mms/harness/policy'
import { PI_NATIVE_TOOLS } from '../../src/mms/harness/pi/nativeTools'
import type { BotAuthority } from '../../src/shared/bots/personal/authority'
import type { BotManifest } from '../../src/shared/bots/personal/definition'
import { botAppToolRefusal, checkBuiltinCall } from '../../src/shared/bots/personal/walls'
import type { HarnessCaps, RunPolicy } from '../../src/shared/harness/types'
import type { NeutralTool } from '../../src/shared/harness/tools'

let base: string
let root: string
let other: string
let scratch: string
let profile: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bot-authority-')))
  root = join(base, 'site')
  other = join(base, 'docs')
  profile = join(base, 'profile')
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
  workspace: { roots: [root], access: 'write' },
  budget: { maxActiveMs: 15 * 60_000, maxTurns: 40 },
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
    profileHome: profile,
    nativeNames: piNames,
    remaining: { maxTurns: 40, deadlineMs: 600_000 },
    temps: [join(base, 'tmp-root')],
    ...patch
  })
}

const authorityFor = (grant: BotManifest = manifest(), waiting = false, narrow?: CompileInput['thread']['narrow'], mcp: Array<`${string}::${string}`> = []): BotAuthority => {
  const compiled = compile({ grant, thread: { narrow } })
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
      tools: { allow: ['edit', 'find', 'grep', 'list_skills', 'load_skill', 'ls', 'read', 'web_search', 'write'] },
      approvals: 'grants',
      approve: 'host',
      budget: { maxWallMs: 600_000, maxTurns: 40 },
      authority: { kind: 'bot', digest: botManifestDigest(manifest()) }
    })
    expect(compiled.permissions.workspace).toEqual({ roots: [root], access: 'write', writeRoots: [root], scratch: realpathSync(scratch) })
  })

  it('refuses shell: no runtime has a proven sandbox here', () => {
    const compiled = compile({ grant: manifest({ tools: ['read', 'shell'] }) })
    expect(compiled).toMatchObject({ ok: false, error: { code: 'policy_unenforceable', missing: ['containment'] } })
  })

  it('refuses a write root inside a temporary folder, and roots overlapping Mousse data or scratch', () => {
    const temp = join(base, 'tmp-root', 'work')
    mkdirSync(temp, { recursive: true })
    expect(compile({ grant: manifest({ workspace: { roots: [temp], access: 'write' } }) })).toMatchObject({ ok: false, error: { reason: expect.stringContaining('temporary folder') } })
    // Reading from a temporary folder is fine.
    expect(compile({ grant: manifest({ workspace: { roots: [temp], access: 'read' } }) }).ok).toBe(true)
    expect(compile({ grant: manifest({ workspace: { roots: [base], access: 'read' } }) })).toMatchObject({ ok: false, error: { reason: expect.stringContaining('scratch') } })
    expect(compile({ grant: manifest({ workspace: { roots: [join(profile, 'bots')], access: 'read' } }) })).toMatchObject({ ok: false })
  })

  it('refuses delegation and thread tools, and user MCP tools, even in a stored grant', () => {
    for (const tool of ['delegate_task', 'thread_fork', 'queue_enqueue', 'create_subagent', 'ask_user'])
      expect(compile({ grant: manifest({ appTools: [tool] }) }), tool).toMatchObject({ ok: false, error: { code: 'policy_unenforceable', reason: expect.stringContaining(tool) } })
    expect(compile({ grant: manifest({ mcp: [{ serverId: 'github', tool: 'create_issue' }] }) })).toMatchObject({ ok: false, error: { missing: ['mcp'], reason: 'Your MCP tools are not available to bots yet.' } })
  })

  it('compiles the published revision held inside the grant: a narrower revision really narrows', () => {
    const grant = manifest({ workspace: { roots: [root, other], access: 'write' }, budget: { maxActiveMs: 60 * 60_000, maxTurns: 100 } })
    const revision = manifest({ tools: ['read'], appTools: [], workspace: { roots: [root], access: 'read' }, budget: { maxActiveMs: 5 * 60_000, maxTurns: 10 } })
    const compiled = compile({ grant, revision })
    if (!compiled.ok) throw new Error(compiled.error.message)
    expect(compiled.policy.tools).toEqual({ allow: ['list_skills', 'load_skill', 'read'] })
    expect(compiled.permissions).toMatchObject({ tools: ['read'], appTools: ['list_skills', 'load_skill'], workspace: { roots: [root], access: 'read' } })
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

  it('still needs exact tool control and hard budgets', () => {
    const approvalOnly = { ...exact, toolControl: 'approval_only' } as HarnessCaps
    expect(checkPolicy(approvalOnly, policy(), 'claude', undefined, { hostApprovals: true, botRuntimeGaps: [] })).toMatchObject({ ok: false, error: { missing: ['toolControl'] } })
    const observed = { ...exact, budgets: 'observed' } as HarnessCaps
    expect(checkPolicy(observed, policy(), 'pi:x', undefined, { hostApprovals: true, botRuntimeGaps: [] })).toMatchObject({ ok: false, error: { missing: ['budgets'] } })
  })

  it('fail closed: no runtime runs a bot while bot runtimes still lack a piece, whatever its caps', () => {
    expect(BOT_RUNTIME_GAPS.length).toBeGreaterThan(0)
    const refused = checkPolicy(exact, policy(), 'pi:x', undefined, { hostApprovals: true })
    expect(refused).toMatchObject({ ok: false, error: { code: 'policy_unenforceable', missing: ['containment'], reason: botRuntimeGapReason(BOT_RUNTIME_GAPS) } })
    // Policies without a bot authority are untouched.
    expect(checkPolicy(exact, { mode: 'default', approvals: 'grants' })).toEqual({ ok: true })
  })
})

describe('BotAuthority.check', () => {
  const read = (path: string) => ({ kind: 'builtin' as const, tool: 'read' as const, nativeName: 'read', args: { path } })
  const edit = (path: string) => ({ kind: 'builtin' as const, tool: 'edit' as const, nativeName: 'edit', args: { path } })

  it('allows granted tools inside a root and inside scratch', () => {
    const bot = authorityFor()
    expect(bot.check(read(join(root, 'index.html')))).toEqual({ ok: true })
    expect(bot.check(edit(join(root, 'new.html')))).toEqual({ ok: true })
    expect(bot.check(edit(join(scratch, 'notes.md')))).toEqual({ ok: true })
    // A relative path is the scratch folder's (the turn's working directory).
    expect(bot.check(edit('notes.md'))).toEqual({ ok: true })
  })

  it('checks every root of a multi-root grant, and nothing outside them', () => {
    const bot = authorityFor(manifest({ workspace: { roots: [root, other], access: 'read' } }))
    expect(bot.check(read(join(other, 'a.md')))).toEqual({ ok: true })
    expect(bot.check(read(join(base, 'secret.txt')))).toEqual({ ok: false, wall: { kind: 'path', tool: 'read', path: join(base, 'secret.txt'), access: 'read' } })
    expect(bot.check(read(join(root, '..', 'secret.txt')))).toMatchObject({ ok: false, wall: { kind: 'path' } })
  })

  it('follows links: a link inside a root that leads out is refused', () => {
    const link = join(root, 'escape')
    try {
      symlinkSync(base, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      return // The platform does not let this process make links.
    }
    const bot = authorityFor()
    expect(bot.check(read(join(link, 'secret.txt')))).toMatchObject({ ok: false, wall: { kind: 'path' } })
  })

  it('a read-only grant refuses writes in the root, but scratch stays writable', () => {
    const bot = authorityFor(manifest({ workspace: { roots: [root], access: 'read' } }))
    expect(bot.check(read(join(root, 'index.html')))).toEqual({ ok: true })
    expect(bot.check(edit(join(root, 'index.html')))).toEqual({ ok: false, wall: { kind: 'path', tool: 'edit', path: join(root, 'index.html'), access: 'write' } })
    expect(bot.check(edit(join(scratch, 'draft.md')))).toEqual({ ok: true })
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

  it('without file access, file tools have no folder at all', () => {
    const bot = authorityFor(manifest({ workspace: null }))
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
    expect(botAppToolRefusal(bot, 'load_skill', { skill: 'release-notes' })).toBeUndefined()
    // Which skill loads is held by the turn's own skills (granted ids only), by id or by name.
    expect(botAppToolRefusal(bot, 'load_skill', { skill: 'Release Notes' })).toBeUndefined()
    expect(botAppToolRefusal(authorityFor(manifest({ skills: [] })), 'load_skill', { skill: 'release-notes' })).toBe('This bot is not allowed to use load_skill.')
    expect(botAppToolRefusal(authorityFor(manifest({ skills: [] })), 'list_skills', {})).toBe('This bot is not allowed to use list_skills.')
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
    for (const [table, name, args] of cases)
      expect(checkBuiltinCall(bot, table, name, args), `${name} ${JSON.stringify(args)}`).toMatchObject({ ok: false, wall: { kind: 'path' } })
    // A real path in scratch or the root still passes.
    expect(checkBuiltinCall(bot, claude, 'Grep', { pattern: 'x', path: root })).toEqual({ ok: true })
    expect(checkBuiltinCall(bot, PI_NATIVE_TOOLS, 'write', { path: join(scratch, 'notes.md'), content: 'x' })).toEqual({ ok: true })
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
      expect(checkBuiltinCall(bot, claude, 'Grep', { pattern: 'x', path }), JSON.stringify(path)).toMatchObject({ ok: false, wall: { kind: 'path' } })
      expect(checkBuiltinCall(bot, PI_NATIVE_TOOLS, 'read', { path }), JSON.stringify(path)).toMatchObject({ ok: false, wall: { kind: 'path' } })
    }
  })
})
