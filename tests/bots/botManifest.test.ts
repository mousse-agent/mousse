/**
 * PR 6 §4 "Approval": a manifest is approved once by the digest of its canonical form; a revision
 * whose manifest is a subset of the active grant runs without asking, and a wider one lists only
 * what it adds. Nothing is approved automatically.
 */
import { describe, expect, it } from 'vitest'
import { botManifestDigest } from '../../src/mms/bots/grants/compile'
import { foldersOf, type BotManifest } from '../../src/shared/bots/personal/definition'
import { filesAsk, withPermission } from '../../src/shared/bots/personal/escalation'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import { compileBotThread } from '../../src/mms/bots/grants/compile'
import { claudeLockedSandbox } from '../../src/mms/harness/claude/locked'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addedPermissions, BOT_APP_TOOLS, BOT_DEFAULT_APP_TOOLS, botStarterManifest, canonicalManifest, describeManifest, intersectManifest, isAbsolutePath, isOwnBotAppTool, manifestProblem, manifestSubset, narrowManifest } from '../../src/shared/bots/personal/manifest'
import { BOT_MEMORY_TOOLS } from '../../src/shared/bots/personal/memory'

const manifest = (patch: Partial<BotManifest> = {}): BotManifest => ({
  tools: ['read', 'edit'],
  appTools: [],
  mcp: [{ serverId: 'github', tool: 'create_issue' }],
  skills: ['release-notes'],
  workspace: { roots: ['/home/me/proj/site'], access: 'write' },
  budget: { maxActiveMs: 15 * 60_000 },
  audience: 'owner',
  ...patch
})

describe('botManifestDigest', () => {
  it('is the same for the same grant in any order, with duplicates and absent limits', () => {
    const a = manifest()
    const b = manifest({
      tools: ['edit', 'read', 'edit'],
      mcp: [{ serverId: 'github', tool: 'create_issue' }, { serverId: 'github', tool: 'create_issue' }],
      budget: { maxActiveMs: 15 * 60_000, maxTurns: undefined }
    })
    expect(botManifestDigest(a)).toBe(botManifestDigest(b))
    expect(botManifestDigest(a)).toMatch(/^[a-f0-9]{64}$/)
    expect(canonicalManifest(b).tools).toEqual(['edit', 'read'])
  })

  it('changes with any permission or limit', () => {
    const base = botManifestDigest(manifest())
    expect(botManifestDigest(manifest({ tools: ['read'] }))).not.toBe(base)
    expect(botManifestDigest(manifest({ workspace: { roots: ['/home/me/proj/site'], access: 'read' } }))).not.toBe(base)
    expect(botManifestDigest(manifest({ budget: { maxActiveMs: 10 * 60_000 } }))).not.toBe(base)
    expect(botManifestDigest(manifest({ mcp: [{ serverId: 'gitlab', tool: 'create_issue' }] }))).not.toBe(base)
  })
})

describe('the subset rule', () => {
  const granted = manifest({ budget: { maxActiveMs: 15 * 60_000, maxTurns: 40 } })

  it('a narrower revision runs without asking', () => {
    const narrower = manifest({ tools: ['read'], mcp: [], skills: [], workspace: { roots: ['/home/me/proj/site'], access: 'read' }, budget: { maxActiveMs: 5 * 60_000, maxTurns: 10 } })
    expect(manifestSubset(narrower, granted)).toBe(true)
    expect(addedPermissions(narrower, granted)).toEqual([])
    expect(manifestSubset(granted, granted)).toBe(true)
  })

  it('a wider revision lists only what it adds, in plain words', () => {
    const wider = manifest({
      tools: ['read', 'edit', 'write'],
      mcp: [{ serverId: 'github', tool: 'create_issue' }, { serverId: 'github', tool: 'merge_pr' }],
      skills: ['release-notes', 'changelog'],
      workspace: { roots: ['/home/me/proj/site', '/home/me/proj/docs'], access: 'write' },
      budget: { maxActiveMs: 30 * 60_000, maxTurns: 40 }
    })
    expect(manifestSubset(wider, granted)).toBe(false)
    // File access is one permission, granted already: another folder adds nothing.
    expect(addedPermissions(wider, granted).map((line) => line.text)).toEqual([
      'Create and overwrite files',
      'Use the github tool `merge_pr`',
      'Use the skill *changelog*',
      'Up to 30 minutes of work per run'
    ])
  })

  it('file access is one addition: once granted, no folder or access adds anything', () => {
    const readOnly = manifest({ workspace: { roots: ['/home/me/proj/site'], access: 'read' } })
    expect(addedPermissions(manifest(), readOnly)).toEqual([])
    expect(manifestSubset(manifest({ workspace: { roots: ['/'], access: 'write' } }), readOnly)).toBe(true)
    expect(addedPermissions(manifest(), manifest({ workspace: null })).map((line) => line.text)).toEqual(['Use files on this computer'])
  })

  it('dropping a limit the grant has is wider, never a subset', () => {
    const unlimited = manifest({ budget: { maxActiveMs: 15 * 60_000 } })
    expect(manifestSubset(unlimited, granted)).toBe(false)
    expect(addedPermissions(unlimited, granted).map((line) => line.text)).toEqual(['No limit on model requests (retries included)'])
  })

  it('with nothing granted, everything is listed', () => {
    expect(addedPermissions(manifest(), null)).toEqual(describeManifest(manifest()))
    expect(describeManifest(manifest()).map((line) => line.text)).toEqual([
      'Use files on this computer',
      'Read files',
      'Edit files',
      'Use the github tool `create_issue`',
      'Use the skill *release-notes*',
      'Up to 15 minutes of work per run'
    ])
  })
})

describe('narrowManifest', () => {
  it('only removes permissions', () => {
    const narrowed = narrowManifest(manifest(), {
      tools: ['read', 'shell'],
      mcp: [{ serverId: 'gitlab', tool: 'create_issue' }],
      workspace: { roots: ['/home/me/proj/site', '/etc'], access: 'write' }
    })
    expect(narrowed.tools).toEqual(['read'])
    expect(narrowed.mcp).toEqual([])
    expect(narrowed.skills).toEqual(['release-notes'])
    expect(narrowed.workspace).toEqual({ roots: ['/home/me/proj/site'], access: 'write' })
    expect(narrowManifest(manifest({ workspace: { roots: ['/a'], access: 'read' } }), { workspace: { roots: ['/a'], access: 'write' } }).workspace).toEqual({ roots: ['/a'], access: 'read' })
    expect(narrowManifest(manifest(), { workspace: null }).workspace).toBeNull()
  })
})

/** A folder that is absolute on the platform running the tests (on Windows `/x` is not). */
const SITE = process.platform === 'win32' ? 'C:\\home\\me\\proj\\site' : '/home/me/proj/site'
const valid = (patch: Partial<BotManifest> = {}): BotManifest => manifest({ workspace: { roots: [SITE], access: 'write' }, ...patch })

describe('full folder paths', () => {
  it('names exactly the folder shown: absolute on the platform, with no . or .. part', () => {
    expect(isAbsolutePath('/home/me/site', 'linux')).toBe(true)
    expect(isAbsolutePath('/home/me/../site', 'linux')).toBe(false)
    expect(isAbsolutePath('/home/./site', 'linux')).toBe(false)
    expect(isAbsolutePath('C:\\Users\\me', 'win32')).toBe(true)
    // On Windows `/x` is relative to the current drive.
    expect(isAbsolutePath('/x', 'win32')).toBe(false)
    expect(isAbsolutePath('C:\\Users\\..\\Windows', 'win32')).toBe(false)
    expect(isAbsolutePath('\\\\server\\share\\dir', 'win32')).toBe(true)
  })
})

describe('manifestProblem', () => {
  it('accepts a well-formed manifest and refuses malformed ones', () => {
    expect(manifestProblem(valid())).toBeUndefined()
    expect(manifestProblem(valid({ tools: ['powershell' as never] }))).toMatch(/built-in tool/)
    expect(manifestProblem(valid({ workspace: { roots: ['relative/path'], access: 'write' } }))).toMatch(/absolute/)
    expect(manifestProblem(valid({ budget: { maxActiveMs: 0 } }))).toMatch(/maxActiveMs/)
    expect(manifestProblem(valid({ audience: 'others' as never }))).toMatch(/other people/)
  })
})

describe('round-1 review fixes', () => {
  it('MCP identity is injective: a separator in a server or tool name is refused, and pairs never collide', () => {
    const granted = manifest({ mcp: [{ serverId: 'server-a', tool: 'branch_write' }] })
    expect(manifestProblem(valid({ mcp: [{ serverId: 'server-a::branch', tool: 'write' }] }))).toBe('An MCP tool is invalid.')
    expect(manifestProblem(valid({ mcp: [{ serverId: 'server-a', tool: 'branch::write' }] }))).toBe('An MCP tool is invalid.')
    expect(manifestProblem(valid({ mcp: [{ serverId: 'a__b', tool: 'c' }] }))).toBe('An MCP tool is invalid.')
    // Even past validation, identity is the pair itself.
    const forged = manifest({ mcp: [{ serverId: 'server-a::branch', tool: 'write' }] })
    const hidden = manifest({ mcp: [{ serverId: 'server-a', tool: 'branch::write' }] })
    expect(manifestSubset(forged, hidden)).toBe(false)
    expect(botManifestDigest(manifest({ mcp: [...forged.mcp, ...hidden.mcp] }))).not.toBe(botManifestDigest(hidden))
    expect(manifestSubset(granted, granted)).toBe(true)
  })

  it('only web, skill and the bot\'s own app tools can be granted: delegation, thread and queue tools are refused at publish', () => {
    expect(manifestProblem(valid({ appTools: ['web_search', 'web_fetch'] }))).toBeUndefined()
    expect(manifestProblem(valid({ appTools: [...BOT_DEFAULT_APP_TOOLS] }))).toBeUndefined()
    for (const tool of ['delegate_task', 'continue_subagent', 'create_subagents', 'thread_fork', 'thread_merge_back', 'queue_enqueue', 'thread_read', 'ask_user', 'read'])
      expect(manifestProblem(valid({ appTools: [tool] })), tool).toContain(`the Mousse tool ${tool}`)
  })

  it('limits are whole numbers, and work time is at most a day', () => {
    expect(manifestProblem(valid({ budget: { maxActiveMs: 1.5 } }))).toMatch(/whole number/)
    expect(manifestProblem(valid({ budget: { maxActiveMs: 60_000, maxTurns: 2.5 } }))).toMatch(/whole number/)
    expect(manifestProblem(valid({ budget: { maxActiveMs: 25 * 60 * 60_000 } }))).toMatch(/24 hours/)
    expect(manifestProblem(valid({ budget: { maxActiveMs: 60_000, maxUsd: 0.5 } }))).toBeUndefined()
  })

  it('intersectManifest keeps only what both name, with the lower limits', () => {
    const granted = manifest({ budget: { maxActiveMs: 60 * 60_000, maxTurns: 100 } })
    const revision = manifest({ tools: ['read', 'write'], skills: [], workspace: { roots: ['/home/me/proj/site', '/etc'], access: 'write' }, budget: { maxActiveMs: 5 * 60_000 } })
    expect(intersectManifest(revision, granted)).toEqual({
      tools: ['read'], appTools: [], mcp: [{ serverId: 'github', tool: 'create_issue' }], skills: [],
      workspace: { roots: ['/home/me/proj/site'], access: 'write' },
      budget: { maxActiveMs: 5 * 60_000, maxTurns: 100 },
      audience: 'owner'
    })
  })
})

describe('intersectManifest access', () => {
  it('keeps file access when both have it, as the grant has it, and drops it when either does not', () => {
    const write = { roots: ['/'], access: 'write' as const }
    const read = { roots: ['/a'], access: 'read' as const }
    const base = { tools: [], appTools: [], mcp: [], skills: [], budget: { maxActiveMs: 60_000 }, audience: 'owner' as const }
    expect(intersectManifest({ ...base, workspace: write }, { ...base, workspace: read }).workspace).toEqual(read)
    expect(intersectManifest({ ...base, workspace: read }, { ...base, workspace: write }).workspace).toEqual(write)
    expect(intersectManifest({ ...base, workspace: write }, { ...base, workspace: null }).workspace).toBeNull()
    expect(intersectManifest({ ...base, workspace: null }, { ...base, workspace: write }).workspace).toBeNull()
  })
})

describe('file access is one permission (bot-architecture.md §3.7)', () => {
  const two = (workspace: BotManifest['workspace']): BotManifest => manifest({ tools: ['read', 'edit'], mcp: [], skills: [], workspace })

  it('a folder answer grants it whole: the top of the file system, read and write, whatever folder was asked about', () => {
    const top = process.platform === 'win32' ? 'C:\\' : '/'
    const folder = process.platform === 'win32' ? 'C:\\b' : '/b'
    expect(withPermission(two(null), { path: folder, access: 'read' }).workspace).toEqual({ roots: [top], access: 'write' })
    expect(withPermission(two({ roots: ['/a'], access: 'read' }), filesAsk()).workspace).toEqual({ roots: [filesAsk().path], access: 'write' })
    // Another answer keeps it as it is.
    const granted = withPermission(two(null), filesAsk())
    expect(withPermission(granted, { budget: { key: 'maxActiveMs' } }, 1000).workspace).toEqual(granted.workspace)
    expect(withPermission(granted, { tool: 'search' }).workspace).toEqual(granted.workspace)
  })

  it('an older build\'s folders keep their stored form, so their digest stays approved, and read as file access', () => {
    const authored = two({ roots: ['/a', '/b'], access: 'write', rootAccess: { '/a': 'read' } })
    expect(canonicalManifest(authored).workspace).toEqual({ roots: ['/a', '/b'], access: 'read', rootAccess: { '/b': 'write' } })
    expect(botManifestDigest(withPermission(authored, { tool: 'read' }))).toBe(botManifestDigest(authored))
    expect(describeManifest(authored).map((line) => line.text)).toEqual(['Use files on this computer', 'Read files', 'Edit files', 'Up to 15 minutes of work per run'])
    expect(describeManifest(two(null)).map((line) => line.text)).toEqual(['Read files in its files folder', 'Edit files in its files folder', 'Up to 15 minutes of work per run'])
  })

  it('"run commands" is one line, not tied to a folder, and an Allow adds only it', () => {
    const authored = two({ roots: ['/a', '/b'], access: 'write', rootAccess: { '/a': 'read' } })
    const after = withPermission(authored, { tool: 'shell' })
    expect(after.tools).toContain('shell')
    expect(foldersOf(after.workspace)).toEqual([['/a', 'read'], ['/b', 'write']])
    expect(describeManifest(after).map((line) => line.text)).toContain('Run commands')
  })

  it('a thread\'s narrowing keeps file access whole, through compilation and the call check; only a narrowing to none removes it', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bot-narrow-')))
    const site = join(base, 'site')
    const elsewhere = join(base, 'elsewhere')
    const profile = join(base, 'profile')
    for (const dir of [site, elsewhere, join(profile, 'scratch')]) mkdirSync(dir, { recursive: true })
    try {
      const grant = manifest({ tools: ['edit'], mcp: [], skills: [], workspace: { roots: [site], access: 'write' } })
      const narrow = { workspace: { roots: [site], access: 'read' as const } }
      expect(narrowManifest(grant, narrow).workspace).toEqual(grant.workspace)
      expect(narrowManifest(grant, { workspace: null }).workspace).toBeNull()
      const compiled = compileBotThread({ grant, digest: 'd', thread: { narrow }, scratch: join(profile, 'scratch'), profileHome: profile, nativeNames: (tools) => ({ ok: true, names: [...tools] }), remaining: { deadlineMs: 60_000 } })
      if (!compiled.ok) throw new Error(compiled.error.message)
      const authority = createBotAuthority({ activationId: 'a', role: 'context', permissions: compiled.permissions, waiting: () => false, counters: { charge: () => ({ ok: true, count: 1 }) }, time: { deadline: () => 0, signal: new AbortController().signal }, spend: null })
      expect(authority.check({ kind: 'builtin', tool: 'edit', nativeName: 'edit', args: { path: join(site, 'file.md') } })).toEqual({ ok: true })
      expect(authority.check({ kind: 'builtin', tool: 'edit', nativeName: 'edit', args: { path: join(elsewhere, 'file.md') } })).toEqual({ ok: true })
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('round 2: the locked Claude sandbox writes only to folders granted for writing', () => {
  it('a mixed workspace denies its read-only folders and allows its write folders', () => {
    const sandbox = claudeLockedSandbox({ workspace: { roots: ['/a', '/b'], access: 'read', writeRoots: ['/b'], scratch: '/s' }, temps: ['/tmp'], home: '/home/me' }) as { filesystem: { allowWrite: string[]; denyWrite: string[] } }
    expect(sandbox.filesystem.allowWrite).toEqual(['/b', '/s'])
    expect(sandbox.filesystem.denyWrite).toEqual(['/a', '/tmp'])
  })
})

describe('default app tools (Bot Phase 1 §5.10)', () => {
  it('every new bot gets the web, its schedules, profile, depth, model, escalate and the five memory tools', () => {
    expect([...BOT_DEFAULT_APP_TOOLS].sort()).toEqual([
      'bot_schedule_add', 'bot_schedule_list', 'bot_schedule_remove', 'escalate', 'memory_forget', 'memory_list', 'memory_read', 'memory_save', 'memory_search',
      'set_depth', 'set_profile', 'use_model', 'web_fetch', 'web_search'
    ])
    for (const tool of BOT_MEMORY_TOOLS) {
      expect(BOT_DEFAULT_APP_TOOLS).toContain(tool)
      expect(BOT_APP_TOOLS.has(tool)).toBe(true)
    }
    // `consult` stays conditional: it comes with context threads, never by default.
    expect(BOT_DEFAULT_APP_TOOLS).not.toContain('consult')
  })

  it('the bot\'s own tools are not permissions; the web tools are', () => {
    for (const tool of ['bot_schedule_add', 'set_depth', 'use_model', 'set_profile', 'escalate', ...BOT_MEMORY_TOOLS]) expect(isOwnBotAppTool(tool), tool).toBe(true)
    for (const tool of ['web_search', 'web_fetch', 'consult']) expect(isOwnBotAppTool(tool), tool).toBe(false)
  })

  it('the starter grant is file tools without a folder, the default app tools and 15 minutes', () => {
    const starter = botStarterManifest()
    expect(manifestProblem(starter)).toBeUndefined()
    expect(starter).toMatchObject({ tools: ['read', 'list', 'search', 'edit', 'write'], workspace: null, mcp: [], skills: [], budget: { maxActiveMs: 15 * 60_000 } })
    expect(starter.appTools).toEqual([...BOT_DEFAULT_APP_TOOLS])
  })
})
