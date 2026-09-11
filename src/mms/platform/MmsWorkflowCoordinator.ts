import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExecutionContext, ExecutionPolicyLayer } from '../../shared/execution/types'
import { stableStringify, WORKFLOW_UUID_PATTERN, type CompiledGraph, type CompiledWorkflow, type StartWorkflowRequest, type WorkflowExecutionAdapters, type WorkflowRunSnapshot } from '../../shared/workflows'
import type { WorkflowRunStartParams } from '../../shared/workflowRunPlatform'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { executionThreadId, type ThreadDataStore } from '../data/ThreadDataStore'
import type { ProjectManager } from '../data/ProjectManager'
import { ApprovalService } from '../execution/ApprovalService'
import { CancellationRegistry } from '../execution/CancellationRegistry'
import { ExecutionPolicyService } from '../execution/ExecutionPolicyService'
import { FileArtifactStore } from '../execution/ArtifactStore'
import { DomainRpcError } from '../protocol/domainRegistry'
import { WorkflowRunService } from '../workflows/engine/WorkflowRunService'
import { sha256Utf8 } from '../workflows/hash'
import { checkBundleRelativePath, isInsideRoot } from '../workflows/pathSafety'
import type { WorkflowRegistry, WorkflowRecordSnapshot } from '../workflows/registry/WorkflowRegistry'
import type { WorkflowRunAdmission, WorkflowRunDomainServices } from '../workflows/registerRunMethods'
import { workflowJsonSchemaValidator } from '../workflows/schema/boundedJsonSchema'

interface AdmissionRecord {
  version: 1
  profileId: string
  digest: string
  executionKey?: string
  threadName: string
  request: StartWorkflowRequest
}
export interface MmsWorkflowCoordinatorOptions {
  profileId: string
  profileRoot: string
  threads: ThreadDataStore
  projects: ProjectManager
  registry: WorkflowRegistry
  adapters?: WorkflowExecutionAdapters
  installationPolicy?: (record: WorkflowRecordSnapshot, projectId?: string) => Promise<ExecutionPolicyLayer>
  onError?: (runId: string, error: unknown) => void
}

const ADAPTER_FOR_NODE: Record<string, keyof WorkflowExecutionAdapters> = {
  agent: 'agent', instruction: 'agent', tool: 'tool', 'mcp-tool': 'mcp', 'load-skill': 'skill',
  'browser-session': 'browser', 'browser-observe': 'browser', 'browser-action': 'browser', 'browser-extract': 'browser', 'browser-task': 'browser'
}
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])

/** One lifecycle per profile; durable admission never derives authority from the renderer. */
export class MmsWorkflowCoordinator implements WorkflowRunDomainServices {
  readonly profileId: string
  readonly runtime: WorkflowRunService
  readonly approvals: ApprovalService
  readonly cancellation = new CancellationRegistry()
  readonly policy = new ExecutionPolicyService()
  private readonly adapters: WorkflowExecutionAdapters
  private readonly admissionRoot: string
  private readonly subscriptions = new Map<string, { close(): void }>()
  private readonly wakeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private admissions: Promise<unknown> = Promise.resolve()
  private recovery?: Promise<void>
  private disposed = false

  constructor(private readonly options: MmsWorkflowCoordinatorOptions) {
    this.profileId = options.profileId
    if (options.registry.profileId !== this.profileId) throw new Error('Workflow registry profile mismatch')
    this.admissionRoot = join(options.profileRoot, 'workflow-admissions')
    mkdirSync(this.admissionRoot, { recursive: true })
    this.approvals = new ApprovalService(options)
    this.adapters = {
      ...options.adapters,
      workspace: { kind: 'workspace', readAuthorizedFile: (path, context) => this.readWorkspaceFile(path, context) },
      artifacts: new FileArtifactStore(options)
    }
    this.runtime = new WorkflowRunService({ ...options, policy: this.policy, cancellation: this.cancellation, adapters: this.adapters })
  }

  /** Trusted composition only. Existing run policy snapshots still cap adapter authority. */
  configureAdapters(adapters: Pick<WorkflowExecutionAdapters, 'agent' | 'tool' | 'mcp' | 'skill' | 'browser'>): void {
    this.assertActive()
    Object.assign(this.adapters, adapters)
  }

  startRecovery(): Promise<void> {
    this.assertActive()
    if (!this.recovery) this.recovery = this.recover()
    return this.recovery
  }

  async start(params: WorkflowRunStartParams, admission: WorkflowRunAdmission): Promise<WorkflowRunSnapshot> {
    this.assertActive()
    if (params.profileId !== this.profileId || !WORKFLOW_UUID_PATTERN.test(params.requestId)) throw new DomainRpcError('profile_mismatch', 'Workflow admission identity is invalid')
    await this.startRecovery()
    // The MMS installation lease owns this profile. Serialize async preparation
    // in that process; atomic durable records survive a process replacement.
    const started = this.admissions.then(() => this.admit(params, admission))
    this.admissions = started.catch(() => undefined)
    return started
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const timer of this.wakeTimers.values()) clearTimeout(timer)
    this.wakeTimers.clear()
    for (const subscription of this.subscriptions.values()) subscription.close()
    this.subscriptions.clear()
    await this.admissions
    await this.recovery?.catch(() => undefined)
    await this.runtime.shutdown()
  }

  private async admit(params: WorkflowRunStartParams, admission: WorkflowRunAdmission): Promise<WorkflowRunSnapshot> {
    this.assertActive()
    const path = join(this.admissionRoot, params.requestId + '.json')
    const digest = sha256Utf8(stableStringify({ params, source: admission.source }))
    let record: AdmissionRecord
    if (existsSync(path)) {
      record = JSON.parse(readFileSync(path, 'utf8')) as AdmissionRecord
      if (record.version !== 1 || record.profileId !== this.profileId || record.digest !== digest || record.request.requestId !== params.requestId) throw new DomainRpcError('WORKFLOW_CONCURRENCY_CONFLICT', 'This request identity was already used for a different workflow invocation')
      const existing = (await this.runtime.list({ profileId: this.profileId })).find((run) => run.requestId === params.requestId)
      if (existing && !this.options.threads.getThread(record.request.threadId)) throw new DomainRpcError('thread_unavailable', 'The original workflow thread was removed; start a new run explicitly')
    } else {
      const definition = this.resolveDefinition(params)
      this.preflight(definition.compiled)
      const input = workflowJsonSchemaValidator.validateData(definition.compiled.inputSchema, params.input)
      if (!input.ok) throw new DomainRpcError('invalid_input', input.diagnostics[0]?.message ?? 'Workflow input is invalid')
      const thread = params.threadId ? this.options.threads.getThread(params.threadId) : undefined
      if (params.threadId && (!thread || thread.id !== params.threadId || thread.settledAt)) throw new DomainRpcError('thread_unavailable', 'The selected thread is unavailable in this profile')
      const projectId = params.projectId ?? thread?.projectId
      if (thread && thread.projectId !== projectId) throw new DomainRpcError('project_mismatch', 'Workflow project must match its thread')
      if (projectId && !this.options.projects.getProject(projectId)) throw new DomainRpcError('project_unavailable', 'The selected project is unavailable in this profile')
      const executionKey = thread ? undefined : this.profileId + '/workflow/' + params.requestId
      const installationPolicy = this.options.installationPolicy ? await this.options.installationPolicy(definition, projectId) : this.defaultPolicy()
      this.assertActive()
      record = {
        version: 1, profileId: this.profileId, digest, executionKey, threadName: ('Workflow: ' + definition.compiled.name).slice(0, 120),
        request: {
          profileId: this.profileId, threadId: thread?.id ?? executionThreadId(executionKey!), projectId,
          requestId: params.requestId, actor: { kind: 'workflow', definitionId: definition.definitionId, definitionRevision: definition.semanticHash },
          source: admission.source, definitionId: definition.definitionId,
          ...(params.draft ? { expectedDraftSemanticHash: definition.semanticHash } : { revisionId: definition.semanticHash }),
          input: structuredClone(params.input), installationPolicy,
          runPolicy: {
            allowedCapabilities: definition.compiled.permissions,
            maxElapsedMs: definition.compiled.limits.timeoutMs,
            maxArtifactBytes: definition.compiled.limits.maxArtifactBytes
          }
        }
      }
      // Persist the chosen thread and policy before either thread creation or
      // engine admission. Retrying cannot resolve a newly published head.
      atomicWriteJsonSync(path, record)
    }
    this.assertActive()
    if (record.executionKey) this.options.threads.ensureExecutionThread(record.executionKey, record.threadName, record.request.projectId)
    this.ownedScope(record.request)
    const snapshot = await this.runtime.admit(record.request)
    await this.watch(snapshot.manifest.runId)
    return snapshot
  }

  private resolveDefinition(params: WorkflowRunStartParams): WorkflowRecordSnapshot {
    const row = this.options.registry.list().find((item) => item.source === 'profile' && item.id === params.definitionId && !item.archived && item.enabled)
    if (!row) throw new DomainRpcError('workflow_unavailable', 'Workflow is unavailable in this profile')
    const revisionId = params.revisionId ?? row.headRevisionId
    if (!params.draft && !revisionId) throw new DomainRpcError('stale_revision', 'Publish a workflow revision before running it from the library')
    const record = params.draft ? this.options.registry.get(params.definitionId) : this.options.registry.getRevision(params.definitionId, revisionId!)
    if (!record || (params.draft && record.semanticHash !== params.expectedDraftSemanticHash)) throw new DomainRpcError('stale_revision', 'The workflow revision changed or is unavailable')
    if (!record.compiled.runnable) throw new DomainRpcError('invalid_input', record.compiled.diagnostics.find((item) => item.severity === 'error')?.message ?? 'Workflow is not runnable')
    return record
  }

  private preflight(compiled: CompiledWorkflow): void {
    const visit = (graph: CompiledGraph): void => {
      for (const node of graph.nodes) {
        if (node.type === 'script' && node.config.executionMode === 'sandboxed' && !this.adapters.sandbox) {
          throw new DomainRpcError('executor_unavailable', 'No sandbox execution adapter is configured for node ' + node.id)
        }
        const adapter = ADAPTER_FOR_NODE[node.type]
        if (adapter && !this.adapters[adapter]) throw new DomainRpcError('executor_unavailable', 'No ' + adapter + ' execution adapter is configured for node ' + node.id)
        for (const nested of Object.values(node.subgraphs ?? {})) visit(nested)
      }
    }
    visit(compiled.graph)
  }

  private defaultPolicy(): ExecutionPolicyLayer {
    return {
      allowedTools: ['workflow.node', 'workflow.script', 'workflow.approval', ...(this.adapters.agent ? ['workflow.agent'] : []), ...(this.adapters.browser ? ['workflow.browser'] : [])],
      allowedCapabilities: ['script.trusted-local', 'human.input', 'human.approval', 'workspace.read', 'artifact.write', ...(this.adapters.agent ? ['model.invoke'] : []), ...(this.adapters.skill ? ['skill.load'] : [])],
      allowedEffects: ['pure', 'read', 'write', 'external', 'unknown'],
      approvalEffects: ['write', 'external', 'unknown']
    }
  }

  private ownedScope(context: Pick<ExecutionContext, 'profileId' | 'threadId' | 'projectId'>): string | undefined {
    this.assertActive()
    if (context.profileId !== this.profileId) throw new DomainRpcError('profile_mismatch', 'Workflow context belongs to another profile')
    const thread = this.options.threads.getThread(context.threadId)
    if (!thread || thread.id !== context.threadId || thread.settledAt || thread.projectId !== context.projectId) throw new DomainRpcError('thread_unavailable', 'Workflow thread ownership changed')
    const project = context.projectId ? this.options.projects.getProject(context.projectId) : undefined
    if (context.projectId && !project) throw new DomainRpcError('project_unavailable', 'Workflow project was removed')
    return project?.path
  }

  private async readWorkspaceFile(relativePath: string, context: ExecutionContext): Promise<{ bytes: Uint8Array; name: string }> {
    const root = this.ownedScope(context)
    if (!root) throw new DomainRpcError('project_required', 'Workspace file inputs require a project')
    const checked = checkBundleRelativePath(relativePath)
    if (!checked.ok) throw new DomainRpcError('invalid_input', checked.reason)
    const rootReal = realpathSync(root)
    let target = rootReal
    for (const segment of checked.segments) {
      target = join(target, segment)
      if (lstatSync(target).isSymbolicLink()) throw new DomainRpcError('invalid_input', 'Workflow file inputs cannot follow symbolic links')
    }
    const before = lstatSync(target)
    if (!before.isFile() || !isInsideRoot(rootReal, realpathSync(target))) throw new DomainRpcError('invalid_input', 'Workflow file input must be a regular project file')
    const handle = await open(target, 'r')
    try {
      const opened = await handle.stat()
      if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile() || opened.size > 16 * 1024 * 1024) throw new DomainRpcError('invalid_input', 'Workflow file input changed or exceeds 16 MiB')
      const buffer = Buffer.alloc(Math.min(opened.size + 1, 16 * 1024 * 1024 + 1))
      let offset = 0
      while (offset < buffer.length) {
        const read = await handle.read(buffer, offset, buffer.length - offset, offset)
        if (read.bytesRead === 0) break
        offset += read.bytesRead
      }
      if (offset > opened.size || !isInsideRoot(rootReal, realpathSync(target))) throw new DomainRpcError('invalid_input', 'Workflow file input changed while reading')
      this.ownedScope(context)
      return { bytes: buffer.subarray(0, offset), name: checked.relativePath }
    } finally { await handle.close() }
  }

  private async recover(): Promise<void> {
    const runs = await this.runtime.list({ profileId: this.profileId })
    for (const run of runs) {
      if (this.disposed) return
      if (TERMINAL.has(run.state)) continue
      await this.watch(run.runId)
      if (run.parentRunId || !['queued', 'running'].includes(run.state)) continue
      try {
        this.ownedScope(run)
        await this.runtime.resume(run.runId, { profileId: this.profileId, deferExecution: true })
      } catch (error) { this.options.onError?.(run.runId, error) }
    }
  }

  private async watch(runId: string): Promise<void> {
    if (this.disposed || this.subscriptions.has(runId)) return
    this.subscriptions.set(runId, this.runtime.subscribe(runId, { profileId: this.profileId }, (snapshot) => this.scheduleWake(snapshot)))
    this.scheduleWake(await this.runtime.get(runId, { profileId: this.profileId }))
  }

  private scheduleWake(snapshot: WorkflowRunSnapshot, notBefore = 0): void {
    const { runId, state, parentRunId } = snapshot.manifest
    const previous = this.wakeTimers.get(runId)
    if (previous) clearTimeout(previous)
    this.wakeTimers.delete(runId)
    if (this.disposed || TERMINAL.has(state)) {
      this.subscriptions.get(runId)?.close()
      this.subscriptions.delete(runId)
      return
    }
    // The parent driver owns subworkflow progress and its budget/cancellation.
    if (parentRunId || state !== 'waiting-condition' || !snapshot.wakeAt) return
    const at = Date.parse(snapshot.wakeAt)
    if (!Number.isFinite(at)) { this.options.onError?.(runId, new Error('Invalid workflow wake time')); return }
    const timer = setTimeout(() => {
      this.wakeTimers.delete(runId)
      void this.wake(runId).catch((error) => this.options.onError?.(runId, error))
    }, Math.max(5, Math.min(2_147_000_000, Math.max(at, notBefore) - Date.now())))
    timer.unref()
    this.wakeTimers.set(runId, timer)
  }

  private async wake(runId: string): Promise<void> {
    if (this.disposed) return
    const current = await this.runtime.get(runId, { profileId: this.profileId })
    if (current.manifest.state !== 'waiting-condition') return
    this.ownedScope(current.manifest)
    try {
      const next = await this.runtime.tick(runId, { profileId: this.profileId, deferExecution: true })
      this.scheduleWake(next)
    } catch (error) {
      // Another admitted control request can briefly own the same durable lease.
      // Re-read state before retrying; cancellation or a changed wait wins.
      if (error instanceof Error && error.message.includes('is leased by pid')) {
        this.scheduleWake(await this.runtime.get(runId, { profileId: this.profileId }), Date.now() + 250)
        return
      }
      throw error
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new DomainRpcError('profile_unavailable', 'Workflow services for this profile are stopped')
  }
}
