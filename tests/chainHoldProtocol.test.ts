/**
 * `threads.chainHold` (issue #1443): only a person at a Mousse window answers a chain of agent messages held at its
 * budget, on this computer or on another of theirs. The CLI, an automation, a test client or a call with no connection of its own is refused before anything is
 * sent or dropped. What Continue and Stop do is in tests/run/threadActionsDaemon.test.ts.
 */
import { expect, it, vi } from 'vitest'
import { dispatchMethod, type HandlerContext } from '../src/mms/protocol/handlers'

const answered = { chainId: 'chain:run-1', sent: 1, stopped: 0, failed: 0 }

function contextFrom(clientType: string | undefined, bridgeCaller?: { node: string; maxPermissionMode: string }) {
  const answerChainHold = vi.fn(async () => answered)
  const ctx = {
    mms: { threads: { getThread: () => ({ id: 't1' }) }, orchestrator: { answerChainHold } },
    globalSequence: () => 0,
    ...(clientType ? { connection: { id: `${clientType}-1`, clientType, capabilities: new Set(), ...(bridgeCaller ? { bridgeCaller } : {}) } } : {})
  } as unknown as HandlerContext
  return { ctx, answerChainHold }
}

const params = { threadId: 't1', chainId: 'chain:run-1', holdId: 'hold-1', answer: 'continue' }

it.each(['cli', 'test', 'unknown', undefined])('refuses an answer from %s and leaves the chain as it is', async (clientType) => {
  const { ctx, answerChainHold } = contextFrom(clientType)
  await expect(dispatchMethod(ctx, 'threads.chainHold', params)).rejects.toMatchObject({ code: 'forbidden' })
  expect(answerChainHold).not.toHaveBeenCalled()
})

it("takes the answer of a person at a Mousse window, for the card's batch", async () => {
  const { ctx, answerChainHold } = contextFrom('gui')
  await expect(dispatchMethod(ctx, 'threads.chainHold', params)).resolves.toEqual(answered)
  expect(answerChainHold).toHaveBeenCalledWith('t1', 'chain:run-1', 'continue', { holdId: 'hold-1' })
  const { holdId: _batch, ...unnamed } = params
  await expect(dispatchMethod(ctx, 'threads.chainHold', unnamed)).rejects.toMatchObject({ code: 'invalid_params' })
})

// A window on another of the person's computers: its router marks the call, and the device's limit here goes with it.
it("takes a routed answer only with the window mark its router sets, held to the device's limit", async () => {
  const device = { node: 'laptop', maxPermissionMode: 'ask' }
  const unmarked = contextFrom('bridge', device)
  await expect(dispatchMethod(unmarked.ctx, 'threads.chainHold', params)).rejects.toMatchObject({ code: 'forbidden' })
  expect(unmarked.answerChainHold).not.toHaveBeenCalled()
  const marked = contextFrom('bridge', device)
  await expect(dispatchMethod(marked.ctx, 'threads.chainHold', { ...params, window: 'person' })).resolves.toEqual(answered)
  expect(marked.answerChainHold).toHaveBeenCalledWith('t1', 'chain:run-1', 'continue', { holdId: 'hold-1', deviceLimit: 'ask' })
  // The mark is a routed call's: a window here does not send it.
  await expect(dispatchMethod(contextFrom('gui').ctx, 'threads.chainHold', { ...params, window: 'person' })).rejects.toMatchObject({ code: 'invalid_params' })
})
