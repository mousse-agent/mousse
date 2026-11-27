/**
 * Electron main for `node scripts/check-applet-runtime.mjs`: production applet runtime modules in a window that draws
 * each applet in a `<webview>`, the way the app does. Every assert names the property it holds.
 */
import { app, BrowserWindow, nativeImage, webContents, type WebContents } from 'electron'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { AppletRuntimeManager, isAppletWebviewSource, type AppletRuntimeEvent } from '../src/main/applets/AppletRuntimeManager'
import { exportAppletHtml } from '../src/shared/appletExport'

const directory = process.argv[2]!
app.setPath('userData', `${directory}/user-data`)
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
type Rgb = [number, number, number]

/** A transcript: a scroller under a header bar, with the card's name strip, its applet slot, a composer, a menu, a dialog and a tooltip over it. */
const PAGE = `<!doctype html><html><body style="margin:0;background:rgb(0,160,0);overflow:hidden">
<header id="titlebar" style="position:absolute;left:0;top:0;width:800px;height:40px;background:rgb(255,255,0);z-index:3"></header>
<div id="scroller" style="position:absolute;left:0;top:0;width:800px;height:600px;overflow-y:auto;background:rgb(0,160,0)">
  <div style="height:8000px;padding-top:140px;box-sizing:border-box">
    <div id="name" style="height:20px;width:400px;margin-left:100px;background:rgb(255,0,255)"></div>
    <div id="slot" style="height:300px;width:400px;margin-left:100px"></div>
  </div>
</div>
<div id="composer" style="position:absolute;left:0;top:450px;width:800px;height:150px;background:rgb(0,0,0);z-index:2"></div>
<div id="menu" hidden style="position:absolute;left:120px;top:160px;width:100px;height:60px;background:rgb(255,128,0);z-index:4"></div>
<div id="tooltip" hidden style="position:absolute;left:300px;top:160px;width:80px;height:24px;background:rgb(128,0,255);z-index:4"></div>
<div id="slot-second" style="position:absolute;left:0;bottom:0;width:10px;height:10px"></div>
<dialog id="dialog" style="width:120px;height:80px;padding:0;border:0;background:rgb(0,255,255)"></dialog>
</body></html>`

const sample = (image: Electron.NativeImage, width: number) => {
  const bitmap = image.toBitmap(), size = image.getSize(), scale = size.width / width
  // Bitmaps are BGRA.
  return (x: number, y: number): Rgb => {
    const at = (Math.round(y * scale) * size.width + Math.round(x * scale)) * 4
    return [bitmap[at + 2]!, bitmap[at + 1]!, bitmap[at]!]
  }
}
const near = (actual: Rgb, expected: Rgb, tolerance = 24) => actual.every((value, index) => Math.abs(value - expected[index]!) <= tolerance)
const assertColor = (actual: Rgb, expected: Rgb, message: string, tolerance?: number) =>
  assert(near(actual, expected, tolerance), `${message}: expected ${expected.join(',')}, got ${actual.join(',')}`)
const processEnded = async (pid: number, within: number) => {
  const started = Date.now()
  while (Date.now() - started < within) {
    try { process.kill(pid, 0) } catch { return Date.now() - started }
    await pause(10)
  }
  return null
}

app.whenReady().then(async () => {
  const owner = new BrowserWindow({
    width: 800, height: 600, useContentSize: true, x: 40, y: 40, frame: false,
    webPreferences: { sandbox: false, contextIsolation: true, nodeIntegration: false, webviewTag: true }
  })
  /** The window's pixels as the OS composited them. */
  const screen = (): ((x: number, y: number) => Rgb) => {
    const file = `${directory}/screen.png`
    if (process.platform === 'darwin') execFileSync('screencapture', ['-x', '-o', '-l', owner.getMediaSourceId().split(':')[1]!, file])
    else writeFileSync(file, execFileSync('import', ['-window', String(owner.getNativeWindowHandle().readUInt32LE()), 'png:-']))
    return sample(nativeImage.createFromPath(file), 800)
  }
  /** The page's own composited frame. */
  const frame = async () => sample(await owner.webContents.capturePage(), 800)
  const events: AppletRuntimeEvent[] = []
  let manager = new AppletRuntimeManager(owner, (event) => events.push(event))
  const attaches: string[] = []
  owner.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    attaches.push(params.src ?? '')
    if (!isAppletWebviewSource(params.src) || !manager.attach(webPreferences, params)) event.preventDefault()
  })
  owner.webContents.on('did-attach-webview', (_event, guest) => { manager.adopt(guest) })
  const page = (script: string) => owner.webContents.executeJavaScript(script)
  const guests = () => webContents.getAllWebContents().filter((contents) => contents.getType() === 'webview')
  /** Puts a webview for `src` in the slot, with extra attributes the page might try. */
  const place = async (src: string, attributes: Record<string, string> = {}, slot = 'slot') => {
    const before = guests().length
    await page(`(()=>{const view=document.createElement('webview');for(const [k,v] of Object.entries(${JSON.stringify(attributes)}))view.setAttribute(k,v);view.setAttribute('src',${JSON.stringify(src)});view.style.cssText='display:flex;width:100%;height:100%';document.getElementById(${JSON.stringify(slot)}).replaceChildren(view)})()`)
    const started = Date.now()
    while (Date.now() - started < 1500 && guests().length === before) await pause(20)
    return guests().length > before ? guests().find((guest) => guest.getURL() === src || guest.getURL() === '') ?? guests().at(-1)! : null
  }
  const ready = async (runtimeId: string) => {
    const started = Date.now()
    while (!events.some((event) => event.runtimeId === runtimeId && event.type === 'ready')) {
      assert(Date.now() - started < 5000, `${runtimeId} reports ready`)
      await pause(10)
    }
    return Date.now() - started
  }
  const mount = (runtimeId: string, source: { html: string; css: string; js: string }) =>
    manager.mount({ runtimeId, threadId: 'test', revisionId: runtimeId, source })
  try {
    await owner.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`)
    owner.webContents.setZoomFactor(1)

    // Attach: only a minted address, once, with no partition or preload of the page's own.
    assert.equal(await place('mousse-applet://runtime/not-minted'), null, 'An address the manager did not mint never attaches')
    const src = mount('working', {
      html: '<main class="red"><button id="button">Add</button><output id="count">0</output><input id="field"><div style="height:500px"></div><p id="far">Far</p></main>',
      css: '.red{background:rgb(0,0,255);min-height:100vh}html,body{margin:0}',
      js: 'document.querySelector("button").onclick=()=>{const out=document.querySelector("output");out.textContent=String(Number(out.textContent)+1);mousseApplet.saveState({count:Number(out.textContent)})};mousseApplet.saveState({node:typeof require,process:typeof process,host:typeof window.mousse,rtc:typeof RTCPeerConnection});fetch("https://example.com").then(()=>mousseApplet.reportError("NETWORK LEAK"),()=>mousseApplet.saveState({network:"blocked"}));'
    })
    assert.equal(await place(src, { partition: 'persist:mousse-profile-test' }), null, 'A page-supplied partition is refused')
    assert.equal(await place(src, { preload: 'file:///etc/passwd' }), null, 'A page-supplied preload is refused')
    const guest = await place(src, { nodeintegration: '', webpreferences: 'contextIsolation=no,sandbox=no,nodeIntegration=yes', allowpopups: '', disablewebsecurity: '' })
    assert(guest, 'A minted address attaches')
    await ready('working')
    const ownerSession = owner.webContents.session
    const originalSession = guest.session
    assert.equal(guest.hostWebContents, owner.webContents, 'The window that draws the applet owns it')
    assert.notEqual(guest.session, ownerSession, "The applet's session is not the window's")
    assert.equal(guest.session.isPersistent(), false, "The applet's session keeps nothing on disk")
    assert.equal(guest.getLastWebPreferences()?.sandbox, true, 'Sandboxed whatever the page asked for')
    assert.equal(guest.getLastWebPreferences()?.contextIsolation, true, 'Context isolated whatever the page asked for')
    assert.equal(guest.getLastWebPreferences()?.webSecurity, true, 'Web security on whatever the page asked for')
    assert.equal(await guest.executeJavaScript('top===window'), true, 'The applet is its own top window, with no parent to reach')
    assert.equal(await place(src, {}, 'slot-second'), null, 'An address attaches once')
    assert.notEqual(guest.getOSProcessId(), owner.webContents.getOSProcessId(), 'Guest needs an independent process')
    assert(events.some((e) => e.type === 'state' && (e.payload as Record<string, unknown>).node === 'undefined' && (e.payload as Record<string, unknown>).process === 'undefined' && (e.payload as Record<string, unknown>).host === 'undefined' && (e.payload as Record<string, unknown>).rtc === 'undefined'), 'No Node, desktop bridge or RTC')
    await pause(200)
    assert(events.some((e) => e.type === 'state' && (e.payload as Record<string, unknown>).network === 'blocked'), 'Networking blocked')
    assert.equal(await guest.executeJavaScript('fetch("file:///etc/passwd").then(()=>"leaked",()=>"blocked")'), 'blocked', 'Host file reads are blocked')
    assert.equal(await guest.executeJavaScript('window.open("https://example.com")'), null, 'Popups blocked')
    assert.equal(await guest.executeJavaScript('(()=>{const f=document.createElement("iframe");document.body.append(f);let result;try{result=typeof f.contentWindow.RTCPeerConnection}catch(e){result=e.name};f.remove();return result})()'), 'SecurityError', 'Fresh iframe cannot restore forbidden RTC globals')
    assert.equal(await guest.executeJavaScript('navigator.permissions.query({name:"camera"}).then(s=>s.state,()=>"denied")'), 'denied', 'Device permissions denied')
    assert.equal(await guest.executeJavaScript('(async()=>{try{localStorage.setItem("k","v");return document.cookie="a=b",String(localStorage.length)}catch(e){return e.name}})()').then(String), 'SecurityError', 'No storage in the opaque sandboxed origin')
    await guest.executeJavaScript('location.href="https://example.com"').catch(() => {})
    await pause(150)
    assert.equal(guest.getURL(), src, 'The applet cannot navigate away')
    await guest.executeJavaScript('document.querySelector("button").click()')
    await pause(50)
    assert(events.some((e) => e.type === 'state' && (e.payload as Record<string, unknown>).count === 1), 'Interaction reports state')
    await page('document.querySelector("webview").focus()')
    guest.focus()
    guest.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    await pause(80)
    assert(owner.webContents.isFocused(), 'Escape returns keyboard focus to the thread')

    // Layering: the window's own UI draws over the applet, and it is cut at the scroller and the composer.
    await page('scroller.scrollTop=0')
    await pause(150)
    let pixels = screen()
    assertColor(pixels(150, 200), [0, 0, 255], 'Applet paints in its card')
    assertColor(pixels(150, 150), [255, 0, 255], "The card's name strip is above it")
    await page('scroller.scrollTop=150')
    await pause(150)
    pixels = screen()
    assertColor(pixels(150, 300), [0, 0, 255], 'Applet paints above the composer')
    assertColor(pixels(150, 500), [0, 0, 0], 'The composer draws over the applet')
    await page('scroller.scrollTop=260')
    await pause(150)
    assertColor(screen()(150, 20), [255, 255, 0], 'The header bar draws over an applet scrolled under it')
    await page('scroller.scrollTop=0;menu.hidden=false;tooltip.hidden=false;dialog.showModal()')
    await pause(150)
    pixels = screen()
    assertColor(pixels(150, 180), [255, 128, 0], 'A menu draws over the applet')
    assertColor(pixels(320, 170), [128, 0, 255], 'A tooltip draws over the applet')
    assertColor(pixels(400, 300), [0, 255, 255], 'A dialog draws over the applet')
    await page('menu.hidden=true;tooltip.hidden=true;dialog.close()')

    // An unpainted applet shows the chat behind it.
    await guest.executeJavaScript('document.querySelector("main").style.background="transparent"')
    await pause(150)
    pixels = screen()
    assertColor(pixels(450, 300), pixels(50, 300), 'An unpainted applet pixel matches the chat surface', 6)
    await guest.executeJavaScript('document.querySelector("main").style.background="rgb(0,0,255)"')

    // The applet cannot move the conversation.
    await page('scroller.scrollTop=200')
    await guest.executeJavaScript('document.documentElement.scrollTop=0')
    await pause(100)
    await guest.executeJavaScript('document.getElementById("button").scrollIntoView({block:"start"});document.getElementById("far").scrollIntoView();document.getElementById("button").scrollIntoView()')
    await pause(150)
    assert.equal(await page('scroller.scrollTop'), 200, "The applet's scrollIntoView leaves the conversation where it was")
    await guest.executeJavaScript('document.getElementById("field").focus()')
    await pause(150)
    assert.equal(await page('scroller.scrollTop'), 200, "The applet's focus() leaves the conversation where it was")

    // Scrolling: 120 wheel steps, every frame captured; the applet never goes blank or leaves its name strip.
    await page('scroller.scrollTop=0')
    await guest.executeJavaScript('document.documentElement.scrollTop=0;document.querySelector("main").style.minHeight="0";document.querySelector("main").style.height="100vh";document.documentElement.style.overflow="hidden"')
    await pause(150)
    let previous = 0
    for (let step = 0; step < 120; step++) {
      // Half the turns land on the applet (the browser chains them to the conversation), half on the name strip.
      const top = await page('document.getElementById("name").getBoundingClientRect().top')
      if (step % 2) owner.webContents.sendInputEvent({ type: 'mouseWheel', x: 150, y: Math.max(45, Math.round(top + 10)), deltaX: 0, deltaY: -3, canScroll: true, hasPreciseScrollingDeltas: true })
      else guest.sendInputEvent({ type: 'mouseWheel', x: 50, y: 150, deltaX: 0, deltaY: -3, canScroll: true, hasPreciseScrollingDeltas: true })
      await page('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
      const name = Math.round(await page('document.getElementById("name").getBoundingClientRect().top'))
      const shot = step % 10 === 9 ? screen() : await frame()
      if (name > 45 && name + 40 < 445) {
        assertColor(shot(150, name + 10), [255, 0, 255], `Step ${step}: name strip where the page put it`)
        assertColor(shot(450, name + 24), [0, 0, 255], `Step ${step}: applet right under its name strip`)
      }
      previous = name
    }
    const scrolled = await page('scroller.scrollTop')
    console.log(`120 wheel steps scrolled the conversation ${scrolled} px`)
    assert(scrolled > 200, `Wheel turns over the applet and its name scroll the conversation (scrolled ${scrolled}, last name top ${previous})`)
    assert(events.some((event) => event.runtimeId === 'working' && event.type === 'wheel'), 'A turn the applet could not use is reported for the conversation')

    // Scrolled far away and back, the same page keeps its memory.
    await guest.executeJavaScript('window.__kept=42')
    const count = await guest.executeJavaScript('document.querySelector("output").textContent')
    await page('scroller.scrollTop=5000')
    manager.setVisible('working', false)
    await pause(1500)
    await page('scroller.scrollTop=0')
    manager.setVisible('working', true)
    await pause(150)
    assert(!guest.isDestroyed() && guests().length === 1, 'The same guest after scrolling 5,000 px away and back')
    assert.equal(await guest.executeJavaScript('[document.querySelector("output").textContent,window.__kept].join()'), `${count},42`, 'DOM and memory kept')

    // Zoom: the webview follows the window and its viewport stays in CSS pixels.
    owner.webContents.setZoomFactor(1.25)
    await pause(250)
    assert.equal(guest.getZoomFactor(), 1.25, 'Guest zoom follows the window')
    assert.equal(await guest.executeJavaScript('innerWidth'), 400, 'Guest viewport remains in CSS pixels at host zoom')
    await guest.executeJavaScript('document.querySelector("output").textContent="0"')
    const button = await guest.executeJavaScript('(()=>{const r=document.querySelector("button").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()')
    guest.sendInputEvent({ type: 'mouseDown', ...button, button: 'left', clickCount: 1 })
    guest.sendInputEvent({ type: 'mouseUp', ...button, button: 'left', clickCount: 1 })
    await pause(80)
    assert.equal(await guest.executeJavaScript('document.querySelector("output").textContent'), '1', 'Zoomed guest remains interactive')
    owner.webContents.setZoomFactor(1)

    // Removing the webview ends its process; a new mount is a new process.
    const removedPid = guest.getOSProcessId()
    await page('document.querySelector("#slot webview").remove()')
    const removedIn = await processEnded(removedPid, 1000)
    assert.notEqual(removedIn, null, 'Removing the webview ends its process within 1 s')
    console.log(`process ended ${removedIn} ms after the webview was removed`)
    await pause(50)
    assert(events.some((e) => e.runtimeId === 'working' && e.type === 'released'), 'A removed webview releases its applet')

    // Three at once; a parked one gives way to a new one; a fourth with none parked is refused.
    await page(`for(const id of ['slot-a','slot-b','slot-c','slot-d']){const div=document.createElement('div');div.id=id;div.style.cssText='height:60px;width:300px';document.body.append(div)}`)
    const slots = ['slot-a', 'slot-b', 'slot-c']
    for (const [index, id] of ['second', 'third', 'fourth'].entries()) {
      const started = Date.now()
      assert(await place(mount(id, { html: '<p>applet</p>', css: '', js: '' }), {}, slots[index]), `${id} attaches`)
      await ready(id)
      console.log(`mount-to-ready ${id}: ${Date.now() - started} ms`)
    }
    assert.throws(() => mount('fifth', { html: '', css: '', js: '' }), /Only three/)
    manager.setVisible('second', false)
    await pause(10)
    manager.setVisible('third', false)
    assert(await place(mount('fifth', { html: '', css: '', js: '' }), {}, 'slot-d'), 'fifth attaches')
    assert(events.some((e) => e.runtimeId === 'second' && e.type === 'released'), 'Oldest parked guest is released at capacity')
    await pause(100)
    assert.equal(guests().length, 3, 'Never more than three guest pages')
    for (const id of ['third', 'fourth', 'fifth']) manager.unmount(id)
    await pause(100)
    assert.equal(guests().length, 0, 'Unmount closes the guest')

    // A looping applet: the window stays responsive, a crash ends the process at once, the watchdog stops the loop.
    const loopSource = { html: '', css: '', js: 'setTimeout(()=>{while(true){}},50)' }
    let looping = await place(mount('loop', loopSource))
    assert(looping)
    await pause(300)
    assert.equal(await owner.webContents.executeJavaScript('1+1'), 2, 'Owner survives infinite loop')
    const loopPid = looping.getOSProcessId()
    looping.forcefullyCrashRenderer()
    const crashedIn = await processEnded(loopPid, 1000)
    assert.notEqual(crashedIn, null, 'forcefullyCrashRenderer() ends a looping applet within 1 s')
    console.log(`looping process ended ${crashedIn} ms after forcefullyCrashRenderer()`)
    assert(events.some((e) => e.runtimeId === 'loop' && e.type === 'error'), 'A crashed applet reports it stopped')
    await page('document.querySelector("#slot webview")?.remove()')
    looping = await place(mount('loop-again', loopSource))
    assert(looping)
    await pause(300)
    const againPid = looping.getOSProcessId()
    assert.notEqual(againPid, loopPid, 'A remount gets a new process')
    await pause(5600)
    assert(events.some((e) => e.runtimeId === 'loop-again' && e.type === 'error' && String(e.payload).includes('stopped responding')), 'Independent host watchdog stops infinite loops')
    assert.notEqual(await processEnded(againPid, 1000), null, "The watchdog ends the loop's process")
    assert.equal(await owner.webContents.executeJavaScript('2+2'), 4, 'Owner survives guest termination')
    await page('document.querySelector("#slot webview")?.remove()')

    const exported = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    try {
      await exported.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(exportAppletHtml({ schemaVersion: 1, stateVersion: 1, title: 'Export fixture', description: 'Security fixture', html: '<button id="export">Test</button>', css: '', js: 'document.body.dataset.executed="yes"' })))
      await pause(150)
      const child = exported.webContents.mainFrame.frames[0]
      assert(child, 'Export iframe exists')
      assert.equal(await child.executeJavaScript('document.body.dataset.executed'), 'yes', 'Export JavaScript runs')
      assert.equal(await child.executeJavaScript('(()=>{const f=document.createElement("iframe");document.body.append(f);try{return typeof f.contentWindow.RTCPeerConnection}catch(e){return e.name}})()'), 'SecurityError', 'Export descendant cannot restore RTC')
      assert.equal(await child.executeJavaScript('fetch("https://example.com").then(()=>"leaked",()=>"blocked")'), 'blocked', 'Export denies fetch')
    } finally {
      exported.destroy()
    }

    // A replacement manager reuses the bounded partitions and never an old address.
    manager.destroy()
    manager = new AppletRuntimeManager(owner, (event) => events.push(event))
    const restartSrc = mount('restart', { html: '<output>new</output>', css: '', js: '' })
    const next = await place(restartSrc) as WebContents
    assert(next)
    await ready('restart')
    assert.equal(next.session, originalSession, 'Manager restart reuses bounded owner partition')
    assert.notEqual(restartSrc, src, 'Manager restart never reuses a source URL')
    const stale = await next.session.fetch(src).then((response) => response.status, (error) => String(error))
    assert(stale === 403 || /ERR_|Failed/.test(String(stale)), `Previous document is unavailable (${stale})`)
    assert.equal(await next.executeJavaScript('document.querySelector("output").textContent'), 'new')
    manager.destroy()
    console.log('Applet runtime passed: webview guest in its own process and session, minted-address attach only, no host/Node/RTC/storage/network/devices, app UI layered over it, transparent backdrop, conversation scroll untouched by the guest, 120 captured wheel steps, state kept across scrolling, zoom 1.25, process ends on removal/crash/watchdog, three-guest limit.')
    owner.destroy()
    app.quit()
  } catch (error) {
    console.error(error)
    manager.destroy()
    owner.destroy()
    app.exit(1)
  }
})
