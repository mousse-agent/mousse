import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { getNodeCatalogEntry } from '../../../shared/workflows'
import type { CanvasNodeData } from './graphAdapter'
import { WorkflowNodeIcon } from './WorkflowNodeIcon'
import { CATEGORY_LABELS } from './defaultNode'

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
      {payload.node.type !== 'start' && entry?.runtime !== false ? <Handle type="target" position={Position.Left} id="in" aria-label={`${payload.node.id} input`} /> : null}
      <div className="wf-node__heading"><span className="wf-node__icon"><WorkflowNodeIcon type={payload.node.type} size={18} /></span><div>
        <div className="wf-node__type">{payload.unsupported ? payload.node.type : CATEGORY_LABELS[entry?.category ?? '']}</div>
        <div className="wf-node__title">{label}</div>
      </div></div>
      <div className="wf-node__id" title={payload.node.id}>{payload.node.id}</div>
      {payload.unsupported ? (
        <p className="wf-field-error">Source preserved. This node cannot run.</p>
      ) : null}
      {payload.runOutcome ? <div className="wf-chip">{payload.runOutcome}</div> : null}
      {payload.ports.map((port) => (
        <div className="wf-node__port" key={port}><span>{port}</span><Handle
          type="source"
          position={Position.Right}
          id={port}
          aria-label={`${payload.node.id} ${port}`}
        /></div>
      ))}
    </div>
  )
}
