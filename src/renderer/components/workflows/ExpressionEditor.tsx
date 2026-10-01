import { EXPRESSION_OPS, parseWorkflowExpression, type WorkflowExpression } from '../../../shared/workflows'

export function ExpressionEditor({
  id,
  label,
  value,
  readOnly,
  onChange
}: {
  id: string
  label: string
  value: unknown
  readOnly?: boolean
  onChange: (value: WorkflowExpression) => void
}) {
  const parsed = parseWorkflowExpression(value ?? { literal: true })
  const error = parsed.ok ? null : parsed.error
  const raw = JSON.stringify(value ?? { literal: true }, null, 2)
  return (
    <div className="wf-field" id={id} data-expression={id}>
      <label htmlFor={`${id}-input`}>{label}</label>
      <select
        aria-label={`${label} operation`}
        disabled={readOnly}
        value={opOf(value)}
        onChange={(event) => {
          const op = event.target.value
          if (op === 'literal') onChange({ literal: true })
          else if (op === 'input') onChange({ ref: 'input', pointer: '' })
          else onChange({ op: op as (typeof EXPRESSION_OPS)[number], args: [{ literal: true }, { literal: true }] })
        }}
      >
        <option value="literal">Literal</option>
        <option value="input">Input pointer</option>
        {EXPRESSION_OPS.map((op) => (
          <option key={op} value={op}>
            {op}
          </option>
        ))}
      </select>
      <textarea
        id={`${id}-input`}
        className="wf-json"
        spellCheck={false}
        readOnly={readOnly}
        rows={8}
        defaultValue={raw}
        key={raw}
        onBlur={(event) => {
          try {
            const next = JSON.parse(event.target.value) as unknown
            const check = parseWorkflowExpression(next)
            if (check.ok) onChange(check.expression)
          } catch {
            /* keep invalid text until it parses; parent diagnostics show the error */
          }
        }}
      />
      <small>Bounded expression AST. No eval, Function, or host I/O.</small>
      {error ? (
        <p className="wf-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function opOf(value: unknown): string {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.op === 'string') return record.op
    if (record.ref === 'input') return 'input'
  }
  return 'literal'
}
