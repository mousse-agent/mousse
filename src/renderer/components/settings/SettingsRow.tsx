import { useId, type ReactNode } from 'react'
import { ChevronRight, type IconComponent } from '../../lib/icons'

/**
 * Settings primitives. Layout rules live at the top of styles/settings.css:
 * one subtle surface per group and no other cards, no nesting, one row
 * anatomy (text left, one control right).
 */

export function SettingsPageTitle({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <header className="settings-page-head">
      <h2 className="settings-page-title">{title}</h2>
      {description && <p className="settings-page-desc">{description}</p>}
    </header>
  )
}

/**
 * A section heading on the page, then its rows on one subtle group surface
 * (.settings-group-rows). With no rows there is no surface; inside a dialog
 * the rows stay flat.
 */
export function SettingsGroup({
  title,
  icon: Icon,
  description,
  action,
  id,
  className,
  children
}: {
  title?: string
  /** Small heading glyph, only where it helps scanning a long page. Not boxed. */
  icon?: IconComponent
  description?: ReactNode
  /** Optional control aligned with the heading, e.g. a switch for the whole group. */
  action?: ReactNode
  id?: string
  className?: string
  children?: ReactNode
}) {
  const headingId = useId()
  return (
    <section
      id={id}
      className={`settings-group${className ? ` ${className}` : ''}`}
      aria-labelledby={title ? headingId : undefined}
    >
      {(title || action) && (
        <div className="settings-group-head">
          <div className="settings-group-head-text">
            {title && (
              <h3 id={headingId} className="settings-group-title">
                {Icon && <Icon size={15} strokeWidth={1.8} aria-hidden="true" className="settings-group-icon" />}
                {title}
              </h3>
            )}
            {description && <p className="settings-group-desc">{description}</p>}
          </div>
          {action && <div className="settings-group-action">{action}</div>}
        </div>
      )}
      {!title && !action && description && <p className="settings-group-desc">{description}</p>}
      <div className="settings-group-rows">{children}</div>
    </section>
  )
}

/** One setting: title and optional description on the left, one control on the right. */
export function SettingsRow({
  title,
  titleAction,
  description,
  control,
  htmlFor,
  titleId,
  disabled,
  indent,
  className,
  children,
  ...rest
}: {
  title: ReactNode
  /** Small inline action right after the title text, e.g. a reset icon button. */
  titleAction?: ReactNode
  description?: ReactNode
  control?: ReactNode
  /** Makes the title a <label> for the control with this id. */
  htmlFor?: string
  /** Id on the title, for aria-labelledby on composite controls. */
  titleId?: string
  disabled?: boolean
  /** Rows that refine the row above (e.g. a skill's default model). */
  indent?: boolean
  className?: string
  /** Full-width content under the title, for controls that do not fit on the right. */
  children?: ReactNode
  'data-task-id'?: string
  'data-device-node'?: string
}) {
  const classes = ['settings-item']
  if (disabled) classes.push('disabled')
  if (indent) classes.push('indent')
  if (children) classes.push('has-body')
  if (className) classes.push(className)
  const titleElement = htmlFor ? (
    <label htmlFor={htmlFor} id={titleId} className="settings-item-title">{title}</label>
  ) : (
    <span id={titleId} className="settings-item-title">{title}</span>
  )
  return (
    <div className={classes.join(' ')} {...rest}>
      <div className="settings-item-text">
        {titleAction ? (
          <div className="settings-item-title-row">
            {titleElement}
            {titleAction}
          </div>
        ) : titleElement}
        {description && <div className="settings-item-desc">{description}</div>}
      </div>
      {control && <div className="settings-item-control">{control}</div>}
      {children && <div className="settings-item-body">{children}</div>}
    </div>
  )
}

export interface SegmentedOption<T extends string | number> {
  value: T
  label: ReactNode
  title?: string
}

/** Single-choice control; the selected segment is raised. */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
  ariaLabelledBy,
  id
}: {
  value: T
  options: ReadonlyArray<SegmentedOption<T>>
  onChange: (value: T) => void
  disabled?: boolean
  ariaLabel?: string
  ariaLabelledBy?: string
  id?: string
}) {
  return (
    <div
      id={id}
      className="settings-seg"
      role="radiogroup"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-disabled={disabled || undefined}
    >
      {options.map((option) => {
        const on = option.value === value
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={on}
            title={option.title}
            disabled={disabled}
            className={on ? 'on' : undefined}
            onClick={() => { if (!on) onChange(option.value) }}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/** On/off switch with the app's toggle look. */
export function Switch({
  checked,
  onChange,
  label,
  id,
  disabled
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label?: string
  id?: string
  disabled?: boolean
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`toggle-switch${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    />
  )
}

/** The one "Advanced" disclosure a page may have, for rarely changed settings. */
export function SettingsAdvanced({ label = 'Advanced', children }: { label?: string; children: ReactNode }) {
  return (
    <details className="settings-advanced">
      <summary>
        <ChevronRight size={14} aria-hidden="true" className="settings-advanced-chevron" />
        {label}
      </summary>
      <div className="settings-advanced-body">{children}</div>
    </details>
  )
}
