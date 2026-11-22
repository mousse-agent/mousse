import { Menu, Tray } from 'electron'

export interface ServiceTrayActions {
  open: () => void
  quitAndStop: () => void
}

/** Platforms where closing the last window keeps the app in the notification area. */
export function usesServiceTray(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
}

/**
 * The notification-area icon that shows Mousse's background service is still
 * running after its windows close, with a way back in and a way to stop it.
 */
export function createServiceTray(iconPath: string, actions: ServiceTrayActions): Tray {
  const tray = new Tray(iconPath)
  tray.setToolTip('Mousse is running in the background')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Mousse', click: actions.open },
    { type: 'separator' },
    { label: 'Quit Mousse and stop background work', click: actions.quitAndStop }
  ]))
  tray.on('click', actions.open)
  return tray
}
