import { useEffect, useRef, useState } from 'react'
import { MoreHorizontal } from '../lib/icons'
import { FloatingPortal, usePinnedPopover } from '../lib/floatingLayer'
import type { ProviderUsage } from '../../shared/providerAuth'

export interface UsageRowActions {
  onHide?: (provider: ProviderUsage) => void
  onUnhide?: (provider: ProviderUsage) => void
  /** Turns the provider off (it asks first); absent where Mousse cannot turn this provider off. */
  onDisable?: (provider: ProviderUsage) => void
}

/**
 * A row's "…" in Other usage and Needs attention, shown on hover or focus: Hide from Usage (or Unhide)
 * and Disable provider, in the app's menu.
 */
export function UsageRowMenu({ provider, hidden, actions }: { provider: ProviderUsage; hidden: boolean; actions: UsageRowActions }) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // The "…" sits at the row's end: the menu lines up with it there, over the row's own figure only.
  const style = usePinnedPopover({ open, anchorRef, contentRef: menuRef, maxHeight: 160, minHeight: 120, align: 'end' })
  useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const close = (event: MouseEvent) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !anchorRef.current?.contains(target)) setOpen(false)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); anchorRef.current?.focus() }
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key) }
  }, [open])
  const pick = (run: ((provider: ProviderUsage) => void) | undefined) => () => { setOpen(false); run?.(provider) }
  const items = [
    hidden ? actions.onUnhide && { label: 'Unhide', run: pick(actions.onUnhide) } : actions.onHide && { label: 'Hide from Usage', run: pick(actions.onHide) },
    actions.onDisable && { label: 'Disable provider', run: pick(actions.onDisable) }
  ].filter((item): item is { label: string; run: () => void } => !!item)
  if (!items.length) return null
  return <>
    <button
      ref={anchorRef}
      type="button"
      className="usage-row-menu-btn"
      data-testid="usage-row-menu"
      aria-label={`${provider.label} options`}
      aria-haspopup="menu"
      aria-expanded={open}
      title="Options"
      onClick={() => setOpen((value) => !value)}
    >
      <MoreHorizontal size={14} aria-hidden="true" />
    </button>
    {open && <FloatingPortal>
      <div ref={menuRef} style={style} className="composer-workspace-menu usage-row-menu" role="menu" aria-label={`${provider.label} options`} data-testid="usage-row-menu-list">
        {items.map((item) => <button key={item.label} type="button" role="menuitem" className="composer-workspace-menu-item" onClick={item.run}>{item.label}</button>)}
      </div>
    </FloatingPortal>}
  </>
}
