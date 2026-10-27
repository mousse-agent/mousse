import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentDefinitionRegistry } from '../../src/mms/agentDefinitions/AgentDefinitionRegistry'
import { AgentResolver } from '../../src/mms/agentDefinitions/AgentResolver'
import { StaticAgentIntegrationLookup, StaticAgentModelLookup } from '../../src/mms/agentDefinitions/lookups'
import { AgentRegistry } from '../../src/mms/agents/AgentRegistry'
import { ProjectManager } from '../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../src/mms/data/ThreadDataStore'
import { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import { tryAcquireExecutionLease, releaseExecutionLeaseHandle } from '../../src/mms/queue/ThreadExecutionLease'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { RunEngine } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import { TaskQueue } from '../../src/mms/tasks/TaskQueue'
import { PtyManager } from '../../src/mms/terminals/PtyManager'
import { WorktreeManager } from '../../src/mms/worktree/WorktreeManager'
import { defaultAgentSettings } from '../../src/shared/agents/defaults'
import type { AgentExecutionRequest, AgentRuntimeToolApprovalCallback } from '../../src/shared/agents/execution'
import type { AgentRuntimeKind, ResolvedAgentDefinition } from '../../src/shared/agents/types'
import { getDefaultSettings } from '../../src/shared/settings'
import { providerResponse } from '../fixtures/agent-platform/agent-runtime-policy/helpers'
import { APPROVAL_ONLY_INSTANCE } from '../fixtures/agent-platform/exactDefinitionRuntime'
import { createDefinitionEngine, DEFINITION_ENGINES, ENGINE_MODEL, FAKE_KEY, type DefinitionEngine } from '../fixtures/agent-platform/definitionEngines'
import type { Harness } from '../../src/mms/harness/gateway'
import type { ProviderAdapter } from '../../src/mms/run/adapters/ProviderAdapter'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'

// PR 4 §6 / §16 `definitionService`, through the real AgentExecutionService, orchestrator, gateway
// and run engine, on each runtime that holds definitions: the real legacy Pi engine (where they run
// today, its transport at a local recorder with a fake key) and a stand-in for a runtime with its
// own loop that earned `exact`. The Claude Code-like instance only asks for approval, as Claude
// Code, Codex and Pi RPC do today.

const PROVIDER = 'fixture'
const MODEL = ENGINE_MODEL
const call = (name: string, args: Record<string, unknown>, id = `${name}-1`) => providerResponse([{ type: 'toolCall', id, name, arguments: args }], 'toolUse')
const say = (text: string) => providerResponse([{ type: 'text', text }], 'stop')

describe.each(DEFINITION_ENGINES)('definitions through the gateway (%s)', (kind) => {
  let home: string
  let work: string
  let engine: RunEngine
  let orch: OrchestratorService
  let store: ThreadDataStore
  let registry: AgentDefinitionRegistry
  let resolver: AgentResolver
  let defs: DefinitionEngine
  let harness: Harness
  const profileId = 'profile-defs'

  beforeEach(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-defsvc-')))
    process.env.MOUSSE_HOME = home
    work = join(home, 'work')
    mkdirSync(work)
    store = new ThreadDataStore(new ProjectManager())
    defs = await createDefinitionEngine(kind, [PROVIDER])
    const settings = getDefaultSettings()
    settings.integrations.skills.enabled = false
    orch = new OrchestratorService(new AgentRegistry(), new TaskQueue(), new WorktreeManager(home), new PtyManager(), { get: () => settings } as never, defs.providerAuth)
    orch.setThreadStore(store)
    engine = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome: home })) })
    orch.setRunEngine(engine)
    harness = defs.install(orch, home)
    registry = new AgentDefinitionRegistry({ profileId, profileRoot: join(home, 'profile') })
    const integrations = new StaticAgentIntegrationLookup({ builtinToolIds: ['read', 'write', 'ask_user', 'bash'] })
    const entry = (instanceId?: string) => ({ ref: { providerId: PROVIDER, modelId: MODEL, ...(instanceId ? { instanceId } : {}) }, available: true, efforts: [], speeds: [], contexts: [], capabilities: ['tools'], unavailableReasons: [] })
    resolver = new AgentResolver({ registry, integrationLookup: integrations, modelLookup: new StaticAgentModelLookup([entry(), entry(`pi:${PROVIDER}`), entry(APPROVAL_ONLY_INSTANCE), entry('stubborn')] as never) })
  })

  afterEach(async () => {
    orch.setRunEngine(null)
    engine.store.db.close()
    harness.stop()
    await defs.close()
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  function publish(runtimeKind: AgentRuntimeKind, instanceId: string, mutate: (settings: ReturnType<typeof defaultAgentSettings>) => void = () => {}) {
    const settings = defaultAgentSettings({ name: 'Reviewer', slug: `reviewer-${runtimeKind}-${instanceId.replace(/\W/g, '')}` })
    settings.primaryModel.ref = { providerId: PROVIDER, modelId: MODEL, instanceId }
    settings.tools = { mode: 'explicit', allowlist: ['read', 'write', 'ask_user'] }
    mutate(settings)
    const draft = registry.createDraft({ runtimeKind, settings, systemPrompt: 'DEFINITION_SYSTEM_PROMPT' })
    const published = registry.publish(draft.id, draft.draftHash, { integrationLookup: new StaticAgentIntegrationLookup({ builtinToolIds: ['read', 'write', 'ask_user', 'bash'] }) })
    return { id: draft.id, revision: published.revision }
  }

  function request(resolved: ResolvedAgentDefinition, threadId: string, extra: Partial<AgentExecutionRequest> = {}): AgentExecutionRequest {
    return {
      profileId, resolved, threadId, projectPath: work, input: 'review the work', source: 'editor',
      host: { workspaceRoots: [work], ...extra.host },
      context: { profileId, threadId, definitionId: resolved.definitionId, history: [], selectedFiles: [], memory: { scope: resolved.settings.memory.scope, entries: [] } },
      ...extra
    } as AgentExecutionRequest
  }

  function revisionBytes(revision: string): Map<string, string> {
    const files = new Map<string, string>()
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (path.includes(revision)) files.set(path, readFileSync(path, 'utf8'))
      }
    }
    walk(join(home, 'profile'))
    return files
  }

  it('refuses a stored Claude Code-kind definition on an instance that only asks for approval, with pointers', async () => {
    const stored = publish('claude-code', APPROVAL_ONLY_INSTANCE)
    const before = revisionBytes(stored.revision)
    const resolved = resolver.resolve({ definitionId: stored.id, revision: stored.revision })
    const thread = store.createThread('refused')
    const result = await orch.runAgentDefinition(request(resolved, thread.id))
    expect(result).toMatchObject({ status: 'failed', runtimeKind: 'claude-code', error: { code: 'SETTINGS_UNSUPPORTED' } })
    expect(result.error!.message).toMatch(/can't enforce this agent's workspace and tool limits/)
    expect(result.error!.details).toMatchObject({ code: 'policy_unenforceable', missing: ['toolControl'], pointers: ['/settings/tools/mode', '/settings/workspace/mode'] })
    // Nothing ran: no turn, no run record.
    expect(defs.turns).toEqual([])
    expect(engine.listRuns(thread.id)).toEqual([])
    expect(revisionBytes(stored.revision)).toEqual(before)
  })

  it('runs the same stored kind on a runtime that holds definitions, with its own session, instructions, grants and limits', async () => {
    const stored = publish('claude-code', `pi:${PROVIDER}`)
    const before = revisionBytes(stored.revision)
    expect(before.size).toBeGreaterThan(0)
    const resolved = resolver.resolve({ definitionId: stored.id, revision: stored.revision })
    const thread = store.createThread('runs')
    defs.outputs.push(say('reviewed'))
    const result = await orch.runAgentDefinition(request(resolved, thread.id))
    expect(result).toMatchObject({ status: 'completed', text: 'reviewed', runtimeKind: 'claude-code' })
    const [{ input, host }] = defs.turns
    expect(input).toMatchObject({ session: 'ephemeral', instructions: { placement: 'replace' }, instanceId: `pi:${PROVIDER}`, cwd: work, prompt: 'review the work' })
    expect(input.instructions!.text).toContain('DEFINITION_SYSTEM_PROMPT')
    expect(host.definition?.grants).toEqual(resolved.grants)
    expect(host.bridge?.toolPolicy?.allow).toEqual(['ask_user', 'read', 'write'])
    // The run is recorded, with the definition's policy on its binding; the stored revision is untouched.
    const runs = engine.listRuns(thread.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ source: 'definition', status: 'completed' })
    expect(engine.bindingForRun(runs[0]!.runId)?.policy).toEqual({
      mode: 'default', origin: 'definition', approvals: 'grants', tools: { allow: ['ask_user', 'read', 'write'] }, budget: { maxTurns: 32, maxToolCalls: 64 },
      authority: { kind: 'definition', digest: expect.stringMatching(/^[0-9a-f]{64}$/) }
    })
    expect(engine.bindingForRun(runs[0]!.runId)?.policyDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(revisionBytes(stored.revision)).toEqual(before)
    // The definition's own system prompt and only its granted tools reach the model.
    expect(defs.captured[0]!.systemPrompt).toContain('DEFINITION_SYSTEM_PROMPT')
    expect(defs.captured[0]!.tools!.map((tool) => tool.name)).not.toContain('bash')
    if (kind === 'legacy') expect(defs.requests[0]!.authorization).toBe(`Bearer ${FAKE_KEY}`)
    // The run took the thread's lease and gave it back.
    const lease = tryAcquireExecutionLease(store.getThreadDir(thread.id))
    expect(lease).not.toBeNull()
    releaseExecutionLeaseHandle(lease!)
  })

  it('holds inherited-but-denied tools, MCP tools and skills, path containment and askUser at the runtime', async () => {
    const stored = publish('mousse', `pi:${PROVIDER}`, (settings) => { settings.approval.askUser = false })
    const resolved = resolver.resolve({ definitionId: stored.id, revision: stored.revision })
    // As the resolver reports an inherited grant the profile denies: absent from the grants, listed in `denied`.
    resolved.grants.builtinTools = resolved.grants.builtinTools.filter((grant) => grant.id !== 'write')
    resolved.grants.denied.push(
      { kind: 'tool', id: 'write', reason: 'Turned off for this profile.' },
      { kind: 'mcp', id: 'srv/drop_table', reason: 'Turned off for this profile.' },
      { kind: 'skill', id: 'secret-skill', reason: 'Turned off for this profile.' }
    )
    const thread = store.createThread('denied')
    let actor: unknown
    const replies = [
      call('write', { path: 'denied.txt', content: 'x' }),
      call('mcp__srv__drop_table', {}),
      call('read', { path: '../outside.txt' }),
      call('ask_user', { questions: [{ id: 'q', prompt: 'May I?' }] }),
      say('done')
    ]
    defs.setNext(async () => {
      actor ??= orch.appToolTurns.get(defs.turns.at(-1)!.input.runId)?.actor
      return replies.shift()!
    })
    const result = await orch.runAgentDefinition(request(resolved, thread.id))
    expect(result.status).toBe('completed')
    const results = defs.captured.at(-1)!.messages.filter((message) => message.role === 'toolResult').map((message) => JSON.stringify(message.content))
    expect(results[0]).toMatch(/not granted/)
    expect(results[1]).toMatch(/not granted/)
    expect(results[2]).toContain('escaped allowed workspace roots')
    expect(results[3]).toContain('disabled by /settings/approval/askUser')
    expect(existsSync(join(work, 'denied.txt'))).toBe(false)
    expect(defs.turns.at(-1)!.host.bridge?.toolPolicy?.allow).not.toContain('write')
    expect(defs.captured.at(-1)!.tools!.map((tool) => tool.name)).not.toContain('write')
    expect((actor as { skillIds?: string[] }).skillIds ?? []).not.toContain('secret-skill')
  })

  it('holds the script rule and a read-only workspace even for granted tools', async () => {
    const stored = publish('mousse', `pi:${PROVIDER}`, (settings) => {
      settings.tools = { mode: 'explicit', allowlist: ['read', 'write', 'bash'] }
      settings.workspace.mode = 'read_only'
      settings.script.enabled = false
    })
    const resolved = resolver.resolve({ definitionId: stored.id, revision: stored.revision })
    expect(resolved.grants.builtinTools.map((grant) => grant.id)).toEqual(expect.arrayContaining(['write', 'bash']))
    const thread = store.createThread('script and read-only')
    defs.outputs.push(call('bash', { command: 'echo hi > script.txt' }), call('write', { path: 'ro.txt', content: 'x' }), say('done'))
    const result = await orch.runAgentDefinition(request(resolved, thread.id))
    expect(result.status).toBe('completed')
    const results = defs.captured.at(-1)!.messages.filter((message) => message.role === 'toolResult').map((message) => JSON.stringify(message.content))
    expect(results).toHaveLength(2)
    expect(results[0]).toContain('Workspace is read-only; bash is blocked by /settings/workspace/mode.')
    expect(results[1]).toContain('Workspace is read-only; write is blocked by /settings/workspace/mode.')
    expect(existsSync(join(work, 'ro.txt'))).toBe(false)
    // A writable workspace with scripts off still refuses a granted bash.
    const scripts = publish('mousse', `pi:${PROVIDER}`, (settings) => {
      settings.identity.slug = 'scripts-off'
      settings.tools = { mode: 'explicit', allowlist: ['read', 'write', 'bash'] }
      settings.script.enabled = false
    })
    defs.outputs.push(call('bash', { command: 'echo hi' }), say('done'))
    expect((await orch.runAgentDefinition(request(resolver.resolve({ definitionId: scripts.id, revision: scripts.revision }), store.createThread('scripts off').id))).status).toBe('completed')
    expect(JSON.stringify(defs.captured.at(-1)!.messages)).toContain('Script execution is disabled by /settings/script/enabled.')
  })

  it('applies the unattended policy without asking anyone', async () => {
    const approve = vi.fn<AgentRuntimeToolApprovalCallback>(async (approval) => ({ status: 'approved', digest: approval.argumentDigest }))
    for (const behavior of ['deny', 'skip', 'fail'] as const) {
      const stored = publish('mousse', `pi:${PROVIDER}`, (settings) => {
        settings.approval.policy = behavior === 'deny' ? 'unattended_deny' : 'inherit'
        settings.approval.unattendedBehavior = behavior === 'deny' ? 'pause' : behavior
        settings.identity.slug = `unattended-${behavior}`
      })
      const resolved = resolver.resolve({ definitionId: stored.id, revision: stored.revision })
      const thread = store.createThread(`unattended ${behavior}`)
      defs.outputs.push(call('write', { path: `${behavior}.txt`, content: 'x' }), say('ok'))
      const result = await orch.runAgentDefinition(request(resolved, thread.id, { source: 'schedule', host: { workspaceRoots: [work], approveToolRequest: approve } }))
      expect(result.status).toBe('completed')
      expect(JSON.stringify(defs.captured.at(-1)!.messages)).toMatch(/Unattended/)
      expect(existsSync(join(work, `${behavior}.txt`))).toBe(false)
    }
    expect(approve).not.toHaveBeenCalled()
  })

  it('runs an approved call with exactly the approved arguments, and refuses a stale digest', async () => {
    const stored = publish('mousse', `pi:${PROVIDER}`, (settings) => { settings.approval.policy = 'always' })
    const resolved = resolver.resolve({ definitionId: stored.id, revision: stored.revision })
    const approvals: string[] = []
    const approve: AgentRuntimeToolApprovalCallback = async (approval) => {
      approvals.push(approval.argumentDigest)
      // The first approval answers for other arguments than asked: stale, so refused.
      return approvals.length === 1 ? { status: 'approved', digest: '0'.repeat(64) } : { status: 'approved', digest: approval.argumentDigest }
    }
    const thread = store.createThread('approvals')
    defs.outputs.push(call('write', { path: 'stale.txt', content: 'stale' }, 'w1'), call('write', { path: 'approved.txt', content: 'exact bytes' }, 'w2'), say('ok'))
    const result = await orch.runAgentDefinition(request(resolved, thread.id, { host: { workspaceRoots: [work], approveToolRequest: approve } }))
    expect(result.status).toBe('completed')
    expect(approvals).toHaveLength(2)
    expect(existsSync(join(work, 'stale.txt'))).toBe(false)
    expect(readFileSync(join(work, 'approved.txt'), 'utf8')).toBe('exact bytes')
  })

  it('a definition run cut off by a restart ends interrupted at boot and is never resumed, so its counts are never needed again', async () => {
    const stored = publish('mousse', `pi:${PROVIDER}`)
    const resolved = resolver.resolve({ definitionId: stored.id, revision: stored.revision })
    const thread = store.createThread('restart')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    defs.setNext(async () => { await gate; return say('late') })
    const blocked = defs
    try {
      const pending = orch.runAgentDefinition(request(resolved, thread.id))
      await vi.waitFor(() => expect(blocked.turns).toHaveLength(1))
      // Its one turn ran with the default 32/64 limits on a first attempt of its own record.
      expect(engine.bindingForRun(blocked.turns[0]!.input.runId)?.policy.budget).toEqual({ maxTurns: 32, maxToolCalls: 64 })
      // The next daemon's boot: the record ends interrupted, and nothing is dispatched again.
      const rebooted = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome: home })) })
      rebooted.reconcileOnBoot()
      expect(rebooted.getRun(blocked.turns[0]!.input.runId)?.status).toBe('interrupted')
      rebooted.store.db.close()
      release()
      await pending
      expect(blocked.turns).toHaveLength(1)
    } finally {
      release()
    }
  })

  it('a Pi connection set to the new engine still runs definitions on the loop (no regression)', async () => {
    if (kind !== 'legacy') return
    harness.stop()
    harness = defs.install(orch, home, { engine: 'rpc' })
    // Its chats run on Pi RPC, which only asks for approval…
    expect(harness.resolveStored({ instanceId: `pi:${PROVIDER}`, llmProvider: PROVIDER, model: MODEL }, { purpose: 'turn' }).caps.toolControl).toBe('approval_only')
    // …while a definition, a workflow node, a chat reply or a dispatch runs on the loop, as on master.
    const stored = publish('mousse', `pi:${PROVIDER}`)
    const resolved = resolver.resolve({ definitionId: stored.id, revision: stored.revision })
    const thread = store.createThread('rpc engine')
    defs.outputs.push(call('write', { path: 'on-rpc-instance.txt', content: 'loop' }), say('ran on the loop'))
    const result = await orch.runAgentDefinition(request(resolved, thread.id))
    expect(result).toMatchObject({ status: 'completed', text: 'ran on the loop' })
    expect(readFileSync(join(work, 'on-rpc-instance.txt'), 'utf8')).toBe('loop')
    expect(defs.requests).toHaveLength(2)
    expect(engine.bindingForRun(engine.listRuns(thread.id)[0]!.runId)?.caps).toMatchObject({ toolControl: 'exact', definitionLimits: 'in_loop' })
  })

  for (const how of ['stopThread', 'abortRun'] as const) {
    it(`a public Stop (${how}) ends the definition run: no tool after it, cancelled, and its record interrupted`, async () => {
      const stored = publish('mousse', `pi:${PROVIDER}`)
      const resolved = resolver.resolve({ definitionId: stored.id, revision: stored.revision })
      const thread = store.createThread(`stop ${how}`)
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      defs.setNext(async () => { await gate; return call('write', { path: 'after-stop.txt', content: 'x' }) })
      const pending = orch.runAgentDefinition(request(resolved, thread.id))
      await vi.waitFor(() => expect(defs.captured).toHaveLength(1))
      const runId = engine.listRuns(thread.id)[0]!.runId
      if (how === 'stopThread') expect((await orch.stopThread(thread.id, 'user')).ok).toBe(true)
      else expect(await orch.abortRun(runId, 'stop-1')).toMatchObject({ status: 'accepted' })
      release()
      const result = await pending
      expect(result.status).toBe('cancelled')
      expect(existsSync(join(work, 'after-stop.txt'))).toBe(false)
      expect(engine.getRun(runId)?.status).toBe('interrupted')
    })
  }

  it('beats for its run while the model is quiet, so the reconciler leaves a live definition alone', async () => {
    const { Reconciler } = await import('../../src/mms/run/reconciler')
    let clock = Date.now()
    const now = () => new Date(clock).toISOString()
    const timed = new RunEngine({ store: engine.store, now })
    orch.setRunEngine(timed)
    ;(orch as unknown as { definitionHeartbeatMs: number }).definitionHeartbeatMs = 20
    const stored = publish('mousse', `pi:${PROVIDER}`)
    const resolved = resolver.resolve({ definitionId: stored.id, revision: stored.revision })
    const thread = store.createThread('quiet model')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    defs.setNext(async () => { await gate; return say('late answer') })
    const pending = orch.runAgentDefinition(request(resolved, thread.id))
    try {
      await vi.waitFor(() => expect(defs.turns).toHaveLength(1))
      const runId = timed.listRuns(thread.id)[0]!.runId
      // 15 s of silence, a beat, then 15 s more: 30 s since the start, 15 s since the last beat.
      clock += 15_000
      await vi.waitFor(() => expect(timed.getRun(runId)?.heartbeatAt).toBe(now()))
      clock += 15_000
      new Reconciler({ store: timed.store, outbox: timed.outbox, tools: timed.tools, now }).runOnce()
      expect(timed.getRun(runId)?.status).toBe('running')
    } finally {
      release()
    }
    expect((await pending).status).toBe('completed')
  })

  it('a turn whose run was ended elsewhere stops and never reports an answer', async () => {
    const stored = publish('mousse', `pi:${PROVIDER}`)
    const resolved = resolver.resolve({ definitionId: stored.id, revision: stored.revision })
    const thread = store.createThread('lost run')
    ;(orch as unknown as { definitionHeartbeatMs: number }).definitionHeartbeatMs = 20
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    defs.setNext(async () => { await gate; return call('write', { path: 'after-loss.txt', content: 'x' }) })
    const pending = orch.runAgentDefinition(request(resolved, thread.id))
    await vi.waitFor(() => expect(defs.turns).toHaveLength(1))
    const runId = engine.listRuns(thread.id)[0]!.runId
    engine.markTerminal(runId, 'interrupted', { interruptedBy: 'provider', error: 'no terminal event' })
    await new Promise((resolve) => setTimeout(resolve, 60))
    release()
    expect((await pending).status).toBe('cancelled')
    expect(existsSync(join(work, 'after-loss.txt'))).toBe(false)
  })

  it('a definition marker alone never admits an ordinary turn, whatever its origin', async () => {
    const noop = () => {}
    const sink = { text: noop, thinking: noop, tool: noop, nativeMessages: noop, compaction: noop, retry: noop, progress: noop, usage: noop, providerRef: noop, steerAccepted: noop, providerMetrics: noop, lineEdits: noop }
    for (const origin of ['interactive', 'bot', 'schedule', 'definition'] as const) {
      const resolved = harness.resolveStored({ instanceId: `pi:${PROVIDER}`, llmProvider: PROVIDER, model: MODEL }, { purpose: 'turn', definition: true })
      const binding = await harness.bind(resolved, { mode: 'agent', origin, policy: { approvals: 'grants', tools: { allow: ['read'] }, authority: { kind: 'definition', digest: 'd'.repeat(64) }, budget: { maxTurns: 0, maxInputTokens: 0, maxOutputTokens: 0, maxUsd: 0 } } })
      defs.outputs.push(say('unbudgeted plain chat'))
      const threadId = store.createThread(origin).id
      const turn = harness.startTurn({
        binding,
        input: { runId: `foreign-${origin}`, attemptId: `foreign-${origin}:1`, threadId, cwd: work, model: binding.model, instanceId: binding.instanceId, llmProvider: PROVIDER, modelPinned: true, mode: 'agent', prompt: 'plain', messages: [{ role: 'user', content: 'plain', timestamp: Date.now() }], signal: new AbortController().signal },
        sink, control: { drainSteer: () => undefined, heartbeat: noop },
        host: { tools: {}, context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: () => '' } },
        app: { turnToken: 't', modeCeiling: 'default', mcpEligible: false, instructions: () => ({ sessionInstructions: '', turnPreamble: '' }) }
      })
      await expect(turn.result).rejects.toMatchObject({ code: 'policy_unenforceable' })
    }
    expect(defs.turns).toEqual([])
    if (kind === 'legacy') expect(defs.requests).toEqual([])
  })

  it('runs granted tools under the host writer and records them in the run ledger', async () => {
    const stored = publish('mousse', `pi:${PROVIDER}`)
    const resolved = resolver.resolve({ definitionId: stored.id, revision: stored.revision })
    // A writer the run lost: the write never happens.
    const lost = vi.fn(async () => { throw new Error('writer authority lost') })
    defs.outputs.push(call('write', { path: 'no-writer.txt', content: 'bypassed' }), say('done'))
    const refused = await orch.runAgentDefinition(request(resolved, store.createThread('writer').id, { host: { workspaceRoots: [work], writer: lost } as never }))
    expect(refused.status).toBe('completed')
    expect(lost).toHaveBeenCalled()
    expect(existsSync(join(work, 'no-writer.txt'))).toBe(false)
    // The lease's own writer runs it, and the run's ledger has the call.
    const thread = store.createThread('ledger')
    defs.outputs.push(call('write', { path: 'ledgered.txt', content: 'x' }), say('done'))
    const ledgered = await orch.runAgentDefinition(request(resolved, thread.id))
    expect(ledgered.error).toBeUndefined()
    expect(ledgered.status).toBe('completed')
    expect(readFileSync(join(work, 'ledgered.txt'), 'utf8')).toBe('x')
    if (kind === 'legacy') expect(engine.tools.listForRun(engine.listRuns(thread.id)[0]!.runId).map((tool) => [tool.tool, tool.status])).toEqual([['write', 'committed']])
  })

  it('a definition that reaches its limit fails, in its result and its run record alike', async () => {
    if (kind !== 'legacy') return
    const stored = publish('mousse', `pi:${PROVIDER}`, (settings) => { settings.limits.maxTurns = 1 })
    const resolved = resolver.resolve({ definitionId: stored.id, revision: stored.revision })
    const thread = store.createThread('limited')
    defs.outputs.push(call('write', { path: 'limited.txt', content: 'side effect' }))
    const result = await orch.runAgentDefinition(request(resolved, thread.id))
    expect(result).toMatchObject({ status: 'failed', error: { code: 'BUDGET_EXCEEDED', details: { limit: { kind: 'turns', limit: 1 } } } })
    expect(engine.listRuns(thread.id)[0]!.status).toBe('failed')
    expect(result.usage.totalTokens).toBeGreaterThan(0)
  })

  it('a message queued on the thread during a definition runs once the definition releases it', async () => {
    const stored = publish('mousse', `pi:${PROVIDER}`)
    const resolved = resolver.resolve({ definitionId: stored.id, revision: stored.revision })
    const thread = store.createThread('queue drain')
    orch.setThreadModelOverride(thread.id, { instanceId: `pi:${PROVIDER}`, llmProvider: PROVIDER, model: MODEL })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    defs.setNext(async () => { await gate; return say('definition done') })
    const pending = orch.runAgentDefinition(request(resolved, thread.id))
    await vi.waitFor(() => expect(defs.turns).toHaveLength(1))
    const sent = await orch.send('queued composer', false, { threadId: thread.id, awaitMode: 'ack' })
    expect(sent.queued).toBe(true)
    defs.setNext(async () => say('composer reply'))
    release()
    expect((await pending).status).toBe('completed')
    await vi.waitFor(() => expect(orch.listQueue(thread.id)).toEqual([]), { timeout: 5_000, interval: 25 })
    await vi.waitFor(() => expect(defs.turns.map((turn) => turn.input.prompt)).toContain('queued composer'), { timeout: 5_000, interval: 25 })
  })

  it('the gateway ends a definition turn whose runtime ignores the time budget', async () => {
    harness.stop()
    // A runtime that holds definitions but only stops when interrupted, never on its signal.
    let finish: ((aborted: boolean) => void) | undefined
    const stubborn: ProviderAdapter = {
      driver: 'codex',
      capabilities: { steer: 'none', interrupt: true, rollback: 'none', fork: 'portable', events: 'rich', containment: 'strong', historyInjection: 'prompt', mcp: true, childPolicy: 'enforced' },
      configured: () => true,
      startTurn: (input, sink) => new Promise((resolve) => {
        sink.providerRef({ provider: 'p', instanceId: input.instanceId, model: input.model })
        finish = (aborted) => resolve({ text: '', aborted, modelName: input.model, totalResponseTimeMs: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextSignature: 's', nativeMessages: [], providerRef: { provider: 'p' } })
      }),
      interrupt: async () => { finish?.(true); return 'interrupted' }
    }
    let stored: unknown = { stubborn: { driver: 'codex', enabled: true } }
    harness = testHarness({ drivers: [adapterDriver(stubborn, { toolControl: 'exact', budgets: 'hard' })], instances: new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (state) => { stored = state.instances } } }), profileHome: home })
    orch.setHarness(harness)
    const definition = publish('mousse', 'stubborn', (settings) => { settings.limits.maxElapsedMs = 200 })
    const resolved = resolver.resolve({ definitionId: definition.id, revision: definition.revision })
    const result = await orch.runAgentDefinition(request(resolved, store.createThread('deadline').id))
    expect(result).toMatchObject({ status: 'failed', error: { code: 'BUDGET_EXCEEDED', details: { limit: { kind: 'elapsed_ms', limit: 200 } } } })
  })

  it('an owned lease that another holds fails the turn as busy, and never queues it', async () => {
    const stored = publish('mousse', `pi:${PROVIDER}`)
    const resolved = resolver.resolve({ definitionId: stored.id, revision: stored.revision })
    const thread = store.createThread('busy')
    const held = tryAcquireExecutionLease(store.getThreadDir(thread.id), { source: 'test' })!
    try {
      defs.outputs.push(say('must not run'))
      const result = await orch.runAgentDefinition(request(resolved, thread.id))
      expect(result).toMatchObject({ status: 'failed' })
      expect(result.error!.message).toMatch(/running other work/)
      expect(defs.turns).toEqual([])
      expect(orch.listQueue(thread.id)).toEqual([])
    } finally {
      releaseExecutionLeaseHandle(held)
    }
  })
})
