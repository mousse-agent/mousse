import type { ReactNode } from 'react'
import { fieldIdForPointer } from './editorIssues'

export function Field({
  id,
  label,
  hint,
  error,
  children
}: {
  id?: string
  label: string
  hint?: string
  error?: string
  children: ReactNode
}) {
  return (
    <div className="agent-field" id={id} data-field={id}>
      <label htmlFor={id ? `${id}-input` : undefined}>{label}</label>
      {children}
      {hint ? <small>{hint}</small> : null}
      {error ? (
        <p className="agent-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function SettingGroup({
  pointer,
  title,
  lead,
  children
}: {
  pointer: string
  title: string
  lead?: string
  children: ReactNode
}) {
  return (
    <section className="agent-setting-group" id={fieldIdForPointer(pointer)} data-setting={pointer}>
      <h3>{title}</h3>
      {lead ? <p className="agent-setting-lead">{lead}</p> : null}
      {children}
    </section>
  )
}

export function CheckRow({
  id,
  checked,
  onChange,
  children,
  disabled
}: {
  id: string
  checked: boolean
  onChange: (value: boolean) => void
  children: ReactNode
  disabled?: boolean
}) {
  return (
    <label className="agent-check-row" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{children}</span>
    </label>
  )
}
