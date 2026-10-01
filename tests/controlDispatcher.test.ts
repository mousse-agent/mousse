import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import { RemoteSessionDispatcher, type RemoteMethodExecutionHandler } from '../src/mms/control/relay/remoteDispatcher'
import { IdempotencyStore } from '../src/mms/control/storage/idempotencyStore'
import type { ControlEnvelope, ControlRequestEnvelope, ControlResponseEnvelope, PairingGrant } from '../src/shared/controlTypes'
import { MmsEventBus } from '../src/mms/events'

describe('Control Protocol 2.0 - RemoteSessionDispatcher', () => {
  let grant: PairingGrant
  let sentEnvelopes: ControlEnvelope[]
  let mockExecutor: RemoteMethodExecutionHandler
  let idempotencyStore: IdempotencyStore
  let eventBus: MmsEventBus

  beforeEach(() => {
    sentEnvelopes = []
    idempotencyStore = new IdempotencyStore(24 * 3600_000)
    eventBus = new MmsEventBus()
    grant = {
      pairingId: 'pair-test-dispatcher',
      mobileDeviceId: 'dev-mobile-1',
      mobileDeviceName: 'iPhone 15',
      mobileStaticPublicKey: randomBytes(32).toString('base64'),
      grantedScopes: ['mousse:read', 'mousse:chat'],
      createdAt: new Date().toISOString(),
      status: 'active',
      receiptSignature: randomBytes(64).toString('base64')
    }
    mockExecutor = {
      execute: vi.fn(async (method: string, params: unknown) => {
        if (method === 'threads.get') {
          return { id: 'thread-1', title: 'Test Thread', secretKey: 'super-secret-key-to-redact' }
        }
        if (method === 'orchestrator.send') {
          return { turnId: 'turn-123', status: 'started' }
        }
        if (method === 'files.write') {
          return { success: true }
        }
        return { ok: true }
      })
    }
  })

  function createDispatcher(overrides?: { grant?: PairingGrant }) {
    return new RemoteSessionDispatcher({
      grant: overrides?.grant || grant,
      executor: mockExecutor,
      idempotencyStore,
      eventBus,
      instanceId: 'mms-instance-unit-test',
      sendEnvelope: (env) => sentEnvelopes.push(env)
    })
  }

  it('allows allowlisted methods within granted scopes (mousse:read and mousse:chat)', async () => {
    const dispatcher = createDispatcher()

    const readReq: ControlRequestEnvelope = {
      kind: 'request',
      id: 'req-read-1',
      method: 'threads.get',
      params: { threadId: 'thread-1' }
    }
    await dispatcher.handleEnvelope(readReq)

    expect(sentEnvelopes.length).toBe(1)
    const resp = sentEnvelopes[0] as ControlResponseEnvelope
    expect(resp.kind).toBe('response')
    expect(resp.id).toBe('req-read-1')
    expect(resp.ok).toBe(true)

    // Verify secret was redacted in result!
    const resData = resp.result as { secretKey: string }
    expect(resData.secretKey).toBe('***REDACTED***')
  })

  it('denies execution when required scope is not in grantedScopes', async () => {
    // Grant only has read and chat, but files.write requires mousse:write
    const dispatcher = createDispatcher()

    const writeReq: ControlRequestEnvelope = {
      kind: 'request',
      id: 'req-write-1',
      method: 'files.write',
      params: { path: '/tmp/test.txt', content: 'hello' }
    }
    await dispatcher.handleEnvelope(writeReq)

    expect(sentEnvelopes.length).toBe(1)
    const resp = sentEnvelopes[0] as ControlResponseEnvelope
    expect(resp.ok).toBe(false)
    expect(resp.error?.code).toBe('PERMISSION_DENIED')
    expect(mockExecutor.execute).not.toHaveBeenCalled()
  })

  it('strictly rejects non-allowlisted and forbidden methods', async () => {
    const dispatcher = createDispatcher()

    // 1. Explicitly forbidden method: provider.login
    await dispatcher.handleEnvelope({
      kind: 'request',
      id: 'req-forbidden-1',
      method: 'provider.login',
      params: {}
    })
    const resp1 = sentEnvelopes[0] as ControlResponseEnvelope
    expect(resp1.ok).toBe(false)
    expect(resp1.error?.code).toBe('METHOD_FORBIDDEN')

    // 2. Internal / unmapped method
    sentEnvelopes = []
    await dispatcher.handleEnvelope({
      kind: 'request',
      id: 'req-unknown-1',
      method: 'daemon.evalInternalCode',
      params: {}
    })
    const resp2 = sentEnvelopes[0] as ControlResponseEnvelope
    expect(resp2.ok).toBe(false)
    expect(resp2.error?.code).toBe('METHOD_FORBIDDEN')
  })

  it('immediately denies any request from a revoked pairing', async () => {
    const revokedGrant: PairingGrant = {
      ...grant,
      status: 'revoked'
    }
    const dispatcher = createDispatcher({ grant: revokedGrant })

    await dispatcher.handleEnvelope({
      kind: 'request',
      id: 'req-revoked',
      method: 'threads.get',
      params: { threadId: 'thread-1' }
    })

    expect(sentEnvelopes.length).toBe(1)
    const resp = sentEnvelopes[0] as ControlResponseEnvelope
    expect(resp.ok).toBe(false)
    expect(resp.error?.code).toBe('DEVICE_REVOKED')
  })

  it('caches and dedupes idempotent mutation requests with idempotencyKey', async () => {
    const dispatcher = createDispatcher()

    const req1: ControlRequestEnvelope = {
      kind: 'request',
      id: 'req-idem-1',
      idempotencyKey: 'mut-key-100',
      method: 'orchestrator.send',
      params: { message: 'Run unit test' }
    }

    await dispatcher.handleEnvelope(req1)
    expect(sentEnvelopes.length).toBe(1)
    const resp1 = sentEnvelopes[0] as ControlResponseEnvelope
    expect(resp1.ok).toBe(true)
    expect(mockExecutor.execute).toHaveBeenCalledTimes(1)

    // Repeat identical request with same idempotencyKey
    sentEnvelopes = []
    const req2: ControlRequestEnvelope = {
      kind: 'request',
      id: 'req-idem-2',
      idempotencyKey: 'mut-key-100',
      method: 'orchestrator.send',
      params: { message: 'Run unit test' }
    }

    await dispatcher.handleEnvelope(req2)
    expect(sentEnvelopes.length).toBe(1)
    const resp2 = sentEnvelopes[0] as ControlResponseEnvelope
    expect(resp2.ok).toBe(true)
    expect(resp2.result).toEqual(resp1.result)
    // Executor should NOT have been called a second time!
    expect(mockExecutor.execute).toHaveBeenCalledTimes(1)
  })

  it('forwards eventBus events to remote peer and redacts secrets', async () => {
    createDispatcher()

    eventBus.emit({
      channel: 'threads:updated',
      data: {
        threadId: 'thread-101',
        name: 'My Thread',
        apiKey: 'sk-secret-provider-key-1234'
      }
    })

    expect(sentEnvelopes.length).toBe(1)
    const evt = sentEnvelopes[0] as any
    expect(evt.kind).toBe('event')
    expect(evt.eventType || evt.type).toBe('threads:updated')
    expect(evt.sequence).toBeGreaterThanOrEqual(1)
    expect(evt.data.apiKey).toBe('***REDACTED***')
  })

  it('enforces maximum 64 concurrent RPCs and rejects the 65th', async () => {
    let resolveHang: (() => void) | null = null
    const hangingExecutor: RemoteMethodExecutionHandler = {
      execute: () => new Promise((resolve) => {
        resolveHang = () => resolve({ ok: true })
      })
    }

    const dispatcher = new RemoteSessionDispatcher({
      grant,
      executor: hangingExecutor,
      idempotencyStore,
      instanceId: 'test-inst',
      sendEnvelope: (env) => sentEnvelopes.push(env)
    })

    // Launch 64 concurrent requests
    for (let i = 0; i < 64; i++) {
      void dispatcher.handleEnvelope({
        kind: 'request',
        id: `rpc-${i}`,
        method: 'threads.get',
        params: {}
      })
    }

    // Launch the 65th request
    await dispatcher.handleEnvelope({
      kind: 'request',
      id: 'rpc-65-overflow',
      method: 'threads.get',
      params: {}
    })

    const rejectResp = sentEnvelopes.find((e) => (e as ControlResponseEnvelope).id === 'rpc-65-overflow') as ControlResponseEnvelope
    expect(rejectResp).toBeDefined()
    expect(rejectResp.ok).toBe(false)
    expect(rejectResp.error?.code).toBe('RATE_LIMIT_EXCEEDED')

    dispatcher.close()
    if (resolveHang) resolveHang()
  })
})
