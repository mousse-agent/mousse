import { describe, expect, it } from 'vitest'
import { NetSyncSession } from '../../../src/mms/net/sync/session'
import { NetError } from '../../../src/shared/net/errors'
import type { Clock } from '../../../src/mms/net/contracts'

/** A clock whose timers run only when the test advances it. */
function manualClock() {
  let time = 0
  const timers: Array<{ at: number; callback: () => void; live: boolean }> = []
  const clock: Clock = {
    now: () => time,
    monotonic: () => time,
    setTimeout(callback, ms) {
      const timer = { at: time + ms, callback, live: true }
      timers.push(timer)
      return { cancel: () => void (timer.live = false) }
    }
  }
  const advance = (ms: number) => {
    time += ms
    for (const timer of timers.filter((entry) => entry.live && entry.at <= time)) {
      timer.live = false
      timer.callback()
    }
  }
  return { clock, advance }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** The parts of a session that answering one RPC touches, over a control queue that is full. */
function fakeSession(options: {
  request: (progress: (data: unknown) => void | Promise<void>) => Promise<unknown>
  full: { value: boolean }
}) {
  const { clock, advance } = manualClock()
  const sent: Array<{ t: string }> = []
  const session = {
    rpcControllers: new Map<string, AbortController>(),
    clock,
    peer: {},
    options: {
      rpc: {
        request: (_h: unknown, _peer: unknown, _signal: AbortSignal, progress: never) =>
          options.request(progress)
      }
    },
    send: async (message: { t: string }) => {
      if (options.full.value) throw new NetError('rate_limited')
      sent.push(message)
    }
  }
  const serve = (deadlineMs = 60_000) =>
    (
      NetSyncSession.prototype as unknown as {
        serveRpc(this: unknown, request: unknown): Promise<void>
      }
    ).serveRpc.call(
      Object.assign(session, {
        sendRpcResult: (NetSyncSession.prototype as unknown as { sendRpcResult: unknown })
          .sendRpcResult
      }),
      { t: 'rpc.request', id: 'rpc_1', deadlineMs }
    )
  return { serve, sent, advance, session }
}

describe('answering an RPC over a full control queue', () => {
  it('holds the answer until the queue has room instead of failing the session', async () => {
    const full = { value: true }
    const { serve, sent, advance } = fakeSession({
      full,
      request: async (progress) => {
        // The queue refuses the piece; the handler ends its request with a failure.
        await Promise.resolve(progress({ piece: 1 })).catch(() => undefined)
        throw new NetError('rate_limited')
      }
    })
    let outcome: 'pending' | 'done' | Error = 'pending'
    void serve().then(
      () => (outcome = 'done'),
      (error) => (outcome = error)
    )
    await flush()
    advance(50)
    await flush()
    expect(outcome).toBe('pending')
    expect(sent).toEqual([])

    full.value = false
    advance(50)
    await flush()
    expect(outcome).toBe('done')
    expect(sent).toMatchObject([{ t: 'rpc.result', id: 'rpc_1', error: { code: 'rate_limited' } }])
  })

  it('stops waiting for room once the request has ended, without failing the session', async () => {
    const full = { value: true }
    const { serve, sent, advance } = fakeSession({ full, request: async () => ({ ok: true }) })
    let outcome: 'pending' | 'done' | Error = 'pending'
    void serve(1_000).then(
      () => (outcome = 'done'),
      (error) => (outcome = error)
    )
    await flush()
    expect(outcome).toBe('pending')
    advance(1_000)
    await flush()
    expect(outcome).toBe('done')
    expect(sent).toEqual([])
  })

  it('still raises other send failures', async () => {
    const { serve, session } = fakeSession({
      full: { value: false },
      request: async () => ({ ok: true })
    })
    session.send = async () => {
      throw new NetError('peer_offline')
    }
    await expect(serve()).rejects.toMatchObject({ code: 'peer_offline' })
  })
})
