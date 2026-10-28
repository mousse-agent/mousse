import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OwnerRoutes,
  refusalOf,
  validateRoutedParams
} from '../../../../src/mms/bridge/routed/OwnerRoutes'
import { MmsRemoteBackend } from '../../../../src/mms/bridge/remote/MmsBackend'
import { PullRequestThreadService } from '../../../../src/mms/git/PullRequestThreadService'
import { SqliteBridgeAudit } from '../../../../src/mms/net/store/audit'
import { SqliteNodePolicy } from '../../../../src/mms/net/store/nodePolicy'
import { systemClock } from '../../../../src/mms/net/clock'
import { DomainRpcError } from '../../../../src/mms/protocol/domainRegistry'
import { CommandRejection } from '../../../../src/mms/run/db/RunStoreError'
import {
  ROUTED_METHODS,
  isRoutedReply,
  routedNetMethod,
  type RoutedReply,
  type RoutedRow
} from '../../../../src/shared/bridge/routed'
import { newId, type NodeCapability } from '../../../../src/shared/net'
import type { PermissionMode } from '../../../../src/shared/permissionMode'
import type { ProtocolConnectionEventType } from '../../../../src/mms/protocol/types'
import { cleanup, fixture, resources } from '../hub/fixture'

afterEach(cleanup)

const COMPUTER: NodeCapability[] = ['read', 'chat', 'write', 'settings']

/** The params that satisfy a row's own checks (its target ids and required keys), whatever the values mean. */
function baseParams(row: RoutedRow): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  if (row.target === 'thread') params[row.threadIds?.[0] ?? 'threadId'] = 'thread-1'
  if (row.target === 'folder') params.threadId = 'thread-1'
  if (row.target === 'project') params.projectId = 'project-1'
  for (const key of row.required ?? [])
    params[key] ??= key === 'path' || key === 'oldPath' ? 'src/a.ts' : 'x'
  return params
}

function repo(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'routed-repo-')))
  resources.push(() => rmSync(path, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'owner@example.test')
  git('config', 'user.name', 'Owner')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(path, 'a.txt'), 'one\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'first')
  return path
}

/** The computer that runs the threads, with every routed row registered and one other computer connected. */
async function owner(
  options: {
    caps?: NodeCapability[]
    maxMode?: PermissionMode
    connectionEvent?: ConstructorParameters<typeof OwnerRoutes>[0]['connectionEvent']
  } = {}
) {
  const f = await fixture(options.caps ?? COMPUTER)
  const policy = new SqliteNodePolicy(f.targetDb, systemClock)
  const audit = new SqliteBridgeAudit(f.targetDb, systemClock)
  if (options.maxMode) policy.set(f.callerNode, { maxPermissionMode: options.maxMode })
  new OwnerRoutes({
    services: f.mms,
    rpc: f.targetRpc,
    policy,
    audit,
    track: (work) => work,
    connectionEvent: options.connectionEvent
  }).register()
  await f.connect()
  const protocolEvents: Array<{ type: string; data: unknown; threadId?: string }> = []
  const listen = (data: unknown) => protocolEvents.push(data as never)
  f.mms.events.on('protocol:event', listen)
  resources.push(() => f.mms.events.off('protocol:event', listen))
  /** One routed call, as the computer that is not the owner makes it. Durable rows carry an idempotency key. */
  const call = async (
    method: string,
    params: Record<string, unknown>,
    idem?: string
  ): Promise<RoutedReply> => {
    const row = ROUTED_METHODS[method]
    const reply = await f.caller().rpc(routedNetMethod(method), params, {
      id: newId('rpc'),
      ...(row.durable ? { idem: idem ?? `idem-${newId('rpc')}` } : {}),
      deadlineMs: 20_000
    })
    expect(isRoutedReply(reply)).toBe(true)
    return reply as RoutedReply
  }
  const ok = async (method: string, params: Record<string, unknown>) => {
    const reply = await call(method, params)
    if (!reply.ok) throw new Error(`${method} refused: ${reply.error.code}: ${reply.error.message}`)
    return reply.result as Record<string, any>
  }
  const thread = (name = 'A thread', projectId?: string, projectPath?: string) =>
    f.mms.threads.createThread(name, projectId, projectPath, {})
  return { f, policy, audit, call, ok, thread, protocolEvents }
}

describe('the routed methods the owner registers', () => {
  it('registers one Net method per row with its fixed capability, and nothing for a local method', async () => {
    const { f } = await owner()
    const registered = f.targetRpc.methods().filter((name) => name.startsWith('routed.'))
    // The rows, and `routed.page` that fetches a reply too large for one RPC reply (staging and streams are opt-in).
    expect(registered).toEqual([...Object.keys(ROUTED_METHODS), 'page'].map(routedNetMethod).sort())
    expect(f.targetRpc.methodInfo(routedNetMethod('page'))).toMatchObject({
      family: 'routed',
      capability: 'read',
      requires: ['settings'],
      mutating: false,
      ephemeral: true
    })
    for (const [method, row] of Object.entries(ROUTED_METHODS)) {
      const info = f.targetRpc.methodInfo(routedNetMethod(method))!
      expect(info, method).toMatchObject({
        family: 'routed',
        capability: row.capability,
        requires: ['settings'],
        mutating: row.durable
      })
      expect(Boolean(info.ephemeral), method).toBe(!row.durable)
      // Durable results stay small in the ledger; a lost reply is "may have happened", not a full replay.
      expect(info.ledgerResultMaxBytes, method).toBe(row.durable ? 16 * 1024 : undefined)
    }
    for (const method of [
      'threads.purge',
      'files.writeDirect',
      'files.root',
      'settings.set',
      'pty.create'
    ])
      expect(f.targetRpc.methodInfo(routedNetMethod(method)), method).toBeUndefined()
  }, 60_000)

  it('refuses every row with one extra key, and the keys no routed call may carry', async () => {
    await owner()
    for (const [method, row] of Object.entries(ROUTED_METHODS)) {
      expect(
        () => validateRoutedParams(method, row, baseParams(row)),
        `${method} accepts its own keys`
      ).not.toThrow()
      for (const extra of [
        'bogus',
        'cwd',
        'env',
        'command',
        'shellArgs',
        'source',
        'projectPath',
        'profileId',
        'expectedProfileId'
      ])
        expect(
          () => validateRoutedParams(method, row, { ...baseParams(row), [extra]: 'x' }),
          `${method} + ${extra}`
        ).toThrow(expect.objectContaining({ code: 'bad_request' }))
      expect(() => validateRoutedParams(method, row, [])).toThrow(
        expect.objectContaining({ code: 'bad_request' })
      )
      for (const key of row.required ?? []) {
        const { [key]: _removed, ...without } = baseParams(row)
        expect(
          () => validateRoutedParams(method, row, without),
          `${method} without ${key}`
        ).toThrow(expect.objectContaining({ code: 'bad_request' }))
      }
    }
  }, 60_000)

  it('refuses the extra key over the wire before anything is admitted', async () => {
    const { f, thread } = await owner()
    const t = thread()
    await expect(
      f
        .caller()
        .rpc(
          routedNetMethod('threads.get'),
          { threadId: t.id, bogus: 1 },
          { id: newId('rpc'), deadlineMs: 5000 }
        )
    ).rejects.toMatchObject({ code: 'bad_request' })
    await expect(
      f
        .caller()
        .rpc(
          routedNetMethod('threads.rename'),
          { threadId: t.id, name: 'x', source: 'cli' },
          { id: newId('rpc'), idem: 'rename-extra', deadlineMs: 5000 }
        )
    ).rejects.toMatchObject({ code: 'bad_request' })
    expect(f.mms.threads.getThread(t.id)!.name).toBe('A thread')
  }, 60_000)

  it('refuses a node without Works on threads on every row', async () => {
    const { f } = await owner({ caps: ['read', 'chat', 'write'] })
    for (const [method, row] of Object.entries(ROUTED_METHODS)) {
      const attempt = f.caller().rpc(routedNetMethod(method), baseParams(row), {
        id: newId('rpc'),
        ...(row.durable ? { idem: `settings-${method}` } : {}),
        deadlineMs: 5000
      })
      await expect(attempt, method).rejects.toMatchObject({ code: 'forbidden' })
    }
  }, 120_000)

  it('refuses a path that is not inside the thread, and a file call with no thread or project', async () => {
    const { call, thread } = await owner()
    const t = thread()
    for (const path of [
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      '\\\\host\\share\\x',
      '//host/share'
    ])
      await expect(call('files.read', { threadId: t.id, path })).rejects.toMatchObject({
        code: 'bad_request'
      })
    await expect(call('files.list', {})).rejects.toMatchObject({ code: 'bad_request' })
    await expect(call('files.list', { threadId: t.id, projectId: 'p' })).rejects.toMatchObject({
      code: 'bad_request'
    })
  }, 60_000)
})

describe('reads and refusals', () => {
  it('reads a thread and counts the read, and answers an unknown id with a completed refusal', async () => {
    const { ok, call, thread, audit, f } = await owner()
    const t = thread('Readable')
    expect((await ok('threads.get', { threadId: t.id })).thread).toMatchObject({
      id: t.id,
      name: 'Readable'
    })
    expect(audit.reads(f.callerNode)).toEqual([
      expect.objectContaining({ calls: 1, bytes: expect.any(Number) })
    ])
    expect(audit.reads(f.callerNode)[0].bytes).toBeGreaterThan(20)

    const unknown = await call('threads.get', { threadId: 'no-such-thread' })
    expect(unknown).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'thread_not_found',
        details: { threadId: 'no-such-thread' }
      })
    })
    expect(await call('queue.list', { threadId: 'no-such-thread' })).toMatchObject({
      ok: false,
      error: { code: 'thread_not_found' }
    })
    expect(await call('threads.list', { projectId: 'no-such-project' })).toMatchObject({
      ok: false,
      error: { code: 'project_not_found' }
    })
    expect(await call('pullRequests.list', { projectId: 'no-such-project' })).toMatchObject({
      ok: false,
      error: { code: 'project_not_found' }
    })
  }, 60_000)

  it('lists subagent threads for a routed caller, which the phone API hides', async () => {
    const { ok, thread, f } = await owner()
    const parent = thread('Parent'),
      child = thread('Child')
    f.mms.threads.updateThreadMeta(child.id, {
      lineage: { parentThreadId: parent.id, rootThreadId: parent.id, relationship: 'subagent' }
    })
    const routed = (await ok('threads.list', {})).threads as Array<{ id: string }>
    expect(routed.map((row) => row.id).sort()).toEqual([child.id, parent.id].sort())
    const phone = (await new MmsRemoteBackend(f.mms).execute('threads.list', {})) as {
      threads: Array<{ id: string }>
    }
    expect(phone.threads.map((row) => row.id)).toEqual([parent.id])
  }, 60_000)

  it('answers a refusal the way the owner window gets it, completed in the ledger and not uncertain', async () => {
    const { call, ok, thread, f, audit } = await owner({ maxMode: 'accept_edits' })
    const t = thread()
    const queued = await ok('queue.enqueue', { threadId: t.id, content: 'later' })
    expect(queued.item).toMatchObject({ content: 'later', permissionMode: 'accept_edits' })

    // A stale queue revision keeps its code and details.
    const stale = await call('queue.reorder', {
      threadId: t.id,
      orderedIds: [queued.item.id],
      expectedRevision: 'not-the-revision'
    })
    expect(stale).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'revision_mismatch',
        details: expect.objectContaining({ expectedRevision: 'not-the-revision' })
      })
    })

    // The device's limit: a mode above it is refused with the limit named; a stricter mode is set.
    const above = await call('threads.setPermissionMode', { threadId: t.id, mode: 'full' })
    expect(above).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'permission_mode_above_ceiling',
        details: expect.objectContaining({ limit: 'accept_edits', reason: 'device_limit' })
      })
    })
    expect(f.mms.threads.getThread(t.id)!.permissionMode).toBeUndefined()
    expect(
      (await ok('threads.setPermissionMode', { threadId: t.id, mode: 'ask' })).thread
    ).toMatchObject({ permissionMode: 'ask' })

    // The refusal is a completed request: a retry with the same key gets the same refusal and runs nothing again.
    const key = 'mode-retry-1'
    const first = await call('threads.setPermissionMode', { threadId: t.id, mode: 'full' }, key)
    const rows = audit.recent(100, f.callerNode).length
    expect(await call('threads.setPermissionMode', { threadId: t.id, mode: 'full' }, key)).toEqual(
      first
    )
    expect(audit.recent(100, f.callerNode).length).toBe(rows)
    const stored = f.targetDb.database
      .prepare(
        "SELECT state, result FROM net_executions WHERE target='routed.threads.setPermissionMode' AND trigger=?"
      )
      .get(key) as { state: string; result: string }
    expect(stored.state).toBe('completed')
    expect(JSON.parse(stored.result)).toMatchObject({
      ok: false,
      error: { code: 'permission_mode_above_ceiling' }
    })
    // The mode change the person made is on the thread's record with the computer that made it.
    const events = f.mms.runEngine.store.db
      .statement(
        "SELECT payload FROM thread_events WHERE thread_id = ? AND type = 'thread.permission_mode'"
      )
      .all(t.id) as Array<{ payload: string }>
    expect(events.map((row) => JSON.parse(row.payload))).toEqual([
      expect.objectContaining({ to: 'ask', node: f.callerNode })
    ])
  }, 60_000)

  it('keeps an unexpected failure uncertain, audits it as uncertain, and records nothing as completed for it', async () => {
    const { f, thread, audit } = await owner()
    const t = thread()
    vi.spyOn(f.mms.threads, 'updateThreadMeta').mockImplementation(() => {
      throw new TypeError('this is a bug, not a refusal')
    })
    const error = await f
      .caller()
      .rpc(
        routedNetMethod('threads.rename'),
        { threadId: t.id, name: 'new' },
        { id: newId('rpc'), idem: 'rename-crash', deadlineMs: 5000 }
      )
      .catch((thrown: unknown) => thrown)
    expect(error).toMatchObject({ code: 'outcome_uncertain' })
    const row = f.targetDb.database
      .prepare("SELECT state FROM net_executions WHERE target='routed.threads.rename'")
      .get() as { state: string }
    expect(row.state).toBe('uncertain')
    // It may have made its change, so the audit says so.
    expect(audit.recent(5, f.callerNode)).toEqual([
      expect.objectContaining({ method: 'threads.rename', outcome: 'uncertain', kind: 'change' })
    ])
    vi.restoreAllMocks()
  }, 60_000)

  it('answers the checks a handler makes before it changes anything as typed refusals, not as unknown outcomes', async () => {
    const { call, thread } = await owner()
    const t = thread()
    expect(await call('agents.stop', { threadId: t.id, agentId: 'no-such-agent' })).toMatchObject({
      ok: false,
      error: { code: 'agent_not_found' }
    })
    expect(await call('queue.remove', { threadId: t.id, itemId: 'no-such-item' })).toMatchObject({
      ok: false,
      error: { code: 'queue_item_not_found' }
    })
    expect(
      await call('actions.getAffectedFiles', { threadId: t.id, actionId: 'nope' })
    ).toMatchObject({
      ok: false,
      error: {
        code: expect.stringMatching(/workspace_not_ready|thread_has_no_folder|action_not_found/)
      }
    })
    expect(await call('operations.abort', { threadId: t.id, operationId: 'nope' })).toMatchObject({
      ok: false
    })
    expect(
      await call('applets.get', { threadId: t.id, appletId: 'a', revisionId: 'b' })
    ).toMatchObject({ ok: false, error: { code: 'applet_unavailable' } })
    expect(
      await call('threads.setWorktreeEnabled', { threadId: t.id, enabled: true })
    ).toMatchObject({
      ok: true
    })
  }, 60_000)

  it('reports which errors are refusals', () => {
    expect(
      refusalOf(new DomainRpcError('thread_not_found', 'Thread not found', { threadId: 't' }))
    ).toEqual({ code: 'thread_not_found', message: 'Thread not found', details: { threadId: 't' } })
    expect(refusalOf(new CommandRejection('thread_busy', 'busy'))).toMatchObject({
      code: 'thread_busy'
    })
    expect(refusalOf(new Error('plain'))).toBeUndefined()
    expect(refusalOf(new TypeError('bug'))).toBeUndefined()
    expect(refusalOf('text')).toBeUndefined()
  })
})

describe('files and the folder of a thread', () => {
  it('reads inside the thread folder, and never falls back to the home folder', async () => {
    const { ok, call, thread, f } = await owner()
    const path = repo()
    const project = f.mms.projects.openProject(path)
    const t = thread('With folder', project.id, path)
    const listed = await ok('files.list', { threadId: t.id })
    expect((listed.entries as Array<{ name: string }>).map((entry) => entry.name)).toContain(
      'a.txt'
    )
    expect(await ok('files.read', { projectId: project.id, path: 'a.txt' })).toMatchObject({
      path: 'a.txt',
      content: expect.stringContaining('one')
    })
    // The panel is told why, as the owner's own window is, and a path that leaves the folder has a code of its own.
    expect(await call('files.read', { threadId: t.id, path: '../outside.txt' })).toMatchObject({
      ok: false,
      error: { code: 'path_outside_folder', message: 'Path is outside the project root' }
    })
    expect(await call('files.read', { threadId: t.id, path: 'missing.txt' })).toMatchObject({
      ok: false,
      error: { code: 'file_unavailable' }
    })

    expect(await call('files.list', { threadId: 'no-such-thread' })).toMatchObject({
      ok: false,
      error: { code: 'thread_not_found' }
    })
    expect(await call('files.list', { projectId: 'no-such-project' })).toMatchObject({
      ok: false,
      error: { code: 'project_not_found' }
    })
    // A thread with no folder lists nothing rather than the home folder.
    const loose = thread('No folder')
    expect(await call('files.list', { threadId: loose.id })).toMatchObject({
      ok: false,
      error: { code: 'thread_has_no_folder' }
    })
  }, 120_000)

  it("saves as an action of the thread that the owner's own window hears about", async () => {
    const { ok, thread, f, protocolEvents } = await owner()
    const path = repo()
    const project = f.mms.projects.openProject(path)
    const t = thread('Saved', project.id, path)
    const saved = await ok('files.write', {
      threadId: t.id,
      path: 'b.txt',
      content: 'from the laptop\n'
    })
    expect(saved).toMatchObject({ path: 'b.txt', receiptId: expect.any(String) })
    const announced = protocolEvents.find((event) => event.type === 'actions.updated')
    expect(announced).toMatchObject({ threadId: t.id, data: { threadId: t.id } })
  }, 120_000)
})

describe('a routed call runs as a person on another computer', () => {
  it('sends as a person with the computer kept aside, and the owner never narrows agent access', async () => {
    const { ok, thread, f } = await owner({ maxMode: 'accept_edits' })
    const t = thread()
    const send = vi
      .spyOn(f.mms.orchestrator, 'send')
      .mockResolvedValue({ message: '', actions: [], runId: 'run-1', accepted: true } as never)
    const channel = vi.spyOn(f.mms.orchestrator, 'runChannelTurn')
    await ok('orchestrator.send', { threadId: t.id, content: 'hello', clientRequestId: 'req-1' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][2]).toMatchObject({
      threadId: t.id,
      source: 'gui',
      awaitMode: 'ack',
      clientRequestId: 'req-1',
      permissionMode: 'accept_edits',
      sentFrom: { node: f.callerNode },
      actor: { kind: 'user', via: 'bridge', node: f.callerNode, maxPermissionMode: 'accept_edits' }
    })
    expect(channel).not.toHaveBeenCalled()
    expect(f.mms.threads.getThread(t.id)!.accessCeiling).toBeUndefined()
    // A device the owner trusted with Full access is limited to nothing the thread does not already have.
    vi.restoreAllMocks()
  }, 60_000)

  it('records the computer on the thread and the run when a message is admitted', async () => {
    const { f, thread } = await owner()
    const t = thread()
    const recorded = (
      f.mms.orchestrator as unknown as {
        recordSentFrom(threadId: string, runId: string, node: string): void
      }
    ).recordSentFrom.bind(f.mms.orchestrator)
    recorded(t.id, 'run-1', f.callerNode)
    expect(f.mms.threads.getThread(t.id)!.sentFrom).toEqual({ node: f.callerNode })
    const events = f.mms.runEngine.store.db
      .statement(
        "SELECT run_id, payload FROM thread_events WHERE thread_id = ? AND type = 'run.sent_from'"
      )
      .all(t.id) as Array<{ run_id: string; payload: string }>
    expect(events.map((row) => [row.run_id, JSON.parse(row.payload)])).toEqual([
      ['run-1', { node: f.callerNode }]
    ])
  }, 60_000)

  it('refuses a /workflow command from another computer, because a device limit cannot bind a workflow', async () => {
    const { call, thread, f } = await owner({ maxMode: 'ask' })
    const t = thread()
    const prepare = vi
      .spyOn(f.mms.platform.workflowChat!, 'prepare')
      .mockResolvedValue({ content: '/review', workflowInvocationId: 'invocation-1' } as never)
    const send = vi.spyOn(f.mms.orchestrator, 'send')
    const enqueue = vi.spyOn(f.mms.orchestrator, 'enqueueForThread')
    for (const method of ['orchestrator.send', 'queue.enqueue'])
      expect(await call(method, { threadId: t.id, content: '/review' })).toMatchObject({
        ok: false,
        error: { code: 'workflow_not_available_remotely' }
      })
    // It was prepared as a window would, then refused before anything was sent or queued.
    expect(prepare).toHaveBeenCalledWith(
      t.id,
      expect.objectContaining({ content: '/review' }),
      'gui'
    )
    expect(send).not.toHaveBeenCalled()
    expect(enqueue).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  }, 60_000)

  it('gives a queued message the limit of its device, and a steer that must wait too', async () => {
    const { ok, thread, f } = await owner({ maxMode: 'ask' })
    const t = thread()
    const queued = await ok('queue.enqueue', { threadId: t.id, content: 'wait' })
    expect(queued.item.permissionMode).toBe('ask')
    expect(
      f.mms.orchestrator.listQueue(t.id).find((item) => item.id === queued.item.id)
    ).toMatchObject({ permissionMode: 'ask' })
    const steer = vi
      .spyOn(f.mms.orchestrator, 'steerThreadOrEnqueueExternal')
      .mockReturnValue({ steered: false, queued: true })
    await ok('orchestrator.steer', { threadId: t.id, text: 'also this' })
    expect(steer).toHaveBeenCalledWith(
      t.id,
      'also this',
      expect.objectContaining({ source: 'gui', permissionMode: 'ask' })
    )
    vi.restoreAllMocks()
  }, 60_000)

  it('is refused the things only a window of this computer may do', async () => {
    const { call, f } = await owner()
    // Nothing for a local window is reachable: not routed, so not registered.
    for (const method of [
      'files.writeDirect',
      'files.root',
      'threads.purge',
      'browser.sessions.list'
    ])
      await expect(
        f
          .caller()
          .rpc(
            routedNetMethod(method),
            {},
            { id: newId('rpc'), idem: `x-${method}`, deadlineMs: 5000 }
          )
      ).rejects.toMatchObject({ code: 'forbidden' })
    expect(await call('threads.list', {})).toMatchObject({ ok: true })
  }, 60_000)

  it('gives a Git action started here its own connection, so only this computer can stop it', async () => {
    const events: Array<{ node: string; type: ProtocolConnectionEventType }> = []
    const { call, ok, thread, f } = await owner({
      connectionEvent: async (caller, type) => void events.push({ node: caller.node, type })
    })
    const path = repo()
    const project = f.mms.projects.openProject(path)
    const t = thread('Git', project.id, path)
    expect(await ok('git.status', { projectId: project.id })).toMatchObject({
      status: expect.anything()
    })
    // Another connection cannot cancel what a bridge connection started: nothing is running, so nothing is cancelled.
    expect(
      await ok('git.cancelOperation', { threadId: t.id, operationId: 'op-not-running' })
    ).toEqual({ cancelled: false })
    expect(
      await call('git.cancelOperation', { threadId: 'missing', operationId: 'op' })
    ).toMatchObject({ ok: false, error: { code: 'thread_not_found' } })
  }, 120_000)
})

describe('the profile barrier and the audit', () => {
  it('holds the profile request barrier while a call runs, and is refused once the profile drains', async () => {
    const { ok, call, thread, f } = await owner()
    const t = thread()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    vi.spyOn(f.mms.orchestrator, 'getContextUsage').mockImplementation(async () => {
      await held
      return { used: 1, limit: 2 } as never
    })
    const running = ok('orchestrator.contextUsage', { threadId: t.id })
    await vi.waitFor(() =>
      expect(f.mms.getOwnedActivity()['rpc:orchestrator.contextUsage']).toBe(1)
    )
    release()
    expect(await running).toMatchObject({ used: 1 })
    await vi.waitFor(() =>
      expect(f.mms.getOwnedActivity()['rpc:orchestrator.contextUsage'] ?? 0).toBe(0)
    )
    vi.restoreAllMocks()

    f.mms.beginShutdown()
    const draining = await call('threads.get', { threadId: t.id })
    expect(draining).toMatchObject({ ok: false, error: { code: 'profile_draining' } })
  }, 60_000)

  it('keeps what was changed and what was refused, and counts reads', async () => {
    const { ok, call, thread, audit, f } = await owner()
    const t = thread()
    await ok('threads.rename', { threadId: t.id, name: 'Renamed' })
    await call('threads.rename', { threadId: 'missing', name: 'x' })
    await ok('threads.get', { threadId: t.id })
    const rows = audit.recent(10, f.callerNode)
    expect(rows.map((row) => [row.method, row.outcome, row.kind]).reverse()).toEqual([
      ['threads.rename', 'ok', 'change'],
      ['threads.rename', 'thread_not_found', 'refused']
    ])
    expect(rows[1]).toMatchObject({ thread: t.id, node: f.callerNode })
    expect(audit.reads(f.callerNode)).toEqual([expect.objectContaining({ calls: 1 })])
  }, 60_000)

  it('does not let refused reads push a device’s earlier changes out of the audit', async () => {
    const { ok, call, thread, audit, f } = await owner()
    const t = thread()
    await ok('threads.rename', { threadId: t.id, name: 'Renamed' })
    for (let attempt = 0; attempt < 300; attempt++)
      expect(await call('threads.get', { threadId: 'nope' })).toMatchObject({ ok: false })
    // The change is still there, and the refused reads are only counted.
    expect(audit.recent(1000, f.callerNode).map((row) => row.method)).toEqual(['threads.rename'])
    expect(audit.reads(f.callerNode)).toEqual([expect.objectContaining({ calls: 300 })])
  }, 120_000)

  it('audits a refused projects.open as refused, and the folder it opened by project', async () => {
    const { call, ok, audit, f } = await owner()
    const refused = await call('projects.open', { path: f.targetPath })
    expect(refused).toMatchObject({ ok: false, error: { code: 'project_refused' } })
    const folder = repo()
    const opened = await ok('projects.open', { path: folder })
    const [success, refusal] = audit.recent(5, f.callerNode)
    expect(success).toMatchObject({
      method: 'projects.open',
      outcome: 'ok',
      kind: 'change',
      project: opened.project.id
    })
    expect(refusal).toMatchObject({
      method: 'projects.open',
      outcome: 'project_refused',
      kind: 'refused',
      project: expect.stringMatching(/^path:[0-9a-f]{12}$/)
    })
    // The path itself is not kept.
    expect(JSON.stringify(audit.recent(5, f.callerNode))).not.toContain(f.targetPath)
  }, 120_000)
})

describe('a device’s mode limit holds for every way its text can run', () => {
  it('leaves a message the owner queued no looser than the limit once the device edits it, and drops the queue from the reply', async () => {
    const { ok, thread, f } = await owner({ maxMode: 'accept_edits' })
    const t = thread()
    f.mms.orchestrator.setThreadPermissionMode(t.id, 'full')
    const item = f.mms.orchestrator.enqueueForThread(
      t.id,
      { content: 'owner text' },
      { source: 'gui' }
    )
    expect(item.permissionMode).toBeUndefined()
    const edited = await ok('queue.edit', {
      threadId: t.id,
      itemId: item.id,
      content: 'device text'
    })
    expect(edited.items).toBeUndefined()
    expect(edited.item).toMatchObject({
      content: 'device text',
      permissionMode: 'accept_edits',
      sentFrom: { node: f.callerNode }
    })
    expect(f.mms.orchestrator.listQueue(t.id).find((entry) => entry.id === item.id)).toMatchObject({
      content: 'device text',
      permissionMode: 'accept_edits',
      sentFrom: { node: f.callerNode }
    })
    expect(f.mms.threads.getThread(t.id)!.sentFrom).toEqual({ node: f.callerNode })
    // A queue write answers with the item only; the caller reads the queue from queue.list.
    const more = await ok('queue.enqueue', { threadId: t.id, content: 'another' })
    expect(Object.keys(more).sort()).toEqual(['item'])
    expect(more.item).toMatchObject({
      permissionMode: 'accept_edits',
      sentFrom: { node: f.callerNode }
    })
    expect((await ok('queue.list', { threadId: t.id })).items).toHaveLength(2)
  }, 60_000)

  it('sends the first message of a thread started from a pull request under the limit, naming the computer', async () => {
    const { ok, f } = await owner({ maxMode: 'accept_edits' })
    const path = repo()
    const project = f.mms.projects.openProject(path)
    const send = vi
      .spyOn(f.mms.orchestrator, 'send')
      .mockResolvedValue({ message: '', actions: [], runId: 'run-pr', accepted: true } as never)
    vi.spyOn(PullRequestThreadService.prototype, 'startThread').mockImplementation(async function (
      this: unknown,
      input
    ) {
      const deps = (
        this as {
          deps: {
            threads: typeof f.mms.threads
            prepareThread(thread: unknown): { id: string } & Record<string, unknown>
            send(id: string, content: string): Promise<void>
          }
        }
      ).deps
      const created = deps.threads.createThread('From a pull request', input.projectId, path, {})
      const prepared = deps.prepareThread(created)
      if (input.send) await deps.send(prepared.id, input.message ?? 'Look at this pull request')
      return { thread: prepared } as never
    })
    const started = await ok('pullRequests.startThread', {
      projectId: project.id,
      number: 7,
      send: true,
      message: 'run something'
    })
    expect(started.threads).toBeUndefined()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][2]).toMatchObject({
      source: 'gui',
      awaitMode: 'ack',
      permissionMode: 'accept_edits',
      sentFrom: { node: f.callerNode },
      actor: { kind: 'user', via: 'bridge', node: f.callerNode }
    })
    expect(f.mms.threads.getThread(started.thread.id)!.startedFrom).toEqual({ node: f.callerNode })
    vi.restoreAllMocks()
  }, 120_000)
})
