import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import type { WorkflowDocumentDto, WorkflowLibraryDto } from '../../shared/workflowPlatform'
import type { WorkflowRunStartParams, WorkflowRunView } from '../../shared/workflowRunPlatform'
import { WORKFLOW_UUID_PATTERN } from '../../shared/workflows'
import { connectDaemonClient, type DaemonClient } from '../daemonClient'
import { flagString, type ParsedArgs } from '../parseArgs'
import { writeError, writeOutput } from '../output'

const INPUT_LIMIT = 1024 * 1024
const HASH = /^[a-f0-9]{64}$/
const RUN_COMMANDS = new Set(['show', 'watch', 'trace', 'pause', 'resume', 'cancel', 'approve', 'answer', 'reconcile'])
const COMMON_FLAGS = ['profile', 'mode']
const FLAGS: Record<string, string[]> = {
  list: [], info: [],
  run: ['input', 'input-file', 'revision', 'draft', 'expected-draft', 'session', 'project', 'request-id', 'wait', 'no-wait'],
  history: ['definition', 'session', 'limit', 'before'], show: [], watch: [],
  trace: ['after', 'limit'], pause: [], resume: [], cancel: [],
  approve: ['approval-id', 'yes', 'deny'], answer: ['node', 'instance', 'input', 'input-file'],
  reconcile: ['node', 'instance', 'attempt', 'decision']
}
const SWITCHES = new Set(['wait', 'no-wait', 'draft', 'yes', 'deny'])

export interface WorkflowCliRequest {
  command: string
  target?: string
  flags: Map<string, string | boolean>
  input?: unknown
  requestId?: string
  wait: boolean
}
export interface WorkflowCliIO {
  emit(value: unknown): void
  /** Foreground cancellation only; a watch client never owns the run. */
  signal?: AbortSignal
  pollMs?: number
}
export type WorkflowCliClient = Pick<DaemonClient, 'request'>

function value(flags: Map<string, string | boolean>, key: string): string {
  const result = flagString(flags, key)
  if (!result || !result.trim()) throw new Error('--' + key + ' requires a value')
  return result
}
function integer(flags: Map<string, string | boolean>, key: string, min: number, max: number): number | undefined {
  if (!flags.has(key)) return undefined
  const text = value(flags, key)
  const result = Number(text)
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(result) || result < min || result > max) throw new Error('--' + key + ' must be an integer from ' + min + ' to ' + max)
  return result
}
function uuid(text: string, label: string): void {
  if (!WORKFLOW_UUID_PATTERN.test(text)) throw new Error(label + ' must be a UUID')
}
async function readInput(flags: Map<string, string | boolean>): Promise<unknown> {
  if (flags.has('input') && flags.has('input-file')) throw new Error('Choose --input or --input-file')
  let text = '{}'
  if (flags.has('input')) text = value(flags, 'input')
  if (flags.has('input-file')) {
    const file = await open(value(flags, 'input-file'), 'r')
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > INPUT_LIMIT) throw new Error('Input must be a regular JSON file of at most 1 MiB')
      const bytes = Buffer.alloc(INPUT_LIMIT + 1)
      let length = 0
      while (length < bytes.length) {
        const read = await file.read(bytes, length, bytes.length - length, null)
        if (!read.bytesRead) break
        length += read.bytesRead
      }
      if (length > INPUT_LIMIT) throw new Error('Input exceeds 1 MiB')
      text = bytes.subarray(0, length).toString('utf8')
    } finally { await file.close() }
  }
  if (Buffer.byteLength(text, 'utf8') > INPUT_LIMIT) throw new Error('Input exceeds 1 MiB')
  try { return JSON.parse(text.replace(/^\uFEFF/, '')) }
  catch { throw new Error('Input is not valid JSON') }
}

/** Validate and read local input before connecting or admitting any work. */
export async function prepareWorkflowCommand(args: ParsedArgs): Promise<WorkflowCliRequest> {
  const command = args.subcommand ?? 'list'
  if (!Object.hasOwn(FLAGS, command)) throw new Error('Unknown workflow command: ' + command)
  if (args.globals.provider || args.globals.model || args.globals.apiKey || args.globals.continueSession) throw new Error('Workflow commands do not accept provider/model/API-key overrides or --continue')
  if (args.globals.sessionId && command !== 'run' && command !== 'history') throw new Error('--session is supported by workflow run/history')
  const allowed = new Set([...COMMON_FLAGS, ...FLAGS[command]])
  for (const [key, flag] of args.flags) {
    if (!allowed.has(key)) throw new Error('Unsupported flag for workflow ' + command + ': --' + key)
    if (SWITCHES.has(key)) {
      if (flag !== true) throw new Error('--' + key + ' is a switch; do not supply a value')
    } else value(args.flags, key)
  }
  const needsTarget = RUN_COMMANDS.has(command) || command === 'run' || command === 'info'
  if (args.positional.length !== (needsTarget ? 1 : 0)) throw new Error('workflow ' + command + (needsTarget ? ' requires exactly one workflow/run identity' : ' accepts no positional arguments'))
  const target = args.positional[0]
  if (target && (target.length > 160 || !target.trim())) throw new Error('Invalid workflow/run identity')
  if (RUN_COMMANDS.has(command)) uuid(target, 'Run identity')
  for (const key of ['session', 'project', 'request-id', 'definition', 'approval-id']) if (args.flags.has(key)) uuid(value(args.flags, key), '--' + key)
  for (const key of ['revision', 'expected-draft']) if (args.flags.has(key) && !HASH.test(value(args.flags, key))) throw new Error('--' + key + ' requires a 64-character revision hash')
  integer(args.flags, 'limit', 1, 100)
  integer(args.flags, 'after', 0, Number.MAX_SAFE_INTEGER)
  if (args.flags.has('wait') && args.flags.has('no-wait')) throw new Error('Choose --wait or --no-wait')
  if (command === 'run') {
    if (args.flags.has('draft') !== args.flags.has('expected-draft')) throw new Error('Draft execution requires --draft and --expected-draft together')
    if (args.flags.has('draft') && args.flags.has('revision')) throw new Error('Choose a published --revision or --draft')
  }
  if (command === 'approve') {
    value(args.flags, 'approval-id')
    if (args.flags.has('yes') === args.flags.has('deny')) throw new Error('Approval requires exactly one of --yes or --deny')
  }
  if (command === 'answer' || command === 'reconcile') {
    value(args.flags, 'node'); value(args.flags, 'instance')
  }
  if (command === 'answer' && !args.flags.has('input') && !args.flags.has('input-file')) throw new Error('Answer requires --input or --input-file')
  if (command === 'reconcile') {
    if (value(args.flags, 'decision') !== 'fail') throw new Error('This runtime supports only --decision fail for an uncertain effect')
    if (integer(args.flags, 'attempt', 1, Number.MAX_SAFE_INTEGER) === undefined) throw new Error('--attempt is required')
  }
  return { command, target, flags: args.flags, wait: !args.flags.has('no-wait'),
    ...(command === 'run' || command === 'answer' ? { input: await readInput(args.flags) } : {}),
    ...(command === 'run' ? { requestId: flagString(args.flags, 'request-id') ?? randomUUID() } : {}) }
}

function owned(view: WorkflowRunView, profileId: string, runId?: string): WorkflowRunView {
  if (view.profileId !== profileId || view.origin !== 'host' || (runId && view.runId !== runId)) throw new Error('Daemon returned a workflow outside the requested ownership scope')
  return view
}
export function workflowWaitExitCode(state: WorkflowRunView['state']): number | undefined {
  switch (state) {
    case 'succeeded': return 0
    case 'failed': return 1
    case 'waiting-approval': case 'waiting-input': return 3
    case 'cancelled': return 4
    case 'interrupted': case 'unknown-effect': case 'recovery-required': return 5
    default: return undefined
  }
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    if (signal?.aborted) done()
    else signal?.addEventListener('abort', done, { once: true })
  })
}
async function watch(client: WorkflowCliClient, profileId: string, initial: WorkflowRunView, io: WorkflowCliIO, cancelOnInterrupt: boolean): Promise<number> {
  let current = owned(initial, profileId)
  let last = ''
  for (;;) {
    const stamp = JSON.stringify([current.state, current.journalSequence, current.updatedAt])
    if (stamp !== last) { io.emit({ kind: 'run', run: current }); last = stamp }
    const exit = workflowWaitExitCode(current.state)
    if (exit !== undefined && (!io.signal?.aborted || ['succeeded', 'failed', 'cancelled'].includes(current.state))) return exit
    if (io.signal?.aborted) {
      if (!cancelOnInterrupt) return 130
      // Cancellation is explicit. Closing a socket never owns this transition.
      current = owned(await client.request<WorkflowRunView>('workflowRuns.cancel', { profileId, runId: current.runId }), profileId, current.runId)
      io.emit({ kind: 'cancellation-requested', run: current })
      return workflowWaitExitCode(current.state) ?? 4
    }
    await delay(io.pollMs ?? 500, io.signal)
    // Read after the previous request settles; never overlap polling requests.
    if (!io.signal?.aborted) current = owned(await client.request<WorkflowRunView>('workflowRuns.get', { profileId, runId: current.runId }), profileId, current.runId)
  }
}

export async function waitForWorkflowRun(client: WorkflowCliClient, profileId: string, runId: string, io: WorkflowCliIO, ownedForeground = false): Promise<number> {
  const current = owned(await client.request<WorkflowRunView>('workflowRuns.get', { profileId, runId }), profileId, runId)
  return watch(client, profileId, current, io, ownedForeground)
}

/** Same framed daemon API used by the desktop. No local engine or implicit approvals. */
export async function executeWorkflowCommand(request: WorkflowCliRequest, client: WorkflowCliClient, profileId: string, io: WorkflowCliIO): Promise<number> {
  const { command, target, flags } = request
  const scope = { profileId }
  const runScope = { ...scope, runId: target! }
  const get = async () => owned(await client.request<WorkflowRunView>('workflowRuns.get', runScope), profileId, target)
  const resolveDefinition = async () => {
    // UUID input can retry a durable admission even after a name/head changes.
    if (WORKFLOW_UUID_PATTERN.test(target!)) return target!
    const rows = await client.request<WorkflowLibraryDto[]>('workflows.list', scope)
    const matching = rows.filter((row) => row.source === 'profile' && !row.archived && (row.slug === target || row.name === target))
    if (matching.length !== 1) throw new Error(matching.length ? 'Workflow name is ambiguous; use its UUID' : 'Workflow was not found in this profile')
    return matching[0].id
  }
  if (command === 'list') { io.emit({ kind: 'definitions', workflows: await client.request('workflows.list', scope) }); return 0 }
  if (command === 'info') {
    const id = await resolveDefinition()
    const document = await client.request<WorkflowDocumentDto>('workflows.get', { ...scope, id })
    if (document.profileId !== profileId || document.id !== id) throw new Error('Workflow belongs to a different profile')
    io.emit({ kind: 'definition', workflow: document }); return 0
  }
  if (command === 'history') {
    io.emit({ kind: 'history', ...await client.request<Record<string, unknown>>('workflowRuns.list', { ...scope,
      definitionId: flagString(flags, 'definition'), threadId: flagString(flags, 'session'), before: flagString(flags, 'before'), limit: integer(flags, 'limit', 1, 100) }) }); return 0
  }
  if (command === 'run') {
    const definitionId = await resolveDefinition()
    const params: WorkflowRunStartParams = { profileId, definitionId, input: request.input, requestId: request.requestId!,
      threadId: flagString(flags, 'session'), projectId: flagString(flags, 'project'),
      ...(flags.has('draft') ? { draft: true, expectedDraftSemanticHash: value(flags, 'expected-draft') } : { revisionId: flagString(flags, 'revision') }) }
    // Print before sending: loss of the response must not force a new identity.
    io.emit({ kind: 'admitting', requestId: params.requestId, definitionId, profileId })
    if (io.signal?.aborted) return 130
    const current = owned(await client.request<WorkflowRunView>('workflowRuns.start', params), profileId)
    if (current.definitionId !== definitionId) throw new Error('Daemon admitted a different workflow definition')
    io.emit({ kind: 'accepted', requestId: params.requestId, runId: current.runId, revisionId: current.revisionId, profileId })
    return request.wait ? watch(client, profileId, current, io, true) : 0
  }
  if (command === 'trace') {
    io.emit({ kind: 'trace', ...await client.request<Record<string, unknown>>('workflowRuns.trace', { ...runScope, afterSequence: integer(flags, 'after', 0, Number.MAX_SAFE_INTEGER), limit: integer(flags, 'limit', 1, 100) }) }); return 0
  }
  if (command === 'show' || command === 'watch') {
    const current = await get()
    if (command === 'watch') return watch(client, profileId, current, io, false)
    io.emit({ kind: 'run', run: current }); return 0
  }
  const method = 'workflowRuns.' + command
  let params: Record<string, unknown> = runScope
  if (command === 'approve') {
    const pending = (await get()).pendingApproval
    if (!pending || pending.approvalId !== value(flags, 'approval-id')) throw new Error('The named approval is no longer pending; inspect the run again')
    params = { ...runScope, approvalId: pending.approvalId, nodeId: pending.nodeId, instanceKey: pending.instanceKey, attempt: pending.attempt, approved: flags.has('yes') }
  } else if (command === 'answer') {
    params = { ...runScope, nodeId: value(flags, 'node'), instanceKey: value(flags, 'instance'), data: request.input }
  } else if (command === 'reconcile') {
    params = { ...runScope, nodeId: value(flags, 'node'), instanceKey: value(flags, 'instance'), attempt: integer(flags, 'attempt', 1, Number.MAX_SAFE_INTEGER), decision: 'fail' }
  }
  const current = owned(await client.request<WorkflowRunView>(method, params), profileId, target)
  io.emit({ kind: 'run', run: current })
  return 0
}

export async function runWorkflow(args: ParsedArgs): Promise<void> {
  let client: DaemonClient | undefined
  let request: WorkflowCliRequest | undefined
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  try {
    request = await prepareWorkflowCommand(args)
    // Do not use openMms: its chat override path can persist provider settings.
    client = await connectDaemonClient({ homeDir: args.globals.homeDir || undefined })
    const status = await client.request<{ defaultProfileId: string }>('profiles.status')
    await client.request('profiles.bind', { profile: args.globals.profile ?? status.defaultProfileId })
    const bound = await client.request<{ binding: { profileId: string } | null }>('profiles.status')
    if (!bound.binding?.profileId) throw new Error('Daemon did not bind the requested profile')
    process.on('SIGINT', interrupt)
    process.exitCode = await executeWorkflowCommand(request, client, bound.binding.profileId, {
      emit: (event) => writeOutput(args.globals.mode, event), signal: controller.signal
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const retry = request?.requestId ? ' Request ID: ' + request.requestId + '; reuse it with identical arguments if admission was not acknowledged.' : ''
    writeError(message + retry, args.globals.mode)
    process.exitCode = 2
  } finally {
    process.removeListener('SIGINT', interrupt)
    await client?.close()
  }
}
