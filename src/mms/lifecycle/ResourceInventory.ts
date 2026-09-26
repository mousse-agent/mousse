import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { LifecycleResource, ResourceInventorySnapshot, ResourceSource, RetentionClaimKind, TaskLifecycleRecord } from '../../shared/resourceLifecycle'
import { assertLifecyclePath, ResourceLifecycleStore, validateResourceInventory } from './ResourceLifecycleStore'
import { canonicalJson, sha256Hex } from '../../shared/agents/hashes'
import { WorktreeRetirementService } from './WorktreeRetirementService'
import { UndoRetentionService } from '../actions/UndoRetentionService'
import { AgentEpisodeStore } from '../agents/AgentEpisodeStore'
import { ThreadJournal } from '../data/ThreadJournal'

type JsonObject = Record<string, unknown>
const object = (value: unknown): JsonObject | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
const rows = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(object).filter((row): row is JsonObject => Boolean(row)) : []
const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')

export interface ResourceInventoryOptions {
  /** Additional known source containers; never walk browser caches or repository files. */
  sourceRoots?: string[]
}

/**
 * Read-only source projection. This deliberately does not call a directory name ownership proof,
 * infer that clean Git status makes a tree disposable, or release any retention claim.
 * Historical generation snapshots are not scanned as live claim authorities.
 */
export function buildResourceInventory(store: ResourceLifecycleStore, record: TaskLifecycleRecord, options: ResourceInventoryOptions = {}): ResourceInventorySnapshot {
  const result: ResourceInventorySnapshot = { schemaVersion: 1, profileId: store.profileId, taskId: record.taskId, generation: record.generation, observedAt: new Date().toISOString(), sources: [], resources: [], blockers: [] }
  const resources = new Map<string, LifecycleResource>()
  const verifiedWorktrees = new Map<string, string | undefined>()
  const seenPaths = new Set<string>()
  const source = (path: string, required = false): { source: ResourceSource; data: unknown } | undefined => {
    if (seenPaths.has(path)) return undefined
    seenPaths.add(path)
    if (!existsSync(path) && !required) return undefined
    const id = digest(path)
    try {
      // Read records only. Symlinked/malformed sources never become ownership authority.
      if (!relative(store.profileHome, path).startsWith('..')) assertLifecyclePath(store.profileHome, path)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('Source is not a bounded regular record')
      const raw = readFileSync(path, 'utf8')
      const data: unknown = JSON.parse(raw)
      const value: ResourceSource = { id, path, digest: digest(raw), status: 'verified' }
      result.sources.push(value)
      return { source: value, data }
    } catch (error) {
      const reason = `Cannot establish source ${path}: ${(error as Error).message}`
      result.sources.push({ id, path, digest: 'unknown', status: 'unknown', reason })
      result.blockers.push(reason)
      return undefined
    }
  }
  const resource = (kind: LifecycleResource['kind'], identity: string | undefined, sourceId: string, claim: RetentionClaimKind | undefined, condition: string, ownerTaskId = record.taskId, repositoryId?: string): void => {
    if (!identity) return
    const id = digest(`${kind}\0${repositoryId ?? ''}\0${identity}`)
    let value = resources.get(id)
    if (!value) {
      value = { id, kind, identity, ownerTaskId, ...(repositoryId ? { repositoryId } : {}), ownership: 'source-associated', materialization: ['task-data', 'worktree', 'workflow-record', 'invocation-thread', 'runtime'].includes(kind) ? (existsSync(identity) ? 'present' : 'absent') : 'unknown', sourceIds: [], claims: [] }
      resources.set(id, value)
    }
    if (!value.sourceIds.includes(sourceId)) value.sourceIds.push(sourceId)
    if (claim && !value.claims.some((item) => item.sourceId === sourceId && item.kind === claim && item.ownerTaskId === ownerTaskId)) value.claims.push({ schemaVersion: 1, kind: claim, sourceId, ownerTaskId, condition })
  }

  const recordRows = (value: unknown, label: string): JsonObject[] => {
    if (!Array.isArray(value) || value.some((item) => !object(item))) result.blockers.push(`Unknown record in ${label}`)
    return rows(value)
  }
  const verifyWorktree = (path: string | undefined, expectedBranch: string | undefined, expectedRepository: string | undefined): void => {
    if (!path) return
    const key = `${path}\0${expectedBranch}\0${expectedRepository}`
    if (!verifiedWorktrees.has(key)) {
      let failure: string | undefined
      try {
        if (!isAbsolute(path)) throw new Error('Registered checkout is not absolute')
        if (!existsSync(path)) {
          const retirement = new WorktreeRetirementService(store)
          const owners = store.list().filter((task) => existsSync(retirement.pathFor(task.taskId, path)))
          if (owners.length !== 1) throw new Error('Absent checkout lacks unique reconstruction authority')
          const manifest = retirement.load(retirement.pathFor(owners[0].taskId, path))
          if (expectedBranch && manifest.branch !== expectedBranch || expectedRepository && manifest.repositoryId !== expectedRepository) throw new Error('Reconstruction owner changed')
          retirement.verifyPins(manifest)
          verifiedWorktrees.set(key, undefined)
          for (const value of resources.values()) if (value.kind === 'worktree' && value.identity === path) value.ownership = 'verified'
          return
        }
        if (lstatSync(path).isSymbolicLink() || !lstatSync(join(path, '.git')).isFile()) throw new Error('Not a regular linked Git worktree')
        const git = (...args: string[]) => execFileSync('git', args, { cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim()
        const common = realpathSync(resolve(path, git('rev-parse', '--git-common-dir')))
        const repositoryId = digest(common.toLowerCase()).slice(0, 32)
        if (expectedRepository && repositoryId !== expectedRepository) throw new Error('Repository common-directory identity changed')
        const branch = git('branch', '--show-current')
        if (!/^mousse\/(thread|agent|workflow)\//.test(branch) || (expectedBranch && branch !== expectedBranch)) throw new Error('Worktree branch is not the source-owned branch')
        const top = realpathSync(git('rev-parse', '--show-toplevel'))
        if (top.toLowerCase() !== realpathSync(path).toLowerCase()) throw new Error('Source path is not the registered worktree root')
        const listed = git('worktree', 'list', '--porcelain').split(/\r?\n/).some((line) => line.startsWith('worktree ') && resolve(line.slice(9)).toLowerCase() === resolve(path).toLowerCase())
        if (!listed) throw new Error('Git does not register the worktree')
      } catch (error) { failure = `Unverified worktree ${path}: ${(error as Error).message}` }
      verifiedWorktrees.set(key, failure)
    }
    const failure = verifiedWorktrees.get(key)
    for (const value of resources.values()) if (value.kind === 'worktree' && value.identity === path) value.ownership = failure ? 'unknown' : 'verified'
    if (failure) result.blockers.push(failure)
  }

  const inventoryTask = (task: TaskLifecycleRecord): void => {
    let expiredReceipts: ReadonlySet<string>
    try { expiredReceipts = new UndoRetentionService(task.location, Date.now, true).expiredReceiptIds() }
    catch (error) { result.blockers.push(`Undo retention authority is invalid: ${(error as Error).message}`); expiredReceipts = new Set() }
    const authority = source(store.recordPath(task.taskId), true)
    if (authority) resource('runtime', store.recordPath(task.taskId), authority.source.id, 'recovery', 'Stable lifecycle mapping, operation receipts and tombstone remain authoritative', task.taskId)
    const meta = source(join(task.location, 'meta.json'), true)
    if (!meta) return
    if (object(meta.data)?.id !== task.taskId) result.blockers.push(`Task metadata owner mismatch: ${task.taskId}`)
    resource(task.taskId === record.taskId ? 'task-data' : 'invocation-thread', task.location, meta.source.id, 'conversation-attachment', 'Conversation owner remains retained', task.taskId)
    if (task.state !== 'active') resource('task-data', task.location, meta.source.id, 'trash-restore', 'Reversible lifecycle operation or trash record exists', task.taskId)
    const workspace = source(join(task.location, 'workspace.json'))
    let repositoryId: string | undefined
    if (workspace) {
      const value = object(workspace.data)
      if (value?.schemaVersion !== 1 || value.threadId !== task.taskId) result.blockers.push(`Unknown workspace owner/schema: ${task.taskId}`)
      repositoryId = text(value?.repositoryId)
      resource('worktree', text(value?.worktreePath), workspace.source.id, 'current-result', 'Task workspace is the authoritative current result', task.taskId, repositoryId)
      resource('git-ref', text(value?.retainedRef), workspace.source.id, 'current-result', 'Task result remains retained', task.taskId, repositoryId)
      if (text(value?.branch)) resource('git-ref', `refs/heads/${value!.branch}`, workspace.source.id, 'current-result', 'Task branch remains retained', task.taskId, repositoryId)
      verifyWorktree(text(value?.worktreePath), text(value?.branch), repositoryId)
      if (['conflicted', 'recovery_required', 'provisioning'].includes(String(value?.lifecycle))) resource('worktree', text(value?.worktreePath), workspace.source.id, value?.lifecycle === 'conflicted' ? 'conflict' : 'recovery', 'Workspace operation has not settled', task.taskId, repositoryId)
    }
    for (const name of ['agents.json', 'mousse-agent-sessions.json']) {
      const found = source(join(task.location, name))
      if (!found) continue
      if (!Array.isArray(found.data)) { result.blockers.push(`Invalid ${name} collection`); continue }
      for (const agent of recordRows(found.data, name)) {
        const agentId = text(agent.agentId) ?? text(agent.id)
        if (!agentId) { result.blockers.push(`Unidentified agent in ${name}`); continue }
        const claim: RetentionClaimKind = agent.status === 'conflict' ? 'conflict' : ['ready', 'running', 'starting', 'interrupted', 'failed'].includes(String(agent.status)) ? 'pending-integration' : 'recall'
        resource('agent-session', `${task.taskId}/${agentId}`, found.source.id, 'recall', 'Durable agent conversation/assignment exists', task.taskId)
        resource('worktree', text(agent.worktreePath), found.source.id, claim, 'Agent source retains its result or resume workspace', task.taskId, repositoryId)
        if (text(agent.branch)) resource('git-ref', `refs/heads/${agent.branch}`, found.source.id, claim, 'Agent branch remains referenced by its owner', task.taskId, repositoryId)
        // A registered Try Agent scratch directory has explicit non-Git ownership in run.json.
        const scratchRecordPath = join(store.profileHome, 'agent-runs', agentId, 'run.json')
        const scratch = !text(agent.branch) && existsSync(scratchRecordPath) ? source(scratchRecordPath) : undefined
        if (scratch && object(scratch.data)?.threadId === task.taskId && object(scratch.data)?.profileId === store.profileId && text(agent.worktreePath) === join(dirname(scratchRecordPath), 'workspace')) {
          for (const item of resources.values()) if (item.kind === 'worktree' && item.identity === agent.worktreePath) { item.kind = 'runtime'; item.ownership = 'source-associated'; item.sourceIds.push(scratch.source.id) }
          resource('workflow-record', dirname(scratchRecordPath), scratch.source.id, 'recall', 'Try Agent record owns its scratch workspace and execution snapshot', task.taskId)
        } else verifyWorktree(text(agent.worktreePath), text(agent.branch), repositoryId)
        if (name === 'agents.json' && text(agent.branch)) {
          resource('git-ref', `refs/mousse/agents/${agentId}/base`, found.source.id, 'recall', 'Agent spawn base is retained', task.taskId, repositoryId)
          resource('git-ref', `refs/mousse/agents/${agentId}`, found.source.id, claim, 'Agent result retention is source-derived; physical ref may be absent', task.taskId, repositoryId)
        }
      }
    }
    const branches = source(join(task.location, 'conversation-branches.json'))
    if (branches) for (const branch of recordRows(branches.data, 'conversation branches')) {
      const branchId = text(branch.id)
      resource('git-ref', text(branch.retainedRef) ?? (branchId ? `refs/mousse/conversation-branches/${branchId}` : undefined), branches.source.id, 'recall', 'Conversation branch retains its exact code boundary', task.taskId, repositoryId)
    }
    const named = source(join(task.location, 'agent-episodes.json'))
    const namedReceiptClaims = new Set<string>()
    if (named) {
      try {
        const state = new AgentEpisodeStore(task.location).read()
        const receipts = new ThreadJournal(task.location, { readOnly: true }).list().map((entry) => object(object(entry.details)?.receipt)).filter((entry): entry is JsonObject => Boolean(entry))
        const contextEpisodes = new Set<string>(), resolvedContext = new Set<string>()
        const identities = new Map(state.identities.map((identity) => [identity.id, identity]))
        for (const episode of [...state.episodes].reverse()) {
          if (resolvedContext.has(episode.agentId) || identities.get(episode.agentId)?.state === 'retired' || !['completed', 'failed', 'interrupted'].includes(episode.state)) continue
          if (![episode.agentId, episode.id].every((id) => /^[a-z0-9][a-z0-9_-]{2,127}$/i.test(id))) throw new Error('Invalid context publication identity')
          const publication = source(join(task.location, 'agent-contexts', episode.agentId, `${episode.id}.json`))
          if (publication) {
            const value = object(publication.data), snapshot = object(value?.snapshot)
            if (value?.schemaVersion !== 1 || value.agentId !== episode.agentId || value.episodeId !== episode.id || value.expectedContextGeneration !== episode.contextGeneration || snapshot?.agentId !== episode.agentId || snapshot.runState === 'running' || !['completed', 'failed', 'interrupted'].includes(String(value.status)) || !object(value.result)) throw new Error('Invalid context publication')
            contextEpisodes.add(episode.id); resolvedContext.add(episode.agentId)
          } else if (episode.request?.contextMode === 'fresh') resolvedContext.add(episode.agentId)
        }
        for (const identity of state.identities.filter((identity) => identity.state !== 'retired')) {
          resource('agent-session', `${task.taskId}/${identity.id}`, named.source.id, 'recall', 'Named agent identity retains context and its latest result', task.taskId)
        }
        for (const episode of state.episodes) {
          const identity = identities.get(episode.agentId)!
          const recall = identity.state !== 'retired' && (episode.id === identity.lastEpisodeId || episode.id === identity.activeEpisodeId || contextEpisodes.has(episode.id))
          const disposition = state.integrations?.find((entry) => entry.episodeId === episode.id)
          const integrated = disposition && receipts.some((receipt) => receipt.id === disposition.receiptId && receipt.operationId === disposition.operationId && receipt.kind === 'integration' && receipt.afterSha === disposition.integrationSha && rows(receipt.contributions).some((contribution) => contribution.actorId === episode.agentId && contribution.resultSha === disposition.resultSha))
          const pending = episode.policy.workspace === 'isolated' && episode.policy.access === 'write' && !integrated && episode.result?.resultSha !== episode.binding.baseSha
          const claim: RetentionClaimKind | undefined = pending ? 'pending-integration' : recall ? 'recall' : undefined
          if ((recall || pending) && episode.result?.receiptId) namedReceiptClaims.add(episode.result.receiptId)
          if (episode.policy.workspace === 'isolated') {
            resource('worktree', episode.binding.worktreePath, named.source.id, claim, 'Unresolved result or current named context retains this episode', task.taskId, repositoryId)
            resource('git-ref', episode.binding.branch ? `refs/heads/${episode.binding.branch}` : undefined, named.source.id, claim, 'Episode owns its isolated branch', task.taskId, repositoryId)
            resource('git-ref', `refs/mousse/agents/${episode.id}/base`, named.source.id, claim, 'Episode owns its spawn base', task.taskId, repositoryId)
            resource('git-ref', `refs/mousse/agents/${episode.id}/result`, named.source.id, claim, 'Episode owns its retained integration result', task.taskId, repositoryId)
            verifyWorktree(episode.binding.worktreePath, episode.binding.branch, repositoryId)
          }
        }
      } catch (error) { result.blockers.push(`Named agent claims are invalid: ${(error as Error).message}`) }
    }
    // Receipts in the journal, rather than duplicate action/generation projections, own retained refs.
    const journalRoot = join(task.location, 'journal')
    const latest = new Map<string, { source: ResourceSource; data: JsonObject }>()
    if (existsSync(journalRoot)) {
      try {
        assertLifecyclePath(task.location, journalRoot)
        for (const name of readdirSync(journalRoot).filter((name) => /^\d{16}\.json$/.test(name)).sort()) {
          const entry = source(join(journalRoot, name))
          if (!entry) continue
          const data = object(entry.data)
          if (data?.schemaVersion !== 1 || !text(data.operationId)) { result.blockers.push('Unknown journal record schema/operation'); continue }
          latest.set(String(data.operationId), { source: entry.source, data })
          const receipt = object(object(data.details)?.receipt)
          if (receipt) {
            const kind: RetentionClaimKind = receipt.kind === 'undo' ? 'redo' : 'undo'
            if (!Array.isArray(receipt.retainedRefs)) { result.blockers.push('Receipt lacks retained ref authority'); continue }
            const expired = typeof receipt.id === 'string' && expiredReceipts.has(receipt.id)
            for (const ref of receipt.retainedRefs) {
              resource('git-ref', text(ref), entry.source.id, kind, 'Action remains eligible under the Undo retention policy', task.taskId, repositoryId)
              if (expired) for (const item of resources.values()) if (item.kind === 'git-ref' && item.identity === ref) item.claims = item.claims.filter((claim) => claim.sourceId !== entry.source.id || !['undo', 'redo'].includes(claim.kind))
              if (named && namedReceiptClaims.has(String(receipt.id))) resource('git-ref', text(ref), named.source.id, 'recall', 'Retained named agent episode references this result receipt', task.taskId, repositoryId)
            }
          }
        }
      } catch (error) { result.blockers.push(`Journal inventory failed: ${(error as Error).message}`) }
    }
    for (const entry of latest.values()) if (['planned', 'running', 'prepared', 'git_applied', 'context_pending', 'recovery_required'].includes(String(entry.data.state))) resource('task-data', task.location, entry.source.id, 'recovery', `Unsettled operation ${entry.data.operationId}`, task.taskId)
    // Attachments are retained associations. No blob is unlinked in this phase.
    const messages = source(join(task.location, 'messages.json'))
    if (messages) {
      const walk = (value: unknown, depth = 0): void => {
        if (depth > 40) { result.blockers.push('Attachment graph exceeds supported nesting'); return }
        if (Array.isArray(value)) { value.forEach((item) => walk(item, depth + 1)); return }
        const node = object(value)
        if (!node) return
        // Execution/browser tools embed the complete immutable ArtifactReference in message blocks.
        if (typeof node.id === 'string' && typeof node.profileId === 'string' && typeof node.sha256 === 'string' && typeof node.mediaType === 'string') {
          if (node.profileId !== store.profileId || !/^[a-f0-9-]{36}$/i.test(node.id) || !/^[a-f0-9]{64}$/i.test(node.sha256)) result.blockers.push('Conversation artifact reference has invalid profile or identity')
          else resource('artifact', node.id, messages.source.id, 'conversation-attachment', 'Conversation embeds an immutable artifact reference', task.taskId)
        }
        for (const [key, child] of Object.entries(node)) {
          if (['artifactId', 'artifactRef', 'blobId'].includes(key) && typeof child === 'string') resource('artifact', child, messages.source.id, 'conversation-attachment', 'Conversation references this artifact', task.taskId)
          else if (typeof child === 'object') walk(child, depth + 1)
        }
      }
      walk(messages.data)
    }
  }

  const tasks = store.list()
  const owned = new Map([[record.taskId, record]])
  for (let added = true; added;) {
    added = false
    for (const task of tasks) if (task.parentTaskId && owned.has(task.parentTaskId) && !owned.has(task.taskId)) { owned.set(task.taskId, task); added = true }
  }
  for (const task of owned.values()) inventoryTask(task)
  const config = source(join(store.profileHome, 'mousse.conf'))
  const scheduledRuntime = source(join(store.profileHome, 'scheduled', 'jobs-runtime.json'))
  if (config) for (const job of recordRows(object(object(config.data)?.scheduled)?.jobs ?? [], 'scheduled job definitions')) {
    const owner = text(job.threadId)
    if (!owner || !owned.has(owner)) continue
    resource('workflow-record', `${config.source.path}#scheduled.jobs/${String(job.id)}`, config.source.id, 'recall', 'Scheduled definition explicitly targets this task', owner)
    if (scheduledRuntime) resource('workflow-record', `${scheduledRuntime.source.path}#${String(job.id)}`, scheduledRuntime.source.id, 'recall', 'Scheduled runtime/history belongs to the task-bound job definition', owner)
  }
  const sourceRoots = options.sourceRoots ?? [join(store.profileHome, 'workflow-agent-bindings'), join(store.profileHome, 'workflow-admissions'), join(store.profileHome, 'platform', 'workflows'), join(store.profileHome, 'workflow-runs'), join(store.profileHome, 'agent-runs'), join(store.profileHome, 'scheduled'), join(store.profileHome, 'browser', 'artifact-index')]
  const requestOwners = new Map<string, string>()
  const walkSources = (root: string, path: string, depth = 0): void => {
    if (!existsSync(path)) return
    try {
      assertLifecyclePath(root, path)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error('Source container is a link')
      if (stat.isDirectory()) {
        if (depth > 8) throw new Error('Source container exceeds supported nesting')
        for (const name of readdirSync(path).sort()) if (!['snapshots', 'staging', 'scripts', 'results', 'bundle', 'workspace', 'artifacts', 'cache'].includes(name)) walkSources(root, join(path, name), depth + 1)
        return
      }
      if (!path.endsWith('.json') || stat.size > 32 * 1024 * 1024) return
      // Ownership must be explicit in known record fields, never inferred from directory names.
      const data = object(JSON.parse(readFileSync(path, 'utf8')))
      if (!data) return
      const context = object(data.context) ?? object(data.manifest) ?? object(data.request) ?? object(data.scope)
      const owner = text(data.parentThreadId) ?? text(data.threadId) ?? text(context?.threadId) ?? requestOwners.get(String(data.requestId ?? ''))
      if (!owner || !owned.has(owner)) return
      const requestId = text(data.requestId) ?? text(context?.requestId)
      if (requestId) requestOwners.set(requestId, owner)
      const found = source(path)
      if (!found) return
      if (data.profileId !== undefined && data.profileId !== store.profileId) { result.blockers.push(`Cross-profile source: ${path}`); return }
      if ((data.version !== undefined && data.version !== 1) || (data.schemaVersion !== undefined && data.schemaVersion !== 1)) { result.blockers.push(`Unknown source schema: ${path}`); return }
      resource('workflow-record', path, found.source.id, 'recall', 'Durable workflow invocation/run association remains retained', owner)
      resource('worktree', text(data.worktreePath), found.source.id, 'pending-integration', 'Workflow workspace registration retains its result', owner, text(data.repositoryId))
      resource('git-ref', text(data.retainedRef), found.source.id, 'pending-integration', 'Workflow result ref remains owned', owner, text(data.repositoryId))
      if (text(data.branch)) resource('git-ref', `refs/heads/${data.branch}`, found.source.id, 'pending-integration', 'Workflow source owns its result branch', owner, text(data.repositoryId))
      verifyWorktree(text(data.worktreePath), text(data.branch), text(data.repositoryId))
      if (text(data.worktreePath)) resource('workflow-record', `${path}.changes`, found.source.id, 'recovery', 'Workflow workspace source owns its checkpoint/integration journal container', owner)
      if (object(data.scope) && object(data.ref)) {
        const scope = object(data.scope)!, ref = object(data.ref)!
        if (scope.profileId !== store.profileId || ref.profileId !== store.profileId || data.integrity !== sha256Hex(canonicalJson({ version: data.version, scope: data.scope, ref: data.ref }))) { result.blockers.push(`Invalid browser artifact ownership/integrity: ${path}`); return }
        const artifactId = text(ref.id), sessionId = text(scope.sessionId)
        if (!artifactId || !/^[a-f0-9-]{36}$/i.test(artifactId) || !sessionId || !/^[a-zA-Z0-9:_-]{1,160}$/.test(sessionId)) { result.blockers.push(`Invalid browser artifact identity: ${path}`); return }
        resource('artifact', artifactId, found.source.id, 'conversation-attachment', 'Browser artifact index explicitly owns this reference', owner)
        resource('runtime', join(store.profileHome, 'artifacts', artifactId), found.source.id, 'conversation-attachment', 'Artifact metadata and blob container are retained by the browser index', owner)
        const metadata = source(join(store.profileHome, 'artifacts', artifactId, 'meta.json'), true)
        if (metadata && canonicalJson(metadata.data) !== canonicalJson(ref)) result.blockers.push(`Artifact metadata differs from its ownership index: ${artifactId}`)
        resource('runtime', join(store.profileHome, 'browser', 'worker-artifacts', store.profileId, sessionId), found.source.id, 'conversation-attachment', 'Browser session artifact container retained; individual unindexed files are not disposal-authorized', owner)
      }
      if (basename(path) === 'manifest.json' && text(data.runId)) {
        const runRoot = dirname(path)
        resource('workflow-record', runRoot, found.source.id, 'recall', 'Run manifest owns its checkpoint, results, scripts, staging and journal', owner)
        for (const name of ['checkpoint.json', 'input.json', 'policy.json', 'bundle', 'journal.ndjson', 'results', 'scripts', 'staging']) resource('workflow-record', join(runRoot, name), found.source.id, 'recall', 'Run-scoped durable execution material remains retained', owner)
        const checkpoint = source(join(runRoot, 'checkpoint.json'), true)
        if (checkpoint) for (const artifact of recordRows(object(checkpoint.data)?.artifacts ?? [], 'workflow checkpoint artifacts')) {
          const artifactId = text(artifact.id)
          resource('artifact', artifactId, checkpoint.source.id, 'conversation-attachment', 'Workflow checkpoint references this result artifact', owner)
          if (artifactId && /^[a-f0-9-]{36}$/i.test(artifactId)) resource('runtime', join(store.profileHome, 'artifacts', artifactId), checkpoint.source.id, 'conversation-attachment', 'Workflow result artifact metadata/blob container', owner)
        }
      }
      if (basename(path) === 'run.json' && text(data.runId)) resource('workflow-record', dirname(path), found.source.id, 'recall', 'Agent execution record owns its immutable snapshot, approvals and scratch workspace', owner)
      for (const pin of recordRows(data.pins ?? [], 'workflow agent pins')) {
        const snapshotHash = text(pin.snapshotHash)
        if (!snapshotHash || !/^[a-f0-9]{64}$/i.test(snapshotHash)) { result.blockers.push(`Invalid workflow snapshot pin: ${path}`); continue }
        const snapshotPath = join(store.profileHome, 'workflow-agent-bindings', 'snapshots', `${snapshotHash}.json`)
        const snapshot = source(snapshotPath, true)
        resource('workflow-record', snapshotPath, found.source.id, 'recall', 'Owned agent admission pins this immutable definition/context snapshot', owner)
        if (snapshot && (object(snapshot.data)?.profileId !== store.profileId || object(snapshot.data)?.snapshotHash !== snapshotHash)) result.blockers.push(`Workflow snapshot owner mismatch: ${snapshotPath}`)
      }
      const executionId = text(data.executionThreadId)
      if (executionId && !owned.has(executionId)) result.blockers.push(`Workflow execution thread lacks durable ownership edge: ${executionId}`)
      if (path.includes(`${join('workflow-agent-bindings', 'invocations')}`) && !executionId) result.blockers.push(`Legacy workflow invocation lacks execution ownership: ${path}`)
    } catch (error) { result.blockers.push(`Cannot verify source container ${relative(store.profileHome, path)}: ${(error as Error).message}`) }
  }
  for (const root of sourceRoots) walkSources(root, root)
  for (const artifact of [...resources.values()].filter((item) => item.kind === 'artifact' && /^[a-f0-9-]{36}$/i.test(item.identity))) {
    for (const claim of artifact.claims) resource('runtime', join(store.profileHome, 'artifacts', artifact.identity), claim.sourceId, claim.kind, 'Artifact association owns its metadata/blob container', claim.ownerTaskId)
  }
  for (const task of owned.values()) {
    const manifestRoot = join(store.root, 'workspaces', task.taskId)
    if (!existsSync(manifestRoot)) continue
    assertLifecyclePath(store.root, manifestRoot)
    for (const name of readdirSync(manifestRoot).filter((name) => name.endsWith('.json'))) {
      const found = source(join(manifestRoot, name), true)
      if (!found) continue
      const value = object(found.data)
      if (value?.schemaVersion !== 1 || value.profileId !== store.profileId || value.taskId !== task.taskId) { result.blockers.push('Unknown workspace reconstruction manifest'); continue }
      const ownerClaims = [...resources.values()].find((entry) => entry.kind === 'worktree' && entry.identity === value.worktreePath)?.claims ?? []
      const claims = ownerClaims.length ? ownerClaims.map((entry) => entry.kind) : [undefined]
      for (const claim of claims) {
        resource('git-ref', text(value.baseRef), found.source.id, claim, 'Workspace owner retains its reconstruction base', task.taskId, text(value.repositoryId))
        resource('git-ref', text(value.resultRef), found.source.id, claim, 'Workspace owner retains its reconstruction result', task.taskId, text(value.repositoryId))
        resource('runtime', found.source.path, found.source.id, claim, 'Workspace reconstruction metadata follows its owner claims', task.taskId)
      }
    }
  }
  result.resources = [...resources.values()]
  result.blockers = [...new Set(result.blockers)]
  validateResourceInventory(result)
  return result
}
