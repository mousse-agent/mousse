import { app, BrowserWindow, type WebContents } from 'electron'
import { runWithoutGpu } from '../electronWithoutGpu.mjs'
import { exitWithParent, keepWindowsOffScreen } from '../fullShellWindow.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppletRuntimeManager, type AppletRuntimeEvent } from '../../../src/main/applets/AppletRuntimeManager'
import { hostAppletWebviews } from '../appletWebviews'

/**
 * Real applet pages in real webviews, for what only real layout and real input show: how host styles lay out an
 * author's buttons, which wheel turns go on to the conversation around an applet (and are reported for it), and which
 * pages the watchdog stops.
 */
const directory = process.env.MOUSSE_APPLET_INPUT_DIRECTORY!
app.setPath('userData', join(directory, 'electron-user-data'))
runWithoutGpu({ app, BrowserWindow })
keepWindowsOffScreen()
exitWithParent()
app.on('window-all-closed', () => {})
setTimeout(() => app.exit(1), 50000).unref()
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms))
/** A page's answer, or `fallback` when it is gone or does not answer within five seconds. */
const ask = <T>(guest: WebContents, code: string, fallback: T): Promise<T> =>
  guest.isDestroyed() ? Promise.resolve(fallback) : Promise.race([guest.executeJavaScript(code).catch(() => fallback) as Promise<T>, delay(5000).then(() => fallback)])

async function main() {
  await app.whenReady()
  app.dock?.hide()
  const window = new BrowserWindow({ show: false, width: 1000, height: 800, useContentSize: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true } })
  // The host page scrolls as the conversation around an applet does.
  await window.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><title>host</title><body style="margin:0;height:4000px">'))
  window.show()
  const events: AppletRuntimeEvent[] = []
  const manager = new AppletRuntimeManager(window, (event) => events.push(event))
  const host = hostAppletWebviews(window, () => manager)
  const mount = (name: string, html: string, css = '', js = '', box = { x: 0, y: 0, width: 600, height: 400 }) =>
    host.place(name, manager.mount({ runtimeId: name, threadId: 'thread', revisionId: `rev-${name}`, source: { html, css, js } }), box)
  const evidence: Record<string, unknown> = {}
  try {
    // Buttons: an author's flex row, a bare button, a host control.
    const layout = await mount(
      'layout',
      '<button class="row" id="row"><span id="icon">*</span><span id="name">Name</span></button><button id="bare"><span id="bare-label">Go</span></button><button class="btn" id="btn">B</button>',
      '.row{display:flex;width:300px}#bare{width:200px}'
    )
    await delay(200)
    evidence.layout = await layout.executeJavaScript(`(()=>{const box=id=>document.getElementById(id).getBoundingClientRect(),style=id=>getComputedStyle(document.getElementById(id));
      return {row:{left:box('row').left,width:box('row').width,padding:style('row').paddingLeft,justify:style('row').justifyContent,background:style('row').backgroundColor,radius:style('row').borderRadius,border:style('row').borderTopWidth},icon:{left:box('icon').left},
        bare:{left:box('bare').left,width:box('bare').width,display:style('bare').display,justify:style('bare').justifyContent,padding:style('bare').paddingLeft,background:style('bare').backgroundColor},bareLabel:{left:box('bare-label').left,width:box('bare-label').width},
        btn:{display:style('btn').display,justify:style('btn').justifyContent,background:style('btn').backgroundColor}}})()`)
    manager.unmount('layout')
    await host.remove('layout')

    // Wheel: the body, an inner scroller with room, one at its end, one that keeps its turns, and ctrl+wheel.
    const wheel = await mount(
      'wheel',
      '<div id="top" style="height:80px">Body</div><div id="box" style="height:100px;overflow:auto"><div style="height:400px">Inner</div></div><div id="contain" style="height:100px;overflow:auto;overscroll-behavior:contain"><div style="height:400px">Kept</div></div>'
    )
    await delay(300)
    const centre = (id: string) => wheel.executeJavaScript(`(()=>{const r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return {x:Math.round(r.left+20),y:Math.round(r.top+r.height/2)}})()`) as Promise<{ x: number; y: number }>
    const turn = async (id: string, down: boolean, setup = '', modifiers: Array<'control'> = []) => {
      if (setup) await wheel.executeJavaScript(setup)
      const at = await centre(id)
      await window.webContents.executeJavaScript('scrollTo(0,0)')
      // Each turn is a gesture of its own, as a pause between turns of a real wheel makes it.
      await delay(600)
      const seen = events.length
      // Electron's wheel delta follows the legacy wheel sign: negative scrolls down.
      wheel.sendInputEvent({ type: 'mouseWheel', ...at, deltaX: 0, deltaY: down ? -120 : 120, canScroll: true, modifiers })
      await delay(400)
      const reported = events.slice(seen).filter((event) => event.runtimeId === 'wheel' && event.type === 'wheel').map((event) => event.payload as number)
      const hostTop = (await window.webContents.executeJavaScript('scrollY')) as number
      const scrolled = await wheel.executeJavaScript(`({box:document.getElementById('box').scrollTop,contain:document.getElementById('contain').scrollTop,root:document.scrollingElement.scrollTop})`)
      return { reported, hostTop, scrolled, zoom: wheel.getZoomFactor() }
    }
    evidence.wheel = {
      body: await turn('top', true),
      innerWithRoom: await turn('box', true, "document.getElementById('box').scrollTop=0"),
      innerAtEnd: await turn('box', true, "document.getElementById('box').scrollTop=1000"),
      innerAtTopGoingUp: await turn('box', false, "document.getElementById('box').scrollTop=0"),
      containAtEnd: await turn('contain', true, "document.getElementById('contain').scrollTop=1000"),
      control: await turn('top', true, '', ['control'])
    }
    manager.unmount('wheel')
    await host.remove('wheel')

    // Watchdog: a page whose timers never fire (as in a covered window) beside a page stuck in a loop.
    const paused = await mount('paused', '<p>Idle</p>', '', 'window.ticks=0;setInterval(()=>window.ticks++,100)', { x: 0, y: 0, width: 400, height: 200 })
    await delay(300)
    // Throttling taken to its limit: every timer in the page, the page's own and any the host document set, never fires again.
    const ticksAtPause = await ask(paused, '(()=>{const last=setTimeout(()=>{},0);for(let id=1;id<=last;id++){clearTimeout(id);clearInterval(id)}return window.ticks})()', -2)
    await mount('loop', '<p>Loop</p>', '', 'setTimeout(()=>{while(true){}},50)', { x: 0, y: 300, width: 400, height: 200 })
    const loopStarted = Date.now()
    let loopStopped: number | null = null
    for (let waited = 0; waited < 75; waited++) {
      await delay(100)
      if (loopStopped === null && events.some((event) => event.runtimeId === 'loop' && event.type === 'error')) loopStopped = Date.now() - loopStarted
    }
    evidence.watchdog = {
      timersPaused: (await ask(paused, 'window.ticks', -1)) === ticksAtPause,
      pausedErrors: events.filter((event) => event.runtimeId === 'paused' && event.type === 'error').map((event) => String(event.payload)),
      pausedAlive: (await ask(paused, '1+1', 0)) === 2,
      loopStoppedAfterMs: loopStopped,
      loopError: events.find((event) => event.runtimeId === 'loop' && event.type === 'error')?.payload ?? null
    }
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence))
  } finally {
    manager.destroy()
    window.destroy()
  }
}
main().then(() => app.exit(0), (error) => { console.error(error); app.exit(1) })
