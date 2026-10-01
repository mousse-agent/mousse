import { useEffect, useState } from 'react'

export function JsonObjectEditor({
  id,
  label,
  value,
  onChange,
  readOnly,
  hint
}: {
  id: string
  label: string
  value: unknown
  onChange: (value: unknown) => void
  readOnly?: boolean
  hint?: string
}) {
  const [raw, setRaw] = useState(() => JSON.stringify(value ?? {}, null, 2))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setRaw(JSON.stringify(value ?? {}, null, 2))
  }, [value])

  return (
    <div className="wf-field" id={id}>
      <label htmlFor={`${id}-input`}>{label}</label>
      <textarea
        id={`${id}-input`}
        className="wf-json"
        spellCheck={false}
        readOnly={readOnly}
        rows={8}
        value={raw}
        onChange={(event) => {
          const next = event.target.value
          setRaw(next)
          try {
            const parsed = JSON.parse(next) as unknown
            setError(null)
            onChange(parsed)
          } catch {
            setError('Invalid JSON is kept until it parses.')
          }
        }}
      />
      {error ? (
        <p className="wf-field-error" role="alert">
          {error}
        </p>
      ) : (
        <small>{hint ?? 'Structured JSON. Unknown fields are preserved when valid.'}</small>
      )}
    </div>
  )
}
