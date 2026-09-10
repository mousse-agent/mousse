import { describe, expect, it } from 'vitest'
import { createBoundedHistory } from '../src/renderer/components/workflows/history'
import { createWorkflowNode, controlOutPortsForNode } from '../src/renderer/components/workflows/defaultNode'
import { IsolatedWorkflowDefinitionsClient } from './fixtures/agent-platform/workflow-editor-client'
import { createBlankWorkflowBundle } from '../src/renderer/components/workflows/templates'

describe('bounded undo history', () => {
  it('undo/redo and drops entries beyond the limit', () => {
    const history = createBoundedHistory<number>(3)
    const h1 = history.push(1)
    const h2 = h1.push(2)
    const h3 = h2.push(3)
    const h4 = h3.push(4)
    const undone = h4.undo(5)
    expect(undone?.next).toBe(4)
    const redone = undone!.history.redo(undone!.next)
    expect(redone?.next).toBe(5)
    expect(h4.canUndo).toBe(true)
    expect(history.clear().canUndo).toBe(false)
  })
})

describe('control ports', () => {
  it('uses catalog ports and switch case keys without coercing unknown types', () => {
    const condition = createWorkflowNode('condition', 'c1')
    expect(controlOutPortsForNode(condition)).toEqual(['true', 'false'])
    const sw = createWorkflowNode('switch', 's1')
    expect(controlOutPortsForNode(sw)).toContain('default')
    expect(controlOutPortsForNode(sw)).toContain('a')
    const unknown = { id: 'x', type: 'quantum-gate', version: 1, config: { keep: 1 } }
    expect(controlOutPortsForNode(unknown)).toEqual(['unsupported'])
  })
})

describe('visual-only save contract', () => {
  it('rejects a visualOnly save that would change semantic bytes', async () => {
    const client = new IsolatedWorkflowDefinitionsClient()
    const created = await client.create({ profileId: 'p', bundle: createBlankWorkflowBundle('A') })
    await expect(
      client.saveDraft({
        profileId: 'p',
        id: created.id,
        expectedDraftSemanticHash: created.semanticHash,
        visualOnly: true,
        bundle: {
          ...created.bundle,
          manifest: { ...created.bundle.manifest, description: 'changed' }
        }
      })
    ).rejects.toMatchObject({ code: 'INVALID_GRAPH' })
  })
})
