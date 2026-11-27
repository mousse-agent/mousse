/**
 * `escalate` is now `permission_ask` (docs/plans/tool-api.md §1.5, request family). Every bot's stored grant names it by
 * its old name: that grant keeps holding the tool, asks the owner for nothing new, never lists it as a permission, and
 * keeps the digest it was approved under.
 */
import { describe, expect, it } from 'vitest'
import { botManifestDigest, compileBotThread } from '../../src/mms/bots/grants/compile'
import { grantedPermissions } from '../../src/mms/bots/chat/projection'
import { addedPermissions, botStarterManifest, canonicalManifest } from '../../src/shared/bots/personal/manifest'

describe("a bot's grant stored with escalate", () => {
  const starter = botStarterManifest()
  const stored = { ...starter, appTools: starter.appTools.map((tool) => (tool === 'permission_ask' ? 'escalate' : tool)) }

  it('holds permission_ask and keeps its digest', () => {
    expect(stored.appTools).toContain('escalate')
    const compiled = compileBotThread({
      grant: stored, digest: botManifestDigest(stored), thread: {}, scratch: '/tmp/mousse-permission-ask-scratch', profileHome: '/tmp/mousse-permission-ask-home',
      botTools: { escalate: true, consult: false, memory: true },
      nativeNames: (tools) => ({ ok: true, names: [...tools] }), remaining: { deadlineMs: 60_000 }
    })
    if (!compiled.ok) throw new Error(compiled.error.message)
    expect(compiled.permissions.appTools).toContain('permission_ask')
    expect(compiled.permissions.appTools).not.toContain('escalate')
    expect(canonicalManifest(stored).appTools).toContain('escalate')
  })

  it('asks the owner for nothing when a revision names permission_ask', () => {
    expect(addedPermissions(starter, stored)).toEqual([])
  })

  it('never lists it as a permission the owner gave', () => {
    expect(grantedPermissions(stored)).toEqual(grantedPermissions(starter))
  })
})
