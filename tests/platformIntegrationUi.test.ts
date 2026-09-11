import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import { IntegrationsWorkspace } from '../src/renderer/components/integrations'
import { MAX_BASE64_BYTES, MAX_ZIP_BYTES, validateZipBytes, fileToPackage, filesToPackage, isManagedSource, parseMap } from '../src/renderer/components/integrations/integrationUi'
import { parseMcpArguments } from '../src/renderer/components/integrations/mcpDraft'
import { IsolatedIntegrationPlatformClient } from './fixtures/agent-platform/integration-editor-client'

describe('integration workspace contracts', () => {
  it('rejects invalid secret maps and preserves exact process arguments', () => {
    for (const invalid of ['{"value":1}', '{"value":null}', '{"__proto__":"bad"}', '{"value":"[redacted]"}']) expect(() => parseMap(invalid)).toThrow()
    expect(parseMap('{"TOKEN":"${TOKEN_ENV}"}')).toEqual({ TOKEN: '${TOKEN_ENV}' })
    expect(parseMcpArguments('["", "  spaced  ", "two words"]')).toEqual(['', '  spaced  ', 'two words'])
    expect(parseMcpArguments('  spaced  \nnext\n')).toEqual(['  spaced  ', 'next'])
    expect(() => parseMcpArguments('[1]')).toThrow()
  })

  it('preserves folder bytes and nested paths while rejecting unsafe, duplicate, and oversized input before reading', async () => {
    const file = (name: string, path: string, text: string) => {
      const value = new File([text], name)
      Object.defineProperty(value, 'webkitRelativePath', { value: path })
      return value
    }
    const source = '---\nname: example\ndescription: A fixture\n---\n\nExact source\n'
    const pkg = await filesToPackage([file('SKILL.md', 'example/SKILL.md', source), file('run.mjs', 'example/scripts/run.mjs', 'process.stdout.write("ok")')])
    const unpacked = unzipSync(pkg.bytes)
    expect(Object.keys(unpacked)).toEqual(['SKILL.md', 'scripts/run.mjs'])
    expect(strFromU8(unpacked['SKILL.md'])).toBe(source)
    const unsafe = file('bad', 'example/../bad', '')
    const read = vi.spyOn(unsafe, 'arrayBuffer')
    await expect(filesToPackage([unsafe])).rejects.toThrow(/unsafe/)
    expect(read).not.toHaveBeenCalled()
    await expect(filesToPackage([file('SKILL.md', 'example/SKILL.md', ''), file('skill.md', 'example/skill.md', '')])).rejects.toThrow(/duplicate/)
    const large = new File([], 'oversize.zip')
    Object.defineProperty(large, 'size', { value: MAX_ZIP_BYTES + 1 })
    const largeRead = vi.spyOn(large, 'arrayBuffer')
    await expect(fileToPackage(large)).rejects.toThrow(/larger/)
    expect(largeRead).not.toHaveBeenCalled()
  })
  it('keeps package transfer bounded before calling the bridge', () => {
    expect(() => validateZipBytes(new Uint8Array(MAX_ZIP_BYTES + 1))).toThrow(/larger than/)
    expect(MAX_BASE64_BYTES).toBeGreaterThan(MAX_ZIP_BYTES)
  })

  it('uses stable installation identities and preserves lifecycle state', async () => {
    const client = new IsolatedIntegrationPlatformClient()
    const created = await client.createSkill({ profileId: 'profile-a', scope: 'global', name: 'Review', description: 'Review changes', enable: true })
    expect(created.installationId).not.toBe('Review')
    const edited = await client.updateSkill({ profileId: 'profile-a', installationId: created.installationId, expectedRevision: created.revision, content: 'Exact source\n\n- check', enable: true })
    expect(edited.skill.revision).not.toBe(created.revision)
    await client.enableSkill({ profileId: 'profile-a', installationId: created.installationId, enabled: false })
    const snapshot = await client.snapshot({ profileId: 'profile-a', refresh: true })
    expect(snapshot.skills.skills[0]?.enabled).toBe(false)
    expect(snapshot.skills.skills[0]?.installationId).toBe(created.installationId)
  })

  it('uses backend ownership metadata for project-managed and external records', () => {
    expect(isManagedSource('generated-agent', true)).toBe(true)
    expect(isManagedSource('mousse-project', false)).toBe(false)
    expect(isManagedSource('generated-agent')).toBe(true)
  })

  it('fences profile catalogs and shows the primary Add actions', () => {
    const client = new IsolatedIntegrationPlatformClient()
    const html = renderToStaticMarkup(createElement(IntegrationsWorkspace, { client, profileId: 'profile-a', initialTab: 'mcp' }))
    expect(html).toContain('data-integrations-workspace')
    expect(html).toContain('Add MCP connection')
    expect(html).toContain('data-action="refresh-integrations"')
  })
})
