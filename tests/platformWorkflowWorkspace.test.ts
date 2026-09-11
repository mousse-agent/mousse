import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMessage, Context } from '@earendil-works/pi-ai'
import { MousseMainService } from '../src/mms/MousseMainService'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { MmsWorkflowCoordinator } from '../src/mms/platform/MmsWorkflowCoordinator'
import { MmsWorkflowAgents } from '../src/mms/platform/MmsWorkflowAgents'
import { WorkflowRegistry } from '../src/mms/workflows/registry/WorkflowRegistry'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { provisionOwnedAgentWorkspace, withSerializedWorkspace } from '../src/mms/workspace/WorkflowWorkspace'
import { acquireRepositoryLease } from '../src/mms/git/RepositoryLease'
import { resolveRepositoryIdentity } from '../src/mms/git/RepositoryIdentity'
import { defaultAgentSettings } from '../src/shared/agents/defaults'
import type { ExecutionActor, ExecutionContext, ExecutionPolicyLayer, ExecutionPolicySnapshot } from '../src/shared/execution/types'
import type { StartWorkflowRequest, WorkflowBundle, WorkflowRunManifest } from '../src/shared/workflows'
import { providerResponse, streamOf } from './fixtures/agent-platform/agent-runtime-policy/helpers'

const roots: string[] = []
const coordinators: MmsWorkflowCoordinator[] = []
const previousHome = process.env.MOUSSE_HOME
const admission = { source: 'gui' as const, connectionId: 'owned-window' }

function ownedTemp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function initRepo(root: string, sentinel = 'primary-bytes'): string {
  mkdirSync(root, { recursive: true })
  git(root, ['init', '-q'])
  git(root, ['config', 'user.name', 'Test'])
  git(root, ['config', 'user.email', 'test@example.test'])
  writeFileSync(join(root, 'PRIMARY.txt'), sentinel)
  git(root, ['add', '.'])
  git(root, ['commit', '-qm', 'base'])
  return git(root, ['rev-parse', 'HEAD'])
}

function scriptSource(): string {
  return `
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
let raw = ''
for await (const chunk of process.stdin) raw += chunk
const input = JSON.parse(raw)
const cwd = process.cwd()
const sentinel = existsSync(join(cwd, 'THREAD.txt')) ? readFileSync(join(cwd, 'THREAD.txt'), 'utf8') : null
writeFileSync(join(cwd, 'proof.txt'), cwd)
const staged = input.files?.[0] && process.env.MOUSSE_INPUT_DIR
  ? readFileSync(join(process.env.MOUSSE_INPUT_DIR, input.files[0]), 'utf8')
  : null
process.stdout.write(JSON.stringify({
  cwd,
  sentinel,
  staged,
  inputDir: process.env.MOUSSE_INPUT_DIR ?? '',
  stagingIsCwd: process.env.MOUSSE_INPUT_DIR === cwd
}))
`
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(coordinators.splice(0).map((coordinator) => coordinator.dispose().catch(() => undefined)))
  if (previousHome === undefined) delete process.env.MOUSSE_HOME
  else process.env.MOUSSE_HOME = previousHome
  for (const root of roots.splice(0)) {
    const rel = relative(realpathSync(tmpdir()), realpathSync(root))
    if (isAbsolute(rel) || (!rel.startsWith('mousse-workflow-ws-') && !rel.startsWith('mousse-workflow-agents-')) || rel.includes('..')) {
      throw new Error('Unexpected fixture root')
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

function coordinatorFixture() {
  const root = ownedTemp('mousse-workflow-ws-')
  const home = join(root, 'home')
  mkdirSync(home)
  process.env.MOUSSE_HOME = home
  const profileRoot = join(root, 'profile')
  mkdirSync(profileRoot)
  const profileId = randomUUID()
  const projects = new ProjectManager(profileRoot)
  const threads = new ThreadDataStore(projects, profileRoot, { allowLegacyProjectData: false })
  projects.setThreadStore(threads)
  const registry = new WorkflowRegistry({ profileId, profileRoot })
  const coordinator = new MmsWorkflowCoordinator({ profileId, profileRoot, projects, threads, registry })
  coordinators.push(coordinator)
  return { root, home, profileRoot, profileId, projects, threads, registry, coordinator }
}

function publishScript(
  f: ReturnType<typeof coordinatorFixture>,
  workingDirectory: 'thread-workspace' | 'run-staging' | 'profile-sandbox' | 'primary-checkout',
  extra: Record<string, unknown> = {},
  effect: 'read' | 'write' = 'read'
) {
  const bundle: WorkflowBundle = {
    assets: [{ relativePath: 'scripts/run.mjs', bytes: new TextEncoder().encode(scriptSource()) }],
    manifest: {
      schemaVersion: 1,
      id: randomUUID(),
      name: 'Workspace script',
      slug: 'workspace-script-' + randomUUID().slice(0, 8),
      entryNodeId: 'start',
      inputSchema: { type: 'object', additionalProperties: true },
      outputSchema: { type: 'object', additionalProperties: true },
      permissions: { capabilities: ['script.trusted-local', 'workspace.read'] },
      nodes: [
        { id: 'start', type: 'start', version: 1, config: {} },
        {
          id: 'script',
          type: 'script',
          version: 1,
          effect,
          inputs: { files: { ref: 'input', pointer: '/files' } },
          config: {
            runtime: 'node',
            file: 'scripts/run.mjs',
            executionMode: 'trusted-local',
            workingDirectory,
            fileInputs: [{ pointer: '/files', source: 'thread-workspace', destination: 'input-dir', rewrite: 'relative-staged-paths', maxTotalBytes: 4096 }],
            ...extra
          }
        },
        { id: 'end', type: 'end', version: 1, config: {}, inputs: { result: { ref: 'node', nodeId: 'script', pointer: '' } } }
      ],
      edges: [
        { from: 'start', port: 'next', to: 'script' },
        { from: 'script', port: 'success', to: 'end' }
      ]
    }
  }
  const saved = f.registry.saveDraft({ bundle })
  return f.registry.publish({
    definitionId: saved.definitionId,
    expectedDraftSemanticHash: saved.semanticHash,
    expectedHeadRevisionId: null
  })
}

async function waitRun(coordinator: MmsWorkflowCoordinator, runId: string, expected: string) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const snapshot = await coordinator.runtime.get(runId, { profileId: coordinator.profileId })
    if (snapshot.manifest.state === expected) return snapshot
    if (snapshot.manifest.state === 'failed' && expected !== 'failed') throw new Error(snapshot.manifest.terminalError)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Workflow did not reach ' + expected)
}

describe('workflow script workingDirectory', () => {
  it('cancels a queued workspace operation without waiting for the current holder', async () => {
    const root = ownedTemp('mousse-workflow-ws-')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let firstStarted = false
    let secondStarted = false
    const first = withSerializedWorkspace(root, async () => { firstStarted = true; await gate })
    await vi.waitFor(() => expect(firstStarted).toBe(true))
    const controller = new AbortController()
    const second = withSerializedWorkspace(root, async () => { secondStarted = true }, controller.signal)
    controller.abort()
    const outcome = await Promise.race([
      second.catch((error: unknown) => error),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500))
    ])
    expect(outcome).not.toBe('timeout')
    expect(outcome).toMatchObject({ code: 'cancelled' })
    expect(secondStarted).toBe(false)
    release()
    await first
  })

  it('runs thread-workspace in the owned worktree, keeps staging independent, and leaves primary untouched', async () => {
    const f = coordinatorFixture()
    const repo = join(f.root, 'repo')
    const primaryHead = initRepo(repo)
    const project = f.projects.openProject(repo)
    const thread = f.threads.createThread('Workspace script', project.id)
    const manager = new ThreadWorkspaceManager(f.threads.getThreadDir(thread.id))
    const metadata = await manager.provision(thread.id, 'main', repo)
    expect(metadata.worktreePath).not.toBe(repo)
    writeFileSync(join(metadata.worktreePath, 'THREAD.txt'), 'thread-sentinel')
    writeFileSync(join(metadata.worktreePath, 'STAGED.txt'), 'staged-bytes')
    const published = publishScript(f, 'thread-workspace')
    const started = await f.coordinator.start({
      profileId: f.profileId,
      definitionId: published.definitionId,
      requestId: randomUUID(),
      input: { files: ['STAGED.txt'] },
      threadId: thread.id,
      projectId: project.id
    }, admission)
    const waiting = await waitRun(f.coordinator, started.manifest.runId, 'waiting-approval')
    await f.coordinator.runtime.approve(started.manifest.runId, { profileId: f.profileId, deferExecution: true }, {
      approvalId: waiting.pendingApprovalId!,
      approved: true,
      actorId: admission.connectionId
    })
    const done = await waitRun(f.coordinator, started.manifest.runId, 'succeeded')
    const result = done.result as { cwd: string; sentinel: string; staged: string; inputDir: string; stagingIsCwd: boolean }
    expect(result.sentinel).toBe('thread-sentinel')
    expect(result.staged).toBe('staged-bytes')
    expect(result.stagingIsCwd).toBe(false)
    expect(result.inputDir.length).toBeGreaterThan(0)
    expect(realpathSync(result.cwd)).toBe(realpathSync(metadata.worktreePath))
    expect(readFileSync(join(metadata.worktreePath, 'proof.txt'), 'utf8')).toBe(result.cwd)
    expect(existsSync(join(repo, 'proof.txt'))).toBe(false)
    expect(readFileSync(join(repo, 'PRIMARY.txt'), 'utf8')).toBe('primary-bytes')
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(primaryHead)
    expect(git(repo, ['branch', '--show-current'])).not.toBe(metadata.branch)
  }, 30_000)

  it('holds the shared repository mutation lease for a mutating workspace script', async () => {
    const f = coordinatorFixture()
    const repo = join(f.root, 'repo')
    initRepo(repo)
    const project = f.projects.openProject(repo)
    const thread = f.threads.createThread('Leased workspace script', project.id)
    const manager = new ThreadWorkspaceManager(f.threads.getThreadDir(thread.id))
    const metadata = await manager.provision(thread.id, 'main', repo)
    writeFileSync(join(metadata.worktreePath, 'THREAD.txt'), 'thread-sentinel')
    writeFileSync(join(metadata.worktreePath, 'STAGED.txt'), 'staged-bytes')
    const blocker = await acquireRepositoryLease(resolveRepositoryIdentity(repo, { requireMutationCapability: true }))
    try {
      const published = publishScript(f, 'thread-workspace', {}, 'write')
      const started = await f.coordinator.start({
        profileId: f.profileId, definitionId: published.definitionId, requestId: randomUUID(),
        input: { files: ['STAGED.txt'] }, threadId: thread.id, projectId: project.id
      }, admission)
      const waiting = await waitRun(f.coordinator, started.manifest.runId, 'waiting-approval')
      await f.coordinator.runtime.approve(started.manifest.runId, { profileId: f.profileId, deferExecution: true }, {
        approvalId: waiting.pendingApprovalId!, approved: true, actorId: admission.connectionId
      })
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(existsSync(join(metadata.worktreePath, 'proof.txt'))).toBe(false)
      expect((await f.coordinator.runtime.get(started.manifest.runId, { profileId: f.profileId })).manifest.state).toBe('running')
      blocker.release()
      const done = await waitRun(f.coordinator, started.manifest.runId, 'succeeded')
      expect(done.result).toMatchObject({ sentinel: 'thread-sentinel' })
    } finally { blocker.release() }
  }, 30_000)

  it('executes run-staging in owned staging and fails profile-sandbox closed', async () => {
    const f = coordinatorFixture()
    const repo = join(f.root, 'repo')
    initRepo(repo)
    const project = f.projects.openProject(repo)
    const thread = f.threads.createThread('Staging script', project.id)
    const manager = new ThreadWorkspaceManager(f.threads.getThreadDir(thread.id))
    const metadata = await manager.provision(thread.id, 'main', repo)
    writeFileSync(join(metadata.worktreePath, 'THREAD.txt'), 'thread-sentinel')
    writeFileSync(join(metadata.worktreePath, 'STAGED.txt'), 'staged-bytes')
    const stagingPublished = publishScript(f, 'run-staging')
    const started = await f.coordinator.start({
      profileId: f.profileId,
      definitionId: stagingPublished.definitionId,
      requestId: randomUUID(),
      input: { files: ['STAGED.txt'] },
      threadId: thread.id,
      projectId: project.id
    }, admission)
    const waiting = await waitRun(f.coordinator, started.manifest.runId, 'waiting-approval')
    await f.coordinator.runtime.approve(started.manifest.runId, { profileId: f.profileId, deferExecution: true }, {
      approvalId: waiting.pendingApprovalId!,
      approved: true,
      actorId: admission.connectionId
    })
    const done = await waitRun(f.coordinator, started.manifest.runId, 'succeeded')
    const result = done.result as { cwd: string; stagingIsCwd: boolean; inputDir: string }
    expect(result.stagingIsCwd).toBe(true)
    expect(result.cwd).toBe(result.inputDir)
    expect(existsSync(join(repo, 'proof.txt'))).toBe(false)

    await expect(f.coordinator.start({
      profileId: f.profileId,
      definitionId: publishScript(f, 'profile-sandbox').definitionId,
      requestId: randomUUID(),
      input: { files: ['STAGED.txt'] },
      threadId: thread.id,
      projectId: project.id
    }, admission)).rejects.toMatchObject({ code: 'executor_unavailable' })
  }, 30_000)

  it('denies profile spoof, missing project, non-git projects, and stale thread workspaces', async () => {
    const f = coordinatorFixture()
    const repo = join(f.root, 'repo')
    initRepo(repo)
    const project = f.projects.openProject(repo)
    const thread = f.threads.createThread('Deny workspace', project.id)
    const published = publishScript(f, 'thread-workspace')
    await expect(f.coordinator.start({
      profileId: randomUUID(),
      definitionId: published.definitionId,
      requestId: randomUUID(),
      input: { files: ['PRIMARY.txt'] },
      threadId: thread.id,
      projectId: project.id
    }, admission)).rejects.toMatchObject({ code: 'profile_mismatch' })
    await expect(f.coordinator.start({
      profileId: f.profileId,
      definitionId: published.definitionId,
      requestId: randomUUID(),
      input: { files: ['PRIMARY.txt'] },
      threadId: thread.id,
      projectId: randomUUID()
    }, admission)).rejects.toMatchObject({ code: 'project_mismatch' })

    const loose = join(f.root, 'loose')
    mkdirSync(loose)
    writeFileSync(join(loose, 'PRIMARY.txt'), 'not-git')
    const looseProject = f.projects.openProject(loose)
    const looseThread = f.threads.createThread('Loose', looseProject.id)
    const started = await f.coordinator.start({
      profileId: f.profileId,
      definitionId: published.definitionId,
      requestId: randomUUID(),
      input: { files: ['PRIMARY.txt'] },
      threadId: looseThread.id,
      projectId: looseProject.id
    }, admission)
    const waiting = await waitRun(f.coordinator, started.manifest.runId, 'waiting-approval')
    await f.coordinator.runtime.approve(started.manifest.runId, { profileId: f.profileId, deferExecution: true }, {
      approvalId: waiting.pendingApprovalId!,
      approved: true,
      actorId: admission.connectionId
    })
    const failed = await waitRun(f.coordinator, started.manifest.runId, 'failed')
    expect(failed.manifest.terminalError).toMatch(/Git repository|not-a-repository|unavailable/i)

    const manager = new ThreadWorkspaceManager(f.threads.getThreadDir(thread.id))
    const metadata = await manager.provision(thread.id, 'main', repo)
    rmSync(metadata.worktreePath, { recursive: true, force: true })
    const stale = await f.coordinator.start({
      profileId: f.profileId,
      definitionId: published.definitionId,
      requestId: randomUUID(),
      input: { files: ['PRIMARY.txt'] },
      threadId: thread.id,
      projectId: project.id
    }, admission)
    const staleWaiting = await waitRun(f.coordinator, stale.manifest.runId, 'waiting-approval')
    await f.coordinator.runtime.approve(stale.manifest.runId, { profileId: f.profileId, deferExecution: true }, {
      approvalId: staleWaiting.pendingApprovalId!,
      approved: true,
      actorId: admission.connectionId
    })
    const staleFailed = await waitRun(f.coordinator, stale.manifest.runId, 'failed')
    expect(staleFailed.manifest.terminalError).toMatch(/stale|missing|unavailable/i)
  }, 30_000)

  it('rejects thread workspace metadata redirected to the primary checkout', async () => {
    const f = coordinatorFixture()
    const repo = join(f.root, 'repo')
    initRepo(repo)
    const project = f.projects.openProject(repo)
    const thread = f.threads.createThread('Redirected workspace', project.id)
    const manager = new ThreadWorkspaceManager(f.threads.getThreadDir(thread.id))
    const metadata = await manager.provision(thread.id, 'main', repo)
    writeFileSync(manager.workspacePath, JSON.stringify({
      ...metadata,
      worktreePath: repo,
      branch: git(repo, ['branch', '--show-current'])
    }))
    const published = publishScript(f, 'thread-workspace')
    const started = await f.coordinator.start({
      profileId: f.profileId,
      definitionId: published.definitionId,
      requestId: randomUUID(),
      input: { files: ['PRIMARY.txt'] },
      threadId: thread.id,
      projectId: project.id
    }, admission)
    const waiting = await waitRun(f.coordinator, started.manifest.runId, 'waiting-approval')
    await f.coordinator.runtime.approve(started.manifest.runId, { profileId: f.profileId, deferExecution: true }, {
      approvalId: waiting.pendingApprovalId!, approved: true, actorId: admission.connectionId
    })
    const failed = await waitRun(f.coordinator, started.manifest.runId, 'failed')
    expect(failed.manifest.terminalError).toMatch(/metadata does not match|primary checkout|registered worktree/i)
    expect(existsSync(join(repo, 'proof.txt'))).toBe(false)
  }, 30_000)
})

async function agentFixture() {
  vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
  const root = ownedTemp('mousse-workflow-agents-')
  const homeDir = join(root, 'home')
  const main = await MousseMainService.create({ homeDir, repoRoot: root, requireOwnership: false, headless: true })
  const host = main.getInstallationHost()!
  const alice = host.manager.create({ displayName: 'Alice', slug: 'alice' })
  const services = await main.getProfileServices(alice.id)
  const captured: Context[] = []
  const outputs: AssistantMessage[] = []
  const provider = services.providerAuth.models.getProviders().find((entry) => services.providerAuth.models.getModels(entry.id).length > 0)!
  const model = services.providerAuth.models.getModels(provider.id)[0]
  const modelRef = { providerId: provider.id, modelId: model.id }
  vi.spyOn(services.providerAuth, 'has').mockReturnValue(true)
  vi.spyOn(services.providerAuth.models, 'getAuth').mockResolvedValue({ apiKey: 'fixture' } as never)
  vi.spyOn(services.providerAuth.models, 'streamSimple').mockImplementation((_model, context) => {
    captured.push(structuredClone(context))
    const next = outputs.shift()
    if (!next) throw new Error('fixture provider exhausted')
    return streamOf(next) as never
  })
  const integrations = services.settings.get().integrations
  services.settings.set({
    provider: { llmProvider: modelRef.providerId, model: modelRef.modelId },
    integrations: { ...integrations, tools: { enabled: true, enabledTools: ['read', 'write', 'ask_user', 'create_task'] } }
  })
  const repo = join(root, 'repo')
  const primaryHead = initRepo(repo)
  const project = services.projects.openProject(repo)
  const thread = services.threads.createThread('Workflow agent workspace', project.id)
  let manifestOverride: WorkflowRunManifest | undefined
  const agents = new MmsWorkflowAgents(services, async (context) => {
    if (manifestOverride) return manifestOverride
    return (await services.platform.workflowRuns.runtime.get(context.runId!, { profileId: context.profileId })).manifest
  })
  services.platform.workflowRuns.configureAdapters({ agent: agents.agent })
  return {
    root, main, alice, services, captured, outputs, modelRef, repo, project, thread, agents, primaryHead,
    setManifest: (manifest: WorkflowRunManifest | undefined) => { manifestOverride = manifest },
    close: async () => { agents.dispose(); await main.stop() }
  }
}

function agentSettings(name: string, modelRef: { providerId: string; modelId: string }) {
  const value = defaultAgentSettings({ name, slug: name.toLowerCase().replaceAll(' ', '-') + '-' + randomUUID().slice(0, 8) })
  value.primaryModel.ref = modelRef
  value.context.includeProjectInstructions = false
  value.context.includeCurrentThread = false
  value.context.selectedFiles = []
  value.context.attachmentPolicy = 'none'
  value.context.sources = []
  value.tools = { mode: 'explicit', allowlist: ['read', 'write'] }
  value.approval.policy = 'inherit'
  value.recovery.retryCount = 0
  value.memory.scope = 'thread'
  return value
}

function publishAgentWorkflow(f: Awaited<ReturnType<typeof agentFixture>>, definitionId: string) {
  const bundle: WorkflowBundle = {
    assets: [],
    manifest: {
      schemaVersion: 1,
      id: randomUUID(),
      name: 'Agent workspace',
      slug: 'agent-workspace-' + randomUUID().slice(0, 8),
      entryNodeId: 'start',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object', additionalProperties: true },
      permissions: { capabilities: ['model.invoke'] },
      nodes: [
        { id: 'start', type: 'start', version: 1, config: {} },
        {
          id: 'agent',
          type: 'agent',
          version: 1,
          config: { agent: { kind: 'user', definitionId }, instructions: 'Write branch.txt' }
        },
        { id: 'end', type: 'end', version: 1, config: {}, inputs: { result: { ref: 'node', nodeId: 'agent', pointer: '' } } }
      ],
      edges: [
        { from: 'start', port: 'next', to: 'agent' },
        { from: 'agent', port: 'success', to: 'end' }
      ]
    }
  }
  const saved = f.services.platform.workflowDefinitions.saveDraft({ bundle })
  return f.services.platform.workflowDefinitions.publish({
    definitionId: saved.definitionId,
    expectedDraftSemanticHash: saved.semanticHash,
    expectedHeadRevisionId: null
  })
}

function startRequest(f: Awaited<ReturnType<typeof agentFixture>>, record: ReturnType<typeof publishAgentWorkflow>): StartWorkflowRequest {
  return {
    profileId: f.alice.id,
    threadId: f.thread.id,
    projectId: f.project.id,
    requestId: randomUUID(),
    definitionId: record.definitionId,
    revisionId: record.head!.revisionId,
    actor: { kind: 'workflow', definitionId: record.definitionId, definitionRevision: record.semanticHash },
    source: 'gui',
    input: {},
    installationPolicy: {
      allowedTools: ['workflow.node', 'workflow.agent', 'read', 'write'],
      allowedCapabilities: ['model.invoke'],
      allowedEffects: ['pure', 'read', 'write', 'external', 'unknown']
    }
  }
}

function policyOf(f: Awaited<ReturnType<typeof agentFixture>>, extra: ExecutionPolicyLayer = {}): ExecutionPolicySnapshot {
  return f.services.platform.workflowRuns.policy.snapshot(f.alice.id, {
    allowedTools: ['workflow.node', 'workflow.agent', 'read', 'write'],
    allowedCapabilities: ['model.invoke', 'human.input'],
    allowedEffects: ['pure', 'read', 'write', 'external', 'unknown'],
    ...extra
  })
}

function runningManifest(f: Awaited<ReturnType<typeof agentFixture>>, request: StartWorkflowRequest, policy: ExecutionPolicySnapshot, runId = randomUUID()): WorkflowRunManifest {
  const actor: ExecutionActor = request.actor
  return {
    schemaVersion: 1,
    runId,
    requestId: request.requestId,
    profileId: request.profileId,
    threadId: request.threadId,
    projectId: request.projectId,
    definitionId: request.definitionId!,
    revisionId: request.revisionId!,
    semanticHash: request.revisionId!,
    slug: 'agent-workspace-fixture',
    policySnapshotId: policy.id,
    cancellationId: randomUUID(),
    actor,
    source: request.source,
    state: 'running',
    journalSeq: 1,
    limits: {},
    budgets: { elapsedMs: 0, toolCalls: 0, tokens: 0, cost: 0, artifactBytes: 0, maxElapsedMs: 30 * 60_000, maxToolCalls: 100, maxArtifactBytes: 50 * 1024 * 1024 },
    depth: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
}

function contextOf(manifest: WorkflowRunManifest): ExecutionContext {
  return {
    profileId: manifest.profileId,
    projectId: manifest.projectId,
    threadId: manifest.threadId,
    turnId: manifest.runId,
    runId: manifest.runId,
    actor: manifest.actor,
    source: manifest.source,
    policySnapshotId: manifest.policySnapshotId,
    cancellationId: manifest.cancellationId
  }
}

function worktreeCount(repo: string): number {
  return git(repo, ['worktree', 'list', '--porcelain']).split(/\r?\n/).filter((line) => line.startsWith('worktree ')).length
}

describe('workflow agent worktrees', () => {
  it('gives concurrent mutating agents separate git worktrees and does not touch primary', async () => {
    const f = await agentFixture()
    try {
      const created = f.services.platform.agentDefinitions.createDraft({
        settings: agentSettings('Workspace Agent', f.modelRef),
        systemPrompt: 'Write the assigned file.'
      })
      f.services.platform.agentDefinitions.publish(created.id, created.draftHash)
      const record = publishAgentWorkflow(f, created.id)
      const request = startRequest(f, record)
      await f.agents.prepare(request, record)
      const policy = policyOf(f)
      const manifest = runningManifest(f, request, policy)
      f.setManifest(manifest)
      const agentResponses = new Map([
        ['left-bytes', [
          providerResponse([{ type: 'toolCall', id: 'w-left', name: 'write', arguments: { path: 'branch.txt', content: 'left-bytes' } }], 'toolUse'),
          providerResponse([{ type: 'text', text: JSON.stringify({ wrote: 'left-bytes' }) }], 'stop')
        ]],
        ['right-bytes', [
          providerResponse([{ type: 'toolCall', id: 'w-right', name: 'write', arguments: { path: 'branch.txt', content: 'right-bytes' } }], 'toolUse'),
          providerResponse([{ type: 'text', text: JSON.stringify({ wrote: 'right-bytes' }) }], 'stop')
        ]]
      ])
      vi.mocked(f.services.providerAuth.models.streamSimple).mockImplementation((_model, context) => {
        f.captured.push(structuredClone(context))
        const marker = ['left-bytes', 'right-bytes'].find((candidate) => String(context.systemPrompt ?? '').includes(candidate))
        const responses = marker ? agentResponses.get(marker) : undefined
        const next = responses?.shift()
        if (!next) throw new Error('deterministic agent fixture exhausted')
        return streamOf(next) as never
      })
      const invoke = (content: string, key: string) => {
        return f.agents.agent.invoke({
          context: contextOf(manifest),
          policy,
          agent: { kind: 'user', definitionId: created.id },
          instructions: `Write branch.txt with ${content}`,
          input: {},
          signal: new AbortController().signal,
          idempotencyKey: randomUUID()
        })
      }
      const [left, right] = await Promise.all([invoke('left-bytes', 'w-left'), invoke('right-bytes', 'w-right')])
      expect([left.output, right.output]).toEqual(expect.arrayContaining([{ wrote: 'left-bytes' }, { wrote: 'right-bytes' }]))
      const listed = git(f.repo, ['worktree', 'list', '--porcelain'])
      const agentPaths = listed.split(/\r?\n/).filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9))
        .filter((path) => path.toLowerCase().includes('workflows') || path.toLowerCase().includes('wf-'))
      expect(agentPaths.length).toBeGreaterThanOrEqual(2)
      const contents = agentPaths.map((path) => existsSync(join(path, 'branch.txt')) ? readFileSync(join(path, 'branch.txt'), 'utf8') : '')
      expect(contents).toEqual(expect.arrayContaining(['left-bytes', 'right-bytes']))
      expect(contents.filter((item) => item === 'left-bytes').length).toBe(1)
      expect(contents.filter((item) => item === 'right-bytes').length).toBe(1)
      expect(existsSync(join(f.repo, 'branch.txt'))).toBe(false)
      expect(readFileSync(join(f.repo, 'PRIMARY.txt'), 'utf8')).toBe('primary-bytes')
      expect(git(f.repo, ['rev-parse', 'HEAD'])).toBe(f.primaryHead)
      const threadMeta = new ThreadWorkspaceManager(f.services.threads.getThreadDir(f.thread.id)).load()
      expect(threadMeta?.worktreePath).toBeTruthy()
      expect(realpathSync(threadMeta!.worktreePath)).not.toBe(realpathSync(f.repo))
      expect(agentPaths.every((path) => realpathSync(path) !== realpathSync(threadMeta!.worktreePath))).toBe(true)
    } finally { await f.close() }
  }, 45_000)

  it('reuses a cancelled invocation identity instead of creating another worktree', async () => {
    const f = await agentFixture()
    try {
      const created = f.services.platform.agentDefinitions.createDraft({
        settings: agentSettings('Recovery Agent', f.modelRef),
        systemPrompt: 'Write then wait.'
      })
      f.services.platform.agentDefinitions.publish(created.id, created.draftHash)
      const record = publishAgentWorkflow(f, created.id)
      const request = startRequest(f, record)
      await f.agents.prepare(request, record)
      const policy = policyOf(f)
      const manifest = runningManifest(f, request, policy)
      f.setManifest(manifest)
      const key = randomUUID()
      const controller = new AbortController()
      vi.mocked(f.services.providerAuth.models.streamSimple).mockImplementation((_model, context, options) => {
        f.captured.push(structuredClone(context))
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }))
          },
          result: async () => providerResponse([], 'aborted')
        } as never
      })
      const pending = f.agents.agent.invoke({
        context: contextOf(manifest),
        policy,
        agent: { kind: 'user', definitionId: created.id },
        instructions: 'Write branch.txt',
        input: {},
        signal: controller.signal,
        idempotencyKey: key
      })
      await vi.waitFor(() => expect(f.captured.length).toBe(1), { timeout: 12_000, interval: 20 })
      const afterDispatch = worktreeCount(f.repo)
      controller.abort()
      await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
      await expect(f.agents.agent.invoke({
        context: contextOf(manifest),
        policy,
        agent: { kind: 'user', definitionId: created.id },
        instructions: 'Write branch.txt',
        input: {},
        signal: new AbortController().signal,
        idempotencyKey: key
      })).rejects.toMatchObject({ code: 'cancelled' })
      expect(worktreeCount(f.repo)).toBe(afterDispatch)
    } finally { await f.close() }
  }, 45_000)

  it('does not upgrade a read-only Agent when assigning its isolated worktree', async () => {
    const f = await agentFixture()
    try {
      const settings = agentSettings('Read-only Agent', f.modelRef)
      settings.workspace.mode = 'read_only'
      const created = f.services.platform.agentDefinitions.createDraft({
        settings,
        systemPrompt: 'Try to write, then report the denial.'
      })
      f.services.platform.agentDefinitions.publish(created.id, created.draftHash)
      const record = publishAgentWorkflow(f, created.id)
      const request = startRequest(f, record)
      await f.agents.prepare(request, record)
      const policy = policyOf(f)
      const manifest = runningManifest(f, request, policy)
      f.setManifest(manifest)
      f.outputs.push(
        providerResponse([{ type: 'toolCall', id: 'readonly-w', name: 'write', arguments: { path: 'readonly.txt', content: 'must-not-write' } }], 'toolUse'),
        providerResponse([{ type: 'text', text: '{"denied":true}' }], 'stop')
      )
      const result = await f.agents.agent.invoke({
        context: contextOf(manifest), policy, agent: { kind: 'user', definitionId: created.id },
        instructions: 'Try to write readonly.txt', input: {}, signal: new AbortController().signal,
        idempotencyKey: randomUUID()
      })
      expect(result.output).toEqual({ denied: true })
      const toolResult = f.captured.at(-1)?.messages.find((message) => message.role === 'toolResult')
      expect(JSON.stringify(toolResult)).toMatch(/read-only/i)
      expect(existsSync(join(f.repo, 'readonly.txt'))).toBe(false)
    } finally { await f.close() }
  }, 45_000)

  it('rejects a durable Agent workspace record redirected outside its registered worktree', async () => {
    const f = await agentFixture()
    try {
      const context: ExecutionContext = {
        profileId: f.alice.id,
        threadId: f.thread.id,
        projectId: f.project.id,
        turnId: randomUUID(),
        actor: { kind: 'workflow', definitionId: randomUUID(), definitionRevision: 'fixture' },
        source: 'gui',
        policySnapshotId: randomUUID(),
        cancellationId: randomUUID()
      }
      const registrationRoot = join(f.services.getProfileHomeDir(), 'workflow-agent-bindings', 'workspaces')
      const key = randomUUID()
      const first = await provisionOwnedAgentWorkspace({
        owner: { profileId: f.alice.id, threads: f.services.threads, projects: f.services.projects },
        context, idempotencyKey: key, registrationRoot, scratchRoot: registrationRoot
      })
      const stored = JSON.parse(readFileSync(first.recordPath, 'utf8'))
      writeFileSync(first.recordPath, JSON.stringify({ ...stored, projectCwd: f.repo }))
      await expect(provisionOwnedAgentWorkspace({
        owner: { profileId: f.alice.id, threads: f.services.threads, projects: f.services.projects },
        context, idempotencyKey: key, registrationRoot, scratchRoot: registrationRoot
      })).rejects.toMatchObject({ code: 'thread_unavailable' })
    } finally { await f.close() }
  }, 45_000)

  it('keeps standalone agents on isolated scratch and refuses non-git projects', async () => {
    const f = await agentFixture()
    try {
      const standalone = f.services.threads.createThread('Standalone agent')
      const created = f.services.platform.agentDefinitions.createDraft({
        settings: agentSettings('Scratch Agent', f.modelRef),
        systemPrompt: 'Write scratch.txt'
      })
      f.services.platform.agentDefinitions.publish(created.id, created.draftHash)
      const record = publishAgentWorkflow(f, created.id)
      const request = startRequest(f, record)
      request.threadId = standalone.id
      request.projectId = undefined
      await f.agents.prepare(request, record)
      const policy = policyOf(f)
      const manifest = runningManifest(f, request, policy)
      f.setManifest(manifest)
      f.outputs.push(
        providerResponse([{ type: 'toolCall', id: 'scratch-w', name: 'write', arguments: { path: 'scratch.txt', content: 'scratch-bytes' } }], 'toolUse'),
        providerResponse([{ type: 'text', text: '{"ok":true}' }], 'stop')
      )
      const result = await f.agents.agent.invoke({
        context: contextOf(manifest),
        policy,
        agent: { kind: 'user', definitionId: created.id },
        instructions: 'Write scratch.txt',
        input: {},
        signal: new AbortController().signal,
        idempotencyKey: randomUUID()
      })
      expect(result.output).toEqual({ ok: true })
      expect(existsSync(join(f.repo, 'scratch.txt'))).toBe(false)

      const loose = join(f.root, 'loose')
      mkdirSync(loose)
      writeFileSync(join(loose, 'file.txt'), 'x')
      const looseProject = f.services.projects.openProject(loose)
      const looseThread = f.services.threads.createThread('Loose gitless', looseProject.id)
      const looseRequest = startRequest(f, record)
      looseRequest.threadId = looseThread.id
      looseRequest.projectId = looseProject.id
      await f.agents.prepare(looseRequest, record)
      const looseManifest = runningManifest(f, looseRequest, policy)
      f.setManifest(looseManifest)
      await expect(f.agents.agent.invoke({
        context: contextOf(looseManifest),
        policy,
        agent: { kind: 'user', definitionId: created.id },
        instructions: 'Write branch.txt',
        input: {},
        signal: new AbortController().signal,
        idempotencyKey: randomUUID()
      })).rejects.toMatchObject({ code: 'executor_unavailable' })
    } finally { await f.close() }
  }, 45_000)
})
