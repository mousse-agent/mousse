/**
 * Phase 1b §9.1, the Hub half of M13: a computer reaches an engine pairing through the Hub's local methods
 * (`bridge.hub.*`), sends it a dispatched agent task (`bridge.dispatch` through `prepare` and `submit`), and asks
 * what it may do there (`bridge.access.mine`). Two fresh profiles with v1 networking off, paired through the
 * fake helper (`./checks/harness`); every call goes through the caller's window as the CLI's does.
 *
 * An engine id never reaches a v1 session: the caller's `net.session` is watched for the whole file.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { newId, type NodeId, type RpcId } from '../../src/shared/net'
import { executeBridgeHubLocal } from '../../src/mms/bridge/hub/local'
import { portableRepository } from '../../src/mms/bridge/dispatch'
import type { EngineCaller } from '../../src/mms/net/contracts'
import { canonicalJson } from '../../src/mms/net/sync/codec'
import { eventually, pairProfiles, type Pair } from './checks/harness'

const codeOf = async (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => 'answered',
    (error: { code?: string }) => error.code
  )

describe('the Hub over an engine pairing', () => {
  let pair: Pair
  let target: NodeId
  let session: ReturnType<typeof vi.spyOn>
  /** A `bridge.hub.*` call from the caller's window. */
  const hub = (method: string, params: Record<string, unknown>) => pair.dispatch(`bridge.hub.${method}`, params, true)
  let folder: string, projectId: string, threadId: string

  beforeAll(async () => {
    pair = await pairProfiles()
    target = pair.ownerOnCaller
    session = vi.spyOn(pair.caller.net, 'session')
    folder = pair.folder()
  }, 120_000)
  afterAll(async () => {
    // Nothing above went to v1.
    expect(session).not.toHaveBeenCalled()
    await pair?.close()
  }, 60_000)

  it('opens a folder, starts a thread and reads it back through the routed twins', async () => {
    const opened = await hub('openProject', { target, path: folder })
    projectId = (opened.project ?? opened).id
    expect(projectId).toBeTruthy()
    expect(JSON.stringify(await hub('projects', { target }))).toContain(projectId)

    const roots = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: folder }).toString().trim()
    expect(JSON.stringify(await hub('matchProject', { target, roots: [roots] }))).toContain(projectId)

    const created = await hub('create', { target, name: 'Over the engine', projectId })
    threadId = (created.thread ?? created).id
    expect(threadId).toBeTruthy()
    // The thread is the owner's own, written there.
    expect(pair.owner.threads.getThread(threadId)?.name).toBe('Over the engine')

    expect(JSON.stringify(await hub('threads', { target, projectId }))).toContain(threadId)
    expect(JSON.stringify(await hub('get', { ref: { nodeId: target, entityId: threadId } }))).toContain(
      'Over the engine'
    )
    expect(await hub('search', { target, query: 'Over the engine' })).toBeTruthy()
    // The owner's model list would start the agent CLIs installed here; it is not what this reads.
    const models = vi.spyOn(pair.owner.harness!, 'llmProviders').mockResolvedValue([])
    try {
      expect(await hub('composerOptions', { target })).toMatchObject({ providers: [] })
    } finally {
      models.mockRestore()
    }
    expect(await hub('questions', { ref: { nodeId: target, entityId: threadId } })).toBeTruthy()
  }, 60_000)

  it("answers an opened folder as ok and a refused one with the owner's reason, as the New project dialog reads them", async () => {
    // The dialog reads `{ ok: true, project }` or `{ ok: false, error }`, the shape a v1 computer answers.
    expect(await hub('openProject', { target, path: folder })).toMatchObject({ ok: true, project: { id: projectId } })
    expect(await hub('openProject', { target, path: join(folder, 'missing') })).toEqual({
      ok: false,
      error: 'That folder does not exist on this computer.'
    })
  }, 60_000)

  it("keeps the owner's words in any other refusal the window is told", async () => {
    const refused = await hub('threads', { target, projectId: 'no-such-project' }).then(
      () => undefined,
      (error: { message?: string }) => error.message
    )
    expect(refused).toBeTruthy()
    expect(refused).not.toBe('The request is malformed.')
  }, 60_000)

  it('changes the model, sends, steers and stops on the owner', async () => {
    const ref = { nodeId: target, entityId: threadId }
    const send = vi.spyOn(pair.owner.orchestrator, 'send').mockResolvedValue({ accepted: true } as never)
    try {
      // The owner answers each one (an answer or its own refusal): the call reached its routed row.
      await codeOf(hub('setModel', { ref, model: { llmProvider: 'pi', model: 'not-a-model' } }))
      await hub('send', { ref, content: 'hello over the engine' })
      expect(send).toHaveBeenCalledWith('hello over the engine', false, expect.objectContaining({ threadId }))
      await codeOf(hub('steer', { ref, run: newId('rpc'), text: 'and this' }))
      await codeOf(hub('abort', { ref, run: newId('rpc') }))
    } finally {
      send.mockRestore()
    }
    // Each was journaled for the pairing and finished there.
    const requests = (await hub('requests', { target })) as Array<{ method: string; state: string }>
    for (const method of ['threads.setModel', 'orchestrator.send', 'orchestrator.steer', 'orchestrator.abort'])
      expect(requests.find((row) => row.method === method)?.state, method).toBe('completed')
  }, 60_000)

  it('refuses a send that names v1 staged images, and the methods with no routed twin', async () => {
    const ref = { nodeId: target, entityId: threadId }
    expect(await codeOf(hub('send', { ref, content: 'with images', attachments: ['upload-1'] }))).toBe(
      'profile_unsupported'
    )
    expect(await codeOf(hub('storage', { target }))).toBe('profile_unsupported')
    expect(
      await codeOf(
        hub('stageAttachment', {
          target,
          upload: 'upload-1',
          index: 0,
          total: 1,
          name: 'a.png',
          mimeType: 'image/png',
          data: 'AAAA'
        })
      )
    ).toBe('profile_unsupported')
  })

  it("attaches to the thread's private stream and detaches", async () => {
    const ref = { nodeId: target, entityId: threadId }
    const updates: unknown[] = []
    const attached = (await executeBridgeHubLocal(pair.caller.bridge.hub, 'bridge.hub.attach', { ref }, {
      owner: 'window-test',
      thread: (event) => void updates.push(event)
    })) as { descriptor: { kind: string; authority: string } }
    // The stream is read from the pairing, bound to it here.
    expect(attached.descriptor).toMatchObject({ kind: 'node.thread', authority: target })
    await eventually(() => expect(updates.length).toBeGreaterThan(0))
    expect(
      await executeBridgeHubLocal(pair.caller.bridge.hub, 'bridge.hub.detach', { ref }, {
        owner: 'window-test',
        thread: () => undefined
      })
    ).toEqual({ detached: true })
  }, 60_000)

  describe('bridge.dispatch', () => {
    let repoId: string, baseCommit: string
    beforeAll(async () => {
      writeFileSync(join(folder, 'base.txt'), 'base\n')
      execFileSync('git', ['add', '-A'], { cwd: folder })
      execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: folder })
      baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: folder }).toString().trim()
      repoId = (await portableRepository(folder)).repoId
    })

    const input = () => ({
      repoId,
      baseCommit,
      agent: 'agent_dispatch',
      prompt: 'Write result.txt',
      limits: { maxTurns: 2, maxToolCalls: 3, maxElapsedMs: 60_000 }
    })

    it('is prepared, submitted and verified through the Hub', async () => {
      const service = (pair.owner.bridge as unknown as { dispatch: { run: (...args: any[]) => Promise<unknown> } })
        .dispatch
      const run = vi.spyOn(service, 'run').mockImplementation(async (value, context, execution) =>
        signedResult(value, context.id, execution)
      )
      try {
        const id = pair.caller.bridge.hub.prepare(target, 'bridge.dispatch', input(), { deadlineMs: 60_000 })
        expect(pair.caller.bridge.hub.status(id).state).toBe('prepared')
        const result = (await pair.caller.bridge.hub.submit(id)) as { rpc: string; repoId: string }
        expect(result).toMatchObject({ rpc: id, repoId })
        expect(run).toHaveBeenCalledTimes(1)
        // The journal keeps it: a query answers the same verified result without running it again.
        expect(await pair.caller.bridge.hub.query(id)).toEqual(result)
        expect(run).toHaveBeenCalledTimes(1)
        // The same through the local method the CLI calls.
        const local = (await hub('dispatch', { target, input: input(), options: { deadlineMs: 60_000 } })) as {
          repoId: string
        }
        expect(local.repoId).toBe(repoId)
      } finally {
        run.mockRestore()
      }
    }, 60_000)

    it('cancels a running dispatch on the pairing', async () => {
      const service = (pair.owner.bridge as unknown as { dispatch: { run: (...args: any[]) => Promise<unknown> } })
        .dispatch
      let started!: () => void
      const running = new Promise<void>((resolve) => (started = resolve))
      let ownerSignal: AbortSignal | undefined
      const run = vi.spyOn(service, 'run').mockImplementation(
        (_value, context: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            ownerSignal = context.signal
            started()
            context.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
          })
      )
      try {
        const id = pair.caller.bridge.hub.prepare(target, 'bridge.dispatch', input(), { deadlineMs: 60_000 })
        const submitted = codeOf(pair.caller.bridge.hub.submit(id))
        await running
        expect(await hub('cancel', { id })).toEqual({ cancelled: true })
        // The owner's handler is told.
        await eventually(() => expect(ownerSignal?.aborted).toBe(true))
        expect(await submitted).toBe('cancelled')
      } finally {
        run.mockRestore()
      }
    }, 60_000)

    it('refuses a result bound to another request', async () => {
      const service = (pair.owner.bridge as unknown as { dispatch: { run: (...args: any[]) => Promise<unknown> } })
        .dispatch
      const run = vi.spyOn(service, 'run').mockImplementation(async (value, _context, execution) =>
        signedResult(value, newId('rpc'), execution)
      )
      try {
        const id = pair.caller.bridge.hub.prepare(target, 'bridge.dispatch', input(), { deadlineMs: 60_000 })
        expect(await codeOf(pair.caller.bridge.hub.submit(id))).toBe('forbidden')
      } finally {
        run.mockRestore()
      }
    }, 60_000)
  })

  /** A dispatch result as the owner's `DispatchService` signs it, for the request it was given, answering `rpc`. */
  function signedResult(value: unknown, rpc: RpcId, execution: string) {
    const identity = pair.owner.net.runtime().identity
    const self = identity.self()!
    const dispatch = newId('dispatch')
    const bundleHash = 'b'.repeat(64)
    return identity.signAsNode({
      v: 1,
      kind: 'bridge.dispatch.result.v1',
      dispatch,
      execution,
      rpc,
      requestHash: createHash('sha256').update(canonicalJson(value)).digest('hex'),
      author: { user: self.user, node: self.node, keyEpoch: 1 },
      issuedAt: Date.now(),
      repoId: (value as { repoId: string }).repoId,
      baseCommit: (value as { baseCommit: string }).baseCommit,
      headCommit: 'c'.repeat(40),
      branch: `mousse/agent/${dispatch}`,
      ref: `refs/mousse/dispatch/${dispatch}`,
      bundleHash,
      artifact: { stream: newId('stream'), event: newId('event'), blob: `blb_${bundleHash}` },
      agent: { definitionId: 'agent_dispatch', revision: 'revision-1', profileId: 'test' },
      threadId: 'thread-1',
      errors: []
    })
  }

  describe('bridge.access.mine', () => {
    const ask = () =>
      pair.caller.netEngine.client(target).rpc('bridge.access.mine', {}, { id: newId('rpc'), deadlineMs: 10_000 })

    it('answers what this computer lets the pairing do', async () => {
      expect(await ask()).toMatchObject({ v: 1, blocked: false, threads: true, work: true })
      // Each change moves the pairing's role, which ends its connection; it connects again.
      const again = () => pair.fabric.connect(pair.callerComputer, pair.ownerOnCaller)
      await pair.ownerLocal('bridge.policy', { node: pair.callerOnOwner, work: false })
      try {
        await again()
        expect(await ask()).toMatchObject({ v: 1, threads: true, work: false })
      } finally {
        await pair.ownerLocal('bridge.policy', { node: pair.callerOnOwner, work: true })
        await again()
      }
      expect(await ask()).toMatchObject({ work: true })
    })

    it('authorizes no call from a grant that is not live, or a caller that is not the owner', () => {
      const row = pair.owner.netEngine.peerRows().find((each) => each.localId === pair.callerOnOwner)!
      const self = pair.owner.net.runtime().identity.self()!
      const caller = (change: Partial<EngineCaller>): EngineCaller =>
        ({ source: 'engine', node: row.localId, user: self.user, role: 'owner', grant: row.grant, endpoint: row.endpoint, ...change }) as EngineCaller
      const rpc = pair.owner.net.runtime().rpc
      for (const method of ['bridge.access.mine', 'bridge.dispatch']) {
        expect(() => rpc.authorizedMethod(method, caller({}))).not.toThrow()
        expect(() => rpc.authorizedMethod(method, caller({ grant: `${row.grant}-old` })), method).toThrow(
          expect.objectContaining({ code: 'forbidden' })
        )
        expect(() => rpc.authorizedMethod(method, caller({ role: 'member' as 'owner' })), method).toThrow(
          expect.objectContaining({ code: 'forbidden' })
        )
      }
    })
  })
})
