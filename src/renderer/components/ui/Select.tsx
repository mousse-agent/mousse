import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import { Check, ChevronDown } from '../../lib/icons'
import { FloatingPortal, useFloatingPosition } from '../../lib/floatingLayer'
import '../../styles/select.css'

export interface SelectOption<T extends string = string> {
  value: T
  label: ReactNode
  /** Text used for type-ahead when the label is not a plain string. */
  textValue?: string
  description?: ReactNode
  disabled?: boolean
  /** Consecutive options with the same group share one small heading. */
  group?: string
}

export interface SelectProps<T extends string = string> {
  value: T | '' | undefined | null
  onChange: (value: T) => void
  options: readonly SelectOption<T>[]
  disabled?: boolean
  /** Shown when no option matches the value. */
  placeholder?: ReactNode
  id?: string
  ariaLabel?: string
  ariaLabelledBy?: string
  size?: 'default' | 'small'
  className?: string
  /** Custom trigger content for the selected option. */
  renderValue?: (option: SelectOption<T> | undefined) => ReactNode
  'data-testid'?: string
  title?: string
}

const TYPEAHEAD_RESET_MS = 600

function optionText<T extends string>(option: SelectOption<T>): string {
  if (option.textValue !== undefined) return option.textValue
  return typeof option.label === 'string' || typeof option.label === 'number' ? String(option.label) : option.value
}

/**
 * Themed replacement for a native <select>. Focus stays on the trigger while
 * the list is open (select-only combobox pattern) and the list renders in a
 * portal so scroll containers never clip it.
 */
export function Select<T extends string = string>({
  value,
  onChange,
  options,
  disabled,
  placeholder,
  id,
  ariaLabel,
  ariaLabelledBy,
  size = 'default',
  className,
  renderValue,
  title,
  'data-testid': testId
}: SelectProps<T>) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [minWidth, setMinWidth] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const typeahead = useRef({ text: '', at: 0 })
  const baseId = useId()
  const listId = `${baseId}-list`
  const optionId = (index: number) => `${baseId}-opt-${index}`

  const selectedIndex = useMemo(
    () => (value === undefined || value === null ? -1 : options.findIndex((option) => option.value === value)),
    [options, value]
  )
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined

  const enabledIndex = useCallback(
    (from: number, step: 1 | -1): number => {
      for (let index = from; index >= 0 && index < options.length; index += step) {
        if (!options[index].disabled) return index
      }
      return -1
    },
    [options]
  )

  const openList = useCallback(() => {
    if (disabled || options.length === 0) return
    setMinWidth(triggerRef.current?.offsetWidth ?? 0)
    setActive(selectedIndex >= 0 && !options[selectedIndex].disabled ? selectedIndex : enabledIndex(0, 1))
    setOpen(true)
  }, [disabled, enabledIndex, options, selectedIndex])

  const close = useCallback(() => {
    setOpen(false)
    setActive(-1)
  }, [])

  const commit = useCallback(
    (index: number) => {
      const option = options[index]
      if (!option || option.disabled) return
      close()
      triggerRef.current?.focus()
      if (option.value !== value) onChange(option.value)
    },
    [close, onChange, options, value]
  )

  useEffect(() => {
    if (disabled && open) close()
  }, [close, disabled, open])

  // Clicking anywhere outside the trigger and the list closes it.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || listRef.current?.contains(target)) return
      close()
    }
    const onBlur = () => close()
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [close, open])

  useLayoutEffect(() => {
    if (!open || active < 0) return
    const list = listRef.current
    const node = list?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    if (!list || !node) return
    if (node.offsetTop < list.scrollTop) list.scrollTop = node.offsetTop - 4
    else if (node.offsetTop + node.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = node.offsetTop + node.offsetHeight - list.clientHeight + 4
    }
  }, [active, open])

  const floatingStyle = useFloatingPosition({
    open,
    anchorRef: triggerRef,
    contentRef: listRef,
    placement: 'below-start',
    gap: 4,
    deps: [options.length, minWidth]
  })

  const matchTypeahead = (key: string): number => {
    const now = Date.now()
    const state = typeahead.current
    state.text = now - state.at > TYPEAHEAD_RESET_MS ? key : state.text + key
    state.at = now
    const query = state.text.toLowerCase()
    // Repeating one letter cycles through options starting with it.
    const repeated = query.length > 1 && [...query].every((char) => char === query[0])
    const needle = repeated ? query[0] : query
    const current = open ? active : selectedIndex
    const begin = repeated || query.length === 1 ? current + 1 : Math.max(current, 0)
    for (let offset = 0; offset < options.length; offset++) {
      const index = (begin + offset) % options.length
      const option = options[index]
      if (!option.disabled && optionText(option).toLowerCase().startsWith(needle)) return index
    }
    return -1
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return
    const { key } = event
    if (!open) {
      if (key === 'Enter' || key === ' ' || key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault()
        openList()
        return
      }
      if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        // Like a native select: typing on the closed control changes the value.
        const index = matchTypeahead(key)
        if (index >= 0 && options[index].value !== value) onChange(options[index].value)
      }
      return
    }

    switch (key) {
      case 'ArrowDown': {
        event.preventDefault()
        const next = enabledIndex(active + 1, 1)
        if (next >= 0) setActive(next)
        return
      }
      case 'ArrowUp': {
        event.preventDefault()
        const previous = enabledIndex(active - 1, -1)
        if (previous >= 0) setActive(previous)
        return
      }
      case 'Home':
      case 'PageUp':
        event.preventDefault()
        setActive(enabledIndex(0, 1))
        return
      case 'End':
      case 'PageDown':
        event.preventDefault()
        setActive(enabledIndex(options.length - 1, -1))
        return
      case 'Enter':
        event.preventDefault()
        if (active >= 0) commit(active)
        else close()
        return
      case ' ':
        event.preventDefault()
        // A space inside a type-ahead run is part of the text.
        if (typeahead.current.text && Date.now() - typeahead.current.at < TYPEAHEAD_RESET_MS) {
          const index = matchTypeahead(' ')
          if (index >= 0) setActive(index)
        } else if (active >= 0) commit(active)
        return
      case 'Escape':
        event.preventDefault()
        // Keep dialogs and pages that close on Escape open.
        event.stopPropagation()
        close()
        return
      case 'Tab':
        close()
        return
      default:
        if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const index = matchTypeahead(key)
          if (index >= 0) setActive(index)
        }
    }
  }

  const triggerContent = renderValue
    ? renderValue(selected)
    : selected
      ? selected.label
      : placeholder

  const classes = ['ui-select']
  if (size === 'small') classes.push('small')
  if (open) classes.push('open')
  if (className) classes.push(className)

  let lastGroup: string | undefined
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        role="combobox"
        className={classes.join(' ')}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        disabled={disabled}
        title={title}
        value={value ?? ''}
        data-value={value ?? ''}
        data-testid={testId}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onKeyDown}
      >
        <span className={`ui-select-value${selected || renderValue ? '' : ' placeholder'}`}>{triggerContent}</span>
        <ChevronDown size={14} strokeWidth={2} className="ui-select-chevron" aria-hidden="true" />
      </button>
      {open && (
        <FloatingPortal>
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            className="ui-select-list"
            aria-label={ariaLabel}
            aria-labelledby={ariaLabel ? undefined : ariaLabelledBy ?? id}
            tabIndex={-1}
            style={{ ...floatingStyle, minWidth }}
            // Keep focus on the trigger so the keyboard keeps working.
            onMouseDown={(event) => event.preventDefault()}
          >
            {options.map((option, index) => {
              const header = option.group !== undefined && option.group !== lastGroup ? option.group : undefined
              const separated = option.group === undefined && lastGroup !== undefined
              lastGroup = option.group
              const isSelected = index === selectedIndex
              return (
                <div key={`${option.value}:${index}`} role="presentation">
                  {header !== undefined && (
                    <div className="ui-select-group" role="presentation">
                      {header}
                    </div>
                  )}
                  {separated && <div className="ui-select-separator" role="presentation" />}
                  <div
                    id={optionId(index)}
                    role="option"
                    data-index={index}
                    data-value={option.value}
                    aria-selected={isSelected}
                    aria-disabled={option.disabled || undefined}
                    className={`ui-select-option${index === active ? ' active' : ''}${isSelected ? ' selected' : ''}${option.disabled ? ' disabled' : ''}`}
                    onMouseMove={() => {
                      if (!option.disabled && index !== active) setActive(index)
                    }}
                    onClick={() => commit(index)}
                  >
                    <span className="ui-select-check" aria-hidden="true">
                      {isSelected && <Check size={14} strokeWidth={2} />}
                    </span>
                    <span className="ui-select-option-text">
                      <span className="ui-select-option-label">{option.label}</span>
                      {option.description && <span className="ui-select-option-desc">{option.description}</span>}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </FloatingPortal>
      )}
    </>
  )
}
