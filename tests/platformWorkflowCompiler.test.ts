import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  WORKFLOW_MAX_NODES,
  WORKFLOW_NODE_TYPES,
  type WorkflowManifest
} from '../src/shared/workflows'
import { compileWorkflow } from '../src/mms/workflows/compiler/compileWorkflow'
import { createAllNodeTypesManifest } from '../src/mms/workflows/fixtures/allNodeTypes'
import { loadWorkflowDirectory } from '../src/mms/workflows/bundleIo'

const EXAMPLE_DIR = join(process.cwd(), 'examples', 'workflows', 'summarize-files')

function codes(source: unknown): string[] {
  return compileWorkflow(source).diagnostics.map((item) => item.code)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

describe('workflow compiler', () => {
  it('compiles a valid graph that includes every node category', () => {
    const compiled = compileWorkflow(createAllNodeTypesManifest())
    const errors = compiled.diagnostics.filter((item) => item.severity === 'error')
    expect(errors, errors.map((item) => item.message).join('\n')).toEqual([])
    expect(compiled.runnable).toBe(true)
    const types = new Set(compiled.graph.nodes.map((node) => node.type))
    for (const type of WORKFLOW_NODE_TYPES) {
      expect(types.has(type), `missing node type ${type}`).toBe(true)
    }
  })

  it('compiles the architecture 6.3 example without executing scripts', () => {
    const loaded = loadWorkflowDirectory(EXAMPLE_DIR)
    const compiled = compileWorkflow(loaded.bundle.manifest, {
      knownAssets: new Set(loaded.bundle.assets.map((asset) => asset.relativePath))
    })
    expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(compiled.runnable).toBe(true)
    expect(compiled.slug).toBe('summarize_files')
    const collect = compiled.graph.nodes.find((node) => node.id === 'collect')
    expect(collect?.config.fileInputs).toEqual([
      expect.objectContaining({
        pointer: '/files',
        source: 'thread-workspace',
        rewrite: 'relative-staged-paths'
      })
    ])
  })

  it('rejects duplicate node ids', () => {
    const manifest = createStartEnd('dup')
    manifest.nodes.push({ id: 'start', type: 'note', version: 1, config: { text: 'dup' } })
    expect(codes(manifest)).toContain('DUPLICATE_NODE_ID')
    expect(compileWorkflow(manifest).runnable).toBe(false)
  })

  it('rejects raw control cycles', () => {
    const manifest = createStartEnd('cycle')
    manifest.nodes.splice(1, 0, {
      id: 'loopish',
      type: 'transform',
      version: 1,
      config: { value: { literal: 1 } }
    })
    manifest.edges = [
      { from: 'start', port: 'next', to: 'loopish' },
      { from: 'loopish', port: 'success', to: 'loopish' }
    ]
    expect(codes(manifest)).toContain('CYCLE_DETECTED')
  })

  it('rejects missing node refs', () => {
    const manifest = createStartEnd('missing-ref')
    manifest.nodes[1]!.inputs = { result: { ref: 'node', nodeId: 'nope', pointer: '' } }
    const compiled = compileWorkflow(manifest)
    expect(compiled.diagnostics.some((d) => d.code === 'MISSING_REF' || d.code === 'BRANCH_OUTPUT_MISUSE')).toBe(
      true
    )
  })

  it('rejects branch-output misuse after a condition merge', () => {
    const manifest: WorkflowManifest = {
      schemaVersion: 1,
      id: '33333333-3333-4333-8333-333333333333',
      name: 'branch misuse',
      slug: 'branch_misuse',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', additionalProperties: true },
      entryNodeId: 'start',
      permissions: { capabilities: [] },
      nodes: [
        { id: 'start', type: 'start', version: 1, config: {} },
        {
          id: 'cond',
          type: 'condition',
          version: 1,
          config: { expression: { op: 'eq', args: [{ literal: 1 }, { literal: 1 }] } }
        },
        { id: 'only-true', type: 'transform', version: 1, config: { value: { literal: { a: 1 } } } },
        { id: 'joinish', type: 'transform', version: 1, config: { value: { literal: 1 } } },
        {
          id: 'end',
          type: 'end',
          version: 1,
          inputs: { result: { ref: 'node', nodeId: 'only-true', pointer: '' } },
          config: {}
        }
      ],
      edges: [
        { from: 'start', port: 'next', to: 'cond' },
        { from: 'cond', port: 'true', to: 'only-true' },
        { from: 'cond', port: 'false', to: 'joinish' },
        { from: 'only-true', port: 'success', to: 'end' },
        { from: 'joinish', port: 'success', to: 'end' }
      ]
    }
    expect(codes(manifest)).toContain('BRANCH_OUTPUT_MISUSE')
  })

  it('allows reading a branch output only on that branch', () => {
    const manifest = clone(JSON.parse(readFileSync(join(EXAMPLE_DIR, 'workflow.json'), 'utf8')))
    const compiled = compileWorkflow(manifest)
    expect(compiled.diagnostics.filter((d) => d.code === 'BRANCH_OUTPUT_MISUSE')).toEqual([])
    expect(compiled.runnable).toBe(true)
  })

  it('rejects oversized graphs', () => {
    const manifest = createStartEnd('huge')
    for (let i = 0; i < WORKFLOW_MAX_NODES; i += 1) {
      manifest.nodes.push({ id: `n${i}`, type: 'note', version: 1, config: { text: 'x' } })
    }
    expect(codes(manifest)).toContain('GRAPH_TOO_LARGE')
  })

  it('rejects malformed and remote schemas', () => {
    const manifest = createStartEnd('schema')
    manifest.inputSchema = {
      type: 'object',
      pattern: '^(a+)+$',
      $ref: 'https://example.invalid/schema.json'
    } as never
    const compiled = compileWorkflow(manifest)
    expect(compiled.diagnostics.some((d) => d.code === 'REMOTE_SCHEMA_REF')).toBe(true)
    expect(
      compiled.diagnostics.some((d) => d.code === 'INVALID_SCHEMA' || d.code === 'RESTRICTED_SCHEMA_KEYWORD')
    ).toBe(true)
    expect(compiled.runnable).toBe(false)
  })

  it('rejects prototype keys in schemas', () => {
    const manifest = createStartEnd('proto')
    manifest.inputSchema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}')
    expect(codes(manifest)).toContain('PROTOTYPE_KEY')
  })

  it('preserves unsupported node types and marks the graph not runnable', () => {
    const manifest = createStartEnd('unsupported')
    manifest.nodes.splice(1, 0, {
      id: 'future',
      type: 'quantum-oracle',
      version: 9,
      config: { mystery: true }
    })
    manifest.edges = [
      { from: 'start', port: 'next', to: 'future' },
      { from: 'future', port: 'success', to: 'end' }
    ]
    const compiled = compileWorkflow(manifest)
    expect(compiled.unsupportedNodeTypes).toContain('quantum-oracle')
    expect(compiled.runnable).toBe(false)
    const preserved = compiled.graph.nodes.find((node) => node.id === 'future')
    expect(preserved?.sourcePreserved).toBe(true)
    expect(preserved?.config).toEqual({ mystery: true })
  })

  it('rejects reserved slugs', () => {
    const manifest = createStartEnd('help')
    manifest.slug = 'help'
    expect(codes(manifest)).toContain('RESERVED_SLUG')
  })

  it('rejects unbounded loops and detects recursive subworkflows', () => {
    const manifest = createStartEnd('loops')
    manifest.nodes.splice(1, 0, {
      id: 'each',
      type: 'for-each',
      version: 1,
      config: {
        items: { literal: [1] },
        subgraph: {
          entryNodeId: 'w',
          nodes: [
            { id: 'w', type: 'transform', version: 1, config: { value: { literal: 1 } } },
            { id: 'e', type: 'end', version: 1, config: {} }
          ],
          edges: [{ from: 'w', port: 'success', to: 'e' }]
        }
      }
    })
    manifest.edges = [
      { from: 'start', port: 'next', to: 'each' },
      { from: 'each', port: 'completed', to: 'end' }
    ]
    expect(codes(manifest)).toContain('UNBOUNDED_LOOP')

    const recursive = createStartEnd('rec')
    recursive.id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    recursive.nodes.splice(1, 0, {
      id: 'sub',
      type: 'subworkflow',
      version: 1,
      config: { workflow: { id: recursive.id } }
    })
    recursive.edges = [
      { from: 'start', port: 'next', to: 'sub' },
      { from: 'sub', port: 'success', to: 'end' }
    ]
    const compiled = compileWorkflow(recursive, {
      currentWorkflowId: recursive.id,
      compilationStack: [recursive.id]
    })
    expect(compiled.diagnostics.some((d) => d.code === 'SUBWORKFLOW_CYCLE')).toBe(true)
  })

  it('reports missing capabilities and missing pinned dependencies', () => {
    const manifest = createStartEnd('caps')
    manifest.nodes.splice(1, 0, {
      id: 'agent',
      type: 'agent',
      version: 1,
      config: { agent: { kind: 'user', definitionId: 'missing-agent' }, instructions: 'hi' }
    })
    manifest.edges = [
      { from: 'start', port: 'next', to: 'agent' },
      { from: 'agent', port: 'success', to: 'end' }
    ]
    const compiled = compileWorkflow(manifest, {
      mode: 'publish',
      dependencyResolver: {
        hasAgent: () => false
      }
    })
    expect(compiled.diagnostics.some((d) => d.code === 'MISSING_CAPABILITY')).toBe(true)
    expect(compiled.diagnostics.some((d) => d.code === 'MISSING_DEPENDENCY')).toBe(true)
  })

  it('does not treat editor positions as semantic graph data', () => {
    const manifest = createStartEnd('visual')
    const withUi = clone(manifest)
    withUi.nodes[0]!.config = { ui: { x: 10, y: 20 } }
    const a = compileWorkflow(manifest)
    const b = compileWorkflow(withUi)
    expect(a.runnable).toBe(true)
    expect(b.graph.nodes[0]!.config.ui).toEqual({ x: 10, y: 20 })
    expect(a.graph.edges).toEqual(b.graph.edges)
  })
})

function createStartEnd(slug: string): WorkflowManifest {
  return {
    schemaVersion: 1,
    id: '44444444-4444-4444-8444-444444444444',
    name: slug,
    slug,
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: { type: 'object', additionalProperties: true },
    entryNodeId: 'start',
    permissions: { capabilities: [] },
    nodes: [
      { id: 'start', type: 'start', version: 1, config: {} },
      { id: 'end', type: 'end', version: 1, config: {} }
    ],
    edges: [{ from: 'start', port: 'next', to: 'end' }]
  }
}
