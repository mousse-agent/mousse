import { app, BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.env.MOUSSE_RENDERER_STARTUP_DIRECTORY!
app.setPath('userData', join(directory, 'user-data'))
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
setTimeout(() => app.exit(1), 15000).unref()
const delay = (ms: number) => new Promise(done => setTimeout(done, ms))

async function main() {
  await app.whenReady(); app.dock?.hide()
  const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } })
  const rendererErrors: string[] = []
  window.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message) })
  const execute = <T,>(code: string): Promise<T> => window.webContents.executeJavaScript(code)
  async function until(code: string) {
    for (let index = 0; index < 100; index++) { if (await execute<boolean>(code)) return; await delay(20) }
    throw new Error(`Startup condition timed out: ${code}; ${JSON.stringify(await execute('({calls:window.qa?.calls,errors:window.qa?.errors,text:document.body.innerText})'))}; ${rendererErrors.join('\n')}`)
  }
  try {
    await window.loadFile(join(directory, 'index.html'))
    await until("!!document.querySelector('.navigation-rail') && qa.calls.filter(row=>row.method==='profiles.status').length>=2")
    // Let mount effects settle with both trusted bootstrap responses held.
    await delay(100)
    const before = await execute('({calls:qa.calls,ready:qa.ready(),profile:qa.profile(),channels:!!document.querySelector(".channels-page"),main:!!document.querySelector(".main-area"),skeleton:!!document.querySelector("[data-workspace-loading=connection]"),titlebar:!!document.querySelector(".titlebar"),theme:document.documentElement.dataset.theme,surface:getComputedStyle(document.documentElement).getPropertyValue("--surface-base").trim(),acrylic:document.documentElement.dataset.acrylic})')
    await execute('qa.fail()')
    await until("document.querySelector('[data-workspace-loading=connection] [role=alert]')?.textContent.includes('Controlled workspace service unavailable')")
    const failed = await execute('({ready:qa.ready(),main:!!document.querySelector(".main-area"),skeleton:!!document.querySelector("[data-workspace-loading=connection]"),error:document.querySelector("[data-workspace-loading=connection] [role=alert]")?.textContent})')
    const previous = await execute<number>("qa.calls.filter(row=>row.method==='profiles.status').length")
    await execute("document.querySelector('[data-workspace-loading=connection] button').click()")
    await until(`qa.calls.filter(row=>row.method==='profiles.status').length>${previous} && !document.querySelector('[data-workspace-loading=connection] [role=alert]')`)
    await execute('qa.bind()')
    await until('qa.ready()')
    await execute('qa.openBrowser()')
    await until("qa.ready() && qa.calls.some(row=>row.method==='platformRequest.request' && row.params==='browser.access.status') && qa.calls.some(row=>row.method==='channels.getSnapshot')")
    await delay(100)
    const after = await execute('({calls:qa.calls,ready:qa.ready(),profile:qa.profile(),errors:qa.errors,channels:!!document.querySelector(".channels-page"),main:!!document.querySelector(".main-area"),workspaceReady:qa.workspaceReady(),skeleton:!!document.querySelector("[data-workspace-loading=content]"),transcript:!!document.querySelector(".startup-transcript")})')
    await execute('qa.hydrate()')
    await until("qa.workspaceReady() && !!document.querySelector('.startup-transcript') && !document.querySelector('[data-workspace-loading]')")
    const hydrated = await execute('({workspaceReady:qa.workspaceReady(),transcript:!!document.querySelector(".startup-transcript"),errors:qa.errors})')
    const workspaceSize = await execute('({width:document.querySelector(".app").offsetWidth,height:document.querySelector(".app").offsetHeight})')
    await execute('window.retainedWorkspace=document.querySelector(".startup-transcript")')
    const acrylic = []
    for (const [theme, intensity] of [['blacksphere-plus', 20], ['blacksphere-plus', 90], ['dark-modern', 55], ['light', 55]]) {
      await execute(`qa.acrylic(${JSON.stringify(theme)},${intensity})`)
      acrylic.push(await execute(`(() => {
        const style = element => ({background:getComputedStyle(element).backgroundColor,image:getComputedStyle(element).backgroundImage});
        const divider = getComputedStyle(document.querySelector('.resizer')).backgroundColor;
        return {root:style(document.querySelector('.app')),panes:[...document.querySelectorAll('.sidebar,.threads-sidebar,.navigation-rail,.titlebar,.main-area,.main-area>.header')].map(style),dividerAlpha:Number(divider.match(/\\/\\s*([\\d.]+)/)?.[1] ?? divider.match(/,\\s*([\\d.]+)\\)$/)?.[1]),visiblePanes:[...document.querySelectorAll('.main-area>.keep-mounted-stack>.keep-mounted-pane')].filter(element=>getComputedStyle(element).display!=='none' && getComputedStyle(element).opacity!=='0').length};
      })()`))
    }
    const overlays = []
    // Opening another page must replace the previous page, even if it was open.
    for (const page of ['settings', 'scheduled', 'channels']) {
      await execute(`qa.overlay(${JSON.stringify(page)},true)`)
      await until(`document.querySelector('.app').inert && !document.querySelector('.${page === 'scheduled' ? 'scheduled' : page}-page').hidden`)
      overlays.push(await execute(`(() => {
        const workspace=document.querySelector('.app'),page=document.querySelector('.overlay-page:not([hidden])');
        return {workspaceVisibility:getComputedStyle(workspace).visibility,workspaceInert:workspace.inert,workspaceSize:{width:workspace.offsetWidth,height:workspace.offsetHeight},visiblePages:document.querySelectorAll('.overlay-page:not([hidden])').length,headerBackground:getComputedStyle(page.querySelector('.overlay-titlebar')).backgroundColor,workspaceRetained:retainedWorkspace===document.querySelector('.startup-transcript')};
      })()`))
    }
    await execute('qa.overlay("channels",false)')
    await until('!document.querySelector(".app").inert')
    const restored = await execute('({visibility:getComputedStyle(document.querySelector(".app")).visibility,inert:document.querySelector(".app").inert,retained:retainedWorkspace===document.querySelector(".startup-transcript")})')
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ before, failed, after, hydrated, acrylic, overlays, restored, workspaceSize, rendererErrors }))
  } finally { window.destroy() }
  app.exit(0)
}
void main().catch(error => { console.error(error); app.exit(1) })
