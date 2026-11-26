/**
 * Settings → Providers of another computer, over two real daemons linked by Bridge. A window of the caller reads and
 * changes the owner's provider entries through the routed rows; a pasted key is saved by the owner and kept nowhere
 * on the caller; the sign-ins it starts there report back to the caller's windows. No agent or sign-in really runs:
 * the owner's provider calls are stubbed where they would.
 */
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { InstanceSnapshot } from '../../../../src/shared/harness/status'
import type { ProviderOperationEvent } from '../../../../src/shared/harness/types'
import type { HarnessGatewayEvent } from '../../../../src/mms/harness/gateway'
import { cleanupAll, homeOf, linked } from './routerFixture'

let t: Awaited<ReturnType<typeof linked>>
beforeAll(async () => {
  t = await linked()
}, 120_000)
afterAll(cleanupAll)
afterEach(() => {
  vi.restoreAllMocks()
})

const owner = () => t.owner.harness!
const snapshot = (instanceId: string, enabled = true) =>
  ({ instanceId, scope: { kind: 'device' }, enabled: { device: enabled, effective: enabled, setBy: 'device' } }) as unknown as InstanceSnapshot
/** An event of the owner's provider instances, as its gateway tells its listeners. */
const ownerEmits = (event: HarnessGatewayEvent) => (owner() as unknown as { emit(event: HarnessGatewayEvent): void }).emit(event)

/** Every file under `folder`, as bytes. */
function filesUnder(folder: string): Array<{ path: string; bytes: Buffer }> {
  const found: Array<{ path: string; bytes: Buffer }> = []
  for (const name of readdirSync(folder)) {
    const path = join(folder, name)
    const stat = statSync(path, { throwIfNoEntry: false })
    if (stat?.isDirectory()) found.push(...filesUnder(path))
    else if (stat?.isFile()) found.push({ path, bytes: readFileSync(path) })
  }
  return found
}

describe("Settings → Providers of another computer", () => {
  it("reads the other computer's own list and turns its providers on or off there, not here", async () => {
    const listed = vi.spyOn(owner().instances, 'snapshots').mockResolvedValue([snapshot('claude')])
    const ownerSet = vi.spyOn(owner().instances, 'setEnabled').mockResolvedValue(snapshot('claude', false))
    const callerSet = vi.spyOn(t.caller.harness!.instances, 'setEnabled')

    const read = await t.dispatch('providers.snapshots', { node: t.node, scope: { kind: 'device' } })
    expect(read.snapshots.map((entry: InstanceSnapshot) => entry.instanceId)).toEqual(['claude'])
    expect(listed).toHaveBeenCalledWith({ kind: 'device' })

    const changed = await t.dispatch('providers.instances.setEnabled', { node: t.node, instanceId: 'claude', enabled: false })
    expect(changed.snapshot.enabled.device).toBe(false)
    expect(ownerSet).toHaveBeenCalledWith('claude', false)
    expect(callerSet).not.toHaveBeenCalled()
  }, 60_000)

  it('saves a pasted key on the other computer only; this computer keeps, logs and shows none of it', async () => {
    const key = `sk-routed-${randomUUID()}`
    const saved = vi.spyOn(owner().instances, 'setSecret').mockResolvedValue(snapshot('pi:openai'))
    const callerSaved = vi.spyOn(t.caller.harness!.instances, 'setSecret')
    const logged: unknown[][] = []
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const)
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args))
    const eventsBefore = t.events.length

    const reply = await t.dispatch('providers.instances.setSecret', { node: t.node, instanceId: 'pi:openai', value: key })

    expect(saved).toHaveBeenCalledWith('pi:openai', key)
    expect(callerSaved).not.toHaveBeenCalled()
    expect(JSON.stringify(reply)).not.toContain(key)
    expect(JSON.stringify(t.events.slice(eventsBefore))).not.toContain(key)
    expect(logged.map((args) => args.map((arg) => (arg instanceof Error ? arg.message : JSON.stringify(arg))).join(' ')).join('\n')).not.toContain(key)
    // Nothing on the caller's disk holds it: not its databases, journals, logs or settings.
    const keyBytes = Buffer.from(key)
    const holding = filesUnder(homeOf.get(t.caller)!).filter((file) => file.bytes.includes(keyBytes)).map((file) => file.path)
    expect(holding).toEqual([])
  }, 60_000)

  it('is refused, in one line, while the other computer does not let this one work there, and nothing changes there', async () => {
    const saved = vi.spyOn(owner().instances, 'setSecret').mockResolvedValue(snapshot('pi:openai'))
    const toggled = vi.spyOn(owner().instances, 'setEnabled').mockResolvedValue(snapshot('claude'))
    await t.owner.net.request('bridge.workOnThreads', { enabled: false })
    try {
      for (const call of [
        t.dispatch('providers.instances.setSecret', { node: t.node, instanceId: 'pi:openai', value: 'sk-never-sent' }),
        t.dispatch('providers.instances.setEnabled', { node: t.node, instanceId: 'claude', enabled: true }),
        t.dispatch('providers.snapshots', { node: t.node, scope: { kind: 'device' } })
      ]) {
        const refused = await t.refused(call)
        expect(refused.message).toBeTruthy()
        expect(refused.message).not.toMatch(/\n/)
      }
      expect(saved).not.toHaveBeenCalled()
      expect(toggled).not.toHaveBeenCalled()
    } finally {
      await t.owner.net.request('bridge.workOnThreads', { enabled: true })
    }
  }, 60_000)

  it("keeps a computer whose changes the owner turned off to reading the other computer's providers", async () => {
    vi.spyOn(owner().instances, 'snapshots').mockResolvedValue([snapshot('claude')])
    const saved = vi.spyOn(owner().instances, 'setSecret').mockResolvedValue(snapshot('pi:openai'))
    await t.owner.net.request('bridge.policy', { node: t.callerNode, work: false })
    try {
      expect((await t.dispatch('providers.snapshots', { node: t.node, scope: { kind: 'device' } })).snapshots).toHaveLength(1)
      await t.refused(t.dispatch('providers.instances.setSecret', { node: t.node, instanceId: 'pi:openai', value: 'sk-never-sent' }))
      expect(saved).not.toHaveBeenCalled()
    } finally {
      await t.owner.net.request('bridge.policy', { node: t.callerNode, work: true })
    }
  }, 60_000)

  it("brings a sign-in it started there to this computer's windows, prompts included, and answers it there", async () => {
    const operationId = `op-${randomUUID()}`
    const prompt: ProviderOperationEvent = {
      operationId,
      instanceId: 'codex',
      kind: 'sign_in',
      phase: 'prompt',
      prompt: { promptId: 'p1', type: 'auth_url', url: 'https://auth.example/start', usesCallbackServer: true, acceptsRedirectPaste: true }
    }
    // The owner's first event goes out before the call that started the sign-in has answered.
    vi.spyOn(owner().instances, 'signIn').mockImplementation(async () => {
      ownerEmits({ type: 'operation', data: prompt })
      return { operationId, instanceId: 'codex', kind: 'sign_in' }
    })
    const answered = vi.spyOn(owner().instances, 'respondSignIn').mockResolvedValue(true)

    const started = await t.dispatch('providers.instances.signIn', { node: t.node, instanceId: 'codex' })
    expect(started.operation.operationId).toBe(operationId)
    const remote = () =>
      t.events.filter((event) => event.type === 'providers.remote' && event.data.type === 'providers.operation' && event.data.data.event.operationId === operationId)
    await vi.waitFor(() => expect(remote()).toHaveLength(1), { timeout: 15_000 })
    expect(remote()[0]!.data).toMatchObject({ node: t.node, data: { event: { phase: 'prompt', prompt: { url: 'https://auth.example/start' } } } })

    // The address the browser here ended on goes to the owner, which finishes the sign-in.
    const response = { promptId: 'p1', kind: 'redirect_url', value: 'http://localhost:1455/auth/callback?code=c' }
    expect((await t.dispatch('providers.instances.respondSignIn', { node: t.node, operationId, response })).ok).toBe(true)
    expect(answered).toHaveBeenCalledWith(operationId, response)
    ownerEmits({ type: 'operation', data: { operationId, instanceId: 'codex', kind: 'sign_in', phase: 'completed' } })
    await vi.waitFor(() => expect(remote().map((event) => event.data.data.event.phase)).toEqual(['prompt', 'completed']), { timeout: 15_000 })
  }, 60_000)

  it("never answers or cancels an operation it did not start there, and never hears of one", async () => {
    const operationId = `op-owner-${randomUUID()}`
    const answered = vi.spyOn(owner().instances, 'respondSignIn').mockResolvedValue(true)
    const cancelled = vi.spyOn(owner().instances, 'cancelInstall').mockResolvedValue(true)
    // A person at the owner signs in there: its prompt stays with the owner's windows.
    ownerEmits({ type: 'operation', data: { operationId, instanceId: 'claude', kind: 'sign_in', phase: 'prompt', prompt: { promptId: 'q', type: 'input', secret: true, message: 'Code' } } })
    const answer = await t.refused(t.dispatch('providers.instances.respondSignIn', { node: t.node, operationId, response: { promptId: 'q', kind: 'input', value: 'guess' } }))
    expect(answer.code).toBe('not_found')
    const cancel = await t.refused(t.dispatch('providers.instances.cancelInstall', { node: t.node, operationId }))
    expect(cancel.code).toBe('not_found')
    expect(answered).not.toHaveBeenCalled()
    expect(cancelled).not.toHaveBeenCalled()
    expect(t.events.some((event) => event.type === 'providers.remote' && JSON.stringify(event.data).includes(operationId))).toBe(false)
  }, 60_000)

  it("changes what an agent runs with there only while that computer lets this one use its terminal", async () => {
    const configured = vi.spyOn(owner().instances, 'configure').mockResolvedValue(snapshot('claude'))
    const added = vi.spyOn(owner().instances, 'add').mockResolvedValue({ snapshot: snapshot('acp:x') } as never)
    // Its name, telemetry and the like need no more than working there.
    await t.dispatch('providers.instances.configure', { node: t.node, instanceId: 'claude', patch: { displayName: 'Work' } })
    expect(configured).toHaveBeenCalledTimes(1)
    // A program, arguments or variables run a command of this computer's choosing there.
    await t.owner.net.request('bridge.policy', { node: t.callerNode, terminal: false })
    for (const [method, params] of [
      ['providers.instances.configure', { instanceId: 'claude', patch: { binaryPath: '/bin/sh' } }],
      ['providers.instances.configure', { instanceId: 'claude', patch: { args: ['-c', 'echo'] } }],
      ['providers.instances.configure', { instanceId: 'claude', patch: { env: { NODE_OPTIONS: '--require x' } } }],
      ['providers.instances.add', { driver: 'acp', config: { displayName: 'Mine', binaryPath: '/bin/sh' } }]
    ] as const) {
      const refused = await t.refused(t.dispatch(method, { node: t.node, ...params }))
      expect(refused.message).toMatch(/terminal/)
    }
    expect(configured).toHaveBeenCalledTimes(1)
    expect(added).not.toHaveBeenCalled()
    await t.owner.net.request('bridge.policy', { node: t.callerNode, terminal: true })
    try {
      await t.dispatch('providers.instances.configure', { node: t.node, instanceId: 'claude', patch: { binaryPath: '/bin/sh' } })
      expect(configured).toHaveBeenLastCalledWith('claude', { binaryPath: '/bin/sh' })
    } finally {
      await t.owner.net.request('bridge.policy', { node: t.callerNode, terminal: false })
    }
  }, 60_000)

  it("tells this computer's windows when the other computer's providers change, so its page reads them again", async () => {
    const before = t.events.filter((event) => event.type === 'providers.remote' && event.data.type === 'providers.changed').length
    vi.spyOn(owner().instances, 'snapshots').mockResolvedValue([snapshot('claude')])
    // This computer is on the page (it read the list), then a change happens there.
    await t.dispatch('providers.snapshots', { node: t.node, scope: { kind: 'device' } })
    ownerEmits({ type: 'snapshots', data: { scope: { kind: 'device' }, snapshots: [snapshot('claude', false)] } })
    await vi.waitFor(
      () => expect(t.events.filter((event) => event.type === 'providers.remote' && event.data.type === 'providers.changed').length).toBe(before + 1),
      { timeout: 15_000 }
    )
    // A notice only: the list itself is read again with the routed read.
    const notice = t.events.filter((event) => event.type === 'providers.remote').at(-1)!
    expect(notice.data).toEqual({ node: t.node, type: 'providers.changed', data: {} })
  }, 60_000)
})
