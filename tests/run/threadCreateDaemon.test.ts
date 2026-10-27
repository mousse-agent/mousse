/**
 * `thread_create` end to end (docs/run-engine/SPEC.md §15.1): a real `OrchestratorService`, Run Engine, effect
 * worker, thread store and Mousse MCP server, with a scripted provider runtime whose turns call the tool over
 * HTTP. Covers what the new thread is (project, workspace, model, mode, creator), the limits it carries, the first
 * message, the hop chain and the per-run cap, and a creation that is retried, raced, or interrupted by a crash at
 * each step.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readAgentThreadReceipt } from '../../src/mms/orchestrator/agentThreadIntent'
import { findUnstartedThread, isThreadStarted } from '../../src/shared/threadTitle'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/run/adapters/claudeSubscription/ClaudeSubscriptionAdapter'
import type { AdapterHost, ProviderAdapter, ProviderCapabilities, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/run/adapters/ProviderAdapter'
import { agentMessageText, TURN_TOKEN_KEY, type AgentCreatedThread } from '../../src/mms/run/mcp/appTools'
import { THREAD_CREATE_MAX_ACTIVE_PER_THREAD, THREAD_CREATE_MAX_PER_RUN } from '../../src/mms/run/mcp/appTools/thread'
import { McpCredentials } from '../../src/mms/run/mcp/McpCredentials'
import { MCP_ERROR_CODES, MousseMcpServer } from '../../src/mms/run/mcp/MousseMcpServer'
import type { PermissionMode } from '../../src/shared/permissionMode'
import type { ProviderDriverKind } from '../../src/shared/providerInstances'
import type { AgentAccessLevel } from '../../src/shared/settings'
import type { ChatMessage } from '../../src/shared/types'
import { phase6Daemon, waitFor, type Phase6Daemon } from './phase6Fixture'

vi.setConfig({ testTimeout: 60_000 })

type Mcp = { url: string; token: string; turnToken?: string }
type Script = (input: TurnInput, mcp: Mcp | undefined, d: Phase6Daemon, adapter: VendorAdapter) => Promise<string>
type Rpc = Awaited<ReturnType<typeof rpc>>

/** A provider stand-in whose script gets the turn's MCP bridge. */
class VendorAdapter implements ProviderAdapter {
  readonly turns: TurnInput[] = []
  readonly abortedRuns = new Set<string>()
  private readonly interruptListeners = new Set<() => void>()
  constructor(readonly driver: ProviderDriverKind, readonly capabilities: ProviderCapabilities, private readonly script: (input: TurnInput, host: AdapterHost, adapter: VendorAdapter) => Promise<string>) {}

  configured(): boolean {
    return true
  }

  /** Holds the turn until `release` settles or the runtime is interrupted (a Stop), the way a live turn would end. */
  async hold(input: TurnInput, release: Promise<void>): Promise<void> {
    await Promise.race([
      release,
      new Promise<void>((resolve) => {
        const listener = (): void => {
          this.abortedRuns.add(input.runId)
          this.interruptListeners.delete(listener)
          resolve()
        }
        this.interruptListeners.add(listener)
        // A Stop aborts the turn of its own run only.
        if (input.signal.aborted) listener()
        else input.signal.addEventListener('abort', listener, { once: true })
      })
    ])
  }

  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.turns.push(input)
    const providerRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
    sink.providerRef(providerRef)
    const text = await this.script(input, host, this)
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

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function rpc(mcp: Mcp, method: string, params: Record<string, unknown>, id = 1) {
  const response = await fetch(mcp.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${mcp.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  })
  return await response.json() as {
    result?: { content?: Array<{ text: string }>; tools?: Array<{ name: string }>; isError?: boolean }
    error?: { code: number; message: string; data?: { reason: string; conflict?: string; [key: string]: unknown } }
  }
}

const call = (mcp: Mcp, name: string, args: Record<string, unknown> = {}) =>
  rpc(mcp, 'tools/call', { name, arguments: mcp.turnToken ? { ...args, [TURN_TOKEN_KEY]: mcp.turnToken } : args })
const parse = <T = Record<string, unknown>>(response: Rpc): T => {
  if (response.error) throw new Error(`rpc error ${response.error.code}: ${response.error.message}`)
  if (response.result?.isError) throw new Error(response.result.content?.[0]?.text ?? 'tool error')
  return JSON.parse(response.result!.content![0].text) as T
}
/** The text of an error result (a tool that refused), or of a JSON-RPC error. */
const refusal = (response: Rpc): string => response.error?.message ?? (response.result?.isError ? response.result.content?.[0]?.text ?? '' : '')

describe('thread_create end to end (SPEC §15.1)', () => {
  let home: string | undefined
  let previousHome: string | undefined
  const stops: Array<() => Promise<void>> = []

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const stop of stops.splice(0).reverse()) await stop().catch(() => undefined)
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  const MODEL = { llmProvider: 'claude-subscription', model: 'vendor-model' }
  const GO = 'Go'

  /** A daemon whose threads all run on one scripted runtime that talks to the real MCP server. `parent` is the usual creator. */
  const world = (script: Script, level: AgentAccessLevel = 'manage') => {
    home = mkdtempSync(join(tmpdir(), 'mousse-thread-create-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    mkdirSync(join(home, 'project'))
    let created: Phase6Daemon | undefined
    const adapter = new VendorAdapter('claude', CLAUDE_SUBSCRIPTION_CAPABILITIES, async (input, host, self) => {
      const bridge = host.bridge
      return script(input, bridge?.mcp ? { ...bridge.mcp, turnToken: bridge.turnToken } : undefined, created!, self)
    })
    const d = phase6Daemon(home, [adapter])
    created = d
    const credentials = new McpCredentials(d.engine.store)
    const server = new MousseMcpServer({ credentials, registry: d.orch.mcpToolRegistry() })
    stops.push(async () => {
      d.orch.setMcpAttachment(null)
      await server.stop()
      await d.stop()
    })
    const project = d.projects.openProject(join(home, 'project'))
    // A Git project (with one commit) for the creations that ask for, or run in, a worktree. The creators live in the plain one.
    mkdirSync(join(home, 'repo'))
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: join(home!, 'repo'), stdio: 'ignore' })
    git('init', '-q')
    git('commit', '-q', '--allow-empty', '-m', 'init')
    const repo = d.projects.openProject(join(home, 'repo'))
    const thread = (name: string, mode?: PermissionMode) => {
      const made = d.store.createThread(name, project.id)
      d.orch.setThreadModelOverride(made.id, MODEL)
      if (mode) d.orch.setThreadPermissionMode(made.id, mode)
      return made
    }
    const parent = thread('Parent')
    const other = thread('Other work')
    const setProfile = (next: AgentAccessLevel, projectIds: string[] = []): void => {
      ;(d.orch as unknown as { settingsStore: { get(): { agentAccess: unknown } } }).settingsStore.get().agentAccess = { level: next, projectIds, answerApprovals: false }
    }
    setProfile(level)
    const events = (threadId: string, type: string) => d.engine.listEvents(threadId).filter((event) => event.type === type)
    const marker = (threadId: string) => events(threadId, 'agent.action').filter((event) => (event.payload as { action?: string }).action === 'created_thread')
    const messages = (threadId: string): ChatMessage[] => d.orch.getOrCreateSession(threadId).messages
    /** Threads the creator launched. */
    const launchedBy = (threadId: string) => d.store.listAllThreads().filter((entry) => entry.createdByThreadId === threadId)
    const turnsOf = (threadId: string) => adapter.turns.filter((turn) => turn.threadId === threadId)
    const run = (threadId: string, prompt: string, clientRequestId: string) => d.orch.send(prompt, false, { threadId, clientRequestId })
    return {
      d, adapter, credentials, server, project, repo, parent, other, thread, setProfile, events, marker, messages, launchedBy, turnsOf, run,
      attach: async () => { await server.start(); d.orch.setMcpAttachment(server) },
      create: (mcp: Mcp, args: Record<string, unknown> = {}) => call(mcp, 'thread_create', { projectId: project.id, ...args })
    }
  }

  describe('what the new thread is', () => {
    it('is made in the project on the creator\'s model, launched by the creator and not nested under it, with the creator\'s mode, a ceiling below manage, an audit event and a row on both threads', async () => {
      const seen: { result?: AgentCreatedThread } = {}
      const w = world(async (input, mcp) => {
        if (input.threadId === w.parent.id) seen.result = parse<AgentCreatedThread>(await w.create(mcp!, { title: 'Audit the logs', clientRequestId: 'c1' }))
        return 'ok'
      })
      const announced: string[] = []
      w.d.store.on('created', (meta: { id: string }) => announced.push(meta.id))
      w.d.orch.setThreadPermissionMode(w.parent.id, 'ask')
      await w.attach()
      await w.run(w.parent.id, GO, 'go')

      const result = seen.result!
      const made = w.d.store.getThread(result.threadId)!
      expect(result).toMatchObject({ projectId: w.project.id, title: 'Audit the logs', workspace: 'project', runsIn: 'project_folder', permissionMode: 'ask', replayed: false, model: { instanceId: 'claude', model: 'vendor-model' } })
      expect(made).toMatchObject({ name: 'Audit the logs', projectId: w.project.id, createdByThreadId: w.parent.id, permissionMode: 'ask', accessCeiling: 'read', modelOverride: { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'vendor-model' } })
      expect(made.worktreeEnabled).toBeUndefined()
      // Launched, never owned: no lineage, no owner in the lifecycle store, so it is neither nested under nor deleted with the creator.
      expect(made.lineage).toBeUndefined()
      expect(w.d.store.lifecycleStore.get(made.id)?.parentTaskId).toBeUndefined()
      expect(w.d.engine.delegations.getLineage(made.id)).toBeNull()
      expect(announced).toContain(made.id)
      // The completion marker is the audit record: ids and names, never a message; the row is its projection.
      expect(w.marker(made.id)).toHaveLength(1)
      expect(w.marker(made.id)[0].payload).toMatchObject({ action: 'created_thread', actorThreadId: w.parent.id, toolCallId: 'mcp:c1', projectId: w.project.id, workspace: 'project', model: 'vendor-model', permissionMode: 'ask', hasFirstMessage: false })
      expect(w.messages(made.id).filter((message) => message.role === 'system').map((message) => message.content)).toEqual([
        `Changed by an agent in thread «Parent» (${w.parent.id}): created this thread`
      ])
      // The person watching the creator sees what it chose: the model, the mode and the place.
      expect(w.messages(w.parent.id).filter((message) => message.role === 'system').map((message) => message.content)).toEqual([
        `Created thread «Audit the logs» (${made.id}) in project ${w.project.id}: claude / vendor-model, ask mode, the project folder.`
      ])
      // Nothing ran: no first message was asked for.
      expect(w.d.engine.listRuns(made.id)).toEqual([])
    })

    it('stores the creator\'s mode whatever the profile default is, so a default loosened later cannot widen the thread past its creator', async () => {
      const ids: { full?: string } = {}
      const seen: Record<string, AgentCreatedThread> = {}
      const w = world(async (input, mcp) => {
        if (input.threadId === w.parent.id) seen.fromDefault = parse<AgentCreatedThread>(await w.create(mcp!, { clientRequestId: 'd1' }))
        if (input.threadId === ids.full) seen.fromFull = parse<AgentCreatedThread>(await w.create(mcp!, { clientRequestId: 'f1' }))
        return 'ok'
      })
      const full = w.thread('Full caller', 'full')
      ids.full = full.id
      await w.attach()
      await w.run(w.parent.id, GO, 'go-1')
      await w.run(full.id, GO, 'go-2')

      // The profile default is Auto-accept edits: a creator in that mode stores it, and a `full` one cannot widen it.
      for (const result of Object.values(seen)) expect(result.permissionMode).toBe('accept_edits')
      for (const result of Object.values(seen)) expect(w.d.store.getThread(result.threadId)?.permissionMode).toBe('accept_edits')
      expect(w.d.store.getThread(seen.fromDefault.threadId)).toMatchObject({ name: 'New Thread', createdByThreadId: w.parent.id })
      // The person loosens the default: the launched threads, their later turns and their forks keep the creator's mode.
      ;(w.d.orch as unknown as { settingsStore: { get(): { permissions: { defaultMode: string } } } }).settingsStore.get().permissions.defaultMode = 'full'
      for (const result of Object.values(seen)) expect(w.d.orch.requestedPermissionMode(result.threadId)).toBe('accept_edits')
    })

    it('is a started thread: listed from the start, and the app\'s New chat never takes it over as an empty draft', async () => {
      const seen: { made?: AgentCreatedThread } = {}
      const w = world(async (input, mcp) => {
        // No title and no message: the shape that looked like an empty draft.
        if (input.threadId === w.parent.id) seen.made = parse<AgentCreatedThread>(await w.create(mcp!, { clientRequestId: 'bare' }))
        return 'ok'
      })
      await w.attach()
      await w.run(w.parent.id, GO, 'go')
      const made = w.d.store.getThread(seen.made!.threadId)!
      expect(made.name).toBe('New Thread')
      expect(made.startedAt).toBeDefined()
      expect(isThreadStarted(made)).toBe(true)
      // What the app's "New chat" asks: the newest empty draft of the project. This thread is not one.
      expect(findUnstartedThread(w.d.store.listAllThreads(), w.project.id)).toBeUndefined()
      // A draft a person already had stays theirs.
      const draft = w.d.store.createThread('New Thread', w.project.id)
      expect(findUnstartedThread(w.d.store.listAllThreads(), w.project.id)?.id).toBe(draft.id)
    })

    it('workspace says what really happens: new_worktree needs a Git project, and the result reports where the thread runs', async () => {
      const seen: Record<string, Rpc> = {}
      const w = world(async (input, mcp) => {
        if (input.threadId !== w.parent.id) return 'ok'
        seen.plainWorktree = await w.create(mcp!, { workspace: 'new_worktree', clientRequestId: 'pw' })
        seen.gitWorktree = await call(mcp!, 'thread_create', { projectId: w.repo.id, workspace: 'new_worktree', clientRequestId: 'gw' })
        seen.gitProject = await call(mcp!, 'thread_create', { projectId: w.repo.id, workspace: 'project', clientRequestId: 'gp' })
        return 'ok'
      })
      await w.attach()
      await w.run(w.parent.id, GO, 'go')

      // A project that is not a Git repository cannot give a worktree: nothing is created or recorded.
      expect(refusal(seen.plainWorktree)).toMatch(/needs a Git project/)
      expect(w.d.engine.store.getReceipt(`thread_create:${w.parent.id}:mcp:pw`)).toBeNull()
      const worktree = parse<AgentCreatedThread>(seen.gitWorktree)
      expect(worktree).toMatchObject({ workspace: 'new_worktree', runsIn: 'own_worktree' })
      expect(w.d.store.getThread(worktree.threadId)?.worktreeEnabled).toBe(true)
      // On a Git project an editing turn gets a worktree of its own whichever was asked for, and the result says so.
      const project = parse<AgentCreatedThread>(seen.gitProject)
      expect(project).toMatchObject({ workspace: 'project', runsIn: 'own_worktree' })
      expect(w.d.store.getThread(project.threadId)?.worktreeEnabled).toBeUndefined()
      expect(w.launchedBy(w.parent.id)).toHaveLength(2)
    })

    it('the first turn runs where the result says: in a worktree on a Git project, in the project folder on any other', async () => {
      const seen: Record<string, AgentCreatedThread> = {}
      const w = world(async (input, mcp) => {
        if (input.threadId !== w.parent.id) return 'ok'
        seen.plain = parse<AgentCreatedThread>(await w.create(mcp!, { firstMessage: 'Edit the files', clientRequestId: 'run-plain' }))
        seen.git = parse<AgentCreatedThread>(await call(mcp!, 'thread_create', { projectId: w.repo.id, firstMessage: 'Edit the files', clientRequestId: 'run-git' }))
        return 'ok'
      })
      await w.attach()
      await w.run(w.parent.id, GO, 'go')
      for (const made of Object.values(seen)) await waitFor(() => w.d.engine.getRun((made.firstMessage as { runId: string }).runId)?.status === 'completed', 'the first run')
      const norm = (path: string | null) => (path ?? '').replace(/\\/g, '/').toLowerCase()
      expect(norm(w.turnsOf(seen.plain.threadId)[0].cwd)).toBe(norm(join(home!, 'project')))
      expect(seen.plain.runsIn).toBe('project_folder')
      expect(norm(w.turnsOf(seen.git.threadId)[0].cwd)).toContain(seen.git.threadId.toLowerCase())
      expect(norm(w.turnsOf(seen.git.threadId)[0].cwd)).not.toBe(norm(join(home!, 'repo')))
      expect(seen.git.runsIn).toBe('own_worktree')
    })

    it('existing_worktree is refused with no thread, no receipt and no event', async () => {
      const seen: { refused?: Rpc } = {}
      const w = world(async (input, mcp) => {
        if (input.threadId === w.parent.id) seen.refused = await w.create(mcp!, { workspace: 'existing_worktree', clientRequestId: 'ew' })
        return 'ok'
      })
      await w.attach()
      await w.run(w.parent.id, GO, 'go')
      expect(refusal(seen.refused!)).toMatch(/existing_worktree is not supported|"existing_worktree" is not supported/)
      expect(w.launchedBy(w.parent.id)).toEqual([])
      expect(w.d.engine.store.getReceipt(`thread_create:${w.parent.id}:mcp:ew`)).toBeNull()
    })

    it('a project that does not exist is refused before anything is recorded', async () => {
      const seen: { refused?: Rpc } = {}
      const w = world(async (input, mcp) => {
        if (input.threadId === w.parent.id) seen.refused = await call(mcp!, 'thread_create', { projectId: 'no-such-project', clientRequestId: 'np' })
        return 'ok'
      })
      await w.attach()
      await w.run(w.parent.id, GO, 'go')
      expect(refusal(seen.refused!)).toMatch(/Project no-such-project was not found/)
      expect(w.launchedBy(w.parent.id)).toEqual([])
      expect(w.d.engine.store.getReceipt(`thread_create:${w.parent.id}:mcp:np`)).toBeNull()
    })
  })

  describe('a launched thread cannot launch', () => {
    it('its agents are granted read at most: thread_create and thread_send are not listed and are refused', async () => {
      const seen: { made?: AgentCreatedThread; listed?: string[]; create?: Rpc; send?: Rpc } = {}
      const w = world(async (input, mcp) => {
        if (input.threadId === w.parent.id) seen.made = parse<AgentCreatedThread>(await w.create(mcp!, { clientRequestId: 'lv' }))
        else if (seen.made && input.threadId === seen.made.threadId) {
          seen.listed = (await rpc(mcp!, 'tools/list', {})).result!.tools!.map((tool) => tool.name)
          seen.create = await w.create(mcp!, { clientRequestId: 'child-create' })
          seen.send = await call(mcp!, 'thread_send', { threadId: w.parent.id, content: 'hello' })
        }
        return 'ok'
      })
      await w.attach()
      await w.run(w.parent.id, GO, 'go')
      const id = seen.made!.threadId
      await w.run(id, 'work by hand', 'hand-1')
      // The profile says manage, and a person drives the thread: its agents are still held to read.
      expect(w.credentials.listForThread(id).map((row) => row.accessLevel).at(-1)).toBe('read')
      expect(seen.listed).not.toContain('thread_create')
      expect(seen.listed).not.toContain('thread_send')
      expect(seen.listed).toContain('thread_wait')
      for (const reply of [seen.create!, seen.send!]) expect(reply.error).toMatchObject({ code: MCP_ERROR_CODES.mousse_scope_denied })
      expect(w.launchedBy(id)).toEqual([])
      // The ceiling is stored on the thread, so forks and subagents of it start from it.
      expect(w.d.store.getThread(id)?.accessCeiling).toBe('read')
      // And lowering the profile still lowers it further.
      w.setProfile('lineage')
      await w.run(id, 'second by hand', 'hand-2')
      expect(w.credentials.listForThread(id).map((row) => row.accessLevel).at(-1)).toBe('lineage')
    })
  })

  describe('the provider instance and model', () => {
    it('are checked as threads.setModel checks them: an unknown instance, a hidden model and an instance the project turned off are refused before any receipt', async () => {
      const seen: Record<string, Rpc | AgentCreatedThread> = {}
      const w = world(async (input, mcp, d) => {
        if (input.threadId !== w.parent.id) return 'ok'
        const harness = (d.orch as unknown as { harness: { instances: { setModelPrefs(id: string, patch: unknown): Promise<unknown>; setEnabled(id: string, scope: unknown, enabled: boolean | null): Promise<unknown> } } }).harness
        seen.explicit = parse<AgentCreatedThread>(await w.create(mcp!, { instanceId: 'claude', model: 'sonnet', clientRequestId: 'm1' }))
        // A model alone is on the creator's own instance.
        seen.onlyModel = parse<AgentCreatedThread>(await w.create(mcp!, { model: 'opus', clientRequestId: 'm2' }))
        seen.unknown = await w.create(mcp!, { instanceId: 'nope', model: 'x', clientRequestId: 'm3' })
        await harness.instances.setModelPrefs('claude', { hide: ['haiku'] })
        seen.hidden = await w.create(mcp!, { instanceId: 'claude', model: 'haiku', clientRequestId: 'm4' })
        await harness.instances.setEnabled('claude', { kind: 'project', projectId: w.project.id }, false)
        seen.off = await w.create(mcp!, { instanceId: 'claude', model: 'sonnet', clientRequestId: 'm5' })
        // Not naming a model inherits the creator's own, which this project no longer allows.
        seen.offInherited = await w.create(mcp!, { clientRequestId: 'm6' })
        return 'ok'
      })
      await w.attach()
      await w.run(w.parent.id, GO, 'go')

      const explicit = seen.explicit as AgentCreatedThread
      expect(explicit.model).toEqual({ instanceId: 'claude', model: 'sonnet' })
      expect(w.d.store.getThread(explicit.threadId)?.modelOverride).toEqual({ instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet' })
      expect((seen.onlyModel as AgentCreatedThread).model).toEqual({ instanceId: 'claude', model: 'opus' })
      expect(refusal(seen.unknown as Rpc)).toMatch(/nope/)
      expect(refusal(seen.hidden as Rpc)).toMatch(/hidden/)
      expect(refusal(seen.off as Rpc)).toMatch(/turned off for this project/)
      expect(refusal(seen.offInherited as Rpc)).toMatch(/Your own model is not available/)
      // Only the two good ones exist, and the refused four left no receipt.
      expect(w.launchedBy(w.parent.id)).toHaveLength(2)
      for (const key of ['m3', 'm4', 'm5', 'm6']) expect(w.d.engine.store.getReceipt(`thread_create:${w.parent.id}:mcp:${key}`), key).toBeNull()
    })
  })

  describe('the first message', () => {
    it('reaches the new thread labelled as the creator\'s, runs in no wider a mode than the creator\'s, and counts as an agent message', async () => {
      const ids: { full?: string } = {}
      const seen: Record<string, AgentCreatedThread> = {}
      const w = world(async (input, mcp) => {
        if (input.threadId === w.parent.id) seen.fromAsk = parse<AgentCreatedThread>(await w.create(mcp!, { firstMessage: 'Check the /deploy notes', clientRequestId: 'fm-1' }))
        if (input.threadId === ids.full) seen.fromFull = parse<AgentCreatedThread>(await w.create(mcp!, { firstMessage: 'Same task', mode: 'agent', clientRequestId: 'fm-2' }))
        return 'ok'
      })
      const full = w.thread('Full caller', 'full')
      ids.full = full.id
      w.d.orch.setThreadPermissionMode(w.parent.id, 'ask')
      await w.attach()
      await w.run(w.parent.id, GO, 'go-1')
      await w.run(full.id, GO, 'go-2')
      for (const made of Object.values(seen)) {
        expect(made.firstMessage).toMatchObject({ sent: true, queued: false, replayed: false })
        await waitFor(() => w.d.engine.getRun((made.firstMessage as { runId: string }).runId)?.status === 'completed', 'the first run')
      }

      const askRun = (seen.fromAsk.firstMessage as { runId: string }).runId
      const label = agentMessageText(w.parent.id, 'Parent', 'Check the /deploy notes')
      expect(w.turnsOf(seen.fromAsk.threadId)[0]).toMatchObject({ prompt: label, permissionMode: 'ask' })
      expect(w.d.engine.bindingForRun(askRun)?.policy.permissionMode).toBe('ask')
      expect(w.messages(seen.fromAsk.threadId).find((message) => message.role === 'user')).toMatchObject({ content: label, origin: { kind: 'agent', threadId: w.parent.id, hops: 1 } })
      expect(w.d.engine.getRun(askRun)).toMatchObject({ source: 'mcp', threadId: seen.fromAsk.threadId, outcome: { sentByAgent: true, agentHops: 1 } })
      // A `full` creator's message still runs under the thread's own (default) mode, never `full`.
      expect(w.turnsOf(seen.fromFull.threadId)[0].permissionMode).toBe('accept_edits')
      // The marker says a message came with it, and the send has its own audit event.
      expect(w.marker(seen.fromAsk.threadId)[0].payload).toMatchObject({ hasFirstMessage: true })
      expect(w.events(seen.fromAsk.threadId, 'agent.action').map((event) => (event.payload as { action: string }).action)).toEqual(['created_thread', 'sent_message'])
    })

    it('an agent message in a row counts: a creation at the hop limit is refused before anything is made, and so is one from a run that carries on that chain', async () => {
      const seen: { refused?: Rpc; bare?: AgentCreatedThread; hopsOf?: Record<string, number | undefined>; continued?: { threadId: string; runId: string } } = {}
      const w = world(async (input, mcp, d) => {
        const hops = d.engine.getRun(input.runId)?.outcome?.agentHops ?? 0
        if (hops < 3) {
          // Two agents pass work back and forth: the runs they start have 1, 2 and 3 agent messages behind them.
          const target = input.threadId === w.parent.id ? w.other.id : w.parent.id
          await call(mcp!, 'thread_send', { threadId: target, content: `hop from a run with ${hops}` })
          return 'sent'
        }
        seen.continued = { threadId: input.threadId, runId: input.runId }
        seen.refused = await w.create(mcp!, { firstMessage: 'one more', clientRequestId: 'chain-3' })
        // The limit is on agent messages: a thread made without one is no hop.
        seen.bare = parse<AgentCreatedThread>(await w.create(mcp!, { clientRequestId: 'bare-3' }))
        return 'end'
      })
      await w.attach()
      await w.run(w.parent.id, GO, 'go')
      await waitFor(() => seen.bare !== undefined, 'the chain to reach the limit', 30_000)

      expect(seen.refused!.error).toMatchObject({ code: MCP_ERROR_CODES.mousse_conflict, data: { conflict: 'agent_hops_exceeded' } })
      // Refused before the receipt and before any thread: the only thread the run at the limit made is the bare one.
      expect(w.launchedBy(seen.continued!.threadId).map((entry) => entry.id)).toEqual([seen.bare!.threadId])
      expect(w.d.engine.store.getReceipt(`thread_create:${seen.continued!.threadId}:mcp:chain-3`)).toBeNull()

      // A provider's own continuation of that run, a wake that delivers a subagent's result and the resume after a usage pause
      // carry the count on: they are the same chain of agent work, so a creation from them is refused too.
      const continuation = await w.d.engine.dispatch({ kind: 'send', threadId: seen.continued!.threadId, clientRequestId: 'continuation:hops', source: 'provider-continuation' })
      if (continuation.status !== 'accepted') throw new Error('the continuation was not accepted')
      expect(w.d.engine.getRun(continuation.runId)?.outcome).toMatchObject({ agentHops: 3 })
      expect(w.d.engine.getRun(continuation.runId)?.outcome?.sentByAgent).toBeUndefined()
      await expect(w.d.orch.mcpToolHost().createThread!({ projectId: w.project.id, workspace: 'project', firstMessage: 'again' }, {
        clientRequestId: 'chain-continued',
        actor: { kind: 'agent', threadId: seen.continued!.threadId, runId: continuation.runId, toolCallId: 'mcp:chain-continued' },
        accessLevel: 'manage'
      })).rejects.toMatchObject({ code: 'agent_hops_exceeded' })
      expect(w.d.engine.store.getReceipt('chain-continued')).toBeNull()
    })
  })

  describe('the cap per run', () => {
    it(`a run creates ${THREAD_CREATE_MAX_PER_RUN} threads and is refused the next`, async () => {
      const results: Rpc[] = []
      const w = world(async (input, mcp) => {
        if (input.threadId !== w.parent.id) return 'ok'
        for (let index = 0; index <= THREAD_CREATE_MAX_PER_RUN; index += 1) results.push(await w.create(mcp!, { clientRequestId: `cap-${index}` }))
        return 'ok'
      })
      await w.attach()
      await w.run(w.parent.id, GO, 'go')
      expect(results.slice(0, THREAD_CREATE_MAX_PER_RUN).every((reply) => !reply.error && !reply.result?.isError)).toBe(true)
      expect(refusal(results.at(-1)!)).toMatch(new RegExp(`limited to ${THREAD_CREATE_MAX_PER_RUN} threads per run`))
      expect(w.launchedBy(w.parent.id)).toHaveLength(THREAD_CREATE_MAX_PER_RUN)
    })
  })

  describe('the cap on launched threads that are still working', () => {
    it('holds across runs of the creator, unlike the per-run count: a fresh run is refused while enough of its launched threads have work', async () => {
      const replies: Rpc[] = []
      const w = world(async (input, mcp) => {
        if (input.threadId !== w.parent.id) return 'ok'
        // Bare threads: the test gives each one queued work, so no turn occupies the worker.
        for (let index = 0; index < THREAD_CREATE_MAX_PER_RUN; index += 1) replies.push(await w.create(mcp!, { clientRequestId: `${input.prompt}-${index}` }))
        return 'ok'
      })
      await w.attach()
      const giveWork = async () => {
        for (const launched of w.launchedBy(w.parent.id)) {
          if (w.d.engine.listRuns(launched.id).length) continue
          const queued = await w.d.engine.dispatch({ kind: 'send', threadId: launched.id, clientRequestId: `work:${launched.id}`, source: 'gui' })
          if (queued.status !== 'accepted') throw new Error('send rejected')
        }
      }
      // Two runs of the creator, five threads each: ten launched threads have a queued run.
      await w.run(w.parent.id, 'run-a', 'go-a')
      await giveWork()
      await w.run(w.parent.id, 'run-b', 'go-b')
      await giveWork()
      expect(replies.every((reply) => !reply.error && !reply.result?.isError)).toBe(true)
      expect(w.launchedBy(w.parent.id)).toHaveLength(THREAD_CREATE_MAX_ACTIVE_PER_THREAD)
      // A third run has a fresh per-run count and is still refused: the launched threads have work.
      replies.length = 0
      await w.run(w.parent.id, 'run-c', 'go-c')
      expect(refusal(replies[0])).toMatch(/still working/)
      expect(replies[0].error).toMatchObject({ code: MCP_ERROR_CODES.mousse_conflict, data: { conflict: 'creation_limit' } })
      expect(w.launchedBy(w.parent.id)).toHaveLength(THREAD_CREATE_MAX_ACTIVE_PER_THREAD)
      // Once their work is over the creator may launch again.
      for (const run of w.d.engine.store.listNonTerminalRuns().filter((entry) => entry.threadId !== w.parent.id)) w.d.engine.markTerminal(run.runId, 'cancelled')
      replies.length = 0
      await w.run(w.parent.id, 'run-d', 'go-d')
      expect(replies.slice(0, THREAD_CREATE_MAX_PER_RUN).every((reply) => !reply.error && !reply.result?.isError)).toBe(true)
    })

    it('a person\'s Stop of the creator stops the launched threads that run work an agent started, and leaves one a person is working in', async () => {
      const release = deferred()
      const seen: { made?: AgentCreatedThread[] } = {}
      const w = world(async (input, mcp, _d, adapter) => {
        if (input.threadId === w.parent.id) {
          seen.made = [
            parse<AgentCreatedThread>(await w.create(mcp!, { firstMessage: 'Long task A', clientRequestId: 'a' })),
            parse<AgentCreatedThread>(await w.create(mcp!, { firstMessage: 'Quick task B', clientRequestId: 'b' }))
          ]
          return 'launched'
        }
        if (input.prompt.includes('Long')) await adapter.hold(input, release.promise)
        return 'worked'
      })
      await w.attach()
      await w.run(w.parent.id, GO, 'go')
      const [a, b] = seen.made!
      const aRun = (a.firstMessage as { runId: string }).runId
      await waitFor(() => w.d.engine.getRun(aRun)?.status === 'running', 'the launched turn')
      await waitFor(() => w.d.engine.getRun((b.firstMessage as { runId: string }).runId)?.status === 'completed', 'the quick launched turn')
      // A person starts working in B: the work there is theirs.
      await w.d.orch.send('Long job of my own', false, { threadId: b.threadId, clientRequestId: 'person-b', awaitMode: 'ack' })
      await waitFor(() => w.turnsOf(b.threadId).length === 2, 'the person\'s turn in B')

      await w.d.orch.stopThread(w.parent.id, 'user', { clientRequestId: 'person-stop' })
      await waitFor(() => w.d.engine.getRun(aRun)?.status !== 'running', 'the launched run to stop')
      expect(w.adapter.abortedRuns.has(aRun)).toBe(true)
      expect(w.d.engine.getActiveRun(b.threadId)?.status).toBe('running')
      release.resolve()
    })
  })

  describe('a retry', () => {
    it('returns the same thread after the caller\'s run was replaced and its credential re-minted, and creates nothing more', async () => {
      const seen: Record<string, AgentCreatedThread> = {}
      const w = world(async (input, mcp) => {
        if (input.threadId !== w.parent.id) return 'ok'
        seen[input.prompt] = parse<AgentCreatedThread>(await w.create(mcp!, { title: 'Once', firstMessage: 'Start', clientRequestId: 'same' }))
        return 'ok'
      })
      await w.attach()
      await w.run(w.parent.id, GO, 'go-1')
      const first = seen[GO]
      await waitFor(() => w.d.engine.getRun((first.firstMessage as { runId: string }).runId)?.status === 'completed', 'the first run')
      const firstCredential = w.credentials.listForThread(w.parent.id).map((row) => row.runId)
      await w.run(w.parent.id, 'again', 'go-2')
      expect(w.credentials.listForThread(w.parent.id).map((row) => row.runId)).not.toEqual(firstCredential)

      const again = seen.again
      expect(again).toMatchObject({ threadId: first.threadId, replayed: true, firstMessage: { sent: true, replayed: true, runId: (first.firstMessage as { runId: string }).runId } })
      expect(w.launchedBy(w.parent.id)).toHaveLength(1)
      expect(w.marker(first.threadId)).toHaveLength(1)
      expect(w.d.engine.listRuns(first.threadId)).toHaveLength(1)
      // The transcript row is the winning call's alone.
      expect(w.messages(first.threadId).filter((message) => message.role === 'system')).toHaveLength(1)
    })

    it('with different arguments is a conflict, and the first thread is untouched', async () => {
      const seen: { first?: AgentCreatedThread; other?: Rpc; title?: Rpc } = {}
      const w = world(async (input, mcp) => {
        if (input.threadId !== w.parent.id) return 'ok'
        seen.first = parse<AgentCreatedThread>(await w.create(mcp!, { title: 'One', clientRequestId: 'k' }))
        seen.other = await w.create(mcp!, { title: 'Two', clientRequestId: 'k' })
        seen.title = await w.create(mcp!, { title: 'One', workspace: 'new_worktree', clientRequestId: 'k' })
        return 'ok'
      })
      await w.attach()
      await w.run(w.parent.id, GO, 'go')
      for (const reply of [seen.other!, seen.title!]) expect(reply.error).toMatchObject({ code: MCP_ERROR_CODES.mousse_conflict, data: { conflict: 'client_request_id_conflict' } })
      expect(w.launchedBy(w.parent.id).map((entry) => entry.name)).toEqual(['One'])
    })

    it('two calls with one key at once make one thread; the second is told it is a replay and adds no row', async () => {
      const seen: { both?: AgentCreatedThread[] } = {}
      const w = world(async (input, mcp) => {
        if (input.threadId !== w.parent.id) return 'ok'
        seen.both = (await Promise.all([w.create(mcp!, { title: 'Raced', clientRequestId: 'race' }), w.create(mcp!, { title: 'Raced', clientRequestId: 'race' })])).map((reply) => parse<AgentCreatedThread>(reply))
        return 'ok'
      })
      await w.attach()
      await w.run(w.parent.id, GO, 'go')
      const [a, b] = seen.both!
      expect(a.threadId).toBe(b.threadId)
      expect([a.replayed, b.replayed].sort()).toEqual([false, true])
      expect(w.launchedBy(w.parent.id)).toHaveLength(1)
      expect(w.marker(a.threadId)).toHaveLength(1)
      expect(w.messages(a.threadId).filter((message) => message.role === 'system')).toHaveLength(1)
    })
  })

  describe('a crash during the creation', () => {
    type World = ReturnType<typeof world>
    const KEY = 'crash-1'

    /**
     * The first run of the creator asks for a thread with a first message after `arm` set up a fault; between
     * the first run and the second, the creator's own mode and the profile's default are changed. The second run
     * asks again with the same key and arguments.
     */
    const crashed = async (arm: (w: World) => void) => {
      const replies: Record<string, Rpc> = {}
      const w = world(async (input, mcp) => {
        if (input.threadId !== w.parent.id) return 'ok'
        replies[input.prompt] = await w.create(mcp!, { title: 'Crash test', instanceId: 'claude', model: 'sonnet', firstMessage: 'Start here', clientRequestId: KEY })
        return 'ok'
      })
      w.d.orch.setThreadPermissionMode(w.parent.id, 'ask')
      arm(w)
      await w.attach()
      await w.run(w.parent.id, GO, 'go-1')
      return { w, replies, key: `thread_create:${w.parent.id}:mcp:${KEY}` }
    }

    /** The second attempt, from a creator that looks different now: another mode, another model. */
    const retry = async (w: World, replies: Record<string, Rpc>) => {
      w.d.orch.setThreadPermissionMode(w.parent.id, 'full')
      w.d.orch.setThreadModelOverride(w.parent.id, { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'haiku' })
      await w.run(w.parent.id, 'again', 'go-2')
      return parse<AgentCreatedThread>(replies.again)
    }

    /** Exactly one complete thread, made from the first attempt's launch, with one marker and one first message. */
    const expectOneComplete = async (w: World, made: AgentCreatedThread) => {
      expect(w.launchedBy(w.parent.id)).toHaveLength(1)
      const thread = w.d.store.getThread(made.threadId)!
      expect(thread).toMatchObject({ name: 'Crash test', permissionMode: 'ask', createdByThreadId: w.parent.id, modelOverride: { instanceId: 'claude', model: 'sonnet' } })
      expect(made).toMatchObject({ title: 'Crash test', permissionMode: 'ask', model: { instanceId: 'claude', model: 'sonnet' } })
      expect(w.marker(made.threadId)).toHaveLength(1)
      expect(made.firstMessage).toMatchObject({ sent: true })
      await waitFor(() => w.d.engine.getRun((made.firstMessage as { runId: string }).runId)?.status === 'completed', 'the first run')
      expect(w.d.engine.listRuns(made.threadId)).toHaveLength(1)
      expect(w.turnsOf(made.threadId)).toHaveLength(1)
      expect(w.turnsOf(made.threadId)[0]).toMatchObject({ model: 'sonnet', permissionMode: 'ask' })
    }

    /** Throws once, when the store writes `file` of the thread the creation decided on (the creator's own files are left alone). */
    const failOnce = (w: World, file: string) => {
      const store = w.d.store as unknown as { writeJsonAtomic(path: string, value: unknown): void }
      const real = store.writeJsonAtomic.bind(store)
      let armed = true
      vi.spyOn(store, 'writeJsonAtomic').mockImplementation((path: string, value: unknown) => {
        const decided = w.d.engine.store.listUnfinishedThreadCreations('1970-01-01T00:00:00.000Z').map((receipt) => readAgentThreadReceipt(receipt)?.intent.threadId)
        if (armed && path.endsWith(file) && decided.some((id) => id && path.includes(id))) {
          armed = false
          throw new Error(`crash while writing ${file}`)
        }
        return real(path, value)
      })
    }

    it('after the receipt and before any file: the retry makes the one thread from the stored launch', async () => {
      const { w, replies, key } = await crashed((world) => {
        vi.spyOn(world.d.store, 'createThread').mockImplementationOnce(() => { throw new Error('crash before the files') })
      })
      expect(refusal(replies[GO])).toMatch(/crash before the files/)
      expect(w.launchedBy(w.parent.id)).toEqual([])
      expect(readAgentThreadReceipt(w.d.engine.store.getReceipt(key))?.intent).toMatchObject({ title: 'Crash test', permissionMode: 'ask', modelOverride: { model: 'sonnet' } })
      await expectOneComplete(w, await retry(w, replies))
    })

    it.each([
      ['meta.json', 'between the lifecycle registration and meta.json'],
      ['messages.json', 'after meta.json and before messages.json']
    ])('inside createThread, %s (%s): the retry leaves one complete thread', async (file) => {
      const { w, replies } = await crashed((world) => failOnce(world, file))
      expect(refusal(replies[GO])).toMatch(/crash while writing/)
      const made = await retry(w, replies)
      expect(made.replayed).toBe(false)
      await expectOneComplete(w, made)
    })

    it('after the files and before the marker: the half thread is discarded and made again under the same id', async () => {
      const { w, replies, key } = await crashed((world) => {
        const store = world.d.engine.store
        const real = store.appendEvent.bind(store)
        let armed = true
        vi.spyOn(store, 'appendEvent').mockImplementation((input) => {
          if (armed && input.type === 'agent.action' && (input.payload as { action?: string }).action === 'created_thread') {
            armed = false
            throw new Error('crash before the marker')
          }
          return real(input)
        })
      })
      expect(refusal(replies[GO])).toMatch(/crash before the marker/)
      const id = readAgentThreadReceipt(w.d.engine.store.getReceipt(key))!.intent.threadId
      // The files are there, but nothing marks the thread complete.
      expect(w.d.store.getThread(id)).toBeDefined()
      expect(w.marker(id)).toEqual([])
      const made = await retry(w, replies)
      expect(made.threadId).toBe(id)
      expect(made.replayed).toBe(false)
      await expectOneComplete(w, made)
    })

    it('after the marker and before the first message: the retry only sends the message', async () => {
      const { w, replies } = await crashed((world) => {
        vi.spyOn(world.d.orch as unknown as { sendToThreadAsAgent(): Promise<unknown> }, 'sendToThreadAsAgent').mockImplementationOnce(async () => { throw new Error('crash before the first message') })
      })
      const first = parse<AgentCreatedThread>(replies[GO])
      // The thread exists and says what became of the message; nothing ran.
      expect(first.firstMessage).toEqual({ sent: false, reason: 'crash before the first message' })
      expect(w.marker(first.threadId)).toHaveLength(1)
      expect(w.d.engine.listRuns(first.threadId)).toEqual([])
      const made = await retry(w, replies)
      expect(made).toMatchObject({ threadId: first.threadId, replayed: true })
      await expectOneComplete(w, made)
    })

    it('a boot between the crash and the retry discards the half thread, lists none, and the retry still succeeds', async () => {
      const { w, replies, key } = await crashed((world) => failOnce(world, 'messages.json'))
      const id = readAgentThreadReceipt(w.d.engine.store.getReceipt(key))!.intent.threadId
      expect(w.d.store.getThread(id)).toBeDefined()
      ;(w.d.orch as unknown as { recoverAgentThreadCreations(): void }).recoverAgentThreadCreations()
      expect(w.d.store.getThread(id)).toBeUndefined()
      expect(w.d.store.listAllThreads().some((entry) => entry.id === id)).toBe(false)
      const made = await retry(w, replies)
      expect(made.threadId).toBe(id)
      await expectOneComplete(w, made)
    })

    /** A creation cut off before its marker, so a half-made thread exists: files, announced, no marker. */
    const beforeMarker = (world: World): void => {
      const store = world.d.engine.store
      const real = store.appendEvent.bind(store)
      let armed = true
      vi.spyOn(store, 'appendEvent').mockImplementation((input) => {
        if (armed && input.type === 'agent.action' && (input.payload as { action?: string }).action === 'created_thread') {
          armed = false
          throw new Error('crash before the marker')
        }
        return real(input)
      })
    }

    it('a thread a person already used before the marker is never adopted: the retry is refused, nothing is sent to it, and boot keeps it', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const { w, replies, key } = await crashed(beforeMarker)
      const id = readAgentThreadReceipt(w.d.engine.store.getReceipt(key))!.intent.threadId
      // The thread was announced when its files were written, so a person opened it and wrote to it.
      await w.run(id, 'hello from a person', 'person-1')
      ;(w.d.orch as unknown as { recoverAgentThreadCreations(): void }).recoverAgentThreadCreations()
      expect(w.d.store.getThread(id)).toBeDefined()
      w.d.orch.setThreadPermissionMode(w.parent.id, 'full')
      await w.run(w.parent.id, 'again', 'go-2')
      expect(replies.again.error).toMatchObject({ code: MCP_ERROR_CODES.mousse_conflict, data: { conflict: 'thread_in_use', threadId: id } })
      expect(w.marker(id)).toEqual([])
      expect(w.messages(id).filter((message) => message.role === 'user').map((message) => message.content)).toEqual(['hello from a person'])
      expect(w.d.engine.listRuns(id)).toHaveLength(1)
      expect(w.launchedBy(w.parent.id)).toHaveLength(1)
    })

    it('a thread a person renamed or re-moded is not used up either, though nothing was sent to it', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const { w, replies, key } = await crashed(beforeMarker)
      const id = readAgentThreadReceipt(w.d.engine.store.getReceipt(key))!.intent.threadId
      w.d.store.updateThreadMeta(id, { name: 'My own name' })
      ;(w.d.orch as unknown as { recoverAgentThreadCreations(): void }).recoverAgentThreadCreations()
      expect(w.d.store.getThread(id)?.name).toBe('My own name')
      await w.run(w.parent.id, 'again', 'go-2')
      expect(replies.again.error).toMatchObject({ data: { conflict: 'thread_in_use' } })
      expect(w.d.engine.listRuns(id)).toEqual([])
    })

    describe('after a real restart', () => {
      /** The daemon dies with a half-made thread; a new one starts over the same home and boots. */
      const restarted = async (touch?: (d2: Phase6Daemon, id: string) => void) => {
        const { w, key } = await crashed(beforeMarker)
        const id = readAgentThreadReceipt(w.d.engine.store.getReceipt(key))!.intent.threadId
        expect(w.d.store.getThread(id)).toBeDefined()
        await w.d.crash()
        const second = phase6Daemon(home!, [new VendorAdapter('claude', CLAUDE_SUBSCRIPTION_CAPABILITIES, async () => 'ok')], { pid: 2 })
        stops.push(() => second.stop())
        const discarded: string[] = []
        second.store.on('discarded', (event: { id: string }) => discarded.push(event.id))
        touch?.(second, id)
        second.orch.recoverRunEngineOnBoot()
        return { second, id, discarded, key }
      }

      it('discards the unused half thread, tells clients, and keeps the receipt for the creator\'s retry', async () => {
        const { second, id, discarded, key } = await restarted()
        expect(second.store.getThread(id)).toBeUndefined()
        expect(second.store.listAllThreads().some((entry) => entry.id === id)).toBe(false)
        expect(discarded).toEqual([id])
        expect(readAgentThreadReceipt(second.engine.store.getReceipt(key))?.intent.threadId).toBe(id)
      })

      it('keeps a half thread a person renamed, and says nothing to clients', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const { second, id, discarded } = await restarted((d2, threadId) => { d2.store.updateThreadMeta(threadId, { name: 'Mine now' }) })
        expect(second.store.getThread(id)?.name).toBe('Mine now')
        expect(discarded).toEqual([])
      })
    })
  })

  it('a bot\'s thread cannot create threads even when the host is asked directly', async () => {
    const w = world(async () => 'ok')
    ;(w.d.orch as unknown as { botThreads: { roleOf(id: string): string | undefined } }).botThreads = { roleOf: (id) => (id === w.parent.id ? 'activation' : undefined) }
    const host = w.d.orch.mcpToolHost()
    await expect(host.createThread!({ projectId: w.project.id, workspace: 'project' }, {
      clientRequestId: 'bot-1',
      actor: { kind: 'agent', threadId: w.parent.id, runId: 'run-x', toolCallId: 'mcp:bot-1' },
      accessLevel: 'manage'
    })).rejects.toMatchObject({ code: 'mousse_scope_denied' })
    expect(w.launchedBy(w.parent.id)).toEqual([])
    expect(w.d.engine.store.getReceipt(`bot-1`)).toBeNull()
  })

  it('a thread can be created below manage by nobody: lineage and read credentials are refused over the wire and the tool is not listed', async () => {
    const seen: { listed?: string[]; refused?: Rpc } = {}
    const w = world(async (input, mcp) => {
      if (input.threadId !== w.parent.id) return 'ok'
      seen.listed = (await rpc(mcp!, 'tools/list', {})).result!.tools!.map((tool) => tool.name)
      seen.refused = await w.create(mcp!, { clientRequestId: 'low' })
      return 'ok'
    }, 'read')
    await w.attach()
    await w.run(w.parent.id, GO, 'go')
    expect(seen.listed).not.toContain('thread_create')
    expect(seen.refused!.error).toMatchObject({ code: MCP_ERROR_CODES.mousse_scope_denied })
    expect(w.launchedBy(w.parent.id)).toEqual([])
  })
})
