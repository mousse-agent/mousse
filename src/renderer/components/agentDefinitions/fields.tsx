import type { ReactNode } from 'react'
import { Switch } from '../settings/SettingsRow'
import { Select, type SelectOption } from '../ui/Select'
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
      <label id={id ? `${id}-label` : undefined} htmlFor={id ? `${id}-input` : undefined}>{label}</label>
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

/** The shared themed select inside a `Field` with the same `field` id; the field's label names it. */
export function FieldSelect<T extends string>({
  field,
  value,
  options,
  onChange,
  disabled
}: {
  field: string
  value: T
  options: readonly SelectOption<T>[]
  onChange: (value: T) => void
  disabled?: boolean
}) {
  return (
    <Select<T>
      id={`${field}-input`}
      ariaLabelledBy={`${field}-label`}
      value={value}
      options={options}
      onChange={onChange}
      disabled={disabled}
    />
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

/** An on/off row: the text on the left names the shared switch on the right, and clicking it toggles. */
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
    <div className="agent-check-row agent-switch-row">
      <label id={`${id}-label`} htmlFor={id}>{children}</label>
      <Switch id={id} checked={checked} disabled={disabled} onChange={onChange} labelledBy={`${id}-label`} />
    </div>
  )
}
