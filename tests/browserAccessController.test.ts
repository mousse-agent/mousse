import { describe, expect, it } from 'vitest'
import { BrowserAccessController } from '../src/mms/browser/BrowserAccessController'
import { dispatchBrowserTool } from '../src/mms/orchestrator/browser/dispatch'
import type { BrowserExecutionBinding } from '../src/mms/orchestrator/browser/binding'

describe('profile browser access', () => {
  it('keeps the tool call pending and reports Allow even if the target subsequently fails', async () => {
    const access = new BrowserAccessController()
    const binding: BrowserExecutionBinding = {
      mode: 'structured',
      execution: { profileId: 'profile', threadId: 'thread', turnId: 'turn', actor: { kind: 'main' }, source: 'gui', policySnapshotId: 'policy', cancellationId: 'cancel' },
      policy: { version: 1, id: 'policy', profileId: 'profile', allowedTools: ['browser_open'], allowedCapabilities: ['browser.session'], allowedEffects: ['external'], approvalEffects: [], maxToolCalls: 10, maxElapsedMs: 60_000, maxArtifactBytes: 1024 }
    }
    let resolved = false
    const operation = dispatchBrowserTool({ binding, name: 'browser_open', args: {}, port: {
      requestAccess: (context, signal) => access.request(context.threadId, signal),
      resolveTarget: () => { resolved = true; throw new Error('Tab disconnected') },
      dispatch: async () => { throw new Error('must not dispatch') }
    } })
    expect(resolved).toBe(false)
    expect(access.status().pending).toHaveLength(1)
    access.respond(access.status().pending[0].requestId, true)
    const result = await operation
    expect(result.text).toContain('The user selected Allow')
    expect(result.text).toContain('Tab disconnected')
    expect(result.isError).toBe(true)
  })

  it('waits for Allow and grants subsequent requests until revoked', async () => {
    const access = new BrowserAccessController()
    let settled = false
    const waiting = access.request('thread-one').then((result) => { settled = true; return result })
    await Promise.resolve()
    expect(settled).toBe(false)
    const state = access.status()
    expect(state.allowed).toBe(false)
    expect(state.pending).toHaveLength(1)
    access.respond(state.pending[0].requestId, true)
    await expect(waiting).resolves.toBe('allowed')
    await expect(access.request('thread-two')).resolves.toBe('already-allowed')
    const grantedSignal = access.signal
    access.set(false)
    expect(grantedSignal.aborted).toBe(true)
    const next = access.request('thread-two')
    access.set(true)
    await expect(next).resolves.toBe('allowed')
    expect(access.signal.aborted).toBe(false)
  })

  it('reports the exact Deny decision to all waiting agents without granting access', async () => {
    const access = new BrowserAccessController()
    const one = access.request('one')
    const two = access.request('two')
    const assertions = [one, two].map((request) => expect(request).rejects.toMatchObject({ code: 'policy_denied', details: { userResponse: 'deny' } }))
    access.respond(access.status().pending[0].requestId, false)
    await Promise.all(assertions)
    expect(access.status()).toEqual({ allowed: false, pending: [] })
  })

  it('removes cancelled prompts and rejects late responses', async () => {
    const access = new BrowserAccessController()
    const abort = new AbortController()
    const waiting = access.request('one', abort.signal)
    const requestId = access.status().pending[0].requestId
    const assertion = expect(waiting).rejects.toMatchObject({ code: 'cancelled' })
    abort.abort()
    await assertion
    expect(access.status().pending).toEqual([])
    expect(() => access.respond(requestId, true)).toThrow(/no longer pending/)
    expect(access.status().allowed).toBe(false)
  })

  it('isolates profiles and cancels waiting requests on shutdown', async () => {
    const alice = new BrowserAccessController()
    const bob = new BrowserAccessController()
    alice.set(true)
    const waiting = bob.request('bob-thread')
    const assertion = expect(waiting).rejects.toMatchObject({ code: 'cancelled' })
    expect(bob.status().allowed).toBe(false)
    bob.dispose()
    await assertion
    expect(alice.status().allowed).toBe(true)
  })
})
