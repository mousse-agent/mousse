import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ArrowShrink, Check, History, Loader2 } from '../lib/icons'
import { FloatingPortal, useClosestAnchor, useFloatingPosition } from '../lib/floatingLayer'
import { shortTokens } from '../lib/promptCache'
import { focusRunSettings, moveFocus } from './ComposerEffortPicker'

export interface IdleCompactionChipProps {
  /** `suggest`: the cache went cold, so the next send re-reads `historyTokens`; `compacting`: Compact now runs. */
  state: 'suggest' | 'compacting'
  historyTokens: number
  /** "Cache expired 1h 12m ago" or "Idle 1h 12m", over the menu. */
  cacheText: string
  /** "≈$0.91" when the thread pays per token. */
  costText?: string
  onCompact: () => void
}

/**
 * Left of the context ring once a thread's prompt cache has gone cold: the next send re-reads the full
 * history. It stays on Full (the send works as always) and offers Compact now, which starts at once and
 * runs while the person types; it then reads "Compacting…" until the compaction ends.
 */
export function IdleCompactionChip({ state, historyTokens, cacheText, costText, onCompact }: IdleCompactionChipProps) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const openedByKeyboard = useRef(false)
  // Above the whole composer, its right edge on the composer's, so it never covers the draft.
  const anchorRef = useClosestAnchor(buttonRef, '.composer')
  const style = useFloatingPosition({ open, anchorRef, contentRef: menuRef, placement: 'above-end', deps: [historyTokens, cacheText] })
  const shown = open && style.visibility === 'visible'
  useEffect(() => {
    if (shown) focusRunSettings(menuRef.current, openedByKeyboard.current)
  }, [shown])
  useEffect(() => {
    if (!open) return
    const dismiss = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !buttonRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('mousedown', dismiss)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', dismiss); document.removeEventListener('keydown', escape) }
  }, [open])
  // The menu goes with the suggestion.
  useEffect(() => { if (state !== 'suggest') setOpen(false) }, [state])

  if (state === 'compacting') {
    return <span className="composer-idle-chip is-compacting" role="status" title="Compacting the history; you can keep typing">
      <Loader2 size={14} aria-hidden="true" className="animate-spin" />
      <span>Compacting…</span>
    </span>
  }

  const history = shortTokens(historyTokens)
  const close = () => { setOpen(false); buttonRef.current?.focus() }
  const keys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.key === 'Tab') {
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
      const at = items.indexOf(document.activeElement as HTMLElement)
      event.preventDefault()
      items[(at + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus()
      return
    }
    moveFocus(event)
  }
  const fullLine = [`Re-reads ${history}`, costText].filter(Boolean).join(' · ')
  const rows = [
    { key: 'compact', Icon: ArrowShrink, name: 'Compact now', line: 'Summarizes older messages', on: false, pick: onCompact },
    { key: 'full', Icon: History, name: 'Full history', line: fullLine, on: true, pick: () => undefined }
  ]
  const label = `Next message sends the full history: ${history}. ${cacheText}`
  return <>
    <button
      ref={buttonRef}
      type="button"
      className={`composer-idle-chip${open ? ' open' : ''}`}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={label}
      title={label}
      onClick={(event) => {
        openedByKeyboard.current = event.detail === 0
        setOpen(!open)
      }}
    >
      <History size={14} aria-hidden="true" />
      <span>Full · {history}</span>
    </button>
    {open ? <FloatingPortal><div ref={menuRef} style={style} className="composer-mode-menu composer-mode-menu-floating composer-run-menu composer-permission-menu composer-idle-menu" role="menu" aria-label="Next message" onKeyDown={keys}>
      <div className="composer-idle-menu-head">{cacheText}</div>
      <div className="composer-mode-menu-section composer-permission-modes" role="group" aria-label="History">
        {rows.map(({ key, Icon, name, line, on, pick }) => (
          <button
            key={key}
            type="button"
            role="menuitemradio"
            aria-checked={on}
            aria-label={`${name}. ${line}`}
            className={`composer-permission-mode${on ? ' selected' : ''}`}
            onClick={() => { close(); pick() }}
          >
            <Icon size={15} aria-hidden="true" className="composer-permission-mode-icon" />
            <span className="composer-permission-mode-text">
              <span className="composer-permission-mode-name">{name}</span>
              <span className="composer-permission-mode-desc">{line}</span>
            </span>
            <span className="composer-permission-mode-check" aria-hidden="true">{on ? <Check size={14} /> : null}</span>
          </button>
        ))}
      </div>
    </div></FloatingPortal> : null}
  </>
}
