/**
 * The settle notice end to end (docs/run-engine/SPEC.md §15.1, "Told when it settles"): a real `OrchestratorService`,
 * Run Engine, effect worker and Mousse MCP server, with scripted provider runtimes whose turns call the tools over HTTP.
 * What the sending agent sees is observed where it sees it: the turns its runtime is given, its transcript and its queue.
 *
 * Inputs covered: the target idle or busy; the work ends, waits on a person first, or is re-queued by a person's edit;
 * the sender idle, busy, stopped by a person after it subscribed, kept in Plan, or a subagent; several watched threads
 * settling together; a chain of sends answered by notices; a daemon restart.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/harness/drivers/claudeCode/adapter'
import type { AdapterHost, ProviderAdapter, ProviderCapabilities, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/harness/adapter'
import { TURN_TOKEN_KEY } from '../../src/mms/run/mcp/appTools'
import { NOTIFY_NEXT } from '../../src/mms/run/mcp/appTools/thread'
import { usageLimitError } from '../../src/mms/orchestrator/providerErrors'
import { McpCredentials } from '../../src/mms/run/mcp/McpCredentials'
import { MousseMcpServer } from '../../src/mms/run/mcp/MousseMcpServer'
import type { ProviderDriverKind } from '../../src/shared/providerInstances'
import { SETTLE_NOTICE_RESULT_CHARS } from '../../src/shared/settleNotice'
import type { ChatMessage, QueuedMessage } from '../../src/shared/types'
import { phase6Daemon, waitFor, type Phase6Daemon } from './phase6Fixture'
import { spendChain } from './chainFixture'

vi.setConfig({ testTimeout: 60_000 })

type Mcp = { url: string; token: string; turnToken?: string }
type Script = (input: TurnInput, mcp: Mcp | undefined, d: Phase6Daemon, adapter: VendorAdapter) => Promise<string>

/** A provider stand-in whose script gets the turn's MCP bridge, and whose turns can be held and interrupted. */
class VendorAdapter implements ProviderAdapter {
  readonly turns: TurnInput[] = []
  readonly abortedRuns = new Set<string>()
  private readonly interruptListeners = new Set<() => void>()
  constructor(readonly driver: ProviderDriverKind, readonly capabilities: ProviderCapabilities, private readonly script: (input: TurnInput, host: AdapterHost, adapter: VendorAdapter) => Promise<string>) {}

  configured(): boolean {
    return true
  }

  /** Holds the turn until `release` settles, the runtime is interrupted (a Stop) or the turn is aborted (a shutdown). */
  async hold(input: TurnInput, release: Promise<void>): Promise<void> {
    const signal = input.signal
    await Promise.race([
      release,
      new Promise<void>((resolve) => {
        const ended = (): void => {
          this.abortedRuns.add(input.runId)
          resolve()
        }
        if (signal?.aborted) ended()
        else signal?.addEventListener('abort', ended, { once: true })
      }),
      new Promise<void>((resolve) => {
        const listener = (): void => {
          this.abortedRuns.add(input.runId)
          this.interruptListeners.delete(listener)
          resolve()
        }
        this.interruptListeners.add(listener)
      })
    ])
  }

  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.turns.push(input)
    const providerRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
    sink.providerRef(providerRef)
    const text = await this.script(input, host, this)
    const aborted = this.abortedRuns.has(input.runId)
    if (!aborted) sink.text({ phase: 'complete', content: text, contentIndex: 0 })
    if (!aborted) host.context.nativeHistoryAfterTurn(text)
    return {
      text: aborted ? '' : text,
      aborted,
      modelName: 'Scripted',
      totalResponseTimeMs: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      contextSignature: 'scripted',
      nativeMessages: [],
      providerRef
    }
  }

  async interrupt(): Promise<'interrupted' | 'not_active'> {
    for (const listener of [...this.interruptListeners]) listener()
    return 'interrupted'
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function rpc(mcp: Mcp, method: string, params: Record<string, unknown>) {
  const response = await fetch(mcp.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${mcp.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  })
  return await response.json() as {
    result?: { content?: Array<{ text: string }>; isError?: boolean }
    error?: { code: number; message: string; data?: { reason: string; [key: string]: unknown } }
  }
}

const call = (mcp: Mcp, name: string, args: Record<string, unknown> = {}) =>
  rpc(mcp, 'tools/call', { name, arguments: mcp.turnToken ? { ...args, [TURN_TOKEN_KEY]: mcp.turnToken } : args })
const parse = (response: Awaited<ReturnType<typeof rpc>>): Record<string, unknown> => {
  if (response.error) throw new Error(`rpc error ${response.error.code}: ${response.error.message}`)
  if (response.result?.isError) throw new Error(response.result.content?.[0]?.text ?? 'tool error')
  return JSON.parse(response.result!.content![0].text)
}

const NOTICE = '<mousse_notice kind="thread_watch"'
const GO = 'Go'
const settle = () => new Promise((resolve) => setTimeout(resolve, 300))

describe('the settle notice: an agent that sends with notify is told when the work settles (SPEC §15.1)', () => {
  let home: string | undefined
  let previousHome: string | undefined
  const stops: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop().catch(() => undefined)
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  const MODEL = { llmProvider: 'claude-subscription', model: 'vendor-model' }

  /** A daemon over `home` (a fresh one unless given) whose threads run on one scripted runtime that talks to the real MCP server. */
  const daemon = (script: Script, at?: string, pid = 1) => {
    if (!at) {
      home = mkdtempSync(join(tmpdir(), 'mousse-settle-'))
      previousHome = process.env.MOUSSE_HOME
      process.env.MOUSSE_HOME = home
      mkdirSync(join(home, 'project'))
    }
    let created: Phase6Daemon | undefined
    const adapter: VendorAdapter = new VendorAdapter('claude', CLAUDE_SUBSCRIPTION_CAPABILITIES, async (input, host, self) => {
      const bridge = host.bridge
      return script(input, bridge?.mcp ? { ...bridge.mcp, turnToken: bridge.turnToken } : undefined, created!, self)
    })
    const d = phase6Daemon(home!, [adapter], { pid, runs: { resumeAfterUsageLimit: true } })
    created = d
    const server = new MousseMcpServer({ credentials: new McpCredentials(d.engine.store), registry: d.orch.mcpToolRegistry() })
    let ended = false
    const end = async (crash: boolean) => {
      if (ended) return
      ended = true
      d.orch.setMcpAttachment(null)
      await server.stop()
      await (crash ? d.crash() : d.stop())
    }
    stops.push(() => end(false))
    const project = d.projects.openProject(join(home!, 'project'))
    return {
      d, adapter, project,
      thread: (name: string) => {
        const made = d.store.createThread(name, project.id)
        d.orch.setThreadModelOverride(made.id, MODEL)
        return made
      },
      attach: async () => { await server.start(); d.orch.setMcpAttachment(server) },
      crash: () => end(true),
      turnsOf: (threadId: string) => adapter.turns.filter((turn) => turn.threadId === threadId),
      noticeTurns: (threadId: string) => adapter.turns.filter((turn) => turn.threadId === threadId && turn.prompt.startsWith(NOTICE)),
      messages: (threadId: string): ChatMessage[] => d.orch.getOrCreateSession(threadId).messages,
      queue: (threadId: string): QueuedMessage[] => d.orch.queueSnapshot(threadId).items,
      watch: (watchId: string) => d.engine.store.db.statement('SELECT * FROM thread_watches WHERE watch_id = ?').get(watchId) as Record<string, unknown> | undefined
    }
  }

  const world = (script: Script) => {
    const w = daemon(script)
    return { ...w, parent: w.thread('Parent'), other: w.thread('Other work') }
  }

  it('tells the sender once when the work ends, in a turn of its own, with the reply cut to 2,000 characters and the thread named by link', async () => {
    const reply = `${'a'.repeat(SETTLE_NOTICE_RESULT_CHARS)}TAIL`
    const seen: Record<string, unknown> = {}
    const w = world(async (input, mcp) => {
      if (input.threadId === w.other.id) return reply
      if (input.prompt === GO) {
        seen.sent = parse(await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'Do the work', notify: true, clientRequestId: 'send-1' }))
        // A retry of the same send keeps the one watch.
        seen.retry = parse(await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'Do the work', notify: true, clientRequestId: 'send-1' }))
      }
      return 'ok'
    })
    await w.attach()
    await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
    const sent = seen.sent as { runId: string; notify: { watchId: string; next: string } }
    expect(sent.notify.next).toBe(NOTIFY_NEXT)
    expect((seen.retry as typeof sent).notify.watchId).toBe(sent.notify.watchId)

    await waitFor(() => w.noticeTurns(w.parent.id).length === 1, 'the notice turn')
    await settle()
    // Told once: one turn, for one end.
    expect(w.noticeTurns(w.parent.id)).toHaveLength(1)
    const prompt = w.noticeTurns(w.parent.id)[0]!.prompt
    // One Mousse block about the run, with the target's reply quoted inside it.
    expect(prompt.startsWith(`<mousse_notice kind="thread_watch" ref="${sent.runId}">\n`)).toBe(true)
    expect(prompt.endsWith('\n</mousse_notice>')).toBe(true)
    expect(prompt).toContain(`mousse://thread/${w.other.id}`)
    expect(prompt).toContain('finished')
    expect(prompt).toContain(`<quoted from="its reply">\n${'a'.repeat(SETTLE_NOTICE_RESULT_CHARS)}\n</quoted>`)
    expect(prompt).not.toContain('TAIL')
    expect(prompt).toContain('thread_read')
    // The transcript shows it as Mousse's notice, not as the person's message or an agent's.
    const message = w.messages(w.parent.id).find((entry) => entry.settleNotice)!
    expect(message.settleNotice).toEqual([expect.objectContaining({ threadId: w.other.id, event: 'ended', status: 'completed', runId: sent.runId, cut: true })])
    expect(message.origin).toBeUndefined()
    const noticeRun = w.d.engine.listRuns(w.parent.id)[0]!
    expect(noticeRun.source).toBe('thread-notice')
    expect(w.watch(sent.notify.watchId)).toMatchObject({ state: 'ended', end_status: 'completed', end_notice: 'sent', needs_input: null })
  })

  it('tells the sender the first time the work waits on a person, and still tells it when the work ends', async () => {
    const seen: Record<string, unknown> = {}
    const w = world(async (input, mcp, d) => {
      if (input.threadId === w.other.id) {
        // Two questions in the run: only the first is told.
        for (const id of ['q1', 'q2']) await d.questions.requestAnswers([{ id, prompt: 'Which?', options: [{ id: 'a', label: 'A' }] }], w.other.id, {})
        return 'answered and done'
      }
      if (input.prompt === GO) seen.sent = parse(await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'Ask first', notify: true }))
      return 'ok'
    })
    await w.attach()
    await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
    await waitFor(() => w.noticeTurns(w.parent.id).length === 1, 'the needs-input notice')
    expect(w.noticeTurns(w.parent.id)[0]!.prompt).toContain('waiting for a person')
    for (let answered = 0; answered < 2; answered++) {
      await waitFor(() => w.d.questions.listPendingForThread(w.other.id).length === 1, 'a question')
      w.d.questions.submitAnswers(w.d.questions.listPendingForThread(w.other.id)[0]!.requestId, { [answered ? 'q2' : 'q1']: 'a' })
    }
    await waitFor(() => w.noticeTurns(w.parent.id).length === 2, 'the end notice')
    await settle()
    expect(w.noticeTurns(w.parent.id)).toHaveLength(2)
    expect(w.noticeTurns(w.parent.id)[1]!.prompt).toContain('answered and done')
    expect(w.messages(w.parent.id).flatMap((message) => message.settleNotice ?? []).map((item) => item.event)).toEqual(['needs_input', 'ended'])
  })

  it('follows a queued message a person edited into the run it gets when it drains', async () => {
    const release = deferred()
    const seen: Record<string, unknown> = {}
    const w = world(async (input, mcp, _d, adapter) => {
      if (input.threadId === w.other.id) {
        if (input.prompt === 'hold') await adapter.hold(input, release.promise)
        return `reply to ${input.prompt.slice(0, 20)}`
      }
      if (input.prompt === GO) seen.sent = parse(await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'queued work', notify: true }))
      return 'ok'
    })
    await w.attach()
    await w.d.orch.send('hold', false, { threadId: w.other.id, clientRequestId: 'hold', awaitMode: 'ack' })
    await waitFor(() => w.turnsOf(w.other.id).length === 1, 'the busy turn')
    await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
    const sent = seen.sent as { runId: string; queued: boolean }
    expect(sent.queued).toBe(true)
    const item = w.queue(w.other.id).find((entry) => entry.runId === sent.runId)!
    // The person rewrites it: its run is cancelled, and it gets a fresh one when it drains.
    w.d.orch.editQueuedItem(w.other.id, item.id, { content: 'edited work' })
    await waitFor(() => w.d.engine.getRun(sent.runId)?.status === 'cancelled', 'the cancelled run')
    await settle()
    expect(w.noticeTurns(w.parent.id)).toHaveLength(0)
    release.resolve()
    await waitFor(() => w.noticeTurns(w.parent.id).length === 1, 'the notice')
    const notice = w.messages(w.parent.id).find((entry) => entry.settleNotice)!.settleNotice![0]!
    expect(notice).toMatchObject({ event: 'ended', status: 'completed' })
    expect(notice.runId).not.toBe(sent.runId)
    expect(w.d.engine.getRun(notice.runId!)?.clientRequestId).toBe(`queue:${item.id}`)
    expect(w.noticeTurns(w.parent.id)[0]!.prompt).toContain('reply to edited work')
  })

  it('waits behind the sender\'s running turn, and notices that meet there run as one turn', async () => {
    const parentGate = deferred()
    const seen: Record<string, unknown> = {}
    const w = world(async (input, mcp, d, adapter) => {
      if (input.threadId === w.parent.id && input.prompt === GO) {
        for (const id of [w.other.id, seen.third as string]) parse(await call(mcp!, 'thread_send', { threadId: id, content: 'work', notify: true }))
        // The sender keeps working while both finish.
        await waitFor(() => d.engine.listRuns(w.other.id)[0]?.status === 'completed' && d.engine.listRuns(seen.third as string)[0]?.status === 'completed', 'both targets')
        await adapter.hold(input, parentGate.promise)
      }
      return 'ok'
    })
    seen.third = w.thread('Third').id
    await w.attach()
    const going = w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go', awaitMode: 'ack' })
    await going
    await waitFor(() => w.queue(w.parent.id).filter((item) => item.settleNotice).flatMap((item) => item.settleNotice!).length === 2, 'both notices queued')
    // Never a steer of the running turn.
    expect(w.noticeTurns(w.parent.id)).toHaveLength(0)
    expect(w.queue(w.parent.id).filter((item) => item.settleNotice)).toHaveLength(1)
    parentGate.resolve()
    await waitFor(() => w.noticeTurns(w.parent.id).length === 1, 'one notice turn')
    await settle()
    expect(w.noticeTurns(w.parent.id)).toHaveLength(1)
    const notice = w.messages(w.parent.id).find((entry) => entry.settleNotice)!.settleNotice!
    expect(notice.map((item) => item.threadId).sort()).toEqual([w.other.id, seen.third as string].sort())
    // Each watched run was the first agent message in a row: the notice turn carries one, and adds none.
    expect(w.d.engine.listRuns(w.parent.id)[0]!.outcome?.agentHops).toBe(1)
  })

  it('a sender and a target go back and forth by notices in one chain: each notice turn stays in it, and the message past its budget is held', async () => {
    const results: Array<Record<string, unknown>> = []
    const w = world(async (input, mcp, d) => {
      if (input.threadId === w.parent.id) {
        // Three messages are left in the chain the person's message started.
        if (input.prompt === GO) spendChain(d.engine, `chain:${input.runId}`, w.parent.id, w.other.id, 3)
        results.push(parse(await call(mcp!, 'thread_send', { threadId: w.other.id, content: `round ${results.length + 1}`, notify: true })))
      }
      return 'ok'
    })
    await w.attach()
    await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
    await waitFor(() => results.length === 4, 'the fourth send', 60_000)
    const chainId = `chain:${w.d.engine.listRuns(w.parent.id).at(-1)!.runId}`
    expect(results.slice(0, 3).every((result) => typeof result.runId === 'string')).toBe(true)
    expect(results[3]).toMatchObject({ status: 'held', delivery: 'held_for_person', chainId })
    // Each notice turn is in the chain of the work it reports on, so the person's one message is what the budget counts from.
    expect(w.d.engine.listRuns(w.parent.id).filter((run) => run.source === 'thread-notice').map((run) => run.outcome?.agentChain)).toEqual([chainId, chainId, chainId])
    expect(w.d.engine.listRuns(w.other.id).map((run) => run.outcome?.agentChain)).toEqual([chainId, chainId, chainId])
    await settle()
    // The held send made no watch, so nothing more starts.
    expect(w.noticeTurns(w.parent.id)).toHaveLength(3)
  }, 90_000)

  it('a notice turn stays in the chain of the message sent with notify, though the sender has run in another chain since', async () => {
    const otherGate = deferred()
    const sent: Array<Record<string, unknown>> = []
    const w = world(async (input, mcp, _d, adapter) => {
      if (input.threadId === w.other.id) {
        await adapter.hold(input, otherGate.promise)
        return 'done'
      }
      if (input.threadId === w.parent.id && input.prompt === GO) sent.push(parse(await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'work', notify: true })))
      return 'ok'
    })
    await w.attach()
    await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
    await waitFor(() => sent.length === 1 && w.d.engine.listRuns(w.parent.id).every((run) => run.status === 'completed'), 'the send')
    const chainId = `chain:${w.d.engine.listRuns(w.parent.id)[0]!.runId}`
    // A person writes in the sender meanwhile: its latest run starts a chain of its own.
    await w.d.orch.send('something else', false, { threadId: w.parent.id, clientRequestId: 'person' })
    await waitFor(() => w.d.engine.listRuns(w.parent.id).length === 2 && w.d.engine.listRuns(w.parent.id).every((run) => run.status === 'completed'), 'the person\'s turn')
    otherGate.resolve()
    await waitFor(() => w.noticeTurns(w.parent.id).length === 1, 'the notice turn')
    expect(w.d.engine.listRuns(w.parent.id).find((run) => run.source === 'thread-notice')?.outcome?.agentChain).toBe(chainId)
  })

  it('a message held at its chain\'s budget keeps its notify: when the person\'s Continue sends it, the sender is told when it settles', async () => {
    const held: Array<Record<string, unknown>> = []
    const w = world(async (input, mcp, d) => {
      if (input.threadId === w.parent.id && input.prompt === GO) {
        spendChain(d.engine, `chain:${input.runId}`, w.parent.id, w.other.id)
        held.push(parse(await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'held work', notify: true })))
      }
      return 'ok'
    })
    await w.attach()
    await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
    await waitFor(() => held.length === 1 && w.d.engine.listRuns(w.parent.id).every((run) => run.status === 'completed'), 'the held send')
    expect(held[0]).toMatchObject({ status: 'held', delivery: 'held_for_person' })
    expect(await w.d.orch.answerChainHold(w.parent.id, String(held[0]!.chainId), 'continue')).toMatchObject({ sent: 1 })
    await waitFor(() => w.noticeTurns(w.parent.id).length === 1, 'the notice turn', 30_000)
    expect(w.noticeTurns(w.parent.id)[0]!.prompt).toContain(`mousse://thread/${w.other.id}`)
  })

  describe('it never starts a turn where the sender must not be woken; it waits in the sender\'s queue', () => {
    it('in a sender a person stopped after it subscribed; the person\'s next turn lets it run after', async () => {
      const otherGate = deferred()
      const w = world(async (input, mcp, _d, adapter) => {
        if (input.threadId === w.other.id) {
          await adapter.hold(input, otherGate.promise)
          return 'done late'
        }
        if (input.prompt === GO) {
          parse(await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'work', notify: true }))
          await adapter.hold(input, new Promise<void>(() => undefined))
        }
        return 'ok'
      })
      await w.attach()
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go', awaitMode: 'ack' })
      await waitFor(() => w.turnsOf(w.other.id).length === 1, 'the target turn')
      await w.d.orch.stopThread(w.parent.id, 'user')
      await waitFor(() => w.d.engine.getActiveRun(w.parent.id) === null, 'the stopped sender')
      otherGate.resolve()
      await waitFor(() => w.queue(w.parent.id).some((item) => item.settleNotice), 'the queued notice')
      await settle()
      expect(w.noticeTurns(w.parent.id)).toHaveLength(0)
      expect(w.queue(w.parent.id).find((item) => item.settleNotice)).toMatchObject({ heldNotice: true })
      // The person comes back: the notice runs after their turn, not instead of it.
      await w.d.orch.send('next', false, { threadId: w.parent.id, clientRequestId: 'next' })
      await waitFor(() => w.noticeTurns(w.parent.id).length === 1, 'the notice after the person\'s turn')
      expect(w.turnsOf(w.parent.id).map((turn) => turn.prompt.startsWith(NOTICE) ? 'notice' : turn.prompt)).toEqual([GO, 'next', 'notice'])
    })

    it('in a sender kept in Plan', async () => {
      const w = world(async (input, mcp) => {
        if (input.threadId === w.parent.id && !input.prompt.startsWith(NOTICE)) parse(await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'work', mode: 'plan', notify: true }))
        return 'ok'
      })
      await w.attach()
      await w.d.orch.send({ content: GO, mode: 'plan' }, false, { threadId: w.parent.id, clientRequestId: 'go' })
      await waitFor(() => w.queue(w.parent.id).some((item) => item.settleNotice), 'the queued notice')
      await settle()
      expect(w.noticeTurns(w.parent.id)).toHaveLength(0)
      expect(w.queue(w.parent.id).find((item) => item.settleNotice)).toMatchObject({ heldNotice: true })
    })

    it('in a subagent\'s thread, whose result is its parent\'s', async () => {
      const w = world(async (input, mcp) => {
        if (input.threadId === sub.id && !input.prompt.startsWith(NOTICE)) parse(await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'work', notify: true }))
        return 'ok'
      })
      const sub = w.thread('Sub')
      w.d.engine.delegations.createLineage({ threadId: sub.id, parentThreadId: w.parent.id, parentRunId: 'run-p', relationship: 'subagent' })
      await w.attach()
      await w.d.orch.send(GO, false, { threadId: sub.id, clientRequestId: 'go' })
      await waitFor(() => w.queue(sub.id).some((item) => item.settleNotice), 'the queued notice')
      await settle()
      expect(w.noticeTurns(sub.id)).toHaveLength(0)
      expect(w.queue(sub.id).find((item) => item.settleNotice)).toMatchObject({ heldNotice: true })
    })
  })

  it('keeps the watch across a daemon restart, and follows a usage-limit pause into the run that continues it', async () => {
    const seen: Record<string, unknown> = {}
    const ids: { parent?: string; other?: string } = {}
    const script: Script = async (input, mcp) => {
      if (input.threadId === ids.other) {
        // The target's first turn hits a usage limit that resets in a moment: its run pauses, and resumes by itself.
        if (input.prompt !== 'Continue' && !seen.paused) {
          seen.paused = true
          throw usageLimitError({ provider: 'claude', resetsAt: new Date(Date.now() + 1_500).toISOString(), estimated: false, limitKind: 'five_hour' })
        }
        return 'continued and done'
      }
      if (input.prompt === GO) seen.sent = parse(await call(mcp!, 'thread_send', { threadId: ids.other, content: 'work', notify: true }))
      return 'ok'
    }
    const first = daemon(script)
    ids.parent = first.thread('Parent').id
    ids.other = first.thread('Other work').id
    await first.attach()
    await first.d.orch.send(GO, false, { threadId: ids.parent, clientRequestId: 'go' })
    const sent = seen.sent as { runId: string; notify: { watchId: string } }
    await waitFor(() => first.d.engine.getRun(sent.runId)?.status === 'paused', 'the paused target')
    await first.crash()
    expect(first.noticeTurns(ids.parent)).toHaveLength(0)

    // The next daemon resumes the pause after the reset and finishes the work: the sender hears once, about the run that continued it.
    const second = daemon(script, home, 2)
    await second.attach()
    await waitFor(() => second.noticeTurns(ids.parent!).length === 1, 'the notice after the restart')
    await settle()
    expect(second.noticeTurns(ids.parent)).toHaveLength(1)
    expect(second.noticeTurns(ids.parent)[0]!.prompt).toContain('continued and done')
    const notice = second.messages(ids.parent).find((entry) => entry.settleNotice)!.settleNotice![0]!
    expect(notice).toMatchObject({ event: 'ended', status: 'completed' })
    expect(second.d.engine.getRun(notice.runId!)?.outcome?.continuationOf).toBe(sent.runId)
    expect(second.watch(sent.notify.watchId)).toMatchObject({ state: 'ended', end_notice: 'sent' })
  })
})
