/** Pass the display backend at launch so GTK and Chromium initialize together.
 * The production fallback relaunches Electron; a test must retain ownership of
 * the process producing its evidence instead of observing the parent exit. */
export function fullShellElectronArgs(driver: string): string[] {
  return [driver, ...(process.platform === 'linux' && process.env.DISPLAY ? ['--ozone-platform=x11'] : [])]
}
