import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentDefinitionRegistry } from '../../src/mms/agentDefinitions/AgentDefinitionRegistry'
import { AgentResolver } from '../../src/mms/agentDefinitions/AgentResolver'
import { definitionCheckIssues } from '../../src/mms/agentDefinitions/definitionRuntime'
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
import { createDefinitionEngine, ENGINE_MODEL, type DefinitionEngine } from '../fixtures/agent-platform/definitionEngines'
import type { Harness } from '../../src/mms/harness/gateway'
import type { ProviderAdapter } from '../../src/mms/harness/adapter'
import { harnessAppError } from '../../src/shared/harness/types'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import type { BrowserRuntimePort } from '../../src/shared/browser/runtime'

// PR 4 §6 / §16 `definitionService`, through the real AgentExecutionService, orchestrator, gateway
// and run engine, on a stand-in for Pi RPC with evidence (a runtime with its own loop that earned
// `exact`). The Claude Code-like instance only asks for approval, as Claude Code and Codex do.

const PROVIDER = 'fixture'
const MODEL = ENGINE_MODEL
/** A second provider, for a fallback on another model. */
const OTHER = 'other'
const call = (name: string, args: Record<string, unknown>, id = `${name}-1`) => providerResponse([{ type: 'toolCall', id, name, arguments: args }], 'toolUse')
const say = (text: string) => providerResponse([{ type: 'text', text }], 'stop')
const mcpServer = { bearerForTurn: () => ({ url: 'http://127.0.0.1:9/mcp', token: 'fake-bearer', tokenHash: 'fake-hash' }), turnEnded: () => undefined, revokeThread: () => {} }

describe('definitions through the gateway', () => {
  let home: string
  let work: string
  let engine: RunEngine
  let orch: OrchestratorService
  let store: ThreadDataStore
  let registry: AgentDefinitionRegistry
  let resolver: AgentResolver
  let defs: DefinitionEngine
  let harness: Harness
  let settings: ReturnType<typeof getDefaultSettings>
  const profileId = 'profile-defs'

  beforeEach(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-defsvc-')))
    process.env.MOUSSE_HOME = home
    work = join(home, 'work')
    mkdirSync(work)
    store = new ThreadDataStore(new ProjectManager())
    defs = await createDefinitionEngine([PROVIDER, OTHER])
    settings = getDefaultSettings()
    settings.integrations.skills.enabled = false
    orch = new OrchestratorService(new AgentRegistry(), new TaskQueue(), new WorktreeManager(home), new PtyManager(), { get: () => settings } as never, defs.providerAuth)
    orch.setThreadStore(store)
    engine = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome: home })) })
    orch.setRunEngine(engine)
    // A running Mousse MCP server: every turn gets a bearer (a definition's app tools need one).
    orch.setMcpAttachment(mcpServer)
    harness = defs.install(orch, home)
    registry = new AgentDefinitionRegistry({ profileId, profileRoot: join(home, 'profile') })
    const integrations = new StaticAgentIntegrationLookup({ builtinToolIds: ['read', 'write', 'edit', 'ask_user', 'bash', 'thread_read', 'git_status', 'git_diff'] })
    const entry = (instanceId?: string) => ({ ref: { providerId: PROVIDER, modelId: MODEL, ...(instanceId ? { instanceId } : {}) }, available: true, efforts: [], speeds: [], contexts: [], capabilities: ['tools'], unavailableReasons: [] })
    resolver = new AgentResolver({ registry, integrationLookup: integrations, modelLookup: new StaticAgentModelLookup([entry(), entry(`pi:${PROVIDER}`), entry(APPROVAL_ONLY_INSTANCE), entry('stubborn'), { ...entry(`pi:${OTHER}`), ref: { providerId: OTHER, modelId: MODEL, instanceId: `pi:${OTHER}` } }] as never) })
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
    const published = registry.publish(draft.id, draft.draftHash, { integrationLookup: new StaticAgentIntegrationLookup({ builtinToolIds: ['read', 'write', 'edit', 'ask_user', 'bash', 'thread_read', 'git_status', 'git_diff'] }) })
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

  it("the editor's check reports the gateway's refusal before anything runs: a primary blocks, a fallback is skipped", async () => {
    const issues = (instanceId: string, mutate?: (settings: ReturnType<typeof defaultAgentSettings>) => void, runtimeKind: AgentRuntimeKind = 'claude-code') => {
      const stored = publish(runtimeKind, instanceId, mutate)
      const resolved = resolver.resolve({ definitionId: stored.id, revision: stored.revision })
      return definitionCheckIssues(orch, { threadId: '', definition: { id: stored.id, revision: stored.revision }, settings: resolved.settings, grants: resolved.grants })
    }
    const refused = issues(APPROVAL_ONLY_INSTANCE)
    expect(refused.map((issue) => issue.pointer)).toEqual(['/settings/tools/mode', '/settings/workspace/mode'])
    expect(refused[0]).toMatchObject({ code: 'SETTINGS_UNSUPPORTED', details: { code: 'policy_unenforceable', missing: ['toolControl'] } })
    expect(refused[0]!.message).toMatch(/can't enforce this agent's workspace and tool limits/)
    expect(refused[0]!.details).not.toHaveProperty('blocking')
    // The same kind on a runtime that holds definitions: nothing to report.
    expect(issues(`pi:${PROVIDER}`)).toEqual([])
    // A fallback that cannot hold it is reported, without blocking: the run skips it.
    const fallback = issues(`pi:${PROVIDER}`, (settings) => {
      settings.fallbacks = { ...settings.fallbacks, enabled: true, allowHigherCost: true, models: [{ providerId: PROVIDER, modelId: MODEL, instanceId: APPROVAL_ONLY_INSTANCE }] }
    }, 'mousse')
    expect(fallback.length).toBeGreaterThan(0)
    expect(fallback.every((issue) => issue.details?.blocking === false && issue.details?.at === '/settings/fallbacks/models/0')).toBe(true)
    // Checking ran nothing.
    expect(defs.turns).toEqual([])
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
    // Held to the profile's agent access level, recorded on the run as any run's grant (SPEC §15.1).
    expect(runs[0]!.accessGrant).toBe((orch as unknown as { grantFor(id: string, ceiling: string): string }).grantFor(thread.id, 'default'))
    expect(engine.bindingForRun(runs[0]!.runId)?.policy).toEqual({
      mode: 'default', origin: 'definition', approvals: 'grants', tools: { allow: ['ask_user', 'read', 'write'] }, budget: { maxTurns: 32, maxToolCalls: 64 },
      authority: { kind: 'definition', digest: expect.stringMatching(/^[0-9a-f]{64}$/) },
      // The strictest permission mode: the definition's own approval rules decide its calls.
      permissionMode: 'ask'
    })
    expect(engine.bindingForRun(runs[0]!.runId)?.policyDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(revisionBytes(stored.revision)).toEqual(before)
    // The definition's own system prompt and only its granted tools reach the model.
    expect(defs.captured[0]!.systemPrompt).toContain('DEFINITION_SYSTEM_PROMPT')
    expect(defs.captured[0]!.tools!.map((tool) => tool.name)).not.toContain('bash')
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

  it("a definition's git reads stay in its roots on its runtime: a magic pathspec and the parent repository stay out", async () => {
    // A repository whose agent may use only `allowed`; `secret.txt` beside it is changed too.
    const top = join(home, 'repo')
    const allowed = join(top, 'allowed')
    mkdirSync(allowed, { recursive: true })
    const git = (...args: string[]) => execFileSync('git', args, { cwd: top, stdio: 'pipe' })
    git('init', '-q')
    git('config', 'user.email', 'test@example.invalid')
    git('config', 'user.name', 'Test')
    git('config', 'commit.gpgsign', 'false')
    writeFileSync(join(top, 'secret.txt'), 'old\n')
    writeFileSync(join(allowed, 'a.txt'), 'one\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    writeFileSync(join(top, 'secret.txt'), 'TOP SECRET OUTSIDE ROOT\n')
    writeFileSync(join(allowed, 'a.txt'), 'two\n')
    const stored = publish('mousse', `pi:${PROVIDER}`, (settings) => {
      settings.tools = { mode: 'explicit', allowlist: ['git_status', 'git_diff'] }
      settings.workspace.mode = 'read_only'
      settings.script.enabled = false
    })
    const resolved = resolver.resolve({ definitionId: stored.id, revision: stored.revision })
    const thread = store.createThread('git-roots')
    const replies = [call('git_diff', { path: ':(top)secret.txt' }), call('git_status', {}, 'git_status-1'), call('git_diff', { path: 'a.txt' }, 'git_diff-2'), say('done')]
    defs.setNext(async () => replies.shift()!)
    const result = await orch.runAgentDefinition(request(resolved, thread.id, { projectPath: allowed, host: { workspaceRoots: [allowed] } }))
    expect(result.status).toBe('completed')
    const results = defs.captured.at(-1)!.messages.filter((message) => message.role === 'toolResult').map((message) => JSON.stringify(message.content))
    expect(results).toHaveLength(3)
    expect(results.join('\n')).not.toContain('TOP SECRET')
    expect(results[1]).not.toContain('secret.txt')
    expect(results[1]).toContain('a.txt')
    expect(results[2]).toContain('+two')
  })

  it("a definition's file tools never change Git metadata: the reviewers' hook, alternates and planted .git writes are refused on its runtime", async () => {
    const top = join(home, 'meta-repo')
    mkdirSync(top)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: top, stdio: 'pipe' })
    git('init', '-q')
    git('config', 'user.email', 'test@example.invalid')
    git('config', 'user.name', 'Test')
    git('config', 'commit.gpgsign', 'false')
    writeFileSync(join(top, 'a.txt'), 'one\n')
    git('add', 'a.txt')
    git('commit', '-q', '-m', 'init')
    mkdirSync(join(top, 'sub'))
    const configBefore = readFileSync(join(top, '.git', 'config'), 'utf8')
    const stored = publish('mousse', `pi:${PROVIDER}`, (settings) => {
      settings.tools = { mode: 'explicit', allowlist: ['write', 'edit', 'git_diff'] }
      settings.script.enabled = false
    })
    const resolved = resolver.resolve({ definitionId: stored.id, revision: stored.revision })
    const thread = store.createThread('git-metadata')
    const replies = [
      call('write', { path: '.git/config', content: `${configBefore}[hook "evil"]\n\tcommand = echo ran\n\tevent = post-index-change\n` }, 'w1'),
      call('write', { path: '.git/objects/info/alternates', content: '/elsewhere/.git/objects\n' }, 'w2'),
      call('write', { path: 'sub/.git', content: 'gitdir: /elsewhere/.git\n' }, 'w3'),
      // Forms Pi's tools expand before they open the path: the gate checks the path Pi opens.
      call('write', { path: '@.git/config', content: 'planted\n' }, 'w5'),
      call('write', { path: '@.git/objects/info/alternates', content: '/elsewhere/.git/objects\n' }, 'w6'),
      call('edit', { path: '@.git/config', edits: [{ oldText: '[core]', newText: '[core]\n\tfsmonitor = planted' }] }, 'e1'),
      call('write', { path: '~/escaped.txt', content: 'out\n' }, 'w7'),
      call('write', { path: '@~/escaped.txt', content: 'out\n' }, 'w8'),
      call('write', { path: 'ok.txt', content: 'fine\n' }, 'w4'),
      say('done')
    ]
    defs.setNext(async () => replies.shift()!)
    // Pi expands `~` to the home folder: a test one, so nothing could reach the real one.
    const fakeHome = join(home, 'fake-home')
    mkdirSync(fakeHome)
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
    let result: Awaited<ReturnType<typeof orch.runAgentDefinition>>
    try {
      result = await orch.runAgentDefinition(request(resolved, thread.id, { projectPath: top, host: { workspaceRoots: [top] } }))
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    expect(result.status).toBe('completed')
    const results = defs.captured.at(-1)!.messages.filter((message) => message.role === 'toolResult').map((message) => JSON.stringify(message.content))
    expect(results).toHaveLength(9)
    for (const text of results.slice(0, 3)) expect(text).toMatch(/cannot change Git metadata/)
    expect(existsSync(join(fakeHome, 'escaped.txt'))).toBe(false)
    expect(readFileSync(join(top, '.git', 'config'), 'utf8')).toBe(configBefore)
    expect(existsSync(join(top, '.git', 'objects', 'info', 'alternates'))).toBe(false)
    expect(existsSync(join(top, 'sub', '.git'))).toBe(false)
    expect(readFileSync(join(top, 'ok.txt'), 'utf8')).toBe('fine\n')
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
    const { Reconciler } = await import('../../src/mms/run/Reconciler')
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
  })

  it('runs granted tools under the host writer', async () => {
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
  })

  it('a definition that reaches its limit fails, in its result and its run record alike', async () => {
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

  it('a run that ends while its approval is pending runs nothing after the approval, and reports no answer', async () => {
    // The runtime's gate checks the run is still active after the approval, as Pi's does.
    const stored = publish('mousse', `pi:${PROVIDER}`, (settings) => { settings.approval.policy = 'always' })
    const resolved = resolver.resolve({ definitionId: stored.id, revision: stored.revision })
    const thread = store.createThread('ended during approval')
    // The approval is answered right after the run was ended elsewhere, well before any heartbeat.
    const approve: AgentRuntimeToolApprovalCallback = async (approval) => {
      const runId = engine.listRuns(thread.id)[0]!.runId
      engine.markTerminal(runId, 'interrupted', { interruptedBy: 'provider', error: 'no terminal event' })
      return { status: 'approved', digest: approval.argumentDigest }
    }
    defs.outputs.push(call('write', { path: 'after-end-in-approval.txt', content: 'x' }), say('done'))
    const result = await orch.runAgentDefinition(request(resolved, thread.id, { host: { workspaceRoots: [work], approveToolRequest: approve } }))
    expect(existsSync(join(work, 'after-end-in-approval.txt'))).toBe(false)
    expect(result.status).toBe('cancelled')
    expect(result.text).toBe('')
    expect(engine.listRuns(thread.id)[0]!.status).toBe('interrupted')
  })

  it('a message queued during a failed primary waits for the fallback, which keeps the thread, then runs once', async () => {
    const stored = publish('mousse', `pi:${PROVIDER}`, (settings) => {
      settings.fallbacks = { enabled: true, models: [{ providerId: OTHER, modelId: MODEL, instanceId: `pi:${OTHER}` }], retryOn: [], allowHigherCost: true }
      settings.recovery.retryCount = 0
      settings.recovery.backoffMs = 250
    })
    const resolved = resolver.resolve({ definitionId: stored.id, revision: stored.revision })
    const thread = store.createThread('queue across fallback')
    orch.setThreadModelOverride(thread.id, { instanceId: `pi:${PROVIDER}`, llmProvider: PROVIDER, model: MODEL })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    defs.setNext(async () => {
      calls += 1
      if (calls === 1) {
        await gate
        throw new Error('fixture provider unavailable')
      }
      return say(calls === 2 ? 'fallback done' : 'composer reply')
    })
    const pending = orch.runAgentDefinition(request(resolved, thread.id))
    await vi.waitFor(() => expect(defs.turns).toHaveLength(1))
    const sent = await orch.send('queued composer', false, { threadId: thread.id, awaitMode: 'ack' })
    expect(sent.queued).toBe(true)
    release()
    const result = await pending
    expect(result).toMatchObject({ status: 'completed', text: 'fallback done' })
    expect(defs.turns.map((turn) => turn.input.instanceId)).toEqual([`pi:${PROVIDER}`, `pi:${OTHER}`])
    // Only then the queued message, once.
    await vi.waitFor(() => expect(defs.turns.filter((turn) => turn.input.prompt === 'queued composer')).toHaveLength(1), { timeout: 5_000, interval: 25 })
    expect(defs.turns.slice(0, 2).every((turn) => turn.input.prompt !== 'queued composer')).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(defs.turns.filter((turn) => turn.input.prompt === 'queued composer')).toHaveLength(1)
  })

  it('a scheduled turn on the thread queues behind a running definition, then runs once after it', async () => {
    const stored = publish('mousse', `pi:${PROVIDER}`)
    const resolved = resolver.resolve({ definitionId: stored.id, revision: stored.revision })
    const thread = store.createThread('scheduled behind a definition')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    defs.setNext(async () => { await gate; return say('definition done') })
    const pending = orch.runAgentDefinition(request(resolved, thread.id))
    await vi.waitFor(() => expect(defs.turns).toHaveLength(1))
    const scheduled = await orch.runIsolatedScheduledJob('scheduled prompt', {
      jobId: 'job-1', occurrenceAt: new Date().toISOString(), threadId: thread.id,
      selection: { instanceId: `pi:${PROVIDER}`, llmProvider: PROVIDER, model: MODEL }
    })
    // It never starts beside the definition: it waits as one queue item.
    expect(scheduled).toMatchObject({ status: 'queued', threadId: thread.id })
    expect(defs.turns).toHaveLength(1)
    defs.setNext(async () => say('scheduled reply'))
    release()
    expect((await pending).status).toBe('completed')
    await vi.waitFor(() => expect(defs.turns.filter((turn) => turn.input.prompt === 'scheduled prompt')).toHaveLength(1), { timeout: 5_000, interval: 25 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(defs.turns.filter((turn) => turn.input.prompt === 'scheduled prompt')).toHaveLength(1)
  })

  it('a later record that finds the thread taken keeps the provider failure that moved the run', async () => {
    const stored = publish('mousse', `pi:${PROVIDER}`, (settings) => {
      settings.fallbacks = { enabled: true, models: [{ providerId: OTHER, modelId: MODEL, instanceId: `pi:${OTHER}` }], retryOn: [], allowHigherCost: true }
      settings.recovery.retryCount = 0
      settings.recovery.backoffMs = 200
    })
    const resolved = resolver.resolve({ definitionId: stored.id, revision: stored.revision })
    const thread = store.createThread('taken across processes')
    let held: ReturnType<typeof tryAcquireExecutionLease> = null
    defs.setNext(async () => {
      // Another process takes the thread's lease during the backoff (the in-process fence cannot stop it).
      setTimeout(() => { held = tryAcquireExecutionLease(store.getThreadDir(thread.id), { source: 'other-process' }) }, 20)
      throw new Error('fixture provider unavailable')
    })
    try {
      const result = await orch.runAgentDefinition(request(resolved, thread.id))
      expect(result.status).toBe('failed')
      // The fallback never reached its runtime: the thread was taken, and the run failed with the primary's error.
      expect(defs.turns).toHaveLength(1)
      expect(result.error!.message).not.toContain('running other work')
      expect(result.error!.message).toMatch(/fixture provider unavailable/)
    } finally {
      if (held) releaseExecutionLeaseHandle(held)
    }
  })

  it('a Stop during a definition run also stops an ordinary turn admitted on the thread, and a Stop for one run spares the other', () => {
    const thread = store.createThread('two stops')
    const session = (orch as unknown as { getOrCreateSession(id: string): { turnAdmitted: boolean; abortRequested: boolean } }).getOrCreateSession(thread.id)
    const stops = (orch as unknown as { definitionStops: Map<string, Set<{ abort: AbortController; runIds: Set<string>; admitted: boolean }>> }).definitionStops
    const definition = { abort: new AbortController(), runIds: new Set(['run:definition']), admitted: false }
    stops.set(thread.id, new Set([definition]))
    // An ordinary turn is admitted and still starting.
    session.turnAdmitted = true
    try {
      // A Stop for the definition's record stops only the definition.
      expect(orch.abortActiveTurn(thread.id, { runId: 'run:definition' })).toBe(true)
      expect(definition.abort.signal.aborted).toBe(true)
      expect(session.abortRequested).toBe(false)
      // A thread Stop also reaches the admitted turn.
      const again = { abort: new AbortController(), runIds: new Set(['run:definition-2']), admitted: false }
      stops.set(thread.id, new Set([again]))
      expect(orch.abortActiveTurn(thread.id)).toBe(true)
      expect(again.abort.signal.aborted).toBe(true)
      expect(session.abortRequested).toBe(true)
    } finally {
      stops.delete(thread.id)
      session.turnAdmitted = false
      session.abortRequested = false
    }
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

  it('a runtime that reports usage per request (Pi’s agent): the run’s usage is what it reported, a turn that reached a limit included', async () => {
    harness.stop()
    let limited = false
    // Two requests' usage with their prices, then a reply (or a limit refusing the third request).
    const reporting: ProviderAdapter = {
      driver: 'codex',
      capabilities: { steer: 'none', interrupt: true, rollback: 'none', fork: 'portable', events: 'rich', containment: 'strong', historyInjection: 'prompt', mcp: true, childPolicy: 'enforced' },
      configured: () => true,
      startTurn: async (input, sink) => {
        sink.providerRef({ provider: 'p', instanceId: input.instanceId, model: input.model })
        sink.usage({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0, costUsd: 0.25 })
        sink.usage({ input: 50, output: 10, cacheRead: 7, cacheWrite: 0, costUsd: 0.125 })
        if (limited) {
          // A reply streamed before the limit refused the next request.
          sink.text({ phase: 'start', contentIndex: 0, content: 'partial ' } as never)
          sink.text({ phase: 'delta', contentIndex: 0, content: 'answer' } as never)
          throw harnessAppError({ code: 'budget_exhausted', message: 'The turn limit was reached.', limit: { kind: 'turns', limit: 2, actual: 2 } })
        }
        return { text: 'done', aborted: false, modelName: input.model, totalResponseTimeMs: 1, usage: { input: 150, output: 30, cacheRead: 7, cacheWrite: 0 }, contextSignature: 's', nativeMessages: [], providerRef: { provider: 'p' } }
      },
      interrupt: async () => 'not_active'
    }
    let stored: unknown = { reporting: { driver: 'codex', enabled: true } }
    harness = testHarness({ drivers: [adapterDriver(reporting, { toolControl: 'exact', budgets: 'hard' })], instances: new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (state) => { stored = state.instances } } }), profileHome: home })
    orch.setHarness(harness)
    const definition = publish('mousse', 'reporting')
    const resolved = resolver.resolve({ definitionId: definition.id, revision: definition.revision })
    const completed = await orch.runAgentDefinition(request(resolved, store.createThread('usage').id))
    expect(completed).toMatchObject({ status: 'completed', usage: { inputTokens: 150, outputTokens: 30, costUsd: 0.375 } })
    limited = true
    const stopped = await orch.runAgentDefinition(request(resolved, store.createThread('usage-limit').id))
    // The limit ends the run with the reply so far, the limit, and the usage.
    expect(stopped).toMatchObject({ status: 'failed', text: 'partial answer', error: { code: 'BUDGET_EXCEEDED', details: { limit: { kind: 'turns', limit: 2 } } }, usage: { inputTokens: 150, outputTokens: 30, costUsd: 0.375 } })
  })

  describe('a browser definition on an instance that runs definitions itself (Pi RPC)', () => {
    const BROWSER_BUILTINS = ['read', 'write', 'ask_user', 'bash', 'thread_read', 'browser_open', 'browser_observe', 'browser_act', 'browser_screenshot']
    /** A local browser stand-in: it records what reached it and never loads a page. */
    function localBrowser(label: string) {
      const dispatched: Array<{ label: string; name: string; args: unknown; actor: unknown; runId?: string }> = []
      const runtime: BrowserRuntimePort = {
        resolveTarget: () => ({ backend: 'managed-chromium' }),
        dispatch: async (context, name, args) => {
          dispatched.push({ label, name, args, actor: context.execution.actor, ...(context.execution.runId ? { runId: context.execution.runId } : {}) })
          return { observationId: 'obs-1' }
        }
      }
      return { runtime, dispatched }
    }
    /**
     * A runtime with its own loop, standing in for Pi RPC: it is sent the turn's Mousse tools
     * (`listForTurn`, as the Pi driver sends them) and calls them over the Mousse MCP registry, as
     * Pi's extension does, under a credential bound to its run.
     */
    function mcpRuntime(calls: Array<{ name: string; args: Record<string, unknown> }>, seen: { tools?: string[]; results: Array<{ text: string; isError?: boolean }>; runId?: string; ran: string[] }, name: string): ProviderAdapter {
      return {
        driver: 'codex',
        capabilities: { steer: 'none', interrupt: true, rollback: 'none', fork: 'portable', events: 'rich', containment: 'strong', historyInjection: 'prompt', mcp: true, childPolicy: 'enforced' },
        configured: () => true,
        startTurn: async (input, sink) => {
          seen.ran.push(name)
          seen.runId = input.runId
          sink.providerRef({ provider: 'p', instanceId: input.instanceId, model: input.model })
          const registry = orch.mcpToolRegistry()
          seen.tools = registry.listForTurn(input.threadId, input.runId).map((tool) => tool.name)
          for (const [index, call] of calls.entries()) {
            seen.results.push(await registry.call(call.name, call.args, {
              credential: { threadId: input.threadId, runId: input.runId, provider: 'pi', modeCeiling: 'default', accessLevel: 'lineage', binding: 'rotate', current: () => true },
              toolCallId: `call-${index}`,
              signal: input.signal
            }))
          }
          return { text: name, aborted: false, modelName: input.model, totalResponseTimeMs: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextSignature: 's', nativeMessages: [], providerRef: { provider: 'p' } }
        },
        interrupt: async () => 'not_active'
      }
    }
    function install(adapter: ProviderAdapter): void {
      harness.stop()
      // As the Pi driver declares on an RPC connection with evidence.
      const driver = adapterDriver(adapter, { toolControl: 'exact', budgets: 'hard' })
      let stored: unknown = { browsing: { driver: 'codex', enabled: true } }
      harness = testHarness({ drivers: [driver], instances: new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (state) => { stored = state.instances } } }), profileHome: home })
      orch.setHarness(harness)
    }
    function browsing(allowlist: string[], mutate: (settings: ReturnType<typeof defaultAgentSettings>) => void = () => {}): ResolvedAgentDefinition {
      const lookup = new StaticAgentIntegrationLookup({ builtinToolIds: BROWSER_BUILTINS })
      const agent = defaultAgentSettings({ name: 'Browser', slug: `browser-${allowlist.join('-').replace(/\W/g, '')}` })
      agent.primaryModel.ref = { providerId: PROVIDER, modelId: MODEL, instanceId: 'browsing' }
      agent.tools = { mode: 'explicit', allowlist }
      agent.browser.mode = 'structured'
      mutate(agent)
      const draft = registry.createDraft({ runtimeKind: 'mousse', settings: agent, systemPrompt: 'DEFINITION_SYSTEM_PROMPT' })
      const published = registry.publish(draft.id, draft.draftHash, { integrationLookup: lookup })
      const entry = { ref: { providerId: PROVIDER, modelId: MODEL, instanceId: 'browsing' }, available: true, efforts: [], speeds: [], contexts: [], capabilities: ['tools'], unavailableReasons: [] }
      return new AgentResolver({ registry, integrationLookup: lookup, modelLookup: new StaticAgentModelLookup([entry] as never) }).resolve({ definitionId: draft.id, revision: published.revision })
    }
    it('runs on the runtime; its granted browser tools run over the Mousse MCP server on the host’s browser, with a ledger row', async () => {
      const seen = { results: [] as Array<{ text: string; isError?: boolean }>, ran: [] as string[], tools: undefined as string[] | undefined, runId: undefined as string | undefined }
      install(mcpRuntime([
        { name: 'browser_open', args: { url: 'http://127.0.0.1:9/local-page' } },
        { name: 'browser_act', args: { sessionId: 's', tabId: 't', generation: 1, observationId: 'o', controlLeaseId: 'l', action: { type: 'reload' } } }
      ], seen, 'runtime'))
      const profile = localBrowser('profile')
      const host = localBrowser('host')
      orch.setBrowserRuntime(profile.runtime)
      // The profile turned every Mousse tool off in its settings: a definition's grants decide its
      // tools.
      settings.integrations.tools.enabled = false
      const resolved = browsing(['read', 'browser_open', 'browser_observe', 'browser_screenshot'])
      const result = await orch.runAgentDefinition(request(resolved, store.createThread('browsing').id, { runId: 'definition-run', host: { workspaceRoots: [work], browserRuntime: host.runtime } as never }))
      expect(result).toMatchObject({ status: 'completed', text: 'runtime' })
      expect(seen.ran).toEqual(['runtime'])
      // Sent the browser tools the turn's binding offers, none outside the grants.
      expect(seen.tools).toEqual(expect.arrayContaining(['browser_open', 'browser_observe']))
      expect(seen.tools).not.toContain('browser_act')
      // The granted call ran on the host's browser (an agent chat's shared one, say), as the
      // definition, under the definition run's binding; the ungranted one never reached a browser.
      expect(seen.results[0]).toMatchObject({ isError: false })
      expect(seen.results[1]).toMatchObject({ isError: true, text: expect.stringContaining('not granted') })
      expect(host.dispatched).toEqual([{ label: 'host', name: 'browser_open', args: { url: 'http://127.0.0.1:9/local-page' }, actor: { kind: 'agent', definitionId: resolved.definitionId, definitionRevision: resolved.revision }, runId: 'definition-run' }])
      expect(profile.dispatched).toEqual([])
      // The call is in the run's tool ledger.
      expect(engine.tools.listForRun(seen.runId!).map((row) => [row.tool, row.status])).toEqual([['browser_open', 'committed']])
    })

    it('an unattended run is held: an action its approval policy denies never reaches the browser', async () => {
      const seen = { results: [] as Array<{ text: string; isError?: boolean }>, ran: [] as string[] }
      install(mcpRuntime([
        { name: 'browser_act', args: { sessionId: 's', tabId: 't', generation: 1, observationId: 'o', controlLeaseId: 'l', action: { type: 'reload' } } },
        { name: 'browser_observe', args: { sessionId: 's' } }
      ], seen, 'runtime'))
      const browser = localBrowser('profile')
      orch.setBrowserRuntime(browser.runtime)
      const resolved = browsing(['browser_act', 'browser_observe'], (agent) => { agent.approval.policy = 'unattended_deny' })
      expect(await orch.runAgentDefinition(request(resolved, store.createThread('scheduled').id, { source: 'schedule', host: { workspaceRoots: [work], browserRuntime: browser.runtime } as never }))).toMatchObject({ status: 'completed' })
      expect(seen.results[0]).toMatchObject({ isError: true, text: expect.stringContaining('/settings/approval/policy') })
      // A read is not refused by that policy.
      expect(seen.results[1]).toMatchObject({ isError: false })
      expect(browser.dispatched.map((call) => call.name)).toEqual(['browser_observe'])
    })

    it('without a browser runtime it fails before the turn', async () => {
      const seen = { results: [] as Array<{ text: string; isError?: boolean }>, ran: [] as string[] }
      install(mcpRuntime([], seen, 'runtime'))
      const resolved = browsing(['browser_open'])
      const host = localBrowser('host')
      const result = await orch.runAgentDefinition(request(resolved, store.createThread('unbound').id, { host: { workspaceRoots: [work], browserRuntime: host.runtime } as never }))
      expect(result).toMatchObject({ status: 'failed', error: { message: expect.stringContaining('Browser runtime is not bound') } })
      expect(seen.ran).toEqual([])
    })

    it('without an MCP bearer for the turn it is refused before the turn, never run without its browser', async () => {
      const seen = { results: [] as Array<{ text: string; isError?: boolean }>, ran: [] as string[] }
      install(mcpRuntime([], seen, 'runtime'))
      const browser = localBrowser('profile')
      orch.setBrowserRuntime(browser.runtime)
      // The Mousse MCP server is not running: no bearer can be issued.
      orch.setMcpAttachment(null)
      const resolved = browsing(['browser_open'])
      const result = await orch.runAgentDefinition(request(resolved, store.createThread('no bearer').id, { host: { workspaceRoots: [work], browserRuntime: browser.runtime } as never }))
      expect(result).toMatchObject({ status: 'failed', error: { message: expect.stringContaining("This agent's tools (browser_open) could not be connected for this run") } })
      expect(seen.ran).toEqual([])
    })
  })

  it('a definition whose spend limit the runtime cannot reserve is refused at publish, Try Run and run time, saying what to change', async () => {
    harness.stop()
    const ran: string[] = []
    const adapterNamed = (name: string): ProviderAdapter => ({
      driver: 'codex',
      capabilities: { steer: 'none', interrupt: true, rollback: 'none', fork: 'portable', events: 'rich', containment: 'strong', historyInjection: 'prompt', mcp: true, childPolicy: 'enforced' },
      configured: () => true,
      startTurn: async (input, sink) => {
        ran.push(name)
        sink.providerRef({ provider: 'p', instanceId: input.instanceId, model: input.model })
        return { text: name, aborted: false, modelName: input.model, totalResponseTimeMs: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextSignature: 's', nativeMessages: [], providerRef: { provider: 'p' } }
      },
      interrupt: async () => 'not_active'
    })
    // A runtime that reserves spend, on a model without a price.
    const driver = adapterDriver(adapterNamed('runtime'), { toolControl: 'exact', budgets: 'hard', spendLimits: 'reserved', runtime: { spendModel: () => ({ label: 'Local model', outputCap: true, priced: false }) } })
    let stored: unknown = { spend: { driver: 'codex', enabled: true }, spend2: { driver: 'codex', enabled: true } }
    harness = testHarness({ drivers: [driver], instances: new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (state) => { stored = state.instances } } }), profileHome: home })
    orch.setHarness(harness)
    const plain = resolver.resolve((({ id, revision }) => ({ definitionId: id, revision }))(publish('mousse', 'spend')))
    expect(await orch.runAgentDefinition(request(plain, store.createThread('counts only').id))).toMatchObject({ status: 'completed', text: 'runtime' })
    const editorCheck = (resolved: ResolvedAgentDefinition) => definitionCheckIssues(orch, { threadId: '', definition: { id: resolved.definitionId, revision: resolved.revision }, settings: resolved.settings, grants: resolved.grants })
    expect(editorCheck(plain)).toEqual([])
    const limited = resolver.resolve((({ id, revision }) => ({ definitionId: id, revision }))(publish('mousse', 'spend2', (settings) => { settings.limits.maxCostUsd = 1 })))
    const said = "This agent's token or cost limits can't be held on this model. Local model has no price, so a cost limit cannot be held. Set a price for the model, or use a token limit instead."
    // Publish (and the editor) refuse it, by the same check.
    expect(editorCheck(limited)).toMatchObject([{ code: 'SETTINGS_UNSUPPORTED', message: said, pointer: '/settings/limits/maxCostUsd' }])
    // Try Run and every other run refuse it before any turn.
    expect(await orch.runAgentDefinition(request(limited, store.createThread('cost limited').id))).toMatchObject({ status: 'failed', error: { code: 'SETTINGS_UNSUPPORTED', message: said } })
    expect(ran).toEqual(['runtime'])
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
