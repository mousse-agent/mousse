import { BrowserWindow, ipcMain, screen } from 'electron'
import { LinuxWindowResizeController } from './linuxWindowResize'

export function registerLinuxWindowResizeIpc(getMain: () => BrowserWindow | null, getAuxiliary: () => BrowserWindow | null): void {
  if (process.platform !== 'linux') return
  const resize = new LinuxWindowResizeController(() => screen.getCursorScreenPoint())
  const ownedWindow = (event: Electron.IpcMainInvokeEvent): BrowserWindow | null => {
    if (event.senderFrame !== event.sender.mainFrame) return null
    const win = BrowserWindow.fromWebContents(event.sender)
    return win && (win === getMain() || win === getAuxiliary()) ? win : null
  }
  for (const channel of ['window:resizeStart', 'window:resizeMove', 'window:resizeEnd']) ipcMain.removeHandler(channel)
  ipcMain.handle('window:resizeStart', (event, edge: unknown, pointerId: unknown) => {
    const win = ownedWindow(event)
    return win ? resize.begin(win, edge, pointerId) : false
  })
  ipcMain.handle('window:resizeMove', (event, pointerId: unknown) => {
    const win = ownedWindow(event)
    if (win) resize.move(win, pointerId)
  })
  ipcMain.handle('window:resizeEnd', (event, pointerId: unknown) => {
    const win = ownedWindow(event)
    if (win) resize.end(win, pointerId)
  })
}
