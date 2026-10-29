import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

const directory = process.env.MOUSSE_STORAGE_SETTINGS_DIRECTORY!
// Set to a folder to also save light and dark screenshots of the page before the scripted run.
const shots = process.env.MOUSSE_STORAGE_SETTINGS_SHOTS
app.setPath('userData', join(directory, 'user-data'))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')

void (async () => {
  await app.whenReady()
  const window = new BrowserWindow({ width: 980, height: 1500, show: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: true } })
  window.webContents.setFrameRate(30)
  window.webContents.startPainting()
  const errors: string[] = []
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
  const run = (source: string): Promise<any> => window.webContents.executeJavaScript(source)
  // A page error reaches here as a plain object, which String() would print as "[object Object]".
  const describe = (error: unknown): string =>
    error instanceof Error ? error.message : typeof error === 'object' && error ? String((error as { message?: unknown }).message ?? JSON.stringify(error)) : String(error)
  const wait = async (source: string) => {
    const end = Date.now() + 15000
    while (!await run(source)) {
      if (Date.now() > end) throw new Error(`Storage page condition timed out: ${source}`)
      await new Promise((done) => setTimeout(done, 25))
    }
  }
  try {
    await window.loadFile(join(directory, 'index.html'))
    await wait('!!window.storageFixture && window.storageFixture.ready()')
    if (shots) {
      mkdirSync(shots, { recursive: true })
      for (const theme of ['dark', 'light']) {
        await run(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
        await new Promise((done) => setTimeout(done, 400))
        // The page scrolls inside its own container, so each group is scrolled to the top and captured from the window.
        for (const id of ['storage-trash', 'storage-worktrees', 'storage-browser', 'storage-usage', 'storage-cleanup']) {
          const clip = await run(`(() => { const box = document.querySelector('.settings-content'); const el = document.getElementById(${JSON.stringify(id)}); box.scrollTop += el.getBoundingClientRect().y - box.getBoundingClientRect().y - 8; const r = el.getBoundingClientRect(); const x = Math.max(0, Math.round(r.x) - 8), y = Math.max(0, Math.round(r.y) - 8); return { x, y, width: Math.min(innerWidth - x, Math.round(r.width) + 16), height: Math.min(innerHeight - y, Math.round(r.height) + 16) } })()`)
          await new Promise((done) => setTimeout(done, 150))
          writeFileSync(join(shots, `${id}-${theme}.png`), (await window.webContents.capturePage(clip)).toPNG())
        }
      }
      await run('document.documentElement.dataset.theme = "dark"')
    }
    // A page error loses its message on the way out of executeJavaScript, so the page sends it as text.
    const evidence = await run('window.storageFixture.run().catch((error) => ({ pageError: String(error && error.stack || error) }))')
    if (evidence.pageError) throw new Error(evidence.pageError)
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ ok: true, errors, ...evidence }))
    window.destroy()
    app.exit(0)
  } catch (error) {
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ ok: false, error: describe(error), errors }))
    window.destroy()
    app.exit(1)
  }
})().catch((error) => { writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ ok: false, error: String(error) })); app.exit(1) })
