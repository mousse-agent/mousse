import { app, BrowserWindow, Menu } from 'electron'
import type { CommandId, ShortcutOverrides } from '../shared/commands'
import { buildMenuTemplate } from './menu/menuTemplate'

/** The shortcuts the installed menu was built from; an identical refresh leaves the menu alone. */
let installed: string | null = null

/** A chosen command item asks the focused window's renderer to run it through the command registry. */
function runInFocusedWindow(id: CommandId): void {
  BrowserWindow.getFocusedWindow()?.webContents.send('commands:run', { id, source: 'menu' })
}

export function setupApplicationMenu(shortcuts: ShortcutOverrides = {}): void {
  const template = buildMenuTemplate({
    isMac: process.platform === 'darwin',
    isDev: Boolean(process.env.ELECTRON_RENDERER_URL),
    platform: process.platform,
    shortcuts,
    appName: app.name,
    onRun: runInFocusedWindow
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  installed = JSON.stringify(shortcuts)
}

/** Rebuilds the menu when the bound profile's shortcuts changed, so it shows the shortcuts in force. */
export function refreshApplicationMenu(shortcuts: ShortcutOverrides | undefined): void {
  const next = shortcuts ?? {}
  if (!app.isReady() || JSON.stringify(next) === installed) return
  setupApplicationMenu(next)
}
