import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { ExecutionContext, ExecutionPolicyLayer, ExecutionPolicySnapshot } from '../../../shared/execution/types'
import type {
  CompiledGraph,
  CompiledNode,
  CompiledWorkflow,
  StartWorkflowRequest,
  WorkflowClock,
  WorkflowExecutionAdapters,
  WorkflowFaultHooks,
  WorkflowFileInputDeclaration,
  WorkflowJournalEvent,
  WorkflowNodeAttempt,
  WorkflowRunManifest,
  WorkflowRunSnapshot,
  WorkflowRunState,
  WorkflowRuntimePort,
  WorkflowTrace
} from '../../../shared/workflows'
import { getNodeCatalogEntry, isPlainObject, parseWorkflowBinding } from '../../../shared/workflows'
import { CancellationRegistry } from '../../execution/CancellationRegistry'
import { ExecutionPolicyService } from '../../execution/ExecutionPolicyService'
import { ApprovalService } from '../../execution/ApprovalService'
import { FileArtifactStore } from '../../execution/ArtifactStore'
import { ScriptRunner } from '../../execution/ScriptRunner'
import { UnconfiguredSandboxAdapter, isSandboxUnavailable } from '../../execution/SandboxAdapter'
import { workflowJsonSchemaValidator } from '../schema/boundedJsonSchema'
import { WorkflowRegistry } from '../registry/WorkflowRegistry'
import { loadWorkflowDirectory, writeWorkflowDirectory } from '../bundleIo'
import { compileWorkflow } from '../compiler/compileWorkflow'
import { sha256Utf8 } from '../hash'
import { collectScopeOutputs, evaluateConfigBinding, evaluateConfigExpression, evaluateNodeInputs, instanceKey, nodeEvalContext } from './bindings'
import { stageFileInputs } from './fileInputs'
import { WorkflowRunStore, type AttemptIntent, type InstanceRecord, type RunCheckpoint, type RunLease } from './runStore'

const PURE_TYPES = new Set([
  'start',
  'end',
  'transform',
  'select-fields',
  'filter',
  'reduce',
  'format',
  'condition',
  'switch',
  'prompt-template',
  'for-each',
  'bounded-repeat',
  'parallel',
  'join',
  'try-catch',
  'finally',
  'fail',
  'delay',
  'wait-for-condition',
  'note',
  'group'
])

const ADAPTER_TYPES: Record<string, keyof WorkflowExecutionAdapters> = {
  agent: 'agent',
  instruction: 'agent',
  tool: 'tool',
  'mcp-tool': 'mcp',
  'load-skill': 'skill',
  'browser-session': 'browser',
  'browser-observe': 'browser',
  'browser-action': 'browser',
  'browser-extract': 'browser',
  'browser-task': 'browser'
}

export interface WorkflowRunServiceOptions {
  profileId: string
  profileRoot: string
  registry: WorkflowRegistry
  policy: ExecutionPolicyService
  cancellation: CancellationRegistry
  adapters?: WorkflowExecutionAdapters
  clock?: WorkflowClock
  faults?: WorkflowFaultHooks
  now?: () => Date
}

const defaultClock: WorkflowClock = {
  now: () => new Date(),
  wait: (ms, signal) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => {
        clearTimeout(t)
        reject(new Error('cancelled'))
      }, { once: true })
    })
}

export class WorkflowRunService implements WorkflowRuntimePort {
  readonly profileId: string
  private readonly registry: WorkflowRegistry
  private readonly policy: ExecutionPolicyService
  private readonly cancellation: CancellationRegistry
  private readonly adapters: WorkflowExecutionAdapters
  private readonly store: WorkflowRunStore
  private readonly approvals: ApprovalService
  private readonly artifacts: FileArtifactStore
  private readonly scripts: ScriptRunner
  private readonly clock: WorkflowClock
  private readonly faults?: WorkflowFaultHooks
  private readonly nowFn: () => Date
  private readonly listeners = new Map<string, Set<(snapshot: WorkflowRunSnapshot) => void>>()
  private readonly activeDrivers = new Map<string, Promise<WorkflowRunSnapshot>>()
  private readonly pauseRequested = new Set<string>()
  private readonly checkpointWrites = new Map<string, Promise<void>>()
  private shuttingDown = false

  constructor(options: WorkflowRunServiceOptions) {
    if (!options.profileId) throw new Error('WorkflowRunService requires profileId')
    if (!options.profileRoot) throw new Error('WorkflowRunService requires profileRoot')
    if (options.registry.profileId !== options.profileId) {
      throw new Error('Registry profileId must match WorkflowRunService profileId')
    }
    this.profileId = options.profileId
    this.registry = options.registry
    this.policy = options.policy
    this.cancellation = options.cancellation
    this.adapters = options.adapters ?? {}
    this.store = new WorkflowRunStore({ profileId: options.profileId, profileRoot: options.profileRoot })
    this.approvals = new ApprovalService({ profileId: options.profileId, profileRoot: options.profileRoot })
    this.artifacts = new FileArtifactStore({ profileId: options.profileId, profileRoot: options.profileRoot })
    this.scripts = new ScriptRunner(options.adapters?.interpreters)
    this.clock = options.clock ?? defaultClock
    this.faults = options.faults
    this.nowFn = options.now ?? (() => this.clock.now())
  }

  async start(request: StartWorkflowRequest): Promise<WorkflowRunSnapshot> {
    if (this.shuttingDown) throw new Error('Workflow runtime is shutting down')
    this.assertOwner(request.profileId)
    const resolved = this.resolveDefinition(request)
    const compiled = resolved.compiled
    if (!compiled.runnable) {
      throw Object.assign(new Error(compiled.diagnostics.find((d) => d.severity === 'error')?.message ?? 'not runnable'), {
        code: 'invalid_input'
      })
    }
    const inputCheck = workflowJsonSchemaValidator.validateData(compiled.inputSchema, request.input)
    if (!inputCheck.ok) {
      throw Object.assign(new Error(inputCheck.diagnostics[0]?.message ?? 'invalid input'), { code: 'invalid_input' })
    }
    const policy = this.policy.snapshot(this.profileId, request.installationPolicy, request.runPolicy ?? {})
    const cancel = this.cancellation.create(this.profileId, request.parentCancellationId)
    const runId = randomUUID()
    const now = this.iso()
    const manifest: WorkflowRunManifest = {
      schemaVersion: 1,
      runId,
      profileId: this.profileId,
      threadId: request.threadId,
      projectId: request.projectId,
      definitionId: resolved.definitionId,
      revisionId: resolved.revisionId,
      semanticHash: resolved.semanticHash,
      slug: compiled.slug,
      policySnapshotId: policy.id,
      cancellationId: cancel.id,
      actor: request.actor,
      source: request.source,
      trigger: request.trigger,
      state: 'queued',
      journalSeq: 0,
      limits: compiled.limits,
      budgets: {
        elapsedMs: 0,
        toolCalls: 0,
        tokens: 0,
        cost: 0,
        artifactBytes: 0,
        maxElapsedMs: policy.maxElapsedMs,
        maxToolCalls: policy.maxToolCalls,
        maxArtifactBytes: policy.maxArtifactBytes
      },
      parentRunId: request.parentRunId,
      parentInstanceKey: request.parentInstanceKey,
      depth: request.depth ?? 0,
      draftSemanticHash: request.expectedDraftSemanticHash,
      createdAt: now,
      updatedAt: now
    }
    const entry = compiled.graph.entryNodeId
    const checkpoint: RunCheckpoint = {
      seq: 0,
      ready: [entry],
      instances: {
        [entry]: {
          instanceKey: entry,
          nodeId: entry,
          type: 'start',
          path: '',
          status: 'ready',
          attempt: 0
        }
      },
      outputs: {}
    }
    const { lease } = this.store.create(manifest, checkpoint)
    try {
      writeWorkflowDirectory(join(this.store.runDir(runId), 'bundle'), resolved.bundle)
      writeFileSync(join(this.store.runDir(runId), 'input.json'), `${JSON.stringify(request.input)}\n`)
      writeFileSync(join(this.store.runDir(runId), 'policy.json'), `${JSON.stringify(policy)}\n`)
      this.append(manifest, lease, 'run-accepted', { revisionId: resolved.revisionId })
      if (request.deferExecution) {
        this.store.release(runId, lease.token)
        this.scheduleDrive(runId)
        return this.snapshot(runId)
      }
      const driven = this.drive(runId, lease.token, request.input, compiled, policy)
      this.activeDrivers.set(runId, driven)
      try {
        return await driven
      } finally {
        if (this.activeDrivers.get(runId) === driven) this.activeDrivers.delete(runId)
      }
    } finally {
      this.store.release(runId, lease.token)
    }
  }

  async admit(request: StartWorkflowRequest): Promise<WorkflowRunSnapshot> {
    return this.start({ ...request, deferExecution: true })
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    const pending = [...this.activeDrivers.keys()]
    for (const runId of pending) {
      try {
        const manifest = this.store.readManifest(runId)
        this.pauseRequested.add(runId)
        this.cancellation.restore(this.profileId, manifest.cancellationId)
        this.cancellation.abort(this.profileId, manifest.cancellationId, 'runtime shutdown')
      } catch {
        // A run may have completed between the inventory and cancellation.
      }
    }
    await Promise.allSettled([...this.activeDrivers.values()])
    this.activeDrivers.clear()
  }

  private scheduleDrive(runId: string): void {
    const existing = this.activeDrivers.get(runId)
    if (existing) return
    const promise = (async () => {
      const lease = await this.acquireAfterCancellation(runId)
      try {
        const manifest = this.store.readManifest(runId)
        const input = JSON.parse(readFileSync(join(this.store.runDir(runId), 'input.json'), 'utf8'))
        const policy = JSON.parse(readFileSync(join(this.store.runDir(runId), 'policy.json'), 'utf8')) as ExecutionPolicySnapshot
        return await this.drive(runId, lease.token, input, this.loadCompiled(runId), policy)
      } finally {
        this.store.release(runId, lease.token)
      }
    })()
    this.activeDrivers.set(runId, promise)
    void promise.finally(() => {
      if (this.activeDrivers.get(runId) === promise) this.activeDrivers.delete(runId)
    })
  }

  async get(runId: string, owner: { profileId: string }): Promise<WorkflowRunSnapshot> {
    this.assertOwner(owner.profileId)
    return this.snapshot(runId)
  }

  async list(query: { profileId: string; threadId?: string }): Promise<WorkflowRunManifest[]> {
    this.assertOwner(query.profileId)
    return this.store
      .listRunIds()
      .map((id) => this.store.readManifest(id))
      .filter((manifest) => manifest.profileId === this.profileId && (!query.threadId || manifest.threadId === query.threadId))
  }

  async trace(runId: string, owner: { profileId: string }): Promise<WorkflowTrace> {
    this.assertOwner(owner.profileId)
    const snap = this.snapshot(runId)
    return {
      runId,
      state: snap.manifest.state,
      events: this.store.readJournal(runId),
      attempts: snap.attempts,
      nodeOutputs: snap.outputs
    }
  }

  async pause(runId: string, owner: { profileId: string }): Promise<WorkflowRunSnapshot> {
    this.assertOwner(owner.profileId)
    if (this.activeDrivers.has(runId)) {
      this.pauseRequested.add(runId)
      const manifest = this.store.readManifest(runId)
      this.cancellation.restore(this.profileId, manifest.cancellationId)
      this.cancellation.abort(this.profileId, manifest.cancellationId, 'paused')
      await this.activeDrivers.get(runId)
      this.pauseRequested.delete(runId)
      return this.snapshot(runId)
    }
    const lease = this.store.acquire(runId, this.iso())
    try {
      const manifest = this.store.readManifest(runId)
      if (manifest.state === 'running') this.store.setState(manifest, 'interrupted', this.iso())
      this.store.writeManifest(manifest, lease.token)
      return this.snapshot(runId)
    } finally {
      this.store.release(runId, lease.token)
    }
  }

  async resume(runId: string, owner: { profileId: string } & { reconcile?: 'retry' | 'abandon' }): Promise<WorkflowRunSnapshot> {
    this.assertOwner(owner.profileId)
    const lease = this.store.acquire(runId, this.iso())
    try {
      const manifest = this.store.readManifest(runId)
      const checkpoint = this.store.readCheckpoint(runId)
      if (manifest.state === 'succeeded' || manifest.state === 'failed' || manifest.state === 'cancelled') {
        return this.snapshot(runId)
      }
      if (manifest.state === 'unknown-effect') {
        if (owner.reconcile === 'abandon') {
          this.store.setState(manifest, 'failed', this.iso(), 'unknown effect abandoned')
          this.store.writeManifest(manifest, lease.token)
          return this.snapshot(runId)
        }
        if (owner.reconcile !== 'retry') return this.snapshot(runId)
        const unresolved = Object.values(checkpoint.intents ?? {}).find((intent) => intent.prepared && !intent.completed)
        if (unresolved && !this.isRetryableEffect(unresolved.effect)) {
          return this.snapshot(runId)
        }
      }
      const compiled = this.loadCompiled(runId)
      const input = JSON.parse(readFileSync(join(this.store.runDir(runId), 'input.json'), 'utf8'))
      const policy = JSON.parse(readFileSync(join(this.store.runDir(runId), 'policy.json'), 'utf8')) as ExecutionPolicySnapshot
      if (manifest.state === 'waiting-condition' && checkpoint.wakeAt && Date.parse(checkpoint.wakeAt) > this.nowFn().getTime()) {
        return this.snapshot(runId)
      }
      this.store.setState(manifest, 'running', this.iso())
      this.store.writeManifest(manifest, lease.token)
      const driven = this.drive(runId, lease.token, input, compiled, policy)
      this.activeDrivers.set(runId, driven)
      try {
        return await driven
      } finally {
        if (this.activeDrivers.get(runId) === driven) this.activeDrivers.delete(runId)
      }
    } finally {
      this.store.release(runId, lease.token)
    }
  }

  async tick(runId: string, owner: { profileId: string }): Promise<WorkflowRunSnapshot> {
    return this.resume(runId, owner)
  }

  async approve(
    runId: string,
    owner: { profileId: string },
    decision: { approvalId: string; approved: boolean; actorId: string }
  ): Promise<WorkflowRunSnapshot> {
    this.assertOwner(owner.profileId)
    const requestedApproval = this.approvals.get(decision.approvalId, owner.profileId)
    if (!requestedApproval) throw new Error(`Approval ${decision.approvalId} not found`)
    this.approvals.decide({
      approvalId: decision.approvalId,
      profileId: owner.profileId,
      expectedRunId: runId,
      actorId: decision.actorId,
      approved: decision.approved,
      now: this.iso(),
      expectedDigest: requestedApproval.requestDigest
    })
    if (!decision.approved) {
      const lease = this.store.acquire(runId, this.iso())
      try {
        const manifest = this.store.readManifest(runId)
        this.store.setState(manifest, 'failed', this.iso(), 'approval denied')
        this.store.writeManifest(manifest, lease.token)
        this.cancellation.restore(this.profileId, manifest.cancellationId)
        this.cancellation.abort(this.profileId, manifest.cancellationId, 'approval denied')
        return this.snapshot(runId)
      } finally {
        this.store.release(runId, lease.token)
      }
    }
    return this.resume(runId, owner)
  }

  async answer(
    runId: string,
    owner: { profileId: string },
    answer: { instanceKey: string; data: unknown }
  ): Promise<WorkflowRunSnapshot> {
    this.assertOwner(owner.profileId)
    const lease = this.store.acquire(runId, this.iso())
    try {
      const checkpoint = this.store.readCheckpoint(runId)
      if (!checkpoint.pendingInput || checkpoint.pendingInput.instanceKey !== answer.instanceKey) {
        throw new Error('No matching pending input')
      }
      if (checkpoint.pendingInput.schema) {
        const check = workflowJsonSchemaValidator.validateData(checkpoint.pendingInput.schema as never, answer.data)
        if (!check.ok) throw new Error(check.diagnostics[0]?.message ?? 'invalid answer')
      }
      checkpoint.outputs[answer.instanceKey] = answer.data
      const inst = checkpoint.instances[answer.instanceKey]
      if (inst) {
        inst.status = 'succeeded'
        inst.output = answer.data
        inst.port = 'success'
        this.enqueueSuccessors(runId, checkpoint, answer.instanceKey, 'success')
      } else {
        const nestedEntry = Object.values(checkpoint.nested ?? {})
          .find((nested) => nested.instances[answer.instanceKey])
        const nestedInst = nestedEntry?.instances[answer.instanceKey]
        if (!nestedEntry || !nestedInst) throw new Error('No matching pending input cursor')
        nestedInst.status = 'succeeded'
        nestedInst.output = answer.data
        nestedInst.port = 'success'
        nestedEntry.ready = nestedEntry.ready.filter((key) => key !== answer.instanceKey)
        nestedEntry.outputs[answer.instanceKey] = answer.data
        const graph = findGraphContaining(this.loadCompiled(runId).graph, nestedInst.nodeId)
        if (graph) {
          for (const edge of graph.edges.filter((item) => item.from === nestedInst.nodeId && item.port === 'success')) {
            const key = instanceKey(nestedInst.path, edge.to)
            if (!nestedEntry.instances[key]) {
              nestedEntry.instances[key] = {
                instanceKey: key,
                nodeId: edge.to,
                type: findNode(graph, edge.to)?.type ?? 'transform',
                path: nestedInst.path,
                status: 'ready',
                attempt: 0
              }
            } else {
              nestedEntry.instances[key]!.status = 'ready'
            }
            if (!nestedEntry.ready.includes(key)) nestedEntry.ready.push(key)
          }
        }
        for (const root of Object.values(checkpoint.instances)) {
          if (root.status === 'waiting') {
            root.status = 'ready'
            if (!checkpoint.ready.includes(root.instanceKey)) checkpoint.ready.unshift(root.instanceKey)
          }
        }
      }
      checkpoint.pendingInput = undefined
      this.store.writeCheckpoint(runId, checkpoint, lease.token)
    } finally {
      this.store.release(runId, lease.token)
    }
    return this.resume(runId, owner)
  }

  async cancel(runId: string, owner: { profileId: string }, reason = 'cancelled'): Promise<WorkflowRunSnapshot> {
    this.assertOwner(owner.profileId)
    const before = this.store.readManifest(runId)
    this.cancellation.restore(this.profileId, before.cancellationId)
    this.cancellation.abort(this.profileId, before.cancellationId, reason)
    const lease = await this.acquireAfterCancellation(runId)
    try {
      const manifest = this.store.readManifest(runId)
      for (const open of this.approvals.listOpen(this.profileId, runId)) {
        this.approvals.revoke(open.approvalId, this.profileId, this.iso())
      }
      this.store.setState(manifest, 'cancelled', this.iso(), reason)
      this.store.writeManifest(manifest, lease.token)
      return this.snapshot(runId)
    } finally {
      this.store.release(runId, lease.token)
    }
  }

  subscribe(
    runId: string,
    owner: { profileId: string },
    listener: (snapshot: WorkflowRunSnapshot) => void
  ): { close(): void } {
    this.assertOwner(owner.profileId)
    const set = this.listeners.get(runId) ?? new Set()
    set.add(listener)
    this.listeners.set(runId, set)
    return {
      close: () => {
        set.delete(listener)
      }
    }
  }

  private async drive(
    runId: string,
    token: string,
    input: unknown,
    compiled: CompiledWorkflow,
    policy: ExecutionPolicySnapshot
  ): Promise<WorkflowRunSnapshot> {
    const heartbeat = setInterval(() => {
      try {
        this.store.heartbeat(runId, token, this.iso())
      } catch {
        try {
          const manifest = this.store.readManifest(runId)
          this.cancellation.restore(this.profileId, manifest.cancellationId)
          this.cancellation.abort(this.profileId, manifest.cancellationId, 'run lease lost')
        } catch {
          // The next ownership-checked write will surface a lost or unreadable lease.
        }
      }
    }, 10_000)
    heartbeat.unref()
    try {
      const started = Date.now()
      let manifest = this.store.readManifest(runId)
      let checkpoint = this.store.readCheckpoint(runId)
      const elapsedAtStart = manifest.budgets.elapsedMs
      manifest.journalSeq = Math.max(
        manifest.journalSeq,
        ...this.store.readJournal(runId).map((event) => event.seq)
      )
    this.recoverUnknown(runId, manifest, checkpoint)
    if (manifest.state === 'unknown-effect') {
      this.store.writeManifest(manifest, token)
      this.store.writeCheckpoint(runId, checkpoint, token)
      return this.snapshot(runId)
    }
    if (manifest.state === 'succeeded' || manifest.state === 'failed' || manifest.state === 'cancelled') {
      this.store.writeManifest(manifest, token)
      this.store.writeCheckpoint(runId, checkpoint, token)
      return this.snapshot(runId)
    }
    this.store.setState(manifest, 'running', this.iso())
    this.append(manifest, { token } as RunLease, 'run-started', {})
    this.store.writeManifest(manifest, token)
    this.requeueWaiting(checkpoint, manifest)
    if (checkpoint.wakeAt && Object.values(checkpoint.instances).some((inst) => inst.retryAt === checkpoint.wakeAt) &&
      Date.parse(checkpoint.wakeAt) <= this.nowFn().getTime()) checkpoint.wakeAt = undefined
    const ctx = this.executionContext(manifest)
    const signal = this.cancellation.restore(this.profileId, manifest.cancellationId)
    const maxConcurrency = compiled.limits.maxConcurrency ?? 4

    while (manifest.state === 'running' && !signal.aborted) {
      if (!this.budget(manifest, started, elapsedAtStart, policy)) break
      const nowMs = this.nowFn().getTime()
      const ready = checkpoint.ready.filter((key) => {
        const candidate = checkpoint.instances[key]
        return candidate?.status === 'ready' && (!candidate.retryAt || Date.parse(candidate.retryAt) <= nowMs)
      })
      if (ready.length === 0) {
        const retryAt = Object.values(checkpoint.instances)
          .map((inst) => inst.retryAt ? Date.parse(inst.retryAt) : 0)
          .filter((at) => at > nowMs)
          .sort((a, b) => a - b)[0]
        if (retryAt) {
          checkpoint.wakeAt = new Date(retryAt).toISOString()
          manifest.state = 'waiting-condition'
          break
        }
        if (Object.values(checkpoint.instances).some((inst) => inst.status === 'waiting')) break
        if (!this.hasPendingWork(checkpoint, compiled.graph)) {
          this.store.setState(manifest, 'failed', this.iso(), 'graph has no ready nodes and is not waiting')
          break
        }
        break
      }
      const batch = ready.slice(0, maxConcurrency)
      checkpoint.ready = checkpoint.ready.filter((key) => !batch.includes(key))
      const executions = await Promise.all(batch.map(async (key) => {
        const inst = checkpoint.instances[key]!
        inst.status = 'running'
        inst.attempt += 1
        try {
          const node = findNode(graphForPath(compiled.graph, inst.path), inst.nodeId)
          const retryPolicy = node?.retry
          let result: Awaited<ReturnType<WorkflowRunService['executeInstance']>>
          for (;;) {
            result = await this.executeInstance(runId, token, manifest, checkpoint, compiled, policy, ctx, signal, input, inst)
            const canRetry = result.kind === 'fail' && !result.unknown && retryPolicy && node &&
              inst.attempt < retryPolicy.maxAttempts && this.isRetryableEffect(this.effectFor(node))
            if (!canRetry) break
            if (checkpoint.intents) delete checkpoint.intents[key]
            const backoff = Math.min(
              Number(retryPolicy?.backoffMs ?? 0) * Math.max(1, 2 ** Math.max(0, inst.attempt - 1)),
              60_000
            )
            inst.retryAt = new Date(this.nowFn().getTime() + backoff).toISOString()
            inst.status = 'ready'
            if (!checkpoint.ready.includes(key)) checkpoint.ready.push(key)
            await this.persistCheckpoint(runId, checkpoint, token)
            if (backoff > 0) await this.clock.wait(backoff, signal)
            if (signal.aborted) break
            inst.retryAt = undefined
            inst.attempt += 1
          }
          this.faults?.afterResult?.(key)
          return { key, result } as const
        } catch (error) {
          return { key, error } as const
        }
      }))
      for (const execution of executions) {
        const key = execution.key
        const inst = checkpoint.instances[key]!
        try {
          if ('error' in execution) throw execution.error
          const result = execution.result
          if (signal.aborted) {
            inst.status = 'ready'
            inst.error = this.pauseRequested.has(runId) || this.shuttingDown ? 'paused' : 'cancelled'
            this.store.setState(
              manifest,
              this.pauseRequested.has(runId) || this.shuttingDown ? 'interrupted' : 'cancelled',
              this.iso(),
              inst.error
            )
            break
          }
          if (result.kind === 'wait') {
            inst.status = 'waiting'
            manifest.state = result.state
            checkpoint.pendingApprovalId = result.approvalId
            checkpoint.pendingInput = result.pendingInput
            checkpoint.wakeAt = result.wakeAt
            break
          }
          if (result.kind === 'skip') {
            inst.status = 'skipped'
            this.skipDescendants(checkpoint, compiled.graph, inst.nodeId, inst.path)
            continue
          }
          if (result.kind === 'fail') {
            inst.status = 'failed'
            inst.error = result.error
            if (result.unknown) {
              this.store.setState(manifest, 'unknown-effect', this.iso(), result.error)
            } else {
              this.store.setState(manifest, 'failed', this.iso(), result.error)
            }
            break
          }
          inst.status = 'succeeded'
          inst.output = result.output
          inst.port = result.port
          checkpoint.outputs[key] = result.output
          const artifactValues = this.collectArtifacts(result.output)
          if (artifactValues.length) {
            checkpoint.artifacts = [...(checkpoint.artifacts ?? []), ...artifactValues.filter((item) =>
              !(checkpoint.artifacts ?? []).some((existing) => existing.id === item.id)
            )]
          }
          this.store.writeResult(runId, key, result.output, token)
          if (inst.type === 'end' && inst.path === '') {
            const outCheck = workflowJsonSchemaValidator.validateData(compiled.outputSchema, result.output)
            if (!outCheck.ok) {
              this.store.setState(manifest, 'failed', this.iso(), outCheck.diagnostics[0]?.message ?? 'invalid output')
              break
            }
            checkpoint.result = result.output
            this.store.setState(manifest, 'succeeded', this.iso())
            break
          }
          if (inst.type === 'fail') {
            this.store.setState(manifest, 'failed', this.iso(), String(result.output ?? 'fail'))
            break
          }
          this.enqueueSuccessors(runId, checkpoint, key, result.port)
        } catch (error) {
          inst.status = 'failed'
          const message = error instanceof Error ? error.message : String(error)
          const intent = checkpoint.intents?.[key]
          const durable = checkpoint.results?.[key]
          if (signal.aborted && inst.retryAt) {
            inst.status = 'ready'
            this.store.setState(manifest, 'interrupted', this.iso(), 'retry backoff interrupted')
          } else if (intent?.completed && durable?.outcome === 'succeeded') {
            inst.status = 'succeeded'
            inst.output = durable.output
            inst.port = durable.port ?? 'success'
            checkpoint.outputs[key] = durable.output
            if (inst.type === 'end' && inst.path === '') {
              checkpoint.result = durable.output
              this.store.setState(manifest, 'succeeded', this.iso())
            } else {
              this.enqueueSuccessors(runId, checkpoint, key, inst.port)
            }
          } else if (intent?.prepared && intent.completed) {
            if (this.isRetryableEffect(intent.effect)) {
              if (checkpoint.intents) delete checkpoint.intents[key]
              inst.status = 'ready'
              if (!checkpoint.ready.includes(inst.instanceKey)) checkpoint.ready.unshift(inst.instanceKey)
            } else {
              this.store.setState(manifest, 'unknown-effect', this.iso(), message)
            }
          } else if (intent?.prepared && !intent.completed) {
            if (this.isRetryableEffect(intent.effect)) {
              inst.status = 'ready'
              if (!checkpoint.ready.includes(inst.instanceKey)) checkpoint.ready.unshift(inst.instanceKey)
            } else {
              this.store.setState(manifest, 'unknown-effect', this.iso(), message)
            }
          } else {
            this.store.setState(manifest, 'failed', this.iso(), message)
          }
          break
        }
      }
      checkpoint.seq += 1
      this.store.writeCheckpoint(runId, checkpoint, token)
      this.faults?.afterCheckpoint?.(runId)
      this.store.writeManifest(manifest, token)
      this.emit(runId)
      if (manifest.state !== 'running') break
    }
    if (signal.aborted && manifest.state === 'running') {
      this.store.setState(
        manifest,
        this.pauseRequested.has(runId) || this.shuttingDown ? 'interrupted' : 'cancelled',
        this.iso(),
        this.pauseRequested.has(runId) || this.shuttingDown ? 'paused' : 'cancelled'
      )
    }
    this.store.writeManifest(manifest, token)
    this.store.writeCheckpoint(runId, checkpoint, token)
    this.emit(runId)
      return this.snapshot(runId)
    } finally {
      clearInterval(heartbeat)
      this.store.release(runId, token)
    }
  }

  private recoverUnknown(runId: string, manifest: WorkflowRunManifest, checkpoint: RunCheckpoint): void {
    for (const intent of Object.values(checkpoint.intents ?? {})) {
      if (!intent.completed) continue
      const durable = checkpoint.results?.[intent.instanceKey]
      const inst = checkpoint.instances[intent.instanceKey]
      const nestedEntry = Object.values(checkpoint.nested ?? {}).find((nested) => nested.instances[intent.instanceKey])
      const nestedInst = nestedEntry?.instances[intent.instanceKey]
      if (!durable || durable.outcome !== 'succeeded' || (!inst && !nestedInst)) continue
      if (!inst && nestedInst && nestedEntry) {
        nestedInst.status = 'succeeded'
        nestedInst.output = durable.output
        nestedInst.port = durable.port ?? 'success'
        nestedEntry.outputs[intent.instanceKey] = durable.output
        nestedEntry.ready = nestedEntry.ready.filter((key) => key !== intent.instanceKey)
        const graph = findGraphContaining(this.loadCompiled(runId).graph, nestedInst.nodeId)
        for (const edge of graph?.edges.filter((item) => item.from === nestedInst.nodeId && item.port === nestedInst.port) ?? []) {
          const key = instanceKey(nestedInst.path, edge.to)
          if (!nestedEntry.instances[key]) {
            nestedEntry.instances[key] = {
              instanceKey: key,
              nodeId: edge.to,
              type: findNode(graph!, edge.to)?.type ?? 'transform',
              path: nestedInst.path,
              status: 'ready',
              attempt: 0
            }
          }
          if (!nestedEntry.ready.includes(key)) nestedEntry.ready.push(key)
        }
        delete checkpoint.intents![intent.instanceKey]
        continue
      }
      inst.status = 'succeeded'
      inst.output = durable.output
      inst.port = durable.port ?? 'success'
      checkpoint.outputs[intent.instanceKey] = durable.output
      if (inst.type === 'end' && inst.path === '') {
        checkpoint.result = durable.output
        this.store.setState(manifest, 'succeeded', this.iso())
      } else {
        this.enqueueSuccessors(runId, checkpoint, intent.instanceKey, inst.port)
      }
      delete checkpoint.intents![intent.instanceKey]
    }
    const unresolved = Object.values(checkpoint.intents ?? {}).filter((intent) => intent.prepared && !intent.completed)
    for (const intent of unresolved) {
      if (this.isRetryableEffect(intent.effect)) {
        const nestedEntry = Object.values(checkpoint.nested ?? {})
          .find((nested) => nested.instances[intent.instanceKey])
        const inst = checkpoint.instances[intent.instanceKey] ?? nestedEntry?.instances[intent.instanceKey]
        if (inst) {
          inst.status = 'ready'
          if (nestedEntry) {
            if (!nestedEntry.ready.includes(intent.instanceKey)) nestedEntry.ready.push(intent.instanceKey)
          } else if (!checkpoint.ready.includes(intent.instanceKey)) {
            checkpoint.ready.push(intent.instanceKey)
          }
        }
        delete checkpoint.intents![intent.instanceKey]
      } else {
        const child = this.store.listRunIds()
          .map((id) => this.store.readManifest(id))
          .find((candidate) => candidate.parentRunId === manifest.runId && candidate.parentInstanceKey === intent.instanceKey)
        const inst = checkpoint.instances[intent.instanceKey]
        if (child?.state === 'succeeded' && inst) {
          const childCheckpoint = this.store.readCheckpoint(child.runId)
          inst.status = 'succeeded'
          inst.output = childCheckpoint.result
          inst.port = 'success'
          checkpoint.outputs[intent.instanceKey] = childCheckpoint.result
          this.enqueueSuccessors(runId, checkpoint, intent.instanceKey, 'success')
          delete checkpoint.intents![intent.instanceKey]
          continue
        }
        this.store.setState(manifest, 'unknown-effect', this.iso(), 'effect dispatched without a durable result')
      }
    }
  }

  private isRetryableEffect(effect: string): boolean {
    return effect === 'pure' || effect === 'read'
  }

  private async executeInstance(
    runId: string,
    token: string,
    manifest: WorkflowRunManifest,
    checkpoint: RunCheckpoint,
    compiled: CompiledWorkflow,
    policy: ExecutionPolicySnapshot,
    ctx: ExecutionContext,
    signal: AbortSignal,
    input: unknown,
    inst: InstanceRecord
  ): Promise<
    | { kind: 'ok'; output: unknown; port: string }
    | { kind: 'fail'; error: string; unknown?: boolean }
    | { kind: 'wait'; state: WorkflowRunState; approvalId?: string; pendingInput?: RunCheckpoint['pendingInput']; wakeAt?: string }
    | { kind: 'skip' }
  > {
    const node = findNode(compiled.graph, inst.nodeId)
    if (!node) return { kind: 'fail', error: `Unknown node ${inst.nodeId}` }
    if (node.type === 'note' || node.type === 'group' || !node.runtime) return { kind: 'skip' }

    const adapterKey = ADAPTER_TYPES[node.type]
    if (adapterKey && !this.adapters[adapterKey]) {
      return { kind: 'fail', error: `Executor unavailable for ${node.type}: no registered ${adapterKey} adapter` }
    }

    const scope = collectScopeOutputs(checkpoint.outputs, inst.path)
    const evalCtx = nodeEvalContext(input, scope, inst.loop)
    const inputs = evaluateNodeInputs(node, evalCtx)
    const effect = this.effectFor(node)
    const toolId = this.toolIdFor(node)
    const inputHash = sha256Utf8(JSON.stringify(inputs))
    const idempotencyKey = createHash('sha256')
      .update(`${runId}:${inst.instanceKey}:${inst.attempt}:${node.type}:${inputHash}`)
      .digest('hex')
    const requestDigest = createHash('sha256')
      .update(JSON.stringify({ runId, instanceKey: inst.instanceKey, type: node.type, inputs, effect }))
      .digest('hex')

    const auth = this.policy.authorize(ctx, policy, {
      toolId,
      classification: effect,
      capability: node.requiredCapabilities[0],
      requestDigest,
      description: `${node.type}:${node.id}`
    })
    if (auth.status === 'denied') return { kind: 'fail', error: `denied:${auth.code}` }
    if (auth.status === 'approval-required') {
      const existing = this.approvals
        .listAll(this.profileId, runId)
        .find((item) => item.instanceKey === inst.instanceKey && item.requestDigest === requestDigest && !item.revokedAt)
      if (existing?.decision === 'approved' && existing.consumedAt) {
        // already authorized for this digest; continue
      } else {
      const record =
        existing && !existing.consumedAt
          ? existing
          : this.approvals.create({
          profileId: this.profileId,
          runId,
          actor: manifest.actor,
          nodeId: node.id,
          instanceKey: inst.instanceKey,
          attempt: inst.attempt,
          definitionId: manifest.definitionId,
          revisionId: manifest.revisionId,
          policySnapshotId: policy.id,
          requestDigest,
          description: `${node.type} ${node.id} (${effect})`,
          createdAt: this.iso(),
          expiresAt: new Date(this.nowFn().getTime() + 60 * 60 * 1000).toISOString()
        })
      const decided = this.approvals.get(record.approvalId, this.profileId)
      if (!decided?.consumedAt) {
        if (auth.unattended) {
          return { kind: 'fail', error: 'unattended approval required' }
        }
        await this.adapters.approvalHost?.notify?.({
          approvalId: record.approvalId,
          profileId: this.profileId,
          runId,
          description: record.description,
          unattended: auth.unattended
        })
        checkpoint.ready.unshift(inst.instanceKey)
        inst.status = 'ready'
        return {
          kind: 'wait',
          state: 'waiting-approval',
          approvalId: record.approvalId
        }
      }
      if (decided.decision !== 'approved') return { kind: 'fail', error: 'approval denied' }
      }
    }

    if (effect !== 'pure' && node.type !== 'approval') {
      if (manifest.budgets.toolCalls >= policy.maxToolCalls) {
        return { kind: 'fail', error: 'tool call budget exceeded' }
      }
      manifest.budgets.toolCalls += 1
    }

    if (!checkpoint.intents) checkpoint.intents = {}
    checkpoint.intents[inst.instanceKey] = {
      instanceKey: inst.instanceKey,
      attempt: inst.attempt,
      idempotencyKey,
      inputHash,
      effect,
      prepared: true,
      dispatched: false,
      completed: false,
      preparedAt: this.iso()
    }
    this.append(manifest, { token } as RunLease, 'attempt-prepared', {
      instanceKey: inst.instanceKey,
      idempotencyKey,
      effect
    })
    await this.persistCheckpoint(runId, checkpoint, token)
    this.faults?.afterIntent?.(inst.instanceKey)
    let output: Awaited<ReturnType<WorkflowRunService['runNodeBody']>>
    try {
      output = await this.runNodeBody(runId, token, manifest, checkpoint, compiled, policy, ctx, signal, input, inst, node, inputs, evalCtx)
      if (checkpoint.intents?.[inst.instanceKey]) checkpoint.intents[inst.instanceKey]!.dispatched = true
      await this.persistCheckpoint(runId, checkpoint, token)
      this.faults?.afterDispatch?.(inst.instanceKey)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.append(manifest, { token } as RunLease, 'attempt-unknown', {
        instanceKey: inst.instanceKey,
        idempotencyKey,
        error: message
      })
      return { kind: 'fail', error: message, unknown: !this.isRetryableEffect(effect) }
    }
    const intent = checkpoint.intents?.[inst.instanceKey]
    if (intent) {
      intent.completed = true
      intent.completedAt = this.iso()
      intent.resultHash = output.kind === 'ok' ? sha256Utf8(JSON.stringify(output.output)) : undefined
    }
    if (!checkpoint.results) checkpoint.results = {}
    checkpoint.results[inst.instanceKey] = {
      instanceKey: inst.instanceKey,
      attempt: inst.attempt,
      outcome: output.kind === 'ok' ? 'succeeded' : 'failed',
      output: output.kind === 'ok' ? output.output : undefined,
      port: output.kind === 'ok' ? output.port : undefined,
      error: output.kind === 'fail' ? output.error : undefined,
      completedAt: this.iso()
    }
    await this.persistCheckpoint(runId, checkpoint, token)
    this.append(manifest, { token } as RunLease, 'attempt-completed', { instanceKey: inst.instanceKey, idempotencyKey })
    return output
  }

  private async runNodeBody(
    runId: string,
    token: string,
    manifest: WorkflowRunManifest,
    checkpoint: RunCheckpoint,
    compiled: CompiledWorkflow,
    policy: ExecutionPolicySnapshot,
    ctx: ExecutionContext,
    signal: AbortSignal,
    input: unknown,
    inst: InstanceRecord,
    node: CompiledNode,
    inputs: Record<string, unknown>,
    evalCtx: ReturnType<typeof nodeEvalContext>
  ): Promise<
    | { kind: 'ok'; output: unknown; port: string }
    | { kind: 'fail'; error: string; unknown?: boolean }
    | { kind: 'wait'; state: WorkflowRunState; approvalId?: string; pendingInput?: RunCheckpoint['pendingInput']; wakeAt?: string }
    | { kind: 'skip' }
  > {
    const cfg = node.config
    switch (node.type) {
      case 'start':
        return { kind: 'ok', output: input, port: 'next' }
      case 'end':
        return { kind: 'ok', output: inputs.result ?? Object.values(inputs)[0] ?? null, port: 'result' }
      case 'transform': {
        const value = cfg.value !== undefined ? evaluateConfigBinding(cfg.value, evalCtx) : evaluateConfigExpression(cfg.expression, evalCtx)
        return { kind: 'ok', output: value, port: 'success' }
      }
      case 'select-fields': {
        const source = cfg.from !== undefined ? evaluateConfigBinding(cfg.from, evalCtx) : inputs.value ?? inputs
        const fields = cfg.fields as string[]
        const object = isPlainObject(source) ? source : {}
        const picked: Record<string, unknown> = {}
        for (const field of fields) picked[field] = object[field]
        return { kind: 'ok', output: picked, port: 'success' }
      }
      case 'filter': {
        const items = (cfg.items ? evaluateConfigBinding(cfg.items, evalCtx) : inputs.items) as unknown
        const result = evaluateConfigExpression(
          { op: 'filter', args: [{ literal: items }, cfg.predicate] },
          evalCtx
        )
        return { kind: 'ok', output: result, port: 'success' }
      }
      case 'reduce': {
        const items = (cfg.items ? evaluateConfigBinding(cfg.items, evalCtx) : []) as unknown[]
        let acc = cfg.initial !== undefined ? evaluateConfigBinding(cfg.initial, evalCtx) : 0
        for (let index = 0; index < items.length; index += 1) {
          acc = evaluateConfigExpression(cfg.reducer, {
            ...evalCtx,
            loop: { item: items[index], index, previous: acc }
          })
        }
        return { kind: 'ok', output: acc, port: 'success' }
      }
      case 'format': {
        const text = evaluateConfigBinding({ template: String(cfg.template) }, evalCtx)
        return { kind: 'ok', output: { text }, port: 'success' }
      }
      case 'prompt-template': {
        const text = typeof cfg.template === 'string'
          ? evaluateConfigBinding({ template: cfg.template }, evalCtx)
          : evaluateConfigBinding(cfg.template, evalCtx)
        return { kind: 'ok', output: { text }, port: 'success' }
      }
      case 'condition': {
        const value = evaluateConfigExpression(cfg.expression, evalCtx)
        if (typeof value !== 'boolean') return { kind: 'fail', error: 'condition did not return a boolean' }
        return { kind: 'ok', output: { value }, port: value ? 'true' : 'false' }
      }
      case 'switch': {
        const value = evaluateConfigBinding(cfg.value, evalCtx)
        const cases = Array.isArray(cfg.cases) ? cfg.cases : []
        for (const item of cases) {
          if (!isPlainObject(item) || typeof item.key !== 'string') continue
          const equals = evaluateConfigBinding(item.equals, evalCtx)
          if (JSON.stringify(equals) === JSON.stringify(value)) {
            return { kind: 'ok', output: { matched: item.key }, port: item.key }
          }
        }
        return { kind: 'ok', output: { matched: 'default' }, port: 'default' }
      }
      case 'delay': {
        const durationMs = Number(cfg.durationMs ?? 0)
        const wakeAt = checkpoint.wakeAt ?? new Date(this.nowFn().getTime() + durationMs).toISOString()
        if (this.nowFn().getTime() >= Date.parse(wakeAt)) {
          checkpoint.wakeAt = undefined
          return { kind: 'ok', output: { elapsedMs: durationMs }, port: 'success' }
        }
        checkpoint.ready.unshift(inst.instanceKey)
        inst.status = 'ready'
        return { kind: 'wait', state: 'waiting-condition', wakeAt }
      }
      case 'wait-for-condition': {
        const matched = evaluateConfigExpression(cfg.expression, evalCtx)
        if (matched === true) return { kind: 'ok', output: { matched: true }, port: 'success' }
        const timeoutMs = Number(cfg.timeoutMs)
        const wakeAt = checkpoint.wakeAt ?? new Date(this.nowFn().getTime() + timeoutMs).toISOString()
        if (this.nowFn().getTime() >= Date.parse(wakeAt)) {
          return { kind: 'ok', output: { matched: false }, port: 'timeout' }
        }
        checkpoint.ready.unshift(inst.instanceKey)
        inst.status = 'ready'
        return { kind: 'wait', state: 'waiting-condition', wakeAt }
      }
      case 'ask-user':
        checkpoint.ready.unshift(inst.instanceKey)
        inst.status = 'ready'
        return {
          kind: 'wait',
          state: 'waiting-input',
          pendingInput: {
            instanceKey: inst.instanceKey,
            prompt: String(cfg.prompt),
            schema: cfg.answerSchema
          }
        }
      case 'approval':
        return { kind: 'ok', output: { decision: 'approved' }, port: 'approved' }
      case 'fail':
        return { kind: 'ok', output: { message: cfg.message ?? 'fail' }, port: 'error' }
      case 'read-input': {
        if (typeof cfg.pointer === 'string') {
          const { getJsonPointer } = await import('../../../shared/workflows')
          const found = getJsonPointer(input, cfg.pointer)
          if (!found.ok) return { kind: 'fail', error: found.error }
          return { kind: 'ok', output: found.value, port: 'success' }
        }
        if (!this.adapters.workspace) return { kind: 'fail', error: 'Workspace adapter required' }
        const path = String(cfg.path ?? '')
        const file = await this.adapters.workspace.readAuthorizedFile(path, ctx)
        return { kind: 'ok', output: { bytes: file.bytes.byteLength, name: file.name }, port: 'success' }
      }
      case 'write-artifact':
      case 'render-report': {
        const store = this.adapters.artifacts ?? this.artifacts
        const content = cfg.content !== undefined ? evaluateConfigBinding(cfg.content, evalCtx) : inputs
        const bytes = Buffer.from(JSON.stringify(content), 'utf8')
        if (manifest.budgets.artifactBytes + bytes.byteLength > policy.maxArtifactBytes) {
          return { kind: 'fail', error: 'artifact byte budget exceeded' }
        }
        const ref = await store.put({
          profileId: this.profileId,
          runId,
          bytes,
          mediaType: 'application/json',
          displayName: String(cfg.name ?? cfg.title ?? 'artifact.json')
        })
        manifest.budgets.artifactBytes += bytes.byteLength
        return { kind: 'ok', output: { artifact: ref }, port: 'success' }
      }
      case 'for-each':
      case 'bounded-repeat':
        return this.runLoop(runId, token, manifest, checkpoint, compiled, policy, ctx, signal, input, inst, node, evalCtx)
      case 'parallel':
        return this.runParallel(runId, token, manifest, checkpoint, compiled, policy, ctx, signal, input, inst, node, evalCtx)
      case 'join': {
        const parallelId = String(cfg.parallelNodeId)
        const sourceKey = instanceKey(inst.path, parallelId)
        const launched = checkpoint.outputs[sourceKey]
        return { kind: 'ok', output: launched ?? { results: [] }, port: 'success' }
      }
      case 'try-catch':
        return this.runTryCatch(runId, token, manifest, checkpoint, compiled, policy, ctx, signal, input, inst, node, evalCtx)
      case 'finally':
        return this.runSubgraphNamed(runId, token, manifest, checkpoint, compiled, policy, ctx, signal, input, inst, node, 'body', evalCtx)
      case 'subworkflow':
        return this.runSubworkflow(runId, token, checkpoint, inst, manifest, policy, ctx, node, evalCtx)
      case 'script':
        return this.runScript(runId, token, manifest, policy, ctx, signal, inst, node, inputs)
      case 'agent':
      case 'instruction': {
        const output = await this.adapters.agent!.invoke({
          context: ctx,
          policy,
          agent: isPlainObject(cfg.agent) ? (cfg.agent as never) : { kind: 'main' },
          instructions: String(cfg.instructions ?? cfg.text ?? ''),
          input: inputs,
          outputSchema: cfg.outputSchema as never,
          signal,
          idempotencyKey: checkpoint.intents?.[inst.instanceKey]?.idempotencyKey ?? inst.instanceKey
        })
        checkpoint.usage = {
          tokens: (checkpoint.usage?.tokens ?? 0) + Number(output.tokens ?? 0),
          cost: (checkpoint.usage?.cost ?? 0) + Number(output.cost ?? 0)
        }
        manifest.budgets.tokens += Number(output.tokens ?? 0)
        manifest.budgets.cost += Number(output.cost ?? 0)
        return { kind: 'ok', output: output.output, port: 'success' }
      }
      case 'tool':
        return {
          kind: 'ok',
          output: (
            await this.adapters.tool!.invoke({
              context: ctx,
              policy,
              toolId: String((cfg.tool as { id: string }).id),
              input: inputs,
              signal,
              idempotencyKey: checkpoint.intents?.[inst.instanceKey]?.idempotencyKey ?? inst.instanceKey
            })
          ).output,
          port: 'success'
        }
      case 'mcp-tool':
        return {
          kind: 'ok',
          output: (
            await this.adapters.mcp!.invoke({
              context: ctx,
              policy,
              serverId: String(cfg.serverId),
              toolName: String(cfg.toolName),
              input: inputs,
              signal,
              idempotencyKey: checkpoint.intents?.[inst.instanceKey]?.idempotencyKey ?? inst.instanceKey
            })
          ).output,
          port: 'success'
        }
      case 'load-skill':
        return {
          kind: 'ok',
          output: await this.adapters.skill!.load({
            context: ctx,
            skillId: String((cfg.skill as { id: string }).id),
            revision: isPlainObject(cfg.skill) ? (cfg.skill.revision as string | undefined) : undefined
          }),
          port: 'success'
        }
      case 'browser-session':
      case 'browser-observe':
      case 'browser-action':
      case 'browser-extract':
      case 'browser-task':
        return {
          kind: 'ok',
          output: (
            await this.adapters.browser!.invoke({
              context: ctx,
              policy,
              nodeType: node.type,
              config: cfg,
              input: inputs,
              signal,
              idempotencyKey: checkpoint.intents?.[inst.instanceKey]?.idempotencyKey ?? inst.instanceKey
            })
          ).output,
          port: 'success'
        }
      default:
        return { kind: 'fail', error: `Unsupported executable node ${node.type}` }
    }
  }

  private async runScript(
    runId: string,
    _token: string,
    manifest: WorkflowRunManifest,
    _policy: ExecutionPolicySnapshot,
    ctx: ExecutionContext,
    signal: AbortSignal,
    inst: InstanceRecord,
    node: CompiledNode,
    inputs: Record<string, unknown>
  ) {
    const cfg = node.config
    const mode = cfg.executionMode
    if (mode === 'sandboxed') {
      const sandbox = this.adapters.sandbox ?? new UnconfiguredSandboxAdapter()
      try {
        await sandbox.execute({
          runtime: cfg.runtime as never,
          scriptPath: '',
          scriptHash: '',
          argv: [],
          cwd: '',
          env: {},
          stdin: '',
          timeoutMs: 1,
          maxStdoutBytes: 1,
          maxStderrBytes: 1,
          signal
        })
      } catch (error) {
        if (isSandboxUnavailable(error)) {
          return { kind: 'fail' as const, error: 'SANDBOX_UNAVAILABLE' }
        }
        throw error
      }
    }
    const relative = String(cfg.file)
    const source = join(this.store.runDir(runId), 'bundle', relative)
    const snapshot = join(this.store.runDir(runId), 'scripts', relative.replace(/[\\/]/g, '_'))
    const { readFileSync } = await import('node:fs')
    const bytes = readFileSync(source)
    mkdirSync(join(this.store.runDir(runId), 'scripts'), { recursive: true })
    writeFileSync(snapshot, bytes)
    const hash = createHash('sha256').update(bytes).digest('hex')
    let stagedInput: unknown = inputs
    let extraEnv: Record<string, string> = {}
    if (Array.isArray(cfg.fileInputs)) {
      try {
        const staged = await stageFileInputs({
          declarations: cfg.fileInputs as WorkflowFileInputDeclaration[],
          input: inputs,
          runRoot: this.store.runDir(runId),
          context: ctx,
          workspace: this.adapters.workspace
        })
        stagedInput = staged.input
        extraEnv = staged.env
      } catch (error) {
        return { kind: 'fail' as const, error: error instanceof Error ? error.message : String(error) }
      }
    }
    const timeoutMs = Number(cfg.timeoutMs ?? 30_000)
    const result = await this.scripts.run({
      runtime: cfg.runtime as never,
      scriptPath: snapshot,
      scriptHash: hash,
      argv: Array.isArray(cfg.argv) ? (cfg.argv as string[]) : [],
      cwd: extraEnv.MOUSSE_INPUT_DIR ?? join(this.store.runDir(runId), 'staging'),
      env: {
        PATH: process.env.PATH ?? '',
        SystemRoot: process.env.SystemRoot ?? '',
        MOUSSE_INPUT_DIR: extraEnv.MOUSSE_INPUT_DIR ?? '',
        ...Object.fromEntries((cfg.environmentAllowlist as string[] | undefined)?.map((name) => [name, process.env[name] ?? '']) ?? [])
      },
      stdin: JSON.stringify(stagedInput),
      timeoutMs,
      maxStdoutBytes: 512 * 1024,
      maxStderrBytes: 64 * 1024,
      signal
    })
    if (result.timedOut) return { kind: 'fail' as const, error: 'script timed out', unknown: true }
    if (result.truncated) return { kind: 'fail' as const, error: 'script output exceeded bounds' }
    if (result.exitCode !== 0) return { kind: 'fail' as const, error: `script exit ${result.exitCode}: ${result.stderr}` }
    let parsed: unknown
    try {
      parsed = JSON.parse(result.stdout)
    } catch {
      return { kind: 'fail' as const, error: 'script stdout is not JSON' }
    }
    if (cfg.outputSchema) {
      const check = workflowJsonSchemaValidator.validateData(cfg.outputSchema as never, parsed)
      if (!check.ok) return { kind: 'fail' as const, error: check.diagnostics[0]?.message ?? 'script output schema mismatch' }
    }
    void inst
    void manifest
    return { kind: 'ok' as const, output: parsed, port: 'success' }
  }

  private async runLoop(
    runId: string,
    token: string,
    manifest: WorkflowRunManifest,
    checkpoint: RunCheckpoint,
    compiled: CompiledWorkflow,
    policy: ExecutionPolicySnapshot,
    ctx: ExecutionContext,
    signal: AbortSignal,
    input: unknown,
    inst: InstanceRecord,
    node: CompiledNode,
    evalCtx: ReturnType<typeof nodeEvalContext>
  ) {
    const subgraph = node.subgraphs?.body
    if (!subgraph) return { kind: 'fail' as const, error: 'loop subgraph missing' }
    const max = Number(node.config.maxIterations ?? 1)
    const maxDurationMs = Number(node.config.maxDurationMs ?? policy.maxElapsedMs)
    const loopStarted = Date.now()
    const results: unknown[] = []
    if (node.type === 'for-each') {
      const items = evaluateConfigBinding(node.config.items, evalCtx)
      if (!Array.isArray(items)) return { kind: 'fail' as const, error: 'for-each items must be an array' }
      if (items.length > max) return { kind: 'fail' as const, error: 'for-each exceeds maxIterations' }
      for (let index = 0; index < items.length; index += 1) {
        if (Date.now() - loopStarted > maxDurationMs) return { kind: 'fail' as const, error: 'loop duration exceeded' }
        const output = await this.runGraph(
          runId,
          token,
          manifest,
          compiled,
          policy,
          ctx,
          signal,
          input,
          subgraph,
          `${inst.instanceKey}#${index}`,
          { item: items[index], index, previous: results[index - 1] },
          checkpoint
        )
        if (output.kind !== 'ok') return output
        results.push(output.output)
      }
    } else {
      let previous: unknown
      for (let index = 0; index < max; index += 1) {
        if (Date.now() - loopStarted > maxDurationMs) return { kind: 'fail' as const, error: 'loop duration exceeded' }
        const output = await this.runGraph(
          runId,
          token,
          manifest,
          compiled,
          policy,
          ctx,
          signal,
          input,
          subgraph,
          `${inst.instanceKey}#${index}`,
          { item: previous, index, previous },
          checkpoint
        )
        if (output.kind !== 'ok') return output
        results.push(output.output)
        previous = output.output
        if (node.config.until) {
          const done = evaluateConfigExpression(node.config.until, { ...evalCtx, loop: { item: previous, index, previous } })
          if (done === true) break
        }
      }
    }
    return { kind: 'ok' as const, output: { results }, port: 'completed' }
  }

  private async runParallel(
    runId: string,
    token: string,
    manifest: WorkflowRunManifest,
    checkpoint: RunCheckpoint,
    compiled: CompiledWorkflow,
    policy: ExecutionPolicySnapshot,
    ctx: ExecutionContext,
    signal: AbortSignal,
    input: unknown,
    inst: InstanceRecord,
    node: CompiledNode,
    evalCtx: ReturnType<typeof nodeEvalContext>
  ) {
    void evalCtx
    const branches = Object.entries(node.subgraphs ?? {}).filter(([name]) => name.startsWith('branch:'))
    const maxConcurrency = Math.max(1, Math.min(Number(node.config.maxConcurrency ?? 4), Number(compiled.limits.maxConcurrency ?? 4)))
    const policyName = String(node.config.policy ?? 'all-success')
    const results: Array<{ id: string; ok: boolean; output?: unknown; error?: string }> = []
    let pendingWait: Extract<Awaited<ReturnType<WorkflowRunService['runGraph']>>, { kind: 'wait' }> | undefined
    const queue = [...branches]
    const active: Promise<void>[] = []
    const controllers = new Map<string, AbortController>()
    let winner: { id: string; output?: unknown } | undefined
    const runBranch = async ([name, graph]: [string, CompiledGraph]) => {
      const id = name.slice('branch:'.length)
      const controller = new AbortController()
      controllers.set(id, controller)
      const abort = () => controller.abort(signal.reason)
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
      try {
        const output = await this.runGraph(runId, token, manifest, compiled, policy, ctx, controller.signal, input, graph, `${inst.instanceKey}/${id}`, undefined, checkpoint)
        if (output.kind === 'ok') {
          results.push({ id, ok: true, output: output.output })
          if (policyName === 'first-success' && !winner) {
            winner = { id, output: output.output }
            for (const [otherId, other] of controllers) if (otherId !== id) other.abort('first-success settled')
          }
        } else if (output.kind === 'fail') {
          results.push({ id, ok: false, error: output.error })
        } else pendingWait = output
      } finally {
        signal.removeEventListener('abort', abort)
      }
    }
    while (queue.length > 0 || active.length > 0) {
      while (queue.length > 0 && active.length < maxConcurrency && !winner) {
        const next = queue.shift()!
        const work = runBranch(next).then(() => {
          const idx = active.indexOf(work)
          if (idx >= 0) active.splice(idx, 1)
        })
        active.push(work)
      }
      if (active.length > 0) await Promise.race(active)
    }
    await Promise.allSettled(active)
    if (pendingWait) return pendingWait
    results.sort((a, b) => a.id.localeCompare(b.id))
    if (policyName === 'first-success') {
      const settled = winner ?? results.find((item) => item.ok)
      if (!settled) return { kind: 'fail' as const, error: 'all parallel branches failed' }
      return { kind: 'ok' as const, output: { results: [{ id: settled.id, ok: true, output: settled.output }] }, port: 'success' }
    }
    if (policyName === 'all-success' && results.some((item) => !item.ok)) {
      return { kind: 'fail' as const, error: results.find((item) => !item.ok)?.error ?? 'parallel branch failed' }
    }
    return { kind: 'ok' as const, output: { results }, port: 'success' }
  }

  private async runTryCatch(
    runId: string,
    token: string,
    manifest: WorkflowRunManifest,
    checkpoint: RunCheckpoint,
    compiled: CompiledWorkflow,
    policy: ExecutionPolicySnapshot,
    ctx: ExecutionContext,
    signal: AbortSignal,
    input: unknown,
    inst: InstanceRecord,
    node: CompiledNode,
    evalCtx: ReturnType<typeof nodeEvalContext>
  ) {
    void evalCtx
    const tryGraph = node.subgraphs?.try
    if (!tryGraph) return { kind: 'fail' as const, error: 'try subgraph missing' }
    const tried = await this.runGraph(runId, token, manifest, compiled, policy, ctx, signal, input, tryGraph, `${inst.instanceKey}/try`, undefined, checkpoint)
    if (tried.kind === 'wait') return tried
    if (tried.kind === 'ok') {
      if (node.subgraphs?.finally) {
        const finalized = await this.runGraph(runId, token, manifest, compiled, policy, ctx, signal, input, node.subgraphs.finally, `${inst.instanceKey}/finally`, undefined, checkpoint)
        if (finalized.kind === 'wait') return finalized
        if (finalized.kind !== 'ok') return finalized
      }
      return { kind: 'ok' as const, output: tried.output, port: 'success' }
    }
    const catchGraph = node.subgraphs?.catch
    if (!catchGraph) return tried
    const caught = await this.runGraph(runId, token, manifest, compiled, policy, ctx, signal, input, catchGraph, `${inst.instanceKey}/catch`, undefined, checkpoint)
    if (caught.kind === 'wait') return caught
    if (node.subgraphs?.finally) {
      const finalized = await this.runGraph(runId, token, manifest, compiled, policy, ctx, signal, input, node.subgraphs.finally, `${inst.instanceKey}/finally`, undefined, checkpoint)
      if (finalized.kind === 'wait') return finalized
      if (finalized.kind !== 'ok') return finalized
    }
    if (caught.kind === 'ok') return { kind: 'ok' as const, output: caught.output, port: 'success' }
    return caught
  }

  private async runSubgraphNamed(
    runId: string,
    token: string,
    manifest: WorkflowRunManifest,
    checkpoint: RunCheckpoint,
    compiled: CompiledWorkflow,
    policy: ExecutionPolicySnapshot,
    ctx: ExecutionContext,
    signal: AbortSignal,
    input: unknown,
    inst: InstanceRecord,
    node: CompiledNode,
    name: string,
    evalCtx: ReturnType<typeof nodeEvalContext>
  ) {
    void evalCtx
    const graph = node.subgraphs?.[name]
    if (!graph) return { kind: 'fail' as const, error: `${name} subgraph missing` }
    const result = await this.runGraph(runId, token, manifest, compiled, policy, ctx, signal, input, graph, `${inst.instanceKey}/${name}`, undefined, checkpoint)
    if (result.kind === 'ok') return { kind: 'ok' as const, output: result.output, port: 'next' }
    return result
  }

  private async runSubworkflow(
    runId: string,
    token: string,
    checkpoint: RunCheckpoint,
    inst: InstanceRecord,
    manifest: WorkflowRunManifest,
    policy: ExecutionPolicySnapshot,
    ctx: ExecutionContext,
    node: CompiledNode,
    evalCtx: ReturnType<typeof nodeEvalContext>
  ) {
    const ref = node.config.workflow as { id?: string; slug?: string; revision?: string }
    if ((manifest.depth ?? 0) >= 8) return { kind: 'fail' as const, error: 'subworkflow depth exceeded' }
    let childRunId = checkpoint.childRuns?.[inst.instanceKey]
    if (!childRunId) {
      childRunId = this.store.listRunIds()
        .map((id) => this.store.readManifest(id))
        .find((child) => child.parentRunId === manifest.runId && child.parentInstanceKey === inst.instanceKey)?.runId
    }
    let nested = childRunId ? await this.get(childRunId, { profileId: this.profileId }) : undefined
    if (nested && !['succeeded', 'failed', 'cancelled', 'unknown-effect'].includes(nested.manifest.state)) {
      nested = await this.resume(childRunId!, { profileId: this.profileId })
    }
    if (!nested) nested = await this.start({
      profileId: this.profileId,
      threadId: manifest.threadId,
      projectId: manifest.projectId,
      actor: manifest.actor,
      source: manifest.source,
      definitionId: ref.id,
      slug: ref.slug,
      revisionId: ref.revision,
      input: node.config.input ? evaluateConfigBinding(node.config.input, evalCtx) : {},
      installationPolicy: {
        allowedTools: [...policy.allowedTools],
        allowedCapabilities: [...policy.allowedCapabilities],
        allowedEffects: [...policy.allowedEffects]
      },
      runPolicy: {
        maxToolCalls: Math.max(0, policy.maxToolCalls - manifest.budgets.toolCalls),
        maxElapsedMs: Math.max(0, policy.maxElapsedMs - manifest.budgets.elapsedMs),
        maxArtifactBytes: Math.max(0, policy.maxArtifactBytes - manifest.budgets.artifactBytes)
      },
      parentRunId: manifest.runId,
      parentInstanceKey: inst.instanceKey,
      depth: (manifest.depth ?? 0) + 1,
      parentCancellationId: manifest.cancellationId
    })
    if (!checkpoint.childRuns) checkpoint.childRuns = {}
    checkpoint.childRuns[inst.instanceKey] = nested.manifest.runId
    await this.persistCheckpoint(runId, checkpoint, token)
    if (nested.manifest.state !== 'succeeded') {
      return { kind: 'fail' as const, error: nested.manifest.terminalError ?? 'subworkflow failed' }
    }
    manifest.budgets.toolCalls += nested.manifest.budgets.toolCalls
    manifest.budgets.tokens += nested.manifest.budgets.tokens
    manifest.budgets.cost += nested.manifest.budgets.cost
    manifest.budgets.artifactBytes += nested.manifest.budgets.artifactBytes
    void ctx
    return { kind: 'ok' as const, output: nested.result, port: 'success' }
  }

  private async runGraph(
    runId: string,
    token: string,
    manifest: WorkflowRunManifest,
    compiled: CompiledWorkflow,
    policy: ExecutionPolicySnapshot,
    ctx: ExecutionContext,
    signal: AbortSignal,
    input: unknown,
    graph: CompiledGraph,
    path: string,
    loop?: { item: unknown; index: number; previous?: unknown },
    rootCheckpoint?: RunCheckpoint
  ): Promise<
    | { kind: 'ok'; output: unknown }
    | { kind: 'fail'; error: string; unknown?: boolean }
    | { kind: 'wait'; state: WorkflowRunState; approvalId?: string; pendingInput?: RunCheckpoint['pendingInput']; wakeAt?: string }
  > {
    const nestedKey = path || graph.entryNodeId
    const saved = rootCheckpoint?.nested?.[nestedKey]
    const local: RunCheckpoint = saved
      ? {
          seq: 0,
          ready: [...saved.ready],
          instances: { ...(rootCheckpoint?.instances ?? {}), ...saved.instances },
          outputs: { ...(rootCheckpoint?.outputs ?? {}), ...saved.outputs },
          result: saved.terminal,
          nested: rootCheckpoint?.nested,
          intents: rootCheckpoint?.intents,
          results: rootCheckpoint?.results,
          wakeAt: rootCheckpoint?.wakeAt
        }
      : {
          seq: 0,
          ready: [instanceKey(path, graph.entryNodeId)],
          instances: { ...(rootCheckpoint?.instances ?? {}) },
          outputs: { ...(rootCheckpoint?.outputs ?? {}) },
          nested: rootCheckpoint?.nested,
          intents: rootCheckpoint?.intents,
          results: rootCheckpoint?.results,
          wakeAt: rootCheckpoint?.wakeAt
        }
    if (rootCheckpoint && !rootCheckpoint.nested) rootCheckpoint.nested = {}
    if (rootCheckpoint && !saved) rootCheckpoint.nested![nestedKey] = {
      graphEntryNodeId: graph.entryNodeId,
      ready: local.ready,
      instances: local.instances,
      outputs: local.outputs,
      phase: 'running'
    }
    if (!local.instances[instanceKey(path, graph.entryNodeId)]) {
      local.instances[instanceKey(path, graph.entryNodeId)] = {
        instanceKey: instanceKey(path, graph.entryNodeId),
        nodeId: graph.entryNodeId,
        type: graph.nodes.find((n) => n.id === graph.entryNodeId)?.type ?? 'transform',
        path,
        status: 'ready',
        attempt: 0,
        loop
      }
    }
    const nestedCompiled: CompiledWorkflow = { ...compiled, graph }
    let terminal: unknown
    let guard = 0
    while (local.ready.length > 0 && guard < 1000) {
      guard += 1
      const key = local.ready.shift()!
      const inst = local.instances[key]
      if (!inst || inst.status !== 'ready') continue
      inst.status = 'running'
      inst.attempt += 1
      const result = await this.executeInstance(runId, token, manifest, { ...local, outputs: { ...local.outputs } }, nestedCompiled, policy, ctx, signal, input, inst)
      if (result.kind === 'fail') return result
      if (result.kind === 'wait') {
        if (rootCheckpoint?.nested) {
          rootCheckpoint.nested[nestedKey] = {
            graphEntryNodeId: graph.entryNodeId,
            ready: [...local.ready],
            instances: { ...local.instances },
            outputs: { ...local.outputs },
            phase: 'waiting'
          }
        }
        return result
      }
      if (result.kind === 'skip') {
        inst.status = 'skipped'
        continue
      }
      inst.status = 'succeeded'
      inst.output = result.output
      inst.port = result.port
      local.outputs[key] = result.output
      if (rootCheckpoint?.nested) {
        rootCheckpoint.nested[nestedKey] = {
          graphEntryNodeId: graph.entryNodeId,
          ready: [...local.ready],
          instances: { ...local.instances },
          outputs: { ...local.outputs },
          terminal,
          phase: 'running'
        }
      }
      if (inst.type === 'end' || inst.type === 'fail') {
        terminal = result.output
        if (inst.type === 'fail') return { kind: 'fail', error: String(result.output) }
        break
      }
      const node = findNode(graph, inst.nodeId)
      for (const edge of graph.edges.filter((item) => item.from === inst.nodeId && item.port === result.port)) {
        const nextKey = instanceKey(path, edge.to)
        if (!local.instances[nextKey]) {
          local.instances[nextKey] = {
            instanceKey: nextKey,
            nodeId: edge.to,
            type: findNode(graph, edge.to)?.type ?? 'transform',
            path,
            status: 'ready',
            attempt: 0,
            loop
          }
        } else if (local.instances[nextKey]!.status === 'pending') {
          local.instances[nextKey]!.status = 'ready'
        }
        if (!local.ready.includes(nextKey) && local.instances[nextKey]!.status === 'ready') local.ready.push(nextKey)
      }
      void node
    }
    if (rootCheckpoint?.nested) {
      rootCheckpoint.nested[nestedKey] = {
        graphEntryNodeId: graph.entryNodeId,
        ready: [...local.ready],
        instances: { ...local.instances },
        outputs: { ...local.outputs },
        terminal,
        phase: 'completed'
      }
    }
    return { kind: 'ok', output: terminal }
  }

  private enqueueSuccessors(_runId: string, checkpoint: RunCheckpoint, fromKey: string, port: string): void {
    const from = checkpoint.instances[fromKey]
    if (!from) return
    const compiled = this.loadCompiled(_runId)
    const graph = graphForPath(compiled.graph, from.path)
    for (const edge of graph.edges.filter((item) => item.from === from.nodeId && item.port === port)) {
      const key = instanceKey(from.path, edge.to)
      if (!checkpoint.instances[key]) {
        checkpoint.instances[key] = {
          instanceKey: key,
          nodeId: edge.to,
          type: findNode(graph, edge.to)?.type ?? 'unknown',
          path: from.path,
          status: 'ready',
          attempt: 0
        }
      } else if (checkpoint.instances[key]!.status === 'pending' || checkpoint.instances[key]!.status === 'skipped') {
        checkpoint.instances[key]!.status = 'ready'
      }
      if (checkpoint.instances[key]!.status === 'ready' && !checkpoint.ready.includes(key)) checkpoint.ready.push(key)
    }
    for (const edge of graph.edges.filter((item) => item.from === from.nodeId && item.port !== port)) {
      const key = instanceKey(from.path, edge.to)
      if (!checkpoint.instances[key]) {
        checkpoint.instances[key] = {
          instanceKey: key,
          nodeId: edge.to,
          type: findNode(graph, edge.to)?.type ?? 'unknown',
          path: from.path,
          status: 'skipped',
          attempt: 0
        }
      }
    }
  }

  private skipDescendants(checkpoint: RunCheckpoint, graph: CompiledGraph, nodeId: string, path: string): void {
    for (const edge of graph.edges.filter((item) => item.from === nodeId)) {
      const key = instanceKey(path, edge.to)
      const inst = checkpoint.instances[key]
      if (inst && inst.status === 'pending') inst.status = 'skipped'
    }
  }

  private hasPendingWork(checkpoint: RunCheckpoint, _graph: CompiledGraph): boolean {
    return Object.values(checkpoint.instances).some((inst) => inst.status === 'ready' || inst.status === 'running' || inst.status === 'waiting')
  }

  private effectFor(node: CompiledNode) {
    const catalogEffect = getNodeCatalogEntry(node.type)?.defaultEffect ?? 'unknown'
    const floor = node.type === 'script' || node.type === 'approval'
      ? 'unknown'
      : ADAPTER_TYPES[node.type] === 'browser' || ADAPTER_TYPES[node.type] === 'mcp' || node.type === 'tool'
        ? 'external'
        : PURE_TYPES.has(node.type)
          ? 'pure'
          : catalogEffect
    const risk = ['pure', 'read', 'write', 'external', 'unknown'] as const
    return risk[Math.max(risk.indexOf(floor), risk.indexOf(node.effect))] ?? 'unknown'
  }

  private toolIdFor(node: CompiledNode): string {
    if (node.type === 'script') return 'workflow.script'
    if (node.type === 'agent' || node.type === 'instruction') return 'workflow.agent'
    if (node.type === 'tool' && isPlainObject(node.config.tool)) return String(node.config.tool.id)
    if (node.type === 'mcp-tool') return `mcp:${node.config.serverId}/${node.config.toolName}`
    if (String(node.type).startsWith('browser')) return 'workflow.browser'
    if (node.type === 'approval') return 'workflow.approval'
    return 'workflow.node'
  }

  private resolveDefinition(request: StartWorkflowRequest) {
    if (request.expectedDraftSemanticHash) {
      if (!request.definitionId) throw Object.assign(new Error('definitionId is required for draft execution'), { code: 'stale_revision' })
      const draft = this.registry.get(request.definitionId)
      if (!draft || draft.semanticHash !== request.expectedDraftSemanticHash) {
        throw Object.assign(new Error('draft semantic hash conflict'), { code: 'stale_revision' })
      }
      return {
        definitionId: request.definitionId,
        revisionId: request.expectedDraftSemanticHash,
        semanticHash: request.expectedDraftSemanticHash,
        compiled: draft.compiled,
        bundle: draft.bundle
      }
    }
    if (request.revisionId && request.definitionId) {
      const snap = this.registry.getRevision(request.definitionId, request.revisionId)
      if (!snap) throw Object.assign(new Error('revision not found'), { code: 'stale_revision' })
      return {
        definitionId: request.definitionId,
        revisionId: request.revisionId,
        semanticHash: snap.semanticHash,
        compiled: snap.compiled,
        bundle: snap.bundle
      }
    }
    const listed = this.registry.list().filter((item) => item.source === 'profile' && item.enabled)
    const match = request.definitionId
      ? listed.find((item) => item.id === request.definitionId)
      : listed.find((item) => item.slug === request.slug)
    if (!match?.headRevisionId) throw Object.assign(new Error('published revision required'), { code: 'stale_revision' })
    const snap = this.registry.getRevision(match.id, match.headRevisionId)
    if (!snap) throw new Error('published revision missing')
    return {
      definitionId: match.id,
      revisionId: match.headRevisionId,
      semanticHash: snap.semanticHash,
      compiled: snap.compiled,
      bundle: snap.bundle
    }
  }

  private loadCompiled(runId: string): CompiledWorkflow {
    const loaded = this.readBundle(runId)
    return loaded
  }

  private readBundle(runId: string): CompiledWorkflow {
    return compileFromRunBundle(this.store.runDir(runId))
  }

  private requeueWaiting(checkpoint: RunCheckpoint, manifest: WorkflowRunManifest): void {
    if (checkpoint.pendingApprovalId) {
      const record = this.approvals.get(checkpoint.pendingApprovalId, this.profileId)
      if (record?.decision === 'approved') checkpoint.pendingApprovalId = undefined
    }
    for (const inst of Object.values(checkpoint.instances)) {
      if (inst.status === 'waiting') {
        inst.status = 'ready'
        if (!checkpoint.ready.includes(inst.instanceKey)) checkpoint.ready.push(inst.instanceKey)
      }
    }
    void manifest
  }

  private snapshot(runId: string): WorkflowRunSnapshot {
    const manifest = this.store.readManifest(runId)
    const checkpoint = this.store.readCheckpoint(runId)
    const compiled = this.loadCompiled(runId)
    const journal = this.store.readJournal(runId)
    const prepared = new Map<string, Extract<WorkflowJournalEvent, { kind: 'attempt-prepared' }> | WorkflowJournalEvent>()
    const completed = new Map<string, WorkflowJournalEvent>()
    for (const event of journal) {
      if (!event.instanceKey) continue
      if (event.kind === 'attempt-prepared') prepared.set(event.instanceKey, event)
      if (event.kind === 'attempt-completed' || event.kind === 'attempt-unknown') completed.set(event.instanceKey, event)
    }
    const attempts = Object.values(checkpoint.instances)
      .filter((inst) => inst.attempt > 0 || prepared.has(inst.instanceKey))
      .map((inst) => {
        const start = prepared.get(inst.instanceKey)
        const end = completed.get(inst.instanceKey)
        const effect = typeof start?.payload.effect === 'string' ? start.payload.effect : 'pure'
        const idempotencyKey = String(start?.payload.idempotencyKey ?? '')
        const outcome: WorkflowNodeAttempt['outcome'] = inst.status === 'succeeded'
          ? 'succeeded'
          : inst.status === 'skipped'
            ? 'skipped'
            : inst.status === 'failed'
              ? (end?.kind === 'attempt-unknown' ? 'unknown' : 'failed')
              : inst.status === 'waiting'
                ? 'cancelled'
                : 'failed'
        return {
          instanceKey: inst.instanceKey,
          nodeId: inst.nodeId,
          type: inst.type,
          attempt: inst.attempt,
          path: inst.path,
          inputHash: idempotencyKey,
          outputHash: inst.output === undefined ? undefined : sha256Utf8(JSON.stringify(inst.output)),
          effect: effect as WorkflowNodeAttempt['effect'],
          idempotencyKey,
          outcome,
          startedAt: start?.at ?? manifest.createdAt,
          completedAt: end?.at,
          error: inst.error,
          childIds: checkpoint.nested?.[inst.instanceKey]
            ? Object.keys(checkpoint.nested[inst.instanceKey]!.instances)
            : undefined
        }
      })
    return {
      manifest,
      compiled,
      attempts,
      artifacts: checkpoint.artifacts ?? [],
      outputs: checkpoint.outputs,
      result: checkpoint.result,
      pendingApprovalId: checkpoint.pendingApprovalId,
      pendingInput: checkpoint.pendingInput as WorkflowRunSnapshot['pendingInput'],
      wakeAt: checkpoint.wakeAt
    }
  }

  private collectArtifacts(value: unknown): import('../../../shared/execution/types').ArtifactReference[] {
    if (!value || typeof value !== 'object') return []
    const found: import('../../../shared/execution/types').ArtifactReference[] = []
    const visit = (item: unknown): void => {
      if (!item || typeof item !== 'object') return
      if ('id' in item && 'sha256' in item && 'profileId' in item && 'runId' in item) {
        found.push(item as import('../../../shared/execution/types').ArtifactReference)
      }
      for (const child of Object.values(item)) visit(child)
    }
    visit(value)
    return found
  }

  private executionContext(manifest: WorkflowRunManifest): ExecutionContext {
    return {
      profileId: manifest.profileId,
      projectId: manifest.projectId,
      threadId: manifest.threadId,
      turnId: manifest.runId,
      runId: manifest.runId,
      actor: manifest.actor,
      policySnapshotId: manifest.policySnapshotId,
      source: manifest.source,
      cancellationId: manifest.cancellationId
    }
  }

  private append(manifest: WorkflowRunManifest, lease: Pick<RunLease, 'token'>, kind: WorkflowJournalEvent['kind'], payload: Record<string, unknown>): void {
    manifest.journalSeq += 1
    this.store.append(
      manifest.runId,
      {
        seq: manifest.journalSeq,
        at: this.iso(),
        kind,
        runId: manifest.runId,
        instanceKey: payload.instanceKey as string | undefined,
        payload
      },
      lease.token
    )
  }

  private budget(manifest: WorkflowRunManifest, started: number, elapsedAtStart: number, policy: ExecutionPolicySnapshot): boolean {
    manifest.budgets.elapsedMs = elapsedAtStart + Date.now() - started
    if (manifest.budgets.elapsedMs > policy.maxElapsedMs) {
      this.store.setState(manifest, 'failed', this.iso(), 'budget exceeded')
      return false
    }
    return true
  }

  private emit(runId: string): void {
    const listeners = this.listeners.get(runId)
    if (!listeners?.size) return
    const snap = this.snapshot(runId)
    for (const listener of listeners) listener(snap)
  }

  /** Serialize checkpoint snapshots so overlapping branches cannot clobber intents. */
  private async persistCheckpoint(runId: string, checkpoint: RunCheckpoint, token: string): Promise<void> {
    const previous = this.checkpointWrites.get(runId) ?? Promise.resolve()
    const snapshot = JSON.parse(JSON.stringify(checkpoint)) as RunCheckpoint
    const write = previous.catch(() => undefined).then(() => {
      this.store.writeCheckpoint(runId, snapshot, token)
    })
    this.checkpointWrites.set(runId, write)
    try {
      await write
    } finally {
      if (this.checkpointWrites.get(runId) === write) this.checkpointWrites.delete(runId)
    }
  }

  private assertOwner(profileId: string): void {
    if (profileId !== this.profileId) throw new Error('profile mismatch')
  }

  private iso(): string {
    return this.nowFn().toISOString()
  }

  private async acquireAfterCancellation(runId: string): Promise<RunLease> {
    let lastError: unknown
    for (let attempt = 0; attempt < 500; attempt += 1) {
      try {
        return this.store.acquire(runId, this.iso())
      } catch (error) {
        lastError = error
        if (!(error instanceof Error) || !error.message.includes('is leased by pid')) throw error
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`Run ${runId} remained leased during cancellation`)
  }
}

function findNode(graph: CompiledGraph, id: string): CompiledNode | undefined {
  const direct = graph.nodes.find((node) => node.id === id)
  if (direct) return direct
  for (const node of graph.nodes) {
    if (!node.subgraphs) continue
    for (const nested of Object.values(node.subgraphs)) {
      const found = findNode(nested, id)
      if (found) return found
    }
  }
  return undefined
}

function findGraphContaining(graph: CompiledGraph, nodeId: string): CompiledGraph | undefined {
  if (graph.nodes.some((node) => node.id === nodeId)) return graph
  for (const node of graph.nodes) {
    for (const nested of Object.values(node.subgraphs ?? {})) {
      const found = findGraphContaining(nested, nodeId)
      if (found) return found
    }
  }

  return undefined
}

function graphForPath(root: CompiledGraph, _path: string): CompiledGraph {
  return root
}

function compileFromRunBundle(runDir: string): CompiledWorkflow {
  const loaded = loadWorkflowDirectory(join(runDir, 'bundle'))
  return compileWorkflow(loaded.bundle.manifest, {
    knownAssets: new Set(loaded.bundle.assets.map((asset) => asset.relativePath))
  })
}

void parseWorkflowBinding
void getNodeCatalogEntry
