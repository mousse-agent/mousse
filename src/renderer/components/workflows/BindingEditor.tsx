import { parseWorkflowBinding, type WorkflowBinding, type WorkflowNode } from '../../../shared/workflows'

export function BindingEditor({
  id,
  label,
  value,
  nodes,
  readOnly,
  onChange
}: {
  id: string
  label: string
  value: unknown
  nodes: readonly WorkflowNode[]
  readOnly?: boolean
  onChange: (value: WorkflowBinding) => void
}) {
  const parsed = parseWorkflowBinding(value ?? { literal: null })
  const kind = bindingKind(value)
  const error = parsed.ok ? null : parsed.error

  const setKind = (next: string) => {
    onChange(bindingForKind(next, value))
  }

  return (
    <div className="wf-field" id={id} data-binding={id}>
      <label htmlFor={`${id}-kind`}>{label}</label>
      <div className="wf-inline">
        <select id={`${id}-kind`} aria-label={`${label} binding kind`} disabled={readOnly} value={kind} onChange={(event) => setKind(event.target.value)}>
          <option value="literal">Literal</option>
          <option value="input">Input pointer</option>
          <option value="node">Node pointer</option>
          <option value="loop">Loop pointer</option>
          <option value="template">Template</option>
          <option value="secret">Secret ref</option>
        </select>
        {kind === 'literal' ? (
          <input
            id={`${id}-literal`}
            disabled={readOnly}
            defaultValue={literalAsText(value)}
            onBlur={(event) => onChange({ literal: parseLiteral(event.target.value) })}
            aria-label={`${label} literal`}
          />
        ) : null}
        {kind === 'input' ? (
          <input
            id={`${id}-pointer`}
            disabled={readOnly}
            value={pointerOf(value)}
            onChange={(event) => onChange({ ref: 'input', pointer: event.target.value })}
            placeholder="/field"
            aria-label={`${label} JSON pointer`}
          />
        ) : null}
        {kind === 'node' ? (
          <>
            <select
              id={`${id}-node`}
              disabled={readOnly}
              value={nodeIdOf(value)}
              onChange={(event) => onChange({ ref: 'node', nodeId: event.target.value, pointer: pointerOf(value) })}
              aria-label={`${label} node`}
            >
              <option value="">Select node</option>
              {nodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.id} ({node.type})
                </option>
              ))}
            </select>
            <input
              disabled={readOnly}
              value={pointerOf(value)}
              onChange={(event) => onChange({ ref: 'node', nodeId: nodeIdOf(value), pointer: event.target.value })}
              placeholder=""
              aria-label={`${label} JSON pointer`}
            />
          </>
        ) : null}
        {kind === 'loop' ? (
          <input
            disabled={readOnly}
            value={pointerOf(value)}
            onChange={(event) => onChange({ ref: 'loop', pointer: event.target.value })}
            placeholder="/previous"
            aria-label={`${label} loop pointer`}
          />
        ) : null}
        {kind === 'template' ? (
          <input
            disabled={readOnly}
            value={templateOf(value)}
            onChange={(event) => onChange({ template: event.target.value })}
            placeholder="{{input.topic}}"
            aria-label={`${label} template`}
          />
        ) : null}
        {kind === 'secret' ? (
          <input
            disabled={readOnly}
            value={secretOf(value)}
            onChange={(event) => onChange({ secretRef: event.target.value })}
            aria-label={`${label} secret id`}
          />
        ) : null}
      </div>
      <small>Bindings are JSON objects. Expressions never eval JavaScript.</small>
      {error ? (
        <p className="wf-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function bindingKind(value: unknown): string {
  if (!value || typeof value !== 'object') return 'literal'
  const record = value as Record<string, unknown>
  if (record.ref === 'input') return 'input'
  if (record.ref === 'node') return 'node'
  if (record.ref === 'loop') return 'loop'
  if ('template' in record) return 'template'
  if ('secretRef' in record) return 'secret'
  return 'literal'
}

function bindingForKind(kind: string, previous: unknown): WorkflowBinding {
  if (kind === 'input') return { ref: 'input', pointer: pointerOf(previous) || '' }
  if (kind === 'node') return { ref: 'node', nodeId: nodeIdOf(previous), pointer: pointerOf(previous) || '' }
  if (kind === 'loop') return { ref: 'loop', pointer: pointerOf(previous) || '/previous' }
  if (kind === 'template') return { template: templateOf(previous) || '{{input}}' }
  if (kind === 'secret') return { secretRef: secretOf(previous) }
  return { literal: parseLiteral(literalAsText(previous)) }
}

function pointerOf(value: unknown): string {
  if (value && typeof value === 'object' && 'pointer' in value && typeof (value as { pointer: unknown }).pointer === 'string') {
    return (value as { pointer: string }).pointer
  }
  return ''
}

function nodeIdOf(value: unknown): string {
  if (value && typeof value === 'object' && 'nodeId' in value && typeof (value as { nodeId: unknown }).nodeId === 'string') {
    return (value as { nodeId: string }).nodeId
  }
  return ''
}

function templateOf(value: unknown): string {
  if (value && typeof value === 'object' && 'template' in value && typeof (value as { template: unknown }).template === 'string') {
    return (value as { template: string }).template
  }
  return ''
}

function secretOf(value: unknown): string {
  if (value && typeof value === 'object' && 'secretRef' in value) {
    const secret = (value as { secretRef: unknown }).secretRef
    if (typeof secret === 'string') return secret
    if (secret && typeof secret === 'object' && 'id' in secret) return String((secret as { id: unknown }).id)
  }
  return ''
}

function literalAsText(value: unknown): string {
  if (value && typeof value === 'object' && 'literal' in value) {
    return JSON.stringify((value as { literal: unknown }).literal)
  }
  return 'null'
}

function parseLiteral(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}
