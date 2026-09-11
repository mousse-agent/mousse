import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMode, OrchestratorSendRequest } from '../../shared/types'
import type { WorkflowChatRun } from '../../shared/workflowChat'
import type { WorkflowRunStartParams } from '../../shared/workflowRunPlatform'
import { isPlainObject, stableStringify, WORKFLOW_UUID_PATTERN } from '../../shared/workflows'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import type { ThreadDataStore } from '../data/ThreadDataStore'
import { DomainRpcError } from '../protocol/domainRegistry'
import { sha256Utf8 } from '../workflows/hash'
import { WorkflowInvocationError, type WorkflowInvocationResolver } from '../workflows/commands/WorkflowInvocationResolver'
import { WorkflowCommandSyntaxError } from '../../shared/workflows/commandTokenizer'
import type { MmsWorkflowCoordinator } from './MmsWorkflowCoordinator'
import { validateWorkflowRunParams } from '../workflows/runDomainValidation'

interface Receipt {
  version: 2
  profileId: string
  threadId: string
  original: string
  digest: string
  title: string
  source: 'gui' | 'cli'
  params: WorkflowRunStartParams
  cancelled?: boolean
  integrity: string
}
export interface WorkflowChatExecutor {
  execute(invocationId: string, threadId: string, original: string, signal: AbortSignal): Promise<WorkflowChatRun>
  abandon(invocationId: string, threadId: string): void
}
interface Options {
  profileId: string
  profileRoot: string
  threads: ThreadDataStore
  resolver: WorkflowInvocationResolver
  runs: MmsWorkflowCoordinator
  skillMode(name: string): Promise<ChatMode | undefined>
}

/** Prepared receipts have no effects. Only a claimed chat turn admits the graph. */
export class MmsWorkflowChatBridge implements WorkflowChatExecutor {
  private readonly root: string
  private readonly canonicalRoot: string
  private preparing: Promise<unknown> = Promise.resolve()
  constructor(private readonly options: Options) {
    this.root = join(options.profileRoot, 'workflow-chat-invocations')
    if (existsSync(this.root) && lstatSync(this.root).isSymbolicLink()) throw new Error('Workflow receipt directory cannot be a symlink')
    mkdirSync(this.root, { recursive: true })
    this.canonicalRoot = realpathSync(this.root)
  }

  prepare(threadId: string, input: OrchestratorSendRequest, source: 'gui' | 'cli'): Promise<OrchestratorSendRequest> {
    // The input reference is strictly host-owned and is never accepted from RPC.
    if (input.workflowInvocationId) throw new DomainRpcError('invalid_params', 'A workflow receipt cannot be supplied by a client')
    if (!input.content.startsWith('/')) return Promise.resolve(input)
    const task = this.preparing.then(() => this.prepareSerial(threadId, input, source))
    this.preparing = task.catch(() => undefined)
    return task.catch((error: unknown) => {
      if (error instanceof WorkflowInvocationError) throw new DomainRpcError(error.code, error.message, error.details)
      if (error instanceof WorkflowCommandSyntaxError) throw new DomainRpcError(error.code, error.message, { offset: error.offset })
      throw error
    })
  }

  private async prepareSerial(threadId: string, input: OrchestratorSendRequest, source: 'gui' | 'cli'): Promise<OrchestratorSendRequest> {
    this.thread(threadId)
    if (input.requestId && !WORKFLOW_UUID_PATTERN.test(input.requestId)) throw new DomainRpcError('invalid_params', 'Invalid workflow request identity')
    const digest = sha256Utf8(stableStringify({ profileId: this.options.profileId, threadId, content: input.content, mode: input.mode, images: input.images, source }))
    if (input.requestId && existsSync(this.path(input.requestId))) {
      const receipt = this.read(input.requestId, threadId)
      if (receipt.digest !== digest) throw new DomainRpcError('WORKFLOW_CONCURRENCY_CONFLICT', 'This request identity already belongs to a different invocation')
      if (receipt.cancelled) throw new DomainRpcError('invocation_cancelled', 'This queued workflow was removed; use a new request identity to run it again')
      return { ...input, workflowInvocationId: input.requestId }
    }
    const invocation = await this.options.resolver.resolve(input.content, { profileId: this.options.profileId })
    if (invocation.kind === 'text') return { ...input, content: invocation.text }
    if (invocation.kind === 'builtin') return input
    if (invocation.kind === 'unknown') throw new DomainRpcError('unknown_command', 'Unknown workflow or skill: /' + invocation.name)
    if (invocation.kind === 'ambiguous') throw new DomainRpcError('ambiguous_command', 'Choose an explicit namespace: ' + invocation.choices.join(' or '))
    if (invocation.kind === 'skill') {
      const mode = await this.options.skillMode(invocation.name)
      if (!mode) throw new DomainRpcError('skill_unavailable', 'Skill is unavailable in this profile')
      return { ...input, mode }
    }
    if (!input.requestId) throw new DomainRpcError('request_id_required', 'Workflow slash commands require a stable caller requestId')
    if (input.images?.length) throw new DomainRpcError('invalid_arguments', 'Pass workflow attachments through its declared input fields')
    const params: WorkflowRunStartParams = { profileId: this.options.profileId, threadId, definitionId: invocation.definitionId,
      revisionId: invocation.revisionId, requestId: input.requestId, input: invocation.input }
    this.options.runs.validateStart(params)
    this.thread(threadId)
    const body: Omit<Receipt, 'integrity'> = { version: 2, profileId: this.options.profileId, threadId, original: input.content, digest,
      title: invocation.record.compiled.name, source, params }
    const receipt: Receipt = { ...body, integrity: sha256Utf8(stableStringify(body)) }
    atomicWriteJsonSync(this.path(input.requestId), receipt)
    return { ...input, workflowInvocationId: input.requestId }
  }

  async execute(invocationId: string, threadId: string, original: string, signal: AbortSignal): Promise<WorkflowChatRun> {
    const receipt = this.read(invocationId, threadId)
    if (receipt.original !== original) throw new DomainRpcError('WORKFLOW_CONCURRENCY_CONFLICT', 'Queued workflow content no longer matches its durable receipt')
    if (receipt.cancelled) throw new DomainRpcError('invocation_cancelled', 'The queued workflow was removed')
    if (signal.aborted) throw new DomainRpcError('cancelled', 'Workflow start cancelled before admission')
    let snapshot = await this.options.runs.start(receipt.params, { connectionId: 'chat:' + invocationId, source: receipt.source })
    if (signal.aborted) snapshot = await this.options.runs.runtime.cancel(snapshot.manifest.runId, { profileId: this.options.profileId }, 'Chat start interrupted')
    return { invocationId, profileId: receipt.profileId, threadId, definitionId: receipt.params.definitionId,
      revisionId: receipt.params.revisionId!, runId: snapshot.manifest.runId, title: receipt.title, state: snapshot.manifest.state }
  }

  abandon(invocationId: string, threadId: string): void {
    const receipt = this.read(invocationId, threadId)
    const { integrity: _integrity, ...body } = { ...receipt, cancelled: true }
    atomicWriteJsonSync(this.path(invocationId), { ...body, integrity: sha256Utf8(stableStringify(body)) })
  }

  private path(id: string): string {
    if (lstatSync(this.root).isSymbolicLink() || realpathSync(this.root) !== this.canonicalRoot) throw new DomainRpcError('invocation_unavailable', 'Workflow receipt directory changed')
    if (!WORKFLOW_UUID_PATTERN.test(id)) throw new DomainRpcError('invalid_params', 'Invalid workflow receipt identity')
    return join(this.root, id + '.json')
  }
  private thread(id: string): void {
    const thread = this.options.threads.getThread(id)
    if (!thread || thread.settledAt) throw new DomainRpcError('thread_unavailable', 'Workflow thread is unavailable in this profile')
  }
  private read(id: string, threadId: string): Receipt {
    this.thread(threadId)
    const path = this.path(id)
    if (!existsSync(path)) throw new DomainRpcError('invocation_unavailable', 'Workflow invocation receipt is missing')
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new DomainRpcError('invocation_unavailable', 'Workflow invocation receipt is invalid')
    const descriptor = openSync(path, 'r')
    let receipt: Receipt
    try {
      const opened = fstatSync(descriptor)
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new DomainRpcError('invocation_unavailable', 'Workflow receipt changed while opening')
      const bytes = Buffer.alloc(2 * 1024 * 1024 + 1)
      let count = 0
      while (count < bytes.length) {
        const n = readSync(descriptor, bytes, count, bytes.length - count, null)
        if (!n) break
        count += n
      }
      if (count === bytes.length) throw new DomainRpcError('invocation_unavailable', 'Workflow receipt exceeds its bound')
      const decoded: unknown = JSON.parse(bytes.subarray(0, count).toString('utf8'))
      if (!isPlainObject(decoded) || !isPlainObject(decoded.params)) throw new DomainRpcError('invocation_unavailable', 'Workflow receipt is invalid')
      receipt = decoded as unknown as Receipt
      this.path(id)
      const after = lstatSync(path)
      if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) throw new DomainRpcError('invocation_unavailable', 'Workflow receipt changed while reading')
    } catch (error) {
      if (error instanceof DomainRpcError) throw error
      throw new DomainRpcError('invocation_unavailable', 'Workflow receipt is not readable')
    } finally { closeSync(descriptor) }
    const { integrity, ...body } = receipt
    if (typeof integrity !== 'string' || !/^[a-f0-9]{64}$/.test(integrity) || sha256Utf8(stableStringify(body)) !== integrity) throw new DomainRpcError('invocation_unavailable', 'Workflow receipt integrity check failed')
    if (receipt.version !== 2 || receipt.profileId !== this.options.profileId || receipt.threadId !== threadId || receipt.params?.profileId !== this.options.profileId || receipt.params.threadId !== threadId || receipt.params.requestId !== id) throw new DomainRpcError('profile_mismatch', 'Workflow receipt does not belong to this thread/profile')
    validateWorkflowRunParams('workflowRuns.start', receipt.params)
    if (!receipt.params.revisionId || receipt.params.draft || !['gui', 'cli'].includes(receipt.source) || typeof receipt.title !== 'string' || receipt.title.length > 120 || !/^[a-f0-9]{64}$/.test(receipt.digest) || (receipt.cancelled !== undefined && typeof receipt.cancelled !== 'boolean')) throw new DomainRpcError('invocation_unavailable', 'Invalid workflow invocation receipt')
    return receipt
  }
}
