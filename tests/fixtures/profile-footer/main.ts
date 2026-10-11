import { app, BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.env.MOUSSE_PROFILE_FOOTER_DIRECTORY!
app.setPath('userData', join(directory, 'user-data'))
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
setTimeout(() => app.exit(1), 15000).unref()
const delay = (ms: number) => new Promise(done => setTimeout(done, ms))

async function main() {
  await app.whenReady(); app.dock?.hide()
  // I deny external requests so the webfont check proves offline loading.
  const { session } = await import('electron')
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true }))
  const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } })
  const execute = <T,>(code: string): Promise<T> => window.webContents.executeJavaScript(code)
  async function until(code: string) {
    for (let index = 0; index < 100; index++) { if (await execute<boolean>(code)) return; await delay(20) }
    throw new Error(`Footer condition timed out: ${code}; ${JSON.stringify(await execute('({errors:footerQa.errors,text:document.body.innerText})'))}`)
  }
  const inspect = `({profile:footerQa.profile(),name:document.querySelector('.profile-sidebar-text strong')?.textContent,avatar:document.querySelector('.profile-sidebar-trigger img')?.getAttribute('src'),loading:!!document.querySelector('.profile-sidebar-loading'),errors:footerQa.errors})`
  try {
    await window.loadFile(join(directory, 'index.html'))
    await until("!!document.querySelector('.profile-sidebar-loading') && footerQa.requests.length>=2")
    const loading = await execute(inspect)
    await execute("footerQa.release('prf_alpha')")
    await until("document.querySelector('.profile-sidebar-text strong')?.textContent==='Adithya'")
    const first = await execute(inspect)
    await execute('footerQa.refresh()')
    await until("footerQa.requests.some(row=>row.profile==='prf_alpha')")
    await execute("document.querySelector('.profile-sidebar-trigger').click()")
    await until("!!document.querySelector('[role=menuitemradio]')")
    await execute("document.querySelector('[role=menuitemradio]').click()")
    await until("footerQa.profile()==='prf_beta' && footerQa.requests.some(row=>row.profile==='prf_beta')")
    await execute("footerQa.release('prf_alpha', true)")
    await delay(60)
    const afterLate = await execute(inspect)
    await execute("footerQa.release('prf_beta')")
    await until("document.querySelector('.profile-sidebar-text strong')?.textContent==='Studio'")
    const switched = await execute(inspect)
    // Switch from another control while this footer's metadata is withheld.
    // Customize must still target its displayed active profile, not old current.
    await execute('footerQa.externalSwitch()')
    await until("document.querySelector('.profile-sidebar-text strong')?.textContent==='Adithya' && footerQa.requests.some(row=>row.profile==='prf_alpha')")
    await execute("document.querySelector('.profile-sidebar-trigger').click()")
    await until("!!document.querySelector('.profile-menu-row')")
    await execute("document.querySelector('.profile-menu-row').click()")
    await until("!!document.querySelector('[aria-label=\"Profile name\"]')")
    await execute(`(()=>{
      const input=document.querySelector('[aria-label="Profile name"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Adithya local');
      input.dispatchEvent(new Event('input',{bubbles:true}));
    })()`)
    await until("!document.querySelector('[aria-label=\"Save profile name\"]').disabled")
    await execute("document.querySelector('[aria-label=\"Save profile name\"]').click()")
    await until("footerQa.updates.length===1 && document.querySelector('.profile-sidebar-text strong')?.textContent==='Adithya local'")
    const updates = await execute('footerQa.updates')
    const headings = await execute("[...document.querySelectorAll('.chat-section-heading h2')].map(node=>({text:node.textContent,transform:getComputedStyle(node).textTransform,spacing:getComputedStyle(node).letterSpacing}))")
    const binds = await execute('footerQa.binds')
    const fonts = await execute(`(async()=>{
      const faces=await Promise.all(['400 13px "Geist"','italic 700 13px "Geist"','400 13px "Geist Mono"','italic 700 13px "Geist Mono"'].map(font=>document.fonts.load(font)));
      return {ui:getComputedStyle(document.body).fontFamily,code:getComputedStyle(document.querySelector('[data-font-sample]')).fontFamily,terminal:footerQa.terminalFont,faces:faces.flat().map(face=>({family:face.family,status:face.status,weight:face.weight,style:face.style}))};
    })()`)
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ loading, first, afterLate, switched, updates, headings, binds, fonts }))
  } finally { window.destroy() }
  app.exit(0)
}
void main().catch(error => { console.error(error); app.exit(1) })
