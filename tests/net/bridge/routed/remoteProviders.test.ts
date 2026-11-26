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
    const added = vi.spyOn(owner().instances, 'addInstance').mockResolvedValue({ snapshot: snapshot('acp:x') } as never)
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

  it('chooses or installs the program an agent runs there only while that computer lets this one use its terminal', async () => {
    const configured = vi.spyOn(owner().instances, 'configure').mockResolvedValue(snapshot('acp:reg'))
    const added = vi.spyOn(owner().instances, 'addInstance').mockResolvedValue({ snapshot: snapshot('acp:reg') } as never)
    const operation = (instanceId: string) => ({ operationId: `op-${randomUUID()}`, instanceId, kind: 'install' as const })
    const installed = vi.spyOn(owner().instances, 'install').mockImplementation(async (instanceId) => operation(instanceId))
    const updated = vi.spyOn(owner().instances, 'update').mockImplementation(async (instanceId) => operation(instanceId))
    // The owner's entries: an ACP registry agent, one with a program of its own, and Claude Code as found.
    const stored: Record<string, Record<string, unknown>> = {
      'acp:reg': { source: { kind: 'registry', agentId: 'some-agent', version: '1.0.0', distribution: 'binary' } },
      'claude:own': { binaryPath: '/opt/tools/claude' },
      claude: {}
    }
    const realGet = t.owner.providerInstances.get.bind(t.owner.providerInstances)
    vi.spyOn(t.owner.providerInstances, 'get').mockImplementation((id) => (id in stored ? { driver: 'acp', enabled: true, config: stored[id] } : realGet(id)))
    const source = { kind: 'registry', agentId: 'some-agent', version: '1.0.0', distribution: 'binary' }
    const choices = [
      ['providers.instances.add', { driver: 'acp', config: { displayName: 'Some agent', source } }],
      ['providers.instances.configure', { instanceId: 'acp:reg', patch: { source } }],
      ['providers.instances.configure', { instanceId: 'codex', patch: { setup: 'managed' } }],
      ['providers.instances.configure', { instanceId: 'claude', patch: { useOlderSettings: true } }],
      ['providers.instances.install', { instanceId: 'acp:reg' }],
      ['providers.instances.update', { instanceId: 'acp:reg' }],
      ['providers.instances.install', { instanceId: 'claude:own' }]
    ] as const
    await t.owner.net.request('bridge.policy', { node: t.callerNode, terminal: false })
    for (const [method, params] of choices) {
      const refused = await t.refused(t.dispatch(method, { node: t.node, ...params }))
      expect(refused.message, method).toMatch(/terminal/)
    }
    expect(added).not.toHaveBeenCalled()
    expect(configured).not.toHaveBeenCalled()
    expect(installed).not.toHaveBeenCalled()
    expect(updated).not.toHaveBeenCalled()
    // An agent Mousse finds or installs itself is not this computer's choice of program.
    await t.dispatch('providers.instances.install', { node: t.node, instanceId: 'claude' })
    expect(installed).toHaveBeenCalledWith('claude')

    await t.owner.net.request('bridge.policy', { node: t.callerNode, terminal: true })
    try {
      for (const [method, params] of choices) await t.dispatch(method, { node: t.node, ...params })
      expect(added).toHaveBeenCalledTimes(1)
      expect(configured).toHaveBeenCalledTimes(3)
      expect(installed).toHaveBeenCalledWith('acp:reg')
      expect(installed).toHaveBeenCalledWith('claude:own')
      expect(updated).toHaveBeenCalledWith('acp:reg')
    } finally {
      await t.owner.net.request('bridge.policy', { node: t.callerNode, terminal: false })
    }
  }, 60_000)

  it('never gives a computer without terminal access the values of launch variables or arguments, in any reply', async () => {
    const secret = `sk-env-${randomUUID()}`
    const token = `tok-${randomUUID()}`
    const configured = (instanceId: string) =>
      ({ ...snapshot(instanceId), config: { home: 'default', args: ['--token', token], env: { OPENAI_API_KEY: secret, LOG_LEVEL: 'debug' } } }) as unknown as InstanceSnapshot
    vi.spyOn(owner().instances, 'snapshots').mockResolvedValue([configured('claude')])
    vi.spyOn(owner().instances, 'configure').mockResolvedValue(configured('claude'))
    vi.spyOn(owner().instances, 'setEnabled').mockResolvedValue(configured('claude'))
    vi.spyOn(owner().instances, 'recheck').mockResolvedValue(configured('claude'))
    vi.spyOn(owner().instances, 'addInstance').mockResolvedValue({ snapshot: configured('claude:new') } as never)
    vi.spyOn(owner().instances, 'refreshAllModels').mockResolvedValue([{ instanceId: 'claude', outcome: 'refreshed', snapshot: configured('claude') }] as never)
    const eventsBefore = t.events.length
    const replies = [
      await t.dispatch('providers.snapshots', { node: t.node, scope: { kind: 'device' } }),
      await t.dispatch('providers.instances.configure', { node: t.node, instanceId: 'claude', patch: { displayName: 'Work' } }),
      await t.dispatch('providers.instances.setEnabled', { node: t.node, instanceId: 'claude', enabled: true }),
      await t.dispatch('providers.instances.recheck', { node: t.node, instanceId: 'claude' }),
      await t.dispatch('providers.instances.add', { node: t.node, driver: 'claude', config: { displayName: 'New' } }),
      await t.dispatch('providers.instances.refreshAllModels', { node: t.node })
    ]
    // A change there reaches this computer as a notice only.
    ownerEmits({ type: 'snapshots', data: { scope: { kind: 'device' }, snapshots: [configured('claude')] } })
    await vi.waitFor(() => expect(t.events.slice(eventsBefore).some((event) => event.type === 'providers.remote')).toBe(true), { timeout: 15_000 })
    const seen = JSON.stringify([replies, t.events.slice(eventsBefore)])
    expect(seen).not.toContain(secret)
    expect(seen).not.toContain(token)
    // The names stay, so the page can say which variables are set.
    expect(replies[0].snapshots[0].config).toMatchObject({ env: { OPENAI_API_KEY: '', LOG_LEVEL: '' }, args: [], launchHidden: true })

    // With terminal access there, the values are as shown on that computer.
    await t.owner.net.request('bridge.policy', { node: t.callerNode, terminal: true })
    try {
      const open = await t.dispatch('providers.snapshots', { node: t.node, scope: { kind: 'device' } })
      expect(open.snapshots[0].config.env.OPENAI_API_KEY).toBe(secret)
      expect(open.snapshots[0].config.launchHidden).toBeUndefined()
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
