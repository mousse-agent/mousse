import { afterEach, expect, it, vi } from 'vitest'
import { NetError, newId } from '../../../../src/shared/net'
import { BridgeHub, executeBridgeHubLocal } from '../../../../src/mms/bridge/hub'
import { FileKeyStore, NetIdentityService } from '../../../../src/mms/net/identity'
import { systemClock } from '../../../../src/mms/net/clock'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture, cleanup, resources } from './fixture'
afterEach(cleanup)

it('persists exact original IDs/idem aliases before sending and rejects cross-payload aliases', async () => {
  const f = await fixture()
  await f.connect()
  const hub = f.hub(),
    id = newId('rpc'),
    alias = newId('rpc')
  expect(
    hub.prepare(f.targetNode, 'threads.create', { name: 'journaled' }, { id, idem: 'create-once' })
  ).toBe(id)
  expect(f.mms.threads.listAllThreads()).toHaveLength(0)
  expect(hub.status(id)).toMatchObject({ id, original: id, state: 'prepared' })
  hub.prepare(
    f.targetNode,
    'threads.create',
    { name: 'journaled' },
    { id: alias, idem: 'create-once' }
  )
  expect(hub.canonicalRequest(alias, 'threads.create', f.targetNode)).toBe(id)
  expect(hub.ownsRequest(alias, 'threads.rename', f.targetNode)).toBe(false)
  expect(() =>
    hub.prepare(
      f.targetNode,
      'threads.create',
      { name: 'different' },
      { id: newId('rpc'), idem: 'create-once' }
    )
  ).toThrow(expect.objectContaining({ code: 'conflict' }))
  expect(() => hub.prepare(f.targetNode, 'providers.login' as any, {} as any)).toThrow(
    expect.objectContaining({ code: 'bad_request' })
  )
  expect(() =>
    hub.prepare(f.targetNode, 'threads.create', { name: 'x', path: '/tmp/escape' } as any)
  ).toThrow(expect.objectContaining({ code: 'bad_request' }))
  const result = await hub.submit(alias)
  expect(result).toMatchObject({ thread: { name: 'journaled' } })
  expect(f.mms.threads.listAllThreads()).toHaveLength(1)
  expect(await hub.submit(id)).toEqual(result)
  expect(f.mms.threads.listAllThreads()).toHaveLength(1)
})

it('recovers a lost post-effect response over actual TLS after caller SQLite restart using rpc.result only', async () => {
  const f = await fixture(),
    first = await f.connect(),
    id = newId('rpc'),
    alias = newId('rpc'),
    hub = f.hub()
  let executions = 0
  const dispatch = f.targetRpc.dispatch.bind(f.targetRpc)
  f.targetRpc.dispatch = async (...args) => {
    const result = await dispatch(...args)
    executions++
    first.transport.cut()
    return result
  }
  hub.prepare(
    f.targetNode,
    'threads.create',
    { name: 'Exactly one actual thread' },
    { id, idem: 'lost-create', deadlineMs: 2000 }
  )
  hub.prepare(
    f.targetNode,
    'threads.create',
    { name: 'Exactly one actual thread' },
    { id: alias, idem: 'lost-create', deadlineMs: 2000 }
  )
  await expect(hub.submit(alias)).rejects.toBeDefined()
  expect(hub.status(id).state).toBe('unknown')
  expect(f.mms.threads.listAllThreads()).toHaveLength(1)
  expect(executions).toBe(1)
  await f.restartCaller()
  expect(await f.hub().query(alias)).toMatchObject({
    thread: { name: 'Exactly one actual thread' }
  })
  expect(f.hub().status(alias)).toMatchObject({ original: id, state: 'completed' })
  expect(executions).toBe(1)
  expect(await f.hub().submit(alias)).toMatchObject({
    thread: { name: 'Exactly one actual thread' }
  })
  expect(executions).toBe(1)
  expect(f.mms.threads.listAllThreads()).toHaveLength(1)
})

it('marks a pre-send durable attempt unknown and never sends it during recovery even when target has no request', async () => {
  let fault = false
  const f = await fixture(undefined, (point) => {
    if (fault && point === 'bridge.hub.attempt.beforeCommit') throw new Error('rollback attempt')
  })
  await f.connect()
  const id = f.hub().prepare(f.targetNode, 'threads.create', { name: 'Never executed' })
  fault = true
  await expect(f.hub().submit(id)).rejects.toThrow('rollback attempt')
  fault = false
  expect(f.hub().status(id).state).toBe('prepared')
  expect(f.mms.threads.listAllThreads()).toHaveLength(0)
  f.callerDb().transaction(() => {
    const row = f
        .callerDb()
        .database.prepare('SELECT record FROM net_bridge_hub_requests WHERE id=?')
        .get(id)!,
      record = JSON.parse(String(row.record))
    record.state = 'unknown'
    f.callerDb()
      .database.prepare('UPDATE net_bridge_hub_requests SET record=? WHERE id=?')
      .run(JSON.stringify(record), id)
  })
  await expect(f.hub().submit(id)).rejects.toMatchObject({ code: 'outcome_uncertain' })
  expect(f.mms.threads.listAllThreads()).toHaveLength(0)
})

it('enforces current same-user capabilities for cached results and denies invalid local DTOs before effects', async () => {
  const f = await fixture(['read'])
  await f.connect()
  expect(
    await executeBridgeHubLocal(f.hub(), 'bridge.hub.threads', { target: f.targetNode })
  ).toEqual({ threads: [] })
  await expect(
    executeBridgeHubLocal(f.hub(), 'bridge.hub.send', {
      ref: { nodeId: f.targetNode, entityId: 'thread' },
      content: 'deny',
      options: { id: newId('rpc') }
    })
  ).rejects.toMatchObject({ code: 'forbidden' })
  await expect(
    executeBridgeHubLocal(f.hub(), 'bridge.hub.threads', {
      target: f.targetNode,
      provider: 'attacker'
    })
  ).rejects.toMatchObject({ code: 'bad_request' })
  const id = f.hub().prepare(f.targetNode, 'projects.list', {})
  await f.hub().submit(id)
  f.targetIdentity.revoke(f.callerNode)
  f.callerIdentity().acceptRoster(f.targetIdentity.roster()!, f.targetKeys.rootKey()!)
  await expect(f.hub().query(id)).rejects.toMatchObject({ code: 'revoked' })
  expect(f.mms.threads.listAllThreads()).toHaveLength(0)
})

it('cancels an admitted original request through its durable alias and bounds active requests', async () => {
  const f = await fixture()
  await f.connect()
  let runSignal: AbortSignal | undefined
  f.backend.run = async (_thread, _content, control) => {
    runSignal = control.signal
    await new Promise<void>((resolve) =>
      control.signal.addEventListener('abort', () => resolve(), { once: true })
    )
    throw new NetError('cancelled')
  }
  const id = newId('rpc'),
    alias = newId('rpc'),
    hub = f.hub()
  hub.prepare(
    f.targetNode,
    'orchestrator.send',
    { threadId: 'owned', content: 'prompt' },
    { id, idem: 'owned-run', deadlineMs: 3000 }
  )
  hub.prepare(
    f.targetNode,
    'orchestrator.send',
    { threadId: 'owned', content: 'prompt' },
    { id: alias, idem: 'owned-run', deadlineMs: 3000 }
  )
  const pending = hub.submit(id).catch((error) => error)
  await vi.waitFor(() => expect(runSignal).toBeDefined())
  await hub.cancel(alias)
  await vi.waitFor(() => expect(runSignal!.aborted).toBe(true))
  expect(await pending).toMatchObject({ code: 'cancelled' })
  await hub.drain()
  expect(hub.activeCount()).toBe(0)
  const unopened = newId('rpc')
  hub.prepare(f.targetNode, 'threads.create', { name: 'cancel-before-send' }, { id: unopened })
  await hub.cancel(unopened)
  await expect(hub.submit(unopened)).rejects.toMatchObject({ code: 'outcome_uncertain' })
  expect(f.mms.threads.listAllThreads()).toHaveLength(0)
})

it('attaches real thread snapshots/events and reopens stable thread identity after a new source generation', async () => {
  const f = await fixture(),
    thread = f.mms.threads.createThread('Display source'),
    adapter = f.makeAdapter()
  await f.connect(adapter.store)
  const updates: unknown[] = [],
    errors: string[] = [],
    ref = { nodeId: f.targetNode, entityId: thread.id },
    attached = await f.hub().attach(
      ref,
      (value) => updates.push(value),
      (code) => errors.push(code)
    )
  await vi.waitFor(() =>
    expect(
      updates.some((value: any) => value.kind === 'snapshot' && value.value.thread.id === thread.id)
    ).toBe(true)
  )
  f.mms.orchestrator.enqueueForThread(thread.id, { content: 'Verified live update' })
  await vi.waitFor(() =>
    expect(
      updates.some((value: any) => value.kind === 'event' && value.type === 'queue.updated')
    ).toBe(true)
  )
  expect(errors).toEqual([])
  f.caller().close()
  f.target().close()
  const next = f.makeAdapter()
  await f.connect(next.store)
  await f.hub().reconnect(f.targetNode)
  expect(errors).toEqual([])
  await vi.waitFor(() => expect(f.callerStore().cursor(attached.descriptor.id).epoch).toBe(2))
  expect(next.activate(thread.id).id).toBe(attached.descriptor.id)
  expect(errors).toEqual([])
  f.hub().close()
  await f.hub().drain()
  expect(f.hub().activeCount()).toBe(0)
})

it('passes worktreeEnabled through bridge.hub.create to the target thread', async () => {
  const f = await fixture(),
    path = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-worktree-')))
  resources.push(() => rmSync(path, { recursive: true, force: true }))
  const project = f.mms.projects.openProject(path)
  await f.connect()
  const create = (options: Record<string, unknown>, name = 'Worktree thread') =>
    executeBridgeHubLocal(f.hub(), 'bridge.hub.create', {
      target: f.targetNode,
      name,
      projectId: project.id,
      options: { id: newId('rpc'), ...options }
    }) as Promise<{ thread: { worktreeEnabled?: boolean } }>
  expect((await create({ worktreeEnabled: true })).thread.worktreeEnabled).toBe(true)
  expect((await create({ worktreeEnabled: false })).thread.worktreeEnabled).not.toBe(true)
  expect((await create({})).thread.worktreeEnabled).not.toBe(true)
  const threads = f.mms.threads.listAllThreads()
  expect(threads.filter((thread) => thread.worktreeEnabled === true)).toHaveLength(1)
  // The flag is part of the request: a retry with the same key but another value conflicts.
  f.hub().prepare(
    f.targetNode,
    'threads.create',
    { name: 'Keyed', projectId: project.id, worktreeEnabled: true },
    { id: newId('rpc'), idem: 'worktree-once' }
  )
  expect(() =>
    f.hub().prepare(
      f.targetNode,
      'threads.create',
      { name: 'Keyed', projectId: project.id, worktreeEnabled: false },
      { id: newId('rpc'), idem: 'worktree-once' }
    )
  ).toThrow(expect.objectContaining({ code: 'conflict' }))
  for (const bad of [{ worktreeEnabled: 'yes' }, { worktreeEnabled: 1 }, { worktree: true }])
    await expect(create(bad)).rejects.toMatchObject({ code: 'bad_request' })
  // Only create takes the flag.
  await expect(
    executeBridgeHubLocal(f.hub(), 'bridge.hub.projects', {
      target: f.targetNode,
      options: { worktreeEnabled: true }
    })
  ).rejects.toMatchObject({ code: 'bad_request' })
  expect(f.mms.threads.listAllThreads()).toHaveLength(threads.length)
})

it('records on the target which device started a thread, and its project there', async () => {
  const f = await fixture()
  await f.connect()
  const create = (options: Record<string, unknown>) =>
    executeBridgeHubLocal(f.hub(), 'bridge.hub.create', {
      target: f.targetNode,
      name: 'Started elsewhere',
      options: { id: newId('rpc'), ...options }
    }) as Promise<{ thread: { id: string; startedFrom?: unknown } }>
  const withProject = await create({ startedFromProjectId: 'caller-project' })
  expect(withProject.thread.startedFrom).toEqual({ node: f.callerNode, projectId: 'caller-project' })
  const plain = await create({})
  expect(plain.thread.startedFrom).toEqual({ node: f.callerNode })
  // Every device that lists the target's threads sees where they began.
  const listed = (await executeBridgeHubLocal(f.hub(), 'bridge.hub.threads', { target: f.targetNode })) as { threads: Array<{ id: string; startedFrom?: unknown }> }
  expect(listed.threads.find((thread) => thread.id === withProject.thread.id)?.startedFrom).toEqual({ node: f.callerNode, projectId: 'caller-project' })
  // A thread made on the target itself has no origin.
  expect(f.mms.threads.createThread('Local').startedFrom).toBeUndefined()
  await expect(create({ startedFromProjectId: 7 })).rejects.toMatchObject({ code: 'bad_request' })
})

it('delivers the first turn of a remote thread when the hub attaches before it sends', async () => {
  const f = await fixture()
  // The turn runs on the profile's default model, a pi instance over the replaced loop client.
  f.mms.settings.set({ provider: { llmProvider: 'openai', model: 'fixture' } })
  ;(f.mms.orchestrator as unknown as { llm: unknown }).llm = {
    getSelectedModelContextLimit: () => ({ limit: 128000, modelName: 'fixture' }),
    getContextInputs: async () => ({
      systemPromptText: '',
      mcpToolsText: '',
      otherToolsText: '',
      signature: 'fixture'
    }),
    generateTitle: async () => 'First turn',
    chat: async (
      _messages: unknown,
      _tools: unknown,
      _options: unknown,
      _thinking: unknown,
      onText: (event: unknown) => void
    ) => {
      onText({ phase: 'start', content: '', contentIndex: 0 })
      onText({ phase: 'delta', content: 'first reply', contentIndex: 0 })
      return {
        text: 'first reply',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        modelName: 'fixture',
        totalResponseTimeMs: 1,
        totalTokensUsed: 2,
        contextInputs: { signature: 'fixture' },
        toolEvents: [],
        nativeMessages: []
      }
    }
  }
  const adapter = f.makeAdapter()
  await f.connect(adapter.store)
  const created = (await executeBridgeHubLocal(f.hub(), 'bridge.hub.create', {
      target: f.targetNode,
      name: 'Attach first'
    })) as { thread: { id: string } },
    ref = { nodeId: f.targetNode, entityId: created.thread.id },
    updates: any[] = [],
    errors: string[] = []
  await executeBridgeHubLocal(
    f.hub(),
    'bridge.hub.attach',
    { ref },
    {
      owner: 'trusted-gui-connection',
      thread: (event: unknown) => updates.push(event),
      error: (_ref: unknown, code: string) => errors.push(code)
    }
  )
  await vi.waitFor(() =>
    expect(updates.some((event) => event.update?.kind === 'snapshot')).toBe(true)
  )
  const before = updates.length
  await executeBridgeHubLocal(f.hub(), 'bridge.hub.send', {
    ref,
    content: 'Hello from the first turn',
    options: { id: newId('rpc') }
  })
  const text = () => JSON.stringify(updates.slice(before))
  await vi.waitFor(() => expect(text()).toContain('Hello from the first turn'))
  await vi.waitFor(() => expect(text()).toContain('first reply'))
  expect(errors).toEqual([])
})

it('delivers the first turn of a remote thread when the hub attaches after the send has started', async () => {
  const f = await fixture()
  // The turn runs on the profile's default model, a pi instance over the replaced loop client.
  f.mms.settings.set({ provider: { llmProvider: 'openai', model: 'fixture' } })
  ;(f.mms.orchestrator as unknown as { llm: unknown }).llm = {
    getSelectedModelContextLimit: () => ({ limit: 128000, modelName: 'fixture' }),
    getContextInputs: async () => ({
      systemPromptText: '',
      mcpToolsText: '',
      otherToolsText: '',
      signature: 'fixture'
    }),
    generateTitle: async () => 'First turn',
    chat: async (
      _messages: unknown,
      _tools: unknown,
      _options: unknown,
      _thinking: unknown,
      onText: (event: unknown) => void
    ) => {
      await new Promise((resolve) => setTimeout(resolve, 400))
      onText({ phase: 'start', content: '', contentIndex: 0 })
      onText({ phase: 'delta', content: 'first reply', contentIndex: 0 })
      return {
        text: 'first reply',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        modelName: 'fixture',
        totalResponseTimeMs: 1,
        totalTokensUsed: 2,
        contextInputs: { signature: 'fixture' },
        toolEvents: [],
        nativeMessages: []
      }
    }
  }
  const adapter = f.makeAdapter()
  await f.connect(adapter.store)
  const created = (await executeBridgeHubLocal(f.hub(), 'bridge.hub.create', {
      target: f.targetNode,
      name: 'Attach after'
    })) as { thread: { id: string } },
    ref = { nodeId: f.targetNode, entityId: created.thread.id },
    updates: any[] = [],
    errors: string[] = []
  const sending = executeBridgeHubLocal(f.hub(), 'bridge.hub.send', {
    ref,
    content: 'Hello from the first turn',
    options: { id: newId('rpc') }
  })
  await executeBridgeHubLocal(
    f.hub(),
    'bridge.hub.attach',
    { ref },
    {
      owner: 'trusted-gui-connection',
      thread: (event: unknown) => updates.push(event),
      error: (_ref: unknown, code: string) => errors.push(code)
    }
  )
  await vi.waitFor(() =>
    expect(updates.some((event) => event.update?.kind === 'snapshot')).toBe(true)
  )
  const before = 0
  const text = () => JSON.stringify(updates.slice(before))
  await vi.waitFor(() => expect(text()).toContain('Hello from the first turn'))
  await vi.waitFor(() => expect(text()).toContain('first reply'), { timeout: 5000 })
  await sending
  expect(errors).toEqual([])
})

it('bounds journal aliases/results and supports an unenrolled construction without admitting requests', async () => {
  const f = await fixture()
  await f.connect()
  const hub = new BridgeHub({
    ...f.hub().options,
    maxJournalRecords: 1,
    maxJournalBytes: 2048,
    maxActiveRequests: 1
  })
  const id = hub.prepare(f.targetNode, 'projects.list', {})
  expect(() => hub.prepare(f.targetNode, 'threads.list', {})).toThrow(
    expect.objectContaining({ code: 'too_large' })
  )
  await hub.submit(id)
  hub.close()
  await hub.drain()
  const blank = new NetIdentityService({
    database: f.callerDb().database,
    keys: new FileKeyStore(f.callerPath),
    clock: systemClock
  })
  // Constructor itself does not demand a configured identity or touch network.
  const before = new BridgeHub({
    ...f.hub().options,
    identity: new Proxy(blank, {
      get: (target, key) => (key === 'self' ? () => undefined : Reflect.get(target, key, target))
    })
  })
  expect(() => before.prepare(f.targetNode, 'projects.list', {})).toThrow(
    expect.objectContaining({ code: 'not_enrolled' })
  )
  before.close()
})

it('limits distinct active requests, coalesces the same original, and drains cancellation before shutdown', async () => {
  const f = await fixture()
  await f.connect()
  let started = false
  f.backend.run = async (_thread, _content, control) => {
    started = true
    await new Promise<void>((resolve) =>
      control.signal.addEventListener('abort', () => resolve(), { once: true })
    )
    throw new NetError('cancelled')
  }
  const hub = new BridgeHub({ ...f.hub().options, maxActiveRequests: 1 }),
    id = hub.prepare(
      f.targetNode,
      'orchestrator.send',
      { threadId: 'bound', content: 'One active' },
      { deadlineMs: 3000 }
    ),
    first = hub.submit(id),
    second = hub.submit(id)
  first.catch(() => {})
  expect(second).toBe(first)
  await vi.waitFor(() => expect(started).toBe(true))
  await expect(hub.projects(f.targetNode)).rejects.toMatchObject({ code: 'rate_limited' })
  hub.close()
  await hub.drain()
  expect(hub.activeCount()).toBe(0)
})

it('keeps GUI and CLI attachment ownership separate across detach and authenticated reconnect', async () => {
  const f = await fixture(),
    thread = f.mms.threads.createThread('Shared display'),
    adapter = f.makeAdapter()
  await f.connect(adapter.store)
  const ref = { nodeId: f.targetNode, entityId: thread.id },
    gui: unknown[] = [],
    cli: unknown[] = [],
    errors: string[] = []
  const guiEvents = {
      owner: 'trusted-gui-connection',
      thread: (event: unknown) => gui.push(event),
      error: (_ref: unknown, code: string) => errors.push(code)
    },
    cliEvents = {
      owner: 'trusted-cli-connection',
      thread: (event: unknown) => cli.push(event),
      error: (_ref: unknown, code: string) => errors.push(code)
    }
  await executeBridgeHubLocal(f.hub(), 'bridge.hub.attach', { ref }, guiEvents)
  await vi.waitFor(() => expect(gui.length).toBeGreaterThan(0))
  await executeBridgeHubLocal(f.hub(), 'bridge.hub.attach', { ref }, cliEvents)
  expect(cli.length).toBeGreaterThan(0)
  await executeBridgeHubLocal(f.hub(), 'bridge.hub.detach', { ref }, cliEvents)
  const cliCount = cli.length,
    guiCount = gui.length
  f.mms.orchestrator.enqueueForThread(thread.id, { content: 'Only GUI remains' })
  await vi.waitFor(() => expect(gui.length).toBeGreaterThan(guiCount))
  expect(cli).toHaveLength(cliCount)
  f.caller().close()
  f.target().close()
  const fresh = f.makeAdapter()
  await f.connect(fresh.store)
  await f.hub().reconnect(f.targetNode)
  await vi.waitFor(() => expect(f.callerStore().cursor(fresh.activate(thread.id).id).epoch).toBe(2))
  expect(errors).toEqual([])
  f.hub().detachOwner(guiEvents.owner)
  const stopped = gui.length
  f.mms.orchestrator.enqueueForThread(thread.id, { content: 'Detached GUI' })
  await new Promise((resolve) => setImmediate(resolve))
  expect(gui).toHaveLength(stopped)
})

it('journals cancellation while offline so a reconnect cannot execute a previously prepared mutation', async () => {
  const f = await fixture()
  await f.connect()
  const id = f.hub().prepare(f.targetNode, 'threads.create', { name: 'offline cancellation' })
  f.caller().close()
  f.target().close()
  await expect(f.hub().cancel(id)).rejects.toMatchObject({ code: 'peer_offline' })
  expect(f.hub().status(id).state).toBe('cancelRequested')
  await f.connect()
  await expect(f.hub().submit(id)).rejects.toMatchObject({ code: 'outcome_uncertain' })
  expect(f.mms.threads.listAllThreads()).toHaveLength(0)
})

it('delivers the previously failing 5 MiB actual MMS source snapshot over TLS after bounded document parsing', async () => {
  const f = await fixture(),
    thread = f.mms.threads.createThread('Large parser reproduction'),
    message = {
      id: 'large',
      role: 'assistant' as const,
      content: 'x'.repeat(5 * 1024 * 1024),
      timestamp: new Date().toISOString()
    }
  f.mms.threads.mutateThreadData(thread.id, () => ({ messages: [message] }))
  f.mms.orchestrator.getOrCreateSession(thread.id).messages = [message]
  const adapter = f.makeAdapter()
  await f.connect(adapter.store)
  const updates: unknown[] = [],
    errors: string[] = []
  await f.hub().attach(
    { nodeId: f.targetNode, entityId: thread.id },
    (value) => updates.push(value),
    (code) => errors.push(code)
  )
  // Delivery, not speed, is under test: a 5 MiB snapshot over TLS is slow on small CI runners.
  await vi.waitFor(() => expect(updates).toHaveLength(1), { timeout: 30000 })
  expect(updates[0]).toMatchObject({
    kind: 'snapshot',
    value: { messages: [{ content: message.content }] }
  })
  expect(errors).toEqual([])
}, 60000)
