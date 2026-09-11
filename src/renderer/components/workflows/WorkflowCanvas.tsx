import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type OnSelectionChangeParams,
  type ReactFlowInstance,
  type Viewport
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import '@xyflow/react/dist/style.css'
import type { WorkflowEditorDocument, WorkflowManifest } from '../../../shared/workflows'
import { explainInvalidConnection } from './localValidation'
import { manifestToCanvas, parseEdgeId } from './graphAdapter'
import { WorkflowGraphNode } from './WorkflowGraphNode'

const NODE_TYPES = { mousse: WorkflowGraphNode }

export function WorkflowCanvas({
  manifest,
  editor,
  selectedId,
  runOutcomes,
  readOnly,
  onSelect,
  onConnect,
  onDisconnect,
  onDeleteNodes,
  onPositionsChange,
  onViewportChange,
  connectionError,
  onConnectionError
}: {
  manifest: WorkflowManifest
  editor?: WorkflowEditorDocument
  selectedId?: string
  runOutcomes?: Record<string, string>
  readOnly?: boolean
  onSelect: (id: string | null) => void
  onConnect: (edge: { from: string; port: string; to: string }) => void
  onDisconnect: (id: string) => void
  onDeleteNodes?: (ids: string[]) => void
  onPositionsChange: (nodes: Array<{ id: string; position: { x: number; y: number } }>) => void
  onViewportChange?: (viewport: Viewport) => void
  connectionError?: string | null
  onConnectionError?: (message: string | null) => void
}) {
  const mapped = useMemo(
    () => manifestToCanvas(manifest, editor, selectedId, runOutcomes),
    [editor, manifest, runOutcomes, selectedId]
  )
  const [nodes, setNodes, onNodesChange] = useNodesState(mapped.nodes as unknown as Node[])
  const [edges, setEdges, onEdgesChange] = useEdgesState(mapped.edges as unknown as Edge[])
  const wrapper = useRef<HTMLDivElement>(null)
  const [flow, setFlow] = useState<ReactFlowInstance | null>(null)

  useEffect(() => {
    const element = wrapper.current
    if (!element || !flow) return
    let first = 0, second = 0
    const keepGraphVisible = () => {
      cancelAnimationFrame(first); cancelAnimationFrame(second)
      // React Flow measures its own container on resize. Wait for that layout
      // before fitting, and preserve the user's pan whenever a node is visible.
      first = requestAnimationFrame(() => { second = requestAnimationFrame(() => {
        const bounds = element.getBoundingClientRect()
        if (!bounds.width || !bounds.height) return
        const rendered = Array.from(element.querySelectorAll('.react-flow__node'))
        const visible = rendered.some((node) => {
          const box = node.getBoundingClientRect()
          return box.width > 0 && box.height > 0 && box.left < bounds.right && box.right > bounds.left && box.top < bounds.bottom && box.bottom > bounds.top
        })
        if (rendered.length && !visible) void flow.fitView({ padding: 0.2, duration: 0 })
      }) })
    }
    const observer = new ResizeObserver(keepGraphVisible)
    observer.observe(element)
    keepGraphVisible()
    return () => { observer.disconnect(); cancelAnimationFrame(first); cancelAnimationFrame(second) }
  }, [flow, manifest.id, nodes.length])

  useEffect(() => {
    // Definition/selection updates must preserve React Flow's measured size.
    // Dropping it hides nodes until a ResizeObserver fires again, which may
    // never happen when only the node's data or selection changed.
    setNodes((current) => {
      const previous = new Map(current.map((node) => [node.id, node]))
      return mapped.nodes.map((node) => ({ ...previous.get(node.id), ...node })) as Node[]
    })
    setEdges(mapped.edges as unknown as Edge[])
  }, [mapped, setEdges, setNodes])

  const onConnectInternal = useCallback(
    (connection: Connection) => {
      if (readOnly) return
      if (!connection.source || !connection.target || !connection.sourceHandle) return
      const edge = { from: connection.source, port: connection.sourceHandle, to: connection.target }
      const reason = explainInvalidConnection(manifest, edge)
      if (reason) {
        onConnectionError?.(reason)
        return
      }
      onConnectionError?.(null)
      onConnect(edge)
      setEdges((current) => addEdge({ ...connection, targetHandle: 'in', label: connection.sourceHandle }, current))
    },
    [manifest, onConnect, onConnectionError, readOnly, setEdges]
  )

  const onSelectionChange = useCallback(
    (params: OnSelectionChangeParams) => {
      const id = params.nodes[0]?.id ?? null
      onSelect(id)
    },
    [onSelect]
  )

  return (
    <div ref={wrapper} className="wf-canvas-wrap" data-canvas="" aria-label="Workflow canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onInit={setFlow}
        onNodesChange={(changes) => {
          onNodesChange(readOnly ? changes.filter((change) => change.type === 'dimensions' || change.type === 'select') : changes)
        }}
        onEdgesChange={(changes) => {
          if (readOnly) return
          onEdgesChange(changes)
          for (const change of changes) {
            if (change.type === 'remove') onDisconnect(change.id)
          }
        }}
        onConnect={onConnectInternal}
        onSelectionChange={onSelectionChange}
        onNodeDragStop={(_event, _node, all) => {
          onPositionsChange(all.map((node) => ({ id: node.id, position: node.position })))
        }}
        onMoveEnd={(_event, viewport) => onViewportChange?.(viewport)}
        fitView
        snapToGrid
        snapGrid={[16, 16]}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable
        deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
        multiSelectionKeyCode="Shift"
        onNodesDelete={(deleted) => {
          if (readOnly) return
          onDeleteNodes?.(deleted.map((node) => node.id))
          onSelect(null)
        }}
        aria-label="Workflow graph"
      >
        <Background gap={16} />
        <Controls showInteractive={!readOnly} />
        <MiniMap pannable zoomable bgColor="#1a1d24" maskColor="#00000088" nodeColor="#6b7c99" />
      </ReactFlow>
      {connectionError ? (
        <div className="wf-banner wf-banner--error" role="alert" data-connection-error="">
          {connectionError}
        </div>
      ) : null}
      <span className="wf-hidden" data-canvas-node-count="">
        {nodes.length}
      </span>
      <span className="wf-hidden" data-canvas-edge-ids="">
        {edges.map((edge) => parseEdgeId(edge.id)?.from ?? edge.id).join(',')}
      </span>
    </div>
  )
}
