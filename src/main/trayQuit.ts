/** The parts of a `BrowserWindow` the tray's Quit uses. */
export interface QuitWindow {
  isDestroyed(): boolean
  close(): void
  show(): void
  focus(): void
  once(event: 'closed', listener: () => void): unknown
  removeListener(event: 'closed', listener: () => void): unknown
  webContents: {
    once(event: 'will-prevent-unload', listener: () => void): unknown
    removeListener(event: 'will-prevent-unload', listener: () => void): unknown
  }
}

/**
 * Closes every window the way the person closing it would, so an editor with unsaved edits keeps
 * its window open (its `beforeunload` check). Resolves true once all are closed, and false as soon
 * as one stays open; that window is brought to the front.
 */
export function closeWindowsForQuit(windows: QuitWindow[]): Promise<boolean> {
  const open = windows.filter((window) => !window.isDestroyed())
  return Promise.all(open.map((window) => new Promise<boolean>((resolve) => {
    // Electron marks the window destroyed before `closed`: its webContents can no longer be read here.
    const closed = (): void => resolve(true)
    const kept = (): void => {
      window.removeListener('closed', closed)
      if (!window.isDestroyed()) {
        window.show()
        window.focus()
      }
      resolve(false)
    }
    window.once('closed', closed)
    window.webContents.once('will-prevent-unload', kept)
    window.close()
  }))).then((results) => results.every(Boolean))
}

export interface TrayQuit {
  /** The tray menu's "Quit Mousse and stop background work". */
  (): void
  /** True while its windows are closing, before the quit itself begins. */
  readonly closing: boolean
  /** Whether the quit goes ahead: waits while windows are still closing, false when none was asked for or one stayed open. */
  decided(): Promise<boolean>
}

/**
 * The tray's Quit. Windows close first, so unsaved edits can still keep Mousse open; only once they
 * have all closed does the tray icon go and the quit that stops the background service begin.
 */
export function createTrayQuit(host: {
  windows(): QuitWindow[]
  isQuitting(): boolean
  destroyTray(): void
  quit(): void
}): TrayQuit {
  let pending: Promise<boolean> | null = null
  let quitting = false
  const run = (): void => {
    if (pending || host.isQuitting()) return
    pending = closeWindowsForQuit(host.windows()).then((allClosed) => {
      pending = null
      if (!allClosed || host.isQuitting()) return false
      quitting = true
      host.destroyTray()
      host.quit()
      return true
    })
  }
  return Object.assign(Object.defineProperty(run, 'closing', { get: () => pending !== null }), {
    decided: () => pending ?? Promise.resolve(quitting)
  }) as TrayQuit
}
