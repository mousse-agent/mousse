import type { WebContents } from 'electron'

const ZOOM_STEP = 0.5

function hasZoomModifier(input: Electron.Input): boolean {
  return input.control || input.meta
}

function isZoomInKey(input: Electron.Input): boolean {
  return (
    input.code === 'Equal' ||
    input.code === 'NumpadAdd' ||
    input.key === '+' ||
    input.key === '='
  )
}

function isZoomOutKey(input: Electron.Input): boolean {
  return input.code === 'Minus' || input.code === 'NumpadSubtract' || input.key === '-'
}

function isZoomResetKey(input: Electron.Input): boolean {
  return input.code === 'Digit0' || input.code === 'Numpad0' || input.key === '0'
}

export function attachZoomShortcuts(webContents: WebContents): void {
  webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !hasZoomModifier(input)) return

    if (isZoomInKey(input)) {
      event.preventDefault()
      webContents.setZoomLevel(webContents.getZoomLevel() + ZOOM_STEP)
      return
    }

    if (isZoomOutKey(input)) {
      event.preventDefault()
      webContents.setZoomLevel(webContents.getZoomLevel() - ZOOM_STEP)
      return
    }

    if (isZoomResetKey(input)) {
      event.preventDefault()
      webContents.setZoomLevel(0)
    }
  })
}
