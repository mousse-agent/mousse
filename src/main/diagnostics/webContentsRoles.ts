/**
 * What each web contents is for, for the memory monitor's process labels: applet views and the in-app browser mark
 * their web contents here when they make them, with how to read their size. Windows, webviews and DevTools are told
 * apart by Electron itself.
 */
import type { WebContents } from 'electron'
import type { AppViewInfo } from '../../shared/diagnostics/profiler'

export type MarkedRole = 'applet' | 'browser'

interface Marked {
  role: MarkedRole
  bounds?: () => { width: number; height: number }
  visible?: () => boolean
}

const roles = new Map<number, Marked>()

export function markWebContentsRole(contents: WebContents, role: MarkedRole, bounds?: Marked['bounds'], visible?: Marked['visible']): void {
  const id = contents.id
  const marked: Marked = { role, ...(bounds ? { bounds } : {}), ...(visible ? { visible } : {}) }
  roles.set(id, marked)
  contents.once('destroyed', () => {
    if (roles.get(id) === marked) roles.delete(id)
  })
}

export function webContentsRole(id: number): MarkedRole | undefined {
  return roles.get(id)?.role
}

/** Every marked view with its size now, in DIP. Reading a bound is cheap; a view that cannot say is skipped. */
export function markedViews(): AppViewInfo[] {
  const out: AppViewInfo[] = []
  for (const marked of roles.values()) {
    try {
      const bounds = marked.bounds?.()
      if (!bounds) continue
      out.push({ role: marked.role, w: Math.max(0, Math.round(bounds.width)), h: Math.max(0, Math.round(bounds.height)), visible: marked.visible?.() ?? true })
    } catch {
      // Destroyed between the mark and now.
    }
  }
  return out
}
