import { app, BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.env.MOUSSE_PROFILE_FOOTER_DIRECTORY!
app.setPath('userData', join(directory, 'user-data'))
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
setTimeout(() => app.exit(1), 60000).unref()
const delay = (ms: number) => new Promise(done => setTimeout(done, ms))

async function main() {
  await app.whenReady(); app.dock?.hide()
  // I deny external requests so the webfont check proves offline loading.
  const { session } = await import('electron')
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true }))
  const window = new BrowserWindow({ show: false, width: 900, height: 700, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } })
  const execute = <T,>(code: string): Promise<T> => window.webContents.executeJavaScript(code)
  async function until(code: string) {
    for (let index = 0; index < 150; index++) { if (await execute<boolean>(code)) return; await delay(20) }
    throw new Error(`Footer condition timed out: ${code}; ${JSON.stringify(await execute('({errors:footerQa.errors,text:document.body.innerText})'))}`)
  }
  const click = (selector: string) => execute(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const clickText = (selector: string, text: string) => execute(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(node=>node.textContent.trim()===${JSON.stringify(text)}).click()`)
  const key = (name: string) => execute(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(name)},bubbles:true,cancelable:true}))`)
  const focused = () => execute<string>(`(()=>{const node=document.activeElement;return node.getAttribute('aria-label')??node.textContent.trim()})()`)
  const setInput = (selector: string, value: string) => execute(`(()=>{
    const input=document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`)
  const footerName = "document.querySelector('.profile-sidebar-profile')?.textContent"
  const load = async (query: Record<string, string>, size = { width: 900, height: 700 }) => {
    window.setContentSize(size.width, size.height)
    await window.loadFile(join(directory, 'index.html'), { query })
    await until(`!!document.querySelector('.profile-sidebar-trigger') && !!${footerName}`)
  }
  const openMenu = async () => {
    await click('.profile-sidebar-trigger')
    await until("!!document.querySelector('.profile-menu') && document.querySelector('.profile-menu').contains(document.activeElement)")
  }
  const menuIsOpen = () => execute<boolean>("!!document.querySelector('.profile-menu')")
  const actionsMenu = () => execute<string[] | null>("(()=>{const menu=document.querySelector('.profile-row-menu');return menu&&[...menu.querySelectorAll('[role=menuitem]')].map(row=>row.textContent.trim())})()")
  const openActions = async (name: string) => {
    await click(`[aria-label="${name} profile actions"]`)
    await until("!!document.querySelector('.profile-row-menu') && document.querySelector('.profile-row-menu').contains(document.activeElement)")
  }
  const dialogInfo = () => execute(`(()=>{
    const dialog=document.querySelector('[role=dialog]'); if(!dialog) return null;
    const submit=dialog.querySelector('button[type=submit]');
    const input=dialog.querySelector('[aria-label="Profile name"]');
    return { title: dialog.querySelector('h3')?.textContent, value: input.value, maxLength: input.maxLength, submit: submit.getAttribute('aria-label'), submitDisabled: submit.disabled,
      archive: !!dialog.querySelector('.profile-edit-archive'), swatches: dialog.querySelectorAll('[role=radio]').length,
      selected: dialog.querySelector('[role=radio][aria-checked=true]')?.getAttribute('aria-label') ?? null, focus: document.activeElement.getAttribute('aria-label') }
  })()`)
  const menuInfo = () => execute(`(()=>{
    const menu=document.querySelector('.profile-menu'); if(!menu) return null;
    const text=node=>node?.textContent?.trim()
    const box=node=>{const r=node.getBoundingClientRect();return {left:Math.round(r.left),top:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)}}
    const identity=menu.querySelector('.profile-account-identity')
    return { role: menu.getAttribute('role'), label: menu.getAttribute('aria-label'), box: box(menu), wide: menu.classList.contains('profile-menu-wide'),
      columns: [...menu.querySelectorAll('.profile-menu-col')].map(col=>({ label: col.getAttribute('aria-label'), box: box(col) })),
      heading: text(menu.querySelector('.profile-menu-heading')),
      profiles: [...menu.querySelectorAll('[role=menuitemradio]')].map(row=>({ name: text(row.querySelector('.profile-menu-name')), checked: row.getAttribute('aria-checked'), check: !!row.querySelector('svg'), dot: row.querySelector('.profile-dot').style.background, dotSize: box(row.querySelector('.profile-dot')).width })),
      kebabs: [...menu.querySelectorAll('.profile-menu-kebab')].map(button=>button.getAttribute('aria-label')),
      rows: [...menu.querySelectorAll('[role=menuitem]')].map(text),
      identity: identity && { name: text(identity.querySelector('strong')), email: text(identity.querySelector('span:not(.profile-avatar):not(.profile-account-devices)')), devices: text(identity.querySelector('.profile-account-devices')), avatar: box(identity.querySelector('.profile-avatar')).width, emptyAvatar: !!identity.querySelector('.mousse-id-avatar-empty') }}
  })()`)
  const inspect = `({profile:footerQa.profile(),name:${footerName},avatar:document.querySelector('.profile-sidebar-trigger img')?.getAttribute('src'),loading:!!document.querySelector('.profile-sidebar-loading'),errors:footerQa.errors})`
  const evidence: Record<string, unknown> = {}
  try {
    // Stale replies and switching through the real menu, with a build that has no Mousse ID service.
    await window.loadFile(join(directory, 'index.html'))
    await until("!!document.querySelector('.profile-sidebar-loading') && footerQa.requests.length>=2")
    const loading = await execute(inspect)
    await execute("footerQa.release('prf_alpha')")
    await until(`${footerName}==='Adithya'`)
    const first = await execute(inspect)
    await execute('footerQa.refresh()')
    await until("footerQa.requests.some(row=>row.profile==='prf_alpha')")
    await click('.profile-sidebar-trigger')
    await until("!!document.querySelector('[role=menuitemradio]')")
    await click('[role=menuitemradio][aria-checked=false]')
    await until("footerQa.profile()==='prf_beta' && footerQa.requests.some(row=>row.profile==='prf_beta')")
    await execute("footerQa.release('prf_alpha', true)")
    await delay(60)
    const afterLate = await execute(inspect)
    await execute("footerQa.release('prf_beta')")
    await until(`${footerName}==='Studio'`)
    const switched = await execute(inspect)
    // Switch from another control while this footer's metadata is withheld.
    // Rename must still target its displayed active profile, not the previous one.
    await execute('footerQa.externalSwitch()')
    await until(`${footerName}==='Adithya' && footerQa.requests.some(row=>row.profile==='prf_alpha')`)
    await openMenu()
    await openActions('Adithya')
    const defaultActions = await actionsMenu()
    await clickText('.profile-row-menu [role=menuitem]', 'Rename')
    await until("!!document.querySelector('[role=dialog]')")
    const renameDialog = await dialogInfo()
    await setInput('[aria-label="Profile name"]', 'Adithya local')
    await until("!document.querySelector('[aria-label=\"Save profile name\"]').disabled")
    await click('[aria-label="Save profile name"]')
    await until(`footerQa.updates.length===1 && ${footerName}==='Adithya local' && !document.querySelector('[role=dialog]')`)
    await until("document.activeElement===document.querySelector('.profile-sidebar-trigger')")
    const updates = await execute('footerQa.updates')
    const headings = await execute("[...document.querySelectorAll('.chat-section-heading h2')].map(node=>({text:node.textContent,transform:getComputedStyle(node).textTransform,spacing:getComputedStyle(node).letterSpacing}))")
    const binds = await execute('footerQa.binds')
    const noAccountRequests = await execute('footerQa.requestLog')
    const fonts = await execute(`(async()=>{
      const faces=await Promise.all(['400 13px "Geist"','italic 700 13px "Geist"','400 13px "Geist Mono"','italic 700 13px "Geist Mono"'].map(font=>document.fonts.load(font)));
      return {ui:getComputedStyle(document.body).fontFamily,code:getComputedStyle(document.querySelector('[data-font-sample]')).fontFamily,terminal:footerQa.terminalFont,faces:faces.flat().map(face=>({family:face.family,status:face.status,weight:face.weight,style:face.style}))};
    })()`)
    Object.assign(evidence, { loading, first, afterLate, switched, updates, headings, binds, fonts, defaultActions, renameDialog, noAccountRequests })

    // A build without MOUSSE_ID_ORIGIN: the profiles column alone, 330px wide, one profile.
    await load({ scenario: 'static', account: 'none', profiles: '1' })
    await openMenu()
    const single = { menu: await menuInfo() }
    await openActions('Adithya')
    Object.assign(single, { actions: await actionsMenu(), requests: await execute('footerQa.requestLog') })
    evidence.single = single

    // Signed in, three profiles: both columns, the device count and the account row.
    await load({ scenario: 'static', account: 'in', profiles: '3' })
    await openMenu()
    evidence.signedIn = { menu: await menuInfo(), requests: await execute('footerQa.requestLog'), trigger: await execute("document.querySelector('.profile-sidebar-trigger').getAttribute('aria-label')") }

    // The keyboard model: column by column, Home/End, Right Arrow into a row's actions, Esc one layer at a time.
    const walk: string[] = [await focused()]
    for (const name of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'End', 'Home', 'ArrowUp']) { await key(name); walk.push(await focused()) }
    await execute("[...document.querySelectorAll('[role=menuitemradio]')].find(row=>row.textContent.trim()==='Studio').focus()")
    await key('ArrowRight')
    await until("!!document.querySelector('.profile-row-menu') && document.querySelector('.profile-row-menu').contains(document.activeElement)")
    const submenu: string[] = [await focused()]
    for (const name of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'End', 'Home']) { await key(name); submenu.push(await focused()) }
    await key('Escape')
    await until("!document.querySelector('.profile-row-menu')")
    const afterFirstEscape = { menuOpen: await menuIsOpen(), focus: await focused() }
    await key('Escape')
    await until("!document.querySelector('.profile-menu')")
    const afterSecondEscape = { menuOpen: await menuIsOpen(), trigger: await execute("document.activeElement===document.querySelector('.profile-sidebar-trigger')") }
    // Tab reaches each row's kebab after the row (a button is activated by Enter natively).
    await openMenu()
    const kebabTabbable = await execute("[...document.querySelectorAll('.profile-menu-kebab')].every(button=>button.tabIndex===0)")
    evidence.keyboard = { walk, submenu, afterFirstEscape, afterSecondEscape, kebabTabbable }

    // Editing from the row menu: validation, Colour, Archive, and creating a profile.
    await load({ scenario: 'static', account: 'in', profiles: '3' })
    await openMenu()
    await openActions('Studio')
    const studioActions = await actionsMenu()
    await clickText('.profile-row-menu [role=menuitem]', 'Colour')
    await until("!!document.querySelector('[role=dialog]')")
    await until("document.activeElement.getAttribute('role')==='radio'")
    const colourDialog = await dialogInfo()
    await click('[role=radio][aria-label="Teal"]')
    await click('[aria-label="Save profile name"]')
    await until("footerQa.updates.length===1 && !document.querySelector('[role=dialog]')")
    const colourUpdates = await execute('footerQa.updates')
    await openMenu()
    const recoloured = (await menuInfo() as { profiles: Array<{ name: string; dot: string }> }).profiles.map(row => row.dot)
    await openActions('Design')
    await clickText('.profile-row-menu [role=menuitem]', 'Rename')
    await until("!!document.querySelector('[role=dialog]')")
    const designDialog = await dialogInfo()
    await setInput('[aria-label="Profile name"]', '')
    const emptyDialog = await dialogInfo()
    await setInput('[aria-label="Profile name"]', 'x'.repeat(80))
    const longDialog = await dialogInfo()
    await setInput('[aria-label="Profile name"]', '   ')
    const blankDialog = await dialogInfo()
    await setInput('[aria-label="Profile name"]', 'Design')
    const unchangedDialog = await dialogInfo()
    await execute("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
    await until("!document.querySelector('[role=dialog]')")
    // Archive from inside the dialog, after the confirmation.
    await openMenu()
    await openActions('Design')
    await clickText('.profile-row-menu [role=menuitem]', 'Rename')
    await until("!!document.querySelector('[role=dialog]')")
    await click('.profile-edit-archive')
    await until("footerQa.archives.length===1 && !document.querySelector('[role=dialog]')")
    const afterDialogArchive = { archives: await execute('footerQa.archives'), confirms: await execute('footerQa.confirms') }
    // Archive from the row menu.
    await openMenu()
    await until("![...document.querySelectorAll('[role=menuitemradio]')].some(row=>row.textContent.trim()==='Design')")
    await openActions('Studio')
    await clickText('.profile-row-menu [role=menuitem]', 'Archive')
    await until("footerQa.archives.length===2 && ![...document.querySelectorAll('[role=menuitemradio]')].some(row=>row.textContent.trim()==='Studio')")
    const afterRowArchive = { archives: await execute('footerQa.archives'), confirms: await execute('footerQa.confirms'), rows: (await menuInfo() as { profiles: Array<{ name: string }> }).profiles.map(row => row.name) }
    await clickText('.profile-menu [role=menuitem]', 'New profile')
    await until("!!document.querySelector('[role=dialog]')")
    const createDialog = await dialogInfo()
    await setInput('[aria-label="Profile name"]', 'Docs')
    await click('[aria-label="Create profile"]')
    await until(`footerQa.creates.length===1 && footerQa.binds.includes('prf_new1') && ${footerName}==='Docs'`)
    const created = { creates: await execute('footerQa.creates'), binds: await execute('footerQa.binds') }
    // Archiving the profile the window is on moves to the default profile first.
    await openMenu()
    await openActions('Docs')
    const docsActions = await actionsMenu()
    await clickText('.profile-row-menu [role=menuitem]', 'Archive')
    await until(`footerQa.archives.includes('prf_new1') && ${footerName}==='Adithya'`)
    const archivedCurrent = { binds: await execute('footerQa.binds'), archives: await execute('footerQa.archives') }
    evidence.actions = { studioActions, colourDialog, colourUpdates, recoloured, designDialog, emptyDialog, longDialog, blankDialog, unchangedDialog, afterDialogArchive, afterRowArchive, createDialog, created, docsActions, archivedCurrent, errors: await execute('footerQa.errors') }

    // Signed out: the sign-in row replaces the identity, and there is no Sign out.
    await load({ scenario: 'static', account: 'out', profiles: '2' })
    await openMenu()
    evidence.signedOut = { menu: await menuInfo(), requests: await execute('footerQa.requestLog'), trigger: await execute("document.querySelector('.profile-sidebar-trigger').getAttribute('aria-label')") }

    // Narrow windows stack the columns, account on top, at the single-column width.
    await load({ scenario: 'static', account: 'in', profiles: '3' }, { width: 500, height: 800 })
    await openMenu()
    await until("!!document.querySelector('.profile-account-devices')")
    evidence.narrow = { menu: await menuInfo(), viewport: await execute('innerWidth') }
  } finally { window.destroy() }
  writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence))
  app.exit(0)
}
void main().catch(error => { console.error(error); app.exit(1) })
