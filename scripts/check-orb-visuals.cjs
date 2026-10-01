const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const output = path.resolve(process.env.MOUSSE_ORB_EVIDENCE || path.join(__dirname, '..', '.mousse-dev', 'orb-evidence'))
app.setPath('userData', path.join(output, 'electron-user-data'))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
setTimeout(async () => {
  console.error('Orb visual fixture timed out')
  await fs.mkdir(output, { recursive: true })
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: false, error: 'Fixture timed out', at: new Date().toISOString() }, null, 2))
  app.exit(1)
}, 45000).unref()
async function main() {
  await app.whenReady()
  await fs.mkdir(output, { recursive: true })
  const win = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, show: false,
    webPreferences: { offscreen: true, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, partition: 'orb-visual-fixture' } })
  const errors = []
  win.webContents.on('console-message', (event) => { if (event.level === 'error') { errors.push(event.message); console.error(event.message) } })
  if (!process.env.MOUSSE_ORB_FIXTURE_URL) throw new Error('Run this fixture through npm run test:orb')
  await win.loadURL(process.env.MOUSSE_ORB_FIXTURE_URL)
  for (let i = 0; i < 100; i++) {
    if (await win.webContents.executeJavaScript('Boolean(document.querySelector(".orb-identity"))')) break
    await delay(100)
  }
  const js = async (source) => {
    try { return await win.webContents.executeJavaScript(source) }
    catch (error) { console.error('Failed fixture operation: ' + source); throw error }
  }
  const assert = async (source, name) => {
    for (let i = 0; i < 30; i++) {
      if (await js(source)) { console.log('PASS ' + name); return }
      await delay(100)
    }
    throw new Error(name)
  }
  await assert('Boolean(document.querySelector(".orb-identity"))', 'rendered')
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await delay(150)
  await assert('getComputedStyle(document.querySelector(".liquid-orb__ribbon")).animationName === "none"', 'reduced motion disables animation')
  await assert('document.querySelector(".liquid-orb").dataset.moving === "false"', 'reduced motion disables parallax')
  await fs.writeFile(path.join(output, 'desktop-aurora.png'), (await win.webContents.capturePage()).toPNG())
  await js(`document.querySelector('[aria-label="Next orb palette"]').click()`)
  await delay(100)
  await assert('JSON.parse(document.querySelector("#appearance-value").textContent).palette === "lagoon"', 'next palette updates controlled draft')
  await js(`document.querySelector('[aria-label="Previous orb palette"]').click()`)
  await delay(100)
  await assert('JSON.parse(document.querySelector("#appearance-value").textContent).palette === "aurora"', 'previous palette updates controlled draft')
  await js(`document.querySelector('[aria-label="Previous orb palette"]').focus()`)
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Left' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Left' })
  await delay(100)
  await assert('JSON.parse(document.querySelector("#appearance-value").textContent).palette === "graphite"', 'keyboard carousel wraps')
  const closedOrbWidth = await js('document.querySelector(".orb-identity__art .liquid-orb").getBoundingClientRect().width')
  await js(`document.querySelector('[aria-label="Aurora"]').click(); document.querySelector('details').open = true`)
  await delay(100)
  await assert('Math.abs(document.querySelector(".orb-identity__art .liquid-orb").getBoundingClientRect().width - ' + closedOrbWidth + ') < 1', 'appearance panel preserves orb size')
  await fs.writeFile(path.join(output, 'desktop-controls.png'), (await win.webContents.capturePage()).toPNG())
  await assert('document.querySelector(".settings").getBoundingClientRect().width === document.querySelector(".orb-identity").getBoundingClientRect().width', 'desktop split is exactly half')
  await js('document.querySelector("header button").click(); document.querySelector("details").open = false')
  await delay(100)
  await fs.writeFile(path.join(output, 'desktop-light.png'), (await win.webContents.capturePage()).toPNG())
  await js('document.querySelector("header button").click()')
  win.setContentSize(760, 900)
  await delay(200)
  await assert('document.querySelector(".settings").getBoundingClientRect().top >= document.querySelector(".orb-identity").getBoundingClientRect().bottom - 1', 'narrow layout stacks')
  await assert('document.documentElement.scrollWidth <= window.innerWidth', 'narrow layout has no horizontal overflow')
  await fs.writeFile(path.join(output, 'narrow.png'), (await win.webContents.capturePage()).toPNG())
  win.setContentSize(1280, 900)
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] })
  await delay(150)
  await assert('getComputedStyle(document.querySelector(".liquid-orb__depth")).display === "none"', 'forced colors has opaque fallback')
  await fs.writeFile(path.join(output, 'forced-colors.png'), (await win.webContents.capturePage()).toPNG())
  if (errors.length) throw new Error('Renderer errors: ' + errors.join('; '))
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, errors, at: new Date().toISOString() }, null, 2))
  win.destroy()
  app.exit(0)
}
main().catch(async (error) => { console.error(error); await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: false, error: String(error), at: new Date().toISOString() }, null, 2)); app.exit(1) })
