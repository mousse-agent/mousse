import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { IntegrationsWorkspace } from '../src/renderer/components/integrations'
import { MAX_BASE64_BYTES, MAX_ZIP_BYTES, validateZipBytes } from '../src/renderer/components/integrations/integrationUi'
import { IsolatedIntegrationPlatformClient } from './fixtures/agent-platform/integration-editor-client'

describe('integration workspace contracts', () => {
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

  it('fences profile catalogs and shows the primary Add actions', () => {
    const client = new IsolatedIntegrationPlatformClient()
    const html = renderToStaticMarkup(createElement(IntegrationsWorkspace, { client, profileId: 'profile-a', initialTab: 'mcp' }))
    expect(html).toContain('data-integrations-workspace')
    expect(html).toContain('Add MCP connection')
    expect(html).toContain('data-action="refresh-integrations"')
  })
})
