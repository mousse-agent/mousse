/**
 * What each web contents is for, for the memory monitor's process labels: applet views and the in-app browser mark
 * their web contents here when they make them. Windows, webviews and DevTools are told apart by Electron itself.
 */
import type { WebContents } from 'electron'

export type MarkedRole = 'applet' | 'browser'

const roles = new Map<number, MarkedRole>()

export function markWebContentsRole(contents: WebContents, role: MarkedRole): void {
  const id = contents.id
  roles.set(id, role)
  contents.once('destroyed', () => {
    if (roles.get(id) === role) roles.delete(id)
  })
}

export function webContentsRole(id: number): MarkedRole | undefined {
  return roles.get(id)
}
