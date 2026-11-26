/**
 * Updating one computer from another (#476, step 2), end to end: two real Net services paired over loopback, the
 * updated computer's request hub and the app-side methods its desktop app calls, the app's agent and the real
 * `DesktopUpdater` with electron-updater replaced by a scripted backend (no installer runs). The asking computer
 * drives it through `net.update.there`, as its Devices dialog does.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DesktopUpdater, type UpdaterBackend } from '../../src/main/updates/DesktopUpdater'
import { RemoteUpdateAgent } from '../../src/main/updates/remoteUpdateAgent'
import { NetService } from '../../src/mms/net/NetService'
import type { HandlerContext } from '../../src/mms/protocol/handlers'
import { DomainHandlerRegistry } from '../../src/mms/protocol/domainRegistry'
import { registerRemoteUpdateMethods } from '../../src/mms/updates/registerRemoteUpdateMethods'
import { RemoteUpdates } from '../../src/mms/updates/remoteUpdates'
import { accessPreset } from '../../src/shared/net/accessPresets'
import { REMOTE_UPDATE_LIMITS, type RemoteUpdateStatus, type RemoteUpdateToast } from '../../src/shared/remoteUpdates'
import type { SelfUpdateReport } from '../../src/shared/updates'

const cleanups: Array<() => Promise<void> | void> = []
let savedVersion: string | undefined
beforeEach(() => {
  savedVersion = process.env.MOUSSE_VERSION
  process.env.MOUSSE_VERSION = '0.1.3'
})
afterEach(async () => {
  if (savedVersion === undefined) delete process.env.MOUSSE_VERSION
  else process.env.MOUSSE_VERSION = savedVersion
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const LIMITS = { ...REMOTE_UPDATE_LIMITS, countdownMs: 300, busyRetryMs: 100, pollMs: 50 }

function service(opts: { selfUpdate?: () => SelfUpdateReport; remoteUpdates?: RemoteUpdates } = {}): NetService {
  const path = mkdtempSync(join(tmpdir(), 'net-remote-update-'))
  const net = new NetService({ profileDir: path, ...opts })
  cleanups.push(
    () => rmSync(path, { recursive: true, force: true }),
    () => net.shutdown()
  )
  return net
}

/** The computer being updated: its Net, its hub, and the app methods registered as the service registers them. */
function target(turns: { count: number }) {
  const hub = new RemoteUpdates({ limits: LIMITS })
  const registry = new DomainHandlerRegistry()
  const events = new EventEmitter()
  registerRemoteUpdateMethods(registry, hub, {
    emit: (type, data) => events.emit('event', { type, data }),
    activeTurns: () => turns.count
  })
  const net = service({ selfUpdate: () => ({ channel: 'stable', self: true }), remoteUpdates: hub })
  return { hub, registry, events, net }
}

/** The desktop app of the updated computer: the real updater over a scripted feed, and its agent. */
function app(t: ReturnType<typeof target>, feed: { version: string }) {
  const backend = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: false,
    allowDowngrade: false,
    fullChangelog: false,
    channel: null as string | null,
    checkForUpdates: vi.fn(async () => ({ isUpdateAvailable: true, updateInfo: { version: feed.version } })),
    downloadUpdate: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(() => true),
    on: () => backend
  }
  const prepareInstall = vi.fn(async () => undefined)
  const updater = new DesktopUpdater({
    currentVersion: '0.1.3',
    repositoryUrl: 'https://github.com/example/mousse',
    store: { read: () => ({}), write: () => undefined },
    loadBackend: async () => backend as unknown as UpdaterBackend,
    prepareInstall,
    recoverInstall: async () => undefined,
    onState: () => undefined,
    setTimer: () => null,
    clearTimer: () => undefined
  })
  const connection = { id: 'app-1', clientType: 'gui' as const, capabilities: new Set<string>() }
  const ctx = { connection } as unknown as HandlerContext
  const toasts: Array<RemoteUpdateToast | null> = []
  const service = Object.assign(t.events, {
    connectionState: 'ready',
    request: <T,>(method: string, params?: unknown) => t.registry.dispatch(ctx, method, params ?? {}) as Promise<T>
  })
  const agent = new RemoteUpdateAgent({ service, updater, toast: (toast) => toasts.push(toast), limits: LIMITS })
  cleanups.push(() => agent.stop())
  return { agent, backend, prepareInstall, toasts, closeConnection: () => t.registry.notifyConnectionClosed(connection.id) }
}

/** The updated computer (the keeper) and the computer asking (a computer enrolled through it). */
async function pair(turns = { count: 0 }) {
  const t = target(turns)
  const asker = service()
  await t.net.request('net.init', { name: 'target', listen: true, port: 0 })
  await t.net.request('net.protect', { passphrase: 'test-authority-protection' })
  const invite = (await t.net.request('bridge.invite', { caps: ['read', 'chat', 'write', 'settings'] })) as { invite: string }
  const joined = (await asker.request('bridge.join', { invite: invite.invite, name: 'asker' })) as { node: string; authority: string }
  await vi.waitFor(() => expect(t.net.status().peers).toContainEqual({ node: joined.node, state: 'open' }))
  const level = (id: 'view' | 'work' | 'full') => t.net.request('bridge.policy', { node: joined.node, ...accessPreset(id).fields })
  const ask = async (params: Record<string, unknown>) =>
    (await asker.request('net.update.there', { node: joined.authority, ...params })) as RemoteUpdateStatus
  return { t, asker, node: joined.node, targetNode: joined.authority, level, ask, turns }
}

it('updates a computer from another: exact version, countdown, Cancel-free install once turns match', async () => {
  const { t, asker, targetNode, level, ask, turns } = await pair({ count: 1 })
  await level('full')
  // No app is running there: it says it does not take requests, and a request is refused.
  expect(await ask({ step: 'prepare', version: '0.1.4' })).toMatchObject({ phase: 'failed', error: 'not_accepting' })
  const { agent, backend, prepareInstall, toasts } = app(t, { version: '0.1.4' })
  agent.start(true)
  await vi.waitFor(() => expect(t.hub.accepts()).toBe(true))
  // Asked again, the target now says it takes requests (what shows the Update button there).
  await ask({ step: 'refresh' })
  const row = ((await asker.request('bridge.nodes', {})) as { nodes: Array<{ node: string; update?: SelfUpdateReport }> }).nodes.find(
    (item) => item.node === targetNode
  )
  expect(row?.update).toMatchObject({ self: true, requests: true })

  // Download returns at once; the status shows it get ready.
  const prepared = await ask({ step: 'prepare', version: '0.1.4' })
  expect(prepared.phase).toBe('preparing')
  await vi.waitFor(async () => expect((await ask({ step: 'status', job: prepared.job })).phase).toBe('ready'))
  expect(backend.downloadUpdate).toHaveBeenCalledTimes(1)
  expect((await ask({ step: 'status', job: prepared.job })).runningTurns).toBe(1)

  // Confirmed with one turn running: the countdown shows there, named for the asking computer.
  expect((await ask({ step: 'install', job: prepared.job, runningTurns: 1 })).phase).toBe('countdown')
  await vi.waitFor(() => expect(toasts.at(-1)).toMatchObject({ from: 'asker' }))
  // A second turn starts before it ends: it waits instead of stopping it.
  turns.count = 2
  await vi.waitFor(async () => expect((await ask({ step: 'status', job: prepared.job })).phase).toBe('waiting'))
  expect(prepareInstall).not.toHaveBeenCalled()
  turns.count = 1
  await vi.waitFor(() => expect(backend.quitAndInstall).toHaveBeenCalledTimes(1))
  expect(prepareInstall).toHaveBeenCalledTimes(1)
  expect((await ask({ step: 'status', job: prepared.job })).phase).toBe('installing')
}, 30000)

it('refuses a computer without Full control, and never installs another version than the one asked for', async () => {
  const { t, level, ask } = await pair()
  const { agent, backend } = app(t, { version: '0.1.5' })
  agent.start(true)
  await vi.waitFor(() => expect(t.hub.accepts()).toBe(true))
  // Work on threads is not enough: refused before anything is kept.
  await level('work')
  expect(await ask({ step: 'prepare', version: '0.1.4' })).toMatchObject({ phase: 'failed', error: 'forbidden' })
  await level('full')
  // The feed there offers 0.1.5: asking for 0.1.4 fails, and nothing is downloaded.
  const prepared = await ask({ step: 'prepare', version: '0.1.4' })
  await vi.waitFor(async () =>
    expect(await ask({ step: 'status', job: prepared.job })).toMatchObject({ phase: 'failed', error: 'version_unavailable' })
  )
  expect(backend.downloadUpdate).not.toHaveBeenCalled()
}, 30000)

it('does not install when the asking computer loses Full control during the countdown, or the app goes away', async () => {
  const { t, level, ask } = await pair()
  await level('full')
  const first = app(t, { version: '0.1.4' })
  first.agent.start(true)
  await vi.waitFor(() => expect(t.hub.accepts()).toBe(true))
  const job = (await ask({ step: 'prepare', version: '0.1.4' })).job
  await vi.waitFor(async () => expect((await ask({ step: 'status', job })).phase).toBe('ready'))
  await ask({ step: 'install', job, runningTurns: 0 })
  // Lowered to Work on threads while it counts down: the status is refused, and the install never starts.
  await level('work')
  expect(await ask({ step: 'status', job })).toMatchObject({ phase: 'failed', error: 'forbidden' })
  await new Promise((resolve) => setTimeout(resolve, LIMITS.countdownMs + 200))
  expect(first.backend.quitAndInstall).not.toHaveBeenCalled()
  await level('full')
  expect(await ask({ step: 'status', job })).toMatchObject({ phase: 'failed', error: 'forbidden' })

  // The next request; the app's connection closes before Install: it fails, and the target stops taking requests.
  const next = (await ask({ step: 'prepare', version: '0.1.4' })).job
  await vi.waitFor(async () => expect((await ask({ step: 'status', job: next })).phase).toBe('ready'))
  first.closeConnection()
  expect(t.hub.accepts()).toBe(false)
  expect(await ask({ step: 'status', job: next })).toMatchObject({ phase: 'failed', error: 'not_accepting' })
  expect(await ask({ step: 'install', job: next, runningTurns: 0 })).toMatchObject({ phase: 'failed' })
  expect(first.backend.quitAndInstall).not.toHaveBeenCalled()
}, 30000)
