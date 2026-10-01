import { app, BrowserWindow, ipcMain } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { GuiMmsController } from '../../../../src/main/mms/GuiMmsController'

interface Config {
  home: string; endpoint: string; ownerToken: string; profileId: string; url: string; preload: string
  providerId: string; providerLabel: string; modelId: string; modelLabel: string
  phase: 'edit' | 'run'; agentId?: string; evidence: string; exportPath: string; userData: string
}
const config = JSON.parse(readFileSync(process.env.MOUSSE_EDITOR_CROSS_CONFIG!, 'utf8')) as Config
app.setPath('userData', config.userData)
app.disableHardwareAcceleration()
let stage = 'startup'
const timeout = setTimeout(() => {
  writeFileSync(config.evidence, JSON.stringify({ ok: false, message: `Timed out during ${stage}` }))
  app.exit(2)
}, 90_000); timeout.unref()
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function run(): Promise<void> {
  await app.whenReady()
  process.env.MOUSSE_EDITOR_CROSS_CONFIG_JSON = JSON.stringify({ profileId: config.profileId,
    providerId: config.providerId, providerLabel: config.providerLabel, modelId: config.modelId,
    modelLabel: config.modelLabel, phase: config.phase, agentId: config.agentId })
  const gui = new GuiMmsController({ homeDir: config.home, endpointOverride: config.endpoint,
    ownerTokenOverride: config.ownerToken, disableAutoStart: true, requestTimeoutMs: 45_000 })
  gui.on('error', () => {})
  const win = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: {
    preload: config.preload, sandbox: false, contextIsolation: true, nodeIntegration: false,
    backgroundThrottling: false, offscreen: true
  } })
  const errors: string[] = []
  let lastTryRun: Promise<unknown> | undefined
  win.webContents.on('console-message', (event) => {
    const details = event
    if (details.level !== 'error' || /monaco|worker|ResizeObserver|Canceled/i.test(details.message)) return
    errors.push(details.message)
  })
  ipcMain.handle('editor-cross:request', (event, payload: { method: string; params?: unknown }) => {
    const request = gui.runWithSender(event.sender, () => gui.request(payload.method, payload.params))
    if (payload.method === 'agentDefinitions.tryRun') lastTryRun = Promise.resolve(request)
    return request
  })
  let downloadDone: Promise<void> | undefined
  win.webContents.session.on('will-download', (_event, item) => {
    item.setSavePath(config.exportPath)
    downloadDone = new Promise((resolve, reject) => item.once('done', (_done, state) => {
      if (state === 'completed') resolve()
      else reject(new Error(`Workflow export ended as ${state}`))
    }))
  })
  const js = <T,>(source: string): Promise<T> => win.webContents.executeJavaScript(source) as Promise<T>
  const waitFor = async (source: string, label: string, attempts = 100): Promise<void> => {
    stage = label
    for (let i = 0; i < attempts; i += 1) {
      try { if (await js(source)) return } catch (error) {
        throw new Error(`Probe failed: ${label}; source=${source}; destroyed=${win.webContents.isDestroyed()}; crashed=${win.webContents.isCrashed()}; ${String(error)}`)
      }
      await delay(75)
    }
    throw new Error(`Timed out: ${label}; url=${win.webContents.getURL()}; body=${await js('document.body.innerText').catch(() => '')}; errors=${errors.join('; ')}`)
  }
  const input = async (selector: string, value: string): Promise<void> => {
    stage = `input ${selector}`
    await js(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el)return false;
      const p=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(p,'value').set.call(el,${JSON.stringify(value)});
      el.dispatchEvent(new Event('input',{bubbles:true})); return true })()`)
  }
  const click = (selector: string) => { stage = `click ${selector}`; return js(`document.querySelector(${JSON.stringify(selector)})?.click()`) }
  try {
    await gui.start(); await gui.prepareWindow(win.webContents); await win.loadURL(config.url)
    await waitFor(config.phase === 'edit' ? 'Boolean(document.querySelector("[data-agent-library]"))' : 'Boolean(document.querySelector("[data-run-fixture]"))', config.phase === 'edit' ? 'agent library' : 'persisted run fixture')
    if (config.phase === 'edit') {
      await click('[data-action="new-agent"]')
      await waitFor('Boolean(document.querySelector("[data-agent-editor]"))', 'agent editor')
      await input('[data-field="name"]', 'Renderer production agent')
      await click('[data-model-picker="/settings/primaryModel"] button[aria-haspopup="listbox"]')
      await waitFor('Boolean(document.querySelector("[role=option]"))', 'model menu')
      await js(`document.querySelector('[role=option]')?.click()`)
      await click('[aria-label="Next orb palette"]')
      await waitFor('Boolean(document.querySelector(".monaco-editor textarea"))', 'prompt Monaco')
      const prompt = '# Exact renderer prompt\n\nPreserve  two spaces.'
      await js(`document.querySelector('.monaco-editor').scrollIntoView({block:'center'})`); await delay(75)
      const editorPoint = await js<{ x: number; y: number }>(`(() => { const r=document.querySelector('.monaco-editor').getBoundingClientRect();
        return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+Math.min(40,r.height/2))} })()`)
      for (let attempt = 0; attempt < 1; attempt += 1) {
        win.webContents.focus()
        await js(`document.querySelector('.monaco-editor textarea')?.focus()`)
        win.webContents.sendInputEvent({ type: 'mouseMove', x: editorPoint.x, y: editorPoint.y })
        win.webContents.sendInputEvent({ type: 'mouseDown', x: editorPoint.x, y: editorPoint.y, button: 'left', clickCount: 1 })
        win.webContents.sendInputEvent({ type: 'mouseUp', x: editorPoint.x, y: editorPoint.y, button: 'left', clickCount: 1 })
        await delay(75)
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] })
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] })
        await win.webContents.insertText(prompt); await delay(150)
      }
      await waitFor('document.querySelector("[aria-label=\\"Agent appearance\\"]")?.tagName === "SECTION"', 'accessible agent appearance')
      await click('[data-action="save-draft"]')
      await waitFor('document.querySelector("[data-action=publish]")?.disabled === false', 'agent save')
      await click('[data-action="publish"]')
      await waitFor('document.querySelector("[data-editor-status]")?.textContent.includes("Published")', 'agent publish')
      await delay(100)
      const agentRows = await gui.runWithSender(win.webContents, () => gui.request<Array<{ id: string; name: string }>>('agentDefinitions.list', { profileId: config.profileId }))
      const agentId = agentRows.find((row) => row.name === 'Renderer production agent')?.id
      if (!agentId) throw new Error('Published renderer agent was not persisted')
      const storedAgent = await gui.runWithSender(win.webContents, () => gui.request<{ visual?: { palette?: string } }>('agentDefinitions.get', { profileId: config.profileId, id: agentId }))
      const palette = storedAgent.visual?.palette
      const appearanceAccessible = true
      await click('[data-fixture="workflows"]')
      await waitFor('Boolean(document.querySelector("[data-workflow-library]"))', 'workflow library')
      await click('[data-action="new-workflow"]')
      await waitFor('Boolean(document.querySelector("[data-template=blank]"))', 'template picker')
      await click('[data-template="blank"]')
      await waitFor('Boolean(document.querySelector("[data-workflow-editor]"))', 'workflow editor')
      await click('[data-action="auto-layout"]'); await click('[data-action="view-source"]')
      await waitFor('Boolean(document.querySelector("[data-source-text]"))', 'workflow source')
      const raw = await js<string>('document.querySelector("[data-source-text]").value')
      const manifest = JSON.parse(raw); manifest.name = 'Renderer production workflow'; manifest.slug = 'renderer-production-workflow'
      await input('[data-source-text]', JSON.stringify(manifest, null, 2))
      await click('[data-action="view-canvas"]'); await delay(150)
      await click('[data-action="save-draft"]')
      await waitFor('document.querySelector("[data-action=publish]")?.disabled === false', 'workflow save')
      await click('[data-action="publish"]')
      await waitFor('document.querySelector("[data-editor-status]")?.textContent.includes("Published")', 'workflow publish')
      const workflowId = await js<string>('document.querySelector("[data-workflow-editor]").getAttribute("data-definition-id")')
      const semantic = await js<string>('document.querySelector("[data-semantic-identity]").textContent')
      await click('[aria-label="Export workflow"]')
      for (let i = 0; i < 100 && !downloadDone; i += 1) await delay(25)
      if (!downloadDone) throw new Error('Workflow export did not start')
      await downloadDone
      if (!existsSync(config.exportPath)) throw new Error('Completed workflow export is missing')
      await click('[data-action="back"]'); await waitFor('Boolean(document.querySelector("[data-workflow-library]"))', 'workflow library after export')
      stage = 'workflow file selection'
      win.webContents.debugger.attach('1.3')
      const document = await win.webContents.debugger.sendCommand('DOM.getDocument') as { root: { nodeId: number } }
      const selected = await win.webContents.debugger.sendCommand('DOM.querySelector', {
        nodeId: document.root.nodeId, selector: 'input[type=file]'
      }) as { nodeId: number }
      await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId: selected.nodeId, files: [config.exportPath] })
      win.webContents.debugger.detach()
      stage = 'workflow import'
      let importedId = ''
      for (let i = 0; i < 100; i += 1) {
        const rows = await gui.runWithSender(win.webContents, () => gui.request<Array<{ id: string }>>('workflows.list', { profileId: config.profileId }))
        importedId = rows.find((row) => row.id !== workflowId)?.id ?? ''
        if (importedId) break
        await delay(50)
      }
      if (!importedId) throw new Error('UI import did not persist a second workflow: ' + await js(`document.querySelector('[data-import-error]')?.textContent ?? document.body.innerText`))
      writeFileSync(config.evidence, JSON.stringify({ ok: true, agentId, prompt, palette, appearanceAccessible, workflowId, importedId, semantic }))
    } else {
      const prompt = 'Run through the production renderer bridge.'
      const palette = JSON.parse(await js<string>('document.querySelector("#appearance-value").textContent')).palette
      await input('[data-field="try-run-prompt"]', prompt); await click('[data-action="try-run"]')
      stage = 'native try run'
      for (let i = 0; i < 100 && !lastTryRun; i += 1) await delay(25)
      if (!lastTryRun) throw new Error('Try-run button did not dispatch through IPC')
      const result = await lastTryRun as { status?: string; summary?: string; runId?: string; threadId?: string }
      if (result.status !== 'completed') throw new Error('Try run did not complete: ' + JSON.stringify(result))
      writeFileSync(config.evidence, JSON.stringify({ ok: true, prompt,
        agentId: await js('document.querySelector("[data-agent-summary]").getAttribute("data-agent-summary")'),
        palette, summary: result.summary, runId: result.runId, threadId: result.threadId }))
    }
    if (errors.length) throw new Error('Renderer errors: ' + errors.join('; '))
  } finally {
    ipcMain.removeHandler('editor-cross:request'); await gui.stop(); if (!win.isDestroyed()) win.destroy()
  }
}
void run().then(() => { clearTimeout(timeout); app.exit(0) }, (error) => {
  writeFileSync(config.evidence, JSON.stringify({ ok: false, stage, message: String(error), stack: error?.stack }))
  process.stderr.write(`stage=${stage}\n${String(error?.stack ?? error)}\n`); app.exit(1)
})
