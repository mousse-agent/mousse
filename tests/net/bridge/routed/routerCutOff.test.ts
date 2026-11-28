/**
 * A computer cut off for its version (pair-with-IP design §5) gets nothing routed to it: no call, no read of a
 * thread's copy kept here, no hold of a thread in view, even while a session from before the refusal is still open.
 */
import { describe, expect, it, vi } from 'vitest'
import { ThreadRouter } from '../../../../src/mms/bridge/routed/ThreadRouter'
import type { HandlerContext } from '../../../../src/mms/protocol/handlers'
import { newId, type NodeId } from '../../../../src/shared/net'
import { qualifyId } from '../../../../src/shared/threadRef'

const SELF = newId('node')
const NODE = newId('node')
const window = {
  mms: {} as never,
  globalSequence: () => 0,
  connection: { id: 'gui-1', clientType: 'gui', capabilities: new Set() }
} as unknown as HandlerContext

function router(cutOff: 'there' | 'here' | undefined) {
  const call = vi.fn(async () => ({}))
  const routed = new ThreadRouter({
    services: {} as never,
    net: { runtime: () => ({ identity: { self: () => ({ node: SELF }) } }) } as never,
    // The old session is still up: online, with a client.
    peers: {
      client: () => ({}) as never,
      computers: () => [{ node: NODE, name: 'Studio' }],
      online: () => true,
      name: () => 'Studio',
      cutOff: (node: NodeId) => (node === NODE ? cutOff : undefined)
    },
    enabled: () => true,
    hub: {} as never,
    signal: new AbortController().signal,
    client: { call } as never
  })
  return { routed, call }
}

describe('a computer cut off for its version', () => {
  // Inputs: an action, a read, the thread's copy kept here, a hold of a thread in view; either computer older.
  const refused = { code: 'computer_offline', details: { node: NODE, needsUpdate: 'there' } }
  it.each([
    ['an action', 'orchestrator.steer', { threadId: qualifyId(NODE, 't1'), text: 'hi' }],
    ['a read', 'threads.get', { threadId: qualifyId(NODE, 't1') }],
    ['its thread’s copy kept here', 'thread.snapshot', { threadId: qualifyId(NODE, 't1') }]
  ])('refuses %s without asking it', async (_label, method, params) => {
    const { routed, call } = router('there')
    await expect(routed.dispatch(window, method, params)).rejects.toMatchObject(refused)
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses holding one of its threads in view, and names this computer when it is the older one', async () => {
    const { routed } = router('here')
    await expect(routed.focus(window, qualifyId(NODE, 't1'), true)).rejects.toMatchObject({
      code: 'computer_offline',
      message: 'Update Mousse here to use Studio.'
    })
  })

  it('routes as before once it is not', async () => {
    const { routed, call } = router(undefined)
    await routed.dispatch(window, 'orchestrator.steer', { threadId: qualifyId(NODE, 't1'), text: 'hi' })
    expect(call).toHaveBeenCalledWith(NODE, 'orchestrator.steer', expect.objectContaining({ threadId: 't1' }), expect.any(Object))
  })
})
