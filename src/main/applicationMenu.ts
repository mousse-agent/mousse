import { app, Menu } from 'electron'

export function setupApplicationMenu(): void {
  const isMac = process.platform === 'darwin'
  const isDev = Boolean(process.env.ELECTRON_RENDERER_URL)

  const viewSubmenu: Electron.MenuItemConstructorOptions[] = [
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' }
  ]

  if (isDev) {
    viewSubmenu.unshift(
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' }
    )
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          } satisfies Electron.MenuItemConstructorOptions
        ]
      : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: viewSubmenu
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
