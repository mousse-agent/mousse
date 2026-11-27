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

/**
 * Windows where a page the window draws has the keyboard (a browser without a window, taken over): the zoom keys are
 * that view's (it zooms its page), not the app's. The window says so as the page gets and loses the keyboard; a
 * window that loads again starts without.
 */
const pageKeyboards = new Set<number>()

export function setPageKeyboard(webContentsId: number, on: boolean): void {
  if (on) pageKeyboards.add(webContentsId)
  else pageKeyboards.delete(webContentsId)
}

export function attachZoomShortcuts(webContents: WebContents): void {
  const id = webContents.id
  webContents.on('did-start-navigation', (details) => { if (details.isMainFrame && !details.isSameDocument) pageKeyboards.delete(id) })
  webContents.once('destroyed', () => pageKeyboards.delete(id))
  webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !hasZoomModifier(input) || pageKeyboards.has(id)) return

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
