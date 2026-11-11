/**
 * Deleting a thread while its turn runs, through the real profile and protocol: the delete stops the turn (its queue
 * goes with the thread), leaves no provider turn running, and reports success. A delete that will be refused stops
 * nothing. A window's reads that arrive while the delete runs make it wait, not fail, and an unarchive meanwhile keeps
 * the thread. Other threads' work goes on through a delete, unless it touches the deleted thread's worktree or files,
 * or (for an expiry, which takes the worktree) its repository.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AdapterHost, ProviderAdapter, ProviderCapabilities, TurnControl, TurnInput, TurnResult, TurnSink } from '../src/mms/harness/adapter'
import type { ProviderDriverKind, ProviderRef } from '../src/shared/providerInstances'
import { ERROR_INFO_CAPABILITY } from '../src/shared/errors'
import type { Thread } from '../src/shared/types'
import { testHarness } from '../src/mms/run/testkit/harness'
import { readDurableQueue } from '../src/mms/queue/durableQueue'
import { sharedThreadDbClient } from '../src/mms/data/threadDb/threadDbClient'
import type { MmsProfileServices } from '../src/mms/MmsProfileServices'
import { lifecycleHarness } from './fixtures/resource-lifecycle-harness'
import { waitFor } from './run/phase6Fixture'
import { PI_TEST_CAPABILITIES } from './support/piStub'
import { archived } from './support/archived'
import { readThreadWorkspaceRecord, ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { runInWorkScope, type WorkScope } from '../src/mms/execution/workScope'
import type { ThreadWorkspaceMetadata } from '../src/shared/workspace'
import { RelayHandler, type RelayHost } from '../src/mms/run/mcp/relay/handler'
import type { RelayCatalog } from '../src/mms/run/mcp/relay/catalog'
import type { RelayTool } from '../src/mms/run/mcp/relay/names'
import type { McpCallRequest } from '../src/mms/run/mcp/appTools/registry'
import type { AppToolTurn } from '../src/mms/run/mcp/appTools/types'
import type { BotEngineHost } from '../src/mms/bots/activation/BotEngine'
import { appTurn } from './run/appToolsFixture'

vi.setConfig({ testTimeout: 60_000 })

/** A provider whose turns stream until each is stopped, as long turns do. Each turn reports its thread as its session. */
class SlowAdapter implements ProviderAdapter {
  private readonly running = new Map<string, Set<() => void>>()
  /** Asks the person a question from a turn whose prompt says `@@ASK`; the turn's end (its abort) withdraws it. */
  ask?: (threadId: string, signal: AbortSignal) => void
  constructor(readonly driver: ProviderDriverKind, readonly capabilities: ProviderCapabilities) {}
  configured(): boolean { return true }
  live(threadId?: string): number {
    if (threadId) return this.running.get(threadId)?.size ?? 0
    return [...this.running.values()].reduce((sum, set) => sum + set.size, 0)
  }
  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, _host: AdapterHost): Promise<TurnResult> {
    const providerRef: ProviderRef = { provider: input.llmProvider, model: input.model, sessionId: input.threadId }
    sink.providerRef(providerRef)
    const set = this.running.get(input.threadId) ?? new Set()
    this.running.set(input.threadId, set)
    let stop = () => {}
    const stopped = new Promise<void>((resolve) => { stop = resolve })
    set.add(stop)
    try {
      sink.text({ phase: 'delta', content: 'working', contentIndex: 0 })
      if (input.prompt.includes('@@ASK')) this.ask?.(input.threadId, input.signal)
      await stopped
      return { text: '', aborted: true, modelName: 'Scripted', totalResponseTimeMs: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextSignature: 'scripted', nativeMessages: [], providerRef }
    } finally {
      set.delete(stop)
    }
  }
  /** Stops the turns of the thread `ref` names; without one, every turn (the end of a test). */
  async interrupt(ref?: ProviderRef): Promise<'interrupted' | 'not_active'> {
    const sets = ref?.sessionId ? [this.running.get(ref.sessionId) ?? new Set<() => void>()] : [...this.running.values()]
    const waiting = sets.flatMap((set) => [...set])
    for (const stop of waiting) stop()
    return waiting.length ? 'interrupted' : 'not_active'
  }
}

type Harness = Awaited<ReturnType<typeof lifecycleHarness>>

async function profile() {
  const f = await lifecycleHarness()
  const adapter = new SlowAdapter('pi', PI_TEST_CAPABILITIES)
  f.services.settings.set({ provider: { llmProvider: 'openai', model: 'deterministic' } })
  f.services.orchestrator.setHarness(testHarness({ profileHome: f.services.getProfileHomeDir(), adapters: [adapter] }))
  const sends: Promise<unknown>[] = []
  const pending = (threadId: string) => readDurableQueue(f.services.threads, threadId).filter((item) => item.state === 'pending').length
  adapter.ask = (threadId, signal) => {
    void f.services.questions.requestAnswers([{ id: 'layout', prompt: 'Which layout?', options: [{ id: 'table', label: 'Table' }, { id: 'list', label: 'List' }] }] as never, threadId, { signal }).catch(() => undefined)
  }
  /** Starts a long turn in `threadId`, and queues a second message behind it unless `queue` is false. */
  const run = async (threadId: string, queue = true, content = 'take your time') => {
    sends.push(f.rpc.request('orchestrator.send', { threadId, content }).catch(() => undefined))
    await waitFor(() => adapter.live(threadId) === 1, 'the turn to reach the provider')
    if (!queue) return
    sends.push(f.rpc.request('orchestrator.send', { threadId, content: 'and then this' }).catch(() => undefined))
    await waitFor(() => pending(threadId) === 1, 'the queued message')
  }
  const thread = async (name: string) => (await f.rpc.request<{ thread: Thread }>('threads.create', { name })).thread
  const close = async () => {
    // A turn that starts after one interrupt (a queued message, a held send let go) is stopped by the next.
    let settled = false
    const all = Promise.all(sends).then(() => { settled = true })
    while (!settled) {
      await adapter.interrupt()
      await Promise.race([all, new Promise((resolve) => setTimeout(resolve, 200))])
    }
    // The thread's last save sends its search index notice a second later. In tests the index runs in this process on
    // one shared engine that outlives the daemon, so it is closed here, or its file stays open and the folder cannot go.
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    await sharedThreadDbClient().call('closeEverything')
    await f.close()
  }
  return { f, adapter, run, pending, thread, close, sends }
}

const stopsFor = (services: MmsProfileServices) => vi.spyOn(services as unknown as { stopRunsForDelete: (ids: readonly string[]) => Promise<void> }, 'stopRunsForDelete')

/** Puts a file only this thread has in its scratch folder: unpublished work only a person in the app may discard. */
function soleCopy(f: Harness, threadId: string): void {
  const path = f.services.threads.getThreadDir(threadId)
  mkdirSync(join(path, 'terminal-workspace'), { recursive: true })
  writeFileSync(join(path, 'terminal-workspace', 'sole-copy.txt'), 'retained output')
  writeFileSync(join(path, 'terminal-workspace.json'), JSON.stringify({ schemaVersion: 1, kind: 'task-terminal-scratch', threadId, workspaceRelativePath: 'terminal-workspace' }))
}

/** A Git repository opened as a project of the profile, for threads with worktrees. */
function project(f: Harness): { repo: string; projectId: string } {
  const repo = join(f.root, `repo-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(repo, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'owner@example.test')
  git('config', 'user.name', 'Owner')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'first')
  return { repo, projectId: f.services.projects.openProject(repo).id }
}

/** A thread of the project with a worktree of its own. */
async function worktreeThread(f: Harness, at: { repo: string; projectId: string }, name: string): Promise<{ thread: Thread; workspace: ThreadWorkspaceMetadata }> {
  const thread = f.services.threads.createThread(name, at.projectId, at.repo, { worktreeEnabled: true, started: true })
  const workspace = await new ThreadWorkspaceManager(f.services.threads.getThreadDir(thread.id)).provision(thread.id, 'main', at.repo, undefined, undefined, undefined, { nameFrom: name })
  return { thread, workspace }
}

/** Records that `threadId` works in `workspace`'s folder (its own worktree, or another thread's): what a delete reads. */
function worksIn(f: Harness, threadId: string, workspace: ThreadWorkspaceMetadata): void {
  writeFileSync(join(f.services.threads.getThreadDir(threadId), 'workspace.json'), JSON.stringify({ ...workspace, threadId }))
}

/**
 * Holds every `method` request the protocol handler admits until `release`, inside the profile's own request barrier,
 * counted as the handler counts it (`dispatchAdmitted` works out its scope from its parameters). `scopes` are the scopes
 * those requests were given; `admitted` waits until one is in flight.
 */
function holdRequests(services: MmsProfileServices, method: string) {
  const real = services.runOwnedRequest.bind(services)
  let release = () => {}
  const hold = new Promise<void>((resolve) => { release = resolve })
  const scopes: Array<WorkScope | null> = []
  vi.spyOn(services, 'runOwnedRequest').mockImplementation(((name: string, work: () => unknown, scope?: WorkScope | null) => {
    if (name !== method) return real(name, work, scope)
    scopes.push(scope ?? null)
    return real(name, async () => { await hold; return work() }, scope)
  }) as MmsProfileServices['runOwnedRequest'])
  const admitted = () => waitFor(() => services.getOwnedActivity()[`rpc:${method}`] === 1, `the ${method} request to be in flight`)
  return { release: () => release(), scopes, admitted }
}

/** A subagent of `parentId` that works in its parent's folder (`shared`): it has no workspace record of its own. */
function sharedSubagent(f: Harness, parentId: string, sharedPath: string): Thread {
  return f.services.threads.createThread('shared subagent', undefined, undefined, {
    started: true,
    lineage: { parentThreadId: parentId, rootThreadId: parentId, relationship: 'subagent' },
    ownerThreadId: parentId,
    workspaceBinding: { policy: 'shared', sharedPath }
  })
}

/** Nothing of `threadId` was touched: listed, active, its turn running and its queue as it was. */
function untouched(p: Awaited<ReturnType<typeof profile>>, threadId: string, queued = 1): void {
  expect(p.f.services.threads.getThread(threadId)).toBeDefined()
  expect(p.f.services.threads.lifecycleStore.get(threadId)?.state ?? 'active').toBe('active')
  expect(p.adapter.live(threadId)).toBe(1)
  expect(p.pending(threadId)).toBe(queued)
}

describe('deleting a thread while its turn runs', () => {
  for (const via of ['gui', 'cli'] as const) {
    it(`stops the turn and its queue once, deletes the thread, and reports success (${via})`, async () => {
      const p = await profile()
      try {
        const target = await p.thread('long turn')
        await p.run(target.id)
        const stops = stopsFor(p.f.services)
        const client = via === 'gui' ? p.f.rpc : await p.f.connect(p.f.alice.id, [ERROR_INFO_CAPABILITY], 'cli')
        // Archived while its turn still runs: the archive's own Stop has not ended it yet.
        archived(p.f.services.threads, target.id)
        const reply = await client.request<{ threads: Thread[]; lifecycle: { state: string } }>('threads.delete', { threadId: target.id })
        expect(reply.lifecycle.state).toBe('purged')
        expect(reply.threads.some((listed) => listed.id === target.id)).toBe(false)
        expect(p.f.services.threads.getThread(target.id)).toBeUndefined()
        // Nothing of it runs any more, and the queued message never became a turn.
        expect(p.adapter.live()).toBe(0)
        expect(p.f.services.orchestrator.isTurnActive(target.id)).toBe(false)
        expect(p.f.services.runEngine.getActiveRun(target.id)).toBeNull()
        // One Stop: before the delete was admitted, not again inside it.
        expect(stops).toHaveBeenCalledTimes(1)
        // A window asking for it hears it is gone for good, so it leaves it (`watchDeletedShownThread`).
        const asked = await client.request('threads.get', { threadId: target.id }).then(() => undefined, (error: { code?: string; details?: { deleting?: boolean } }) => error)
        expect(asked?.code).toBe('thread_not_found')
        expect(asked?.details?.deleting).toBeUndefined()
        await new Promise((resolve) => setTimeout(resolve, 200))
        expect(p.adapter.live()).toBe(0)
      } finally {
        await p.close()
      }
    })
  }

  it('stops the turns of its subagent threads too, and deletes them with it', async () => {
    const p = await profile()
    try {
      const parent = await p.thread('parent')
      const child = p.f.services.threads.createThread('its subagent', undefined, undefined, { started: true, lineage: { parentThreadId: parent.id, rootThreadId: parent.id, relationship: 'subagent' } })
      await p.run(parent.id, false)
      await p.run(child.id, false)
      archived(p.f.services.threads, parent.id)
      const reply = await p.f.rpc.request<{ lifecycle: { state: string } }>('threads.delete', { threadId: parent.id })
      expect(reply.lifecycle.state).toBe('purged')
      expect(p.f.services.threads.getThread(child.id)).toBeUndefined()
      expect(p.adapter.live(child.id)).toBe(0)
      expect(p.adapter.live(parent.id)).toBe(0)
    } finally {
      await p.close()
    }
  })

  it('ends a question its running turn asked, which the Stop withdraws, instead of refusing the delete', async () => {
    const p = await profile()
    try {
      const target = await p.thread('asks a question')
      // No queued message here: a message sent to a thread that waits for an answer answers the question for it.
      await p.run(target.id, false, 'take your time @@ASK')
      await waitFor(() => p.f.services.questions.listPendingForThread(target.id).length === 1, 'the question to be pending')
      archived(p.f.services.threads, target.id)
      const reply = await p.f.rpc.request<{ lifecycle: { state: string } }>('threads.delete', { threadId: target.id })
      expect(reply.lifecycle.state).toBe('purged')
      expect(p.f.services.questions.listPendingForThread(target.id)).toEqual([])
      expect(p.adapter.live(target.id)).toBe(0)
    } finally {
      await p.close()
    }
  })

  it('waits for a window\'s read that arrives while the delete runs, instead of failing with the thread half gone', async () => {
    const p = await profile()
    let release = () => {}
    let poll: Promise<unknown> | undefined
    try {
      const target = await p.thread('long turn')
      await p.run(target.id)
      await p.f.rpc.request('threads.settle', { threadId: target.id, settled: true })
      const peer = await p.f.connect(p.f.alice.id, ['browser.viewer.v1'])
      const browser = p.f.services.platform.browser, status = browser.accessStatus()
      const hold = new Promise<void>((resolve) => { release = resolve })
      vi.spyOn(browser, 'accessStatus').mockImplementation(() => hold.then(() => status) as never)
      // The window still shows the thread: a read of it arrives once the delete is under way, and answers soon after.
      const preview = p.f.services.lifecycle.cleanup.preview.bind(p.f.services.lifecycle.cleanup)
      let reads = 0
      vi.spyOn(p.f.services.lifecycle.cleanup, 'preview').mockImplementation(async (...args) => {
        if (reads++ === 0) {
          poll = peer.request('browser.access.status', { profileId: p.f.alice.id }).catch(() => undefined)
          await vi.waitFor(() => expect(p.f.services.getOwnedActivity()['rpc:browser.access.status']).toBe(1))
          setTimeout(() => release(), 300)
        }
        return preview(...args)
      })
      const reply = await p.f.rpc.request<{ lifecycle: { state: string } }>('threads.delete', { threadId: target.id })
      expect(reply.lifecycle.state).toBe('purged')
      expect(p.f.services.threads.getThread(target.id)).toBeUndefined()
    } finally {
      release()
      await poll
      vi.restoreAllMocks()
      await p.close()
    }
  })

  it('keeps a thread unarchived while the delete waited for a busy profile', async () => {
    const p = await profile()
    let release = () => {}
    let poll: Promise<unknown> | undefined
    try {
      const target = await p.thread('changed my mind')
      archived(p.f.services.threads, target.id)
      const peer = await p.f.connect(p.f.alice.id, ['browser.viewer.v1'])
      const browser = p.f.services.platform.browser, status = browser.accessStatus()
      const hold = new Promise<void>((resolve) => { release = resolve })
      vi.spyOn(browser, 'accessStatus').mockImplementation(() => hold.then(() => status) as never)
      // The first trash is refused while a read is in flight; while the delete waits to try again, the person
      // unarchives the thread, and only then does the read answer.
      const services = p.f.services as unknown as { trashThread: MmsProfileServices['trashThread'] }
      const trash = services.trashThread.bind(p.f.services)
      let tries = 0
      vi.spyOn(services, 'trashThread').mockImplementation(async (...args) => {
        if (tries++ === 0) {
          poll = peer.request('browser.access.status', { profileId: p.f.alice.id }).catch(() => undefined)
          await vi.waitFor(() => expect(p.f.services.getOwnedActivity()['rpc:browser.access.status']).toBe(1))
          setTimeout(() => { p.f.services.threads.setThreadSettled(target.id, false); release() }, 300)
        }
        return trash(...args)
      })
      await expect(p.f.rpc.request('threads.delete', { threadId: target.id })).rejects.toThrow('Archive the thread before deleting it')
      expect(tries).toBe(1)
      expect(p.f.services.threads.getThread(target.id)?.settledAt).toBeUndefined()
      expect(p.f.services.threads.lifecycleStore.get(target.id)?.state ?? 'active').toBe('active')
    } finally {
      release()
      await poll
      vi.restoreAllMocks()
      await p.close()
    }
  })
})

describe('a delete that will be refused stops nothing', () => {
  it('a thread the deleted one launched, still running: neither turn is stopped', async () => {
    const p = await profile()
    try {
      const creator = await p.thread('creator')
      const launched = p.f.services.threads.createThread('launched by it', undefined, undefined, { started: true, createdByThreadId: creator.id })
      await p.run(creator.id)
      await p.run(launched.id, false)
      archived(p.f.services.threads, creator.id)
      await expect(p.f.rpc.request('threads.delete', { threadId: creator.id })).rejects.toThrow(/a thread it launched is still running/)
      untouched(p, creator.id)
      expect(p.adapter.live(launched.id)).toBe(1)
      expect(p.f.services.threads.getThread(launched.id)).toBeDefined()
    } finally {
      await p.close()
    }
  })

  it('from the CLI, with unpublished work: the turn keeps running and its queue stays', async () => {
    const p = await profile()
    try {
      const target = await p.thread('has scratch output')
      await p.run(target.id)
      soleCopy(p.f, target.id)
      archived(p.f.services.threads, target.id)
      const stops = stopsFor(p.f.services)
      const cli = await p.f.connect(p.f.alice.id, [ERROR_INFO_CAPABILITY], 'cli')
      await expect(cli.request('threads.delete', { threadId: target.id })).rejects.toThrow('The thread has unpublished work')
      expect(stops).not.toHaveBeenCalled()
      untouched(p, target.id)
    } finally {
      await p.close()
    }
  })
})

describe('other threads keep working through a delete', () => {
  it('deletes a running thread while another streams: the other keeps streaming, and its queue stays', async () => {
    const p = await profile()
    try {
      const target = await p.thread('to delete')
      const other = await p.thread('still working')
      await p.run(target.id)
      await p.run(other.id)
      archived(p.f.services.threads, target.id)
      const stops = stopsFor(p.f.services)
      const reply = await p.f.rpc.request<{ lifecycle: { state: string } }>('threads.delete', { threadId: target.id })
      expect(reply.lifecycle.state).toBe('purged')
      expect(p.f.services.threads.getThread(target.id)).toBeUndefined()
      expect(p.adapter.live(target.id)).toBe(0)
      // Only the deleted thread was stopped.
      expect(stops).toHaveBeenCalledTimes(1)
      expect(stops.mock.calls[0]![0]).toEqual([target.id])
      untouched(p, other.id)
      expect(p.f.services.orchestrator.isTurnActive(other.id)).toBe(true)
      // Its thread still reads and writes: a window's read answers, and another message joins the queue.
      const read = await p.f.rpc.request<{ thread: Thread }>('threads.get', { threadId: other.id })
      expect(read.thread.id).toBe(other.id)
      p.sends.push(p.f.rpc.request('orchestrator.send', { threadId: other.id, content: 'one more' }).catch(() => undefined))
      await waitFor(() => p.pending(other.id) === 2, 'the next message to be queued')
      expect(p.adapter.live(other.id)).toBe(1)
    } finally {
      await p.close()
    }
  })

  it('deletes an idle archived thread while another streams, without waiting for its open send', async () => {
    const p = await profile()
    try {
      const target = await p.thread('idle')
      const other = await p.thread('still working')
      await p.run(other.id)
      archived(p.f.services.threads, target.id)
      // The other thread's send stays open for its whole turn.
      expect(p.f.services.getOwnedActivity()['rpc:orchestrator.send']).toBeGreaterThanOrEqual(1)
      // Before, the delete's admission waited 2 s for that send and was refused (`profile_busy`).
      const reply = await p.f.rpc.request<{ lifecycle: { state: string } }>('threads.delete', { threadId: target.id })
      expect(reply.lifecycle.state).toBe('purged')
      untouched(p, other.id)
    } finally {
      await p.close()
    }
  })

  it('deletes it while another thread\'s send is still being set up (no turn yet), and that send goes on', async () => {
    const p = await profile()
    let release = () => {}
    try {
      const target = await p.thread('to delete')
      const other = await p.thread('starting')
      await p.run(target.id)
      // The other thread's send waits for its repository or a folder prompt: it is being handled, with no turn yet.
      const orchestrator = p.f.services.orchestrator as unknown as { sendOwned: (...args: unknown[]) => Promise<unknown> }
      const sendOwned = orchestrator.sendOwned.bind(p.f.services.orchestrator)
      const hold = new Promise<void>((resolve) => { release = resolve })
      vi.spyOn(orchestrator, 'sendOwned').mockImplementation(async (...args: unknown[]) => {
        if ((args[2] as { threadId?: string } | undefined)?.threadId === other.id) await hold
        return sendOwned(...args)
      })
      p.sends.push(p.f.rpc.request('orchestrator.send', { threadId: other.id, content: 'hello' }).catch(() => undefined))
      await waitFor(() => p.f.services.orchestrator.getOwnedActivity().send === 2, 'the other send to be handled')
      archived(p.f.services.threads, target.id)
      const reply = await p.f.rpc.request<{ lifecycle: { state: string } }>('threads.delete', { threadId: target.id })
      expect(reply.lifecycle.state).toBe('purged')
      expect(p.adapter.live(target.id)).toBe(0)
      release()
      await waitFor(() => p.adapter.live(other.id) === 1, 'the other thread\'s turn to start')
    } finally {
      release()
      vi.restoreAllMocks()
      await p.close()
    }
  })

  it('deletes a thread and its running subagent while another thread and its subagent stream', async () => {
    const p = await profile()
    try {
      const parent = await p.thread('to delete')
      const child = p.f.services.threads.createThread('its subagent', undefined, undefined, { started: true, lineage: { parentThreadId: parent.id, rootThreadId: parent.id, relationship: 'subagent' } })
      const other = await p.thread('still working')
      const otherChild = p.f.services.threads.createThread('the other\'s subagent', undefined, undefined, { started: true, lineage: { parentThreadId: other.id, rootThreadId: other.id, relationship: 'subagent' } })
      for (const id of [parent.id, child.id, other.id, otherChild.id]) await p.run(id, false)
      archived(p.f.services.threads, parent.id)
      const reply = await p.f.rpc.request<{ lifecycle: { state: string } }>('threads.delete', { threadId: parent.id })
      expect(reply.lifecycle.state).toBe('purged')
      expect(p.f.services.threads.getThread(child.id)).toBeUndefined()
      expect(p.adapter.live(parent.id) + p.adapter.live(child.id)).toBe(0)
      expect(p.adapter.live(other.id)).toBe(1)
      expect(p.adapter.live(otherChild.id)).toBe(1)
    } finally {
      await p.close()
    }
  })

  it('deletes a thread while another runs in a different worktree of the same repository, and keeps its worktree', async () => {
    const p = await profile()
    try {
      const at = project(p.f)
      const { thread: target, workspace } = await worktreeThread(p.f, at, 'to delete')
      const { thread: other } = await worktreeThread(p.f, at, 'other worktree')
      await p.run(target.id)
      await p.run(other.id, false)
      archived(p.f.services.threads, target.id)
      const reply = await p.f.rpc.request<{ lifecycle: { state: string } }>('threads.delete', { threadId: target.id })
      expect(reply.lifecycle.state).toBe('purged')
      expect(p.adapter.live(other.id)).toBe(1)
      // A person's delete keeps the worktree and its branch (#812/#817).
      expect(existsSync(workspace.worktreePath)).toBe(true)
      expect(execFileSync('git', ['rev-parse', '--verify', `refs/heads/${workspace.branch}`], { cwd: at.repo, encoding: 'utf8' }).trim()).toMatch(/^[0-9a-f]{40}$/)
    } finally {
      await p.close()
    }
  })

  it('an expiry deletes a thread for good while other threads run elsewhere', async () => {
    const p = await profile()
    try {
      const target = p.f.services.threads.createThread('expiring', undefined, undefined, { started: true, expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
      const other = await p.thread('still working')
      const at = project(p.f)
      const { thread: elsewhere } = await worktreeThread(p.f, at, 'another repository')
      await p.run(other.id)
      await p.run(elsewhere.id, false)
      p.f.services.threads.updateThreadMeta(target.id, { expiresAt: new Date(Date.now() - 1_000).toISOString() })
      // The expiry's own delete (`ThreadExpiryService.deleteForGood`).
      await (p.f.services as unknown as { deleteExpiredThread: (id: string) => Promise<void> }).deleteExpiredThread(target.id)
      expect(p.f.services.threads.getThread(target.id)).toBeUndefined()
      expect(p.f.services.threads.lifecycleStore.get(target.id)?.state).toBe('purged')
      untouched(p, other.id)
      expect(p.adapter.live(elsewhere.id)).toBe(1)
    } finally {
      await p.close()
    }
  })

  it('an MCP tool call another thread\'s provider turn makes through the relay goes on, and the delete does not wait for it', async () => {
    const p = await profile()
    let release = () => {}
    try {
      const target = await p.thread('to delete')
      const other = await p.thread('calls a tool')
      await p.run(target.id)
      await p.run(other.id, false)
      archived(p.f.services.threads, target.id)
      // The relay's call runs on the profile's MCP manager, as `McpManager.callTool` runs it (`runTimed`), and holds
      // until released: a long tool call of the other thread's turn.
      const manager = p.f.services.mcpManager as unknown as { runTimed: (label: string, timeoutMs: number, message: string, signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<unknown>) => Promise<unknown> }
      const hold = new Promise<void>((resolve) => { release = resolve })
      const tool: RelayTool = { name: 'echo__say', description: 'Says it', inputSchema: { type: 'object' }, installationId: 'inst-echo', serverName: 'echo', toolName: 'say', providerName: 'mcp__echo__say__abcd1234', configRevision: 'rev1' }
      const turn = { ...appTurn({ threadId: other.id, runId: 'run-other' }), turnToken: 'tt' } as AppToolTurn
      const relay = new RelayHandler({
        catalog: { listing: () => [tool], resolve: () => tool } as unknown as RelayCatalog,
        manager: {
          isToolCallAllowed: async () => ({ allowed: true }),
          callTool: ((_name: string, _args: unknown, _projectPath: unknown, signal?: AbortSignal) =>
            manager.runTimed('mcp-call', 60_000, 'Timed out calling MCP tool say', signal, async () => { await hold; return { content: [{ type: 'text', text: 'said' }], isError: false } })) as never
        } as RelayHost['manager'],
        registry: { admit: async (rawArgs: Record<string, unknown>) => ({ threadId: other.id, active: 'run-other', turn, args: rawArgs, caller: { threadId: other.id, runId: 'run-other', provider: 'codex', modeCeiling: 'default', accessLevel: 'lineage' as const }, boundToken: 'tt' }) } as never,
        projectPathFor: () => undefined
      })
      const request: McpCallRequest = {
        credential: { threadId: other.id, runId: 'run-other', provider: 'codex', modeCeiling: 'default', accessLevel: 'lineage', binding: 'per_call', relay: { approvals: 'runtime' }, current: () => true } as never,
        toolCallId: 'mcp:c1',
        signal: new AbortController().signal
      }
      // The relay's HTTP server serves it outside any turn (`MousseMcpServer.start` runs as the profile's work).
      const call = runInWorkScope(null, () => relay.call(tool.name, { text: 'hi' }, request))
      await waitFor(() => p.f.services.mcpManager.getActiveWork().some((entry) => entry.label === 'mcp-call'), 'the relayed call to be in flight')
      // Counted under the caller's thread, not as the profile's.
      expect(p.f.services.mcpManager.getActiveWork().find((entry) => entry.label === 'mcp-call')?.scope).toEqual({ threadIds: [other.id] })
      const reply = await p.f.rpc.request<{ lifecycle: { state: string } }>('threads.delete', { threadId: target.id })
      expect(reply.lifecycle.state).toBe('purged')
      expect(p.adapter.live(target.id)).toBe(0)
      release()
      expect(await call).toEqual({ text: 'said' })
      expect(p.adapter.live(other.id)).toBe(1)
    } finally {
      release()
      await p.close()
    }
  })

  it('a deleted bot\'s thread is deleted for good while another thread streams', async () => {
    const p = await profile()
    try {
      const other = await p.thread('still working')
      await p.run(other.id)
      const home = p.f.services.threads.ensureExecutionThread('bot:helper', 'Helper', undefined, undefined, { botOwned: true })
      // `BotEngine` trashes a deleted bot's threads through this seam (`MmsProfileServices`' `trashThread`).
      const host = (p.f.services.personalBots as unknown as { host: BotEngineHost }).host
      await host.trashThread!(home.id)
      expect(p.f.services.threads.lifecycleStore.get(home.id)?.state).toBe('purged')
      untouched(p, other.id)
    } finally {
      await p.close()
    }
  })

  it('a request that names only another thread is not waited for', async () => {
    const p = await profile()
    let hold: ReturnType<typeof holdRequests> | undefined
    let read: Promise<unknown> | undefined
    try {
      const target = await p.thread('to delete')
      const other = await p.thread('read by a window')
      await p.run(target.id)
      archived(p.f.services.threads, target.id)
      hold = holdRequests(p.f.services, 'threads.get')
      read = p.f.rpc.request('threads.get', { threadId: other.id })
      await hold.admitted()
      expect(hold.scopes).toEqual([{ threadIds: [other.id] }])
      const reply = await p.f.rpc.request<{ lifecycle: { state: string } }>('threads.delete', { threadId: target.id })
      expect(reply.lifecycle.state).toBe('purged')
      // Still in flight through the whole delete.
      expect(p.f.services.getOwnedActivity()['rpc:threads.get']).toBe(1)
      hold.release()
      expect((await read as { thread: Thread }).thread.id).toBe(other.id)
    } finally {
      hold?.release()
      await read?.catch(() => undefined)
      vi.restoreAllMocks()
      await p.close()
    }
  })
})

describe('a delete is refused, stopping nothing, while other work touches what it deletes', () => {
  it('another thread works in its worktree', async () => {
    const p = await profile()
    try {
      const at = project(p.f)
      const { thread: target, workspace } = await worktreeThread(p.f, at, 'to delete')
      const other = await p.thread('in its worktree')
      await p.run(target.id)
      await p.run(other.id, false)
      worksIn(p.f, other.id, workspace)
      archived(p.f.services.threads, target.id)
      const stops = stopsFor(p.f.services)
      await expect(p.f.rpc.request('threads.delete', { threadId: target.id })).rejects.toThrow(/another thread is working in its worktree/)
      expect(stops).not.toHaveBeenCalled()
      untouched(p, target.id)
      expect(p.adapter.live(other.id)).toBe(1)
    } finally {
      await p.close()
    }
  })

  it('an expiry, which takes the worktree, while another thread works in the same repository', async () => {
    const p = await profile()
    try {
      const at = project(p.f)
      const { thread: target, workspace } = await worktreeThread(p.f, at, 'expiring')
      const { thread: other } = await worktreeThread(p.f, at, 'same repository')
      await p.run(other.id, false)
      p.f.services.threads.updateThreadMeta(target.id, { expiresAt: new Date(Date.now() - 1_000).toISOString() })
      await expect(p.f.services.deleteThreadForGood(target.id, { human: false, discard: false, expiry: true }))
        .rejects.toThrow(/another thread is working in the same repository, and this delete removes the thread's worktree and Git refs/)
      expect(p.f.services.threads.getThread(target.id)).toBeDefined()
      expect(p.f.services.threads.lifecycleStore.get(target.id)?.state ?? 'active').toBe('active')
      expect(existsSync(workspace.worktreePath)).toBe(true)
      expect(p.adapter.live(other.id)).toBe(1)
    } finally {
      await p.close()
    }
  })

  // Each request goes through the protocol handler, which works out its scope from its parameters.
  for (const [kind, method, params] of [
    // Named by folder or project, the request may touch the thread's files: it is not counted under a thread.
    ['a folder', 'files.read', (folder: string, other: string) => ({ threadId: other, path: join(folder, 'notes.md') })],
    ['a project', 'git.status', (_folder: string, _other: string, projectId: string) => ({ projectId })],
    // A project terminal's requests before it has a thread, a chat's task id, another computer's thread: their reach is not known.
    ['`__unbound__`', 'threads.get', () => ({ threadId: '__unbound__' })],
    ['an id that is not a thread here', 'threads.get', () => ({ threadId: 'rpc_9f2c41d0' })],
    ['a thread here and one of another computer', 'threads.get', (_folder: string, other: string) => ({ threadId: other, target: { parentThreadId: 'thread-of-another-computer' } })]
  ] as const) {
    it(`a request that names ${kind} is in flight`, async () => {
      const p = await profile()
      let hold: ReturnType<typeof holdRequests> | undefined
      let request: Promise<unknown> | undefined
      try {
        const at = project(p.f)
        const { thread: target, workspace } = await worktreeThread(p.f, at, 'to delete')
        const other = await p.thread('reads files')
        await p.run(target.id)
        archived(p.f.services.threads, target.id)
        hold = holdRequests(p.f.services, method)
        request = p.f.rpc.request(method, params(workspace.worktreePath, other.id, at.projectId)).catch(() => undefined)
        await hold.admitted()
        // Counted as the profile's, never under the one thread it does name.
        expect(hold.scopes).toEqual([null])
        const stops = stopsFor(p.f.services)
        await expect(p.f.rpc.request('threads.delete', { threadId: target.id })).rejects.toThrow(new RegExp(`profile requests are still active \\(rpc:${method.replace('.', '\\.')}=1\\)`))
        expect(stops).not.toHaveBeenCalled()
        untouched(p, target.id)
      } finally {
        hold?.release()
        await request
        vi.restoreAllMocks()
        await p.close()
      }
    })
  }

  it('a person\'s delete left in the trash, tried again while a shared subagent works in its worktree', async () => {
    const p = await profile()
    try {
      const at = project(p.f)
      const { thread: target, workspace } = await worktreeThread(p.f, at, 'to delete')
      // Another thread was given the deleted thread's worktree, and its shared subagent works there.
      const parent = await p.thread('in its worktree')
      worksIn(p.f, parent.id, workspace)
      const child = sharedSubagent(p.f, parent.id, workspace.worktreePath)
      // Trashed by an earlier delete that stopped there (a crash, a refusal): no longer listed.
      archived(p.f.services.threads, target.id)
      await p.f.services.trashThread(target.id, undefined, undefined, true)
      expect(p.f.services.threads.getThread(target.id)).toBeUndefined()
      await p.run(child.id, false)
      expect(readThreadWorkspaceRecord(p.f.services.threads.getThreadDir(child.id))).toBeUndefined()
      await expect(p.f.rpc.request('threads.delete', { threadId: target.id })).rejects.toThrow(/another thread is working in its worktree/)
      expect(p.f.services.threads.lifecycleStore.get(target.id)?.state).toBe('trashed')
      expect(existsSync(workspace.worktreePath)).toBe(true)
      expect(p.adapter.live(child.id)).toBe(1)
    } finally {
      await p.close()
    }
  })

  it('an expiry left in the trash, tried again or purged while a shared subagent works in the same project', async () => {
    const p = await profile()
    try {
      const at = project(p.f)
      const { thread: target, workspace } = await worktreeThread(p.f, at, 'expiring')
      // Another thread of the project, idle, and its shared subagent, which works in its worktree. The subagent's
      // project and repository are its parent's.
      const { thread: parent, workspace: theirs } = await worktreeThread(p.f, at, 'same project')
      const child = sharedSubagent(p.f, parent.id, theirs.worktreePath)
      p.f.services.threads.updateThreadMeta(target.id, { expiresAt: new Date(Date.now() - 1_000).toISOString() })
      // An earlier delete trashed it while nothing ran, and stopped there; the thread has expired since, so the expiry
      // finishes the delete, taking the worktree.
      archived(p.f.services.threads, target.id)
      await p.f.services.trashThread(target.id, undefined, undefined, true)
      expect(p.f.services.threads.getThread(target.id)).toBeUndefined()
      await p.run(child.id, false)
      expect(readThreadWorkspaceRecord(p.f.services.threads.getThreadDir(child.id))).toBeUndefined()
      const refusal = /another thread is working in the same repository, and this delete removes the thread's worktree and Git refs/
      // The purge's own idle check, with the expiry's authority: it stays in the trash.
      await expect(p.f.services.lifecycle.cleanup.purge({ taskId: target.id, operationId: 'expiry-purge', authorization: 'expiry' })).rejects.toThrow(refusal)
      expect(p.f.services.threads.lifecycleStore.get(target.id)?.state).toBe('trashed')
      // The expiry service's next try (`deleteForGood`): refused, it puts the thread back in Archived, as any refused
      // delete of a thread an earlier one left in the trash does.
      await expect((p.f.services as unknown as { deleteExpiredThread: (id: string) => Promise<void> }).deleteExpiredThread(target.id)).rejects.toThrow(refusal)
      expect(p.f.services.threads.lifecycleStore.get(target.id)?.state).not.toMatch(/purge/)
      expect(p.f.services.threads.getThread(target.id)?.settledAt).toBeTruthy()
      expect(existsSync(workspace.worktreePath)).toBe(true)
      expect(p.adapter.live(child.id)).toBe(1)
    } finally {
      await p.close()
    }
  })

  it('profile-wide work (an automation run) is in flight', async () => {
    const p = await profile()
    let release = () => {}
    try {
      const target = await p.thread('to delete')
      await p.run(target.id)
      archived(p.f.services.threads, target.id)
      const hold = new Promise<void>((resolve) => { release = resolve })
      const scheduled = p.f.services.scheduled as unknown as { lifecycle: { run: (label: string, work: () => Promise<void>, scope: null) => Promise<void> } }
      const run = scheduled.lifecycle.run('scheduled-run', () => hold, null)
      const stops = stopsFor(p.f.services)
      await expect(p.f.rpc.request('threads.delete', { threadId: target.id })).rejects.toThrow(/profile execution is still active/)
      expect(stops).not.toHaveBeenCalled()
      untouched(p, target.id)
      release()
      await run
    } finally {
      release()
      await p.close()
    }
  })
})
