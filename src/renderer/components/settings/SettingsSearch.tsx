import { useRef, type AriaAttributes, type AriaRole, type KeyboardEvent, type Ref } from 'react'
import { Search, X } from '../../lib/icons'
import '../../styles/settingsSearch.css'

/**
 * The settings search field: a soft filled field with a leading icon and a clear button.
 * Escape clears it when it has text (and stops there); other keys go to `onKeyDown`.
 */
export function SettingsSearch({
  value,
  onChange,
  placeholder = 'Search',
  ariaLabel,
  autoFocus,
  onKeyDown,
  inputRef,
  className,
  inputAria
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  ariaLabel: string
  autoFocus?: boolean
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void
  inputRef?: Ref<HTMLInputElement>
  className?: string
  /** Extra ARIA for the input, e.g. a combobox naming the list its arrow keys move through. */
  inputAria?: AriaAttributes & { role?: AriaRole }
}) {
  const ownRef = useRef<HTMLInputElement | null>(null)
  const setRef = (node: HTMLInputElement | null) => {
    ownRef.current = node
    if (typeof inputRef === 'function') inputRef(node)
    else if (inputRef) (inputRef as { current: HTMLInputElement | null }).current = node
  }
  return (
    <div className={`settings-search${className ? ` ${className}` : ''}`}>
      <Search size={14} aria-hidden="true" className="settings-search-icon" />
      <input
        {...inputAria}
        ref={setRef}
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && value) {
            event.stopPropagation()
            event.preventDefault()
            onChange('')
            return
          }
          onKeyDown?.(event)
        }}
      />
      {value && (
        <button
          type="button"
          className="settings-search-clear"
          aria-label="Clear search"
          title="Clear"
          onClick={() => {
            onChange('')
            ownRef.current?.focus()
          }}
        >
          <X size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
