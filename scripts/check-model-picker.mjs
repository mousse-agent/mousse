import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import { build } from 'esbuild'

// Mount the real composer in Chromium, including its floating/hover menus.
const directory = await mkdtemp(join(tmpdir(), 'mousse-model-picker-'))
try {
  const bundle = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      loader: 'tsx',
      contents: `
        import { useState } from 'react'
        import { createRoot } from 'react-dom/client'
        import { ComposerFooter } from './src/renderer/components/ComposerFooter'
        const providers = [{ id: 'openai', label: 'OpenAI', models: [
          { id: 'gpt-test', label: 'GPT Test', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
          { id: 'gpt-other', label: 'GPT Other', efforts: ['low', 'high'] },
          { id: 'plain', label: 'Plain Model' },
          { id: 'context@200k', label: 'Context Model @ 200k', efforts: ['low', 'high'] },
          { id: 'context@1m', label: 'Context Model @ 1m', efforts: ['low', 'high'] },
          { id: 'quick-model', label: 'Quick Model (fast) @ 1m', efforts: ['low', 'high'] }
        ] }]
        localStorage.clear()
        window.fixture = { selections: [], modes: [] }
        function Fixture() {
          const [modelId, setModelId] = useState('gpt-test:high')
          const [mode, setMode] = useState('agent')
          const [open, setOpen] = useState(false)
          const [readOnly, setReadOnly] = useState(false)
          const [recordingPending, setRecordingPending] = useState(false)
          window.fixture.setModelId = setModelId
          window.fixture.setReadOnly = setReadOnly
          window.fixture.setRecordingPending = setRecordingPending
          return <ComposerFooter chatMode={mode} onChatModeChange={value => {
            window.fixture.modes.push(value); setMode(value)
          }} enabledSkills={[]} providers={providers} selectedProviderId="openai"
            selectedModelId={modelId} modelReadOnly={readOnly} recordingPending={recordingPending} modelMenuOpen={open} onModelMenuOpenChange={setOpen}
            onModelSelect={(provider, model) => {
              window.fixture.selections.push([provider, model]); setModelId(model); setOpen(false)
            }} onOpenSettings={() => {}} onAttachClick={() => {}} contextOpen={false}
            onContextOpenChange={() => {}} contextUsage={{ percent: 0, used: 0, limit: 1,
              modelName: null, source: 'estimated', categories: [] }} />
        }
        createRoot(document.getElementById('root')).render(<Fixture />)
      `
    },
    bundle: true, platform: 'browser', format: 'iife', write: false,
    jsx: 'automatic', loader: { '.svg': 'dataurl', '.webp': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' }, minify: true
  })
  const css = await readFile(new URL('../src/renderer/styles/app.css', import.meta.url), 'utf8')
  await writeFile(join(directory, 'fixture.js'), bundle.outputFiles[0].text)
  await writeFile(join(directory, 'fixture.html'), `<html><head><style>
    :root{--surface-strong-rgb:32,28,39;--surface-base-rgb:23,17,31;--accent-rgb:170,140,200;
      --accent-pale-rgb:200,180,220;--accent-deep-rgb:100,70,130;--text-primary:white;--text-secondary:#ddd}
    body{background:#17111f;color:white;font:14px sans-serif}#root{position:fixed;bottom:30px;left:30px}
    ${css}
  </style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`)
  await writeFile(join(directory, 'check.cjs'), String.raw`
    const assert = require('node:assert/strict')
    const { app, BrowserWindow } = require('electron')
    app.setPath('userData', require('node:path').join(__dirname, 'user-data'))
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
    app.whenReady().then(async () => {
      const window = new BrowserWindow({ width: 1000, height: 700, show: false,
        webPreferences: { backgroundThrottling: false } })
      const evaluate = code => window.webContents.executeJavaScript(code)
      const waitFor = async (condition, message) => {
        const deadline = Date.now() + 2000
        while (!await condition()) {
          assert(Date.now() < deadline, message)
          await pause(20)
        }
      }
      // Hidden Electron windows can suspend animation frames; observe React's DOM instead.
      const settle = () => evaluate('new Promise(resolve => setTimeout(resolve, 30))')
      const click = async selector => {
        assert(await evaluate('!!document.querySelector(' + JSON.stringify(selector) + ')'), selector)
        await evaluate('document.querySelector(' + JSON.stringify(selector) + ').click()')
        await settle()
      }
      const hover = async label => {
        await evaluate('Array.from(document.querySelectorAll(".model-picker-row")).find(row => ' +
          'row.querySelector(".model-picker-row-title").textContent === ' + JSON.stringify(label) +
          ').dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))')
        await waitFor(() => evaluate('Array.from(document.querySelectorAll(".model-picker-row")).find(row => row.querySelector(".model-picker-row-title").textContent === ' + JSON.stringify(label) + ').classList.contains("highlighted")'), 'Hovered row was not highlighted: ' + label)
        await settle()
      }
      // A hidden window sets activeElement without OS focus; dispatch the focusin
      // React receives when a person focuses a control in the visible app.
      const activateFocused = async () => {
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
        window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
        await settle()
      }
      const efforts = () => evaluate('Array.from(document.querySelectorAll(\'[aria-label="Effort"] button\')).map(button => button.textContent)')
      try {
        for (const platform of ['linux', 'win32', 'darwin']) {
          await window.loadFile(require('node:path').join(__dirname, 'fixture.html'))
          await pause(100)
          await evaluate('window.mousse = { platform: ' + JSON.stringify(platform) + ' }; ' +
            'document.documentElement.className = ' + JSON.stringify('platform-' + platform))
          assert.equal(await evaluate('document.querySelector(".composer-pill-btn-label").textContent'), 'Agent')
          assert.equal(await evaluate('document.querySelector(".composer-model-btn-label").textContent'), 'GPT Test · High')
          assert.equal(await evaluate('document.querySelector(".composer-model-btn-name").textContent'), 'GPT Test')
          assert.equal(await evaluate('getComputedStyle(document.querySelector(".composer-model-btn-name")).fontWeight'), '600')
          await click('.composer-pill-btn')
          assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".composer-mode-menu [role=option]")).map(button => button.firstElementChild.textContent)'), ['Plan', 'Agent', 'Build'])
          assert.equal(await evaluate('document.querySelector(".composer-mode-menu").getAttribute("aria-label")'), 'Select chat mode')
          await click('.composer-model-btn')
          await hover('GPT Test')
          assert.deepEqual(await efforts(), ['Low', 'Medium', 'High', 'XHigh', 'Max'])
          assert.equal(await evaluate('document.querySelector(\'[aria-label="Effort"] [aria-pressed="true"]\').textContent'), 'High')
          await click('[aria-label="Effort"] button:first-child')
          assert.deepEqual(await evaluate('window.fixture.selections'), [['openai', 'gpt-test:low']])
          assert.deepEqual(await evaluate('window.fixture.modes'), [])
          assert.equal(await evaluate('document.querySelector(".composer-model-btn-label").textContent'), 'GPT Test · Low')
          await click('.composer-model-btn')
          await hover('GPT Other')
          assert.deepEqual(await efforts(), ['Low', 'High'])
          await evaluate('document.querySelector(\'[aria-label="Effort"] button:last-child\').focus(); if (!document.hasFocus()) document.activeElement.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))')
          assert.equal(await evaluate('document.activeElement.textContent'), 'High')
          await activateFocused()
          assert.deepEqual(await evaluate('window.fixture.selections.at(-1)'), ['openai', 'gpt-other:high'])
          await click('.composer-model-btn')
          await hover('Plain Model')
          assert.equal(await evaluate('!!document.querySelector(".composer-model-variant-panel")'), false)
          await click('.composer-model-btn')
          await evaluate('window.fixture.setModelId("context@1m:low")')
          await pause(40)
          await click('.composer-model-btn')
          await hover('Context Model')
          await click('[aria-label="Effort"] button:last-child')
          assert.deepEqual(await evaluate('window.fixture.selections.at(-1)'), ['openai', 'context@1m:high'])
          await click('.composer-pill-btn')
          await click('.composer-mode-menu button[role=option]:first-of-type')
          assert.deepEqual(await evaluate('window.fixture.modes'), ['plan'])
          assert.deepEqual(await evaluate('window.fixture.selections.at(-1)'), ['openai', 'context@1m:high'])
          await evaluate('window.fixture.setModelId("quick-model:high")')
          await pause(40)
          assert.equal(await evaluate('document.querySelector(".composer-model-btn-label").textContent'), 'Quick Model · 1m · High · Fast')
          assert.equal(await evaluate('!!document.querySelector(".composer-fast-toggle")'), false)
          await click('.composer-model-btn')
          await evaluate('Array.from(document.querySelectorAll(".model-picker-row")).find(row => row.querySelector(".model-picker-row-title").textContent === "GPT Other").querySelector(".model-picker-row-main").focus(); if (!document.hasFocus()) document.activeElement.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))')
          await waitFor(async () => (await efforts()).length > 0, 'Focused model effort choices did not render')
          assert.deepEqual(await efforts(), ['Low', 'High'])
          await activateFocused()
          assert.deepEqual(await evaluate('window.fixture.selections.at(-1)'), ['openai', 'gpt-other:high'])
          await click('.composer-model-btn')
          const selectionCount = await evaluate('window.fixture.selections.length')
          await evaluate('Array.from(document.querySelectorAll(".model-picker-row")).find(row => row.querySelector(".model-picker-row-title").textContent === "GPT Test").querySelector(".model-picker-star").focus(); if (!document.hasFocus()) document.activeElement.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))')
          await activateFocused()
          assert.equal(await evaluate('window.fixture.selections.length'), selectionCount)
          assert(await evaluate('Array.from(document.querySelectorAll(".model-picker-row")).find(row => row.querySelector(".model-picker-row-title").textContent === "GPT Test").querySelector(".model-picker-star").classList.contains("active")'))
          await click('.composer-model-btn')
          await evaluate('window.fixture.setReadOnly(true)')
          await pause(40)
          assert.equal(await evaluate('document.querySelector(".composer-model-btn").disabled'), true)
          await click('.composer-model-btn')
          assert.equal(await evaluate('!!document.querySelector(".model-picker-shell")'), false)
          await evaluate('window.fixture.setRecordingPending(true)')
          await pause(40)
          assert.equal(await evaluate('document.querySelector(\'[aria-label=\"Voice input\"]\').disabled'), true)
          assert.equal(await evaluate('document.querySelector(\'[aria-label=\"Voice input\"]\').getAttribute("aria-busy")'), 'true')
          console.log('PASS: ' + platform + ' effort click/keyboard choices, focused row and favorite activation, context/speed labels, separate mode menu, read-only and recording protection')
        }
      } finally { window.destroy() }
      app.quit()
    }).catch(error => { console.error(error); app.exit(1) })
  `)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(directory, 'check.cjs')], { env, stdio: 'inherit' })
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Model picker check timed out')) }, 30_000)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', code => { clearTimeout(timeout); resolve(code) })
  })
  assert.equal(code, 0, 'Model picker Chromium check failed')
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
