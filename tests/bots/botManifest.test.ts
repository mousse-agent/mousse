/**
 * PR 6 §4 "Approval": a manifest is approved once by the digest of its canonical form; a revision
 * whose manifest is a subset of the active grant runs without asking, and a wider one lists only
 * what it adds. Nothing is approved automatically.
 */
import { describe, expect, it } from 'vitest'
import { botManifestDigest } from '../../src/mms/bots/grants/compile'
import { foldersOf, type BotManifest } from '../../src/shared/bots/personal/definition'
import { withPermission } from '../../src/shared/bots/personal/escalation'
import { claudeLockedSandbox } from '../../src/mms/harness/claude/locked'
import { addedPermissions, BOT_APP_TOOLS, BOT_DEFAULT_APP_TOOLS, botStarterManifest, canonicalManifest, describeManifest, intersectManifest, isAbsolutePath, isOwnBotAppTool, manifestProblem, manifestSubset, narrowManifest } from '../../src/shared/bots/personal/manifest'
import { BOT_MEMORY_TOOLS } from '../../src/shared/bots/personal/memory'
import { grantedPermissions } from '../../src/mms/bots/chat/projection'

const manifest = (patch: Partial<BotManifest> = {}): BotManifest => ({
  tools: ['read', 'edit'],
  appTools: [],
  mcp: [{ serverId: 'github', tool: 'create_issue' }],
  skills: ['release-notes'],
  workspace: null,
  budget: { maxToolCalls: 50 },
  audience: 'owner',
  ...patch
})

describe('botManifestDigest', () => {
  it('is the same for the same grant in any order, with duplicates and absent limits', () => {
    const a = manifest()
    const b = manifest({
      tools: ['edit', 'read', 'edit'],
      mcp: [{ serverId: 'github', tool: 'create_issue' }, { serverId: 'github', tool: 'create_issue' }],
      budget: { maxToolCalls: 50, maxTurns: undefined }
    })
    expect(botManifestDigest(a)).toBe(botManifestDigest(b))
    expect(botManifestDigest(a)).toMatch(/^[a-f0-9]{64}$/)
    expect(canonicalManifest(b).tools).toEqual(['edit', 'read'])
  })

  it('changes with any permission or limit', () => {
    const base = botManifestDigest(manifest())
    expect(botManifestDigest(manifest({ tools: ['read'] }))).not.toBe(base)
    expect(botManifestDigest(manifest({ budget: { maxToolCalls: 40 } }))).not.toBe(base)
    expect(botManifestDigest(manifest({ mcp: [{ serverId: 'gitlab', tool: 'create_issue' }] }))).not.toBe(base)
  })

  // Stored grants are approved by this digest: what a turn may do by its start (`BOT_TURN_KINDS`, #1360) is not part of
  // a grant, so changing it never asks the owner again. The value is the one the build before #1360 wrote.
  it('a stored grant hashes as it did when it was approved', () => {
    const stored = manifest({ tools: ['read', 'edit', 'shell'], appTools: ['web_search', 'web_fetch', 'bot_schedule_add', 'escalate', 'run_report', 'threads', 'browser'] })
    expect(botManifestDigest(stored)).toBe('59d7d34674af007da7c383871d8f56723c12ce8121e73025432855e208b35459')
  })

  // "Allow everything" (#1363) is stored only when on: a grant without it, as every stored one is, hashes as before.
  it('Allow everything is part of the digest only when on', () => {
    const stored = manifest({ tools: ['read', 'edit', 'shell'], appTools: ['web_search', 'web_fetch', 'bot_schedule_add', 'escalate', 'run_report', 'threads', 'browser'] })
    expect(botManifestDigest({ ...stored, fullTrust: undefined })).toBe('59d7d34674af007da7c383871d8f56723c12ce8121e73025432855e208b35459')
    expect(canonicalManifest(stored)).not.toHaveProperty('fullTrust')
    expect(botManifestDigest({ ...stored, fullTrust: true })).not.toBe(botManifestDigest(stored))
    expect(manifestProblem({ ...stored, fullTrust: false })).toBe('Allow everything is on, or left out.')
  })

  it('a grant approved with a work time keeps its digest, and a revision without one is a subset of it', () => {
    const old = manifest({ budget: { maxActiveMs: 60 * 60_000, maxToolCalls: 50 } })
    // The same canonical form as when it was approved: work time first, then the other limits.
    expect(JSON.stringify(canonicalManifest(old).budget)).toBe(JSON.stringify({ maxActiveMs: 60 * 60_000, maxToolCalls: 50 }))
    expect(botManifestDigest(old)).not.toBe(botManifestDigest(manifest()))
    expect(manifestSubset(manifest(), old)).toBe(true)
    expect(manifestSubset(old, manifest())).toBe(true)
    expect(describeManifest(old).map((line) => line.text)).not.toContainEqual(expect.stringMatching(/work/))
  })
})

describe('the subset rule', () => {
  const granted = manifest({ budget: { maxToolCalls: 50, maxTurns: 40 } })

  it('a narrower revision runs without asking', () => {
    const narrower = manifest({ tools: ['read'], mcp: [], skills: [], budget: { maxToolCalls: 20, maxTurns: 10 } })
    expect(manifestSubset(narrower, granted)).toBe(true)
    expect(addedPermissions(narrower, granted)).toEqual([])
    expect(manifestSubset(granted, granted)).toBe(true)
  })

  it('a wider revision lists only what it adds, in plain words', () => {
    const wider = manifest({
      tools: ['read', 'edit', 'write'],
      mcp: [{ serverId: 'github', tool: 'create_issue' }, { serverId: 'github', tool: 'merge_pr' }],
      skills: ['release-notes', 'changelog'],
      budget: { maxToolCalls: 80, maxTurns: 40 }
    })
    expect(manifestSubset(wider, granted)).toBe(false)
    expect(addedPermissions(wider, granted).map((line) => line.text)).toEqual([
      'Create and overwrite files in its files folder',
      'Use the MCP tool `merge_pr`',
      'Use the skill *changelog*',
      'Up to 80 tool calls per run'
    ])
  })

  it('a stored workspace adds nothing: a revision naming folders the grant lacks is still a subset', () => {
    const folders = manifest({ workspace: { roots: ['/'], access: 'write' } })
    expect(manifestSubset(folders, manifest())).toBe(true)
    expect(addedPermissions(folders, manifest())).toEqual([])
  })

  it('dropping a limit the grant has is wider, never a subset', () => {
    const unlimited = manifest({ budget: { maxToolCalls: 50 } })
    expect(manifestSubset(unlimited, granted)).toBe(false)
    expect(addedPermissions(unlimited, granted).map((line) => line.text)).toEqual(['No limit on model requests (retries included)'])
  })

  // What approve() moves work onto (a subset of the new grant) and what it ends (anything the old one gave that the new
  // one does not): Allow everything and how tightly an MCP tool is held count as permissions too.
  it.each([
    ['Allow everything added', manifest({ fullTrust: true }), manifest(), ['Allow everything: every tool and permission a bot can be given, without asking']],
    ['Allow everything taken away', manifest(), manifest({ fullTrust: true }), []],
    ['an MCP tool no longer asking first', manifest(), manifest({ mcp: [{ serverId: 'github', tool: 'create_issue', level: 'asks_first' }] }), ['Use the MCP tool `create_issue` without asking first']],
    ['an MCP tool asking first again', manifest({ mcp: [{ serverId: 'github', tool: 'create_issue', level: 'asks_first' }] }), manifest(), []]
  ])('%s', (_name, wanted, granted, added) => {
    expect(addedPermissions(wanted, granted).map((line) => line.text)).toEqual(added)
    expect(manifestSubset(wanted, granted)).toBe(added.length === 0)
    // The other way round is the other answer: what one adds, the other takes away.
    expect(manifestSubset(granted, wanted)).toBe(added.length > 0)
  })

  it('with nothing granted, everything is listed', () => {
    expect(addedPermissions(manifest(), null)).toEqual(describeManifest(manifest()))
    expect(describeManifest(manifest()).map((line) => line.text)).toEqual([
      'Read files in its files folder',
      'Edit files in its files folder',
      'Use the MCP tool `create_issue`',
      'Use the skill *release-notes*',
      'Up to 50 tool calls per run'
    ])
  })
})

describe('narrowManifest', () => {
  it('only removes permissions', () => {
    const narrowed = narrowManifest(manifest(), {
      tools: ['read', 'shell'],
      mcp: [{ serverId: 'gitlab', tool: 'create_issue' }]
    })
    expect(narrowed.tools).toEqual(['read'])
    expect(narrowed.mcp).toEqual([])
    expect(narrowed.skills).toEqual(['release-notes'])
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
    expect(manifestProblem(valid({ budget: { maxTurns: 0 } }))).toMatch(/maxTurns/)
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
    for (const tool of ['delegate_task', 'continue_subagent', 'create_subagents', 'thread_fork', 'thread_merge_back', 'queue_enqueue', 'thread_read', 'question_ask', 'read'])
      expect(manifestProblem(valid({ appTools: [tool] })), tool).toContain(`the Mousse tool ${tool}`)
  })

  it('limits are whole numbers, and no limit is required', () => {
    expect(manifestProblem(valid({ budget: { maxTurns: 2.5 } }))).toMatch(/whole number/)
    expect(manifestProblem(valid({ budget: { maxUsd: 0.5 } }))).toBeUndefined()
    expect(manifestProblem(valid({ budget: {} }))).toBeUndefined()
  })

  it('intersectManifest keeps only what both name, with the lower limits', () => {
    const granted = manifest({ budget: { maxToolCalls: 60, maxTurns: 100 } })
    const revision = manifest({ tools: ['read', 'write'], skills: [], workspace: { roots: ['/home/me/proj/site', '/etc'], access: 'write' }, budget: { maxToolCalls: 5 } })
    expect(intersectManifest(revision, granted)).toEqual({
      tools: ['read'], appTools: [], mcp: [{ serverId: 'github', tool: 'create_issue' }], skills: [],
      workspace: null,
      budget: { maxToolCalls: 5, maxTurns: 100 },
      audience: 'owner'
    })
  })
})

describe('a stored workspace (an older build\'s file access) grants nothing', () => {
  const two = (workspace: BotManifest['workspace']): BotManifest => manifest({ tools: ['read', 'edit'], mcp: [], skills: [], workspace })

  it('an older build\'s folder ask adds nothing when allowed', () => {
    const folder = process.platform === 'win32' ? 'C:\\b' : '/b'
    for (const manifest of [two(null), two({ roots: ['/a'], access: 'read' })])
      expect(withPermission(manifest, { path: folder, access: 'write' })).toEqual(manifest)
  })

  it('an older build\'s folders keep their stored form, so their digest stays approved, and list nothing', () => {
    const authored = two({ roots: ['/a', '/b'], access: 'write', rootAccess: { '/a': 'read' } })
    expect(canonicalManifest(authored).workspace).toEqual({ roots: ['/a', '/b'], access: 'read', rootAccess: { '/b': 'write' } })
    expect(botManifestDigest(withPermission(authored, { tool: 'read' }))).toBe(botManifestDigest(authored))
    expect(describeManifest(authored).map((line) => line.text)).toEqual(['Read files in its files folder', 'Edit files in its files folder', 'Up to 50 tool calls per run'])
  })

  it('"run commands" is one line, not tied to a folder, and an Allow adds only it', () => {
    const authored = two({ roots: ['/a', '/b'], access: 'write', rootAccess: { '/a': 'read' } })
    const after = withPermission(authored, { tool: 'shell' })
    expect(after.tools).toContain('shell')
    expect(foldersOf(after.workspace)).toEqual([['/a', 'read'], ['/b', 'write']])
    expect(describeManifest(after).map((line) => line.text)).toContain('Run commands')
  })
})

describe('round 2: the locked Claude sandbox writes only to folders granted for writing', () => {
  it('a mixed workspace denies its read-only folders and allows its write folders', () => {
    const sandbox = claudeLockedSandbox({ workspace: { roots: ['/a', '/b'], access: 'read', writeRoots: ['/b'], scratch: '/s' }, temps: ['/tmp'], home: '/home/me' }) as { filesystem: { allowWrite: string[]; denyWrite: string[] } }
    expect(sandbox.filesystem.allowWrite).toEqual(['/b', '/s'])
    expect(sandbox.filesystem.denyWrite).toEqual(['/a', '/tmp'])
  })
})

// The Tells you setting is gone, but grants approved before then still list its tool.
it('a grant an older build approved with telling_set still reads as well formed and lists nothing for it', () => {
  const old = { ...botStarterManifest(), appTools: [...botStarterManifest().appTools, 'telling_set'] }
  expect(manifestProblem(old)).toBeUndefined()
  expect(grantedPermissions(old)).toEqual(grantedPermissions(botStarterManifest()))
})

describe('default app tools (Bot Phase 1 §5.10)', () => {
  it('every new bot gets the web, its schedules, profile, depth, model, permission_ask, run_report, the five memory tools and its open items', () => {
    expect([...BOT_DEFAULT_APP_TOOLS].sort()).toEqual([
      'bot_schedule_add', 'bot_schedule_list', 'bot_schedule_remove', 'item_list', 'item_save', 'memory_forget', 'memory_list', 'memory_read', 'memory_save', 'memory_search',
      'permission_ask', 'run_report', 'set_depth', 'set_profile', 'use_model', 'web_fetch', 'web_search'
    ])
    for (const tool of BOT_MEMORY_TOOLS) {
      expect(BOT_DEFAULT_APP_TOOLS).toContain(tool)
      expect(BOT_APP_TOOLS.has(tool)).toBe(true)
    }
    // `consult` stays conditional: it comes with context threads, never by default.
    expect(BOT_DEFAULT_APP_TOOLS).not.toContain('consult')
  })

  it('the bot\'s own tools are not permissions; the web tools are', () => {
    for (const tool of ['bot_schedule_add', 'set_depth', 'use_model', 'set_profile', 'permission_ask', ...BOT_MEMORY_TOOLS]) expect(isOwnBotAppTool(tool), tool).toBe(true)
    for (const tool of ['web_search', 'web_fetch', 'consult']) expect(isOwnBotAppTool(tool), tool).toBe(false)
  })

  it('the starter grant is file tools without a folder, the default app tools and no limits', () => {
    const starter = botStarterManifest()
    expect(manifestProblem(starter)).toBeUndefined()
    expect(starter).toMatchObject({ tools: ['read', 'list', 'search', 'edit', 'write'], workspace: null, mcp: [], skills: [], budget: {} })
    expect(starter.appTools).toEqual([...BOT_DEFAULT_APP_TOOLS])
  })
})
