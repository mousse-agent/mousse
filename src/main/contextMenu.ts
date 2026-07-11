import { clipboard, Menu, type BrowserWindow, type WebContents } from 'electron'

export function attachContextMenu(
  webContents: WebContents,
  getWindow?: () => BrowserWindow | null
): void {
  webContents.on('context-menu', (_event, params) => {
    const template: Electron.MenuItemConstructorOptions[] = []

    if (params.editFlags.canCut) {
      template.push({ role: 'cut' })
    }
    if (params.editFlags.canCopy) {
      template.push({ role: 'copy' })
    }
    if (params.editFlags.canPaste) {
      template.push({ role: 'paste' })
    }
    if (params.editFlags.canSelectAll) {
      if (template.length > 0) {
        template.push({ type: 'separator' })
      }
      template.push({ role: 'selectAll' })
    }

    if (template.length === 0) return

    Menu.buildFromTemplate(template).popup({ window: getWindow?.() ?? undefined })
  })
}

export function showCopyMenu(
  getWindow: () => BrowserWindow | null,
  x: number,
  y: number,
  text: string
): void {
  Menu.buildFromTemplate([
    {
      label: 'Copy',
      click: () => {
        clipboard.writeText(text)
      }
    }
  ]).popup({ window: getWindow() ?? undefined, x: Math.round(x), y: Math.round(y) })
}
