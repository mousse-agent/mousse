import { useEffect, useState } from 'react'

export function JsonValueEditor({
  id,
  label,
  value,
  onChange,
  readOnly
}: {
  id: string
  label: string
  value: unknown
  onChange: (value: Record<string, unknown> | undefined) => void
  readOnly?: boolean
}) {
  const [raw, setRaw] = useState(() => JSON.stringify(value ?? {}, null, 2))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setRaw(JSON.stringify(value ?? {}, null, 2))
  }, [value])

  return (
    <div className="agent-field" id={id}>
      <label htmlFor={`${id}-input`}>{label}</label>
      <textarea
        id={`${id}-input`}
        className="agent-json-editor"
        spellCheck={false}
        readOnly={readOnly}
        rows={8}
        value={raw}
        onChange={(event) => {
          const next = event.target.value
          setRaw(next)
          if (!next.trim()) {
            setError(null)
            onChange(undefined)
            return
          }
          try {
            const parsed = JSON.parse(next) as unknown
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              setError('JSON object required.')
              return
            }
            setError(null)
            onChange(parsed as Record<string, unknown>)
          } catch {
            setError('Invalid JSON.')
          }
        }}
      />
      {error ? (
        <p className="agent-field-error" role="alert">
          {error}
        </p>
      ) : (
        <small>Structured JSON. Invalid JSON is kept in the field until it parses.</small>
      )}
    </div>
  )
}
