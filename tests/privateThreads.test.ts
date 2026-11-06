/**
 * Private threads (`Thread.localOnly`, issue #672): a private thread and everything below it stay on the
 * computer that started it. The desktop app and the CLI see them; another computer (a routed call,
 * `clientType: 'bridge'`), a phone (no connection) and any other client do not, in lists, search, the
 * pushed lists stream, the phone API, activity and turn snapshots, the trash inventory and storage usage.
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsListsSource } from '../src/mms/bridge/remote/MmsListsSource'
import { MmsRemoteBackend } from '../src/mms/bridge/remote/MmsBackend'
import { dispatchMethod, type HandlerContext } from '../src/mms/protocol/handlers'
import type { ProtocolClientType } from '../src/mms/protocol/types'
import { isLocalOnlyThread } from '../src/shared/threadLineage'
import { PullRequestThreadService } from '../src/mms/git/PullRequestThreadService'
import type { Thread, ThreadSearchResult } from '../src/shared/types'

const ids = (threads: ReadonlyArray<{ id: string }>) => threads.map((thread) => thread.id).sort()

describe('private threads', () => {
  let home: string
  let mms: MousseMainService

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-private-threads-'))
    process.env.MOUSSE_HOME = home
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
  })

  afterEach(async () => {
    await mms.stop()
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    delete process.env.MOUSSE_HOME
  })

  /** A request as `clientType` makes it; `undefined` is a phone's backend, which has no connection. */
  const as = (clientType: ProtocolClientType | undefined) =>
    (method: string, params: Record<string, unknown> = {}) =>
      dispatchMethod(
        {
          mms,
          globalSequence: () => 0,
          ...(clientType ? { connection: { id: `c-${clientType}`, clientType } } : {})
        } as unknown as HandlerContext,
        method,
        params
      )

  /** A shared thread, a private one with a subagent, and a subagent written before children carried the flag. */
  function seed() {
    const subagentOf = (parentThreadId: string) => ({ parentThreadId, rootThreadId: parentThreadId, relationship: 'subagent' as const })
    const shared = mms.threads.createThread('Shared budget', undefined, undefined, { started: true })
    const secret = mms.threads.createThread('Secret budget', undefined, undefined, { started: true, localOnly: true })
    const child = mms.threads.createThread('Secret budget helper', undefined, undefined, { lineage: subagentOf(secret.id), localOnly: true, started: true })
    const legacyChild = mms.threads.createThread('Secret budget older helper', undefined, undefined, { lineage: subagentOf(secret.id), started: true })
    return { shared, secret, child, legacyChild }
  }

  it('is fixed at creation and resolves through the lineage root', () => {
    const { shared, secret, child, legacyChild } = seed()
    expect(secret.localOnly).toBe(true)
    expect(shared.localOnly).toBeUndefined()
    const all = mms.threads.listAllThreads()
    expect(isLocalOnlyThread(child, all)).toBe(true)
    // The root decides for a child that has no flag of its own.
    expect(isLocalOnlyThread(legacyChild, all)).toBe(true)
    expect(isLocalOnlyThread(shared, all)).toBe(false)
    // Renaming keeps the flag: every write spreads the record.
    expect(mms.threads.updateThreadMeta(secret.id, { name: 'Renamed' }).localOnly).toBe(true)
    expect(mms.threads.getThread(secret.id)?.localOnly).toBe(true)
  })

  it('is listed and searched on this computer only', async () => {
    const { shared, secret, child, legacyChild } = seed()
    const gui = (await as('gui')('threads.list')) as { threads: Thread[] }
    expect(ids(gui.threads)).toEqual(ids([shared, secret, child, legacyChild]))
    const cli = (await as('cli')('threads.list')) as { threads: Thread[] }
    expect(ids(cli.threads)).toEqual(ids([shared, secret]))
    for (const caller of ['bridge', 'test', undefined] as const) {
      const { threads } = (await as(caller)('threads.list')) as { threads: Thread[] }
      expect(ids(threads), String(caller)).toEqual([shared.id])
      const { results } = (await as(caller)('threads.search', { query: 'budget' })) as { results: ThreadSearchResult[] }
      expect(results.map((hit) => hit.threadId), String(caller)).toEqual([shared.id])
    }
    const { results } = (await as('gui')('threads.search', { query: 'budget' })) as { results: ThreadSearchResult[] }
    expect(results.map((hit) => hit.threadId).sort()).toEqual(ids([shared, secret]))
  })

  it('can only be started from this computer', async () => {
    const created = (await as('gui')('threads.create', { name: 'Mine', localOnly: true })) as { thread: Thread }
    expect(created.thread.localOnly).toBe(true)
    const fromCli = (await as('cli')('threads.create', { name: 'Mine too', localOnly: true })) as { thread: Thread }
    expect(fromCli.thread.localOnly).toBe(true)
    for (const caller of ['bridge', undefined] as const)
      await expect(as(caller)('threads.create', { name: 'Not here', localOnly: true }), String(caller)).rejects.toMatchObject({ code: 'invalid_params' })
  })

  it('leaves no name or status in the results of other devices', async () => {
    const { shared, secret } = seed()
    mms.orchestrator.setAwaitingInput(secret.id)
    const remote = as('bridge')
    const activity = (await remote('activity.snapshot')) as { activity: Record<string, unknown> }
    expect(Object.keys(activity.activity)).not.toContain(secret.id)
    const snapshot = (await remote('thread.snapshot', { threadId: shared.id })) as { turnSnapshot: Record<string, unknown> }
    expect(Object.keys(snapshot.turnSnapshot)).not.toContain(secret.id)
    expect(Object.keys(((await as('gui')('thread.snapshot', { threadId: shared.id })) as { turnSnapshot: Record<string, unknown> }).turnSnapshot)).toContain(secret.id)
    const reference = (await remote('chatReferences.resolve', { reference: { kind: 'thread', threadId: secret.id, title: 'x' } })) as { reference: unknown }
    expect(reference.reference).toBeNull()
  })

  it('is out of the trash inventory other devices read', async () => {
    const { shared, secret } = seed()
    await mms.trashThread(secret.id)
    await mms.trashThread(shared.id)
    const local = (await as('gui')('threads.inventory')) as { lifecycles: Array<{ taskId: string }>; taskNames: Record<string, string> }
    expect(local.lifecycles.map((record) => record.taskId)).toEqual(expect.arrayContaining([secret.id, shared.id]))
    const remote = (await as('bridge')('threads.inventory')) as { lifecycles: Array<{ taskId: string }>; taskNames: Record<string, string> }
    expect(remote.lifecycles.map((record) => record.taskId)).toContain(shared.id)
    expect(remote.lifecycles.map((record) => record.taskId)).not.toContain(secret.id)
    expect(Object.values(remote.taskNames)).not.toContain('Secret budget')
  })

  it('never reaches a phone or another computer through the lists stream or the phone API', async () => {
    const { shared, secret, child } = seed()
    for (const options of [{}, { private: true }]) {
      const lists = new MmsListsSource(mms, undefined, options).snapshot()
      expect(lists.threads.map((row) => row.id), JSON.stringify(options)).toEqual([shared.id])
      expect(JSON.stringify(lists)).not.toContain('Secret budget')
    }
    const backend = new MmsRemoteBackend(mms)
    expect(() => backend.snapshot(secret.id)).toThrow()
    expect(() => backend.snapshot(child.id)).toThrow()
    await expect(backend.execute('threads.get' as never, { threadId: secret.id })).rejects.toMatchObject({ code: 'stream_unknown' })
    await expect(backend.stop(secret.id)).rejects.toMatchObject({ code: 'stream_unknown' })
    expect(backend.snapshot(shared.id)).toBeTruthy()
  })

  it('makes its subagents and forks private, and refuses work on other computers', async () => {
    const { shared, secret } = seed()
    // The orchestrator's own creation paths, as the Run Engine calls them.
    const orchestrator = mms.orchestrator as unknown as {
      createChildThread(request: Record<string, unknown>): { threadId: string }
      createForkThread(creation: Record<string, unknown>): { threadId: string }
      delegateRemoteTask(...args: unknown[]): Promise<{ started: boolean; code?: string }>
      listComputers(threadId: string): Promise<{ computers: unknown[]; note: string }>
    }
    const child = orchestrator.createChildThread({ parentThreadId: secret.id, parentRunId: 'run-1', clientRequestId: 'c1', prompt: 'Look', workspace: 'shared', wake: 'none' })
    expect(mms.threads.getThread(child.threadId)?.localOnly).toBe(true)
    const sharedChild = orchestrator.createChildThread({ parentThreadId: shared.id, parentRunId: 'run-2', clientRequestId: 'c2', prompt: 'Look', workspace: 'shared', wake: 'none' })
    expect(mms.threads.getThread(sharedChild.threadId)?.localOnly).toBeUndefined()
    const fork = orchestrator.createForkThread({ kind: 'fork', sourceThreadId: secret.id, sourceRunId: 'run-1' })
    expect(mms.threads.getThread(fork.threadId)?.localOnly).toBe(true)
    const remote = await orchestrator.delegateRemoteTask(secret.id, 'run-1', { computer: 'Office', prompt: 'p', title: 't', workspace: 'shared' }, { toolCallId: 'call-1' }, { accessLevel: 'lineage' })
    expect(remote).toMatchObject({ started: false, code: 'private_thread' })
    expect((await orchestrator.listComputers(secret.id)).note).toMatch(/private thread/)
    const execution = mms.threads.ensureExecutionThread('private-test/workflow-agent', 'Workflow agent', undefined, { parentTaskId: secret.id }, { localOnly: true })
    expect(execution.localOnly).toBe(true)
  })

  it('keeps a thread deleted for good out of the trash list other devices read', async () => {
    const { shared } = seed()
    await mms.trashThread(shared.id)
    const record = mms.threads.lifecycleStore.get(shared.id)!
    // A record whose folder is gone (deleted for good, or mid-move) says nothing about whether it was private.
    rmSync(join(record.location, 'meta.json'))
    const remote = (await as('bridge')('threads.inventory')) as { lifecycles: Array<{ taskId: string }> }
    expect(remote.lifecycles.map((entry) => entry.taskId)).not.toContain(shared.id)
  })
  it('is not named to another device as the thread working on a pull request', () => {
    const { shared, secret } = seed()
    const link = { number: 42, url: 'https://github.com/o/r/pull/42', host: 'github.com', nameWithOwner: 'o/r', headRefName: 'h', baseRefName: 'main', headRepository: null, isCrossRepository: false, linkedAt: new Date().toISOString() }
    mms.threads.updateThreadMeta(shared.id, { pullRequest: link })
    mms.threads.updateThreadMeta(secret.id, { pullRequest: link })
    const identity = { host: 'github.com', nameWithOwner: 'o/r', number: 42 }
    const lookup = (hidden?: (thread: Thread) => boolean) =>
      (new PullRequestThreadService({ threads: mms.threads, hidden } as never) as unknown as { threadsOf(identity: unknown): Array<{ id: string }> }).threadsOf(identity).map((entry) => entry.id).sort()
    expect(lookup()).toEqual([shared.id, secret.id].sort())
    expect(lookup((thread) => isLocalOnlyThread(thread, mms.threads.listAllThreads()))).toEqual([shared.id])
  })
})
