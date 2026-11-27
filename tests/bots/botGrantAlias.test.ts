/**
 * A bot's stored grant that names a tool by its old name (docs/plans/tool-api.md §4): it still grants the tool under its
 * new name, and its digest is the one it was approved under. No tool a bot can be granted has been renamed yet (the
 * checklist tools are always on, never granted), so the alias table is given one here: `web_lookup`, the old name of
 * `web_search`.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/shared/toolAliases', async (importActual) => {
  const MOUSSE_TOOL_ALIASES: Record<string, string> = { web_lookup: 'web_search' }
  const isToolAlias = (name: string) => Object.prototype.hasOwnProperty.call(MOUSSE_TOOL_ALIASES, name)
  const canonicalToolName = (name: string) => (isToolAlias(name) ? MOUSSE_TOOL_ALIASES[name] : name)
  // A plain rename, never a variant: a grant of the old name is the new tool's (`canonicalGrantName`).
  return {
    ...(await importActual<object>()),
    MOUSSE_TOOL_ALIASES,
    isToolAlias,
    canonicalToolName,
    canonicalGrantName: canonicalToolName,
    isVariantAlias: () => false,
    isRunningVariant: () => false
  }
})

import { botManifestDigest, compileBotThread } from '../../src/mms/bots/grants/compile'
import { botGrantTool, botStarterManifest, canonicalManifest, intersectManifest, manifestProblem } from '../../src/shared/bots/personal/manifest'

describe("a bot's grant under a tool's old name", () => {
  const starter = botStarterManifest()
  const withoutSearch = { ...starter, appTools: starter.appTools.filter((tool) => tool !== 'web_search') }
  const stored = { ...withoutSearch, appTools: [...withoutSearch.appTools, 'web_lookup'] }
  const compile = (grant: typeof stored) => compileBotThread({
    grant, digest: botManifestDigest(grant), thread: {}, scratch: '/tmp/mousse-grant-alias-scratch', profileHome: '/tmp/mousse-grant-alias-home',
    nativeNames: (tools) => ({ ok: true, names: [...tools] }), remaining: { deadlineMs: 60_000 }
  })

  it('still grants the tool, under its new name', () => {
    expect(manifestProblem(stored)).toBeUndefined()
    const compiled = compile(stored)
    if (!compiled.ok) throw new Error(compiled.error.message)
    expect(compiled.permissions.appTools).toContain('web_search')
    expect(compiled.permissions.appTools).not.toContain('web_lookup')
    // Without it, nothing grants the search.
    const without = compile(withoutSearch)
    if (!without.ok) throw new Error(without.error.message)
    expect(without.permissions.appTools).not.toContain('web_search')
  })

  it('keeps the digest it was approved under, and a new ask names the new tool', () => {
    expect(canonicalManifest(stored).appTools).toContain('web_lookup')
    expect(botManifestDigest(stored)).not.toBe(botManifestDigest({ ...withoutSearch, appTools: [...withoutSearch.appTools, 'web_search'] }))
    expect(botGrantTool('web_lookup')).toBe('web_search')
  })

  it("keeps the tool when a revision that asks for its new name runs inside the stored grant", () => {
    const revision = { ...withoutSearch, appTools: [...withoutSearch.appTools, 'web_search'] }
    expect(intersectManifest(revision, stored).appTools).toContain('web_search')
    expect(intersectManifest(stored, revision).appTools).toContain('web_search')
  })
})
