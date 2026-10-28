/**
 * How long a device's terminal lives on the owner, and who can see it: Net or Bridge turned off, a device that
 * stays away, a block that lands while a shell is starting, and what the owner's own windows are told.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchMethod } from '../../../../src/mms/protocol/handlers'
import { OwnerRoutes } from '../../../../src/mms/bridge/routed/OwnerRoutes'
import { PROJECT_SHELL_AGENT_ID } from '../../../../src/shared/types'
import type { NodeId } from '../../../../src/shared/net'
import { cleanup, resources } from '../hub/fixture'
import { cleanups, cleanupAll, linked } from './routerFixture'
import { fakeShells, type Spawned } from './terminalFixture'
import { repo, routedOwner, testClock } from './routedFixture'

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanup()
  await cleanupAll()
})

type Owner = Awaited<ReturnType<typeof routedOwner>>

const agentId = `${PROJECT_SHELL_AGENT_ID}:tab`
function folderThread(o: Owner) {
  const path = repo()
  const project = o.f.mms.projects.openProject(path)
  return o.thread('Terminal thread', project.id, path)
}
const create = (o: Owner, threadId: string) => o.call('pty.create', { threadId, agentId })
async function another(o: Owner) {
  const t = folderThread(o)
  const reply = await create(o, t.id)
  if (!reply.ok) throw new Error(`pty.create refused: ${reply.error.code}`)
  return { t, ptyId: (reply.result as { ptyId: string }).ptyId }
}
const closes = (o: Owner) =>
  o.audit.recent(50, o.f.callerNode).filter((row) => row.method === 'pty.close')
const window = (o: Owner, method: string, params: Record<string, unknown>) =>
  dispatchMethod(
    {
      mms: o.f.mms,
      globalSequence: () => 0,
      connection: {
        id: 'window-1',
        clientType: 'gui',
        capabilities: new Set(),
        binding: { profileId: o.f.mms.getProfileId(), epoch: 1 },
        lifetime: new AbortController().signal
      }
    },
    method,
    params
  )

describe('turning Net or Bridge off', () => {
  it('ends every device shell, writes its close row, frees the thread, and leaves a true count behind', async () => {
    const o = await routedOwner()
    const spawned = fakeShells(o.f.mms.ptyManager, resources)
    o.policy.set(o.f.callerNode, { terminal: true })
    const first = await another(o)
    await another(o)
    expect(o.routes.terminals.count(o.f.callerNode)).toBe(2)

    await o.routes.close()
    expect(spawned.every((shell) => shell.pty.killed)).toBe(true)
    expect(closes(o).map((row) => row.outcome.split(';')[0])).toEqual(['net_off', 'net_off'])
    // The port is gone with the routes, and the thread's writer lease with the shell: its owner can open a terminal there.
    expect(o.f.mms.routedTerminals).toBeUndefined()
    const own = (await window(o, 'pty.create', { threadId: first.t.id, agentId })) as { ptyId: string }
    expect(own.ptyId).toBeTruthy()

    // Net comes back: a fresh set of routes counts from zero, and that is true, because nothing of the old is running.
    const again = new OwnerRoutes({
      services: o.f.mms,
      rpc: { register: () => undefined, methods: () => [], dispatch: async () => null },
      policy: o.policy,
      audit: o.audit,
      track: (work) => work
    })
    expect(again.terminals.count(o.f.callerNode)).toBe(0)
    await again.close()
  }, 240_000)

  it('does the same through net.disable on a real Bridge service, after telling the owner’s windows of the first terminal', async () => {
    const t = await linked()
    const heard: Array<{ type: string; data: Record<string, unknown> }> = []
    t.owner.events.on('protocol:event', ((event: { type: string; data: Record<string, unknown> }) =>
      heard.push(event)) as (data: unknown) => void)
    const spawned = fakeShells(t.owner.ptyManager, cleanups)
    await t.owner.net.request('bridge.policy', { node: t.callerNode, terminal: true })
    const path = repo()
    const project = t.owner.projects.openProject(path)
    const thread = t.owner.threads.createThread('T', project.id, path, {})
    const created = await t.dispatch('pty.create', { threadId: t.qualified(thread.id), agentId })
    expect(created.ptyId).toBeTruthy()
    expect(spawned).toHaveLength(1)
    // The owner's windows are told once, by name, in the daemon's own notice event (the desktop shows it).
    expect(heard.filter((event) => event.type === 'ui.notify')).toEqual([
      {
        type: 'ui.notify',
        data: { kind: 'remote-terminal', device: expect.any(String), threadId: thread.id, threadName: 'T' }
      }
    ])
    const terminals = t.insideOwner.routes.terminals

    await t.owner.net.request('net.disable', {})
    expect(spawned[0].pty.killed).toBe(true)
    expect(terminals.count(t.callerNode)).toBe(0)
  }, 240_000)
})

describe('a device that is away', () => {
  it('keeps its terminals through a short drop and ends them after the grace period, audited as device_away', async () => {
    let connected = true
    const clock = testClock()
    const o = await routedOwner({ clock, terminals: { connected: () => connected, awayMs: 10 * 60 * 1000 } })
    const spawned = fakeShells(o.f.mms.ptyManager, resources)
    o.policy.set(o.f.callerNode, { terminal: true })
    await another(o)
    const minutes = (n: number) => clock.advance(n * 60 * 1000)
    // Nothing happens while it is connected.
    expect(o.routes.terminals.sweep()).toBe(0)
    connected = false
    expect(o.routes.terminals.sweep()).toBe(0)
    // A drop of a few minutes is not the end.
    minutes(5)
    expect(o.routes.terminals.sweep()).toBe(0)
    expect(spawned[0].pty.killed).toBe(false)
    // Back again: the count of time away starts over.
    connected = true
    expect(o.routes.terminals.sweep()).toBe(0)
    connected = false
    minutes(1)
    expect(o.routes.terminals.sweep()).toBe(0)
    minutes(9)
    expect(o.routes.terminals.sweep()).toBe(0)
    expect(spawned[0].pty.killed).toBe(false)
    minutes(2)
    expect(o.routes.terminals.sweep()).toBe(1)
    expect(spawned[0].pty.killed).toBe(true)
    expect(closes(o)).toEqual([expect.objectContaining({ outcome: expect.stringMatching(/^device_away;/) })])
    expect(o.routes.terminals.count(o.f.callerNode)).toBe(0)
  }, 240_000)

  it('is not ended while another device is connected, and a terminal that ended itself is not counted', async () => {
    const away = new Set<NodeId>()
    const o = await routedOwner({
      terminals: { connected: (node) => !away.has(node), awayMs: 1 }
    })
    const spawned = fakeShells(o.f.mms.ptyManager, resources)
    o.policy.set(o.f.callerNode, { terminal: true })
    await another(o)
    spawned[0].pty.exit(0)
    away.add(o.f.callerNode)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(o.routes.terminals.sweep()).toBe(0)
  }, 240_000)
})

describe('a block that lands while a shell is starting', () => {
  it('stops the shell as it appears, refuses the call, and never hands it back after Unblock', async () => {
    const o = await routedOwner()
    const spawned = fakeShells(o.f.mms.ptyManager, resources, () => {
      // The owner blocks the device while its shell is being made.
      o.policy.set(o.f.callerNode, { blocked: true })
    })
    o.policy.set(o.f.callerNode, { terminal: true })
    const t = folderThread(o)
    const reply = await create(o, t.id)
    expect(reply).toMatchObject({ ok: false, error: { code: 'terminal_ended' } })
    expect(spawned[0].pty.killed).toBe(true)
    expect(closes(o)).toEqual([expect.objectContaining({ outcome: expect.stringMatching(/^blocked;/) })])
    expect(o.routes.terminals.count(o.f.callerNode)).toBe(0)
    o.policy.set(o.f.callerNode, { blocked: false })
    expect(o.routes.terminals.heldBy(o.f.callerNode)).toEqual([])
    expect((await o.ok('pty.list', { threadId: t.id })).ptys).toEqual([])
  }, 240_000)

  it('stops a shell whose call failed after it started, so none is left with no one to hold it', async () => {
    const o = await routedOwner()
    const spawned = fakeShells(o.f.mms.ptyManager, resources)
    o.policy.set(o.f.callerNode, { terminal: true })
    const t = folderThread(o)
    vi.spyOn(o.f.mms.threadRuntimes, 'registerPty').mockImplementationOnce(() => {
      throw new Error('registry broke')
    })
    await expect(create(o, t.id)).rejects.toMatchObject({ code: 'outcome_uncertain' })
    await vi.waitFor(() => expect(spawned[0].pty.killed).toBe(true))
    await vi.waitFor(() => expect(closes(o)).toHaveLength(1))
    expect(closes(o)).toEqual([expect.objectContaining({ outcome: expect.stringMatching(/^create_failed;/) })])
    expect(o.routes.terminals.count(o.f.callerNode)).toBe(0)
  }, 240_000)
})

describe('what the owner sees', () => {
  it('lists who holds a terminal on a thread, stops it when asked, and says so in the audit', async () => {
    const o = await routedOwner({ terminals: { deviceName: () => 'Studio Mac' } })
    const spawned: Spawned[] = fakeShells(o.f.mms.ptyManager, resources)
    o.policy.set(o.f.callerNode, { terminal: true })
    const { t, ptyId } = await another(o)
    const listed = (await window(o, 'pty.list', { threadId: t.id })) as {
      ptys: Array<{ ptyId: string; heldBy?: { node: string; name: string } }>
    }
    expect(listed.ptys).toEqual([
      expect.objectContaining({ ptyId, heldBy: expect.objectContaining({ node: o.f.callerNode, name: 'Studio Mac' }) })
    ])
    // The device sees its own terminal without the holder (it knows who it is).
    expect((await o.ok('pty.list', { threadId: t.id })).ptys[0]).not.toHaveProperty('heldBy')
    await window(o, 'pty.kill', { ptyId, threadId: t.id })
    expect(spawned[0].pty.killed).toBe(true)
    expect(closes(o)).toEqual([expect.objectContaining({ outcome: expect.stringMatching(/^owner_stopped;/) })])
  }, 240_000)

  it('tells the owner’s windows, once, when a device opens its first terminal', async () => {
    const told: Array<{ name: string; threadId: string }> = []
    const o = await routedOwner({
      terminals: { deviceName: () => 'Studio Mac', onFirstTerminal: (info) => told.push(info) }
    })
    fakeShells(o.f.mms.ptyManager, resources)
    o.policy.set(o.f.callerNode, { terminal: true })
    const first = await another(o)
    await another(o)
    expect(told).toEqual([{ node: o.f.callerNode, name: 'Studio Mac', threadId: first.t.id }])
  }, 240_000)
})
