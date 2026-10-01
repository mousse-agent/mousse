import { describe, expect, it } from 'vitest'
import { compileWorkflow } from '../src/mms/workflows/compiler/compileWorkflow'
import type { WorkflowManifest, WorkflowGraph } from '../src/shared/workflows'

function manifest(reference = 'before'): WorkflowManifest {
  const branch = (id: string): WorkflowGraph => ({
    entryNodeId: id,
    nodes: [{ id, type: 'end', version: 1, config: {}, inputs: { result: { ref: 'node', nodeId: reference, pointer: '' } } }],
    edges: []
  })
  return {
    schemaVersion: 1, id: 'e394733e-574a-4e87-a431-8812c111cd00', name: 'Nested bindings', slug: 'nested-bindings',
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, permissions: { capabilities: [] }, entryNodeId: 'start',
    nodes: [
      { id: 'start', type: 'start', version: 1, config: {} },
      { id: 'before', type: 'transform', version: 1, config: { value: { literal: { sentinel: 'ancestor' } } } },
      { id: 'parallel', type: 'parallel', version: 1, config: { branches: [{ id: 'a', subgraph: branch('a-end') }, { id: 'z', subgraph: branch('z-end') }] } },
      { id: 'after', type: 'end', version: 1, config: {} }
    ],
    edges: [{ from: 'start', port: 'next', to: 'before' }, { from: 'before', port: 'success', to: 'parallel' }, { from: 'parallel', port: 'success', to: 'after' }]
  }
}

describe('nested workflow data availability', () => {
  it('allows parallel branches to read a dominating ancestor', () => {
    const compiled = compileWorkflow(manifest())
    expect(compiled.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
    expect(compiled.runnable).toBe(true)
    expect(Object.keys(compiled.graph.nodes.find((node) => node.id === 'parallel')!.subgraphs!)).toEqual(['branch:a', 'branch:z'])
  })

  it.each(['parallel', 'after', 'z-end'])('rejects an unavailable parent, successor, or sibling: %s', (reference) => {
    const compiled = compileWorkflow(manifest(reference))
    expect(compiled.runnable).toBe(false)
    expect(compiled.diagnostics.some((item) => item.nodeId === 'a-end' && item.code === 'BRANCH_OUTPUT_MISUSE')).toBe(true)
  })

  it('rejects an ancestor that does not dominate the parallel node on every path', () => {
    const source = manifest()
    source.nodes.push({ id: 'condition', type: 'condition', version: 1, config: { expression: { op: 'eq', args: [{ literal: 1 }, { literal: 1 }] } } })
    source.edges[0] = { from: 'start', port: 'next', to: 'condition' }
    source.edges.push({ from: 'condition', port: 'true', to: 'before' }, { from: 'condition', port: 'false', to: 'parallel' })
    const compiled = compileWorkflow(source)
    expect(compiled.runnable).toBe(false)
    expect(compiled.diagnostics.some((item) => item.nodeId === 'a-end' && item.code === 'BRANCH_OUTPUT_MISUSE')).toBe(true)
  })
})
