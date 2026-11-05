import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  DEFAULT_FONT_STACKS,
  fontChoiceLabel,
  fontStack,
  googleFontsForRole,
  sameFontChoice,
  searchFontNames,
  SYSTEM_FONT_STACKS,
  type FontChoice,
  type FontRole
} from '../../../shared/fontSettings'
import { isGoogleFontLoaded, loadGoogleFont, useAppFontsVersion } from '../../lib/appFonts'
import { isMonospaceFamily, listInstalledFontFamilies } from '../../lib/localFonts'
import { FloatingPortal, useFloatingPosition } from '../../lib/floatingLayer'
import { ChevronDown, Download, Loader2, Search } from '../../lib/icons'
import '../../styles/select.css'
import '../../styles/font-picker.css'

type Group = 'Built in' | 'On this computer' | 'Google Fonts'

interface FontEntry {
  key: string
  choice: FontChoice
  label: string
  group: Group
  /** The stack the row's name and the preview are drawn in. */
  stack: string
  /** A Google family whose files are not loaded yet. */
  pending: boolean
}

/** Rows per group; typing narrows the rest. */
const GROUP_LIMIT = 150

const PREVIEW_TEXT: Record<FontRole, string> = {
  interface: 'Sphinx of black quartz, judge my vow',
  code: 'const total = items.length // 0O 1lI {}'
}

function entryKey(choice: FontChoice): string {
  return `${choice.source}:${choice.family ?? ''}`
}

function buildEntries(role: FontRole, query: string, installed: readonly string[]): FontEntry[] {
  const builtIn: FontEntry[] = [
    { key: 'default:', choice: { source: 'default' }, label: fontChoiceLabel(role, { source: 'default' }), group: 'Built in', stack: DEFAULT_FONT_STACKS[role], pending: false },
    { key: 'system:', choice: { source: 'system' }, label: 'System font', group: 'Built in', stack: SYSTEM_FONT_STACKS[role], pending: false }
  ]
  const local = searchFontNames(installed, query, (family) => family)
    .slice(0, GROUP_LIMIT)
    .map<FontEntry>((family) => {
      const choice: FontChoice = { source: 'installed', family }
      return { key: entryKey(choice), choice, label: family, group: 'On this computer', stack: fontStack(role, choice), pending: false }
    })
  const google = searchFontNames(googleFontsForRole(role), query, (entry) => entry.family)
    .slice(0, GROUP_LIMIT)
    .map<FontEntry>((entry) => {
      const choice: FontChoice = { source: 'google', family: entry.family }
      return { key: entryKey(choice), choice, label: entry.family, group: 'Google Fonts', stack: fontStack(role, choice), pending: !isGoogleFontLoaded(entry.family) }
    })
  return [...searchFontNames(builtIn, query, (entry) => entry.label), ...local, ...google]
}

export interface FontPickerProps {
  role: FontRole
  value: FontChoice
  onChange: (choice: FontChoice) => Promise<void> | void
  ariaLabel: string
}

/**
 * A font control: the built-in and system fonts, the fonts on this computer, and the Google Fonts
 * catalog, with search and a preview line. A Google font downloads when it is chosen.
 */
export function FontPicker({ role, value, onChange, ariaLabel }: FontPickerProps) {
  useAppFontsVersion()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [installed, setInstalled] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const baseId = useId()
  const listId = `${baseId}-list`
  const optionId = (index: number) => `${baseId}-opt-${index}`

  const installedForRole = useMemo(
    () => (role === 'code' ? installed.filter((family) => isMonospaceFamily(family)) : installed),
    [installed, role]
  )
  const entries = useMemo(() => buildEntries(role, query, installedForRole), [installedForRole, query, role])
  const selectedKey = entryKey(value)
  const activeEntry = entries[active] ?? entries[0]

  const openPicker = useCallback(() => {
    setQuery('')
    setError(null)
    setOpen(true)
    // Listing local fonts needs the click that opened the picker.
    void listInstalledFontFamilies().then(setInstalled)
  }, [])

  const close = useCallback((refocus: boolean) => {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }, [])

  // Start on the current choice; a new search starts at the top.
  useEffect(() => {
    if (!open) return
    const index = query ? 0 : entries.findIndex((entry) => entry.key === selectedKey)
    setActive(Math.max(index, 0))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || popRef.current?.contains(target)) return
      close(false)
    }
    const onBlur = () => close(false)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [close, open])

  useLayoutEffect(() => {
    const list = listRef.current
    const node = list?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    if (!open || !list || !node) return
    if (node.offsetTop < list.scrollTop) list.scrollTop = node.offsetTop - 4
    else if (node.offsetTop + node.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = node.offsetTop + node.offsetHeight - list.clientHeight + 4
    }
  }, [active, open])

  const floatingStyle = useFloatingPosition({ open, anchorRef: triggerRef, contentRef: popRef, placement: 'below-end', gap: 4 })

  const choose = async (entry: FontEntry | undefined) => {
    if (!entry || busy) return
    if (sameFontChoice(entry.choice, value)) {
      close(true)
      return
    }
    setError(null)
    if (entry.choice.source === 'google' && entry.choice.family) {
      setBusy(entry.key)
      try {
        const loaded = await loadGoogleFont(entry.choice.family, role, true)
        if (!loaded) throw new Error('not loaded')
      } catch {
        setError(`Couldn't download ${entry.label}. Check the connection and try again.`)
        return
      } finally {
        setBusy(null)
      }
    }
    await onChange(entry.choice)
    close(true)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActive((index) => Math.min(index + 1, entries.length - 1))
        return
      case 'ArrowUp':
        event.preventDefault()
        setActive((index) => Math.max(index - 1, 0))
        return
      case 'PageDown':
        event.preventDefault()
        setActive((index) => Math.min(index + 10, entries.length - 1))
        return
      case 'PageUp':
        event.preventDefault()
        setActive((index) => Math.max(index - 10, 0))
        return
      case 'Enter':
        event.preventDefault()
        void choose(entries[active])
        return
      case 'Escape':
        event.preventDefault()
        // Keep the settings page open.
        event.stopPropagation()
        close(true)
        return
      case 'Tab':
        close(false)
    }
  }

  const label = fontChoiceLabel(role, value)
  let lastGroup: Group | undefined
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`ui-select font-picker-trigger${open ? ' open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${ariaLabel}: ${label}`}
        onClick={() => (open ? close(false) : openPicker())}
        onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault()
            openPicker()
          }
        }}
      >
        <span className="ui-select-value" style={{ fontFamily: fontStack(role, value) }}>{label}</span>
        <ChevronDown size={14} strokeWidth={2} className="ui-select-chevron" aria-hidden="true" />
      </button>
      {open && (
        <FloatingPortal>
          <div ref={popRef} className="font-picker-pop" role="dialog" aria-label={ariaLabel} style={floatingStyle}>
            <div className="font-picker-search">
              <Search size={14} aria-hidden="true" />
              <input
                ref={inputRef}
                role="combobox"
                aria-label={`Search ${ariaLabel.toLowerCase()}s`}
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={activeEntry ? optionId(active) : undefined}
                placeholder="Search fonts"
                value={query}
                spellCheck={false}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onKeyDown}
              />
            </div>
            {error && <div className="font-picker-error" role="alert">{error}</div>}
            <div ref={listRef} id={listId} role="listbox" className="font-picker-list" aria-label={ariaLabel}>
              {entries.length === 0 && <div className="font-picker-empty">No fonts match.</div>}
              {entries.map((entry, index) => {
                const header = entry.group !== lastGroup ? entry.group : undefined
                lastGroup = entry.group
                const selected = entry.key === selectedKey
                return (
                  <div key={entry.key} role="presentation">
                    {header && <div className="ui-select-group" role="presentation">{header}</div>}
                    <div
                      id={optionId(index)}
                      role="option"
                      data-index={index}
                      aria-selected={selected}
                      className={`font-picker-option${index === active ? ' active' : ''}${selected ? ' selected' : ''}`}
                      onMouseMove={() => { if (index !== active) setActive(index) }}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => void choose(entry)}
                    >
                      <span className="font-picker-option-label" style={entry.pending ? undefined : { fontFamily: entry.stack }}>{entry.label}</span>
                      {busy === entry.key && <Loader2 size={13} className="spin" aria-label="Downloading" />}
                    </div>
                  </div>
                )
              })}
            </div>
            {activeEntry && (
              <div className="font-picker-preview" aria-hidden="true">
                <span className="font-picker-preview-text" style={{ fontFamily: activeEntry.stack }}>{PREVIEW_TEXT[role]}</span>
                {activeEntry.pending && (
                  <span className="font-picker-preview-note" title="Downloads from Google Fonts once, when chosen. Until then the preview uses the system font.">
                    <Download size={12} />
                  </span>
                )}
              </div>
            )}
          </div>
        </FloatingPortal>
      )}
    </>
  )
}
