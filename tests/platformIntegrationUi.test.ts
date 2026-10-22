import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import { IntegrationsWorkspace } from '../src/renderer/components/integrations'
import { MAX_ZIP_BYTES, validateZipBytes, fileToPackage, filesToPackage, parseMap } from '../src/renderer/components/integrations/integrationUi'
import { createMcpPayload, draftFromMcp, parseMcpArguments, updateMcpPayload } from '../src/renderer/components/integrations/mcpDraft'
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
  })

  it('fences profile catalogs and lists skills and MCP servers as settings groups', () => {
    const client = new IsolatedIntegrationPlatformClient()
    const html = renderToStaticMarkup(createElement(IntegrationsWorkspace, { client, profileId: 'profile-a' }))
    expect(html).toContain('data-integrations-workspace')
    expect(html).toContain('data-profile-id="profile-a"')
    expect(html).toContain('data-action="add-skill"')
    expect(html).toContain('data-action="add-mcp"')
    expect(html).toContain('MCP servers')
    expect(html).not.toContain('role="tablist"')
  })

  it('edits never change whether a server is on', () => {
    const draft = draftFromMcp()
    Object.assign(draft, { name: 'Fixture', command: 'node', enabled: true })
    expect(createMcpPayload(draft, { profileId: 'profile-a' }, 'global')).toMatchObject({ enable: true })
    expect(updateMcpPayload(draft, { profileId: 'profile-a' }, 'installation', 'revision')).not.toHaveProperty('enable')
  })

  it('keeps saved headers, environment and OAuth client settings unless their replace switch is on', () => {
    const saved = { name: 'Fixture', transport: 'http', url: 'https://example.invalid/mcp', authMode: 'oauth' } as Parameters<typeof draftFromMcp>[0]
    const draft = draftFromMcp(saved)
    Object.assign(draft, { headers: '{"A":"${B}"}', env: '{"C":"${D}"}', clientId: 'client' })
    const kept = updateMcpPayload(draft, { profileId: 'profile-a' }, 'installation', 'revision')
    expect(kept).not.toHaveProperty('headers')
    expect(kept).not.toHaveProperty('env')
    expect(kept).not.toHaveProperty('auth')
    Object.assign(draft, { replaceHeaders: true, replaceEnv: true, replaceAuth: true })
    expect(updateMcpPayload(draft, { profileId: 'profile-a' }, 'installation', 'revision')).toMatchObject({
      headers: { A: '${B}' }, env: { C: '${D}' }, auth: { clientId: 'client', scopes: [] }
    })
  })
})
