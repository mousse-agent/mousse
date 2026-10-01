import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electron from 'electron'
import ts from 'typescript'

if (process.platform !== 'linux') throw new Error('Run this rendering check on Linux')
const directory = await mkdtemp(join(tmpdir(), 'mousse-linux-rendering-'))
try {
  const source = await readFile(new URL('../src/main/linuxRendering.ts', import.meta.url), 'utf8')
  await writeFile(join(directory, 'policy.cjs'), ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS }
  }).outputText)
  await writeFile(join(directory, 'check.cjs'), `
const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const { configureLinuxRendering } = require('./policy.cjs')
configureLinuxRendering(app, process.platform)
assert(app.commandLine.hasSwitch('disable-partial-raster'))
assert(app.commandLine.hasSwitch('ui-disable-partial-swap'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  assert.equal(app.isHardwareAccelerationEnabled(), false,
    'Linux GUI must bypass hardware acceleration')
  const window = new BrowserWindow({ width: 1000, height: 700, frame: false,
    backgroundColor: '#17111f', webPreferences: { backgroundThrottling: false } })
  try {
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<style>body{margin:0;background:#17111f;color:white;font:18px sans-serif}main{display:flex;height:100vh}aside{width:300px;flex-shrink:0;background:#282030}section{flex:1;overflow:hidden}img{width:180px}article{padding:20px;border-bottom:1px solid #777}</style>' +
      '<main><aside>Resizable sidebar</aside><section>' +
      Array.from({length:12}, (_,i) => '<article>Text and image resize check ' + i +
      '<img src="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27180%27 height=%2740%27%3E%3Crect width=%27180%27 height=%2740%27 fill=%27orange%27/%3E%3C/svg%3E"></article>').join('') + '</section></main>'))
    assert(await window.webContents.executeJavaScript(
      'Array.from(document.images).every(image => image.complete && image.naturalWidth > 0)'),
      'Fixture images must be decoded before comparing pixels')
    await pause(300)
    const baseline = (await window.webContents.capturePage()).toBitmap()
    for (const width of [460, 180, 380, 220, 500, 300]) {
      await window.webContents.executeJavaScript('document.querySelector("aside").style.width = "' + width + 'px"')
      await pause(40)
    }
    for (const width of [1100, 900, 1200, 1000]) {
      window.setSize(width, 700)
      await pause(80)
    }
    await pause(300)
    const resized = (await window.webContents.capturePage()).toBitmap()
    assert(baseline.equals(resized), 'Text/image pixels differ after returning to original layout')
    console.log('PASS: Linux software rendering and identical text/image pixels after panel and window resize')
  } finally { window.destroy() }
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(directory, 'check.cjs')], { env, stdio: 'inherit' })
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('Linux rendering check timed out after 30 seconds'))
    }, 30_000)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', code => { clearTimeout(timeout); resolve(code ?? 1) })
  })
} finally {
  await rm(directory, { recursive: true, force: true })
}
