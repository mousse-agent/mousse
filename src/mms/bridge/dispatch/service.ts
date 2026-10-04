import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import {
  NetError,
  isNetErrorCode,
  isId,
  newId,
  type NodeDelegation,
  type Roster,
  type Signed
} from '../../../shared/net'
import type { RpcContext } from '../../net/contracts'
import type { NetDatabase } from '../../net/store/database'
import { json } from '../../net/store/database'
import type { NetIdentityService } from '../../net/identity/NetIdentityService'
import type { ThreadDataStore } from '../../data/ThreadDataStore'
import { WorktreeManager } from '../../worktree/WorktreeManager'
import { canonicalJson } from '../../net/sync/codec'
import {
  createResultBundle,
  privateDirectory,
  removeQuarantine,
  resultRef,
  verifyAndImportBundle,
  writeArtifact
} from './bundle'
import { canonicalRepository, portableRepository, REPO_ID } from './repository'
import { dispatchRequest } from './validate'
import { git, remoteGit } from './git'
import type {
  DispatchArtifacts,
  DispatchRecord,
  DispatchResultBody,
  DispatchRuntime,
  RepositoryBindingOptions
} from './types'

export interface DispatchServiceOptions {
  db: NetDatabase
  identity: NetIdentityService
  installationHome: string
  profileId: string
  threads: Pick<ThreadDataStore, 'ensureExecutionThread'>
  runtime: DispatchRuntime
  artifacts: DispatchArtifacts
}

/** Domain journal shares the root RPC ledger transaction; provider effects never replay. */
export class DispatchService {
  private readonly active = new Map<string, AbortController>()
  private readonly cleanups = new Set<Promise<void>>()
  private quarantine?: string
  constructor(private readonly options: DispatchServiceOptions) {
    options.db.database
      .exec(`CREATE TABLE IF NOT EXISTS net_dispatch_bindings(repo TEXT PRIMARY KEY,path TEXT NOT NULL,options TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS net_dispatches(execution TEXT PRIMARY KEY,id TEXT NOT NULL UNIQUE,caller TEXT NOT NULL,user TEXT NOT NULL,state TEXT NOT NULL,phase TEXT NOT NULL,record TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS net_dispatch_recovery ON net_dispatches(state,phase);`)
  }

  async bindRepository(
    repoId: string,
    path: string,
    options: RepositoryBindingOptions = {}
  ): Promise<void> {
    if (
      !REPO_ID.test(repoId) ||
      Object.keys(options).some(
        (key) => !['allowFetch', 'allowPush', 'remote', 'projectId'].includes(key)
      )
    )
      throw new NetError('bad_request')
    for (const value of [options.allowFetch, options.allowPush])
      if (value !== undefined && typeof value !== 'boolean') throw new NetError('bad_request')
    if (
      options.projectId !== undefined &&
      (typeof options.projectId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(options.projectId))
    )
      throw new NetError('bad_request')
    const root = await canonicalRepository(path),
      identity = await portableRepository(root)
    if (identity.repoId !== repoId) throw new NetError('conflict')
    if (
      options.remote !== undefined &&
      (typeof options.remote !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(options.remote) ||
        !(await git(root, ['remote'])).split('\n').includes(options.remote))
    )
      throw new NetError('bad_request')
    if ((options.allowFetch || options.allowPush) && !options.remote)
      throw new NetError('bad_request')
    const encoded = json(options)
    this.options.db.transaction(() => {
      this.options.db.charge(1, Buffer.byteLength(encoded) + Buffer.byteLength(root))
      this.options.db.database
        .prepare(
          'INSERT INTO net_dispatch_bindings VALUES(?,?,?) ON CONFLICT(repo) DO UPDATE SET path=excluded.path,options=excluded.options'
        )
        .run(repoId, root, encoded)
    })
  }

  query(execution: string, context: RpcContext): DispatchRecord | undefined {
    const record = this.load(execution)
    if (record && (record.caller !== context.caller.node || record.user !== context.caller.user))
      throw new NetError('forbidden')
    return record
  }
  cancel(execution: string, context: RpcContext): DispatchRecord | undefined {
    const record = this.query(execution, context)
    this.active.get(execution)?.abort(new NetError('cancelled'))
    return record
  }

  async run(value: unknown, context: RpcContext, execution: string): Promise<Signed> {
    const request = dispatchRequest(value),
      requestHash = createHash('sha256').update(canonicalJson(request)).digest('hex')
    if (!isId('execution', execution) || !context.onTerminalCommit)
      throw new NetError('bad_request')
    const held = this.query(execution, context)
    if (held) {
      if (held.requestHash !== requestHash) throw new NetError('conflict')
      if (held.state === 'completed' && held.result) return held.result
      if (held.state === 'failed')
        throw new NetError(isNetErrorCode(held.error) ? held.error : 'internal')
      throw new NetError('outcome_uncertain')
    }
    if (this.active.size >= 8) throw new NetError('quota_exceeded')
    const binding = this.options.db.database
      .prepare('SELECT path,options FROM net_dispatch_bindings WHERE repo=?')
      .get(request.repoId)
    if (!binding) throw new NetError('repo_not_bound')
    const record: DispatchRecord = {
      id: newId('dispatch'),
      execution,
      caller: context.caller.node,
      user: context.caller.user,
      rpc: context.id,
      requestHash,
      request,
      binding: { path: String(binding.path), options: JSON.parse(String(binding.options)) },
      phase: 'preparing',
      state: 'accepted',
      createdAt: this.options.db.clock.now(),
      updatedAt: this.options.db.clock.now()
    }
    this.save(record, true)
    const controller = new AbortController(),
      abort = () => controller.abort(new NetError('cancelled'))
    this.active.set(execution, controller)
    context.signal.addEventListener('abort', abort, { once: true })
    if (context.signal.aborted) abort()
    const remaining = Math.min(
      request.limits.maxElapsedMs,
      context.deadlineAt - this.options.db.clock.now()
    )
    const expiresAt = this.options.db.clock.now() + remaining
    const timer = this.options.db.clock.setTimeout(
      () => controller.abort(new NetError('deadline_exceeded')),
      Math.max(0, remaining)
    )
    let effects = false
    try {
      this.check(controller.signal)
      if (remaining <= 0) throw new NetError('deadline_exceeded')
      if ((await realpath(this.options.installationHome)) !== this.options.installationHome)
        throw new NetError('forbidden')
      const root = await canonicalRepository(record.binding.path),
        identity = await portableRepository(root)
      if (identity.repoId !== request.repoId) throw new NetError('conflict')
      if (request.push && !record.binding.options.allowPush) throw new NetError('forbidden')
      const definition = await this.options.runtime.resolveAgent(request.agent)
      if (definition.profileId !== this.options.profileId || definition.runtimeKind !== 'mousse')
        throw new NetError('profile_unsupported')
      record.definition = {
        definitionId: definition.definitionId,
        revision: definition.revision,
        profileId: definition.profileId
      }
      this.save(record)
      const quarantine = await privateDirectory(await this.quarantineRoot(), record.id)
      let baseAvailable = false
      try {
        baseAvailable =
          (await git(
            root,
            ['rev-parse', '--verify', `${request.baseCommit}^{commit}`],
            controller.signal
          )) === request.baseCommit
      } catch {
        this.check(controller.signal)
      }
      if (request.inputBundle) {
        this.phase(record, 'transferring')
        const bytes = await this.options.artifacts.readInput(request.inputBundle, context),
          bundle = `${quarantine}/input.bundle`
        await writeArtifact(bundle, bytes, request.inputBundle, controller.signal)
        this.phase(record, 'verifying')
        await verifyAndImportBundle(
          root,
          quarantine,
          bundle,
          request.baseCommit,
          identity,
          controller.signal
        )
        baseAvailable = true
      } else if (
        !baseAvailable &&
        request.fetch &&
        record.binding.options.allowFetch &&
        record.binding.options.remote
      ) {
        this.phase(record, 'transferring')
        await remoteGit(
          root,
          [
            '-c',
            'fetch.fsckObjects=true',
            'fetch',
            '--no-tags',
            '--no-write-fetch-head',
            record.binding.options.remote,
            request.baseCommit
          ],
          controller.signal
        )
        baseAvailable =
          (await git(
            root,
            ['rev-parse', '--verify', `${request.baseCommit}^{commit}`],
            controller.signal
          )) === request.baseCommit
      }
      this.phase(record, 'verifying')
      if (!baseAvailable) throw new NetError('bad_request')
      const roots = (
        await git(root, ['rev-list', '--max-parents=0', request.baseCommit], controller.signal)
      ).split('\n')
      if (roots.some((commit) => !identity.roots.includes(commit))) throw new NetError('conflict')
      const configuration = await git(root, ['config', '--null', '--list'], controller.signal)
      if (
        configuration
          .split('\0')
          .some((entry) => /^filter\..*\.(clean|smudge|process)\n/i.test(entry))
      )
        throw new NetError('profile_unsupported')
      this.check(controller.signal)
      const manager = new WorktreeManager(root, this.options.installationHome)
      record.worktree = await manager.createWorktree(
        record.id,
        root,
        request.baseCommit,
        (info) => {
          record.worktree = info
          this.save(record)
        },
        { safeCheckout: true }
      )
      const thread = this.options.threads.ensureExecutionThread(
        `bridge.dispatch:${execution}`,
        `Dispatch ${record.id}`,
        record.binding.options.projectId
      )
      record.threadId = thread.id
      this.check(controller.signal)
      record.state = 'running'
      this.phase(record, 'running')
      effects = true
      const outcome = await this.withAbort(
        this.options.runtime.run({
          definition,
          threadId: thread.id,
          worktreePath: record.worktree.path,
          prompt: request.prompt,
          executionId: execution,
          limits: {
            ...request.limits,
            maxElapsedMs: Math.max(
              1,
              Math.min(request.limits.maxElapsedMs, expiresAt - this.options.db.clock.now())
            )
          },
          signal: controller.signal
        }),
        controller.signal
      )
      this.check(controller.signal)
      if (outcome.status !== 'completed')
        throw new NetError(outcome.status === 'cancelled' ? 'cancelled' : 'outcome_uncertain')
      if (
        outcome.profileId !== definition.profileId ||
        outcome.definitionId !== definition.definitionId ||
        outcome.definitionRevision !== definition.revision ||
        outcome.threadId !== thread.id ||
        outcome.runId !== execution
      )
        throw new NetError('conflict')
      this.phase(record, 'publishing')
      await git(record.worktree.path, ['add', '--all'], controller.signal)
      if (await git(record.worktree.path, ['diff', '--cached', '--name-only'], controller.signal))
        await git(
          record.worktree.path,
          [
            '-c',
            'user.name=Mousse Dispatch',
            '-c',
            'user.email=dispatch@localhost',
            '-c',
            'commit.gpgsign=false',
            'commit',
            '-m',
            `Dispatch ${record.id}`
          ],
          controller.signal
        )
      const head = await git(record.worktree.path, ['rev-parse', 'HEAD'], controller.signal)
      await git(root, ['merge-base', '--is-ancestor', request.baseCommit, head], controller.signal)
      await git(
        root,
        ['update-ref', resultRef(record.id), head, '0'.repeat(head.length)],
        controller.signal
      )
      if (request.push) {
        await remoteGit(
          root,
          [
            'push',
            '--no-verify',
            record.binding.options.remote!,
            `${resultRef(record.id)}:refs/heads/mousse/dispatch/${record.id}`
          ],
          controller.signal
        )
      }
      const bytes = await createResultBundle(root, quarantine, record.id, controller.signal),
        bundleHash = createHash('sha256').update(bytes).digest('hex')
      const publication = await this.options.artifacts.prepareResult(bytes, context)
      if (publication.ref.blob !== `blb_${bundleHash}`) throw new NetError('conflict')
      const self = this.options.identity.self(),
        rootKey = self && this.options.identity.pinnedRootKey(self.user),
        signedRoster = this.options.identity.roster()
      if (!self || !rootKey || !signedRoster) throw new NetError('not_enrolled')
      const roster = this.options.identity.verifySigned<Roster>(signedRoster, rootKey)
      const delegation = roster.nodes
        .map((row) => this.options.identity.verifySigned<NodeDelegation>(row, rootKey))
        .filter((row) => row.subject === self.node)
        .sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0]
      if (!delegation) throw new NetError('bad_delegation')
      const body: DispatchResultBody = {
        v: 1,
        kind: 'bridge.dispatch.result.v1',
        dispatch: record.id,
        execution,
        rpc: context.id,
        requestHash,
        author: { user: self.user, node: self.node, keyEpoch: delegation.keyEpoch },
        issuedAt: this.options.db.clock.now(),
        repoId: request.repoId,
        baseCommit: request.baseCommit,
        headCommit: head,
        branch: record.worktree.branch,
        ref: resultRef(record.id),
        bundleHash,
        artifact: publication.ref,
        agent: record.definition,
        threadId: thread.id,
        errors: []
      }
      const signed = this.options.identity.signAsNode(body)
      this.options.identity.verifyAuthor(
        body.author,
        canonicalJson(body),
        Buffer.from(signed.sig, 'base64url'),
        body.issuedAt,
        'newWork'
      )
      record.result = signed
      this.save(record)
      this.check(controller.signal)
      context.onTerminalCommit(() => {
        if (!this.options.db.inTransaction) throw new NetError('internal')
        publication.commit()
        record.state = 'completed'
        record.phase = 'cleanup'
        this.save(record)
        this.options.db.afterCommit(() => this.enqueueCleanup(record))
      })
      return signed
    } catch (error) {
      record.state = effects ? 'uncertain' : 'failed'
      record.error = error instanceof NetError ? error.code : 'internal'
      this.save(record)
      if (!effects) await this.cleanup(record)
      throw effects
        ? new NetError('outcome_uncertain', undefined, { cause: error })
        : error instanceof NetError
          ? error
          : new NetError('internal', undefined, { cause: error })
    } finally {
      timer.cancel()
      context.signal.removeEventListener('abort', abort)
      this.active.delete(execution)
    }
  }

  /** Startup reconciliation never invokes the model or republishes a result. */
  async recover(): Promise<void> {
    const rows = this.options.db.database
      .prepare("SELECT record FROM net_dispatches WHERE phase!='complete' ORDER BY id LIMIT 100")
      .all()
    for (const row of rows) {
      const record = JSON.parse(String(row.record)) as DispatchRecord
      if (this.active.has(record.execution)) continue
      if (record.state === 'accepted') {
        record.state = 'failed'
        record.error = 'cancelled'
        this.save(record)
        await this.cleanup(record)
      } else if (record.state === 'running') {
        record.state = 'uncertain'
        record.error = 'outcome_uncertain'
        this.save(record)
      } else if (record.state === 'completed' || record.state === 'failed')
        await this.cleanup(record)
    }
  }
  async drainCleanup(): Promise<void> {
    await Promise.all([...this.cleanups])
  }
  private enqueueCleanup(record: DispatchRecord): void {
    const pending = this.cleanup(record).catch(() => undefined)
    this.cleanups.add(pending)
    void pending.finally(() => this.cleanups.delete(pending))
  }
  private async cleanup(record: DispatchRecord): Promise<void> {
    // Uncertain model effects stay available for owner inspection; automatic cleanup is unsafe.
    if (record.state === 'uncertain' || record.state === 'running') return
    record.phase = 'cleanup'
    delete record.cleanupError
    this.save(record)
    if (record.worktree) {
      const cleanup = await new WorktreeManager(
        record.binding.path,
        this.options.installationHome
      ).cleanupValidatedAgentWorktree(record.worktree, { safeCheckout: true })
      if (!cleanup.success) record.cleanupError = 'worktree_cleanup_failed'
    }
    try {
      await removeQuarantine(await this.quarantineRoot(), record.id)
    } catch {
      record.cleanupError ??= 'quarantine_cleanup_failed'
    }
    if (!record.cleanupError) record.phase = 'complete'
    this.save(record)
  }
  private async quarantineRoot(): Promise<string> {
    return (this.quarantine ??= await privateDirectory(this.options.db.directory, 'dispatch'))
  }
  private check(signal: AbortSignal): void {
    if (signal.aborted)
      throw signal.reason instanceof NetError ? signal.reason : new NetError('cancelled')
  }
  private withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () =>
        reject(signal.reason instanceof NetError ? signal.reason : new NetError('cancelled'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }
  private phase(record: DispatchRecord, phase: DispatchRecord['phase']): void {
    record.phase = phase
    this.save(record)
  }
  private load(execution: string): DispatchRecord | undefined {
    const row = this.options.db.database
      .prepare('SELECT record FROM net_dispatches WHERE execution=?')
      .get(execution)
    return row ? JSON.parse(String(row.record)) : undefined
  }
  private save(record: DispatchRecord, insert = false): void {
    record.updatedAt = this.options.db.clock.now()
    const encoded = json(record)
    this.options.db.transaction(() => {
      this.options.db.charge(1, Buffer.byteLength(encoded))
      if (insert)
        this.options.db.database
          .prepare('INSERT INTO net_dispatches VALUES(?,?,?,?,?,?,?)')
          .run(
            record.execution,
            record.id,
            record.caller,
            record.user,
            record.state,
            record.phase,
            encoded
          )
      else
        this.options.db.database
          .prepare('UPDATE net_dispatches SET state=?,phase=?,record=? WHERE execution=?')
          .run(record.state, record.phase, encoded, record.execution)
    })
  }
}
