import { app, BrowserWindow, screen } from 'electron'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const directory = process.env.MOUSSE_FONT_INSPECTION_DIRECTORY!
if (!directory) throw new Error('A dedicated font inspection directory is required')
mkdirSync(directory, { recursive: true })
app.setPath('userData', join(directory, 'user-data'))
if (process.env.MOUSSE_FONT_INSPECTION_SOFTWARE === '1') app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
setTimeout(() => app.exit(1), 15000).unref()

async function main() {
  await app.whenReady(); app.dock?.hide()
  const fontCss = readFileSync(resolve('src/renderer/styles/geist-fonts.css'), 'utf8')
    .replaceAll('../assets/fonts/geist/', './')
  for (const font of ['Geist-Variable.woff2', 'Geist-Italic-Variable.woff2', 'GeistMono-Variable.woff2', 'GeistMono-Italic-Variable.woff2']) {
    copyFileSync(resolve('src/renderer/assets/fonts/geist', font), join(directory, font))
  }
  const shellCss = readFileSync(resolve('src/renderer/styles/compact-shell.css'), 'utf8')
  const movementCss = readFileSync(resolve('src/renderer/styles/sliding-threads-pane.css'), 'utf8')
  const html = `<!doctype html><meta charset="utf-8"><style>${fontCss}${shellCss}${movementCss}
    html,body{margin:0;background:#111;color:#e6e6e6}body{padding:24px;box-sizing:border-box}
    h1{font-size:16px;font-weight:500;margin:0 0 20px}h2{font-size:12px;color:#aaa;font-weight:500;margin:0 0 10px}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:22px 40px}section{border:1px solid #292929;border-radius:8px;padding:16px;background:#151519}
    p{margin:8px 0;font-size:13px;font-weight:400;line-height:20px}.system p{font-family:'Segoe UI',system-ui,sans-serif}
    .fractional{transform:translateX(.4px) scale(.99)}.layer{transform:translateZ(0);will-change:transform}.bold p{font-weight:500}
    pre{font-size:12px;line-height:18px}.sample-sidebar{width:220px;height:120px}.app{--threads-pane-width:220px;--threads-pane-layout-width:220px}
  </style><h1>Native text rendering check · Geist</h1><div class="grid">
    <section class="native"><h2>Geist 400 · no transform or filter</h2><p data-text>Projects and recent conversations</p><p>The quick brown fox jumps over the lazy dog.</p><p>Workspace settings · Chat with an agent</p><pre>const answer = 42; // Geist Mono</pre></section>
    <section class="system"><h2>System reference · Segoe UI 400</h2><p>Projects and recent conversations</p><p>The quick brown fox jumps over the lazy dog.</p><p>Workspace settings · Chat with an agent</p><pre>const answer = 42; // Geist Mono</pre></section>
    <section class="layer"><h2>Geist 400 · forced compositor layer</h2><p>Projects and recent conversations</p><p>The quick brown fox jumps over the lazy dog.</p><p>Workspace settings · Chat with an agent</p></section>
    <section class="fractional"><h2>Geist 400 · fractional scale/translation reference</h2><p>Projects and recent conversations</p><p>The quick brown fox jumps over the lazy dog.</p><p>Workspace settings · Chat with an agent</p></section>
    <section class="bold"><h2>Geist 500 · same compact text size</h2><p>Projects and recent conversations</p><p>The quick brown fox jumps over the lazy dog.</p></section>
    <section class="app sample-sidebar"><h2>Actual sidebar wrapper at rest</h2><div class="sliding-threads-pane is-expanded"><div class="sliding-threads-pane-clip"><div class="sliding-threads-pane-content"><p>Projects and recent conversations</p></div></div></div></section>
  </div>`
  const window = new BrowserWindow({ width: 1050, height: 680, show: false, backgroundColor: '#111111', webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } })
  try {
    writeFileSync(join(directory, 'index.html'), html)
    await window.loadFile(join(directory, 'index.html'))
    const renderer = await window.webContents.executeJavaScript(`(async()=>{
      const fonts=await Promise.all(['400 13px "Geist"','500 13px "Geist"','400 12px "Geist Mono"'].map(font=>document.fonts.load(font)));
      const sample=node=>{const css=getComputedStyle(node);const rect=node.getBoundingClientRect();return {family:css.fontFamily,size:css.fontSize,weight:css.fontWeight,transform:css.transform,filter:css.filter,backdrop:css.backdropFilter,opacity:css.opacity,smoothing:css.webkitFontSmoothing,textRendering:css.textRendering,willChange:css.willChange,x:rect.x,y:rect.y,width:rect.width,height:rect.height}};
      return {devicePixelRatio,viewportScale:visualViewport?.scale,fonts:fonts.flat().map(face=>({family:face.family,status:face.status,weight:face.weight})),samples:Object.fromEntries(['.native p','.system p','.layer','.fractional','.bold p','.sliding-threads-pane-content'].map(selector=>[selector,sample(document.querySelector(selector))]))};
    })()`)
    await new Promise(done => setTimeout(done, 100))
    const display = screen.getDisplayMatching(window.getBounds())
    const evidence = { platform: process.platform, electron: process.versions.electron, zoomLevel: window.webContents.getZoomLevel(), zoomFactor: window.webContents.getZoomFactor(), displayScale: display.scaleFactor, gpu: app.getGPUFeatureStatus(), renderer }
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2))
    try { writeFileSync(join(directory, 'comparison.png'), (await window.webContents.capturePage()).toPNG()) }
    catch (error) { writeFileSync(join(directory, 'capture-error.txt'), error instanceof Error ? error.message : String(error)) }
    console.log(JSON.stringify({ directory, zoomFactor: evidence.zoomFactor, displayScale: evidence.displayScale, renderer }))
  } finally { window.destroy() }
  app.exit(0)
}
void main().catch(error => { console.error(error?.stack ?? error?.message ?? String(error)); app.exit(1) })
