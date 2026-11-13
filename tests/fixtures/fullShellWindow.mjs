// Full-app test drivers import the real main entry, which shows and focuses its window.
// Call this before that import so the run stays off the developer's screen and keyboard.
import { app, BrowserWindow } from 'electron'

/** Every window opens off-screen, transparent, click-through, out of the taskbar and unable to
 * take focus. It still counts as shown, so the page paints and `capturePage` keeps working.
 *
 * macOS pulls such a window back onto the screen, but X11 without a window manager (Xvfb in CI) keeps it
 * off-screen and reports it fully obscured, and Chromium then treats every page in it as occluded: a page
 * with background throttling on, such as an applet, stops rendering, so its ResizeObserver never fires.
 * This switch makes an occluded window count as visible, which is what a test window off-screen means. */
export function keepWindowsOffScreen() {
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  const proto = BrowserWindow.prototype
  proto.show = function show() {
    const { width, height } = this.getBounds()
    this.setPosition(-20_000 - width, -20_000 - height)
    this.setSkipTaskbar(true)
    // Also keeps Windows from activating it when another window closes or on Alt+Tab.
    this.setFocusable(false)
    this.setOpacity(0)
    this.setIgnoreMouseEvents(true)
    this.showInactive()
  }
  proto.focus = function focus() {}
  proto.moveTop = function moveTop() {}
  app.focus = () => {}
}

/** End this app when the test process that spawned it is gone, even if its `finally` never ran. */
export function exitWithParent(intervalMs = 1000) {
  const parent = process.ppid
  const timer = setInterval(() => {
    try { process.kill(parent, 0) } catch (error) { if (error.code !== 'EPERM') app.exit(1) }
  }, intervalMs)
  timer.unref()
}
