import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'

const directory = process.env.MOUSSE_SIDEBAR_MOTION_DIRECTORY!
app.setPath('userData', join(directory, 'user-data'))
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')

void (async () => {
  await app.whenReady()
  const window = new BrowserWindow({ width: 900, height: 650, show: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: true } })
  window.webContents.setFrameRate(60)
  window.webContents.startPainting()
  const errors: string[] = []
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
  const run = (source: string): Promise<any> => window.webContents.executeJavaScript(source)
  const wait = async (source: string) => {
    const end = Date.now() + 5000
    while (!await run(source)) {
      if (Date.now() > end) throw new Error(`Sidebar condition timed out: ${source}`)
      await new Promise((done) => setTimeout(done, 15))
    }
  }
  try {
    await window.loadFile(join(directory, 'index.html'))
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    await wait('!!window.sidebarFixture && !!document.querySelector(".sidebar-focus")')
    const initial = await run('window.sidebarFixture.measure()')
    const selected = await run(`(() => ({
      dot: getComputedStyle(document.querySelector('.threads-sidebar-selected-dot')).display,
      status: getComputedStyle(document.querySelector('.threads-sidebar-status-dot')).display,
      project: getComputedStyle(document.querySelector('.threads-sidebar-project-row')).backgroundColor,
      thread: getComputedStyle(document.querySelector('.threads-sidebar-thread.active')).backgroundColor,
      rail: getComputedStyle(document.querySelector('.navigation-rail-button.active')).boxShadow
    }))()`)
    await run('window.sidebarFixture.focus()')
    const close = await run('window.sidebarFixture.sample("dock", false)')
    const open = await run('window.sidebarFixture.sample("dock", true)')
    const reverse = await run('window.sidebarFixture.reverse()')
    const resize = await run('window.sidebarFixture.resize(330, true)')
    await run('window.sidebarFixture.resize(330, false)')
    const resizedClose = await run('window.sidebarFixture.sample("dock", false)')
    const peekOpen = await run('window.sidebarFixture.sample("peek", true)')
    const peekClose = await run('window.sidebarFixture.sample("peek", false)')
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await wait('matchMedia("(prefers-reduced-motion: reduce)").matches')
    const reducedOpen = await run('window.sidebarFixture.sample("dock", true, 40)')
    const reducedClose = await run('window.sidebarFixture.sample("dock", false, 40)')
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ ok: true, errors, initial, selected, close, open, reverse, resize, resizedClose, peekOpen, peekClose, reducedOpen, reducedClose }))
    window.destroy()
    app.exit(0)
  } catch (error) {
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ ok: false, error: String(error), errors }))
    window.destroy()
    app.exit(1)
  }
})().catch((error) => { writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ ok: false, error: String(error) })); app.exit(1) })
