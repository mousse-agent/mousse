import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AgentDefinitionError } from '../../shared/agents/errors'
import type { AgentExecutionResult, AgentRuntimeContextSnapshot, AgentRuntimeToolApprovalRequest } from '../../shared/agents/execution'
import type { AgentDefinitionDomainServices, DefinitionTryRunResult } from '../agentDefinitions/registerMethods'
import { assertRuntimeSettingsSupported } from '../agentDefinitions/runtimePolicy'
import type { MmsProfileServices } from '../MmsProfileServices'
import { OwnedWorkBarrier } from '../execution/OwnedWorkBarrier'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { assertOwnedPath } from '../profiles/pathSafety'
import { checkBundleRelativePath } from '../workflows/pathSafety'
import type { ResolvedAgentDefinition } from '../../shared/agents/types'

type TryInput = Parameters<NonNullable<AgentDefinitionDomainServices['tryRun']>>[0]
const RECORD_MAX_BYTES = 8 * 1024 * 1024
const CONTEXT_FILE_MAX_BYTES = 1024 * 1024

interface AgentRunRecord {
  version: 1
  runId: string
  profileId: string
  threadId: string
  definitionId: string
  definitionRevision: string
  createdAt: string
  state: 'running' | 'interrupted' | AgentExecutionResult['status']
  snapshot: ResolvedAgentDefinition
  input: string
  result?: AgentExecutionResult
}

/** Profile-owned host composition; AgentExecutionService still uses the existing LlmClient loop. */
export class MmsAgentExecutionService {
  private readonly lifecycle = new OwnedWorkBarrier()
  private readonly root: string
  private readonly canonicalRoot: string

  constructor(private readonly services: MmsProfileServices) {
    this.root = join(services.getProfileHomeDir(), 'agent-runs')
    assertOwnedPath(services.getProfileHomeDir(), this.root)
    if (existsSync(this.root) && lstatSync(this.root).isSymbolicLink()) throw new Error('Agent run directory cannot be a symlink')
    mkdirSync(this.root, { recursive: true })
    this.canonicalRoot = realpathSync(this.root)
    this.recoverInterrupted()
  }

  beginShutdown(): void { this.lifecycle.beginShutdown() }
  getActiveCount(): number { return this.lifecycle.count }
  async dispose(): Promise<void> { this.beginShutdown(); await this.lifecycle.waitForIdle() }

  tryRun(input: TryInput): Promise<DefinitionTryRunResult> {
    return this.lifecycle.run('agent-editor-run', () => this.runOwned(input))
  }

  private async runOwned(input: TryInput): Promise<DefinitionTryRunResult> {
    const resolved = structuredClone(input.resolved)
    if (resolved.profileId !== this.services.profileId || input.record.profileId !== this.services.profileId) {
      throw new AgentDefinitionError('PROFILE_MISMATCH', 'Agent execution belongs to another profile')
    }
    if (resolved.runtimeKind !== 'mousse') throw new AgentDefinitionError('SETTINGS_UNSUPPORTED', 'External CLI execution is not yet bound to this profile run owner', {
      details: { runtimeKind: resolved.runtimeKind, hostBindings: ['qualified CLI process lifecycle'] }
    })
    if (resolved.settings.memory.scope !== 'thread' && resolved.settings.memory.scope !== 'off') throw new AgentDefinitionError('SETTINGS_UNSUPPORTED', 'Persistent agent memory is not yet bound to this run owner', { pointer: '/settings/memory/scope' })
    const runId = randomUUID(), runRoot = join(this.root, runId), workspace = join(runRoot, 'workspace')
    this.assertRoot()
    mkdirSync(workspace, { recursive: true })
    // Try Run uses its own workspace and transcript. A definition's paths never
    // become host authority merely because they appear in the settings document.
    const host = { workspaceRoots: [realpathSync(workspace)], approveToolRequest: (request: AgentRuntimeToolApprovalRequest) => this.approve(runRoot, request) }
    assertRuntimeSettingsSupported(resolved, host)
    const thread = this.services.threads.createThread(`Try Agent: ${resolved.settings.identity.name}`)
    const registry = this.services.threadRuntimes.getOrHydrate(thread.id).agents
    const record: AgentRunRecord = { version: 1, runId, profileId: this.services.profileId, threadId: thread.id,
      definitionId: resolved.definitionId, definitionRevision: resolved.revision, createdAt: new Date().toISOString(), state: 'running', snapshot: resolved, input: input.prompt }
    this.writeRecord(runRoot, record)
    const userAt = new Date().toISOString()
    const cancelQuestions = (): void => this.services.questions.dismissAllForThread(thread.id)
    this.lifecycle.signal.addEventListener('abort', cancelQuestions, { once: true })
    let result: AgentExecutionResult | undefined
    try {
      registry.create({ cliType: resolved.runtimeKind, executionMode: 'headless', worktreePath: workspace, branch: '', task: input.prompt, status: 'running' }, runId)
      this.services.events.broadcast('threads:updated', this.services.threads.listAllThreads())
      this.services.orchestrator.recordAgentDefinitionMessages(thread.id, [{ id: `${runId}:user`, role: 'user', content: input.prompt, timestamp: userAt, turnId: runId }])
      const context: AgentRuntimeContextSnapshot = { profileId: this.services.profileId, threadId: thread.id, definitionId: resolved.definitionId,
        history: [], selectedFiles: [], memory: { scope: resolved.settings.memory.scope, entries: [] } }
      // Selected files are relative to this run's host-owned workspace. Missing
      // sources are reported honestly instead of reading arbitrary local paths.
      for (const path of resolved.settings.context.selectedFiles) {
        checkBundleRelativePath(path)
        const file = assertOwnedPath(workspace, join(workspace, path))
        if (existsSync(file)) context.selectedFiles!.push({ path, content: this.readContextFile(file) })
      }
      result = await this.services.orchestrator.runAgentDefinition({ profileId: this.services.profileId, resolved,
        runId, threadId: thread.id, projectPath: workspace, input: input.prompt, source: 'editor', host, context, signal: this.lifecycle.signal })
      record.state = result.status
      record.result = result
      this.writeRecord(runRoot, record)
      const messages = result.history.filter((entry) => entry.role !== 'user').map((entry, index) => ({
        id: `${runId}:history:${index}`, role: entry.role === 'assistant' ? 'assistant' as const : 'system' as const,
        content: entry.name ? `${entry.name}: ${entry.content}` : entry.content, timestamp: entry.at, turnId: runId
      }))
      if (!messages.length && result.error) messages.push({ id: `${runId}:error`, role: 'assistant', content: result.error.message, timestamp: new Date().toISOString(), turnId: runId })
      this.services.orchestrator.recordAgentDefinitionMessages(thread.id, messages)
      registry.updateStatus(runId, result.status)
      return { ok: result.status === 'completed', status: result.status === 'completed' ? 'completed' : 'failed',
        summary: (result.text || result.error?.message || 'Agent run completed without text.').slice(0, 256 * 1024), runId, threadId: thread.id,
        trace: [{ at: record.createdAt, message: `Pinned definition ${resolved.definitionId} at ${resolved.revision}` },
          { at: new Date().toISOString(), message: `${result.status}; ${result.usage.totalTokens ?? 0} tokens reported` }] }
    } catch (error) {
      record.state = this.lifecycle.stopping ? 'cancelled' : 'failed'
      delete record.result
      this.writeRecord(runRoot, record)
      registry.updateStatus(runId, record.state)
      throw error
    } finally {
      this.lifecycle.signal.removeEventListener('abort', cancelQuestions)
      cancelQuestions()
      this.services.events.broadcast('threads:updated', this.services.threads.listAllThreads())
    }
  }

  private approve(runRoot: string, request: AgentRuntimeToolApprovalRequest) {
    if (this.lifecycle.stopping) return Promise.resolve({ status: 'cancelled' as const })
    return this.lifecycle.run('agent-approval', () => this.approveOwned(runRoot, request))
  }

  private async approveOwned(runRoot: string, request: AgentRuntimeToolApprovalRequest) {
    const approvalId = randomUUID(), path = join(runRoot, `approval-${approvalId}.json`)
    this.assertRoot(); assertOwnedPath(this.root, path)
    atomicWriteJsonSync(path, { version: 1, approvalId, request, state: 'pending' })
    try {
      const answers = await this.services.questions.requestAnswers([{ id: 'approval', prompt: `Allow ${request.canonicalToolName}?\n${JSON.stringify(request.arguments).slice(0, 6000)}`,
        options: [{ id: 'approve', label: 'Allow this action' }, { id: 'reject', label: 'Reject' }] }], request.threadId)
      const approved = !this.lifecycle.stopping && answers.approval === 'approve'
      this.assertRoot()
      atomicWriteJsonSync(path, { version: 1, approvalId, request, state: approved ? 'approved' : 'denied', decidedAt: new Date().toISOString() })
      return { status: approved ? 'approved' as const : 'denied' as const, digest: request.argumentDigest }
    } catch {
      this.assertRoot()
      atomicWriteJsonSync(path, { version: 1, approvalId, request, state: 'cancelled', decidedAt: new Date().toISOString() })
      return { status: 'cancelled' as const }
    }
  }

  private assertRoot(): void {
    assertOwnedPath(this.services.getProfileHomeDir(), this.root)
    if (lstatSync(this.root).isSymbolicLink() || realpathSync(this.root) !== this.canonicalRoot) throw new Error('Agent run storage changed')
  }
  private writeRecord(root: string, record: AgentRunRecord): void {
    this.assertRoot(); assertOwnedPath(this.root, root)
    if (lstatSync(root).isSymbolicLink()) throw new Error('Agent run directory changed')
    if (Buffer.byteLength(JSON.stringify(record), 'utf8') > RECORD_MAX_BYTES) throw new Error('Agent run result exceeds its storage bound')
    atomicWriteJsonSync(join(root, 'run.json'), record)
  }
  private recoverInterrupted(): void {
    const entries = readdirSync(this.root)
    if (entries.length > 10_000) throw new Error('Agent run inventory exceeds its bound')
    for (const id of entries) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) continue
      const root = join(this.root, id), file = join(root, 'run.json')
      assertOwnedPath(this.root, root)
      if (lstatSync(root).isSymbolicLink()) throw new Error('Agent run directory changed')
      if (!existsSync(file)) continue
      const record = JSON.parse(this.readContextFile(file, RECORD_MAX_BYTES)) as AgentRunRecord
      if (record.version !== 1 || record.runId !== id || record.profileId !== this.services.profileId || !record.snapshot || record.snapshot.profileId !== this.services.profileId) throw new Error('Agent run record ownership is invalid')
      if (record.state === 'running') { record.state = 'interrupted'; this.writeRecord(root, record) }
    }
  }
  private readContextFile(path: string, maxBytes = CONTEXT_FILE_MAX_BYTES): string {
    const before = lstatSync(path)
    if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw new Error('Agent context file is not a bounded regular file')
    const fd = openSync(path, 'r')
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > maxBytes) throw new Error('Agent context file changed')
      const bytes = Buffer.alloc(stat.size + 1), count = readSync(fd, bytes, 0, bytes.length, 0)
      if (count > stat.size) throw new Error('Agent context file grew while reading')
      return bytes.subarray(0, count).toString('utf8')
    } finally { closeSync(fd) }
  }
}
