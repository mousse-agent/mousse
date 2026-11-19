import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { FloatingPortal, FLOATING_LAYER_Z_INDEX } from '../lib/floatingLayer'
import { runWithToast } from '../lib/actionToast'
import { copyThreadReference } from '../lib/threadReference'
import './integrations/rowMenu.css'

/** Where the menu opens. */
type MenuAt = { x: number; y: number }

/**
 * The right-click menu of a thread shown outside the sidebar (a thread chip, a subagent row or card, a thread a bot
 * started): Copy reference, in the app's row menu at the pointer. The menu key or Shift+F10 opens it from the keyboard.
 * Spread `bind` on the element that shows the thread and render `menu` beside it.
 */
export function useThreadRefMenu(threadId: string | undefined, node?: string): {
  bind: { onContextMenu?: (event: MouseEvent<HTMLElement>) => void; onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void }
  menu: ReactNode
} {
  const [at, setAt] = useState<MenuAt | null>(null)
  // The element the menu opened from: Escape or a copy gives focus back to it, as a menu does.
  const opener = useRef<HTMLElement | null>(null)
  const close = useCallback((refocus: boolean) => {
    setAt(null)
    if (refocus && opener.current?.isConnected) opener.current.focus()
  }, [])
  if (!threadId) return { bind: {}, menu: null }
  const bind = {
    onContextMenu: (event: MouseEvent<HTMLElement>) => {
      event.preventDefault()
      event.stopPropagation()
      opener.current = event.currentTarget
      setAt({ x: event.clientX, y: event.clientY })
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
      event.preventDefault()
      opener.current = event.currentTarget
      const box = event.currentTarget.getBoundingClientRect()
      setAt({ x: box.left + 12, y: box.top + 12 })
    }
  }
  return { bind, menu: at ? <ThreadRefMenu at={at} threadId={threadId} {...(node ? { node } : {})} onClose={close} /> : null }
}

function ThreadRefMenu({ at, threadId, node, onClose }: { at: MenuAt; threadId: string; node?: string; onClose(refocus: boolean): void }) {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    panel.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    const away = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node)) onClose(false) }
    // Escape closes this menu only, not a popup the thread is listed in.
    const keys = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(true) } }
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', keys, true)
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', keys, true) }
  }, [onClose])
  // A little off the pointer, and kept 8px inside the window: the menu is about 180 by 40.
  const left = Math.max(8, Math.min(at.x + 4, window.innerWidth - 188 - 8))
  const top = Math.max(8, Math.min(at.y + 4, window.innerHeight - 48 - 8))
  const copy = () => {
    onClose(true)
    void runWithToast('copy the reference', () => copyThreadReference(threadId, node))
  }
  return <FloatingPortal>
    <div ref={panel} className="row-menu thread-ref-menu" role="menu" aria-label="Thread actions" style={{ position: 'fixed', left, top, zIndex: FLOATING_LAYER_Z_INDEX }}
      // A press here is not a press away from a popup the thread is listed in: that popup stays open until the copy.
      onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <button type="button" role="menuitem" className="row-menu-item" title="Paste it into a chat to point its agent at this thread" onClick={copy}>Copy reference</button>
    </div>
  </FloatingPortal>
}
