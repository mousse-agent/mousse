/**
 * The owner's proof on a send comes only from the connection it arrived on: a Mousse window here, or
 * a routed call from another of the owner's computers. What the caller says (`source`) never makes one.
 */
import { describe, expect, it, vi } from 'vitest'
import { dispatchMethod, type HandlerContext } from '../src/mms/protocol/handlers'

function daemon(connection: Record<string, unknown> | undefined) {
  const send = vi.fn(async () => ({ runId: 'run-1' }))
  const resumePausedRun = vi.fn(async () => ({ ok: true }))
  const thread = { id: 't1', name: 'Chat', createdAt: '', updatedAt: '' }
  const mms = {
    threads: { getThread: (id: string) => (id === 't1' ? thread : undefined) },
    orchestrator: {
      ensureSessionLoaded: async () => undefined,
      getOrCreateSession: () => ({}),
      isActiveTurnRunning: () => false,
      send,
      resumePausedRun
    }
  }
  const ctx = {
    mms,
    globalSequence: () => 1,
    ...(connection ? { connection: { id: 'c', capabilities: new Set(), binding: { profileId: 'p', epoch: 1 }, ...connection } } : {})
  } as unknown as HandlerContext
  const proofOf = (call: unknown[] | undefined) => (call?.[2] as { ownerProof?: unknown } | undefined)?.ownerProof
  return {
    sendProof: async (params: Record<string, unknown> = {}) => {
      await dispatchMethod(ctx, 'orchestrator.send', { threadId: 't1', content: 'hello', clientRequestId: 'r1', ...params })
      return proofOf(send.mock.calls.at(-1))
    },
    resumeProof: async () => {
      await dispatchMethod(ctx, 'runs.resumeNow', { runId: 'run-0' })
      return resumePausedRun.mock.calls.at(-1)?.[1]
    }
  }
}

const BRIDGE_CALLER = { node: 'laptop', user: 'usr_owner', maxPermissionMode: 'full' }

describe('the owner’s proof at ingress', () => {
  it('a window here, and a routed window on another of the owner’s computers, record one', async () => {
    expect(await daemon({ clientType: 'gui' }).sendProof()).toEqual({ via: 'gui' })
    expect(await daemon({ clientType: 'bridge', bridgeCaller: BRIDGE_CALLER }).sendProof()).toEqual({ via: 'bridge', node: 'laptop' })
    expect(await daemon({ clientType: 'gui' }).resumeProof()).toEqual({ via: 'gui' })
    expect(await daemon({ clientType: 'bridge', bridgeCaller: BRIDGE_CALLER }).resumeProof()).toEqual({ via: 'bridge', node: 'laptop' })
  })

  it('the CLI, a bridge without a verified caller, and internal callers record none, whatever source they name', async () => {
    for (const connection of [{ clientType: 'cli' }, { clientType: 'bridge' }, { clientType: 'remote' }, undefined]) {
      const d = daemon(connection)
      expect([connection?.clientType, await d.sendProof({ source: 'gui' })]).toEqual([connection?.clientType, undefined])
      expect([connection?.clientType, await d.resumeProof()]).toEqual([connection?.clientType, undefined])
    }
  })
})
