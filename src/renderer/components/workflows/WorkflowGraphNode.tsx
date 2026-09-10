import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { getNodeCatalogEntry } from '../../../shared/workflows'
import type { CanvasNodeData } from './graphAdapter'

type MousseNode = Node<CanvasNodeData, 'mousse'>

export function WorkflowGraphNode({ data, selected }: NodeProps<MousseNode>) {
  const payload = data
  const entry = getNodeCatalogEntry(payload.node.type)
  const label = entry?.label ?? `Unsupported`
  return (
    <div
      className={`wf-node${payload.unsupported ? ' wf-node--unsupported' : ''}`}
      data-node-id={payload.node.id}
      data-node-type={payload.node.type}
      data-unsupported={payload.unsupported ? 'true' : 'false'}
      data-selected={selected ? 'true' : 'false'}
      data-run-outcome={payload.runOutcome ?? ''}
    >
      <Handle type="target" position={Position.Left} id="in" aria-label={`${payload.node.id} input`} />
      <div className="wf-node__type">{payload.unsupported ? payload.node.type : entry?.category}</div>
      <div className="wf-node__title">{payload.node.id}</div>
      <div className="wf-chip">{label}</div>
      {payload.unsupported ? (
        <p className="wf-field-error">Source preserved. This node cannot run.</p>
      ) : null}
      {payload.runOutcome ? <div className="wf-chip">{payload.runOutcome}</div> : null}
      {payload.ports.map((port, index) => (
        <Handle
          key={port}
          type="source"
          position={Position.Right}
          id={port}
          style={{ top: 24 + index * 14 }}
          aria-label={`${payload.node.id} ${port}`}
        />
      ))}
    </div>
  )
}
