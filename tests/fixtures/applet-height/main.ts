import { app, BrowserWindow } from 'electron'
import { runWithoutGpu } from '../electronWithoutGpu.mjs'
import { exitWithParent, keepWindowsOffScreen } from '../fullShellWindow.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppletRuntimeManager, type AppletRuntimeEvent } from '../../../src/main/applets/AppletRuntimeManager'
import { hostAppletWebviews } from '../appletWebviews'

/**
 * Real applet pages in real webviews. The fixture plays the host: whenever a page reports a height, its webview is
 * resized to that height, as the transcript card does. Each case records every height its page reported.
 */
const directory = process.env.MOUSSE_APPLET_HEIGHT_DIRECTORY!
app.setPath('userData', join(directory, 'electron-user-data'))
runWithoutGpu({ app, BrowserWindow })
// A page lays out only in a shown window: shown off-screen, transparent and unfocusable.
keepWindowsOffScreen()
exitWithParent()
app.on('window-all-closed', () => {})
setTimeout(() => app.exit(1), 50000).unref()
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms))

const CASES: Record<string, { html: string; css?: string; js?: string }> = {
  short: { html: '<div style="height:80px">Total: 42</div>' },
  empty: { html: '' },
  tall: { html: '<div style="height:2500px">Tall</div>' },
  huge: { html: '<div style="height:6000px">Huge</div>' },
  // Margins of the first and last child count; the page is the root element's box.
  margins: { html: '<p style="margin:24px 0;height:40px">Margins</p>' },
  // Content that changes after load: it grows, then shrinks.
  changes: {
    html: '<div id="box" style="height:400px"></div>',
    js: "setTimeout(()=>{document.getElementById('box').style.height='600px'},500);setTimeout(()=>{document.getElementById('box').style.height='120px'},1200)"
  },
  // Already published applets sized to the frame. Each would follow its own frame without the guard.
  legacyMinHeight: { html: '<div style="height:80px">Old</div>', css: 'body{min-height:100vh}' },
  legacyTaller: { html: '<header style="height:40px">Head</header><main>Body</main>', css: 'main{min-height:100vh}' },
  legacyRatio: { html: '<div class="a">Ratio</div>', css: '.a{height:110vh}' },
  legacyFull: { html: '<div class="a">Full</div>', css: 'html,body{height:100%}.a{height:100%}' }
}

async function main() {
  await app.whenReady()
  app.dock?.hide()
  const window = new BrowserWindow({ show: false, width: 900, height: 700, useContentSize: true, webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true } })
  await window.loadURL('data:text/html,<!doctype html><title>host</title>')
  window.show()
  const reports = new Map<string, number[]>()
  const errors: string[] = []
  const frame = (height: number) => ({ x: 0, y: 0, width: 600, height })
  const onEvent = (event: AppletRuntimeEvent) => {
    if (event.type === 'error') errors.push(`${event.runtimeId}: ${String(event.payload)}`)
    if (event.type !== 'resize') return
    reports.get(event.runtimeId)!.push(event.payload as number)
    void host.resize(event.runtimeId, event.payload as number)
  }
  const manager = new AppletRuntimeManager(window, onEvent)
  const host = hostAppletWebviews(window, () => manager)
  const result: Record<string, number[]> = {}
  try {
    for (const [name, page] of Object.entries(CASES)) {
      reports.set(name, [])
      await host.place(name, manager.mount({
        runtimeId: name,
        threadId: 'thread',
        revisionId: `rev-${name}`,
        source: { html: page.html, css: page.css ?? '', js: page.js ?? '' }
      }), frame(320))
      // Wait until the page has gone quiet: nothing reported for a second, and its scripted changes are done.
      let seen = -1
      for (let quiet = 0, waited = 0; quiet < 10 && waited < 60; waited++) {
        await delay(100)
        const count = reports.get(name)!.length
        quiet = count === seen ? quiet + 1 : 0
        seen = count
      }
      if (name === 'changes') await delay(1500)
      result[name] = reports.get(name)!
      manager.unmount(name)
      await host.remove(name)
    }
    // The page itself is unpainted in the app, so the chat behind it shows through; what the applet paints stays.
    const backdrop: Record<string, number[]> = {}
    for (const [name, html] of Object.entries({ plain: '<p>Plain</p>', painted: '<div style="height:200px;background:#123456">Painted</div>' })) {
      await host.place(name, manager.mount({ runtimeId: name, threadId: 'thread', revisionId: `rev-${name}`, source: { html, css: '', js: '' } }), frame(200))
      let image = await manager.capture(name)
      for (let tries = 0; tries < 20 && (image.isEmpty() || image.getSize().height < 150); tries++) { await delay(100); image = await manager.capture(name) }
      const size = image.getSize(), bitmap = image.toBitmap()
      backdrop[name] = Array.from(bitmap.subarray(((size.height - 20) * size.width + size.width - 20) * 4, ((size.height - 20) * size.width + size.width - 20) * 4 + 4))
      manager.unmount(name)
      await host.remove(name)
    }
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ reports: result, errors, backdrop }))
  } finally {
    manager.destroy()
    window.destroy()
  }
}
main().then(() => app.exit(0), (error) => { console.error(error); app.exit(1) })
