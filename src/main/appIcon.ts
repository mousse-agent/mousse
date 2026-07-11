import { app, nativeImage } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

function resolveIcon(name: string): string | undefined {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, name)]
    : [join(__dirname, '../../resources', name), join(app.getAppPath(), 'resources', name)]

  for (const path of candidates) {
    if (!existsSync(path)) continue
    if (!nativeImage.createFromPath(path).isEmpty()) return path
  }

  return undefined
}

export function getAppIconPath(): string | undefined {
  if (process.platform === 'win32') {
    return resolveIcon('icon.ico') ?? resolveIcon('icon.png')
  }

  if (process.platform === 'darwin') {
    return resolveIcon('icon.icns') ?? resolveIcon('icon.png')
  }

  return resolveIcon('icon.png')
}

export function applyAppIcon(): void {
  const iconPath = getAppIconPath()
  if (!iconPath) return

  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(iconPath)
  }
}
