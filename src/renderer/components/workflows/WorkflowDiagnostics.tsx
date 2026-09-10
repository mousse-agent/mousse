import type { WorkflowDiagnostic } from '../../../shared/workflows'

export function WorkflowDiagnostics({
  diagnostics,
  onSelectNode
}: {
  diagnostics: readonly WorkflowDiagnostic[]
  onSelectNode?: (nodeId: string) => void
}) {
  if (diagnostics.length === 0) {
    return (
      <div data-diagnostics="" className="wf-banner">
        No diagnostics.
      </div>
    )
  }
  return (
    <ul data-diagnostics="" className="wf-diagnostics">
      {diagnostics.map((item, index) => (
        <li key={`${item.code}:${item.nodeId ?? ''}:${index}`} data-severity={item.severity}>
          <strong>{item.code}</strong> {item.message}
          {item.nodeId ? (
            <button type="button" className="btn btn-sm" onClick={() => onSelectNode?.(item.nodeId!)}>
              {item.nodeId}
            </button>
          ) : null}
          {item.path ? <small>{item.path}</small> : null}
        </li>
      ))}
    </ul>
  )
}
