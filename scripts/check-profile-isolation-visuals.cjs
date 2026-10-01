const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')

const output = path.resolve(process.env.MOUSSE_PROFILE_FIXTURE_EVIDENCE || path.join(__dirname, '..', '.mousse-dev', 'profile-isolation-evidence'))
app.setPath('userData', path.join(output, 'electron-user-data'))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
setTimeout(() => { console.error('Profile fixture timed out'); app.exit(1) }, 90000).unref()

async function main() {
  await fs.rm(path.join(output, 'electron-user-data'), { recursive: true, force: true })
  await app.whenReady()
  await fs.mkdir(output, { recursive: true })
  ipcMain.handle('fixture:platform-request', () => ({
    ok: false,
    error: {
      code: 'revision_conflict',
      message: 'Profile revision is stale',
      details: { expectedRevision: 2, actualRevision: 3 }
    }
  }))
  if (!process.env.MOUSSE_PROFILE_FIXTURE_URL) throw new Error('Run this fixture through scripts/run-profile-isolation-visual-check.mjs')

  const makeWindow = (profile) => new BrowserWindow({
    width: 900, height: 700, useContentSize: true, show: false,
    webPreferences: {
      offscreen: true, contextIsolation: true, sandbox: true,
      nodeIntegration: false, backgroundThrottling: false,
      preload: path.resolve(__dirname, 'profile-isolation-fixture-preload.cjs'),
      partition: `persist:mousse-profile-${profile}`
    }
  })
  const a = makeWindow('a')
  const b = makeWindow('b')
  const errors = []
  for (const win of [a, b]) {
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error') { errors.push(event.message); console.error(event.message) }
    })
  }
  const url = process.env.MOUSSE_PROFILE_FIXTURE_URL
  await Promise.all([
    a.loadURL(`${url}?profile=profile-a`),
    b.loadURL(`${url}?profile=profile-b`)
  ])
  const js = (win, source) => win.webContents.executeJavaScript(source)
  const assert = async (condition, name) => {
    for (let i = 0; i < 40; i++) {
      if (await condition()) { console.log(`PASS ${name}`); return }
      await delay(100)
    }
    throw new Error(name)
  }
  await assert(() => js(a, 'document.querySelector("#profile-id").textContent === "profile-a"'), 'window A bound to profile A')
  await assert(() => js(b, 'document.querySelector("#profile-id").textContent === "profile-b"'), 'window B bound to profile B')
  await assert(() => js(a, 'window.fixturePlatform.request().then(() => false).catch((error) => error.code === "revision_conflict" && error.details?.expectedRevision === 2 && error.details?.actualRevision === 3)'), 'structured revision conflict survives hidden Electron IPC')
  await assert(() => js(a, 'document.querySelector("#partition-marker").textContent === "profile-a"'), 'profile A browser partition marker')
  await assert(() => js(b, 'document.querySelector("#partition-marker").textContent === "profile-b"'), 'profile B browser partition marker')

  await js(a, 'document.querySelector("#draft").value = "A dirty"; document.querySelector("#draft").dispatchEvent(new Event("input", { bubbles: true }))')
  await js(a, 'document.querySelector("[data-action=\\"switch-b\\"]").click()')
  await assert(() => js(a, 'location.search.includes("profile-a") && document.querySelector("#dirty-state").textContent === "dirty"'), 'dirty guard blocks profile switch')
  await js(a, 'document.querySelector("[data-action=\\"save\\"]").click(); document.querySelector("[data-action=\\"switch-b\\"]").click()')
  await assert(() => js(a, 'location.search.includes("profile-b")'), 'saved window can switch profile')

  // A stale response/event from A must not repaint B. A matching event still arrives.
  await js(a, 'dispatchEvent(new CustomEvent("mousse-late-response", { detail: { profileId: "profile-b", message: "B late" } }))')
  await js(b, 'dispatchEvent(new CustomEvent("mousse-late-response", { detail: { profileId: "profile-a", message: "A leaked" } })); dispatchEvent(new CustomEvent("mousse-profile-event", { detail: { profileId: "profile-b", message: "B live" } }))')
  await assert(() => js(a, 'document.querySelector("#event-log").textContent.includes("B late")'), 'late response stays in its profile')
  await assert(() => js(b, 'document.querySelector("#event-log").textContent.includes("B live") && !document.querySelector("#event-log").textContent.includes("A leaked")'), 'events do not cross profile windows')

  await js(a, 'document.querySelector("[data-action=\\"theme\\"]").click()')
  await assert(() => js(a, 'document.documentElement.dataset.theme === "light"'), 'profile A theme updates')
  await assert(() => js(b, 'document.documentElement.dataset.theme === "dark"'), 'profile B theme remains isolated')

  await fs.writeFile(path.join(output, 'profile-a.png'), (await a.webContents.capturePage()).toPNG())
  await fs.writeFile(path.join(output, 'profile-b.png'), (await b.webContents.capturePage()).toPNG())
  const result = { passed: true, errors, profiles: ['profile-a', 'profile-b'], checks: ['ipc-revision-conflict', 'late-response', 'event-routing', 'dirty-guard', 'theme', 'browser-partition'], at: new Date().toISOString() }
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
  a.destroy(); b.destroy(); app.exit(errors.length ? 1 : 0)
}

main().catch(async (error) => {
  console.error(error)
  await fs.mkdir(output, { recursive: true })
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: false, error: String(error), at: new Date().toISOString() }, null, 2))
  app.exit(1)
})
