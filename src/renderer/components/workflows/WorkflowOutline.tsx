import { getNodeCatalogEntry, type WorkflowEdge, type WorkflowManifest } from '../../../shared/workflows'
import { controlOutPortsForNode } from './defaultNode'

export function WorkflowOutline({
  manifest,
  selectedId,
  onSelect,
  onConnect,
  onDelete,
  readOnly
}: {
  manifest: WorkflowManifest
  selectedId?: string | null
  onSelect: (id: string) => void
  onConnect: (edge: WorkflowEdge) => void
  onDelete: (ids: string[]) => void
  readOnly?: boolean
}) {
  return (
    <div className="wf-outline" data-outline="">
      <table>
        <caption>Accessible node outline</caption>
        <thead>
          <tr>
            <th>Id</th>
            <th>Type</th>
            <th>Ports</th>
          </tr>
        </thead>
        <tbody>
          {manifest.nodes.map((node) => {
            const entry = getNodeCatalogEntry(node.type)
            return (
              <tr key={node.id} data-outline-row={node.id} data-selected={node.id === selectedId ? 'true' : 'false'}>
                <td>
                  <button type="button" className="wf-outline__node" onClick={() => onSelect(node.id)}>
                    {node.id}
                  </button>
                </td>
                <td>{entry?.label ?? `Unsupported (${node.type})`}</td>
                <td>{controlOutPortsForNode(node).join(', ') || '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <form
        className="wf-inline"
        data-connect-form=""
        onSubmit={(event) => {
          event.preventDefault()
          if (readOnly) return
          const form = event.currentTarget
          const from = (form.elements.namedItem('from') as HTMLSelectElement).value
          const port = (form.elements.namedItem('port') as HTMLSelectElement).value
          const to = (form.elements.namedItem('to') as HTMLSelectElement).value
          if (from && port && to) onConnect({ from, port, to })
        }}
      >
        <label>
          From
          <select name="from" aria-label="Connect from node" disabled={readOnly} defaultValue={selectedId ?? ''}>
            {manifest.nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          Port
          <select name="port" aria-label="Connect from port" disabled={readOnly}>
            {[...new Set(manifest.nodes.flatMap((node) => controlOutPortsForNode(node)))].map((port) => (
              <option key={port} value={port}>
                {port}
              </option>
            ))}
          </select>
        </label>
        <label>
          To
          <select name="to" aria-label="Connect to node" disabled={readOnly}>
            {manifest.nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.id}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-sm" data-action="connect-nodes" disabled={readOnly}>
          Connect
        </button>
        <button
          type="button"
          className="btn btn-sm"
          data-action="delete-selected"
          disabled={readOnly || !selectedId}
          onClick={() => selectedId && onDelete([selectedId])}
        >
          Delete selected
        </button>
      </form>
    </div>
  )
}
