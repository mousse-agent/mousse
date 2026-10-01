import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electron from 'electron'
import { build } from 'esbuild'

// Mount the real composer in Chromium, including its floating/hover menus.
const directory = await mkdtemp(join(tmpdir(), 'mousse-model-picker-'))
try {
  const bundle = await build({
    stdin: {
      resolveDir: new URL('..', import.meta.url).pathname,
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
          { id: 'speed@1m', label: 'Speed Model @ 1m', efforts: ['low', 'high'] },
          { id: 'speed@1m:fast', label: 'Speed Model (fast) @ 1m', efforts: ['low', 'high'] },
          { id: 'speed@1m:slow', label: 'Speed Model (slow) @ 1m', efforts: ['low', 'high'] }
        ] }, { id: 'openai-codex', label: 'OpenAI Subscription', models: [
          { id: 'gpt-subscription', label: 'GPT Subscription', efforts: ['low', 'high'] },
          { id: 'gpt-subscription:fast', label: 'GPT Subscription (fast)', efforts: ['low', 'high'] },
          { id: 'subscription-standard-only', label: 'Subscription Standard Only' }
        ] }]
        window.fixture = { selections: [], modes: [] }
        function Fixture() {
          const [modelId, setModelId] = useState('gpt-test:high')
          const [providerId, setProviderId] = useState('openai')
          const [mode, setMode] = useState('agent')
          const [open, setOpen] = useState(false)
          const [readOnly, setReadOnly] = useState(false)
          window.fixture.setModelId = setModelId
          window.fixture.setProviderId = setProviderId
          window.fixture.setReadOnly = setReadOnly
          return <ComposerFooter chatMode={mode} onChatModeChange={value => {
            window.fixture.modes.push(value); setMode(value)
          }} enabledSkills={[]} providers={providers} selectedProviderId={providerId}
            selectedModelId={modelId} modelReadOnly={readOnly} modelMenuOpen={open} onModelMenuOpenChange={setOpen}
            onModelSelect={(provider, model) => {
              window.fixture.selections.push([provider, model]); setProviderId(provider); setModelId(model); setOpen(false)
            }} onOpenSettings={() => {}} onAttachClick={() => {}} contextOpen={false}
            onContextOpenChange={() => {}} contextUsage={{ percent: 0, used: 0, limit: 1,
              modelName: null, source: 'estimated', categories: [] }} />
        }
        createRoot(document.getElementById('root')).render(<Fixture />)
      `
    },
    bundle: true, platform: 'browser', format: 'iife', write: false,
    jsx: 'automatic', loader: { '.svg': 'dataurl', '.webp': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' }
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
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
    app.whenReady().then(async () => {
      const window = new BrowserWindow({ width: 1000, height: 700, show: false,
        webPreferences: { backgroundThrottling: false } })
      const evaluate = code => window.webContents.executeJavaScript(code)
      const click = async selector => {
        assert(await evaluate('!!document.querySelector(' + JSON.stringify(selector) + ')'), selector)
        await evaluate('document.querySelector(' + JSON.stringify(selector) + ').click()')
        await pause(40)
      }
      const hover = async label => {
        await evaluate('Array.from(document.querySelectorAll(".model-picker-row")).find(row => ' +
          'row.querySelector(".model-picker-row-title").textContent === ' + JSON.stringify(label) +
          ').dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))')
        await pause(40)
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
          assert.equal(await evaluate('!!document.querySelector(".composer-fast-toggle")'), false)
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
          await evaluate('document.querySelector(\'[aria-label="Effort"] button:last-child\').focus()')
          assert.equal(await evaluate('document.activeElement.textContent'), 'High')
          window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
          window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
          window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
          await pause(40)
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
          await evaluate('window.fixture.setModelId("speed@1m:high")')
          await pause(40)
          assert.equal(await evaluate('document.querySelector(".composer-fast-toggle").getAttribute("aria-pressed")'), 'false')
          assert(await evaluate('document.querySelector(".composer-fast-toggle").nextElementSibling.matches(".composer-model-picker")'))
          await click('.composer-fast-toggle')
          assert.deepEqual(await evaluate('window.fixture.selections.at(-1)'), ['openai', 'speed@1m:fast:high'])
          assert.equal(await evaluate('document.querySelector(".composer-fast-toggle").getAttribute("aria-pressed")'), 'true')
          assert.equal(await evaluate('document.querySelector(".composer-model-btn-label").textContent'), 'Speed Model · 1m · High')
          await click('.composer-fast-toggle')
          assert.deepEqual(await evaluate('window.fixture.selections.at(-1)'), ['openai', 'speed@1m:slow:high'])
          assert.equal(await evaluate('document.querySelector(".composer-model-btn-label").textContent'), 'Speed Model · 1m · High')
          await evaluate('window.fixture.setReadOnly(true)')
          await pause(40)
          assert.equal(await evaluate('document.querySelector(".composer-fast-toggle").disabled'), true)
          const selectionCount = await evaluate('window.fixture.selections.length')
          await click('.composer-fast-toggle')
          assert.equal(await evaluate('window.fixture.selections.length'), selectionCount)
          await evaluate('window.fixture.setModelId("plain")')
          await pause(40)
          assert.equal(await evaluate('!!document.querySelector(".composer-fast-toggle")'), false)
          console.log('PASS: ' + platform + ' effort hover choices, current effort, click/keyboard selection, context preservation, and separate mode menu')
          console.log('PASS: ' + platform + ' Fast endpoint toggle visibility, placement, state, endpoint switching, and read-only protection')
          await evaluate('window.fixture.setReadOnly(false); window.fixture.setProviderId("openai-codex"); window.fixture.setModelId("gpt-subscription:high")')
          await pause(40)
          assert.equal(await evaluate('document.querySelector(".composer-fast-toggle").getAttribute("aria-pressed")'), 'false')
          await click('.composer-fast-toggle')
          assert.deepEqual(await evaluate('window.fixture.selections.at(-1)'), ['openai-codex', 'gpt-subscription:fast:high'])
          assert.equal(await evaluate('document.querySelector(".composer-fast-toggle").getAttribute("aria-pressed")'), 'true')
          assert.equal(await evaluate('document.querySelector(".composer-model-btn-label").textContent'), 'GPT Subscription · High')
          await click('.composer-fast-toggle')
          assert.deepEqual(await evaluate('window.fixture.selections.at(-1)'), ['openai-codex', 'gpt-subscription:high'])
          await evaluate('window.fixture.setModelId("subscription-standard-only")')
          await pause(40)
          assert.equal(await evaluate('!!document.querySelector(".composer-fast-toggle")'), false)
          console.log('PASS: ' + platform + ' OpenAI subscription Fast toggle visibility and round-trip effort preservation')
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
  await rm(directory, { recursive: true, force: true })
}
