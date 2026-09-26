import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import electron from 'electron'
import { build } from 'esbuild'
import type { BrowserActionResult, BrowserObservation, BrowserSessionRecord, BrowserWorkerRequest } from '../src/shared/browser/types'
import { ElectronAttachedBrowserBackend } from '../src/main/browser/automation/backend'
import { TrustedGuestRegistry } from '../src/main/browser/automation/registry'
import { createFailClosedAttachedPolicy, createLoopbackAttachedPolicy } from '../src/main/browser/automation/policy'
import { profileBrowserPartition } from '../src/main/browser/browserPolicy'
import { createFilesystemArtifactPort } from '../src/mms/browser/defaultPorts'
import type { BrowserJournalPort } from '../src/mms/browser/ports'
import { createFakeGuestPair } from './fixtures/agent-platform/electron-attached-browser/fakeGuest'
import { makeAttachedTempRoot, removeOwnedTempRoot } from './fixtures/agent-platform/electron-attached-browser/ownedTemp'

const profileId = 'prof_attached'
const uiTabId = 'uitab_1'
const threadId = 'thread_1'
const profileEpoch = 'epoch_1'
const ownedRoots: string[] = []

function req(method: BrowserWorkerRequest['method'], params: Record<string, unknown>, id = 'id_' + randomUUID()): BrowserWorkerRequest {
  return { version: 1, id, profileId, method, params }
}

function memoryJournal(): BrowserJournalPort & { records: unknown[] } {
  const records: unknown[] = []
  return { records, append(record) { records.push(record) } }
}

function registerPair(registry: TrustedGuestRegistry, extra?: { unbound?: boolean; partition?: string; epoch?: string; binding?: boolean }) {
  const pair = createFakeGuestPair({ profileId, partition: extra?.partition })
  registry.registerGuest({
    guest: pair.guest,
    owner: pair.owner,
    profileId,
    profileEpoch: extra?.epoch ?? profileEpoch,
    uiTabId,
    thread: extra?.unbound ? { kind: 'unbound' } : { kind: 'thread', threadId }
  })
  return pair
}

async function openSession(backend: ElectronAttachedBrowserBackend) {
  const opened = await backend.call(req('session.open', { uiTabId, threadId }))
  expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
  return opened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
}

afterEach(() => {
  while (ownedRoots.length) {
    const root = ownedRoots.pop()
    if (root) removeOwnedTempRoot(root)
  }
})

describe('ElectronAttachedBrowserBackend fake-port races', () => {
  it('reuses its own debugger session on repeated opens and respects human takeover', async () => {
    const registry = new TrustedGuestRegistry({ ownerBinding: () => true })
    registerPair(registry)
    const backend = new ElectronAttachedBrowserBackend({ registry, policy: createLoopbackAttachedPolicy(), journal: memoryJournal() })
    const [first, again] = await Promise.all([openSession(backend), openSession(backend)])
    expect(again.session.id).toBe(first.session.id)
    expect(again.observation.elements.length).toBeGreaterThan(0)
    const takeover = await backend.call(req('control.take', { sessionId: first.session.id, owner: 'human' }))
    expect(takeover.ok).toBe(true)
    const denied = await backend.call(req('session.open', { uiTabId, threadId }))
    expect(denied.error?.code).toBe('human_controlled')
    await backend.shutdown()
  })

  it('does not treat a renderer webContentsId as ownership', async () => {
    const registry = new TrustedGuestRegistry({
      ownerBinding: () => true
    })
    expect((registry as unknown as { registerByWebContentsId?: unknown }).registerByWebContentsId).toBeUndefined()
    const backend = new ElectronAttachedBrowserBackend({
      registry,
      policy: createLoopbackAttachedPolicy(),
      journal: memoryJournal()
    })
    const opened = await backend.call(req('session.open', { webContentsId: 99, uiTabId: 'missing_tab', threadId }))
    expect(opened.ok).toBe(false)
    expect(opened.error?.code).toMatch(/session_closed|invalid_action/)
  })

  it('does not let a second window replace a trusted ui tab id or rebind a pinned thread', () => {
    const registry = new TrustedGuestRegistry({ ownerBinding: () => true })
    registerPair(registry)
    const other = createFakeGuestPair({ profileId })
    expect(() => registry.registerGuest({
      guest: other.guest,
      owner: other.owner,
      profileId,
      profileEpoch,
      uiTabId,
      thread: { kind: 'thread', threadId: 'thread_2' }
    })).toThrow(/another window/)
    expect(() => registry.assignThread(uiTabId, 'thread_2')).toThrow(/already bound/)
    expect(registry.descriptorOf(uiTabId).thread).toEqual({ kind: 'thread', threadId })
  })

  it('fails closed on host, partition, epoch, owner-binding, and unbound-tab mismatches', async () => {
    const owner = createFakeGuestPair({ profileId })
    const registry = new TrustedGuestRegistry({
      ownerBinding: () => false
    })
    expect(() => registry.registerGuest({
      guest: owner.guest,
      owner: createFakeGuestPair({ profileId }).owner,
      profileId,
      profileEpoch,
      uiTabId,
      thread: { kind: 'thread', threadId }
    })).toThrow(/hostWebContents|trusted owner/)

    const matching = createFakeGuestPair({ profileId, partition: 'persist:wrong' })
    const okRegistry = new TrustedGuestRegistry({ ownerBinding: () => true })
    expect(() => okRegistry.registerGuest({
      guest: matching.guest,
      owner: matching.owner,
      profileId,
      profileEpoch,
      uiTabId,
      thread: { kind: 'thread', threadId }
    })).toThrow(/partition/)

    const bound = new TrustedGuestRegistry({ ownerBinding: () => false })
    const pair = createFakeGuestPair({ profileId })
    bound.registerGuest({
      guest: pair.guest,
      owner: pair.owner,
      profileId,
      profileEpoch,
      uiTabId,
      thread: { kind: 'thread', threadId }
    })
    const backend = new ElectronAttachedBrowserBackend({
      registry: bound,
      policy: createLoopbackAttachedPolicy(),
      journal: memoryJournal()
    })
    const denied = await backend.call(req('session.open', { uiTabId, threadId }))
    expect(denied.ok).toBe(false)
    expect(denied.error?.code).toBe('policy_denied')

    const unboundReg = new TrustedGuestRegistry({ ownerBinding: () => true })
    const unbound = createFakeGuestPair({ profileId })
    unboundReg.registerGuest({
      guest: unbound.guest,
      owner: unbound.owner,
      profileId,
      profileEpoch,
      uiTabId: 'uitab_unbound',
      thread: { kind: 'unbound' }
    })
    const unboundBackend = new ElectronAttachedBrowserBackend({
      registry: unboundReg,
      policy: createLoopbackAttachedPolicy(),
      journal: memoryJournal()
    })
    const unboundOpen = await unboundBackend.call(req('session.open', { uiTabId: 'uitab_unbound', threadId }))
    expect(unboundOpen.ok).toBe(false)
    expect(unboundOpen.error?.code).toBe('policy_denied')
    unboundReg.assignThread('uitab_unbound', threadId)
    const assigned = await unboundBackend.call(req('session.open', { uiTabId: 'uitab_unbound', threadId }))
    expect(assigned.ok, JSON.stringify(assigned.error)).toBe(true)
  })

  it('does not navigate on attach unless a URL is explicitly requested', async () => {
    const registry = new TrustedGuestRegistry({ ownerBinding: () => true })
    const pair = registerPair(registry)
    const backend = new ElectronAttachedBrowserBackend({
      registry,
      policy: createLoopbackAttachedPolicy(),
      journal: memoryJournal()
    })
    const opened = await openSession(backend)
    expect(pair.page.url).toContain('page.html')
    expect(opened.observation.url).toContain('page.html')
    expect(opened.session.backend).toBe('electron-attached')
  })

  it('returns unsupported for tabs.new/close and fail-closed policy by default', async () => {
    const registry = new TrustedGuestRegistry({ ownerBinding: () => true })
    registerPair(registry)
    const closedPolicy = new ElectronAttachedBrowserBackend({
      registry,
      policy: createFailClosedAttachedPolicy(),
      journal: memoryJournal()
    })
    const denied = await closedPolicy.call(req('session.open', { uiTabId, threadId }))
    expect(denied.ok).toBe(false)
    expect(denied.error?.code).toBe('policy_denied')

    const backend = new ElectronAttachedBrowserBackend({
      registry,
      policy: createLoopbackAttachedPolicy(),
      journal: memoryJournal()
    })
    const opened = await openSession(backend)
    const created = await backend.call(req('tabs.new', { sessionId: opened.session.id }))
    expect(created.ok).toBe(false)
    expect(created.error?.code).toBe('unsupported')
    const closed = await backend.call(req('tabs.close', { sessionId: opened.session.id, tabId: opened.observation.tabId }))
    expect(closed.ok).toBe(false)
    expect(closed.error?.code).toBe('unsupported')
  })

  it('omits screenshots when no artifact writer is injected', async () => {
    const registry = new TrustedGuestRegistry({ ownerBinding: () => true })
    registerPair(registry)
    const backend = new ElectronAttachedBrowserBackend({
      registry,
      policy: createLoopbackAttachedPolicy(),
      journal: memoryJournal()
    })
    const opened = await openSession(backend)
    const observed = await backend.call(req('observe', { sessionId: opened.session.id, includeScreenshot: true }))
    expect(observed.ok).toBe(true)
    const observation = observed.result as BrowserObservation
    expect(observation.screenshot).toBeUndefined()
    expect(observation.warnings).toContain('screenshot-unavailable')
    expect(JSON.stringify(observation)).not.toContain('data:image')
    expect(backend.capabilities().capabilities.screenshots).toBe(false)
  })

  it('fills and clicks through a fake existing tab without destroying it on close', async () => {
    const registry = new TrustedGuestRegistry({ ownerBinding: () => true })
    const pair = registerPair(registry)
    const backend = new ElectronAttachedBrowserBackend({
      registry,
      policy: createLoopbackAttachedPolicy(),
      journal: memoryJournal()
    })
    const opened = await openSession(backend)
    const name = opened.observation.elements.find((el) => el.name === 'Name')
    expect(name).toBeTruthy()
    const filled = await backend.call(req('act', {
      requestId: 'fill',
      sessionId: opened.session.id,
      tabId: opened.observation.tabId,
      generation: opened.session.generation,
      observationId: opened.observation.observationId,
      controlLeaseId: opened.session.controlLeaseId,
      action: { type: 'fill', target: { kind: 'ref', ref: name!.ref }, text: 'Ada' }
    }))
    expect(filled.ok, JSON.stringify(filled.error)).toBe(true)
    expect(pair.page.nameValue).toBe('Ada')
    expect(pair.debugger.insertedTextCount).toBe(1)
    expect(pair.guest.keyboardFocusCalls).toBe(3)
    expect(pair.guest.keyboardReleaseRestores).toEqual([true])
    expect(pair.debugger.focusEmulated).toBe(false)
    const after = (filled.result as BrowserActionResult).observation!
    const save = after.elements.find((el) => el.name === 'Save')!
    const clicked = await backend.call(req('act', {
      requestId: 'save',
      sessionId: opened.session.id,
      tabId: after.tabId,
      generation: after.generation,
      observationId: after.observationId,
      controlLeaseId: opened.session.controlLeaseId,
      action: { type: 'click', target: { kind: 'ref', ref: save.ref } }
    }))
    expect(clicked.ok).toBe(true)
    expect(pair.page.result).toContain('saved:Ada')
    const closed = await backend.call(req('session.close', { sessionId: opened.session.id }))
    expect(closed.ok).toBe(true)
    expect(pair.guest.isDestroyed()).toBe(false)
    expect(pair.page.url).toContain('page.html')
  })

  it('restores real page focus after a held keyboard action is cancelled by human takeover', async () => {
    const registry = new TrustedGuestRegistry({ ownerBinding: () => true })
    const pair = registerPair(registry)
    let entered!: () => void, release!: () => void
    const held = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const backend = new ElectronAttachedBrowserBackend({ registry, policy: createLoopbackAttachedPolicy(), journal: memoryJournal(),
      interceptCommand: async (method) => { if (method === 'Input.insertText') { entered(); await gate } } })
    const opened = await openSession(backend)
    const action = backend.call(req('act', {
      requestId: 'cancel-keyboard', sessionId: opened.session.id, tabId: opened.observation.tabId,
      generation: opened.session.generation, observationId: opened.observation.observationId,
      controlLeaseId: opened.session.controlLeaseId,
      action: { type: 'fill', target: { kind: 'ref', ref: opened.observation.elements.find((el) => el.name === 'Name')!.ref }, text: 'Never inserted' }
    }))
    await held
    expect(pair.debugger.focusEmulated).toBe(true)
    const takeover = await backend.call(req('control.take', { sessionId: opened.session.id, owner: 'human' }))
    expect(takeover.ok).toBe(true)
    release()
    await action
    expect(pair.debugger.focusEmulated).toBe(false)
    expect(pair.debugger.insertedTextCount).toBe(0)
    expect(pair.guest.keyboardReleaseRestores).toEqual([false])
    expect(pair.page.nameValue).not.toBe('Never inserted')
    await backend.shutdown()
    expect(pair.guest.isDestroyed()).toBe(false)
  })

  it('fences a held action on takeover and requires fresh refs after human edit', async () => {
    const registry = new TrustedGuestRegistry({ ownerBinding: () => true })
    const pair = registerPair(registry)
    const backend = new ElectronAttachedBrowserBackend({
      registry,
      policy: createLoopbackAttachedPolicy(),
      journal: memoryJournal(),
      interceptCommand: async (method) => {
        const held = pair.debugger.hold.get(method)
        if (held) await held.promise
      }
    })
    const opened = await openSession(backend)
    const save = opened.observation.elements.find((el) => el.name === 'Save')!
    const release = pair.debugger.holdMethod('DOM.getContentQuads')
    const held = backend.call(req('act', {
      requestId: 'held',
      sessionId: opened.session.id,
      tabId: opened.observation.tabId,
      generation: opened.session.generation,
      observationId: opened.observation.observationId,
      controlLeaseId: opened.session.controlLeaseId,
      action: { type: 'click', target: { kind: 'ref', ref: save.ref } }
    }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(backend.getActiveCount()).toBe(1)
    const takeover = await backend.call(req('control.take', { sessionId: opened.session.id, owner: 'human' }))
    expect(takeover.ok).toBe(true)
    release()
    const heldResult = await held
    expect(heldResult.ok).toBe(false)
    expect(heldResult.error?.code).toMatch(/cancelled|human_controlled/)
    expect(pair.page.result).toBe('idle')
    const stale = await backend.call(req('act', {
      requestId: 'stale',
      sessionId: opened.session.id,
      tabId: opened.observation.tabId,
      generation: opened.session.generation,
      observationId: opened.observation.observationId,
      controlLeaseId: opened.session.controlLeaseId,
      action: { type: 'click', target: { kind: 'ref', ref: save.ref } }
    }))
    expect(stale.ok).toBe(false)
    const lease = (takeover.result as { controlLeaseId: string }).controlLeaseId
    const released = await backend.call(req('control.release', { sessionId: opened.session.id, controlLeaseId: lease }))
    expect(released.ok).toBe(true)
    const staleAfterRelease = await backend.call(req('act', {
      requestId: 'stale2',
      sessionId: opened.session.id,
      tabId: opened.observation.tabId,
      generation: opened.session.generation,
      observationId: opened.observation.observationId,
      controlLeaseId: lease,
      action: { type: 'fill', target: { kind: 'ref', ref: opened.observation.elements.find((el) => el.name === 'Name')!.ref }, text: 'X' }
    }))
    expect(staleAfterRelease.ok).toBe(false)
    const fresh = await backend.call(req('observe', { sessionId: opened.session.id }))
    expect(fresh.ok).toBe(true)
    expect((fresh.result as BrowserObservation).generation).toBeGreaterThan(opened.session.generation)
  })

  it('rejects stale guest, owner, epoch, and navigation; does not detach a foreign debugger', async () => {
    const registry = new TrustedGuestRegistry({ ownerBinding: () => true })
    const pair = registerPair(registry)
    const backend = new ElectronAttachedBrowserBackend({
      registry,
      policy: createLoopbackAttachedPolicy(),
      journal: memoryJournal()
    })
    const opened = await openSession(backend)
    pair.guest.navigate('http://127.0.0.1:1/other.html')
    pair.debugger.emitEvent('Page.frameNavigated', { frame: { id: 'frm_nav', loaderId: 'ldr_nav', url: 'http://127.0.0.1:1/other.html' } })
    const staleNav = await backend.call(req('act', {
      requestId: 'nav',
      sessionId: opened.session.id,
      tabId: opened.observation.tabId,
      generation: opened.session.generation,
      observationId: opened.observation.observationId,
      controlLeaseId: opened.session.controlLeaseId,
      action: { type: 'click', target: { kind: 'ref', ref: opened.observation.elements.find((el) => el.name === 'Save')!.ref } }
    }))
    expect(staleNav.ok).toBe(false)

    backend.revokeProfileEpoch(profileId, 'epoch_2')
    const staleEpoch = await backend.call(req('observe', { sessionId: opened.session.id }))
    expect(staleEpoch.ok).toBe(false)
    expect(staleEpoch.error?.code).toMatch(/session_closed|profile_mismatch|worker_disconnected/)

    const foreignReg = new TrustedGuestRegistry({ ownerBinding: () => true })
    const foreign = createFakeGuestPair({ profileId })
    foreign.debugger.markForeignAttached()
    foreignReg.registerGuest({
      guest: foreign.guest,
      owner: foreign.owner,
      profileId,
      profileEpoch,
      uiTabId: 'uitab_foreign',
      thread: { kind: 'thread', threadId }
    })
    const foreignBackend = new ElectronAttachedBrowserBackend({
      registry: foreignReg,
      policy: createLoopbackAttachedPolicy(),
      journal: memoryJournal()
    })
    const foreignOpen = await foreignBackend.call(req('session.open', { uiTabId: 'uitab_foreign', threadId }))
    expect(foreignOpen.ok).toBe(false)
    expect(foreignOpen.error?.message).toMatch(/another feature/i)
    expect(foreign.debugger.foreignAttached).toBe(true)
    expect(foreign.debugger.attached).toBe(false)
  })

  it('revokes leases and reports unknown effect when external navigation interrupts raw input', async () => {
    const registry = new TrustedGuestRegistry({ ownerBinding: () => true })
    const pair = registerPair(registry)
    const journal = memoryJournal()
    const backend = new ElectronAttachedBrowserBackend({
      registry,
      policy: createLoopbackAttachedPolicy(),
      journal
    })
    const opened = await openSession(backend)
    const release = pair.debugger.holdMethod('Input.dispatchMouseEvent')
    const action = backend.call(req('act', {
      requestId: 'navigate-during-input',
      sessionId: opened.session.id,
      tabId: opened.observation.tabId,
      generation: opened.session.generation,
      observationId: opened.observation.observationId,
      controlLeaseId: opened.session.controlLeaseId,
      action: {
        type: 'click',
        target: { kind: 'ref', ref: opened.observation.elements.find((element) => element.name === 'Save')!.ref }
      }
    }))
    await pair.debugger.waitUntilHeld('Input.dispatchMouseEvent')
    pair.guest.navigate('http://127.0.0.1:1/external-navigation')
    release()
    const response = await action
    expect(response.ok).toBe(true)
    expect((response.result as BrowserActionResult).outcome).toBe('unknown-effect')
    const control = await backend.call(req('control.release', {
      sessionId: opened.session.id,
      controlLeaseId: opened.session.controlLeaseId
    }))
    expect(control.ok).toBe(false)
    expect(journal.records).toContainEqual(expect.objectContaining({
      requestId: 'navigate-during-input', phase: 'outcome', outcome: 'unknown-effect'
    }))
  })

  it('retains shutdown ownership across timeout and retry', async () => {
    const registry = new TrustedGuestRegistry({ ownerBinding: () => true })
    const pair = registerPair(registry)
    let releaseHold = () => undefined
    let holdObserve = false
    const backend = new ElectronAttachedBrowserBackend({
      registry,
      policy: createLoopbackAttachedPolicy(),
      journal: memoryJournal(),
      interceptCommand: async (method) => {
        if (holdObserve && method === 'Accessibility.getFullAXTree') {
          await new Promise<void>((resolve) => { releaseHold = resolve })
        }
      }
    })
    const opened = await openSession(backend)
    holdObserve = true
    const pending = backend.call(req('observe', { sessionId: opened.session.id }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(backend.getActiveCount()).toBe(1)
    backend.beginShutdown()
    await expect(backend.shutdown({ timeoutMs: 30 })).rejects.toThrow(/timed out/)
    expect(backend.getActiveCount()).toBe(1)
    const retry = backend.shutdown({ timeoutMs: 2_000 })
    releaseHold()
    await pending
    await retry
    expect(backend.getActiveCount()).toBe(0)
    expect(pair.guest.isDestroyed()).toBe(false)
  })

  it('retains a timed-out raw Electron command until its actual promise settles', async () => {
    const registry = new TrustedGuestRegistry({ ownerBinding: () => true })
    const pair = registerPair(registry)
    const backend = new ElectronAttachedBrowserBackend({
      registry,
      policy: createLoopbackAttachedPolicy(),
      journal: memoryJournal()
    })
    const opened = await openSession(backend)
    const release = pair.debugger.holdMethod('Input.dispatchMouseEvent')
    const pending = backend.call(
      req('act', {
        requestId: 'raw-timeout',
        sessionId: opened.session.id,
        tabId: opened.observation.tabId,
        generation: opened.session.generation,
        observationId: opened.observation.observationId,
        controlLeaseId: opened.session.controlLeaseId,
        action: {
          type: 'click',
          target: { kind: 'ref', ref: opened.observation.elements.find((element) => element.name === 'Save')!.ref }
        }
      }),
      { timeoutMs: 100 }
    )
    await pair.debugger.waitUntilHeld('Input.dispatchMouseEvent')
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(backend.getActiveCount()).toBe(1)
    await expect(backend.shutdown({ timeoutMs: 30 })).rejects.toThrow(/timed out/)
    expect(backend.getActiveCount()).toBe(1)
    release()
    const result = await pending
    expect(result.ok).toBe(true)
    expect((result.result as BrowserActionResult).outcome).toBe('unknown-effect')
    await backend.shutdown({ timeoutMs: 2_000 })
    expect(backend.getActiveCount()).toBe(0)
    expect(pair.guest.isDestroyed()).toBe(false)
  })
})

describe('hidden Electron live webview fixture', () => {
  it('attaches to an existing guest, drives the live page, and preserves the human tab', async () => {
    const root = makeAttachedTempRoot()
    ownedRoots.push(root)
    const fixtureDir = dirname(fileURLToPath(new URL('./fixtures/agent-platform/electron-attached-browser/run-electron-fixture.mjs', import.meta.url)))
    const buildDir = resolve(root, 'build')
    const evidencePath = resolve(root, 'evidence.json')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(buildDir, { recursive: true })
    await mkdir(resolve(root, 'artifacts'), { recursive: true })
    await mkdir(resolve(root, 'electron-user-data'), { recursive: true })
    await build({
      bundle: true,
      platform: 'node',
      format: 'esm',
      sourcemap: false,
      logLevel: 'warning',
      packages: 'external',
      banner: {
        js: "import { fileURLToPath as __fixtureFileURLToPath } from 'node:url'; import { dirname as __fixtureDirname } from 'node:path'; const __filename = __fixtureFileURLToPath(import.meta.url); const __dirname = __fixtureDirname(__filename);"
      },
      entryPoints: [resolve(fixtureDir, 'electron-main.ts')],
      outfile: resolve(buildDir, 'main.mjs'),
      external: ['electron']
    })
    const env = {
      ...process.env,
      MOUSSE_ATTACHED_EVIDENCE: evidencePath,
      MOUSSE_ATTACHED_ARTIFACTS: resolve(root, 'artifacts'),
      MOUSSE_ATTACHED_USER_DATA: resolve(root, 'electron-user-data'),
      MOUSSE_ATTACHED_HOST_HTML: resolve(fixtureDir, 'host.html'),
      MOUSSE_ATTACHED_PAGE_HTML: resolve(fixtureDir, 'site', 'page.html')
    }
    delete env.ELECTRON_RUN_AS_NODE
    const electronPath = String(electron)
    const stderr: string[] = []
    const code = await new Promise<number>((resolveExit, reject) => {
      const child = spawn(electronPath, [resolve(buildDir, 'main.mjs')], {
        cwd: resolve(fixtureDir, '../../../..'),
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      child.stderr.on('data', (chunk) => { stderr.push(String(chunk)); process.stderr.write(chunk) })
      child.stdout.on('data', (chunk) => process.stdout.write(chunk))
      child.once('error', reject)
      child.once('exit', (exitCode) => resolveExit(exitCode ?? 1))
    })
    if (!existsSync(evidencePath)) {
      throw new Error(`electron fixture produced no evidence (exit ${code}): ${stderr.join('').slice(-4000)}`)
    }
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as {
      passed?: boolean
      error?: string
      liveName?: string
      liveResult?: string
      formStillAda?: string
      cookie?: string
      posts?: number
      postsAfterHold?: number
      screenshot?: boolean
      guestAliveAfterClose?: boolean
      unsupportedCode?: string
      staleActCode?: string | null
      staleAfterHumanCode?: string | null
    }
    expect(evidence.passed, evidence.error ?? JSON.stringify(evidence)).toBe(true)
    expect(code).toBe(0)
    expect(evidence.liveName).toBe('Ada')
    expect(evidence.liveResult).toContain('saved:Ada')
    expect(evidence.formStillAda).toBe('Ada')
    expect(evidence.cookie).toContain('recovery=kept')
    expect(evidence.posts).toBe(1)
    expect(evidence.postsAfterHold).toBe(1)
    expect(evidence.screenshot).toBe(true)
    expect(evidence.guestAliveAfterClose).toBe(true)
    expect(evidence.unsupportedCode).toBe('unsupported')
    expect(evidence.staleActCode).toBeTruthy()
    expect(evidence.staleAfterHumanCode).toBeTruthy()
  }, 120_000)
})
