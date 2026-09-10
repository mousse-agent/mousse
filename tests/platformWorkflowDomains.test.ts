import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DomainHandlerRegistry } from '../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../src/mms/protocol/handlers'
import { registerWorkflowDefinitionMethods } from '../src/mms/workflows/registerDefinitionMethods'
import { WorkflowRegistry } from '../src/mms/workflows/registry/WorkflowRegistry'
import { createWorkflowDefinitionsClient } from '../src/renderer/services/workflowDefinitionsClient'
import { WORKFLOW_DEFINITIONS_CAPABILITY, type WorkflowDefinitionMethod } from '../src/shared/workflowPlatform'
import { encodeWorkflowBundle } from '../src/shared/workflows/wire'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mousse-workflow-domain-'))
  roots.push(root)
  const registries = new Map(['profile-a', 'profile-b'].map((profileId) => [profileId, new WorkflowRegistry({ profileId, profileRoot: join(root, profileId) })]))
  const domains = new DomainHandlerRegistry()
  registerWorkflowDefinitionMethods(domains, (id) => registries.get(id)!)
  const context = (profileId: string): HandlerContext => ({ mms: {} as HandlerContext['mms'], globalSequence: () => 0, connection: { id: 'fixture', capabilities: new Set([WORKFLOW_DEFINITIONS_CAPABILITY]), binding: { profileId, epoch: 1 } } })
  const request = async <T>(method: WorkflowDefinitionMethod, params: unknown, profileId = 'profile-a'): Promise<T> => {
    const result = await domains.dispatch(context(profileId), method, JSON.parse(JSON.stringify(params)))
    return JSON.parse(JSON.stringify(result)) as T
  }
  return { client: createWorkflowDefinitionsClient({ request }), request, registries }
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    const path = relative(realpathSync(tmpdir()), realpathSync(root))
    if (isAbsolute(path) || !path.startsWith('mousse-workflow-domain-') || path.includes('..')) throw new Error('Unexpected workflow fixture path')
    rmSync(root, { recursive: true, force: true })
  }
})

describe('profile-bound workflow definition domain', () => {
  it('persists edits and published history, restores a draft without changing its published head', async () => {
    const { client } = fixture()
    const profileId = 'profile-a'
    const created = await client.create({ profileId, name: 'History fixture', slug: 'history-fixture' })
    expect(created.compiled.runnable).toBe(true)
    const first = await client.publish({ profileId, id: created.id, expectedDraftSemanticHash: created.semanticHash, expectedHeadRevisionId: null })
    const edited = await client.saveDraft({ profileId, id: created.id, expectedDraftSemanticHash: created.semanticHash, bundle: { ...created.bundle, manifest: { ...created.bundle.manifest, description: 'Second revision' } } })
    const second = await client.publish({ profileId, id: created.id, expectedDraftSemanticHash: edited.semanticHash, expectedHeadRevisionId: first.semanticHash })
    expect((await client.listRevisions({ profileId, id: created.id })).map((item) => item.revisionId)).toContain(first.semanticHash)
    await expect(client.saveDraft({ profileId, id: created.id, expectedDraftSemanticHash: first.semanticHash, bundle: first.bundle })).rejects.toMatchObject({ code: 'WORKFLOW_CONCURRENCY_CONFLICT' })
    const restored = await client.restoreRevision({ profileId, id: created.id, revisionId: first.semanticHash, expectedDraftSemanticHash: second.semanticHash })
    expect(restored.semanticHash).toBe(first.semanticHash)
    expect(restored.head?.revisionId).toBe(second.semanticHash)
    const loaded = await client.get({ profileId, id: created.id })
    expect(loaded.bundle.manifest.description).toBeUndefined()
  })

  it('roundtrips binary assets through actual JSON and validates package paths and digests before writing', async () => {
    const { client, request } = fixture()
    const profileId = 'profile-a'
    const created = await client.create({ profileId, slug: 'asset-fixture' })
    const bytes = new Uint8Array([0, 255, 128, 10, 13])
    const bundle = { ...created.bundle, assets: [{ relativePath: 'assets/data.bin', bytes }] }
    const saved = await client.saveDraft({ profileId, id: created.id, expectedDraftSemanticHash: created.semanticHash, bundle })
    const exported = await client.exportBundle({ profileId, id: created.id })
    expect(exported.assets[0].bytes).toEqual(bytes)
    for (const relativePath of ['../secret.txt', '/absolute.txt', 'workflow.json', 'assets/file:stream']) {
      await expect(request('workflows.saveDraft', { profileId, id: created.id, expectedDraftSemanticHash: saved.semanticHash, bundle: encodeWorkflowBundle({ ...bundle, assets: [{ relativePath, bytes }] }) })).rejects.toMatchObject({ code: 'invalid_asset' })
    }
    await expect(client.saveDraft({ profileId, id: created.id, expectedDraftSemanticHash: saved.semanticHash, bundle: { ...bundle, assets: [{ relativePath: 'assets/data.bin', bytes, sha256: '0'.repeat(64) }] } })).rejects.toMatchObject({ code: 'invalid_asset' })
    expect((await client.get({ profileId, id: created.id })).semanticHash).toBe(saved.semanticHash)
  })

  it('rejects foreign identities/profile claims, archives from listing, and imports conflicts only as copies', async () => {
    const { client, request } = fixture()
    const profileId = 'profile-a'
    const created = await client.create({ profileId, slug: 'copy-fixture' })
    await expect(request('workflows.get', { id: created.id, profileId: 'profile-b' })).rejects.toMatchObject({ code: 'profile_mismatch' })
    await expect(request('workflows.get', { id: created.id, profileId: 'profile-b' }, 'profile-b')).rejects.toMatchObject({ code: 'workflow_not_found' })
    await expect(client.importBundle({ profileId, bundle: created.bundle })).rejects.toMatchObject({ code: 'WORKFLOW_CONCURRENCY_CONFLICT' })
    const copied = await client.importBundle({ profileId, bundle: created.bundle, conflict: 'rename' })
    expect(copied.id).not.toBe(created.id)
    expect(copied.slug).not.toBe(created.slug)
    await client.archive({ profileId, id: created.id })
    expect((await client.list({ profileId })).map((row) => row.id)).not.toContain(created.id)
    expect((await client.list({ profileId, archived: true })).find((row) => row.id === created.id)?.archived).toBe(true)
  })
})
