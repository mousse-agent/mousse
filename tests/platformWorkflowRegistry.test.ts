import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WorkflowArchiveUnsupportedError,
  WorkflowConcurrencyError
} from '../src/shared/workflows'
import {
  computeSemanticHash,
  computeVisualHash,
  loadWorkflowDirectory,
  semanticAssetsFromBundle,
  WorkflowRegistry,
  ZipArchiveImportNotConfigured
} from '../src/mms/workflows'
import { createAllNodeTypesManifest } from '../src/mms/workflows/fixtures/allNodeTypes'

const EXAMPLE_DIR = join(process.cwd(), 'examples', 'workflows', 'summarize-files')

const dirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

function registry() {
  const profileRoot = tempDir('mousse-wf-profile-')
  return {
    profileRoot,
    registry: new WorkflowRegistry({
      profileId: 'profile-test',
      profileRoot
    })
  }
}

describe('workflow registry', () => {
  it('requires an explicit profileId and profileRoot', () => {
    expect(() => new WorkflowRegistry({ profileId: '', profileRoot: tempDir('x-') })).toThrow(/profileId/)
    expect(() => new WorkflowRegistry({ profileId: 'p', profileRoot: '' })).toThrow(/profileRoot/)
  })

  it('saves a draft, publishes an immutable revision, and roundtrips export/import', () => {
    const { registry: store } = registry()
    const loaded = loadWorkflowDirectory(EXAMPLE_DIR)
    const saved = store.saveDraft({ bundle: loaded.bundle })
    expect(saved.profileId).toBe('profile-test')
    expect(saved.compiled.runnable).toBe(true)

    const published = store.publish({
      definitionId: saved.definitionId,
      expectedDraftSemanticHash: saved.semanticHash,
      expectedHeadRevisionId: null
    })
    expect(published.head?.revisionId).toBe(published.semanticHash)
    expect(published.bundle.lock?.dependencies.some((d) => d.id === 'scripts/collect.mjs')).toBe(true)

    const dest = tempDir('mousse-wf-export-')
    store.exportDirectory(saved.definitionId, dest)
    const roundtrip = loadWorkflowDirectory(dest)
    expect(computeSemanticHash(roundtrip.bundle.manifest, semanticAssetsFromBundle(roundtrip.bundle))).toBe(
      published.semanticHash
    )

    const other = new WorkflowRegistry({
      profileId: 'profile-other',
      profileRoot: tempDir('mousse-wf-profile-2-')
    })
    const imported = other.importDirectory(dest)
    expect(imported.bundle.manifest.id).toBe(loaded.bundle.manifest.id)
    expect(imported.semanticHash).toBe(published.semanticHash)
  })

  it('keeps semantic hashes stable across key reorder and visual-only edits', () => {
    const { registry: store } = registry()
    const loaded = loadWorkflowDirectory(EXAMPLE_DIR)
    const first = store.saveDraft({ bundle: loaded.bundle })
    const reordered = JSON.parse(
      JSON.stringify(loaded.bundle.manifest, ['slug', 'name', 'id', 'schemaVersion', 'description', 'instructionsFile', 'inputSchema', 'outputSchema', 'entryNodeId', 'limits', 'permissions', 'dependencyPolicy', 'nodes', 'edges'])
    )
    // Reconstruct a fully valid object after partial key listing — use canonicalize by saving shuffled node object keys.
    const shuffled = {
      ...loaded.bundle,
      manifest: {
        edges: loaded.bundle.manifest.edges,
        nodes: loaded.bundle.manifest.nodes,
        permissions: loaded.bundle.manifest.permissions,
        limits: loaded.bundle.manifest.limits,
        entryNodeId: loaded.bundle.manifest.entryNodeId,
        outputSchema: loaded.bundle.manifest.outputSchema,
        inputSchema: loaded.bundle.manifest.inputSchema,
        instructionsFile: loaded.bundle.manifest.instructionsFile,
        description: loaded.bundle.manifest.description,
        slug: loaded.bundle.manifest.slug,
        name: loaded.bundle.manifest.name,
        id: loaded.bundle.manifest.id,
        schemaVersion: loaded.bundle.manifest.schemaVersion,
        dependencyPolicy: loaded.bundle.manifest.dependencyPolicy
      }
    }
    const second = store.saveDraft({
      bundle: shuffled,
      expectedDraftSemanticHash: first.semanticHash
    })
    expect(second.semanticHash).toBe(first.semanticHash)
    void reordered

    const moved = store.saveDraft({
      bundle: {
        ...loaded.bundle,
        editor: {
          schemaVersion: 1,
          viewport: { x: 40, y: 10, zoom: 1.2 },
          nodes: { start: { x: 99, y: 99 } }
        }
      },
      visualOnly: true,
      expectedDraftSemanticHash: first.semanticHash
    })
    expect(moved.semanticHash).toBe(first.semanticHash)
    expect(moved.visualHash).not.toBe(first.visualHash)
    expect(computeVisualHash(moved.bundle.editor)).toBe(moved.visualHash)
  })

  it('rejects semantic changes presented as a visual-only save', () => {
    const { registry: store } = registry()
    const loaded = loadWorkflowDirectory(EXAMPLE_DIR)
    const first = store.saveDraft({ bundle: loaded.bundle })
    const changed = {
      ...loaded.bundle,
      manifest: { ...loaded.bundle.manifest, name: 'Semantically changed' }
    }
    expect(() => store.saveDraft({
      bundle: changed,
      visualOnly: true,
      expectedDraftSemanticHash: first.semanticHash
    })).toThrow(WorkflowConcurrencyError)
  })

  it('publishes visual-only changes under an independent visual revision', () => {
    const { registry: store } = registry()
    const loaded = loadWorkflowDirectory(EXAMPLE_DIR)
    const first = store.saveDraft({ bundle: loaded.bundle })
    const firstPublished = store.publish({
      definitionId: first.definitionId,
      expectedDraftSemanticHash: first.semanticHash,
      expectedHeadRevisionId: null
    })
    const moved = store.saveDraft({
      bundle: {
        ...loaded.bundle,
        editor: { schemaVersion: 1, nodes: { start: { x: 300, y: 120 } } }
      },
      visualOnly: true,
      expectedDraftSemanticHash: first.semanticHash,
      expectedHeadRevisionId: firstPublished.semanticHash
    })
    const republished = store.publish({
      definitionId: moved.definitionId,
      expectedDraftSemanticHash: moved.semanticHash,
      expectedHeadRevisionId: firstPublished.semanticHash
    })
    expect(republished.semanticHash).toBe(firstPublished.semanticHash)
    expect(republished.visualHash).not.toBe(firstPublished.visualHash)
    expect(republished.bundle.editor).toEqual(moved.bundle.editor)
  })

  it('changes the semantic hash when script bytes change', () => {
    const { registry: store } = registry()
    const loaded = loadWorkflowDirectory(EXAMPLE_DIR)
    const first = store.saveDraft({ bundle: loaded.bundle })
    const assets = loaded.bundle.assets.map((asset) =>
      asset.relativePath === 'scripts/collect.mjs'
        ? { ...asset, bytes: `${asset.bytes as string}\n// touched\n` }
        : asset
    )
    const second = store.saveDraft({ bundle: { ...loaded.bundle, assets } })
    expect(second.semanticHash).not.toBe(first.semanticHash)
  })

  it('raises optimistic concurrency conflicts on draft and head mismatches', () => {
    const { registry: store } = registry()
    const loaded = loadWorkflowDirectory(EXAMPLE_DIR)
    const saved = store.saveDraft({ bundle: loaded.bundle })
    expect(() =>
      store.saveDraft({ bundle: loaded.bundle, expectedDraftSemanticHash: 'not-the-hash' })
    ).toThrow(WorkflowConcurrencyError)

    store.publish({
      definitionId: saved.definitionId,
      expectedDraftSemanticHash: saved.semanticHash,
      expectedHeadRevisionId: null
    })
    expect(() =>
      store.publish({
        definitionId: saved.definitionId,
        expectedDraftSemanticHash: saved.semanticHash,
        expectedHeadRevisionId: null
      })
    ).toThrow(WorkflowConcurrencyError)
  })

  it('rejects traversal asset paths', () => {
    const { registry: store } = registry()
    const loaded = loadWorkflowDirectory(EXAMPLE_DIR)
    loaded.bundle.assets.push({ relativePath: '../secret.txt', bytes: 'nope' })
    expect(() => store.saveDraft({ bundle: loaded.bundle })).toThrow(/Unsafe asset path|traversal|Absolute/i)
  })

  it('rejects reserved and duplicate asset paths', () => {
    const { registry: store } = registry()
    const loaded = loadWorkflowDirectory(EXAMPLE_DIR)
    expect(() => store.saveDraft({
      bundle: { ...loaded.bundle, assets: [...loaded.bundle.assets, loaded.bundle.assets[0]!] }
    })).toThrow(/Duplicate asset path/)
    expect(() => store.saveDraft({
      bundle: { ...loaded.bundle, assets: [...loaded.bundle.assets, { relativePath: 'workflow.json', bytes: '{}' }] }
    })).toThrow(/reserved/)
  })

  it('rejects revision traversal and never falls back to a draft export', () => {
    const { registry: store } = registry()
    const loaded = loadWorkflowDirectory(EXAMPLE_DIR)
    const saved = store.saveDraft({ bundle: loaded.bundle })
    expect(() => store.getRevision(saved.definitionId, '../draft')).toThrow(/SHA-256/)
    expect(() => store.exportDirectory(saved.definitionId, tempDir('mousse-wf-missing-revision-'), {
      revisionId: 'a'.repeat(64)
    })).toThrow(/revision cannot be exported/)
  })

  it('rejects symlink assets that escape the package root', () => {
    const pkg = tempDir('mousse-wf-symlink-')
    const outside = tempDir('mousse-wf-outside-')
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    writeFileSync(
      join(pkg, 'workflow.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: '55555555-5555-4555-8555-555555555555',
        name: 'symlink',
        slug: 'symlink_pack',
        inputSchema: { type: 'object', additionalProperties: false },
        outputSchema: { type: 'object', additionalProperties: true },
        entryNodeId: 'start',
        nodes: [
          { id: 'start', type: 'start', version: 1, config: {} },
          { id: 'end', type: 'end', version: 1, config: {} }
        ],
        edges: [{ from: 'start', port: 'next', to: 'end' }]
      })
    )
    try {
      symlinkSync(join(outside, 'secret.txt'), join(pkg, 'leaked.txt'))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'ENOTSUP') return
      throw error
    }
    const loaded = loadWorkflowDirectory(pkg)
    expect(loaded.bundle.assets.some((asset) => asset.relativePath === 'leaked.txt')).toBe(false)
  })

  it('discovers project workflows without enabling or executing them', () => {
    const projectRoot = tempDir('mousse-wf-project-')
    const bundleDir = join(projectRoot, '.mousse', 'workflows', 'summarize-files')
    mkdirSync(bundleDir, { recursive: true })
    const loaded = loadWorkflowDirectory(EXAMPLE_DIR)
    writeFileSync(join(bundleDir, 'workflow.json'), JSON.stringify(loaded.bundle.manifest, null, 2))
    const profileRoot = tempDir('mousse-wf-profile-')
    const store = new WorkflowRegistry({
      profileId: 'profile-test',
      profileRoot,
      trustedProjectRoots: [{ projectId: 'proj-1', root: projectRoot }]
    })
    const found = store.discover().filter((item) => item.source === 'project')
    expect(found).toHaveLength(1)
    expect(found[0]!.enabled).toBe(false)
    expect(found[0]!.slug).toBe('summarize_files')
  })

  it('does not fake zip archive import', async () => {
    const { registry: store } = registry()
    await expect(store.importArchive(join(EXAMPLE_DIR, 'missing.zip'))).rejects.toBeInstanceOf(
      WorkflowArchiveUnsupportedError
    )
    await expect(new ZipArchiveImportNotConfigured().extractToStaging('a.zip', tempDir('z-'))).rejects.toBeInstanceOf(
      WorkflowArchiveUnsupportedError
    )
  })

  it('imports the all-node-types catalog graph as a draft without running it', () => {
    const { registry: store } = registry()
    const manifest = createAllNodeTypesManifest()
    const saved = store.saveDraft({
      bundle: {
        manifest,
        assets: [{ relativePath: 'scripts/noop.mjs', bytes: 'export {}\n' }]
      }
    })
    expect(saved.compiled.runnable).toBe(true)
    expect(saved.compiled.unsupportedNodeTypes).toEqual([])
  })
})
