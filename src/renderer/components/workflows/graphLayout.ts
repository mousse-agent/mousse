import type { WorkflowEdge, WorkflowEditorDocument, WorkflowNode } from '../../../shared/workflows'

const COL_WIDTH = 240
const ROW_HEIGHT = 140
const ORIGIN_X = 80
const ORIGIN_Y = 80

/** Layered DAG layout from the entry node. Updates visual metadata only. */
export function autoLayoutPositions(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  entryNodeId: string
): Record<string, { x: number; y: number }> {
  const outgoing = new Map<string, string[]>()
  for (const edge of edges) {
    const list = outgoing.get(edge.from) ?? []
    list.push(edge.to)
    outgoing.set(edge.from, list)
  }
  const layer = new Map<string, number>()
  const queue = [entryNodeId]
  layer.set(entryNodeId, 0)
  while (queue.length) {
    const id = queue.shift()!
    const nextLayer = (layer.get(id) ?? 0) + 1
    for (const to of outgoing.get(id) ?? []) {
      if (!layer.has(to)) {
        layer.set(to, nextLayer)
        queue.push(to)
      }
    }
  }
  for (const node of nodes) {
    if (!layer.has(node.id)) layer.set(node.id, 0)
  }
  const buckets = new Map<number, string[]>()
  for (const node of nodes) {
    const index = layer.get(node.id) ?? 0
    const bucket = buckets.get(index) ?? []
    bucket.push(node.id)
    buckets.set(index, bucket)
  }
  const positions: Record<string, { x: number; y: number }> = {}
  for (const [index, ids] of buckets) {
    ids.forEach((id, row) => {
      positions[id] = { x: ORIGIN_X + index * COL_WIDTH, y: ORIGIN_Y + row * ROW_HEIGHT }
    })
  }
  return positions
}

export function applyLayoutToEditor(
  previous: WorkflowEditorDocument | undefined,
  positions: Record<string, { x: number; y: number }>
): WorkflowEditorDocument {
  const nodes = { ...(previous?.nodes ?? {}) }
  for (const [id, position] of Object.entries(positions)) {
    nodes[id] = { ...nodes[id], x: position.x, y: position.y }
  }
  return {
    schemaVersion: 1,
    viewport: previous?.viewport,
    nodes,
    collapsedGroups: previous?.collapsedGroups,
    annotations: previous?.annotations
  }
}

export function nudgePosition(
  editor: WorkflowEditorDocument | undefined,
  id: string,
  dx: number,
  dy: number
): WorkflowEditorDocument {
  const current = editor?.nodes?.[id] ?? { x: ORIGIN_X, y: ORIGIN_Y }
  return applyLayoutToEditor(editor, { [id]: { x: current.x + dx, y: current.y + dy } })
}
