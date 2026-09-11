import { createConnection, type Socket } from 'node:net'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { domainObject } from '../src/mms/protocol/domainRegistry'
import { ConnectionCommandRouter, ClientCommandReceiver } from '../src/mms/protocol/connectionCommands'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { encodeFrame, FrameDecoder } from '../src/mms/protocol/framing'
import { parseEnvelope } from '../src/mms/protocol/validators'
import {
  MMS_PROTOCOL_MAX_COMMAND_PAYLOAD_BYTES,
  MMS_PROTOCOL_MAX_CONNECTION_COMMANDS,
  MMS_PROTOCOL_MAX_GLOBAL_COMMANDS,
  MMS_PROTOCOL_VERSION,
  type ProtocolEvent
} from '../src/mms/protocol/types'
import {
  BROWSER_ATTACHED_DISPATCH_METHOD,
  BROWSER_ATTACHED_V1_CAPABILITY
} from '../src/shared/browser/connectionCommands'
import { PROFILES_V1_CAPABILITY } from '../src/shared/profiles/types'
import type { BrowserWorkerRequest, BrowserWorkerResponse } from '../src/shared/browser/types'
import {
  makeBrowserCommandTempRoot,
  removeBrowserCommandTempRoot
} from './fixtures/agent-platform/browser-command-transport/ownedTemp'

const OWNER_TOKEN = 'fixture-owner-token'
const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) removeBrowserCommandTempRoot(root)
})

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function workerRequest(
  method: BrowserWorkerRequest['method'],
  profileId: string,
  id = 'req_1',
  params?: Record<string, unknown>
): BrowserWorkerRequest {
  const defaults: Partial<Record<BrowserWorkerRequest['method'], Record<string, unknown>>> = {
    observe: { sessionId: 'session_1' },
    act: {
      requestId: `${id}_action`, sessionId: 'session_1', tabId: 'tab_1', generation: 1,
      observationId: 'observation_1', controlLeaseId: 'lease_1', action: { type: 'reload' }, timeoutMs: 30_000
    }
  }
  return { version: 1, id, profileId, method, params: params ?? defaults[method] ?? {} }
}

function okResult(id: string, extra: Record<string, unknown> = {}): BrowserWorkerResponse {
  return { version: 1, id, ok: true, result: extra }
}

type Inspected = {
  connectionId: string
  clientType: string | null
  capabilities: string[]
  binding: { profileId: string; epoch: number } | null
}

async function inspect(client: LocalMmsClient): Promise<Inspected> {
  return client.request<Inspected>('fixture.inspectConnection')
}

async function startHarness(opts: { router?: boolean } = {}) {
  const root = makeBrowserCommandTempRoot()
  roots.push(root)
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  const main = await MousseMainService.create({
    homeDir: home,
    repoRoot: root,
    requireOwnership: false,
    headless: true
  })
  main.domains.register({
    method: 'fixture.inspectConnection',
    scope: 'installation',
    validate: (params) => {
      if (params === undefined || params === null) return {}
      return domainObject(params, [])
    },
    handle: (ctx) => ({
      connectionId: ctx.connection?.id ?? null,
      clientType: ctx.connection?.clientType ?? null,
      capabilities: ctx.connection ? [...ctx.connection.capabilities].sort() : [],
      binding: ctx.connection?.binding ?? null
    })
  })
  const host = main.getInstallationHost()!
  const defaultId = host.getDefaultProfileId()
  const bob = host.manager.create({ displayName: 'Bob', slug: 'bob' })
  const router = opts.router === false ? null : new ConnectionCommandRouter()
  const server = new MmsProtocolServer({
    mms: main,
    ownerToken: OWNER_TOKEN,
    ...(router ? { commandRouter: router } : {})
  })
  const endpoint = await server.start()
  const stop = async (clients: LocalMmsClient[] = []): Promise<void> => {
    await Promise.allSettled(clients.map((client) => client.close()))
    await server.stop()
    await main.stop()
  }
  return { root, home, main, host, defaultId, bob, router, server, endpoint, stop }
}

function guiClient(home: string, endpoint: string, extraCaps: string[] = []): LocalMmsClient {
  return new LocalMmsClient({
    homeDir: home,
    endpoint,
    ownerToken: OWNER_TOKEN,
    clientType: 'gui',
    requestedCapabilities: [PROFILES_V1_CAPABILITY, ...extraCaps]
  })
}

function cliClient(home: string, endpoint: string, extraCaps: string[] = []): LocalMmsClient {
  return new LocalMmsClient({
    homeDir: home,
    endpoint,
    ownerToken: OWNER_TOKEN,
    clientType: 'cli',
    requestedCapabilities: [PROFILES_V1_CAPABILITY, ...extraCaps]
  })
}

async function bindGui(
  home: string,
  endpoint: string,
  profile: string,
  handler?: Parameters<LocalMmsClient['setAttachedBrowserCommandHandler']>[0]
): Promise<LocalMmsClient> {
  const client = guiClient(home, endpoint, [BROWSER_ATTACHED_V1_CAPABILITY])
  if (handler) client.setAttachedBrowserCommandHandler(handler)
  await client.connect()
  await client.request('profiles.bind', { profile })
  return client
}

describe('attached browser command envelope validation', () => {
  it('rejects unknown methods, unknown fields, and oversize payloads', () => {
    const request = workerRequest('observe', 'profile_1')
    expect(
      parseEnvelope({
        kind: 'server_req',
        id: 'cmd_1',
        method: 'cdp.evaluate',
        registrationId: 'reg_1',
        registrationEpoch: 1,
        profileId: 'profile_1',
        profileEpoch: 1,
        request
      })
    ).toBeNull()
    expect(
      parseEnvelope({
        kind: 'server_req', id: 'cmd_params', method: BROWSER_ATTACHED_DISPATCH_METHOD,
        registrationId: 'reg_1', registrationEpoch: 1, profileId: 'profile_1', profileEpoch: 1,
        request: workerRequest('observe', 'profile_1', 'req_params', { sessionId: 'session_1', evaluate: '1+1' })
      })
    ).toBeNull()
    expect(
      parseEnvelope({
        kind: 'server_req', id: 'cmd_bound', method: BROWSER_ATTACHED_DISPATCH_METHOD,
        registrationId: 'reg_1', registrationEpoch: 1, profileId: 'profile_1', profileEpoch: 1,
        request: workerRequest('observe', 'profile_1', 'req_bound', { sessionId: 'session_1', maxElements: 1001 })
      })
    ).toBeNull()
    expect(
      parseEnvelope({
        kind: 'server_req',
        id: 'cmd_1',
        method: BROWSER_ATTACHED_DISPATCH_METHOD,
        registrationId: 'reg_1',
        registrationEpoch: 1,
        profileId: 'profile_1',
        profileEpoch: 1,
        request,
        eval: '1+1'
      })
    ).toBeNull()
    expect(
      parseEnvelope({
        kind: 'client_res',
        id: 'cmd_1',
        registrationId: 'reg_1',
        registrationEpoch: 1,
        requestId: 'req_1',
        ok: true,
        result: okResult('req_1'),
        forged: true
      })
    ).toBeNull()
    expect(
      parseEnvelope({
        kind: 'server_req',
        id: 'cmd_1',
        method: BROWSER_ATTACHED_DISPATCH_METHOD,
        registrationId: 'reg_1',
        registrationEpoch: 1,
        profileId: 'profile_1',
        profileEpoch: 1,
        request: {
          version: 1,
          id: 'req_1',
          profileId: 'profile_1',
          method: 'observe',
          params: { blob: 'x'.repeat(MMS_PROTOCOL_MAX_COMMAND_PAYLOAD_BYTES + 32) }
        }
      })
    ).toBeNull()
    expect(
      parseEnvelope({
        kind: 'server_req',
        id: 'cmd_1',
        method: BROWSER_ATTACHED_DISPATCH_METHOD,
        registrationId: 'reg_1',
        registrationEpoch: 1,
        profileId: 'profile_1',
        profileEpoch: 1,
        request
      })
    ).toMatchObject({ kind: 'server_req', method: BROWSER_ATTACHED_DISPATCH_METHOD })
  })
})

describe('framed daemon to Electron-main command transport', () => {
  it('advertises and grants browser-attached-v1 only for requested GUI with an injected router', async () => {
    const withRouter = await startHarness()
    const withoutRouter = await startHarness({ router: false })
    const guiRequested = guiClient(withRouter.home, withRouter.endpoint, [BROWSER_ATTACHED_V1_CAPABILITY])
    const guiUnrequested = guiClient(withRouter.home, withRouter.endpoint)
    const cliRequested = cliClient(withRouter.home, withRouter.endpoint, [BROWSER_ATTACHED_V1_CAPABILITY])
    const guiNoRouter = guiClient(withoutRouter.home, withoutRouter.endpoint, [BROWSER_ATTACHED_V1_CAPABILITY])
    try {
      const helloGui = await guiRequested.connect()
      const helloCli = await cliRequested.connect()
      const helloUnreq = await guiUnrequested.connect()
      const helloNoRouter = await guiNoRouter.connect()
      await guiRequested.request('profiles.bind', { profile: withRouter.defaultId })
      await cliRequested.request('profiles.bind', { profile: withRouter.defaultId })
      await guiUnrequested.request('profiles.bind', { profile: withRouter.defaultId })
      await guiNoRouter.request('profiles.bind', { profile: withoutRouter.defaultId })
      expect(helloGui.capabilities).toContain(BROWSER_ATTACHED_V1_CAPABILITY)
      expect(helloCli.capabilities).toContain(BROWSER_ATTACHED_V1_CAPABILITY)
      expect(helloNoRouter.capabilities).not.toContain(BROWSER_ATTACHED_V1_CAPABILITY)
      expect((await inspect(guiRequested)).capabilities).toContain(BROWSER_ATTACHED_V1_CAPABILITY)
      expect((await inspect(guiUnrequested)).capabilities).not.toContain(BROWSER_ATTACHED_V1_CAPABILITY)
      expect((await inspect(cliRequested)).capabilities).not.toContain(BROWSER_ATTACHED_V1_CAPABILITY)
      expect((await inspect(guiNoRouter)).capabilities).not.toContain(BROWSER_ATTACHED_V1_CAPABILITY)
      expect(helloUnreq.capabilities).toContain(PROFILES_V1_CAPABILITY)
    } finally {
      await withRouter.stop([guiRequested, guiUnrequested, cliRequested])
      await withoutRouter.stop([guiNoRouter])
    }
  })

  it('rejects a wrong owner token before any command capability exists', async () => {
    const h = await startHarness()
    const bad = new LocalMmsClient({
      homeDir: h.home,
      endpoint: h.endpoint,
      ownerToken: 'wrong-token',
      clientType: 'gui',
      requestedCapabilities: [BROWSER_ATTACHED_V1_CAPABILITY]
    })
    try {
      await expect(bad.connect()).rejects.toThrow(/Hello rejected|auth/i)
    } finally {
      await bad.close()
      await h.stop()
    }
  })

  it('delivers a command only to the targeted GUI handler with no sibling, CLI, event, or replay leak', async () => {
    const h = await startHarness()
    const seen: Record<string, string[]> = { alice1: [], alice2: [], bob: [], cli: [] }
    const handler = (label: string) => async (command: { request: BrowserWorkerRequest }) => {
      seen[label].push(command.request.method)
      return okResult(command.request.id, { from: label })
    }
    const alice1 = await bindGui(h.home, h.endpoint, h.defaultId, handler('alice1'))
    const alice2 = await bindGui(h.home, h.endpoint, h.defaultId, handler('alice2'))
    const bob = await bindGui(h.home, h.endpoint, h.bob.id, handler('bob'))
    const cli = cliClient(h.home, h.endpoint, [BROWSER_ATTACHED_V1_CAPABILITY])
    await cli.connect()
    await cli.request('profiles.bind', { profile: h.defaultId })
    const events: ProtocolEvent[] = []
    for (const client of [alice1, alice2, bob, cli]) {
      client.onEvent((event) => events.push(event))
      await client.subscribe(0)
    }
    const seqBefore = [alice1, alice2, bob, cli].map((client) => client.lastKnownSequence)
    const target = await inspect(alice1)
    const sibling = await inspect(alice2)
    const bobInfo = await inspect(bob)
    const cliInfo = await inspect(cli)
    expect(target.connectionId).not.toBe(sibling.connectionId)
    expect(target.binding?.profileId).toBe(h.defaultId)
    const result = await h.router!.dispatch({
      connectionId: target.connectionId,
      registrationId: 'reg_alice1',
      registrationEpoch: 1,
      expectedBinding: target.binding!,
      request: workerRequest('observe', h.defaultId)
    })
    expect(result).toMatchObject({
      status: 'completed',
      dispatched: true,
      response: { ok: true, result: { from: 'alice1' } }
    })
    expect(seen).toEqual({ alice1: ['observe'], alice2: [], bob: [], cli: [] })
    expect(events).toEqual([])
    expect([alice1, alice2, bob, cli].map((client) => client.lastKnownSequence)).toEqual(seqBefore)
    await expect(
      h.router!.dispatch({
        connectionId: cliInfo.connectionId,
        registrationId: 'reg_cli',
        registrationEpoch: 1,
        expectedBinding: cliInfo.binding!,
        request: workerRequest('observe', h.defaultId)
      })
    ).resolves.toMatchObject({ status: 'rejected', code: 'capability_required', dispatched: false })
    await expect(
      h.router!.dispatch({
        connectionId: bobInfo.connectionId,
        registrationId: 'reg_bob',
        registrationEpoch: 1,
        expectedBinding: target.binding!,
        request: workerRequest('observe', h.defaultId)
      })
    ).resolves.toMatchObject({ status: 'rejected', code: 'stale_binding', dispatched: false })
    const replay = await alice2.subscribe(seqBefore[1] ?? 0)
    expect(replay.replay).toEqual([])
    expect(seen.alice2).toEqual([])
    await h.stop([alice1, alice2, bob, cli])
  })

  it('cancels on rebind and disconnect, rejects stale replies, and does not execute a duplicate handler', async () => {
    const h = await startHarness()
    const first = deferred()
    const releaseFirst = deferred()
    let calls = 0
    const alice = await bindGui(h.home, h.endpoint, h.defaultId, async (command, { signal }) => {
      calls += 1
      if (calls === 1) {
        first.resolve()
        await Promise.race([
          releaseFirst.promise,
          new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        ])
        return okResult(command.request.id, { generation: 'stale' })
      }
      return okResult(command.request.id, { generation: 'fresh' })
    })
    const info = await inspect(alice)
    const pending = h.router!.dispatch({
      connectionId: info.connectionId,
      registrationId: 'reg_1',
      registrationEpoch: 1,
      expectedBinding: info.binding!,
      request: workerRequest('act', h.defaultId, 'req_old'),
      timeoutMs: 15_000
    })
    await first.promise
    const rebound = await alice.request<{ epoch: number }>('profiles.bind', { profile: h.bob.id })
    const interrupted = await pending
    expect(interrupted.status).toBe('unknown-effect')
    expect(interrupted.dispatched).toBe(true)
    const afterBind = await inspect(alice)
    expect(afterBind.binding?.epoch).toBe(rebound.epoch)
    await expect(
      h.router!.dispatch({
        connectionId: afterBind.connectionId,
        registrationId: 'reg_1',
        registrationEpoch: 1,
        expectedBinding: info.binding!,
        request: workerRequest('observe', h.defaultId, 'req_stale_epoch')
      })
    ).resolves.toMatchObject({ status: 'rejected', code: 'stale_binding' })
    const fresh = await h.router!.dispatch({
      connectionId: afterBind.connectionId,
      registrationId: 'reg_2',
      registrationEpoch: 2,
      expectedBinding: afterBind.binding!,
      request: workerRequest('observe', h.bob.id, 'req_new')
    })
    expect(fresh).toMatchObject({
      status: 'completed',
      response: { result: { generation: 'fresh' } }
    })
    releaseFirst.resolve()
    await h.stop([alice])
  })

  it('does not launch a second handler for a duplicate command id', async () => {
    const receiver = new ClientCommandReceiver()
    let launches = 0
    const entered = deferred()
    const release = deferred()
    receiver.setHandler(async (command) => {
      launches += 1
      entered.resolve()
      await release.promise
      return okResult(command.request.id)
    })
    const writes: unknown[] = []
    receiver.bindWriter((envelope) => {
      writes.push(envelope)
    })
    const envelope = {
      kind: 'server_req' as const,
      id: 'cmd_dup',
      method: BROWSER_ATTACHED_DISPATCH_METHOD,
      registrationId: 'reg_1',
      registrationEpoch: 1,
      profileId: 'profile_1',
      profileEpoch: 1,
      request: workerRequest('observe', 'profile_1')
    }
    receiver.handleServerRequest(envelope)
    await entered.promise
    receiver.handleServerRequest(envelope)
    expect(launches).toBe(1)
    expect(receiver.getActiveCount()).toBe(1)
    release.resolve()
    await waitReceiverIdle(receiver)
    expect(launches).toBe(1)
    expect(writes).toHaveLength(1)
    receiver.unbindWriter()
    receiver.handleServerRequest({ ...envelope, id: 'cmd_after_disconnect', request: workerRequest('observe', 'profile_1', 'req_after_disconnect') })
    await Promise.resolve()
    expect(launches).toBe(1)
  })

  it('invalidates a disposed profile binding and recovers the same connection after rebind', async () => {
    const h = await startHarness()
    const entered = deferred()
    const release = deferred()
    const alice = await bindGui(h.home, h.endpoint, h.defaultId, async (command) => {
      if (command.request.id === 'req_disposed') {
        entered.resolve()
        await release.promise
      }
      return okResult(command.request.id)
    })
    try {
      const before = await inspect(alice)
      const pending = h.router!.dispatch({
        connectionId: before.connectionId,
        registrationId: 'reg_disposed', registrationEpoch: 1,
        expectedBinding: before.binding!, request: workerRequest('act', h.defaultId, 'req_disposed')
      })
      await entered.promise
      h.main.domains.notifyProfileDisposed(h.defaultId)
      await expect(pending).resolves.toMatchObject({ status: 'unknown-effect', code: 'profile_dispose' })
      await expect(h.router!.dispatch({
        connectionId: before.connectionId,
        registrationId: 'reg_stale', registrationEpoch: 1,
        expectedBinding: before.binding!, request: workerRequest('observe', h.defaultId, 'req_stale_disposed')
      })).resolves.toMatchObject({ status: 'rejected', code: 'stale_binding' })

      await alice.request('profiles.bind', { profile: h.bob.id })
      const rebound = await inspect(alice)
      await expect(h.router!.dispatch({
        connectionId: rebound.connectionId,
        registrationId: 'reg_recovered', registrationEpoch: 2,
        expectedBinding: rebound.binding!, request: workerRequest('observe', h.bob.id, 'req_recovered')
      })).resolves.toMatchObject({ status: 'completed', response: { id: 'req_recovered' } })
      release.resolve()
    } finally {
      release.resolve()
      await h.stop([alice])
    }
  })

  it('enforces per-connection outstanding bounds and retains raw ownership past caller timeout', async () => {
    const h = await startHarness()
    const release = deferred()
    const alice = await bindGui(h.home, h.endpoint, h.defaultId, async (command) => {
      await release.promise
      return okResult(command.request.id)
    })
    const info = await inspect(alice)
    const hanging: Promise<unknown>[] = []
    for (let i = 0; i < MMS_PROTOCOL_MAX_CONNECTION_COMMANDS; i += 1) {
      hanging.push(
        h.router!.dispatch({
          connectionId: info.connectionId,
          registrationId: 'reg_bound',
          registrationEpoch: 1,
          expectedBinding: info.binding!,
          request: workerRequest('act', h.defaultId, `req_bound_${i}`),
          timeoutMs: 40
        })
      )
    }
    await vi.waitFor(() => expect(h.router!.getActiveCount()).toBe(MMS_PROTOCOL_MAX_CONNECTION_COMMANDS))
    await expect(
      h.router!.dispatch({
        connectionId: info.connectionId,
        registrationId: 'reg_bound',
        registrationEpoch: 1,
        expectedBinding: info.binding!,
        request: workerRequest('act', h.defaultId, 'req_bound_overflow')
      })
    ).resolves.toMatchObject({ status: 'rejected', code: 'backpressure', dispatched: false })
    const timedOut = await Promise.all(hanging)
    expect(timedOut.every((result) => (result as { status: string }).status === 'unknown-effect')).toBe(true)
    expect(h.router!.getActiveCount()).toBe(MMS_PROTOCOL_MAX_CONNECTION_COMMANDS)
    h.router!.beginShutdown()
    await expect(h.router!.shutdown({ timeoutMs: 30 })).rejects.toMatchObject({ code: 'profile_busy' })
    expect(h.router!.getActiveCount()).toBe(MMS_PROTOCOL_MAX_CONNECTION_COMMANDS)
    await expect(
      h.router!.dispatch({
        connectionId: info.connectionId,
        registrationId: 'reg_bound',
        registrationEpoch: 1,
        expectedBinding: info.binding!,
        request: workerRequest('observe', h.defaultId, 'req_after_shutdown')
      })
    ).resolves.toMatchObject({ status: 'rejected', code: 'admission_closed' })
    release.resolve()
    await h.router!.shutdown({ timeoutMs: 5_000 })
    expect(h.router!.getActiveCount()).toBe(0)
    expect(timedOut.every((result) => (result as { dispatched: boolean }).dispatched)).toBe(true)
    await h.stop([alice])
  })

  it('rejects missing handlers, thrown handlers, malformed and oversize results without a second dispatch', async () => {
    const h = await startHarness()
    const none = await bindGui(h.home, h.endpoint, h.defaultId)
    const throwing = await bindGui(h.home, h.endpoint, h.defaultId, async () => {
      throw new Error('executor exploded')
    })
    const malformed = await bindGui(h.home, h.endpoint, h.defaultId, async () => ({ version: 2 }) as never)
    const oversize = await bindGui(h.home, h.endpoint, h.defaultId, async (command) => ({
      version: 1,
      id: command.request.id,
      ok: true,
      result: { blob: 'x'.repeat(MMS_PROTOCOL_MAX_COMMAND_PAYLOAD_BYTES + 8) }
    }))
    const hugeError = await bindGui(h.home, h.endpoint, h.defaultId, async () => {
      throw new Error('x'.repeat(MMS_PROTOCOL_MAX_COMMAND_PAYLOAD_BYTES + 8))
    })
    const noneInfo = await inspect(none)
    const throwInfo = await inspect(throwing)
    const malformedInfo = await inspect(malformed)
    const oversizeInfo = await inspect(oversize)
    const hugeErrorInfo = await inspect(hugeError)
    await expect(
      h.router!.dispatch({
        connectionId: noneInfo.connectionId,
        registrationId: 'reg_none',
        registrationEpoch: 1,
        expectedBinding: noneInfo.binding!,
        request: workerRequest('observe', h.defaultId, 'req_none')
      })
    ).resolves.toMatchObject({ status: 'cancelled', code: 'handler_unavailable', dispatched: true })
    await expect(
      h.router!.dispatch({
        connectionId: throwInfo.connectionId,
        registrationId: 'reg_throw',
        registrationEpoch: 1,
        expectedBinding: throwInfo.binding!,
        request: workerRequest('act', h.defaultId, 'req_throw')
      })
    ).resolves.toMatchObject({ status: 'unknown-effect', dispatched: true, code: 'handler_error' })
    await expect(
      h.router!.dispatch({
        connectionId: malformedInfo.connectionId,
        registrationId: 'reg_bad',
        registrationEpoch: 1,
        expectedBinding: malformedInfo.binding!,
        request: workerRequest('observe', h.defaultId, 'req_bad')
      })
    ).resolves.toMatchObject({ status: 'cancelled', code: 'malformed_command', dispatched: true })
    await expect(
      h.router!.dispatch({
        connectionId: malformedInfo.connectionId,
        registrationId: 'reg_bad_mutation',
        registrationEpoch: 1,
        expectedBinding: malformedInfo.binding!,
        request: workerRequest('act', h.defaultId, 'req_bad_mutation')
      })
    ).resolves.toMatchObject({ status: 'unknown-effect', code: 'malformed_command', dispatched: true })
    await expect(
      h.router!.dispatch({
        connectionId: oversizeInfo.connectionId,
        registrationId: 'reg_big',
        registrationEpoch: 1,
        expectedBinding: oversizeInfo.binding!,
        request: workerRequest('observe', h.defaultId, 'req_big')
      })
    ).resolves.toMatchObject({ status: 'cancelled', code: 'command_too_large', dispatched: true })
    const boundedError = await h.router!.dispatch({
      connectionId: hugeErrorInfo.connectionId,
      registrationId: 'reg_huge_error', registrationEpoch: 1,
      expectedBinding: hugeErrorInfo.binding!, request: workerRequest('observe', h.defaultId, 'req_huge_error')
    })
    expect(boundedError).toMatchObject({ status: 'cancelled', code: 'handler_error', dispatched: true })
    expect((boundedError as { message: string }).message).toHaveLength(4096)
    await h.stop([none, throwing, malformed, oversize, hugeError])
  })

  it('aborts before dispatch without sending and after dispatch without retrying the mutation', async () => {
    const h = await startHarness()
    let launches = 0
    const entered = deferred()
    const hold = deferred()
    const alice = await bindGui(h.home, h.endpoint, h.defaultId, async (command, { signal }) => {
      launches += 1
      entered.resolve()
      await Promise.race([
        hold.promise,
        new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      ])
      return okResult(command.request.id)
    })
    const info = await inspect(alice)
    const before = new AbortController()
    before.abort()
    await expect(
      h.router!.dispatch({
        connectionId: info.connectionId,
        registrationId: 'reg_pre',
        registrationEpoch: 1,
        expectedBinding: info.binding!,
        request: workerRequest('act', h.defaultId, 'req_pre'),
        signal: before.signal
      })
    ).resolves.toMatchObject({ status: 'cancelled', dispatched: false, code: 'cancelled' })
    expect(launches).toBe(0)
    const after = new AbortController()
    const pending = h.router!.dispatch({
      connectionId: info.connectionId,
      registrationId: 'reg_post',
      registrationEpoch: 1,
      expectedBinding: info.binding!,
      request: workerRequest('act', h.defaultId, 'req_post'),
      signal: after.signal,
      timeoutMs: 10_000
    })
    await entered.promise
    expect(launches).toBe(1)
    after.abort()
    await expect(pending).resolves.toMatchObject({ status: 'unknown-effect', dispatched: true, code: 'cancelled' })
    expect(launches).toBe(1)
    hold.resolve()
    await vi.waitFor(() => expect(h.router!.getActiveCount()).toBe(0))
    await h.stop([alice])
  })

  it('does not let a late result after reconnect resolve a new command, and does not retry a lost ack', async () => {
    const h = await startHarness()
    const oldEntered = deferred()
    const oldRelease = deferred()
    const newEntered = deferred()
    const newRelease = deferred()
    const client = guiClient(h.home, h.endpoint, [BROWSER_ATTACHED_V1_CAPABILITY])
    let generation = 0
    client.setAttachedBrowserCommandHandler(async (command, { signal }) => {
      void signal
      generation += 1
      if (generation === 1) {
        oldEntered.resolve()
        await oldRelease.promise
        return okResult(command.request.id, { wave: 'old' })
      }
      newEntered.resolve()
      await newRelease.promise
      return okResult(command.request.id, { wave: 'new' })
    })
    await client.connect()
    await client.request('profiles.bind', { profile: h.defaultId })
    const firstInfo = await inspect(client)
    const first = h.router!.dispatch({
      connectionId: firstInfo.connectionId,
      registrationId: 'reg_old',
      registrationEpoch: 1,
      expectedBinding: firstInfo.binding!,
      request: workerRequest('act', h.defaultId, 'req_old_wave'),
      timeoutMs: 30
    })
    await oldEntered.promise
    const firstResult = await first
    expect(firstResult.status).toBe('unknown-effect')
    expect(h.router!.getActiveCount()).toBe(1)
    expect(generation).toBe(1)
    await client.close()
    await vi.waitFor(() => expect(h.router!.getActiveCount()).toBe(0))
    await client.connect()
    await client.request('profiles.bind', { profile: h.defaultId })
    const secondInfo = await inspect(client)
    expect(secondInfo.connectionId).not.toBe(firstInfo.connectionId)
    const second = h.router!.dispatch({
      connectionId: secondInfo.connectionId,
      registrationId: 'reg_new',
      registrationEpoch: 1,
      expectedBinding: secondInfo.binding!,
      request: workerRequest('act', h.defaultId, 'req_new_wave')
    })
    await newEntered.promise
    oldRelease.resolve()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(h.router!.getActiveCount()).toBe(1)
    newRelease.resolve()
    await expect(second).resolves.toMatchObject({
      status: 'completed',
      response: { id: 'req_new_wave', result: { wave: 'new' } }
    })
    expect(generation).toBe(2)
    await h.stop([client])
  })

  it('rejects forged cross-client replies and unknown-method command frames fail closed', async () => {
    const h = await startHarness()
    const entered = deferred()
    const release = deferred()
    let commandId = ''
    const target = await bindGui(h.home, h.endpoint, h.defaultId, async (command) => {
      commandId = command.commandId
      entered.resolve()
      await release.promise
      return okResult(command.request.id, { from: 'target' })
    })
    const sibling = await bindGui(h.home, h.endpoint, h.defaultId, async (command) =>
      okResult(command.request.id, { from: 'sibling' })
    )
    const info = await inspect(target)
    const pending = h.router!.dispatch({
      connectionId: info.connectionId,
      registrationId: 'reg_forge',
      registrationEpoch: 1,
      expectedBinding: info.binding!,
      request: workerRequest('observe', h.defaultId, 'req_forge')
    })
    await entered.promise
    await writeRaw(h.endpoint, {
      kind: 'hello',
      protocolVersion: MMS_PROTOCOL_VERSION,
      ownerToken: OWNER_TOKEN,
      clientType: 'gui',
      requestedCapabilities: [PROFILES_V1_CAPABILITY, BROWSER_ATTACHED_V1_CAPABILITY]
    }, {
      kind: 'client_res',
      id: commandId,
      registrationId: 'reg_forge',
      registrationEpoch: 1,
      requestId: 'req_forge',
      ok: true,
      result: okResult('req_forge', { from: 'forged' })
    })
    expect(h.router!.getActiveCount()).toBe(1)
    release.resolve()
    await expect(pending).resolves.toMatchObject({
      status: 'completed',
      response: { result: { from: 'target' } }
    })
    await sibling.close()
    await h.stop([target, sibling])
  })

  it('enforces the global outstanding command maximum', async () => {
    const router = new ConnectionCommandRouter()
    const sent: string[] = []
    const binding = { profileId: 'profile_1', epoch: 1 }
    const attach = (connectionId: string): void => {
      router.attach({
        connectionId,
        clientType: 'gui',
        capabilities: new Set([BROWSER_ATTACHED_V1_CAPABILITY]),
        currentBinding: () => binding,
        send: (envelope) => {
          sent.push(envelope.kind)
          return true
        }
      })
    }
    const connectionIds = ['conn_a', 'conn_b', 'conn_c', 'conn_d', 'conn_e']
    for (const id of connectionIds) attach(id)
    await expect(router.dispatch({
      connectionId: 'conn_a', registrationId: 'reg_g', registrationEpoch: 1,
      expectedBinding: binding, request: workerRequest('observe', 'profile_1', 'req_bad_timeout'), timeoutMs: 120_001
    })).resolves.toMatchObject({ status: 'rejected', code: 'malformed_command', dispatched: false })
    expect(sent).toHaveLength(0)
    const hanging: Promise<unknown>[] = []
    for (let i = 0; i < MMS_PROTOCOL_MAX_GLOBAL_COMMANDS; i += 1) {
      const connectionId = connectionIds[Math.floor(i / MMS_PROTOCOL_MAX_CONNECTION_COMMANDS)]!
      hanging.push(
        router.dispatch({
          connectionId,
          registrationId: 'reg_g',
          registrationEpoch: 1,
          expectedBinding: binding,
          request: workerRequest('observe', 'profile_1', `req_g_${i}`),
          timeoutMs: 5_000
        })
      )
    }
    expect(router.getActiveCount()).toBe(MMS_PROTOCOL_MAX_GLOBAL_COMMANDS)
    await expect(
      router.dispatch({
        connectionId: 'conn_e',
        registrationId: 'reg_g',
        registrationEpoch: 1,
        expectedBinding: binding,
        request: workerRequest('observe', 'profile_1', 'req_g_overflow')
      })
    ).resolves.toMatchObject({ status: 'rejected', code: 'backpressure' })
    for (const id of connectionIds) router.revoke(id, 'close')
    await Promise.all(hanging)
    expect(router.getActiveCount()).toBe(0)
    expect(sent.filter((kind) => kind === 'server_req')).toHaveLength(MMS_PROTOCOL_MAX_GLOBAL_COMMANDS)
  })
})

async function writeRaw(endpoint: string, hello: unknown, extra: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket: Socket = createConnection(endpoint)
    const dec = new FrameDecoder()
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('raw hello timeout'))
    }, 5_000)
    let authed = false
    socket.on('connect', () => {
      socket.write(encodeFrame(hello))
    })
    socket.on('data', (chunk) => {
      dec.push(chunk)
      for (const frame of dec.shiftAll()) {
        const env = parseEnvelope(frame)
        if (!authed && (env?.kind === 'hello_ok' || env?.kind === 'hello_err')) {
          if (env.kind === 'hello_err') {
            clearTimeout(timer)
            socket.destroy()
            reject(new Error(`raw hello failed: ${env.code}`))
            return
          }
          authed = true
          socket.write(encodeFrame(extra), () => {
            setTimeout(() => {
              clearTimeout(timer)
              socket.destroy()
              resolve()
            }, 50)
          })
        }
      }
    })
    socket.on('error', reject)
  })
}

async function waitReceiverIdle(receiver: ClientCommandReceiver): Promise<void> {
  const started = Date.now()
  while (receiver.getActiveCount() > 0) {
    if (Date.now() - started > 3_000) throw new Error('command receiver did not settle')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
