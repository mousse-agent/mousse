import { isPlainObject, type BoundedJsonSchema } from '../../../shared/workflows'
import { useCallback, useEffect, useRef, useState } from 'react'

export function SchemaInputForm({
  schema,
  value,
  onChange,
  disabled,
  idPrefix = 'input',
  onValidityChange
}: {
  schema: BoundedJsonSchema | Record<string, unknown>
  value: unknown
  onChange: (value: unknown) => void
  disabled?: boolean
  idPrefix?: string
  onValidityChange?: (valid: boolean) => void
}) {
  const [invalid, setInvalid] = useState<Record<string, boolean>>({})
  const report = useCallback((id: string, valid: boolean) => setInvalid((previous) => Boolean(previous[id]) === !valid ? previous : { ...previous, [id]: !valid }), [])
  const schemaKey = JSON.stringify(schema)
  useEffect(() => setInvalid({}), [idPrefix, schemaKey])
  useEffect(() => onValidityChange?.(!Object.values(invalid).some(Boolean)), [invalid, onValidityChange])
  const record = isPlainObject(value) ? value : {}
  const properties = isPlainObject(schema.properties) ? schema.properties : {}
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : []
  const keys = Object.keys(properties)
  if (keys.length === 0) {
    return (
      <div className="wf-field">
        <label htmlFor={`${idPrefix}-json`}>Input JSON</label>
        <JsonInput id={`${idPrefix}-json`} value={value ?? {}} disabled={disabled} onChange={onChange} onValidityChange={(valid) => report('$root', valid)} />
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
            {renderField(fieldId, type, fieldSchema, current, disabled, (next) => onChange({ ...record, [key]: next }), (valid) => report(key, valid))}
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
  onChange: (value: unknown) => void,
  onValidityChange: (valid: boolean) => void
) {
  if (Array.isArray(schema.enum)) {
    return (
      <select id={id} disabled={disabled} value={current === undefined ? '' : String(schema.enum.findIndex((item) => JSON.stringify(item) === JSON.stringify(current)))} onChange={(event) => onChange(event.target.value === '' ? undefined : (schema.enum as unknown[])[Number(event.target.value)])}>
        <option value="">Select</option>
        {schema.enum.map((item, index) => (
          <option key={index} value={String(index)}>
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
    return <JsonInput id={id} value={current ?? []} kind="array" disabled={disabled} onChange={onChange} onValidityChange={onValidityChange} />
  }
  if (type === 'object') {
    return <JsonInput id={id} value={current ?? {}} kind="object" disabled={disabled} onChange={onChange} onValidityChange={onValidityChange} />
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

function JsonInput({ id, value, kind, disabled, onChange, onValidityChange }: {
  id: string; value: unknown; kind?: 'array' | 'object'; disabled?: boolean
  onChange: (value: unknown) => void; onValidityChange: (valid: boolean) => void
}) {
  const serialized = JSON.stringify(value, null, 2)
  const lastValue = useRef(serialized)
  const [text, setText] = useState(serialized)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (lastValue.current !== serialized) { lastValue.current = serialized; setText(serialized); setError(null) }
  }, [serialized])
  useEffect(() => onValidityChange(error === null), [error, onValidityChange])
  return <>
    <textarea id={id} className="wf-json" spellCheck={false} rows={4} disabled={disabled} value={text} aria-invalid={Boolean(error)} aria-describedby={error ? id + '-error' : undefined} onChange={(event) => {
      const next = event.target.value
      setText(next)
      try {
        const parsed: unknown = JSON.parse(next)
        if ((kind === 'array' && !Array.isArray(parsed)) || (kind === 'object' && !isPlainObject(parsed))) throw new Error('Expected a JSON ' + kind)
        lastValue.current = JSON.stringify(parsed, null, 2)
        setError(null); onChange(parsed)
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'Enter valid JSON') }
    }} />
    {error ? <small id={id + '-error'} className="wf-field-error">{error}</small> : null}
  </>
}

export function missingRequiredInputs(schema: BoundedJsonSchema | Record<string, unknown>, value: unknown): string[] {
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : []
  const record = isPlainObject(value) ? value : {}
  return required.filter((key) => record[key] === undefined || record[key] === '')
}
