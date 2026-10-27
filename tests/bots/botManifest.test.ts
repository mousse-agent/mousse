/**
 * PR 6 §4 "Approval": a manifest is approved once by the digest of its canonical form; a revision
 * whose manifest is a subset of the active grant runs without asking, and a wider one lists only
 * what it adds. Nothing is approved automatically.
 */
import { describe, expect, it } from 'vitest'
import { botManifestDigest } from '../../src/mms/bots/grants/compile'
import type { BotManifest } from '../../src/shared/bots/personal/definition'
import { addedPermissions, canonicalManifest, describeManifest, intersectManifest, manifestProblem, manifestSubset, narrowManifest } from '../../src/shared/bots/personal/manifest'

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
    expect(addedPermissions(wider, granted).map((line) => line.text)).toEqual([
      'Create and overwrite files in /home/me/proj/site, /home/me/proj/docs',
      'Use the github tool `merge_pr`',
      'Use the skill *changelog*',
      'Read and edit files in /home/me/proj/docs',
      'Up to 30 minutes of work per run'
    ])
  })

  it('write access on a granted read-only root is an addition', () => {
    const readOnly = manifest({ workspace: { roots: ['/home/me/proj/site'], access: 'read' } })
    expect(addedPermissions(manifest(), readOnly).map((line) => line.text)).toEqual(['Read and edit files in /home/me/proj/site'])
  })

  it('dropping a limit the grant has is wider, never a subset', () => {
    const unlimited = manifest({ budget: { maxActiveMs: 15 * 60_000 } })
    expect(manifestSubset(unlimited, granted)).toBe(false)
    expect(addedPermissions(unlimited, granted).map((line) => line.text)).toEqual(['No limit on model requests (retries included)'])
  })

  it('with nothing granted, everything is listed', () => {
    expect(addedPermissions(manifest(), null)).toEqual(describeManifest(manifest()))
    expect(describeManifest(manifest()).map((line) => line.text)).toEqual([
      'Read and edit files in /home/me/proj/site',
      'Read files in /home/me/proj/site',
      'Edit files in /home/me/proj/site',
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

describe('manifestProblem', () => {
  it('accepts a well-formed manifest and refuses malformed ones', () => {
    expect(manifestProblem(manifest())).toBeUndefined()
    expect(manifestProblem(manifest({ tools: ['powershell' as never] }))).toMatch(/built-in tool/)
    expect(manifestProblem(manifest({ workspace: { roots: ['relative/path'], access: 'write' } }))).toMatch(/absolute/)
    expect(manifestProblem(manifest({ budget: { maxActiveMs: 0 } }))).toMatch(/maxActiveMs/)
    expect(manifestProblem(manifest({ audience: 'others' as never }))).toMatch(/other people/)
  })
})

describe('round-1 review fixes', () => {
  it('MCP identity is injective: a separator in a server or tool name is refused, and pairs never collide', () => {
    const granted = manifest({ mcp: [{ serverId: 'server-a', tool: 'branch_write' }] })
    expect(manifestProblem(manifest({ mcp: [{ serverId: 'server-a::branch', tool: 'write' }] }))).toBe('An MCP tool is invalid.')
    expect(manifestProblem(manifest({ mcp: [{ serverId: 'server-a', tool: 'branch::write' }] }))).toBe('An MCP tool is invalid.')
    expect(manifestProblem(manifest({ mcp: [{ serverId: 'a__b', tool: 'c' }] }))).toBe('An MCP tool is invalid.')
    // Even past validation, identity is the pair itself.
    const forged = manifest({ mcp: [{ serverId: 'server-a::branch', tool: 'write' }] })
    const hidden = manifest({ mcp: [{ serverId: 'server-a', tool: 'branch::write' }] })
    expect(manifestSubset(forged, hidden)).toBe(false)
    expect(botManifestDigest(manifest({ mcp: [...forged.mcp, ...hidden.mcp] }))).not.toBe(botManifestDigest(hidden))
    expect(manifestSubset(granted, granted)).toBe(true)
  })

  it('only web and skill app tools can be granted: delegation, thread and queue tools are refused at publish', () => {
    expect(manifestProblem(manifest({ appTools: ['web_search', 'web_fetch'] }))).toBeUndefined()
    for (const tool of ['delegate_task', 'continue_subagent', 'create_subagents', 'thread_fork', 'thread_merge_back', 'queue_enqueue', 'thread_read', 'ask_user', 'read'])
      expect(manifestProblem(manifest({ appTools: [tool] })), tool).toContain(`the Mousse tool ${tool}`)
  })

  it('limits are whole numbers, and work time is at most a day', () => {
    expect(manifestProblem(manifest({ budget: { maxActiveMs: 1.5 } }))).toMatch(/whole number/)
    expect(manifestProblem(manifest({ budget: { maxActiveMs: 60_000, maxTurns: 2.5 } }))).toMatch(/whole number/)
    expect(manifestProblem(manifest({ budget: { maxActiveMs: 25 * 60 * 60_000 } }))).toMatch(/24 hours/)
    expect(manifestProblem(manifest({ budget: { maxActiveMs: 60_000, maxUsd: 0.5 } }))).toBeUndefined()
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
  it('is read where either side says read', () => {
    const write = { roots: ['/a'], access: 'write' as const }
    const read = { roots: ['/a'], access: 'read' as const }
    const base = { tools: [], appTools: [], mcp: [], skills: [], budget: { maxActiveMs: 60_000 }, audience: 'owner' as const }
    expect(intersectManifest({ ...base, workspace: write }, { ...base, workspace: read }).workspace).toEqual(read)
    expect(intersectManifest({ ...base, workspace: read }, { ...base, workspace: write }).workspace).toEqual(read)
    expect(intersectManifest({ ...base, workspace: write }, { ...base, workspace: null }).workspace).toBeNull()
  })
})
