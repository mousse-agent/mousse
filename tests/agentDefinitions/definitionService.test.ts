import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage, Context } from '@earendil-works/pi-ai'
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
import { APPROVAL_ONLY_INSTANCE, installExactDefinitionRuntime, type ExactRuntime } from '../fixtures/agent-platform/exactDefinitionRuntime'

// PR 4 §6 / §16 `definitionService`, through the real AgentExecutionService, orchestrator, gateway
// and run engine. The exact runtime is a stand-in (no production runtime declares `exact` yet); the
// Claude Code-like instance only asks for approval, as Claude Code, Codex and Pi RPC do today.

const PROVIDER = 'fixture'
const MODEL = 'fixture-model'
const call = (name: string, args: Record<string, unknown>, id = `${name}-1`) => providerResponse([{ type: 'toolCall', id, name, arguments: args }], 'toolUse')
const say = (text: string) => providerResponse([{ type: 'text', text }], 'stop')

describe('definitions through the gateway', () => {
  let home: string
  let work: string
  let engine: RunEngine
  let orch: OrchestratorService
  let store: ThreadDataStore
  let registry: AgentDefinitionRegistry
  let resolver: AgentResolver
  let runtime: ExactRuntime
  let outputs: AssistantMessage[]
  let captured: Context[]
  const profileId = 'profile-defs'

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-defsvc-')))
    process.env.MOUSSE_HOME = home
    work = join(home, 'work')
    mkdirSync(work)
    store = new ThreadDataStore(new ProjectManager())
    orch = new OrchestratorService(new AgentRegistry(), new TaskQueue(), new WorktreeManager(home), new PtyManager(), { get: () => getDefaultSettings() } as never, {} as never)
    orch.setThreadStore(store)
    engine = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome: home })) })
    orch.setRunEngine(engine)
    outputs = []
    captured = []
    runtime = installExactDefinitionRuntime({ orchestrator: orch, providerId: PROVIDER, profileHome: home, captured, outputs })
    registry = new AgentDefinitionRegistry({ profileId, profileRoot: join(home, 'profile') })
    const integrations = new StaticAgentIntegrationLookup({ builtinToolIds: ['read', 'write', 'ask_user', 'bash'] })
    const entry = (instanceId?: string) => ({ ref: { providerId: PROVIDER, modelId: MODEL, ...(instanceId ? { instanceId } : {}) }, available: true, efforts: [], speeds: [], contexts: [], capabilities: ['tools'], unavailableReasons: [] })
    resolver = new AgentResolver({ registry, integrationLookup: integrations, modelLookup: new StaticAgentModelLookup([entry(), entry(`pi:${PROVIDER}`), entry(APPROVAL_ONLY_INSTANCE)] as never) })
  })

  afterEach(() => {
    orch.setRunEngine(null)
    engine.store.db.close()
    runtime.harness.stop()
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
    expect(runtime.turns).toEqual([])
    expect(engine.listRuns(thread.id)).toEqual([])
    expect(revisionBytes(stored.revision)).toEqual(before)
  })

  it('runs the same stored kind when its model is on an exact instance, with its own session, instructions, grants and limits', async () => {
    const stored = publish('claude-code', `pi:${PROVIDER}`)
    const before = revisionBytes(stored.revision)
    expect(before.size).toBeGreaterThan(0)
    const resolved = resolver.resolve({ definitionId: stored.id, revision: stored.revision })
    const thread = store.createThread('runs')
    outputs.push(say('reviewed'))
    const result = await orch.runAgentDefinition(request(resolved, thread.id))
    expect(result).toMatchObject({ status: 'completed', text: 'reviewed', runtimeKind: 'claude-code' })
    const [{ input, host }] = runtime.turns
    expect(input).toMatchObject({ session: 'ephemeral', instructions: { placement: 'replace' }, instanceId: `pi:${PROVIDER}`, cwd: work, prompt: 'review the work' })
    expect(input.instructions!.text).toContain('DEFINITION_SYSTEM_PROMPT')
    expect(host.definition?.grants).toEqual(resolved.grants)
    expect(host.bridge?.toolPolicy?.allow).toEqual(['ask_user', 'read', 'write'])
    // The run is recorded, with the definition's policy on its binding; the stored revision is untouched.
    const runs = engine.listRuns(thread.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ source: 'definition', status: 'completed' })
    expect(engine.bindingForRun(runs[0]!.runId)?.policy).toEqual({
      mode: 'default', origin: 'definition', approvals: 'grants', tools: { allow: ['ask_user', 'read', 'write'] }, budget: { maxTurns: 32, maxToolCalls: 64 }
    })
    expect(revisionBytes(stored.revision)).toEqual(before)
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
    runtime.adapter.startTurn = ((original) => async (...args: Parameters<typeof original>) => {
      actor = orch.appToolTurns.get(args[0].runId)?.actor
      return original(...args)
    })(runtime.adapter.startTurn.bind(runtime.adapter))
    outputs.push(
      call('write', { path: 'denied.txt', content: 'x' }),
      call('mcp__srv__drop_table', {}),
      call('read', { path: '../outside.txt' }),
      call('ask_user', { questions: [{ id: 'q', prompt: 'May I?' }] }),
      say('done')
    )
    const result = await orch.runAgentDefinition(request(resolved, thread.id))
    expect(result.status).toBe('completed')
    const results = captured.at(-1)!.messages.filter((message) => message.role === 'toolResult').map((message) => JSON.stringify(message.content))
    expect(results[0]).toContain('not granted')
    expect(results[1]).toContain('not granted')
    expect(results[2]).toContain('escaped allowed workspace roots')
    expect(results[3]).toContain('disabled by /settings/approval/askUser')
    expect(existsSync(join(work, 'denied.txt'))).toBe(false)
    expect(host(runtime).bridge?.toolPolicy?.allow).not.toContain('write')
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
    outputs.push(call('bash', { command: 'echo hi > script.txt' }), call('write', { path: 'ro.txt', content: 'x' }), say('done'))
    const result = await orch.runAgentDefinition(request(resolved, thread.id))
    expect(result.status).toBe('completed')
    const results = captured.at(-1)!.messages.filter((message) => message.role === 'toolResult').map((message) => JSON.stringify(message.content))
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
    outputs.push(call('bash', { command: 'echo hi' }), say('done'))
    expect((await orch.runAgentDefinition(request(resolver.resolve({ definitionId: scripts.id, revision: scripts.revision }), store.createThread('scripts off').id))).status).toBe('completed')
    expect(JSON.stringify(captured.at(-1)!.messages)).toContain('Script execution is disabled by /settings/script/enabled.')
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
      outputs.push(call('write', { path: `${behavior}.txt`, content: 'x' }), say('ok'))
      const result = await orch.runAgentDefinition(request(resolved, thread.id, { source: 'schedule', host: { workspaceRoots: [work], approveToolRequest: approve } }))
      expect(result.status).toBe('completed')
      expect(JSON.stringify(captured.at(-1)!.messages)).toMatch(/Unattended/)
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
    outputs.push(call('write', { path: 'stale.txt', content: 'stale' }, 'w1'), call('write', { path: 'approved.txt', content: 'exact bytes' }, 'w2'), say('ok'))
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
    const blocked = installExactDefinitionRuntime({ orchestrator: orch, providerId: PROVIDER, profileHome: home, captured, next: async () => { await gate; return say('late') } })
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
      blocked.harness.stop()
    }
  })

  it('an owned lease that another holds fails the turn as busy, and never queues it', async () => {
    const stored = publish('mousse', `pi:${PROVIDER}`)
    const resolved = resolver.resolve({ definitionId: stored.id, revision: stored.revision })
    const thread = store.createThread('busy')
    const held = tryAcquireExecutionLease(store.getThreadDir(thread.id), { source: 'test' })!
    try {
      outputs.push(say('must not run'))
      const result = await orch.runAgentDefinition(request(resolved, thread.id))
      expect(result).toMatchObject({ status: 'failed' })
      expect(result.error!.message).toMatch(/running other work/)
      expect(runtime.turns).toEqual([])
      expect(orch.listQueue(thread.id)).toEqual([])
    } finally {
      releaseExecutionLeaseHandle(held)
    }
  })
})

function host(runtime: ExactRuntime) {
  return runtime.turns.at(-1)!.host
}
