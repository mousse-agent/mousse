/**
 * Side chats: a fork of a thread made from its side panel (`thread.fork` with `sideChat`). It is a child of the
 * thread that no list shows, works in the thread's checkout, never writes to the thread, ends when the thread is
 * archived, goes when it is deleted, and survives a restart.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeSharedThreadDbClient } from '../../src/mms/data/threadDb/threadDbClient'
import { MousseMainService } from '../../src/mms/MousseMainService'
import { LocalMmsClient } from '../../src/mms/protocol/client'
import { MmsProtocolServer } from '../../src/mms/protocol/server'
import { visibleThreads } from '../../src/shared/threadLineage'
import { ThreadWorkspaceManager } from '../../src/mms/workspace/ThreadWorkspaceManager'
import { gitFoundationFixture } from '../fixtures/gitFoundation'
import { PI, phase6Daemon, piAdapter, type Phase6Daemon } from './phase6Fixture'

describe('side chats over the protocol', () => {
  let home: string | undefined
  let mms: MousseMainService | undefined
  let server: MmsProtocolServer | undefined
  let client: LocalMmsClient | undefined

  const start = async () => {
    mms = await MousseMainService.create({ homeDir: home!, headless: true, ownerKind: 'test' })
    await mms.start()
    const ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    const endpoint = await server.start()
    client = new LocalMmsClient({ homeDir: home!, endpoint, ownerToken, clientType: 'gui' })
    await client.connect()
    return { mms, client }
  }
  const stop = async () => {
    await client?.close()
    await server?.stop()
    await mms?.stop()
    client = undefined
    server = undefined
    mms = undefined
  }
  afterEach(async () => {
    await stop()
    // The search index's worker keeps the profile's index open until the process's database client closes.
    await closeSharedThreadDbClient()
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  /** A thread with one finished run, so it can be forked. */
  const threadWithRun = async (service: MousseMainService, name: string) => {
    const thread = service.threads.createThread(name)
    const sent = await service.runEngine.dispatch({ kind: 'send', threadId: thread.id, clientRequestId: `seed:${name}`, source: 'gui' })
    if (sent.status !== 'accepted') throw new Error('send rejected')
    service.runEngine.markStarting(sent.runId)
    service.runEngine.markRunning(sent.runId)
    service.runEngine.markTerminal(sent.runId, 'completed')
    return thread
  }
  const sideChatOf = async (rpc: LocalMmsClient, sourceThreadId: string, key: string) =>
    (await rpc.request<{ threadId: string }>('thread.fork', { sourceThreadId, atRunOrdinal: 'latest_stable', seedFrom: 'current_head', sideChat: true, clientRequestId: key })).threadId

  it('is a child of its thread that no list shows, has no side chats or merge-back of its own, and survives a restart', async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-side-chat-'))
    const { mms: service, client: rpc } = await start()
    const parent = await threadWithRun(service, 'Parent')
    const sideId = await sideChatOf(rpc, parent.id, 'side-1')

    expect(service.threads.getThread(sideId)).toMatchObject({
      name: 'New chat',
      lineage: { parentThreadId: parent.id, rootThreadId: parent.id, relationship: 'side' }
    })
    expect(service.threads.getThread(sideId)?.startedAt).toBeTruthy()
    expect(service.runEngine.delegations.getLineage(sideId)).toMatchObject({ parentThreadId: parent.id, relationship: 'fork' })
    const listed = visibleThreads(service.threads.listAllThreads()).map((thread) => thread.id)
    expect(listed).toContain(parent.id)
    expect(listed).not.toContain(sideId)

    await expect(sideChatOf(rpc, sideId, 'side-of-side')).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(rpc.request('thread.mergeBack', { forkThreadId: sideId })).rejects.toMatchObject({ code: 'invalid_params' })

    // Boot repair discards a child the run store does not know as a subagent; a side chat is kept.
    await stop()
    const restarted = await start()
    expect(restarted.mms.threads.getThread(sideId)?.lineage?.relationship).toBe('side')
  }, 60_000)

  it('ends with its thread\'s archive, stays ended when the thread comes back, and goes with its delete', async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-side-chat-'))
    const { mms: service, client: rpc } = await start()
    const parent = await threadWithRun(service, 'Parent')
    const other = await threadWithRun(service, 'Other')
    const sideId = await sideChatOf(rpc, parent.id, 'side-a')
    const othersSide = await sideChatOf(rpc, other.id, 'side-b')

    await rpc.request('threads.settle', { threadId: parent.id, settled: true })
    expect(service.threads.getThread(sideId)?.settledAt).toBeTruthy()
    expect(service.threads.getThread(othersSide)?.settledAt).toBeUndefined()
    await rpc.request('threads.settle', { threadId: parent.id, settled: false })
    expect(service.threads.getThread(sideId)?.settledAt).toBeTruthy()

    await rpc.request('threads.settle', { threadId: parent.id, settled: true })
    await rpc.request('threads.delete', { threadId: parent.id })
    expect(service.threads.getThread(parent.id)).toBeUndefined()
    expect(service.threads.getThread(sideId)).toBeUndefined()
    expect(service.threads.getThread(othersSide)).toBeDefined()
  }, 60_000)
})

describe('a side chat\'s turn', () => {
  let daemon: Phase6Daemon | undefined
  let foundation: ReturnType<typeof gitFoundationFixture> | undefined
  afterEach(async () => {
    await daemon?.stop().catch(() => undefined)
    daemon = undefined
    foundation?.dispose()
    foundation = undefined
  })

  it('runs in its thread\'s checkout with the thread\'s history, and writes nothing to the thread', async () => {
    foundation = gitFoundationFixture()
    const f = foundation
    const pi = piAdapter((input) => {
      if (input.cwd && input.prompt.startsWith('Write ')) writeFileSync(join(input.cwd, 'value.txt'), `${input.prompt.slice(6)}\n`)
      return `done: ${String(input.messages.at(-1)!.content)}`
    })
    const d = (daemon = phase6Daemon(f.home, [pi]))
    const project = d.projects.openProject(f.repo)
    const parent = d.store.createThread('Parent', project.id)
    d.orch.setThreadModelOverride(parent.id, PI)
    await d.orch.send({ content: 'Write one', mode: 'agent' }, false, { threadId: parent.id, clientRequestId: 'p-1' })
    const parentWorktree = new ThreadWorkspaceManager(d.store.getThreadDir(parent.id)).load()!.worktreePath
    const parentMessages = d.orch.getMessages(parent.id).map((message) => message.id)

    const side = await d.engine.forkThread({ sourceThreadId: parent.id, atRunOrdinal: 'latest_stable', seedFrom: 'current_head', sideChat: true, clientRequestId: 'side' })
    const response = await d.orch.send({ content: 'What is in value.txt?', mode: 'agent' }, false, { threadId: side.threadId, clientRequestId: 's-1' })
    expect(response.message).toBe('done: What is in value.txt?')

    const turn = pi.turns.at(-1)!
    expect(turn.threadId).toBe(side.threadId)
    expect(turn.cwd?.startsWith(parentWorktree)).toBe(true)
    expect(turn.prompt).toContain('[user] Write one')
    expect(readFileSync(join(parentWorktree, 'value.txt'), 'utf8')).toBe('one\n')
    // No worktree of its own.
    expect(existsSync(join(d.store.getThreadDir(side.threadId), 'workspace.json'))).toBe(false)
    expect(new ThreadWorkspaceManager(d.store.getThreadDir(side.threadId)).load()).toBeUndefined()
    // The thread's transcript is as it was.
    expect(d.orch.getMessages(parent.id).map((message) => message.id)).toEqual(parentMessages)
    // Named from its first message, as a new thread is.
    expect(d.store.getThread(side.threadId)?.name).not.toBe('New chat')
  }, 60_000)
})
