import type {
  WorkflowEdge,
  WorkflowEditorDocument,
  WorkflowEditorNodeVisual,
  WorkflowManifest,
  WorkflowNode
} from '../../../shared/workflows'
import { controlOutPortsForNode, isKnownNodeType } from './defaultNode'

export interface CanvasNodeData {
  node: WorkflowNode
  unsupported: boolean
  label: string
  ports: string[]
  runOutcome?: string
  [key: string]: unknown
}

export interface CanvasNode {
  id: string
  type: 'mousse'
  position: { x: number; y: number }
  data: CanvasNodeData
  selected?: boolean
}

export interface CanvasEdge {
  id: string
  source: string
  target: string
  sourceHandle: string
  targetHandle: 'in'
  label?: string
  selected?: boolean
}

export function edgeId(edge: WorkflowEdge): string {
  return `${edge.from}:${edge.port}->${edge.to}`
}

export function parseEdgeId(id: string): WorkflowEdge | null {
  const match = /^(.+):(.+)->(.+)$/.exec(id)
  if (!match) return null
  return { from: match[1], port: match[2], to: match[3] }
}

export function defaultPosition(index: number): { x: number; y: number } {
  return { x: 80 + (index % 4) * 240, y: 80 + Math.floor(index / 4) * 140 }
}

export function manifestToCanvas(
  manifest: WorkflowManifest,
  editor?: WorkflowEditorDocument,
  selectedId?: string,
  runOutcomes?: Record<string, string>
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const visuals = editor?.nodes ?? {}
  const nodes: CanvasNode[] = manifest.nodes.map((node, index) => {
    const visual = visuals[node.id]
    return {
      id: node.id,
      type: 'mousse',
      position: visual ? { x: visual.x, y: visual.y } : defaultPosition(index),
      selected: node.id === selectedId,
      data: {
        node,
        unsupported: !isKnownNodeType(node.type),
        label: isKnownNodeType(node.type) ? node.type : `Unsupported (${node.type})`,
        ports: controlOutPortsForNode(node),
        runOutcome: runOutcomes?.[node.id]
      }
    }
  })
  const edges: CanvasEdge[] = manifest.edges.map((edge) => ({
    id: edgeId(edge),
    source: edge.from,
    target: edge.to,
    sourceHandle: edge.port,
    targetHandle: 'in',
    label: edge.port
  }))
  return { nodes, edges }
}

export function canvasPositionsToEditor(
  previous: WorkflowEditorDocument | undefined,
  nodes: Array<{ id: string; position: { x: number; y: number } }>,
  viewport?: WorkflowEditorDocument['viewport']
): WorkflowEditorDocument {
  const nextNodes: Record<string, WorkflowEditorNodeVisual> = { ...(previous?.nodes ?? {}) }
  for (const node of nodes) {
    nextNodes[node.id] = {
      ...nextNodes[node.id],
      x: node.position.x,
      y: node.position.y
    }
  }
  const ids = new Set(nodes.map((node) => node.id))
  for (const id of Object.keys(nextNodes)) {
    if (!ids.has(id)) delete nextNodes[id]
  }
  return {
    schemaVersion: 1,
    viewport: viewport ?? previous?.viewport,
    nodes: nextNodes,
    collapsedGroups: previous?.collapsedGroups,
    annotations: previous?.annotations
  }
}

export function replaceNode(manifest: WorkflowManifest, next: WorkflowNode): WorkflowManifest {
  return {
    ...manifest,
    nodes: manifest.nodes.map((node) => (node.id === next.id ? next : node))
  }
}

export function removeNodes(manifest: WorkflowManifest, ids: Iterable<string>): WorkflowManifest {
  const drop = new Set(ids)
  const nodes = manifest.nodes.filter((node) => !drop.has(node.id))
  const edges = manifest.edges.filter((edge) => !drop.has(edge.from) && !drop.has(edge.to))
  const entryNodeId = drop.has(manifest.entryNodeId)
    ? (nodes.find((node) => node.type === 'start')?.id ?? nodes[0]?.id ?? manifest.entryNodeId)
    : manifest.entryNodeId
  return { ...manifest, nodes, edges, entryNodeId }
}

export function addEdgeToManifest(manifest: WorkflowManifest, edge: WorkflowEdge): WorkflowManifest {
  if (manifest.edges.some((item) => item.from === edge.from && item.port === edge.port && item.to === edge.to)) {
    return manifest
  }
  return { ...manifest, edges: [...manifest.edges, edge] }
}

export function removeEdgeFromManifest(manifest: WorkflowManifest, id: string): WorkflowManifest {
  const edge = parseEdgeId(id)
  if (!edge) return manifest
  return {
    ...manifest,
    edges: manifest.edges.filter((item) => !(item.from === edge.from && item.port === edge.port && item.to === edge.to))
  }
}

export function duplicateNodes(
  manifest: WorkflowManifest,
  ids: Iterable<string>,
  newId: (existing: Iterable<string>, prefix?: string) => string
): { manifest: WorkflowManifest; createdIds: string[] } {
  const selected = new Set(ids)
  const existing = new Set(manifest.nodes.map((node) => node.id))
  const remap = new Map<string, string>()
  const created: WorkflowNode[] = []
  for (const node of manifest.nodes) {
    if (!selected.has(node.id)) continue
    const id = newId(existing, node.type === 'start' ? 'start' : 'node')
    existing.add(id)
    remap.set(node.id, id)
    created.push({ ...structuredClone(node), id })
  }
  const extraEdges = manifest.edges
    .filter((edge) => remap.has(edge.from) && remap.has(edge.to))
    .map((edge) => ({
      from: remap.get(edge.from)!,
      port: edge.port,
      to: remap.get(edge.to)!
    }))
  return {
    manifest: {
      ...manifest,
      nodes: [...manifest.nodes, ...created],
      edges: [...manifest.edges, ...extraEdges]
    },
    createdIds: [...remap.values()]
  }
}
