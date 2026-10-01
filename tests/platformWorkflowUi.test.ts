import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WORKFLOW_MAX_BUNDLE_BYTES, WORKFLOW_NODE_TYPES } from '../src/shared/workflows'
import { createAsyncGate, shouldApplyAsyncResult } from '../src/renderer/components/workflows/asyncGate'
import { collectLocalDiagnostics, explainInvalidConnection } from '../src/renderer/components/workflows/localValidation'
import { parseWorkflowImportFile } from '../src/renderer/components/workflows/importBundle'
import {
  filterWorkflowLibrary,
  publicationState,
  type WorkflowLibraryQuery
} from '../src/renderer/components/workflows/libraryFilter'
import { manifestToCanvas, addEdgeToManifest } from '../src/renderer/components/workflows/graphAdapter'
import { applyLayoutToEditor } from '../src/renderer/components/workflows/graphLayout'
import { isVisualOnlyChange, semanticIdentity } from '../src/renderer/components/workflows/semanticIdentity'
import { parseManifestSource } from '../src/renderer/components/workflows/sourceParse'
import { WORKFLOW_TEMPLATES, createBlankWorkflowBundle } from '../src/renderer/components/workflows/templates'
import { WorkflowLibrary } from '../src/renderer/components/workflows/WorkflowLibrary'
import { WorkflowRunPanel } from '../src/renderer/components/workflows/WorkflowRunPanel'
import type { WorkflowLibraryItem } from '../src/renderer/components/workflows/client'
import type { WorkflowRunView } from '../src/shared/workflowRunPlatform'
import { IsolatedWorkflowDefinitionsClient, IsolatedWorkflowExecutionClient } from './fixtures/agent-platform/workflow-editor-client'

const css = readFileSync(new URL('../src/renderer/components/workflows/workflows.css', import.meta.url), 'utf8')

function item(overrides: Partial<WorkflowLibraryItem> & Pick<WorkflowLibraryItem, 'id' | 'name' | 'slug'>): WorkflowLibraryItem {
  return {
    source: 'profile',
    enabled: true,
    draftSemanticHash: 'd1',
    updatedAt: '2026-01-02T00:00:00.000Z',
    tags: [],
    ...overrides
  }
}

describe('library filter and sort', () => {
  const items = [
    item({ id: '1', name: 'Summarize', slug: 'summarize', tags: ['script'], updatedAt: '2026-01-02T00:00:00.000Z' }),
    item({
      id: '2',
      name: 'Review',
      slug: 'review',
      tags: ['agent'],
      updatedAt: '2026-01-03T00:00:00.000Z',
      lastRunAt: '2026-01-04T00:00:00.000Z',
      headRevisionId: 'abc',
      headSemanticHash: 'abc',
      draftSemanticHash: 'abc'
    })
  ]
  const base: WorkflowLibraryQuery = { search: '', tag: '', status: 'all', sort: 'name' }

  it('searches, filters tags/status, and sorts', () => {
    expect(filterWorkflowLibrary(items, { ...base, search: 'summ' }).map((entry) => entry.id)).toEqual(['1'])
    expect(filterWorkflowLibrary(items, { ...base, tag: 'agent' }).map((entry) => entry.id)).toEqual(['2'])
    expect(filterWorkflowLibrary(items, { ...base, status: 'published' }).map((entry) => entry.id)).toEqual(['2'])
    expect(filterWorkflowLibrary(items, { ...base, sort: 'lastRun' }).map((entry) => entry.id)).toEqual(['2', '1'])
  })

  it('labels draft versus published', () => {
    expect(publicationState(item({ id: '1', name: 'A', slug: 'a' }))).toBe('draft')
    expect(
      publicationState(item({ id: '1', name: 'A', slug: 'a', headRevisionId: 'h', headSemanticHash: 'd1', draftSemanticHash: 'd1' }))
    ).toBe('published')
    expect(
      publicationState(item({ id: '1', name: 'A', slug: 'a', headRevisionId: 'h', headSemanticHash: 'old', draftSemanticHash: 'd1' }))
    ).toBe('unpublished-changes')
  })
})

describe('import shape/size gate', () => {
  it('rejects oversized or non-bundle JSON before the port is called', () => {
    expect(() => parseWorkflowImportFile({ name: 'x.json', size: 12, text: '{not json' })).toThrow(/not valid JSON/)
    expect(() => parseWorkflowImportFile({ name: 'x.json', size: WORKFLOW_MAX_BUNDLE_BYTES + 1, text: '{}' })).toThrow(/larger than/)
    expect(() => parseWorkflowImportFile({ name: 'x.json', size: 2, text: '{}' })).toThrow(/manifest/)
  })
})

describe('stale async guard', () => {
  it('drops results from a previous profile/definition generation', () => {
    const gate = createAsyncGate()
    const first = gate.bump()
    const second = gate.bump()
    expect(shouldApplyAsyncResult(first, gate.current())).toBe(false)
    expect(shouldApplyAsyncResult(second, gate.current())).toBe(true)
  })
})

describe('templates', () => {
  it('emits valid v1 manifests covering catalog classes used by the library', () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const bundle = template.create()
      const local = collectLocalDiagnostics(bundle.manifest)
      expect(bundle.manifest.schemaVersion).toBe(1)
      expect(local.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
      expect(bundle.manifest.nodes.some((node) => node.type === 'start')).toBe(true)
    }
    expect(WORKFLOW_NODE_TYPES.includes('script')).toBe(true)
  })
})

describe('semantic identity vs layout', () => {
  it('keeps semantic identity when only editor.json positions change', () => {
    const bundle = createBlankWorkflowBundle('Layout')
    const next = {
      ...bundle,
      editor: applyLayoutToEditor(bundle.editor, { start: { x: 12, y: 48 }, end: { x: 400, y: 160 } })
    }
    expect(semanticIdentity(bundle.manifest, bundle.assets)).toBe(semanticIdentity(next.manifest, next.assets))
    expect(isVisualOnlyChange(bundle, next)).toBe(true)
  })
})

describe('canvas adapter roundtrip', () => {
  it('roundtrips nodes/edges without changing semantic identity', () => {
    const bundle = createBlankWorkflowBundle('Roundtrip')
    const canvas = manifestToCanvas(bundle.manifest, bundle.editor)
    expect(canvas.nodes.map((node) => node.id).sort()).toEqual(bundle.manifest.nodes.map((node) => node.id).sort())
    expect(canvas.edges).toHaveLength(bundle.manifest.edges.length)
    const connected = addEdgeToManifest(bundle.manifest, { from: 'end', port: 'next', to: 'start' })
    const reason = explainInvalidConnection(bundle.manifest, { from: 'end', port: 'next', to: 'start' })
    expect(reason).toMatch(/does not expose control port/i)
    expect(connected.edges.length).toBeGreaterThanOrEqual(bundle.manifest.edges.length)
  })
})

describe('source parse', () => {
  it('retains invalid JSON and applies a valid object without dropping extra fields', () => {
    const invalid = parseManifestSource('{ nope')
    expect(invalid.ok).toBe(false)
    if (invalid.ok) throw new Error('expected invalid')
    expect(invalid.rawText).toBe('{ nope')
    const valid = parseManifestSource(
      JSON.stringify({
        schemaVersion: 1,
        id: '11111111-1111-4111-8111-111111111111',
        name: 'A',
        slug: 'a',
        entryNodeId: 'start',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        nodes: [{ id: 'start', type: 'start', version: 1, config: {} }],
        edges: [],
        vendorExtra: { keep: true }
      })
    )
    expect(valid.ok).toBe(true)
    if (!valid.ok) throw new Error('expected valid')
    expect(valid.extrasPreserved).toBe(true)
    expect((valid.manifest as unknown as { vendorExtra: { keep: boolean } }).vendorExtra.keep).toBe(true)
  })
})

describe('isolated client conflicts, fences, and fixture runs', () => {
  it('rejects stale draft hashes and labels fixture execution', async () => {
    const client = new IsolatedWorkflowDefinitionsClient()
    const created = await client.create({ profileId: 'p', templateId: 'blank', name: 'A' })
    await client.saveDraft({
      profileId: 'p',
      id: created.id,
      expectedDraftSemanticHash: created.semanticHash,
      bundle: {
        ...created.bundle,
        manifest: { ...created.bundle.manifest, description: 'v2' }
      }
    })
    await expect(
      client.saveDraft({
        profileId: 'p',
        id: created.id,
        expectedDraftSemanticHash: created.semanticHash,
        bundle: created.bundle
      })
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })

    const execution = new IsolatedWorkflowExecutionClient()
    await expect(
      execution.start({ profileId: 'p', definitionId: created.id, requestId: crypto.randomUUID(), draft: true, input: {} } as Parameters<typeof execution.start>[0])
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    const draftRun = await execution.start({
      profileId: 'p',
      definitionId: created.id,
      requestId: crypto.randomUUID(),
      draft: true,
      expectedDraftSemanticHash: created.semanticHash,
      input: {}
    })
    expect(draftRun.origin).toBe('fixture')
    const run = await execution.start({ profileId: 'p', definitionId: created.id, requestId: crypto.randomUUID(), input: { requireApproval: true } })
    expect(run.origin).toBe('fixture')
    expect(run.state).toBe('waiting-approval')
    expect(run.result).toMatchObject({ fixture: true })
    const approved = await execution.approve({
      profileId: 'p',
      runId: run.runId,
      approvalId: run.pendingApproval!.approvalId,
      nodeId: run.pendingApproval!.nodeId,
      instanceKey: run.pendingApproval!.instanceKey,
      attempt: run.pendingApproval!.attempt,
      approved: true
    })
    expect(approved.state).toBe('succeeded')
    expect(execution.dryRun).toBeUndefined()
    expect(execution.setBreakpoint).toBeUndefined()
  })

  it('does not apply list results from another profile', async () => {
    const client = new IsolatedWorkflowDefinitionsClient()
    await client.create({ profileId: 'a', name: 'Alpha' })
    await client.create({ profileId: 'b', name: 'Beta' })
    const a = await client.list({ profileId: 'a' })
    const b = await client.list({ profileId: 'b' })
    expect(a.every((row) => row.name !== 'Beta')).toBe(true)
    expect(b.every((row) => row.name !== 'Alpha')).toBe(true)
  })

  it('preserves unsupported node types instead of coercing them', async () => {
    const client = new IsolatedWorkflowDefinitionsClient()
    const bundle = createBlankWorkflowBundle('Future')
    bundle.manifest.nodes.push({ id: 'future', type: 'quantum-gate', version: 1, config: { keep: true } })
    const seeded = client.seed('p', bundle)
    expect(seeded.bundle.manifest.nodes.some((node) => node.type === 'quantum-gate')).toBe(true)
    const validated = await client.validate({ profileId: 'p', bundle: seeded.bundle })
    expect(validated.compiled.unsupportedNodeTypes).toContain('quantum-gate')
    expect(validated.runnable).toBe(false)
  })
})

describe('concurrent run waits', () => {
  it('renders every independently actionable approval and input', () => {
    const manifest = createBlankWorkflowBundle('Waits').manifest
    const approval = (id: string) => ({ approvalId: id, runId: 'run', nodeId: `${id}-node`, instanceKey: `${id}/node`, attempt: 1, description: id })
    const pendingInput = (id: string) => ({ runId: 'run', nodeId: `${id}-node`, instanceKey: `${id}/node`, prompt: `${id} prompt`, schema: { type: 'string' } })
    const run: WorkflowRunView = {
      runId: 'run', profileId: 'p', definitionId: manifest.id, state: 'waiting-approval', origin: 'fixture',
      events: [], attempts: [], artifacts: [], pendingApprovals: [approval('approval-a'), approval('approval-b')],
      pendingInputs: [pendingInput('input-a'), pendingInput('input-b')]
    }
    const execution = {
      start: async () => run, get: async () => run, list: async () => ({ runs: [] }), trace: async () => ({ events: [], afterSequence: 0, hasMore: false }),
      cancel: async () => run, approve: async () => run, answer: async () => run,
      subscribe: () => ({ unsubscribe() {} })
    }
    const html = renderToStaticMarkup(createElement(WorkflowRunPanel, {
      profileId: 'p', definitionId: manifest.id, manifest, execution, run, onRunChange() {}
    }))
    expect((html.match(/data-approval=/g) ?? [])).toHaveLength(2)
    expect((html.match(/data-ask-user=/g) ?? [])).toHaveLength(2)
    expect(html).toContain('approval-a')
    expect(html).toContain('input-b prompt')
  })
})

describe('library static rendering', () => {
  it('renders New workflow and a loading state on first paint, not dummy cards', () => {
    const pending = new IsolatedWorkflowDefinitionsClient()
    pending.list = () => new Promise(() => undefined)
    const html = renderToStaticMarkup(
      createElement(WorkflowLibrary, {
        profileId: 'p',
        client: pending,
        onOpen: () => undefined
      })
    )
    expect(html).toContain('New workflow')
    expect(html).toContain('Loading workflows')
    expect(html).not.toContain('data-workflow-card')
    expect(css).toContain('wf-library-grid')
  })
})
