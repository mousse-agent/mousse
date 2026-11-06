import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown } from '../../lib/icons'
import { FloatingPortal, useFloatingPosition } from '../../lib/floatingLayer'
import type { SelectOption } from './Select'
import '../../styles/select.css'

export interface ComboBoxProps<T extends string = string> {
  /** The option in effect, or a value no option has (a typed one). */
  value: T
  /** What the closed field shows. */
  text: string
  options: readonly SelectOption<T>[]
  /** An option was picked, from the list or by typing its name. */
  onChange: (value: T) => void
  /** Typed text was committed (Enter or leaving the field). Returns false when it is not valid. */
  onCommitText: (text: string) => boolean
  /** The field turned invalid, or valid again (edited, reverted or committed). */
  onInvalidChange?: (invalid: boolean) => void
  id?: string
  ariaLabel?: string
  /** The line that describes the field, or its problem. */
  ariaDescribedBy?: string
  /** Shown while the field is empty, to say it takes typing. */
  placeholder?: string
  /** Tooltip on the field. */
  title?: string
  disabled?: boolean
}

function optionText<T extends string>(option: SelectOption<T>): string {
  if (option.textValue !== undefined) return option.textValue
  return typeof option.label === 'string' ? option.label : option.value
}

/**
 * An editable select: the field takes typed text, and its list offers the usual choices. Same look
 * and list as `Select`. Enter or leaving the field commits the text; Escape puts back what is saved.
 */
export function ComboBox<T extends string = string>({
  value,
  text,
  options,
  onChange,
  onCommitText,
  onInvalidChange,
  id,
  ariaLabel,
  ariaDescribedBy,
  placeholder,
  title,
  disabled
}: ComboBoxProps<T>) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  // What is typed; null while the field shows the saved choice.
  const [draft, setDraft] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  const [minWidth, setMinWidth] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const justFocused = useRef(false)
  const baseId = useId()
  const listId = `${baseId}-list`
  const optionId = (index: number) => `${baseId}-opt-${index}`

  const selectedIndex = useMemo(() => options.findIndex((option) => option.value === value), [options, value])

  const reportedInvalid = useRef(false)
  useEffect(() => {
    if (reportedInvalid.current === invalid) return
    reportedInvalid.current = invalid
    onInvalidChange?.(invalid)
  }, [invalid, onInvalidChange])

  const openList = useCallback(() => {
    if (disabled || options.length === 0) return
    setMinWidth(boxRef.current?.offsetWidth ?? 0)
    // Start on the checked entry; with none checked, nothing is highlighted until an arrow key.
    setActive(selectedIndex >= 0 && !options[selectedIndex].disabled ? selectedIndex : -1)
    setOpen(true)
  }, [disabled, options, selectedIndex])

  const close = useCallback(() => {
    setOpen(false)
    setActive(-1)
  }, [])

  const revert = useCallback(() => {
    setDraft(null)
    setInvalid(false)
  }, [])

  const choose = useCallback((index: number) => {
    const option = options[index]
    if (!option || option.disabled) return
    close()
    revert()
    if (option.value !== value) onChange(option.value)
  }, [close, onChange, options, revert, value])

  /** Commits typed text: an option's name picks it, empty text keeps what is saved. */
  const commitDraft = useCallback(() => {
    if (draft === null) return
    const typed = draft.trim()
    if (!typed || typed === text) { revert(); return }
    const named = options.findIndex((option) => optionText(option).toLowerCase() === typed.toLowerCase())
    if (named >= 0) { choose(named); return }
    if (onCommitText(typed)) revert()
    else setInvalid(true)
  }, [choose, draft, onCommitText, options, revert, text])

  useEffect(() => {
    if (disabled && open) close()
  }, [close, disabled, open])

  // Clicking anywhere outside the field and the list closes it.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (boxRef.current?.contains(target) || listRef.current?.contains(target)) return
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
    anchorRef: boxRef,
    contentRef: listRef,
    placement: 'below-start',
    gap: 4,
    deps: [options.length, minWidth]
  })

  const step = (from: number, direction: 1 | -1): number => {
    for (let index = from; index >= 0 && index < options.length; index += direction) {
      if (!options[index].disabled) return index
    }
    return -1
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    justFocused.current = false
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault()
        if (!open) { openList(); return }
        const next = event.key === 'ArrowDown' ? step(active + 1, 1) : step(active - 1, -1)
        if (next >= 0) setActive(next)
        return
      }
      case 'Enter':
        event.preventDefault()
        // Typing clears the highlight, so a highlighted option was reached with the arrows.
        if (open && active >= 0) choose(active)
        else { close(); commitDraft() }
        return
      case 'Escape':
        // Nothing to undo: let the page handle Escape.
        if (!open && draft === null && !invalid) return
        event.preventDefault()
        // Keep dialogs and pages that close on Escape open.
        event.stopPropagation()
        close()
        revert()
        return
      case 'Tab':
        close()
    }
  }

  const classes = ['ui-select', 'ui-combobox']
  if (open) classes.push('open')
  if (invalid) classes.push('invalid')
  if (disabled) classes.push('disabled')

  return (
    <>
      <div ref={boxRef} className={classes.join(' ')}>
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          className="ui-combobox-input"
          aria-label={ariaLabel}
          aria-autocomplete="none"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
          aria-describedby={ariaDescribedBy}
          aria-invalid={invalid || undefined}
          placeholder={placeholder}
          title={title}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          value={draft ?? text}
          // Focusing selects the text, so typing replaces it; the click that focused keeps that selection.
          onFocus={(event) => { event.currentTarget.select(); justFocused.current = true }}
          onMouseUp={(event) => { if (justFocused.current) event.preventDefault(); justFocused.current = false }}
          onClick={() => { if (!open) openList() }}
          onChange={(event) => {
            setDraft(event.target.value)
            // Typing is not a pick from the list.
            setActive(-1)
            setInvalid(false)
          }}
          onKeyDown={onKeyDown}
          onBlur={() => { close(); commitDraft() }}
        />
        <span
          className="ui-select-chevron-hit"
          aria-hidden="true"
          // Keep focus (and the typed text) in the field.
          onMouseDown={(event) => {
            event.preventDefault()
            if (disabled) return
            inputRef.current?.focus()
            if (open) close()
            else openList()
          }}
        >
          <ChevronDown size={14} strokeWidth={2} className="ui-select-chevron" />
        </span>
      </div>
      {open && (
        <FloatingPortal>
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            className="ui-select-list"
            aria-label={ariaLabel}
            tabIndex={-1}
            style={{ ...floatingStyle, minWidth }}
            // Keep focus in the field so the keyboard keeps working.
            onMouseDown={(event) => event.preventDefault()}
          >
            {options.map((option, index) => {
              const isSelected = index === selectedIndex
              return (
                <div
                  key={`${option.value}:${index}`}
                  id={optionId(index)}
                  role="option"
                  data-index={index}
                  data-value={option.value}
                  aria-selected={isSelected}
                  aria-disabled={option.disabled || undefined}
                  className={`ui-select-option${index === active ? ' active' : ''}${isSelected ? ' selected' : ''}${option.disabled ? ' disabled' : ''}`}
                  onMouseMove={() => { if (!option.disabled && index !== active) setActive(index) }}
                  onClick={() => choose(index)}
                >
                  <span className="ui-select-check" aria-hidden="true">
                    {isSelected && <Check size={14} strokeWidth={2} />}
                  </span>
                  <span className="ui-select-option-text">
                    <span className="ui-select-option-label">{option.label}</span>
                  </span>
                </div>
              )
            })}
          </div>
        </FloatingPortal>
      )}
    </>
  )
}
