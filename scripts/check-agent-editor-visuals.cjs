const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const output = path.resolve(process.env.MOUSSE_AGENT_EDITOR_EVIDENCE || path.join(__dirname, '..', '.mousse-dev', 'agent-editor-evidence'))
app.setPath('userData', path.join(output, 'electron-user-data'))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
setTimeout(() => { console.error('Agent editor fixture timed out'); app.exit(1) }, 90000).unref()

async function main() {
  await app.whenReady()
  await fs.mkdir(output, { recursive: true })
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    useContentSize: true,
    show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      partition: 'agent-editor-visual-fixture'
    }
  })
  const errors = []
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') {
      if (/monaco|worker|Canceled|Failed to load/i.test(event.message)) return
      errors.push(event.message)
      console.error(event.message)
    }
  })
  if (!process.env.MOUSSE_AGENT_EDITOR_FIXTURE_URL) throw new Error('Run this fixture through scripts/run-agent-editor-visual-check.mjs')
  await win.loadURL(process.env.MOUSSE_AGENT_EDITOR_FIXTURE_URL)
  for (let i = 0; i < 120; i++) {
    if (await win.webContents.executeJavaScript('Boolean(document.querySelector("[data-agent-library]"))')) break
    await delay(100)
  }
  const js = async (source) => {
    try { return await win.webContents.executeJavaScript(source) }
    catch (error) { console.error('Failed fixture operation: ' + source); throw error }
  }
  const assert = async (source, name) => {
    for (let i = 0; i < 40; i++) {
      if (await js(source)) { console.log('PASS ' + name); return }
      await delay(100)
    }
    throw new Error(name)
  }
  const sendKey = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await delay(30)
  }

  await assert('Boolean(document.querySelector("[data-agent-library]"))', 'library rendered')
  await assert('Boolean(document.querySelector("[data-active-runs]"))', 'active runs slot is preserved')
  await js('document.querySelector("[data-action=\\"new-agent\\"]").click()')
  await assert('Boolean(document.querySelector("[data-agent-editor]"))', 'new agent opens editor')
  await js(`(() => {
    const field = document.querySelector('[data-field="name"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(field, 'Research companion');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await delay(100)
  const sourceTab = 'Array.from(document.querySelectorAll(\'[role="tab"]\')).find((el) => el.textContent.includes("Source"))'
  const previewTab = 'Array.from(document.querySelectorAll(\'[role="tab"]\')).find((el) => el.textContent.includes("Preview"))'
  await assert('Boolean(document.querySelector(".monaco-editor textarea"))', 'Monaco source editor mounted')
  await js('document.querySelector(".monaco-editor").scrollIntoView({ block: "center" })')
  await delay(100)
  const editorPoint = await js(`(() => {
    const rect = document.querySelector('.monaco-editor').getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + Math.min(40, rect.height / 2)) };
  })()`)
  win.webContents.sendInputEvent({ type: 'mouseMove', x: editorPoint.x, y: editorPoint.y })
  win.webContents.sendInputEvent({ type: 'mouseDown', x: editorPoint.x, y: editorPoint.y, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x: editorPoint.x, y: editorPoint.y, button: 'left', clickCount: 1 })
  await delay(100)
  await sendKey('A', ['control'])
  const initialPrompt = '# Research brief\n\nAlpha  beta\n\n- exact'
  await win.webContents.insertText(initialPrompt)
  const enteredPrompt = await js('document.querySelector("#prompt-value").textContent')
  await assert(
    `document.querySelector("#prompt-value").textContent.replace(/\\r\\n/g, "\\n") === ${JSON.stringify(initialPrompt)}`,
    'Monaco edit updates source without changing spaces'
  )
  await sendKey('Home', ['control'])
  for (let i = 0; i < '# Research'.length; i++) await sendKey('Right', ['shift'])
  await assert(`Boolean(${previewTab})`, 'prompt Preview tab present')
  await js(`(${previewTab}).click()`)
  await delay(100)
  await assert(`(${previewTab}).getAttribute("aria-selected") === "true"`, 'Preview tab selected')
  await assert('document.querySelector(\'[role="tabpanel"][aria-hidden="false"]\').innerText.includes("Research brief")', 'Preview renders edited prompt')
  await js(`(${sourceTab}).click()`)
  await delay(100)
  await assert(`(${sourceTab}).getAttribute("aria-selected") === "true"`, 'Source tab restored')
  await win.webContents.insertText('## Updated')
  const selectedPrompt = enteredPrompt.replace('# Research', '## Updated')
  await assert(`document.querySelector("#prompt-value").textContent === ${JSON.stringify(selectedPrompt)}`, 'Source restores Monaco selection after Preview')
  await js('document.querySelector(\'[aria-label="Next orb palette"]\').click()')
  await delay(150)
  await assert('JSON.parse(document.querySelector("#appearance-value").textContent).palette === "lagoon"', 'palette updates visual draft only')
  await sendKey('S', ['control'])
  await assert('document.querySelector("[data-dirty]")?.getAttribute("data-dirty") === "false" || document.querySelector("[data-editor-status]")?.textContent.includes("Draft saved")', 'save draft completes')
  const savedPalette = await js('document.querySelector("#appearance-value").textContent')
  await js('document.querySelector("[data-action=\\"back\\"]").click()')
  await delay(200)
  await js('document.querySelector("[data-action=\\"new-agent\\"]") ? true : document.querySelector("[data-agent-card]")')
  await js('Array.from(document.querySelectorAll("[data-agent-card]")).find((el) => el.textContent.includes("Research companion"))?.click()')
  await assert('Boolean(document.querySelector("[data-agent-editor]"))', 'reload opens saved editor')
  await assert(`document.querySelector("#appearance-value").textContent.includes("lagoon") || document.querySelector("#appearance-value").textContent === ${JSON.stringify(savedPalette)}`, 'palette persisted after reload')
  await assert(`document.querySelector("#prompt-value").textContent === ${JSON.stringify(selectedPrompt)}`, 'exact Monaco source persisted after reload')
  await assert('document.querySelector(".agent-editor__settings").getBoundingClientRect().width === document.querySelector(".agent-editor__identity").getBoundingClientRect().width', 'desktop split is exactly half')
  await fs.writeFile(path.join(output, 'desktop.png'), (await win.webContents.capturePage()).toPNG())

  await js(`(() => {
    const field = document.querySelector('[data-field="name"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(field, 'Dirty name');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await delay(50)
  await assert('document.querySelector(\'[aria-label="Export agent"]\').disabled === true', 'dirty draft cannot export stale registry bytes')
  await js('document.querySelector("[data-action=\\"back\\"]").click()')
  await assert('Boolean(document.querySelector(".modal"))', 'dirty navigation shows review dialog')
  await js('Array.from(document.querySelectorAll(".modal button")).find((el) => el.textContent.includes("Keep editing"))?.click()')
  await assert('Boolean(document.querySelector("[data-agent-editor]"))', 'cancel keeps the editor')
  await js('document.querySelector("[data-fixture=profile-b]").click()')
  await assert('Boolean(document.querySelector(".modal"))', 'profile switch asks the mounted dirty editor')
  await assert('document.getElementById("fixture-profile").textContent === "profile-a"', 'profile remains bound while the decision is pending')
  await js('Array.from(document.querySelectorAll(".modal button")).find((el) => el.textContent.includes("Keep editing"))?.click()')
  await assert('document.getElementById("fixture-profile").textContent === "profile-a" && document.querySelector("[data-field=name]").value === "Dirty name"', 'declined profile switch preserves the unsaved draft')

  win.setContentSize(760, 900)
  await delay(250)
  await assert('document.querySelector(".agent-editor__settings").getBoundingClientRect().top >= document.querySelector(".agent-editor__identity").getBoundingClientRect().bottom - 1', 'narrow layout stacks')
  await assert('document.documentElement.scrollWidth <= window.innerWidth + 1', 'narrow layout has no horizontal overflow')
  await fs.writeFile(path.join(output, 'narrow.png'), (await win.webContents.capturePage()).toPNG())

  win.setContentSize(1280, 900)
  await js('document.querySelector("[data-action=\\"back\\"]").click()')
  await delay(200)
  if (await js('Boolean(document.querySelector(".modal"))')) {
    await js('document.querySelector("[data-action=\\"discard-draft\\"]")?.click()')
    await delay(200)
  }
  await assert('Boolean(document.querySelector("[data-agent-library]"))', 'returned to library')
  await js('Array.from(document.querySelectorAll("[data-agent-card]")).find((el) => el.textContent.includes("Unavailable model"))?.click()')
  await assert('Boolean(document.querySelector("[data-agent-editor]"))', 'unavailable model agent opens')
  await assert('document.body.innerText.includes("no longer in the shared catalog") || document.body.innerText.includes("removed-model")', 'unavailable model stays visible')
  await assert('document.querySelector("[data-action=\\"publish\\"]")?.disabled === true', 'publish blocked for missing model')

  await js('document.querySelector("[data-fixture=\\"profile-b\\"]").click()')
  await delay(300)
  await assert('document.getElementById("fixture-profile").textContent === "profile-b"', 'profile switched')
  await assert('document.querySelector("[data-agent-library]")?.getAttribute("data-profile-id") === "profile-b"', 'open editor resets at profile boundary')
  await assert('!document.body.innerText.includes("Unavailable model")', 'stale profile A rows are not shown after switch')

  if (errors.length) throw new Error('Renderer errors: ' + errors.join('; '))
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, errors, at: new Date().toISOString() }, null, 2))
  win.destroy()
  app.exit(0)
}

main().catch(async (error) => {
  console.error(error)
  await fs.mkdir(output, { recursive: true })
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: false, error: String(error), at: new Date().toISOString() }, null, 2))
  app.exit(1)
})
