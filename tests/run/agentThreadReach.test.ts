/**
 * Agents reaching other threads end to end (docs/run-engine/SPEC.md §15.1): a real `OrchestratorService`, Run Engine
 * and effect worker, with scripted adapters. Every agent reads and manages every thread; covers the read tools over the
 * real store, the thread that launched a thread, the agent action record, and the Mousse MCP server.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/harness/drivers/claudeCode/adapter'
import { PI_TEST_CAPABILITIES } from '../support/piStub'
import type { AdapterHost, ProviderAdapter, ProviderCapabilities, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/harness/adapter'
import type { DelegationToolHost } from '../../src/mms/run/mcp/appTools/delegation'
import { TURN_TOKEN_KEY } from '../../src/mms/run/mcp/appTools'
import { McpCredentials } from '../../src/mms/run/mcp/McpCredentials'
import { MCP_ERROR_CODES, MousseMcpServer } from '../../src/mms/run/mcp/MousseMcpServer'
import { ThreadDataStore } from '../../src/mms/data/ThreadDataStore'
import type { ProviderDriverKind } from '../../src/shared/providerInstances'
import { phase6Daemon, waitFor, type Phase6Daemon } from './phase6Fixture'
import { THREAD_REFERENCE_NOTE, extractChatReferences, formatChatReferences } from '../../src/shared/chatReferences'

type Script = (input: TurnInput, host: AdapterHost) => Promise<string>

/** A provider stand-in whose script gets the turn's host (its delegation tools, its MCP bridge). */
class ScriptedAdapter implements ProviderAdapter {
  readonly turns: TurnInput[] = []
  constructor(readonly driver: ProviderDriverKind, readonly capabilities: ProviderCapabilities, private readonly script: Script) {}

  configured(): boolean {
    return true
  }

  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.turns.push(input)
    const providerRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
    sink.providerRef(providerRef)
    const text = await this.script(input, host)
    sink.text({ phase: 'complete', content: text, contentIndex: 0 })
    const native = this.capabilities.historyInjection === 'native'
    if (!native) host.context.nativeHistoryAfterTurn(text)
    return {
      text,
      aborted: false,
      modelName: 'Scripted',
      totalResponseTimeMs: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      contextSignature: 'scripted',
      nativeMessages: native ? [...input.messages, { role: 'assistant', content: [{ type: 'text', text }], timestamp: Date.now() } as never] : [],
      providerRef
    }
  }

  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }
}

describe('agents and other threads (SPEC §15.1)', () => {
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

  const profileHome = (): string => {
    home = mkdtempSync(join(tmpdir(), 'mousse-agent-access-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    mkdirSync(join(home, 'project'))
    return home
  }

  /** A pi parent in a project (and a Claude-shaped adapter for children); `onParent` runs inside its first turn. */
  const daemon = (
    onParent: (delegation: DelegationToolHost, d: Phase6Daemon, threadId: string) => Promise<void>,
    options: { onPiChild?: Script; pid?: number; dir?: string } = {}
  ) => {
    const dir = options.dir ?? profileHome()
    let created: Phase6Daemon | undefined
    const pi = new ScriptedAdapter('pi', PI_TEST_CAPABILITIES, async (input, host) => {
      if (input.prompt !== 'Delegate it') return options.onPiChild ? options.onPiChild(input, host) : 'Looked.'
      await onParent(host.tools.delegation!, created!, input.threadId)
      return 'Delegated.'
    })
    const claude = new ScriptedAdapter('claude', CLAUDE_SUBSCRIPTION_CAPABILITIES, async () => 'Done.')
    const d = phase6Daemon(dir, [pi, claude], { pid: options.pid })
    created = d
    stops.push(d.stop)
    const project = d.projects.openProject(join(dir, 'project'))
    return { d, pi, claude, project, dir }
  }

  describe('the read tools over the real store', () => {
    const NOW = '2026-10-12T00:00:00.000Z'
    const withMessages = (d: Phase6Daemon, threadId: string, texts: string[]) =>
      d.store.saveThreadData(threadId, { ...d.store.loadThreadData(threadId), messages: texts.map((content, index) => ({ id: `m${index}`, role: 'user', content, timestamp: NOW }) as never) })

    it('titles-only reads no transcript, and a bounded search reads only the most recently updated threads', async () => {
      const { d, project } = daemon(async () => undefined)
      const old = d.store.createThread('Old chat', project.id)
      const recent = d.store.createThread('Recent chat', project.id)
      withMessages(d, old.id, ['the needle in the old chat'])
      withMessages(d, recent.id, ['the needle in the recent chat'])
      d.store.updateThreadMeta(old.id, { name: 'Old chat' })
      d.store.updateThreadMeta(recent.id, { name: 'Recent chat' })
      const messageHits = (options: Parameters<NonNullable<ReturnType<Phase6Daemon['orch']['mcpToolHost']>['searchThreads']>>[2]) =>
        Promise.resolve(d.orch.mcpToolHost().searchThreads!('needle', 50, options)).then((found) => found.filter((hit) => hit.matchType === 'message').map((hit) => hit.threadId).sort())
      expect(await messageHits({ titlesOnly: true })).toEqual([])
      expect(await messageHits({})).toEqual([old.id, recent.id].sort())
      // One transcript only: the thread updated last.
      const hits = await messageHits({ maxMessageThreads: 1 })
      expect(hits).toEqual([d.store.listAllThreads().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0].id])
    })

    it('reading a transcript for another thread does not load that thread into memory', async () => {
      const { d, project } = daemon(async () => undefined)
      const reader = d.store.createThread('Reader', project.id)
      const target = d.store.createThread('Target', project.id)
      withMessages(d, target.id, ['first', 'second'])
      const sessions = (d.orch as unknown as { sessions: Map<string, unknown> }).sessions
      sessions.delete(target.id)
      const messages = d.orch.mcpToolHost().threadMessages!(target.id)
      expect(messages.map((message) => message.content)).toEqual(['first', 'second'])
      expect(sessions.has(target.id)).toBe(false)
      expect(reader.id).not.toBe(target.id)
    })
  })

  it('a thread records the thread that launched it, apart from the subagent lineage, and keeps it across a restart', async () => {
    const { d, project } = daemon(async () => undefined)
    const creator = d.store.createThread('Creator', project.id)
    const launched = d.store.createThread('Launched', project.id, undefined, { createdByThreadId: creator.id })
    const plain = d.store.createThread('Plain', project.id)
    const late = d.store.createThread('Late', project.id)
    d.store.updateThreadMeta(late.id, { createdByThreadId: creator.id })
    // A fresh store over the same home is what the next daemon sees.
    const reopened = new ThreadDataStore(d.projects)
    expect(reopened.getThread(launched.id)).toMatchObject({ createdByThreadId: creator.id })
    expect(reopened.getThread(late.id)).toMatchObject({ createdByThreadId: creator.id })
    expect(reopened.getThread(plain.id)?.createdByThreadId).toBeUndefined()
    // Not a subagent relation: the launched thread has no lineage and is listed on its own.
    expect(reopened.getThread(launched.id)?.lineage).toBeUndefined()
    expect(reopened.listAllVisibleThreads().map((thread) => thread.id)).toEqual(expect.arrayContaining([launched.id, creator.id]))
  })

  describe('recordAgentAction', () => {
    it('writes an agent.action event without content and a transcript row naming the acting thread', async () => {
      const { d, project } = daemon(async () => undefined)
      const caller = d.store.createThread('Planner', project.id)
      const target = d.store.createThread('Target', project.id)
      const sent = await d.engine.dispatch({ kind: 'send', threadId: target.id, clientRequestId: 'target-run', source: 'gui' })
      if (sent.status !== 'accepted') throw new Error('send rejected')
      const orch = d.orch as unknown as {
        recordAgentAction(target: { threadId: string; runId?: string }, actor: { kind: 'agent'; threadId: string; runId: string; toolCallId: string }, action: string, details?: Record<string, string | number | boolean | null>): void
      }
      orch.recordAgentAction({ threadId: target.id, runId: sent.runId }, { kind: 'agent', threadId: caller.id, runId: 'run-of-caller', toolCallId: 'mcp:call-1' }, 'sent_message', { summary: 'sent a message', length: 12 })
      const event = d.engine.listEvents(target.id).find((entry) => entry.type === 'agent.action')!
      expect(event).toMatchObject({ runId: sent.runId, payload: { action: 'sent_message', actorThreadId: caller.id, actorRunId: 'run-of-caller', toolCallId: 'mcp:call-1', summary: 'sent a message', length: 12 } })
      const row = d.orch.getMessages(target.id).find((message) => message.role === 'system')!
      expect(row.content).toBe(`Changed by an agent in thread «Planner» (${caller.id}): sent a message`)
      // The event is durable and visible to a lineage reader; it holds ids and counts only.
      expect(JSON.stringify(event.payload)).not.toMatch(/hello|secret/)
    })

    it('names the acting thread by id when its title is unknown, and uses the action when there is no summary', async () => {
      const { d, project } = daemon(async () => undefined)
      const target = d.store.createThread('Target', project.id)
      const orch = d.orch as unknown as { recordAgentAction(target: { threadId: string }, actor: unknown, action: string): void }
      orch.recordAgentAction({ threadId: target.id }, { kind: 'agent', threadId: 'gone-thread', runId: 'r', toolCallId: 't' }, 'stopped_run')
      expect(d.orch.getMessages(target.id).find((message) => message.role === 'system')!.content).toBe('Changed by an agent in thread «gone-thread» (gone-thread): stopped_run')
      expect(d.engine.listEvents(target.id).some((entry) => entry.type === 'agent.action')).toBe(true)
    })
  })
})

/** The server and bearer a turn's bridge attaches, with the turn token Claude's hook stamps on each call. */
type Mcp = { url: string; token: string; turnToken?: string }

async function rpc(mcp: Mcp, method: string, params: Record<string, unknown>, id = 1) {
  const response = await fetch(mcp.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${mcp.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  })
  return await response.json() as { result?: { content?: Array<{ text: string }>; tools?: Array<{ name: string }>; isError?: boolean }; error?: { code: number; message: string; data?: { reason: string } } }
}

describe('other threads over the Mousse MCP server', () => {
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

  /** A daemon whose Claude-shaped parent talks to the real MCP server; `script` is its model. */
  const world = (script: (input: TurnInput, mcp: Mcp, d: Phase6Daemon) => Promise<string>) => {
    home = mkdtempSync(join(tmpdir(), 'mousse-agent-access-mcp-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    mkdirSync(join(home, 'project'))
    let created: Phase6Daemon | undefined
    const vendor = new ScriptedAdapter('claude', CLAUDE_SUBSCRIPTION_CAPABILITIES, async (input, host) => {
      const bridge = host.bridge
      if (!bridge?.mcp) throw new Error('expected the Mousse MCP server')
      return script(input, { ...bridge.mcp, turnToken: bridge.turnToken }, created!)
    })
    const d = phase6Daemon(home, [vendor])
    created = d
    const credentials = new McpCredentials(d.engine.store)
    const server = new MousseMcpServer({ credentials, registry: d.orch.mcpToolRegistry() })
    stops.push(async () => {
      d.orch.setMcpAttachment(null)
      await server.stop()
      await d.stop()
    })
    const project = d.projects.openProject(join(home, 'project'))
    const parent = d.store.createThread('Parent', project.id)
    const other = d.store.createThread('Other work', project.id)
    d.orch.setThreadModelOverride(parent.id, { llmProvider: 'claude-subscription', model: 'vendor-model' })
    return { d, server, credentials, parent, other, vendor, attach: async () => { await server.start(); d.orch.setMcpAttachment(server) } }
  }
  const names = async (mcp: Mcp): Promise<string[]> => (await rpc(mcp, 'tools/list', {})).result!.tools!.map((tool) => tool.name)
  const call = (mcp: Mcp, name: string, args: Record<string, unknown> = {}, id = 2) =>
    rpc(mcp, 'tools/call', { name, arguments: mcp.turnToken ? { ...args, [TURN_TOKEN_KEY]: mcp.turnToken } : args }, id)
  const NOW = '2026-10-12T00:00:00.000Z'
  const withMessages = (d: Phase6Daemon, threadId: string, texts: string[]) =>
    d.store.saveThreadData(threadId, { ...d.store.loadThreadData(threadId), messages: texts.map((content, index) => ({ id: `m${index}`, role: 'user', content, timestamp: NOW }) as never) })

  it('an agent in a thread an older version capped at lineage reads another thread\'s messages', async () => {
    const seen: Record<string, unknown> = {}
    const { d, credentials, parent, other, attach } = world(async (_input, mcp) => {
      seen.listed = await names(mcp)
      seen.list = (await call(mcp, 'thread_list')).error
      const read = await call(mcp, 'thread_read', { threadId: other.id, view: 'messages' })
      seen.readError = read.error
      seen.read = read.result?.content?.[0]?.text
      return 'Done.'
    })
    await attach()
    // A thread a bot launched, as an older version stored it: a lineage ceiling on the thread, and an old profile level.
    const creator = d.store.createThread('Bot thread', parent.projectId)
    d.store.updateThreadMeta(parent.id, { createdByThreadId: creator.id, accessCeiling: 'lineage' } as never)
    ;(d.orch as unknown as { settingsStore: { get(): { agentAccess: unknown } } }).settingsStore.get().agentAccess = { level: 'lineage', projectIds: [], answerApprovals: false }
    withMessages(d, other.id, ['the plan for other work'])
    await d.orch.send('Go', false, { threadId: parent.id, clientRequestId: 'go' })

    expect(seen.listed).toEqual(expect.arrayContaining(['thread_list', 'thread_search', 'thread_read']))
    expect(seen.list).toBeUndefined()
    expect(seen.readError).toBeUndefined()
    expect(seen.read).toContain('the plan for other work')
    expect(credentials.listForThread(parent.id).map((row) => row.accessLevel)).toEqual(['manage'])
  }, 60_000)

  // A thread reference copied from the app and pasted into a message: the agent gets a pointer, then catches up on the
  // thread with thread_read, from what it is to its last turns to the full transcript.
  it('a pasted thread reference reaches the agent as a pointer it reads by summary, recent and messages', async () => {
    const seen: { prompt?: string; summary?: Record<string, any>; recent?: Record<string, any>; messages?: Record<string, any> } = {}
    const read = async (mcp: Mcp, args: Record<string, unknown>, id: number) => {
      const response = await call(mcp, 'thread_read', args, id)
      expect(response.error).toBeUndefined()
      expect(response.result?.isError).toBeFalsy()
      return JSON.parse(response.result!.content![0]!.text) as Record<string, any>
    }
    const { d, parent, other, attach } = world(async (input, mcp) => {
      seen.prompt = input.prompt
      const target = extractChatReferences(input.prompt).references[0]!.threadId!
      seen.summary = await read(mcp, { threadId: target, view: 'summary' }, 2)
      seen.recent = await read(mcp, { threadId: target, view: 'recent', turns: 1 }, 3)
      seen.messages = await read(mcp, { threadId: target, view: 'messages', afterIndex: seen.recent.fromIndex }, 4)
      return 'Caught up.'
    })
    await attach()
    const transcript = [
      ['user', 'Draft the login page'], ['assistant', 'Drafted the login page.'],
      ['user', 'Now add a password reset'], ['assistant', 'Looking at the mailer'], ['assistant', `Added the reset flow. ${'detail '.repeat(800)}`]
    ] as const
    d.store.saveThreadData(other.id, { ...d.store.loadThreadData(other.id), messages: transcript.map(([role, content], index) => ({ id: `m${index}`, role, content, timestamp: NOW }) as never) })

    const reference = formatChatReferences([{ id: `thread:${other.id}`, kind: 'thread', title: 'Other work', threadId: other.id }])
    await d.orch.send(`What is left on this?\n\n${reference}`, false, { threadId: parent.id, clientRequestId: 'ref' })

    // The message points at the thread and holds none of its transcript.
    expect(seen.prompt).toContain(`Link: mousse://thread/${other.id}`)
    expect(seen.prompt).toContain(THREAD_REFERENCE_NOTE)
    expect(seen.prompt).not.toMatch(/login page|password reset|meta\.json/)
    // Metadata: what the thread is, none of its content.
    expect(seen.summary).toMatchObject({ threadId: other.id, title: 'Other work', status: 'idle', messages: transcript.length })
    expect(JSON.stringify(seen.summary)).not.toMatch(/login page|password reset/)
    // Short: the last turn, its step as one line and its answer trimmed.
    expect(seen.recent!.turns).toEqual([{
      prompt: expect.objectContaining({ index: 2, text: 'Now add a password reset' }),
      steps: ['Looking at the mailer'],
      answer: expect.objectContaining({ index: 4, cut: true, totalChars: transcript[4][1].length })
    }])
    // Full: the transcript from that turn on, paged.
    expect(seen.messages!.messages.map((row: { index: number }) => row.index)).toEqual([2, 3, 4])
    expect(seen.messages!.messages[2].text).toContain('Added the reset flow.')
  }, 60_000)
})
