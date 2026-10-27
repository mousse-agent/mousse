/**
 * PR 6 §4 "Compile" and "Bot authority": a thread's grant compiles to the binding's policy (an
 * exact allowlist, host approvals, the bot authority's digest) and to the authority every check
 * point applies on every call. Nothing asks a person; a call outside the grant stops at a wall.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import { botManifestDigest, compileBotThread, type CompileInput } from '../../src/mms/bots/grants/compile'
import { checkPolicy } from '../../src/mms/harness/policy'
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
  appTools: ['thread_read'],
  mcp: [{ serverId: 'github', tool: 'create_issue' }],
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

const authorityFor = (grant: BotManifest = manifest(), waiting = false, narrow?: CompileInput['thread']['narrow']): BotAuthority => {
  const compiled = compile({ grant, thread: { narrow } })
  if (!compiled.ok) throw new Error(compiled.error.message)
  return createBotAuthority({
    activationId: 'act-1',
    role: 'activation',
    permissions: compiled.permissions,
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
      tools: { allow: ['edit', 'find', 'grep', 'ls', 'mcp__github__create_issue', 'read', 'thread_read', 'write'] },
      approvals: 'grants',
      approve: 'host',
      budget: { maxWallMs: 600_000, maxTurns: 40 },
      authority: { kind: 'bot', digest: botManifestDigest(manifest()) }
    })
    expect(compiled.permissions.workspace).toEqual({ roots: [root], access: 'write', scratch: realpathSync(scratch) })
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
    expect(checkPolicy(exact, policy(), 'pi:x', undefined, { hostApprovals: true })).toEqual({ ok: true })
    expect(checkPolicy(exact, policy(), 'pi:x')).toMatchObject({ ok: false, error: { missing: ['toolControl'] } })
    // A definition authority asking the host is still refused: nothing answers it there.
    expect(checkPolicy(exact, { ...policy(), authority: { kind: 'definition', digest: 'd' } }, 'pi:x', undefined, { hostApprovals: true })).toMatchObject({ ok: false })
  })

  it('still needs exact tool control and hard budgets', () => {
    const approvalOnly = { ...exact, toolControl: 'approval_only' } as HarnessCaps
    expect(checkPolicy(approvalOnly, policy(), 'claude', undefined, { hostApprovals: true })).toMatchObject({ ok: false, error: { missing: ['toolControl'] } })
    const observed = { ...exact, budgets: 'observed' } as HarnessCaps
    expect(checkPolicy(observed, policy(), 'pi:x', undefined, { hostApprovals: true })).toMatchObject({ ok: false, error: { missing: ['budgets'] } })
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
    const bot = authorityFor(manifest({ tools: ['read'] }))
    expect(bot.check(edit(join(root, 'a')))).toEqual({ ok: false, wall: { kind: 'tool', tool: 'edit' } })
    expect(bot.check({ kind: 'skill', skill: 'deploy' })).toEqual({ ok: false, wall: { kind: 'skill', skill: 'deploy' } })
    expect(bot.check({ kind: 'skill', skill: 'release-notes' })).toEqual({ ok: true })
    expect(bot.check({ kind: 'app', tool: 'delegate_task', args: {} })).toEqual({ ok: false, wall: { kind: 'tool', tool: 'delegate_task' } })
    expect(bot.check({ kind: 'mcp', server: 'github', tool: 'create_issue', args: {} })).toEqual({ ok: true })
    expect(bot.check({ kind: 'mcp', server: 'gitlab', tool: 'create_issue', args: {} })).toEqual({ ok: false, wall: { kind: 'mcp', server: 'gitlab', tool: 'create_issue' } })
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
    expect(botAppToolRefusal(bot, 'thread_read', {})).toBeUndefined()
    expect(botAppToolRefusal(bot, 'delegate_task', {})).toBe('This bot is not allowed to use delegate_task.')
    expect(botAppToolRefusal(bot, 'load_skill', { skill: 'release-notes' })).toBeUndefined()
    expect(botAppToolRefusal(bot, 'load_skill', { skill: 'deploy' })).toBe('This bot is not allowed to use the skill deploy.')
    expect(botAppToolRefusal(authorityFor(manifest({ skills: [] })), 'list_skills', {})).toBe('This bot is not allowed to use list_skills.')
  })
})
