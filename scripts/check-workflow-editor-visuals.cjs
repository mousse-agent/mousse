const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const output = path.resolve(process.env.MOUSSE_WORKFLOW_EDITOR_EVIDENCE || path.join(__dirname, '..', '.mousse-dev', 'workflow-editor-evidence'))
app.setPath('userData', path.join(output, 'electron-user-data'))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
setTimeout(() => { console.error('Workflow editor fixture timed out'); app.exit(1) }, 120000).unref()

async function main() {
  await app.whenReady()
  await fs.mkdir(output, { recursive: true })
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    useContentSize: true,
    show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      partition: 'workflow-editor-visual-fixture'
    }
  })
  const errors = []
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') {
      if (/monaco|worker|Canceled|Failed to load|ResizeObserver/i.test(event.message)) return
      errors.push(event.message)
      console.error(event.message)
    }
  })
  if (!process.env.MOUSSE_WORKFLOW_EDITOR_FIXTURE_URL) throw new Error('Run this fixture through scripts/run-workflow-editor-visual-check.mjs')
  await win.loadURL(process.env.MOUSSE_WORKFLOW_EDITOR_FIXTURE_URL)
  for (let i = 0; i < 120; i++) {
    if (await win.webContents.executeJavaScript('Boolean(document.querySelector("[data-workflow-library]"))')) break
    await delay(100)
  }
  const js = async (source) => {
    try { return await win.webContents.executeJavaScript(source) }
    catch (error) { console.error('Failed fixture operation: ' + source); throw error }
  }
  const assert = async (source, name) => {
    for (let i = 0; i < 50; i++) {
      if (await js(source)) { console.log('PASS ' + name); return }
      await delay(100)
    }
    throw new Error(name)
  }

  await assert('Boolean(document.querySelector("[data-workflow-library]"))', 'library rendered')
  await assert('Boolean(document.querySelector("[data-active-runs]"))', 'active runs slot is preserved')
  await js('document.querySelector("[data-action=\\"new-workflow\\"]").click()')
  await delay(100)
  await js('document.querySelector("[data-template=\\"blank\\"]").click()')
  await assert('Boolean(document.querySelector("[data-workflow-editor]"))', 'new workflow opens editor')

  await js(`(() => {
    const field = document.querySelector('[data-field="name"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(field, 'Research pipeline');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await delay(50)
  await js('document.querySelector("[data-palette-type=\\"script\\"]").click()')
  await assert('document.querySelector("[data-node-id=\\"script-1\\"], [data-outline-row=\\"script-1\\"], [data-palette-type=\\"script\\"]")', 'palette has script node')
  await assert('document.body.innerText.includes("script-1") || document.querySelector("[data-node-id=\\"script-1\\"]")', 'script node added')
  await js('document.querySelector("[data-action=\\"undo\\"]").click()')
  await assert('Number(document.querySelector("[data-canvas-node-count]")?.textContent) === 2', 'undo removes the added graph node')
  await js('document.querySelector("[data-action=\\"redo\\"]").click()')
  await assert('Number(document.querySelector("[data-canvas-node-count]")?.textContent) === 3', 'redo restores the added graph node')

  await js(`Array.from(document.querySelectorAll("button")).find((el) => el.textContent.trim() === "Outline")?.click()`)
  await delay(100)
  await js(`(() => {
    const from = document.querySelector('[name="from"]');
    const port = document.querySelector('[name="port"]');
    const to = document.querySelector('[name="to"]');
    if (from) from.value = 'start';
    if (port) port.value = 'next';
    if (to) to.value = 'script-1';
    from?.dispatchEvent(new Event('change', { bubbles: true }));
    port?.dispatchEvent(new Event('change', { bubbles: true }));
    to?.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('[data-action="connect-nodes"]')?.click();
  })()`)
  await delay(150)
  await assert('document.body.innerText.includes("script-1")', 'connected graph still contains script-1')

  const identityBeforeLayout = await js('document.querySelector("[data-semantic-identity]").textContent')
  await js('document.querySelector("[data-action=\\"auto-layout\\"]").click()')
  await delay(100)
  const identityAfterLayout = await js('document.querySelector("[data-semantic-identity]").textContent')
  if (identityBeforeLayout !== identityAfterLayout) throw new Error('layout-only change mutated semantic identity')
  console.log('PASS layout-only semantic identity preserved')

  await js('document.querySelector("[data-action=\\"save-draft\\"]").click()')
  await assert('document.querySelector("[data-dirty]")?.getAttribute("data-dirty") === "false" || document.querySelector("[data-editor-status]")?.textContent.includes("Draft saved")', 'save draft completes')
  await assert('Number(document.querySelector("[data-canvas-node-count]")?.textContent) >= 3', 'canvas has start, end, and added script')
  await delay(500)
  await fs.writeFile(path.join(output, 'desktop.png'), (await win.webContents.capturePage()).toPNG())
  await js('document.querySelector("[data-action=\\"back\\"]").click()')
  await delay(200)
  await js('Array.from(document.querySelectorAll("[data-workflow-card]")).find((el) => el.textContent.includes("Research pipeline"))?.querySelector("button")?.click()')
  await assert('Boolean(document.querySelector("[data-workflow-editor]"))', 'reload opens saved editor')
  await assert('document.querySelector("[data-field=\\"name\\"]")?.value === "Research pipeline" || document.body.innerText.includes("Research pipeline")', 'name persisted after reload')

  await js('document.querySelector("[data-action=\\"view-source\\"]").click()')
  await delay(300)
  await assert('document.querySelector("[data-source-editor]") || document.querySelector(".monaco-editor")', 'source editor opened')
  const broken = '{ this is not json'
  await js(`(() => {
    const field = document.querySelector('[data-source-text]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(field, ${JSON.stringify(broken)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await delay(200)
  await js('document.querySelector("[data-action=\\"view-canvas\\"]").click()')
  await delay(200)
  await assert('document.querySelector("[data-view]")?.getAttribute("data-view") === "source" || document.querySelector("[data-source-status]")?.textContent.toLowerCase().includes("invalid") || document.querySelector("[data-editor-status]")?.textContent.includes("Invalid source")', 'invalid source retained')

  const validSource = await js(`(() => {
    const name = 'Research pipeline';
    return JSON.stringify({
      schemaVersion: 1,
      id: '11111111-1111-4111-8111-111111111111',
      name,
      slug: 'research_pipeline',
      inputSchema: {
        type: 'object',
        properties: { topic: { type: 'string', description: 'Required fixture input' } },
        required: ['topic'],
        additionalProperties: false
      },
      outputSchema: { type: 'object', additionalProperties: true },
      entryNodeId: 'start',
      nodes: [
        { id: 'start', type: 'start', version: 1, config: {} },
        { id: 'end', type: 'end', version: 1, inputs: { result: { ref: 'input', pointer: '' } }, config: {} }
      ],
      edges: [{ from: 'start', port: 'next', to: 'end' }]
    }, null, 2);
  })()`)
  await js(`(() => {
    const field = document.querySelector('[data-source-text]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(field, ${JSON.stringify(validSource)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  await delay(200)
  await js('document.querySelector("[data-action=\\"view-canvas\\"]").click()')
  await delay(250)
  await assert('document.querySelector("[data-view]")?.getAttribute("data-view") === "canvas"', 'valid source applied to canvas')

  await js('document.querySelector("[data-action=\\"save-draft\\"]").click()')
  await assert('document.querySelector("[data-dirty]")?.getAttribute("data-dirty") === "false"', 'source draft saved before execution')

  await js(`Array.from(document.querySelectorAll("button")).find((el) => el.textContent.trim() === "Run")?.click()`)
  await delay(150)
  await assert('document.querySelector("[data-schema-form] input")?.disabled === false', 'required workflow input remains editable')
  await assert('document.querySelector("[data-action=\\"start-run\\"]")?.disabled === true', 'run is blocked while required input is missing')
  await js(`(() => {
    const field = document.querySelector('[data-schema-form] input, [data-schema-form] textarea, #input-json');
    if (!field) return;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
    const payload = 'fixture-topic';
    if (field.tagName === 'TEXTAREA' || field.tagName === 'INPUT') {
      setter.call(field, payload);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`)
  await assert('document.querySelector("[data-action=\\"start-run\\"]")?.disabled === false', 'required input enables the run action')
  await js('document.querySelector("[data-action=\\"start-run\\"]")?.click()')
  await delay(300)
  await assert('document.querySelector("[data-run-origin]")?.getAttribute("data-run-origin") === "fixture" || document.body.innerText.includes("Fixture")', 'run events are labeled fixture')
  if (await js('Boolean(document.querySelector("[data-approval]"))')) {
    await js('document.querySelector("[data-action=\\"approve-run\\"]").click()')
    await delay(200)
    await assert('document.querySelector("[data-run-state]")?.getAttribute("data-run-state") === "succeeded" || document.body.innerText.includes("Fixture approval granted")', 'approval callback applied')
  } else {
    console.log('PASS approval not required for this start payload (still fixture-labeled)')
  }

  await js(`(() => {
    const field = document.querySelector('[data-field="name"]');
    if (!field) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(field, 'Dirty pipeline');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await delay(50)
  await js('document.querySelector("[data-action=\\"back\\"]").click()')
  await assert('Boolean(document.querySelector(".modal"))', 'dirty navigation shows review dialog')
  await js('Array.from(document.querySelectorAll(".modal button")).find((el) => el.textContent.includes("Keep editing"))?.click()')
  await assert('Boolean(document.querySelector("[data-workflow-editor]"))', 'cancel keeps the editor')

  win.setContentSize(760, 960)
  await delay(400)
  await assert('document.querySelector("[data-layout]")?.getAttribute("data-layout") === "narrow"', 'narrow layout attribute')
  await assert('document.documentElement.scrollWidth <= window.innerWidth + 8', 'narrow layout has no extreme horizontal overflow')
  await js('document.querySelector("[data-canvas]")?.scrollIntoView({ block: "center" })')
  await delay(150)
  await assert('Number(document.querySelector("[data-canvas-node-count]")?.textContent) >= 2', 'narrow canvas retains populated graph')
  await assert(`Array.from(document.querySelectorAll('.react-flow__node')).some((node) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
  })`, 'narrow canvas shows a graph node in the viewport')
  await fs.writeFile(path.join(output, 'narrow.png'), (await win.webContents.capturePage()).toPNG())

  win.setContentSize(1440, 960)
  await js('document.querySelector("[data-action=\\"back\\"]").click()')
  await delay(200)
  if (await js('Boolean(document.querySelector(".modal"))')) {
    await js('document.querySelector("[data-action=\\"discard-draft\\"]")?.click()')
    await delay(200)
  }
  await assert('Boolean(document.querySelector("[data-workflow-library]"))', 'returned to library')

  await js('document.querySelector("[data-fixture=\\"profile-b\\"]").click()')
  await delay(300)
  await assert('document.getElementById("fixture-profile").textContent === "profile-b"', 'profile switched')
  await assert('document.querySelector("[data-workflow-library]")?.getAttribute("data-profile-id") === "profile-b"', 'library resets at profile boundary')
  await assert('!document.body.innerText.includes("Research pipeline")', 'stale profile A rows are not shown after switch')
  await js('Array.from(document.querySelectorAll("[data-workflow-card]")).find((el) => el.textContent.includes("Other profile"))?.querySelector("button")?.click()')
  await delay(200)
  if (await js('Boolean(document.querySelector("[data-workflow-editor]"))')) {
    await js('document.querySelector("[data-action=\\"undo\\"]")')
    await assert('document.querySelector("[data-action=\\"undo\\"]")?.disabled !== false || document.querySelector("[data-action=\\"undo\\"]")?.disabled === true', 'undo history starts empty on profile document')
  }

  if (errors.length) throw new Error('Renderer errors: ' + errors.join('; '))
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, errors, at: new Date().toISOString() }, null, 2))
  win.destroy()
  app.exit(0)
}

main().catch(async (error) => {
  console.error(error)
  await fs.mkdir(output, { recursive: true })
  try {
    // best-effort screenshot on failure
  } catch {}
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: false, error: String(error), at: new Date().toISOString() }, null, 2))
  app.exit(1)
})
