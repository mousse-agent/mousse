import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../../../../src/mms/MousseMainService'
import {
  BRIDGE_REMOTE_METHODS,
  MmsListsSource,
  MmsRemoteBackend,
  RemoteApi,
  validateRemoteParams
} from '../../../../src/mms/bridge/remote'
import { bridgeRemoteMethodNames } from '../../../../src/mms/bridge/remote/capabilities'
import type { ListsServices } from '../../../../src/mms/bridge/remote/MmsListsSource'
import type { RpcContext } from '../../../../src/mms/net/contracts'
import { newId, type NodeId, type UserId } from '../../../../src/shared/net'

// A phone's thread menu: Rename, Pin and Archive were already open to phones; Regenerate title and Archive after are
// now too, through the same handlers as a window here. Deleting stays on the computer that runs the thread.

const clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  setTimeout: (callback: () => void, ms: number) => {
    const timer = setTimeout(callback, ms)
    return { cancel: () => clearTimeout(timer) }
  }
}
const phone = { node: newId('node') as NodeId, user: newId('user') as UserId }

function call(api: RemoteApi, method: string, params: unknown): Promise<unknown> {
  const entry = api.methods().find((row) => row.method === method)
  if (!entry) throw new Error('unregistered ' + method)
  entry.validate(params)
  const context: RpcContext = {
    id: newId('rpc'),
    caller: phone as RpcContext['caller'],
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 60_000,
    progress: () => undefined
  }
  return Promise.resolve(entry.handle(params, context))
}

const resources: Array<() => unknown> = []
afterEach(async () => {
  for (const dispose of resources.splice(0).reverse()) await dispose()
})

async function profile() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-remote-menu-')))
  const mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
  await mms.start()
  const api = new RemoteApi(new MmsRemoteBackend(mms), clock)
  resources.push(
    () => rmSync(home, { recursive: true, force: true }),
    () => mms.stop(),
    () => api.close()
  )
  return { mms, api }
}

describe('the thread menu from a phone', () => {
  it('opens Regenerate title and Archive after to phones, never Delete, and reports them in net.info', () => {
    expect(BRIDGE_REMOTE_METHODS['threads.regenerateTitle']).toEqual({
      capability: 'write',
      mutating: true
    })
    expect(BRIDGE_REMOTE_METHODS['threads.setExpiry']).toEqual({
      capability: 'write',
      mutating: true
    })
    expect(Object.keys(BRIDGE_REMOTE_METHODS)).not.toContain('threads.delete')
    expect(bridgeRemoteMethodNames()).toEqual(
      expect.arrayContaining([
        'threads.rename',
        'threads.pin',
        'threads.archive',
        'threads.settle',
        'threads.regenerateTitle',
        'threads.setExpiry'
      ])
    )
    expect(bridgeRemoteMethodNames()).not.toContain('threads.delete')
  })

  it('accepts only the keys the handlers read', () => {
    const ok = (method: keyof typeof BRIDGE_REMOTE_METHODS, params: unknown) =>
      expect(() => validateRemoteParams(method, params)).not.toThrow()
    const bad = (method: keyof typeof BRIDGE_REMOTE_METHODS, params: unknown) =>
      expect(() => validateRemoteParams(method, params)).toThrow()
    ok('threads.regenerateTitle', { threadId: 't' })
    bad('threads.regenerateTitle', { threadId: 't', name: 'x' })
    bad('threads.regenerateTitle', {})
    ok('threads.setExpiry', { threadId: 't', expiresAt: '2026-11-20T10:00:00.000Z' })
    ok('threads.setExpiry', {
      threadId: 't',
      expiresAt: '2026-11-20T10:00:00.000Z',
      stopsRun: true
    })
    ok('threads.setExpiry', { threadId: 't', expiresAt: null })
    bad('threads.setExpiry', { threadId: 't' })
    bad('threads.setExpiry', { threadId: 't', expiresAt: 42 })
    bad('threads.setExpiry', { threadId: 't', expiresAt: '' })
    bad('threads.setExpiry', { threadId: 't', expiresAt: null, stopsRun: 'yes' })
    bad('threads.setExpiry', { threadId: 't', expiresAt: null, discard: true })
  })

  it('sets and clears when a thread deletes itself, and the lists a phone follows show it', async () => {
    const { mms, api } = await profile()
    const thread = mms.threads.createThread('Expiring')
    const lists = new MmsListsSource(mms as unknown as ListsServices)
    const listed = () => lists.snapshot().threads.find((row) => row.id === thread.id)
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

    await call(api, 'threads.setExpiry', { threadId: thread.id, expiresAt, stopsRun: true })
    expect(mms.threads.getThread(thread.id)).toMatchObject({ expiresAt, expiryStopsRun: true })
    expect(listed()).toMatchObject({ expiresAt, expiryStopsRun: true })

    await call(api, 'threads.setExpiry', { threadId: thread.id, expiresAt: null })
    expect(mms.threads.getThread(thread.id)?.expiresAt).toBeUndefined()
    expect(listed()).not.toHaveProperty('expiresAt')
    expect(listed()).not.toHaveProperty('expiryStopsRun')
  })

  it('answers a refused expiry in words instead of "may have happened"', async () => {
    const { mms, api } = await profile()
    const thread = mms.threads.createThread('Too soon')
    const soon = new Date(Date.now() + 5_000).toISOString()
    expect(await call(api, 'threads.setExpiry', { threadId: thread.id, expiresAt: soon })).toEqual({
      ok: false,
      error: 'An expiry must be at least a minute away'
    })
    expect(mms.threads.getThread(thread.id)?.expiresAt).toBeUndefined()
  })

  it("regenerates a title with the computer's title model, and says so when none came back", async () => {
    const { mms, api } = await profile()
    const thread = mms.threads.createThread('Old name')
    const title = vi
      .spyOn(mms.orchestrator, 'generateThreadTitle')
      .mockResolvedValueOnce('Fix the login page')
    const result = (await call(api, 'threads.regenerateTitle', { threadId: thread.id })) as {
      thread: { name: string }
    }
    expect(title).toHaveBeenCalledWith(expect.any(Array), thread.id)
    expect(result.thread.name).toBe('Fix the login page')
    expect(mms.threads.getThread(thread.id)).toMatchObject({
      name: 'Fix the login page',
      titleSource: 'final'
    })

    title.mockResolvedValueOnce('')
    expect(await call(api, 'threads.regenerateTitle', { threadId: thread.id })).toEqual({
      ok: false,
      error: 'The title model returned an empty title.'
    })
    expect(mms.threads.getThread(thread.id)?.name).toBe('Fix the login page')
  })
})
