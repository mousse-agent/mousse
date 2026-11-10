// Every Electron app a test starts calls this first, before the app is ready.
// Tests check behaviour, never how something looks on a GPU, so nothing they open may load it.

/** Chromium switches that keep a test's Electron app off the GPU. */
export const NO_GPU_SWITCHES = ['disable-gpu', 'disable-gpu-compositing']
/** Turns the OS reduced-motion setting on, so pages stay still. */
export const REDUCED_MOTION_SWITCH = 'force-prefers-reduced-motion'

/**
 * Renders in software, with no GPU process work, and with the OS reduced-motion setting on, so the
 * renderer's own reduced-motion rules (global.css, lib/motion.ts, ui/Collapse) cut animations and
 * transitions short. Also makes a passing exit fail while a window is still open: every fixture
 * destroys the windows it opened before it exits.
 *
 * Takes `app` and `BrowserWindow` from the caller's own `electron` import. `reducedMotion: false`
 * keeps the OS default for a fixture that needs it; say why where it is passed. The GPU stays off.
 * @param {{ app: { disableHardwareAcceleration(): void, commandLine: { appendSwitch(name: string, value?: string): void }, exit(code?: number): void },
 *   BrowserWindow: { getAllWindows(): Array<{ isDestroyed(): boolean, webContents: { getURL(): string } }> },
 *   reducedMotion?: boolean }} electron
 */
export function runWithoutGpu({ app, BrowserWindow, reducedMotion = true }) {
  app.disableHardwareAcceleration()
  for (const name of NO_GPU_SWITCHES) app.commandLine.appendSwitch(name)
  if (reducedMotion) app.commandLine.appendSwitch(REDUCED_MOTION_SWITCH)
  const exit = app.exit.bind(app)
  app.exit = (code = 0) => {
    const open = code === 0 ? BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()) : []
    if (open.length === 0) return exit(code)
    const urls = open.map((window) => window.webContents.getURL() || 'about:blank').join(', ')
    process.stderr.write(`${open.length} window(s) still open when the test app exited: ${urls}\n`)
    return exit(1)
  }
}
