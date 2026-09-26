import { app, BrowserWindow } from 'electron'
import { createServer, type AddressInfo } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { ElectronAttachedBrowserBackend } from '../../../../src/main/browser/automation/backend'
import { TrustedGuestRegistry } from '../../../../src/main/browser/automation/registry'
import { wrapElectronWebContents } from '../../../../src/main/browser/automation/electronGuest'
import { createLoopbackAttachedPolicy } from '../../../../src/main/browser/automation/policy'
import { profileBrowserPartition } from '../../../../src/main/browser/browserPolicy'
import { createFilesystemArtifactPort } from '../../../../src/mms/browser/defaultPorts'
import type { BrowserJournalPort } from '../../../../src/mms/browser/ports'
import type { BrowserActionResult, BrowserObservation, BrowserSessionRecord, BrowserWorkerRequest } from '../../../../src/shared/browser/types'

const evidencePath = process.env.MOUSSE_ATTACHED_EVIDENCE
const artifactRoot = process.env.MOUSSE_ATTACHED_ARTIFACTS
const userData = process.env.MOUSSE_ATTACHED_USER_DATA
const hostHtml = process.env.MOUSSE_ATTACHED_HOST_HTML
const pageHtml = process.env.MOUSSE_ATTACHED_PAGE_HTML

if (!evidencePath || !artifactRoot || !userData || !hostHtml || !pageHtml) {
  process.stderr.write('Attached electron fixture requires evidence, artifact, user-data, host, and page paths\n')
  process.exit(1)
}

app.setPath('userData', userData)
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('in-process-gpu')
setTimeout(() => {
  process.stderr.write('Attached electron fixture timed out\n')
  app.exit(1)
}, 90_000).unref()

function request(profileId: string, method: BrowserWorkerRequest['method'], params: Record<string, unknown>): BrowserWorkerRequest {
  return { version: 1, id: 'id_' + randomUUID(), profileId, method, params }
}

function memoryJournal(): BrowserJournalPort & { records: unknown[] } {
  const records: unknown[] = []
  return {
    records,
    append(record) { records.push(record) }
  }
}

async function startSite(): Promise<{ origin: string; close: () => Promise<void>; submitCount: () => number }> {
  let submits = 0
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'POST' && url.pathname === '/submit-once') {
      submits += 1
      res.statusCode = 200
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end('accepted')
      return
    }
    if (url.pathname === '/page.html' || url.pathname === '/') {
      res.statusCode = 200
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(readFileSync(pageHtml))
      return
    }
    if (url.pathname === '/other.html') {
      res.statusCode = 200
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end('<!doctype html><title>Other</title><p>navigated</p>')
      return
    }
    res.statusCode = 404
    res.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    submitCount: () => submits
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor<T>(read: () => Promise<T> | T, accept: (value: T) => boolean, label: string): Promise<T> {
  for (let index = 0; index < 80; index += 1) {
    const value = await read()
    if (accept(value)) return value
    await delay(100)
  }
  throw new Error(`Timed out: ${label}`)
}

function named(observation: BrowserObservation, name: string, role?: string) {
  const matches = observation.elements.filter((element) => (element.name ?? '').includes(name) || (element.text ?? '').includes(name) || element.role === name)
  const match = role ? matches.find((element) => element.role === role) ?? matches[0] : matches[0]
  if (!match) throw new Error(`missing ${name}: ${observation.elements.map((el) => `${el.role}:${el.name}`).join(' | ')}`)
  return match
}

async function main(): Promise<void> {
  mkdirSync(userData, { recursive: true })
  mkdirSync(artifactRoot, { recursive: true })
  const site = await startSite()
  await app.whenReady()
  const profileId = 'prof_attached'
  const profileEpoch = 'epoch_1'
  const uiTabId = 'uitab_live'
  const threadId = 'thread_live'
  const partition = profileBrowserPartition(profileId)
  const journal = memoryJournal()
  let holdCommand: ((release: () => void) => void) | null = null
  let holdPromise: Promise<void> | null = null
  let markHoldStarted: (() => void) | null = null

  const registry = new TrustedGuestRegistry({
    expectedPartition: profileBrowserPartition,
    ownerBinding: ({ profileId: boundProfile, profileEpoch: boundEpoch, uiTabId: boundTab }) =>
      boundProfile === profileId && boundEpoch === profileEpoch && boundTab === uiTabId
  })
  const backend = new ElectronAttachedBrowserBackend({
    registry,
    policy: createLoopbackAttachedPolicy(),
    journal,
    artifacts: createFilesystemArtifactPort(artifactRoot),
    browserVersion: process.versions.chrome,
    interceptCommand: async (method) => {
      if (holdCommand && (method === 'Input.dispatchMouseEvent' || method === 'DOM.getContentQuads')) {
        markHoldStarted?.()
        holdPromise = holdPromise ?? new Promise<void>((resolve) => holdCommand?.(resolve))
        await holdPromise
      }
    }
  })

  const host = new BrowserWindow({
    show: false,
    // Input must work without OS focus; CI and background tabs cannot own it.
    focusable: false,
    width: 1280,
    height: 720,
    webPreferences: {
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Hidden CI hosts still need an active compositor for raw CDP input.
      backgroundThrottling: false
    }
  })
  host.webContents.on('will-attach-webview', (_event, webPreferences) => {
    delete webPreferences.preload
    webPreferences.partition = partition
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.javascript = true
    webPreferences.backgroundThrottling = false
  })
  let guestContents: Electron.WebContents | null = null
  const attached = new Promise<Electron.WebContents>((resolve, reject) => {
    host.webContents.on('did-attach-webview', (_event, guest) => {
      guestContents = guest
      registry.registerGuest({
        guest: wrapElectronWebContents(guest),
        owner: wrapElectronWebContents(host.webContents),
        profileId,
        profileEpoch,
        uiTabId,
        thread: { kind: 'thread', threadId }
      })
      guest.once('did-finish-load', () => resolve(guest))
      guest.once('did-fail-load', (_event, code, description, url, mainFrame) => {
        if (mainFrame) reject(new Error(`Fixture guest navigation failed (${code}): ${description}: ${url}`))
      })
    })
  })
  // Give the webview its actual initial destination. An about:blank navigation
  // still pending at attachment can otherwise overtake a subsequent loadURL.
  const initialHost = readFileSync(hostHtml, 'utf8').replace('src="about:blank"', `src="${site.origin}/page.html"`)
  await host.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(initialHost))
  const guest = await attached
  if (guest.getURL() !== site.origin + '/page.html') throw new Error('Attached guest loaded an unexpected fixture URL: ' + guest.getURL())
  if (await guest.executeJavaScript('document.readyState') !== 'complete') throw new Error('Attached fixture document did not finish loading')

  const opened = await backend.call(request(profileId, 'session.open', { uiTabId, threadId }))
  if (!opened.ok) throw new Error('session.open failed: ' + opened.error?.message)
  const payload = opened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
  const session = payload.session
  const name = named(payload.observation, 'Name', 'textbox')
  const filled = await backend.call(request(profileId, 'act', {
    requestId: 'fill_name',
    sessionId: session.id,
    tabId: payload.observation.tabId,
    generation: session.generation,
    observationId: payload.observation.observationId,
    controlLeaseId: session.controlLeaseId,
    timeoutMs: 10_000,
    action: { type: 'fill', target: { kind: 'ref', ref: name.ref }, text: 'Ada' }
  }))
  if (!filled.ok) {
    const state = await guest.executeJavaScript('({visibility:document.visibilityState,focused:document.hasFocus(),active:document.activeElement?.id,name:document.getElementById("name").value})')
    throw new Error('fill failed: ' + filled.error?.message + '; fixture state=' + JSON.stringify(state))
  }
  const liveName = await guest.executeJavaScript('document.getElementById("name").value') as string
  const afterFill = (filled.result as BrowserActionResult).observation ?? payload.observation
  const save = named(afterFill, 'Save', 'button')
  const clicked = await backend.call(request(profileId, 'act', {
    requestId: 'click_save',
    sessionId: session.id,
    tabId: afterFill.tabId,
    generation: afterFill.generation,
    observationId: afterFill.observationId,
    controlLeaseId: session.controlLeaseId,
    timeoutMs: 10_000,
    action: { type: 'click', target: { kind: 'ref', ref: save.ref } },
    expected: { type: 'text', text: 'saved:Ada:pwlen=0', present: true }
  }))
  if (!clicked.ok) throw new Error('save click failed: ' + clicked.error?.message)
  const liveResult = await guest.executeJavaScript('document.getElementById("result").textContent') as string
  const afterSave = (clicked.result as BrowserActionResult).observation!
  const submit = named(afterSave, 'Submit once', 'button')
  const posted = await backend.call(request(profileId, 'act', {
    requestId: 'click_submit',
    sessionId: session.id,
    tabId: afterSave.tabId,
    generation: afterSave.generation,
    observationId: afterSave.observationId,
    controlLeaseId: session.controlLeaseId,
    timeoutMs: 10_000,
    action: { type: 'click', target: { kind: 'ref', ref: submit.ref } },
    expected: { type: 'text', text: 'submitted', present: true }
  }))
  if (!posted.ok) throw new Error('submit click failed: ' + posted.error?.message)
  await waitFor(() => site.submitCount(), (count) => count === 1, 'one POST')
  const cookie = await guest.executeJavaScript('document.cookie') as string
  const formStillAda = await guest.executeJavaScript('document.getElementById("name").value') as string

  const afterPost = (posted.result as BrowserActionResult).observation!
  let releaseHold: () => void = () => undefined
  const holdStarted = new Promise<void>((resolve) => { markHoldStarted = resolve })
  holdCommand = (release) => { releaseHold = release }
  holdPromise = null
  const held = backend.call(request(profileId, 'act', {
    requestId: 'held_click',
    sessionId: session.id,
    tabId: afterPost.tabId,
    generation: afterPost.generation,
    observationId: afterPost.observationId,
    controlLeaseId: session.controlLeaseId,
    timeoutMs: 15_000,
    action: { type: 'click', target: { kind: 'ref', ref: named(afterPost, 'Submit once', 'button').ref } }
  }))
  await Promise.race([
    holdStarted,
    delay(10_000).then(() => { throw new Error('held click did not reach the debugger transport') })
  ])
  const takeover = await backend.call(request(profileId, 'control.take', { sessionId: session.id, owner: 'human' }))
  if (!takeover.ok) throw new Error('takeover failed: ' + takeover.error?.message)
  const takeoverState = takeover.result as { controlLeaseId: string; generation: number }
  releaseHold()
  const heldResult = await held
  const postsAfterHold = site.submitCount()
  const staleAct = await backend.call(request(profileId, 'act', {
    requestId: 'stale_after_takeover',
    sessionId: session.id,
    tabId: afterPost.tabId,
    generation: afterPost.generation,
    observationId: afterPost.observationId,
    controlLeaseId: session.controlLeaseId,
    action: { type: 'click', target: { kind: 'ref', ref: named(afterPost, 'Submit once', 'button').ref } }
  }))
  await guest.executeJavaScript('document.getElementById("name").value = "Human"')
  const release = await backend.call(request(profileId, 'control.release', {
    sessionId: session.id,
    controlLeaseId: takeoverState.controlLeaseId
  }))
  if (!release.ok) throw new Error('release failed: ' + release.error?.message)
  const staleAfterHuman = await backend.call(request(profileId, 'act', {
    requestId: 'stale_after_human',
    sessionId: session.id,
    tabId: afterPost.tabId,
    generation: afterPost.generation,
    observationId: afterPost.observationId,
    controlLeaseId: takeoverState.controlLeaseId,
    action: { type: 'fill', target: { kind: 'ref', ref: name.ref }, text: 'X' }
  }))
  const unsupported = await backend.call(request(profileId, 'tabs.new', { sessionId: session.id }))
  const fresh = await backend.call(request(profileId, 'observe', { sessionId: session.id, includeScreenshot: true }))
  if (!fresh.ok) throw new Error('fresh observe failed: ' + fresh.error?.message)
  const freshObs = fresh.result as BrowserObservation
  const screenshot = Boolean(
    freshObs.viewport.cssWidth > 0
    && freshObs.viewport.deviceScaleFactor > 0
    && (freshObs.screenshot?.artifactId
      ? freshObs.screenshot.cssToImageScaleX > 0 && freshObs.screenshot.pixelWidth > 0
      : freshObs.warnings.includes('screenshot-unavailable'))
  )

  await guest.loadURL(site.origin + '/other.html')
  await waitFor(() => guest.getURL(), (url) => url.includes('/other.html'), 'guest navigated')
  const staleNav = await backend.call(request(profileId, 'act', {
    requestId: 'stale_nav',
    sessionId: session.id,
    tabId: freshObs.tabId,
    generation: freshObs.generation,
    observationId: freshObs.observationId,
    controlLeaseId: takeoverState.controlLeaseId,
    action: { type: 'click', target: { kind: 'ref', ref: named(freshObs, 'Submit once', 'button').ref } }
  }))

  backend.revokeProfileEpoch(profileId, 'epoch_2')
  const staleEpoch = await backend.call(request(profileId, 'observe', { sessionId: session.id }))

  const guestAliveBeforeClose = !guest.isDestroyed()
  const closed = await backend.call(request(profileId, 'session.close', { sessionId: session.id }))
  const guestAliveAfterClose = !guest.isDestroyed() && guest.getURL().includes('http://127.0.0.1')

  holdCommand = null
  holdPromise = null
  markHoldStarted = null
  const evidence = {
    passed: true,
    liveName,
    liveResult,
    formStillAda,
    cookie,
    posts: site.submitCount(),
    postsAfterHold,
    heldOk: heldResult.ok,
    heldOutcome: (heldResult.result as BrowserActionResult | undefined)?.outcome ?? heldResult.error?.code,
    staleActCode: staleAct.error?.code ?? null,
    staleAfterHumanCode: staleAfterHuman.error?.code ?? null,
    screenshot,
    viewport: freshObs.viewport,
    staleNavCode: staleNav.error?.code ?? (staleNav.ok ? 'unexpected-ok' : null),
    staleEpochCode: staleEpoch.error?.code ?? null,
    guestAliveBeforeClose,
    guestAliveAfterClose,
    closeOk: closed.ok,
    unsupportedCode: unsupported.error?.code ?? null,
    capabilities: backend.capabilities()
  }
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2))
  host.destroy()
  await site.close()
  app.exit(0)
}

main().catch((error) => {
  try {
    writeFileSync(evidencePath, JSON.stringify({
      passed: false,
      error: error instanceof Error ? error.stack ?? error.message : String(error)
    }, null, 2))
  } catch { /* ignore */ }
  process.stderr.write((error instanceof Error ? error.stack ?? error.message : String(error)) + '\n')
  app.exit(1)
})
