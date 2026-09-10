import { isPlainObject, type BoundedJsonSchema } from '../../../shared/workflows'

export function SchemaInputForm({
  schema,
  value,
  onChange,
  disabled,
  idPrefix = 'input'
}: {
  schema: BoundedJsonSchema | Record<string, unknown>
  value: unknown
  onChange: (value: unknown) => void
  disabled?: boolean
  idPrefix?: string
}) {
  const record = isPlainObject(value) ? value : {}
  const properties = isPlainObject(schema.properties) ? schema.properties : {}
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : []
  const keys = Object.keys(properties)
  if (keys.length === 0) {
    return (
      <div className="wf-field">
        <label htmlFor={`${idPrefix}-json`}>Input JSON</label>
        <textarea
          id={`${idPrefix}-json`}
          className="wf-json"
          spellCheck={false}
          disabled={disabled}
          rows={8}
          value={JSON.stringify(value ?? {}, null, 2)}
          onChange={(event) => {
            try {
              onChange(JSON.parse(event.target.value) as unknown)
            } catch {
              /* keep previous until valid */
            }
          }}
        />
      </div>
    )
  }
  return (
    <div className="wf-schema-form" data-schema-form="">
      {keys.map((key) => {
        const field = properties[key]
        const fieldSchema = isPlainObject(field) ? field : { type: 'string' }
        const fieldId = `${idPrefix}-${key}`
        const current = record[key]
        const type = typeof fieldSchema.type === 'string' ? fieldSchema.type : 'string'
        const isRequired = required.includes(key)
        return (
          <div className="wf-field" key={key}>
            <label htmlFor={fieldId}>
              {key}
              {isRequired ? ' *' : ''}
            </label>
            {renderField(fieldId, type, fieldSchema, current, disabled, (next) => onChange({ ...record, [key]: next }))}
            {typeof fieldSchema.description === 'string' ? <small>{fieldSchema.description}</small> : null}
          </div>
        )
      })}
    </div>
  )
}

function renderField(
  id: string,
  type: string,
  schema: Record<string, unknown>,
  current: unknown,
  disabled: boolean | undefined,
  onChange: (value: unknown) => void
) {
  if (Array.isArray(schema.enum)) {
    return (
      <select id={id} disabled={disabled} value={String(current ?? '')} onChange={(event) => onChange(event.target.value)}>
        <option value="">Select</option>
        {schema.enum.map((item) => (
          <option key={String(item)} value={String(item)}>
            {String(item)}
          </option>
        ))}
      </select>
    )
  }
  if (type === 'boolean') {
    return (
      <input
        id={id}
        type="checkbox"
        disabled={disabled}
        checked={Boolean(current)}
        onChange={(event) => onChange(event.target.checked)}
      />
    )
  }
  if (type === 'number' || type === 'integer') {
    return (
      <input
        id={id}
        type="number"
        disabled={disabled}
        value={typeof current === 'number' ? current : ''}
        onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))}
      />
    )
  }
  if (type === 'array') {
    const text = Array.isArray(current) ? JSON.stringify(current) : '[]'
    return (
      <input
        id={id}
        disabled={disabled}
        value={text}
        onChange={(event) => {
          try {
            const parsed = JSON.parse(event.target.value) as unknown
            if (Array.isArray(parsed)) onChange(parsed)
          } catch {
            /* keep */
          }
        }}
        aria-label={`${id} JSON array`}
      />
    )
  }
  if (type === 'object') {
    return (
      <textarea
        id={id}
        className="wf-json"
        disabled={disabled}
        rows={4}
        value={JSON.stringify(current ?? {}, null, 2)}
        onChange={(event) => {
          try {
            const parsed = JSON.parse(event.target.value) as unknown
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) onChange(parsed)
          } catch {
            /* keep */
          }
        }}
      />
    )
  }
  return (
    <input
      id={id}
      disabled={disabled}
      value={typeof current === 'string' ? current : current == null ? '' : String(current)}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

export function missingRequiredInputs(schema: BoundedJsonSchema | Record<string, unknown>, value: unknown): string[] {
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : []
  const record = isPlainObject(value) ? value : {}
  return required.filter((key) => record[key] === undefined || record[key] === '')
}
