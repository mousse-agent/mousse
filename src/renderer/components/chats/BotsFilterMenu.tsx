import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { Check } from '../../lib/icons'
import { FloatingPortal, useFloatingPosition } from '../../lib/floatingLayer'
import { focusInitialMenuItem, useMenuKeyboard } from '../../hooks/useMenuKeyboard'
import { BOT_STATE_LABELS, type BotListFilter, type BotStateFilter } from '../../lib/botList'
import { ComputerMark } from '../sidebar/ThreadFilterBar'
import '../../styles/thread-filter.css'

const STATES: readonly BotStateFilter[] = ['all', 'needs', 'working']

/**
 * The Bots list's filter menu, under the filter button beside +: by computer (All, This computer, each other computer,
 * shown only when other computers' bots are listed), by state (All bots, Needs me, Working), Hide offline (with other
 * computers' bots), and Show hidden with how many are hidden. The same menu rows as the Threads filter.
 */
export function BotsFilterMenu({ anchorRef, filter, computers, hidden, onChange, onClose }: {
  anchorRef: RefObject<HTMLButtonElement | null>
  filter: BotListFilter
  computers: ReadonlyArray<{ node: string; name: string }>
  /** How many listed bots are hidden. */
  hidden: number
  onChange(change: Partial<BotListFilter>): void
  onClose(refocus: boolean): void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const style = useFloatingPosition({ open: true, anchorRef, contentRef: menuRef, placement: 'below-end', gap: 6, deps: [computers.length] })
  const onMenuKeyDown = useMenuKeyboard(menuRef, () => onClose(true))
  // Placed (and made visible) after it mounts; a hidden item cannot take focus, so wait a frame.
  useEffect(() => {
    const frame = requestAnimationFrame(() => focusInitialMenuItem(menuRef.current))
    return () => cancelAnimationFrame(frame)
  }, [])
  useEffect(() => {
    const away = (event: MouseEvent) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return
      onClose(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [anchorRef, onClose])

  const radio = (key: string, checked: boolean, label: string, pick: () => void, mark?: ReactNode) => (
    <button key={key} type="button" role="menuitemradio" aria-checked={checked} className="threads-context-menu-item thread-filter-menu-item" onClick={pick}>
      <span className="thread-filter-check" aria-hidden="true">{checked && <Check size={14} strokeWidth={2.2} />}</span>
      {mark}
      <span className="thread-filter-option-name">{label}</span>
    </button>
  )
  const toggle = (checked: boolean, label: string, flip: () => void) => (
    <button type="button" role="menuitemcheckbox" aria-checked={checked} className="threads-context-menu-item thread-filter-menu-item" onClick={flip}>
      <span className="thread-filter-check" aria-hidden="true">{checked && <Check size={14} strokeWidth={2.2} />}</span>
      <span>{label}</span>
    </button>
  )
  const separator = <div className="threads-context-menu-separator thread-filter-menu-separator" role="separator" />
  const elsewhere = computers.length > 0

  return (
    <FloatingPortal>
      <div
        ref={menuRef}
        className="threads-context-menu thread-filter-menu"
        role="menu"
        aria-label="Filter bots"
        style={style}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onClose(true)
            return
          }
          onMenuKeyDown(event)
        }}
      >
        {elsewhere && (
          <>
            <div className="thread-filter-menu-label" role="presentation">Computer</div>
            {radio('all', filter.computer === 'all', 'All', () => onChange({ computer: 'all' }))}
            {radio('here', filter.computer === 'here', 'This computer', () => onChange({ computer: 'here' }), <ComputerMark option={{ id: 'here', name: 'This computer', local: true }} />)}
            {computers.map((computer) => radio(computer.node, filter.computer === computer.node, computer.name, () => onChange({ computer: computer.node }), <ComputerMark option={{ id: computer.node, name: computer.name }} />))}
            {separator}
          </>
        )}
        <div className="thread-filter-menu-label" role="presentation">Show</div>
        {STATES.map((state) => radio(state, filter.state === state, BOT_STATE_LABELS[state], () => onChange({ state })))}
        {separator}
        {elsewhere && toggle(filter.hideOffline, 'Hide offline', () => onChange({ hideOffline: !filter.hideOffline }))}
        {toggle(filter.showHidden, `Show hidden (${hidden})`, () => onChange({ showHidden: !filter.showHidden }))}
      </div>
    </FloatingPortal>
  )
}
