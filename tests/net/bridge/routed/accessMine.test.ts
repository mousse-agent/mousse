/**
 * `bridge.access.mine`: one computer asks another what it may do there, and Settings → Devices shows the answer under
 * "This computer may do there". Over two real daemons linked by Bridge (the keeper and a member), each answer is
 * checked against what the member's real calls then get: the answer comes from the same checks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NetError, newId } from '../../../../src/shared/net'
import { accessPreset } from '../../../../src/shared/net/accessPresets'
import type { BridgeAccessThere } from '../../../../src/shared/net/local'
import { cleanupAll, linked } from './routerFixture'

let t: Awaited<ReturnType<typeof linked>>
beforeAll(async () => {
  t = await linked()
}, 120_000)
afterAll(cleanupAll)

/** What the member's Devices page is told about the keeper. */
const there = async () => (await t.caller.net.request('bridge.access.there', { node: t.node })) as BridgeAccessThere
const access = async () => {
  const answer = await there()
  if (answer.state !== 'known') throw new Error(`Expected an answer, got ${JSON.stringify(answer)}`)
  return answer.access
}
/** A real call from the member to the keeper. */
const call = (method: string, params: unknown) =>
  t.caller.net.session(t.node).rpc(method, params, { id: newId('rpc'), deadlineMs: 15_000, idem: newId('rpc') })
/** The keeper's registered remote methods, to stand in for another build. */
const registry = () =>
  (t.owner.net.runtime().rpc as unknown as { registry: Map<string, { handle: (...args: unknown[]) => Promise<unknown> }> }).registry
const refusedWith = (reason: string) => ({ code: 'forbidden', details: { reason } })

describe('what this computer may do there', () => {
  it('reports the defaults, and the work they allow passes', async () => {
    expect(await access()).toMatchObject({ v: 1, blocked: false, threads: true, work: true, terminal: false, editor: false, bots: 'use', maxPermissionMode: 'accept_edits' })
    const thread = t.thread('Plan')
    expect(await call('routed.threads.pin', { threadId: thread.id, pinned: true })).toMatchObject({ ok: true })
  }, 60_000)

  it('after the keeper picks View and chat, reports work off, and a work call is refused while reads pass', async () => {
    await t.owner.net.request('bridge.policy', { node: t.callerNode, ...accessPreset('view').fields })
    try {
      expect(await access()).toMatchObject({ threads: true, work: false, terminal: false, editor: false })
      const thread = t.thread('Read only')
      await expect(call('routed.threads.rename', { threadId: thread.id, name: 'Changed' })).rejects.toMatchObject(refusedWith('work_off'))
      expect(await call('routed.threads.list', {})).toMatchObject({ ok: true })
    } finally {
      await t.owner.net.request('bridge.policy', { node: t.callerNode, ...accessPreset('work').fields })
    }
  }, 60_000)

  it('after the keeper picks Full control, reports terminals and editor connections on', async () => {
    await t.owner.net.request('bridge.policy', { node: t.callerNode, ...accessPreset('full').fields })
    try {
      expect(await access()).toMatchObject({ threads: true, work: true, terminal: true, editor: true, maxPermissionMode: 'full', agentReach: 'all', bots: 'full' })
      // The bot level on its own: reported as set, and the rest stays Full control.
      await t.owner.net.request('bridge.policy', { node: t.callerNode, bots: 'off' })
      expect(await access()).toMatchObject({ terminal: true, editor: true, maxPermissionMode: 'full', bots: 'off' })
    } finally {
      await t.owner.net.request('bridge.policy', { node: t.callerNode, ...accessPreset('work').fields })
    }
  }, 60_000)

  it('with "Let my other devices work here" off on the keeper, reports no threads, and thread calls are refused', async () => {
    await t.owner.net.request('bridge.workOnThreads', { enabled: false })
    try {
      expect(await access()).toMatchObject({ threads: false, work: false, terminal: false, editor: false })
      await expect(call('routed.threads.list', {})).rejects.toMatchObject(refusedWith('setting_off'))
    } finally {
      await t.owner.net.request('bridge.workOnThreads', { enabled: true })
    }
  }, 60_000)

  it('blocked there, says so, and every thread call is refused', async () => {
    await t.owner.net.request('bridge.policy', { node: t.callerNode, blocked: true })
    try {
      expect(await access()).toMatchObject({ blocked: true, threads: false, work: false })
      await expect(call('routed.threads.list', {})).rejects.toMatchObject(refusedWith('blocked'))
    } finally {
      await t.owner.net.request('bridge.policy', { node: t.callerNode, blocked: false })
    }
  }, 60_000)

  it('not connected there, the call is refused and the page is told so', async () => {
    await t.owner.net.request('bridge.disconnect', { node: t.callerNode })
    try {
      await expect(call('bridge.access.mine', {})).rejects.toMatchObject(refusedWith('not_connected'))
      expect(await there()).toEqual({ state: 'not_connected' })
    } finally {
      await t.owner.net.request('bridge.connect', { node: t.callerNode })
    }
    expect(await access()).toMatchObject({ work: true })
  }, 60_000)

  it('a refusal with no reason from a computer that has the call is a refusal, not an older build', async () => {
    // As a grant there that does not cover the call: refused with no reason, as the dispatcher refuses a missing capability.
    const entry = registry().get('bridge.access.mine')!
    const handle = entry.handle
    entry.handle = async () => { throw new NetError('forbidden') }
    try {
      expect(await there()).toEqual({ state: 'refused' })
    } finally {
      entry.handle = handle
    }
  }, 60_000)

  it('a computer on a build from before bot levels says on or off, read as a level', async () => {
    const entry = registry().get('bridge.access.mine')!
    const handle = entry.handle
    try {
      for (const [bots, work, level] of [[true, true, 'full'], [true, false, 'use'], [false, true, 'off']] as const) {
        entry.handle = async (...args) => ({ ...((await handle(...args)) as object), bots, work })
        expect(await there(), `${bots}, work ${work}`).toMatchObject({ state: 'known', access: { bots: level } })
      }
    } finally {
      entry.handle = handle
    }
  }, 60_000)

  it('a computer on a build from before the call is unknown', async () => {
    // As a build from before the call: the keeper does not have it, and its net.info does not name it.
    const info = registry().get('net.info')!
    const handle = info.handle
    info.handle = async (...args) => { const { access: _access, ...older } = (await handle(...args)) as Record<string, unknown>; return older }
    registry().delete('bridge.access.mine')
    expect(await there()).toEqual({ state: 'unknown', reason: 'older' })
  }, 60_000)
})
