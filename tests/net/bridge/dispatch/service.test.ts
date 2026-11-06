import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { devNull, tmpdir } from 'node:os'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { newId, NetError, type RpcArtifactRef } from '../../../../src/shared/net'
import type { ResolvedAgentDefinition } from '../../../../src/shared/agents/types'
import { NetDatabase } from '../../../../src/mms/net/store/database'
import { FileKeyStore } from '../../../../src/mms/net/identity/FileKeyStore'
import { NetIdentityService } from '../../../../src/mms/net/identity/NetIdentityService'
import { ProjectManager } from '../../../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../../../src/mms/data/ThreadDataStore'
import type { RpcContext } from '../../../../src/mms/net/contracts'
import {
  DispatchService,
  portableRepository,
  normalizeRemote,
  verifyDispatchResult,
  type DispatchRequest,
  type DispatchRuntime
} from '../../../../src/mms/bridge/dispatch'
import { fixtureGitAsync as git, ownedHome } from '../../../support/fixtureGit'
import { inputRef, resultRef } from '../../../../src/mms/bridge/dispatch/bundle'
import { authenticatedRemote } from './http-fixture'
import { FakeClock } from '../../harness/FakeClock'
import type { Clock } from '../../../../src/mms/net/contracts'
import { sharedBuild } from '../../../support/build'
import { dispatchKeptFilesOwner, KEEP_COPY_LIMITS, keptCopyRestoreCommand } from '../../../../src/mms/actions/keptCopies'
import { threadPreservedIndex } from '../../../../src/mms/actions/preservedFiles'
import { UndoRetentionSweeper } from '../../../../src/mms/actions/UndoRetentionSweeper'
import { listKeptWorktrees } from '../../../../src/mms/lifecycle/keptWorktrees'
import { isCleanupAdminCapture } from '../../../../src/mms/lifecycle/worktreeAdminData'
import { ResourceLifecycleCoordinator } from '../../../../src/mms/lifecycle/ResourceLifecycleCoordinator'
import type { ResourceLifecycleStore } from '../../../../src/mms/lifecycle/ResourceLifecycleStore'
import { StorageCleanupService } from '../../../../src/mms/lifecycle/StorageCleanupService'
import { StoragePolicyStore } from '../../../../src/mms/lifecycle/StoragePolicyStore'
import { StorageSweepClock } from '../../../../src/mms/lifecycle/sweepClock'
import { STORAGE_POLICY_DEFAULTS } from '../../../../src/shared/storage'
import type { DispatchRecord } from '../../../../src/mms/bridge/dispatch/types'
import { WorktreeManager } from '../../../../src/mms/worktree/WorktreeManager'
import { installGitRemoveGuard } from '../../../fixtures/gitRemoveGuard'

const roots: string[] = [],
  databases: NetDatabase[] = [],
  owned: Array<() => void> = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const undo of owned.splice(0)) undo()
  for (const db of databases.splice(0)) db.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const definition = {
  definitionId: 'agent_dispatch',
  profileId: 'test',
  revision: 'revision-1',
  runtimeKind: 'mousse'
} as ResolvedAgentDefinition
async function repository(path: string) {
  await mkdir(path, { recursive: true })
  await git(path, ['init', '--template='])
  await writeFile(join(path, 'base.txt'), 'base\n')
  await git(path, ['add', '.'])
  await git(path, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@localhost',
    'commit',
    '-m',
    'base'
  ])
  await git(path, ['remote', 'add', 'origin', 'https://EXAMPLE.com/team/repository.git'])
  return git(path, ['rev-parse', 'HEAD'])
}
async function fixture(runtimeOverride?: DispatchRuntime['run'], clock?: Clock) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mousse-dispatch-')))
  roots.push(root)
  const repo = join(root, 'repo'),
    profile = join(root, 'profile'),
    home = join(root, 'home')
  await mkdir(profile)
  await mkdir(home)
  // The profile and installation homes are Mousse's, as the real ones under the Mousse home are.
  owned.push(ownedHome(profile), ownedHome(home))
  const base = await repository(repo),
    identityRepo = await portableRepository(repo)
  const db = new NetDatabase({ profileDir: profile, clock })
  databases.push(db)
  const keys = new FileKeyStore(profile),
    identity = new NetIdentityService({
      database: db.database,
      keys,
      clock: db.clock,
      coordinator: db
    })
  await identity.bootstrapAuthority('Fixture')
  const projects = new ProjectManager(profile),
    threads = new ThreadDataStore(projects, profile, {
      profileId: 'test',
      allowLegacyProjectData: false
    })
  projects.setThreadStore(threads)
  let effects = 0,
    preparedBytes = Buffer.alloc(0),
    source = Buffer.alloc(0)
  db.database.exec(
    'CREATE TABLE dispatch_test_publication(blob TEXT PRIMARY KEY); CREATE TABLE dispatch_test_terminal(execution TEXT PRIMARY KEY);'
  )
  const runtime: DispatchRuntime = {
    resolveAgent: async () => structuredClone(definition),
    run: async (request) => {
      effects++
      if (runtimeOverride) return runtimeOverride(request)
      expect(await git(request.worktreePath, ['rev-parse', 'HEAD'])).toBe(base)
      await writeFile(join(request.worktreePath, 'result.txt'), 'verified model fixture\n')
      return {
        runId: request.executionId,
        profileId: 'test',
        threadId: request.threadId,
        definitionId: definition.definitionId,
        definitionRevision: definition.revision,
        runtimeKind: 'mousse',
        status: 'completed',
        text: 'done',
        history: [],
        usage: { elapsedMs: 1 }
      }
    }
  }
  const service = new DispatchService({
    db,
    identity,
    installationHome: home,
    profileHome: profile,
    profileId: 'test',
    threads,
    runtime,
    artifacts: {
      readInput: async () => source,
      prepareResult: async (bytes) => {
        preparedBytes = Buffer.from(bytes)
        const ref: RpcArtifactRef = {
          stream: newId('stream'),
          event: newId('event'),
          blob: `blb_${hash(bytes)}`
        }
        return {
          ref,
          commit: () => {
            db.charge(1)
            db.database.prepare('INSERT INTO dispatch_test_publication VALUES(?)').run(ref.blob)
          }
        }
      }
    }
  })
  const roster = identity.verifySigned<import('../../../../src/shared/net').Roster>(
    identity.roster()!,
    keys.rootKey()!
  )
  const delegation = identity.verifySigned<import('../../../../src/shared/net').NodeDelegation>(
    roster.nodes[0],
    keys.rootKey()!
  )
  const self = identity.self()!,
    callbacks: Array<() => void> = [],
    controller = new AbortController()
  const context: RpcContext = {
    id: newId('rpc'),
    caller: { ...self, delegation },
    signal: controller.signal,
    deadlineAt: db.clock.now() + 30_000,
    progress: () => undefined,
    onTerminalCommit: (work) => callbacks.push(work)
  }
  const request: DispatchRequest = {
    repoId: identityRepo.repoId,
    baseCommit: base,
    agent: 'agent_dispatch',
    prompt: 'Write result.txt',
    limits: { maxTurns: 2, maxToolCalls: 3, maxElapsedMs: 20_000 }
  }
  const execution = newId('execution')
  return {
    root,
    repo,
    profile,
    home,
    db,
    keys,
    identity,
    threads,
    service,
    request,
    execution,
    context,
    controller,
    effects: () => effects,
    callbacks,
    bytes: () => preparedBytes,
    source: (bytes: Buffer) => {
      source = bytes
    },
    commit: () =>
      db.transaction(() => {
        callbacks.forEach((work) => work())
        db.database.prepare('INSERT INTO dispatch_test_terminal VALUES(?)').run(execution)
      })
  }
}

it('derives the same portable identity for clones and normalized transport/user differences', async () => {
  const f = await fixture(),
    clone = join(f.root, 'clone')
  await git(f.root, ['clone', '--no-hardlinks', f.repo, clone])
  await git(clone, ['remote', 'set-url', 'origin', 'git@example.com:team/repository.git'])
  expect((await portableRepository(clone)).repoId).toBe(f.request.repoId)
  expect(normalizeRemote('ssh://git@EXAMPLE.com:22/team/repository.git')).toBe(
    'example.com/team/repository'
  )
  expect(() => normalizeRemote('https://example.com/team/repo.git?token=secret')).toThrow()
  await writeFile(join(clone, 'dirty.txt'), 'caller dirty')
  expect((await portableRepository(clone)).repoId).toBe(f.request.repoId)
})

it('keeps its identity with Mousse-owned root commits under refs/mousse, and dispatch still runs', async () => {
  const f = await fixture()
  // Mousse keeps Git's data of a removed worktree as a commit that is often a root commit, under refs/mousse/. 300 of
  // them pass the 256-root limit; none may change the identity.
  const stream = Array.from({ length: 300 }, (_, index) =>
    `commit refs/mousse/preserved/root-${index}\ncommitter Mousse <mousse@localhost> ${index} +0000\ndata ${String(index).length}\n${index}\n`).join('')
  execFileSync('git', ['fast-import', '--quiet'], { cwd: f.repo, input: stream })
  expect((await git(f.repo, ['rev-list', '--max-parents=0', '--all'])).split('\n')).toHaveLength(301)
  expect((await portableRepository(f.repo)).repoId).toBe(f.request.repoId)
  await f.service.bindRepository(f.request.repoId, f.repo)
  await f.service.run(f.request, f.context, f.execution)
  const record = f.service.query(f.execution, f.context)!
  f.commit()
  await f.service.drainCleanup()
  expect(f.service.query(f.execution, f.context)).toMatchObject({ state: 'completed', phase: 'complete' })
  await expect(stat(record.worktree!.path)).rejects.toMatchObject({ code: 'ENOENT' })
  // The cleanup kept Git's data of the dispatch's worktree as a copy the dispatch owns; the identity is still the same.
  const owner = dispatchKeptFilesOwner(f.profile, record.id)
  const kept = (await git(f.repo, ['for-each-ref', '--format=%(refname)', 'refs/mousse/preserved/'])).split('\n').filter((ref) => threadPreservedIndex(owner).owns(ref))
  expect(kept).toHaveLength(1)
  expect(await git(f.repo, ['cat-file', '-t', `${kept[0]}:HEAD`])).toBe('blob')
  expect((await portableRepository(f.repo)).repoId).toBe(f.request.repoId)
})

it('requires explicit binding and exact profile before worktree/model effects', async () => {
  const f = await fixture()
  await expect(f.service.run(f.request, f.context, f.execution)).rejects.toMatchObject({
    code: 'repo_not_bound'
  })
  expect(f.effects()).toBe(0)
  await expect(f.service.bindRepository(`repo_${'a'.repeat(64)}`, f.repo)).rejects.toMatchObject({
    code: 'conflict'
  })
  await f.service.bindRepository(f.request.repoId, f.repo)
  await expect(
    f.service.run({ ...f.request, localPath: '/tmp' }, f.context, f.execution)
  ).rejects.toMatchObject({ code: 'bad_request' })
  await expect(
    f.service.run({ ...f.request, push: true }, f.context, f.execution)
  ).rejects.toMatchObject({ code: 'forbidden' })
  expect(f.effects()).toBe(0)
})

it('runs in an actual isolated stable thread/worktree and atomically settles signed Git bundle', async () => {
  const f = await fixture()
  await f.service.bindRepository(f.request.repoId, f.repo)
  await writeFile(join(f.repo, 'caller-only.txt'), 'dirty caller data')
  const signed = await f.service.run(f.request, f.context, f.execution),
    record = f.service.query(f.execution, f.context)!
  expect(record).toMatchObject({ state: 'running', phase: 'publishing' })
  expect(f.effects()).toBe(1)
  expect(f.db.database.prepare('SELECT * FROM dispatch_test_publication').all()).toHaveLength(0)
  const result = verifyDispatchResult(f.identity, signed, {
    node: f.identity.self()!.node,
    user: f.identity.self()!.user,
    rpc: f.context.id,
    execution: f.execution,
    repoId: f.request.repoId,
    baseCommit: f.request.baseCommit,
    requestHash: record.requestHash
  })
  expect(result.bundleHash).toBe(hash(f.bytes()))
  expect(await git(f.repo, ['show', `${result.headCommit}:result.txt`])).toBe(
    'verified model fixture'
  )
  await expect(git(f.repo, ['show', `${result.headCommit}:caller-only.txt`])).rejects.toThrow()
  expect(f.threads.ensureExecutionThread(`bridge.dispatch:${f.execution}`, 'same').id).toBe(
    result.threadId
  )
  const bundle = join(f.root, 'result.bundle')
  await writeFile(bundle, f.bytes())
  expect(await git(f.repo, ['bundle', 'list-heads', bundle])).toBe(
    `${result.headCommit} ${result.ref}`
  )
  f.commit()
  await f.service.drainCleanup()
  expect(f.service.query(f.execution, f.context)).toMatchObject({
    state: 'completed',
    phase: 'complete'
  })
  await expect(stat(record.worktree!.path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.db.database.prepare('SELECT * FROM dispatch_test_publication').all()).toHaveLength(1)
  expect(await f.service.run(f.request, f.context, f.execution)).toEqual(signed)
  expect(f.effects()).toBe(1)
  const altered = structuredClone(signed),
    body = JSON.parse(Buffer.from(altered.payload, 'base64url').toString())
  body.headCommit = 'a'.repeat(40)
  altered.payload = Buffer.from(JSON.stringify(body)).toString('base64url')
  expect(() =>
    verifyDispatchResult(f.identity, altered, {
      node: f.identity.self()!.node,
      user: f.identity.self()!.user,
      rpc: f.context.id,
      execution: f.execution,
      repoId: f.request.repoId,
      baseCommit: f.request.baseCommit,
      requestHash: record.requestHash
    })
  ).toThrow()
})

it('keeps unpublished publishing work uncertain after terminal transaction rollback and never reruns', async () => {
  const f = await fixture()
  await f.service.bindRepository(f.request.repoId, f.repo)
  await f.service.run(f.request, f.context, f.execution)
  expect(() =>
    f.db.transaction(() => {
      f.callbacks.forEach((work) => work())
      throw new Error('terminal failure')
    })
  ).toThrow('terminal failure')
  expect(f.db.database.prepare('SELECT * FROM dispatch_test_publication').all()).toHaveLength(0)
  expect(f.service.query(f.execution, f.context)).toMatchObject({
    state: 'running',
    phase: 'publishing'
  })
  await f.service.recover()
  expect(f.service.query(f.execution, f.context)).toMatchObject({
    state: 'uncertain',
    phase: 'publishing'
  })
  await expect(f.service.run(f.request, f.context, f.execution)).rejects.toMatchObject({
    code: 'outcome_uncertain'
  })
  expect(f.effects()).toBe(1)
})

it('recovers an interrupted dispatch that sorts after more than a page of uncertain ones', async () => {
  const f = await fixture()
  const insert = f.db.database.prepare('INSERT INTO net_dispatches VALUES(?,?,?,?,?,?,?)')
  const row = (id: string, state: DispatchRecord['state'], phase: DispatchRecord['phase']) => {
    const record = {
      id,
      execution: `execution_${id}`,
      caller: f.context.caller.node,
      user: f.context.caller.user,
      rpc: f.context.id,
      requestHash: 'hash',
      request: f.request,
      binding: { path: f.repo, options: {} },
      state,
      phase
    } as unknown as DispatchRecord
    insert.run(record.execution, id, record.caller, record.user, state, phase, JSON.stringify(record))
    return record
  }
  // Uncertain dispatches stay for the owner; they are never completed by a start.
  for (let index = 0; index < 101; index++)
    row(`dispatch_a${String(index).padStart(3, '0')}`, 'uncertain', 'running')
  const interrupted = row('dispatch_z', 'accepted', 'preparing')
  await f.service.recover()
  expect(f.service.query(interrupted.execution, f.context)).toMatchObject({
    state: 'failed',
    error: 'cancelled',
    phase: 'complete'
  })
  expect(f.service.query('execution_dispatch_a000', f.context)).toMatchObject({
    state: 'uncertain',
    phase: 'running'
  })
})

it('imports a missing exact base through verified incremental quarantine without copying dirty files', async () => {
  const f = await fixture(),
    sender = join(f.root, 'sender')
  await git(f.root, ['clone', f.repo, sender])
  await git(sender, ['remote', 'set-url', 'origin', 'git@example.com:team/repository.git'])
  await writeFile(join(sender, 'new.txt'), 'new base\n')
  await git(sender, ['add', '.'])
  await git(sender, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@localhost',
    'commit',
    '-m',
    'new'
  ])
  const base = await git(sender, ['rev-parse', 'HEAD'])
  await git(sender, ['update-ref', inputRef(base), base])
  const bundle = join(f.root, 'input.bundle')
  await git(sender, ['bundle', 'create', bundle, inputRef(base), `^${f.request.baseCommit}`])
  const bytes = await readFile(bundle)
  f.source(bytes)
  f.request.baseCommit = base
  f.request.inputBundle = {
    stream: newId('stream'),
    event: newId('event'),
    blob: `blb_${hash(bytes)}`
  }
  await f.service.bindRepository(f.request.repoId, f.repo)
  // The default fixture requires its original base, so use a fresh service runtime below.
  const f2 = await fixture(async (request) => ({
    runId: request.executionId,
    profileId: 'test',
    threadId: request.threadId,
    definitionId: definition.definitionId,
    definitionRevision: definition.revision,
    runtimeKind: 'mousse',
    status: 'completed',
    text: await git(request.worktreePath, ['show', 'HEAD:new.txt']),
    history: [],
    usage: { elapsedMs: 1 }
  }))
  await f2.service.bindRepository(f.request.repoId, f.repo)
  f2.source(bytes)
  await f2.service.run(f.request, f2.context, f2.execution)
  f2.commit()
  await f2.service.drainCleanup()
  expect(await git(f.repo, ['rev-parse', '--verify', inputRef(base)])).toBe(base)
  expect(f2.effects()).toBe(1)
})

it('rejects artifact hash mismatch and unexpected bundle refs before effects', async () => {
  const f = await fixture()
  await f.service.bindRepository(f.request.repoId, f.repo)
  const bundle = join(f.root, 'unexpected.bundle')
  await git(f.repo, ['bundle', 'create', bundle, 'HEAD'])
  const bytes = await readFile(bundle)
  f.source(bytes)
  const inputBundle: RpcArtifactRef = {
    stream: newId('stream'),
    event: newId('event'),
    blob: `blb_${'0'.repeat(64)}`
  }
  await expect(
    f.service.run({ ...f.request, inputBundle }, f.context, f.execution)
  ).rejects.toMatchObject({ code: 'conflict' })
  inputBundle.blob = `blb_${hash(bytes)}`
  await expect(
    f.service.run(
      { ...f.request, inputBundle },
      { ...f.context, id: newId('rpc') },
      newId('execution')
    )
  ).rejects.toMatchObject({ code: 'bad_request' })
  expect(f.effects()).toBe(0)
})

it('rejects a bundle containing a forbidden .git tree path in quarantine', async () => {
  const f = await fixture(),
    sender = join(f.root, 'malicious-sender')
  await git(f.root, ['clone', f.repo, sender])
  const blob = await git(sender, ['rev-parse', 'HEAD:base.txt']),
    treeFile = join(f.root, 'malformed-tree')
  await writeFile(treeFile, Buffer.concat([Buffer.from('100644 .git\0'), Buffer.from(blob, 'hex')]))
  const tree = await git(sender, ['hash-object', '--literally', '-t', 'tree', '-w', treeFile])
  const commit = await git(sender, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@localhost',
    'commit-tree',
    tree,
    '-p',
    f.request.baseCommit,
    '-m',
    'invalid .git path'
  ])
  await git(sender, ['update-ref', inputRef(commit), commit])
  const bundle = join(f.root, 'malicious.bundle')
  await git(sender, ['bundle', 'create', bundle, inputRef(commit), `^${f.request.baseCommit}`])
  const bytes = await readFile(bundle)
  await f.service.bindRepository(f.request.repoId, f.repo)
  f.source(bytes)
  await expect(
    f.service.run(
      {
        ...f.request,
        baseCommit: commit,
        inputBundle: { stream: newId('stream'), event: newId('event'), blob: `blb_${hash(bytes)}` }
      },
      f.context,
      f.execution
    )
  ).rejects.toMatchObject({ code: 'bad_request' })
  expect(f.effects()).toBe(0)
  await expect(git(f.repo, ['rev-parse', '--verify', `${commit}^{commit}`])).rejects.toThrow()
})

it('fails expired admission without effects and enforces elapsed deadline during a running model', async () => {
  const clock = new FakeClock(Date.now())
  let started!: () => void
  const running = new Promise<void>((resolve) => {
    started = resolve
  })
  const f = await fixture(async (request) => {
    expect(request.limits.maxElapsedMs).toBe(700)
    started()
    return new Promise(() => undefined)
  }, clock)
  await f.service.bindRepository(f.request.repoId, f.repo)
  await expect(
    f.service.run(f.request, { ...f.context, deadlineAt: clock.now() - 1 }, f.execution)
  ).rejects.toMatchObject({ code: 'deadline_exceeded' })
  expect(f.effects()).toBe(0)

  const execution = newId('execution'),
    context = { ...f.context, id: newId('rpc') }
  const pending = f.service.run(
    { ...f.request, limits: { ...f.request.limits, maxElapsedMs: 700 } },
    context,
    execution
  )
  const outcome = pending.catch((error) => error)
  await running
  expect(f.effects()).toBe(1)
  clock.advance(700)
  expect(await outcome).toMatchObject({ code: 'outcome_uncertain' })
  expect(f.service.query(execution, context)).toMatchObject({
    state: 'uncertain',
    error: 'deadline_exceeded'
  })
})

it('fetches a missing base only through an explicitly enabled owner-selected remote', async () => {
  let expected = ''
  const f = await fixture(async (request) => {
      expect(await git(request.worktreePath, ['rev-parse', 'HEAD'])).toBe(expected)
      return {
        runId: request.executionId,
        profileId: 'test',
        threadId: request.threadId,
        definitionId: definition.definitionId,
        definitionRevision: definition.revision,
        runtimeKind: 'mousse',
        status: 'completed',
        text: 'fetched',
        history: [],
        usage: { elapsedMs: 1 }
      }
    }),
    sender = join(f.root, 'fetch-source')
  await git(f.root, ['clone', f.repo, sender])
  await writeFile(join(sender, 'new-base.txt'), 'new')
  await git(sender, ['add', '.'])
  await git(sender, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@localhost',
    'commit',
    '-m',
    'new base'
  ])
  expected = await git(sender, ['rev-parse', 'HEAD'])
  await git(f.repo, ['remote', 'set-url', 'origin', `file://${sender}`])
  f.request.repoId = (await portableRepository(f.repo)).repoId
  f.request.baseCommit = expected
  f.request.fetch = true
  await f.service.bindRepository(f.request.repoId, f.repo)
  await expect(f.service.run(f.request, f.context, f.execution)).rejects.toMatchObject({
    code: 'bad_request'
  })
  expect(f.effects()).toBe(0)
  await f.service.bindRepository(f.request.repoId, f.repo, { allowFetch: true, remote: 'origin' })
  const execution = newId('execution')
  await f.service.run(f.request, f.context, execution)
  f.db.transaction(() => f.callbacks.forEach((work) => work()))
  await f.service.drainCleanup()
  expect(f.service.query(execution, f.context)).toMatchObject({
    state: 'completed',
    phase: 'complete'
  })
  expect(f.effects()).toBe(1)
  expect(
    await git(sender, ['for-each-ref', '--format=%(refname)', 'refs/heads/mousse/dispatch/'])
  ).toBe('')
})

it('fetches the missing base and pushes the result with the bound remote credential helper', async () => {
  let expected = ''
  const f = await fixture(async (request) => {
    expect(await git(request.worktreePath, ['rev-parse', 'HEAD'])).toBe(expected)
    await writeFile(join(request.worktreePath, 'authenticated-result.txt'), 'result\n')
    return {
      runId: request.executionId,
      profileId: 'test',
      threadId: request.threadId,
      definitionId: definition.definitionId,
      definitionRevision: definition.revision,
      runtimeKind: 'mousse',
      status: 'completed',
      text: 'authenticated',
      history: [],
      usage: { elapsedMs: 1 }
    }
  })
  const remote = join(f.root, 'remote.git')
  const sender = join(f.root, 'authenticated-sender')
  await git(f.root, ['clone', '--bare', f.repo, remote])
  await git(f.root, ['clone', remote, sender])
  await writeFile(join(sender, 'new-base.txt'), 'authenticated base\n')
  await git(sender, ['add', '.'])
  await git(sender, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@localhost',
    'commit',
    '-m',
    'new base'
  ])
  expected = await git(sender, ['rev-parse', 'HEAD'])
  await git(sender, ['push', 'origin', 'HEAD'])
  const http = await authenticatedRemote(f.root)
  try {
    await git(f.repo, ['remote', 'set-url', 'origin', http.url])
    f.request.repoId = (await portableRepository(f.repo)).repoId
    f.request.baseCommit = expected
    f.request.fetch = true
    f.request.push = true
    await f.service.bindRepository(f.request.repoId, f.repo, {
      allowFetch: true,
      allowPush: true,
      remote: 'origin'
    })
    vi.stubEnv('HOME', f.root)
    vi.stubEnv('XDG_CONFIG_HOME', f.root)
    vi.stubEnv('GIT_CONFIG_GLOBAL', http.globalConfig)
    vi.stubEnv('GIT_CONFIG_SYSTEM', devNull)
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '0')
    await expect(git(f.repo, ['rev-parse', '--verify', `${expected}^{commit}`])).rejects.toThrow()
    await f.service.run(f.request, f.context, f.execution)
    const record = f.service.query(f.execution, f.context)!
    const head = await git(f.repo, ['rev-parse', resultRef(record.id)])
    expect(await git(remote, ['rev-parse', `refs/heads/mousse/dispatch/${record.id}`])).toBe(head)
    expect(await git(remote, ['show', `${head}:authenticated-result.txt`])).toBe('result')
    expect(
      (await readFile(http.marker, 'utf8')).split('\n').filter((value) => value === 'get')
    ).toHaveLength(2)
    expect(http.counts().fetch).toBeGreaterThan(0)
    expect(http.counts().push).toBeGreaterThan(0)
    expect(http.errors).toEqual([])
    f.commit()
    await f.service.drainCleanup()
    expect(f.service.query(f.execution, f.context)).toMatchObject({
      state: 'completed',
      phase: 'complete'
    })
  } finally {
    await http.close()
  }
})

it('persists cleanup refusal for a dirty owned worktree and retries cleanup without rerunning', async () => {
  const f = await fixture()
  await f.service.bindRepository(f.request.repoId, f.repo)
  await f.service.run(f.request, f.context, f.execution)
  const worktree = f.service.query(f.execution, f.context)!.worktree!
  const extra = join(worktree.path, 'owner-extra.txt')
  await writeFile(extra, 'retain this owner edit')
  f.commit()
  await f.service.drainCleanup()
  expect(f.service.query(f.execution, f.context)).toMatchObject({
    state: 'completed',
    phase: 'cleanup',
    cleanupError: 'worktree_cleanup_failed',
    cleanupReason: 'Kept: it has uncommitted changes (owner-extra.txt). Nothing in it was changed.'
  })
  expect(await readFile(extra, 'utf8')).toBe('retain this owner edit')
  await rm(extra)
  await f.service.recover()
  expect(f.service.query(f.execution, f.context)).toMatchObject({
    state: 'completed',
    phase: 'complete'
  })
  expect(f.effects()).toBe(1)
})

it.each(['normal', 'recovery'])(
  'publishes exact filtered file bytes and completes %s cleanup without executing global required filters',
  async (mode) => {
    const f = await fixture(async (request) => {
      expect(await readFile(join(request.worktreePath, 'asset.bin'), 'utf8')).toBe('stored bytes\n')
      await writeFile(join(request.worktreePath, 'result.bin'), 'exact result bytes\n')
      return {
        runId: request.executionId,
        profileId: 'test',
        threadId: request.threadId,
        definitionId: definition.definitionId,
        definitionRevision: definition.revision,
        runtimeKind: 'mousse',
        status: 'completed',
        text: 'done',
        history: [],
        usage: { elapsedMs: 1 }
      }
    })
    await writeFile(join(f.repo, '.gitattributes'), '*.bin filter=probe\n')
    await writeFile(join(f.repo, 'asset.bin'), 'stored bytes\n')
    await git(f.repo, ['add', '.'])
    await git(f.repo, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@localhost',
      'commit',
      '-m',
      'filter attributes'
    ])
    f.request.baseCommit = await git(f.repo, ['rev-parse', 'HEAD'])
    await f.service.bindRepository(f.request.repoId, f.repo)
    const marker = join(f.root, 'filter-executed'),
      config = join(f.root, 'gitconfig'),
      program = join(f.root, 'filter.cjs')
    await writeFile(
      program,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); process.stdin.pipe(process.stdout)`
    )
    const command = `"${process.execPath.replaceAll('\\', '/')}" "${program.replaceAll('\\', '/')}"`
    await writeFile(config, '')
    for (const driver of ['clean', 'smudge'])
      await git(f.repo, ['config', '--file', config, `filter.probe.${driver}`, command])
    await git(f.repo, ['config', '--file', config, 'filter.probe.required', 'true'])
    vi.stubEnv('GIT_CONFIG_GLOBAL', config)
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')

    const signed = await f.service.run(f.request, f.context, f.execution),
      record = f.service.query(f.execution, f.context)!,
      result = verifyDispatchResult(f.identity, signed, {
        node: f.identity.self()!.node,
        user: f.identity.self()!.user,
        rpc: f.context.id,
        execution: f.execution,
        repoId: f.request.repoId,
        baseCommit: f.request.baseCommit,
        requestHash: record.requestHash
      })
    expect(await git(f.repo, ['show', `${result.ref}:asset.bin`])).toBe('stored bytes')
    expect(await git(f.repo, ['show', `${result.ref}:result.bin`])).toBe('exact result bytes')
    const bundle = join(f.root, 'published.bundle')
    await writeFile(bundle, f.bytes())
    await git(f.repo, ['bundle', 'verify', bundle])
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    // Force Git to inspect the file content again during its safe removal check.
    const asset = join(record.worktree!.path, 'asset.bin')
    await writeFile(asset, mode === 'recovery' ? 'owner dirty bytes\n' : 'stored bytes\n')
    f.commit()
    await f.service.drainCleanup()
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    if (mode === 'recovery') {
      expect(f.service.query(f.execution, f.context)).toMatchObject({
        state: 'completed',
        phase: 'cleanup',
        cleanupError: 'worktree_cleanup_failed'
      })
      expect(await readFile(asset, 'utf8')).toBe('owner dirty bytes\n')
      await writeFile(asset, 'stored bytes\n')
      await f.service.recover()
      await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(f.service.query(f.execution, f.context)).toMatchObject({
      state: 'completed',
      phase: 'complete'
    })
    expect(f.effects()).toBe(1)
  }
)

it('refuses configured clean filters before model effects or staging executes the external program', async () => {
  const f = await fixture()
  await f.service.bindRepository(f.request.repoId, f.repo)
  const marker = join(f.root, 'clean-executed')
  await git(f.repo, ['config', 'filter.probe.clean', `sh -c "printf executed > '${marker}'; cat"`])
  await expect(f.service.run(f.request, f.context, f.execution)).rejects.toMatchObject({
    code: 'profile_unsupported'
  })
  await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.effects()).toBe(0)
})

it('cancels a running model without replay or unsafe cleanup', async () => {
  const f = await fixture(async (request) => {
    await writeFile(join(request.worktreePath, 'partial.txt'), 'effect')
    return new Promise((_, reject) =>
      request.signal.addEventListener('abort', () => reject(new NetError('cancelled')), {
        once: true
      })
    )
  })
  await f.service.bindRepository(f.request.repoId, f.repo)
  const pending = f.service.run(f.request, f.context, f.execution)
  for (let count = 0; count < 200 && f.effects() === 0; count++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  expect(f.effects()).toBe(1)
  f.service.cancel(f.execution, f.context)
  await expect(pending).rejects.toMatchObject({ code: 'outcome_uncertain' })
  const record = f.service.query(f.execution, f.context)!
  expect(record.state).toBe('uncertain')
  expect(await readFile(join(record.worktree!.path, 'partial.txt'), 'utf8')).toBe('effect')
  await f.service.recover()
  await expect(f.service.run(f.request, f.context, f.execution)).rejects.toMatchObject({
    code: 'outcome_uncertain'
  })
  expect(f.effects()).toBe(1)
  await expect(
    f.service.run({ ...f.request, prompt: 'different' }, f.context, f.execution)
  ).rejects.toMatchObject({ code: 'conflict' })
})

it.each(['preparing', 'running'] as const)(
  'recovers an actual SIGKILL during %s without repeating provider effects',
  async (phase) => {
    const f = await fixture()
    await f.service.bindRepository(f.request.repoId, f.repo)
    const worker = await sharedBuild({
      entryPoints: ['tests/net/bridge/dispatch/crash-worker.ts'],
      outfile: 'bridge-dispatch-crash-worker.mjs',
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'esm',
      banner: {
        js: "import { createRequire as dispatchTestRequire } from 'node:module'; const require = dispatchTestRequire(import.meta.url); const __dirname = process.cwd();"
      },
      logLevel: 'silent'
    })
    const child = fork(
      worker,
      [
        JSON.stringify({
          profile: f.profile,
          home: f.home,
          request: f.request,
          execution: f.execution,
          rpc: f.context.id,
          phase
        })
      ],
      {
        execPath: process.execPath,
        env: { ...process.env, NODE_PATH: await realpath('node_modules') },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      }
    )
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk).slice(0, 1000)
    })
    try {
      const ready = await Promise.race([
        once(child, 'message').then(([message]) => message),
        once(child, 'exit').then(() => {
          throw new Error(`Child exited: ${stderr}`)
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Child fixture did not reach durable phase')), 10_000)
        )
      ])
      expect(ready).toEqual({ ready: true })
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      expect((await exited)[1]).toBe('SIGKILL')
      const before = f.service.query(f.execution, f.context)!
      expect(before.phase).toBe(phase)
      await f.service.recover()
      const after = f.service.query(f.execution, f.context)!
      expect(after.state).toBe(phase === 'preparing' ? 'failed' : 'uncertain')
      if (phase === 'running')
        expect(await readFile(join(after.worktree!.path, 'crash-effect.txt'), 'utf8')).toBe(
          'committed model effect before SIGKILL'
        )
      await expect(f.service.run(f.request, f.context, f.execution)).rejects.toMatchObject({
        code: phase === 'preparing' ? 'cancelled' : 'outcome_uncertain'
      })
      expect(f.effects()).toBe(0)
    } finally {
      child.kill('SIGKILL')
    }
  },
  20_000
)

describe('worktree cleanup keeps the ignored files a dispatch made', () => {
  const DAY = 24 * 60 * 60 * 1000
  /** What the agent leaves behind that Git ignores: a build output with bytes no text conversion survives, and a log. */
  const outputs = (): Record<string, Buffer> => ({
    'build/app.bin': Buffer.concat([randomBytes(3000), Buffer.from('\r\n\0\xff end\n', 'latin1')]),
    'run.log': Buffer.from('step one\r\nstep two\n')
  })
  /** Ignored through the repository's own exclude file, which every worktree of it reads. */
  async function ignoreOutputs(repo: string) {
    await mkdir(join(repo, '.git', 'info'), { recursive: true })
    await writeFile(join(repo, '.git', 'info', 'exclude'), 'build/\n*.log\n')
  }
  async function writeOutputs(worktree: string, files: Record<string, Buffer>) {
    for (const [path, bytes] of Object.entries(files)) {
      await mkdir(dirname(join(worktree, path)), { recursive: true })
      await writeFile(join(worktree, path), bytes)
    }
  }
  const completed = (request: Parameters<DispatchRuntime['run']>[0]) => ({
    runId: request.executionId,
    profileId: 'test',
    threadId: request.threadId,
    definitionId: definition.definitionId,
    definitionRevision: definition.revision,
    runtimeKind: 'mousse' as const,
    status: 'completed' as const,
    text: 'done',
    history: [],
    usage: { elapsedMs: 1 }
  })
  /** Writes a kept file back with the command a record names, in the repository's main folder, and reads its bytes. */
  function restore(repo: string, ref: string, path: string): Buffer {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    execFileSync('sh', ['-c', keptCopyRestoreCommand(ref).replaceAll('<path>', `'${path}'`)], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
    return readFileSync(join(repo, path))
  }
  const preservedRefs = async (repo: string) => (await git(repo, ['for-each-ref', '--format=%(refname)', 'refs/mousse/preserved/'])).split('\n').filter(Boolean)
  /** The copies of Git's own data of a removed worktree, which cleanup keeps beside the copy of its ignored files. */
  const adminRefs = async (repo: string) => {
    const refs: string[] = []
    for (const ref of await preservedRefs(repo)) if (await isCleanupAdminCapture(repo, ref)) refs.push(ref)
    return refs
  }
  /** A completed dispatch whose agent left `files` in its worktree. */
  async function completedDispatch(files: Record<string, Buffer>) {
    const f = await fixture(async (request) => {
      await writeOutputs(request.worktreePath, files)
      await writeFile(join(request.worktreePath, 'result.txt'), 'result\n')
      return completed(request)
    })
    await ignoreOutputs(f.repo)
    await f.service.bindRepository(f.request.repoId, f.repo)
    await f.service.run(f.request, f.context, f.execution)
    return f
  }
  function storage(f: Awaited<ReturnType<typeof fixture>>) {
    const store = f.threads.lifecycleStore
    const coordinator = new ResourceLifecycleCoordinator(store, { drain: async () => {}, settleMutationOwnership: async () => {}, projectIndex: () => {}, projectPurged: () => {} })
    const clock = new StorageSweepClock(store.root)
    clock.start()
    const policy = new StoragePolicyStore(store, clock)
    policy.configure(STORAGE_POLICY_DEFAULTS, true)
    return new StorageCleanupService({ store, threads: f.threads, purge: coordinator.cleanup, policy, clock, idle: () => undefined, installationHome: f.home })
  }

  it('a completed dispatch keeps its ignored outputs, then removes the worktree, and the copy gives back their exact bytes (the cleanup reproduction, inverted)', async () => {
    const files = outputs()
    const f = await completedDispatch(files)
    const worktree = f.service.query(f.execution, f.context)!.worktree!.path
    f.commit()
    await f.service.drainCleanup()
    const record = f.service.query(f.execution, f.context)!
    expect(record).toMatchObject({ state: 'completed', phase: 'complete', worktreeCopy: { files: 2 } })
    expect(record.worktreeKept).toBeUndefined()
    expect(record.worktreeCleanup).toBeUndefined()
    await expect(stat(worktree)).rejects.toMatchObject({ code: 'ENOENT' })
    // The dispatch owns the copy, so its Undo window decides when it goes.
    expect(threadPreservedIndex(dispatchKeptFilesOwner(f.profile, record.id)).owns(record.worktreeCopy!.ref)).toBe(true)
    // Beside it, the dispatch keeps Git's own data of the worktree, until the same window ends.
    const admin = await adminRefs(f.repo)
    expect(admin).toHaveLength(1)
    expect(threadPreservedIndex(dispatchKeptFilesOwner(f.profile, record.id)).owns(admin[0]!)).toBe(true)
    expect((await preservedRefs(f.repo)).sort()).toEqual([record.worktreeCopy!.ref, admin[0]!].sort())
    for (const [path, bytes] of Object.entries(files)) expect(restore(f.repo, record.worktreeCopy!.ref, path).equals(bytes)).toBe(true)
  })

  it('a dispatch that fails before its agent runs, and has no thread, still keeps the ignored files in its worktree first', async () => {
    const files = outputs()
    const f = await fixture()
    await ignoreOutputs(f.repo)
    await f.service.bindRepository(f.request.repoId, f.repo)
    // Something wrote into the new worktree, then the thread could not be made: the dispatch fails with no effects.
    f.threads.ensureExecutionThread = () => {
      const worktree = f.service.query(f.execution, f.context)!.worktree!.path
      for (const [path, bytes] of Object.entries(files)) {
        mkdirSync(dirname(join(worktree, path)), { recursive: true })
        execFileSync('sh', ['-c', 'cat > "$1"', 'sh', join(worktree, path)], { input: bytes })
      }
      throw new Error('Execution project is unavailable')
    }
    await expect(f.service.run(f.request, f.context, f.execution)).rejects.toBeInstanceOf(NetError)
    const record = f.service.query(f.execution, f.context)!
    expect(record).toMatchObject({ state: 'failed', phase: 'complete', worktreeCopy: { files: 2 } })
    expect(record.threadId).toBeUndefined()
    await expect(stat(record.worktree!.path)).rejects.toMatchObject({ code: 'ENOENT' })
    for (const [path, bytes] of Object.entries(files)) expect(restore(f.repo, record.worktreeCopy!.ref, path).equals(bytes)).toBe(true)
    expect(f.effects()).toBe(0)
  })

  it('a dispatch with no thread whose cleanup a process left part way is finished by Storage against its proof, and every byte is kept', async () => {
    const files = outputs()
    const f = await fixture()
    await ignoreOutputs(f.repo)
    await f.service.bindRepository(f.request.repoId, f.repo)
    f.threads.ensureExecutionThread = () => {
      const worktree = f.service.query(f.execution, f.context)!.worktree!.path
      for (const [path, bytes] of Object.entries(files)) {
        mkdirSync(dirname(join(worktree, path)), { recursive: true })
        execFileSync('sh', ['-c', 'cat > "$1"', 'sh', join(worktree, path)], { input: bytes })
      }
      throw new Error('Execution project is unavailable')
    }
    // The delete stops after its first removal, as when the process ends there.
    const cleanupWorktree = WorktreeManager.prototype.cleanupValidatedAgentWorktree
    let removals = 0
    vi.spyOn(WorktreeManager.prototype, 'cleanupValidatedAgentWorktree').mockImplementationOnce(function (this: WorktreeManager, info, options) {
      return cleanupWorktree.call(this, info, { ...options, beforeRemove: () => { if (++removals === 2) throw new Error('The process ended') } })
    })
    await expect(f.service.run(f.request, f.context, f.execution)).rejects.toBeInstanceOf(NetError)
    const record = f.service.query(f.execution, f.context)!
    expect(record.threadId).toBeUndefined()
    expect(record).toMatchObject({ state: 'failed', phase: 'cleanup', cleanupError: 'worktree_cleanup_failed', worktreeCopy: { files: 2 } })
    const worktree = record.worktree!.path
    const left = (await readdir(dirname(worktree))).filter((name) => /^\.deleting-[a-f0-9]{16}$/.test(name)).map((name) => join(dirname(worktree), name))
    expect(left).toHaveLength(1)
    expect(existsSync(worktree)).toBe(false)
    // A save into what is left before Storage runs.
    const saved = Buffer.from('saved into what was left 31be\n')
    await mkdir(join(left[0]!, 'build'), { recursive: true }); await writeFile(join(left[0]!, 'build', 'after.bin'), saved)

    const report = await storage(f).run('schedule')
    expect(report.items).toContainEqual(expect.objectContaining({ rule: 'worktree-orphan', outcome: 'removed', reason: expect.stringMatching(/^Finished a cleanup that stopped part way/) }))
    expect(existsSync(left[0]!)).toBe(false)
    expect(existsSync(`${left[0]!}.json`)).toBe(false)
    expect(await git(f.repo, ['worktree', 'list', '--porcelain'])).not.toContain(worktree)
    for (const [path, bytes] of Object.entries(files)) expect(restore(f.repo, record.worktreeCopy!.ref, path).equals(bytes)).toBe(true)
    const owner = threadPreservedIndex(dispatchKeptFilesOwner(f.profile, record.id))
    const late = (await preservedRefs(f.repo)).filter((ref) => owner.owns(ref) && ref !== record.worktreeCopy!.ref && !execFileSync('git', ['cat-file', 'commit', ref], { cwd: f.repo, encoding: 'utf8' }).includes("Git's own data"))
    expect(late.some((ref) => { try { return restore(f.repo, ref, 'build/after.bin').equals(saved) } catch { return false } })).toBe(true)

    // The dispatch's next start finds nothing left to do.
    await f.service.recover()
    expect(f.service.query(f.execution, f.context)).toMatchObject({ phase: 'complete' })
    expect(f.service.query(f.execution, f.context)!.cleanupError).toBeUndefined()
  })

  it('over the copy limit, the worktree stays with every ignored file, and the record says how many it kept', async () => {
    const files = outputs()
    const f = await completedDispatch(files)
    const limit = KEEP_COPY_LIMITS.bytes
    KEEP_COPY_LIMITS.bytes = 1024
    try {
      f.commit()
      await f.service.drainCleanup()
    } finally {
      KEEP_COPY_LIMITS.bytes = limit
    }
    const record = f.service.query(f.execution, f.context)!
    expect(record).toMatchObject({ state: 'completed', phase: 'complete', worktreeKept: { ignoredFiles: 2, reason: expect.stringMatching(/^Kept, 2 ignored files: .*build\/app\.bin/) } })
    expect(record.worktreeCopy).toBeUndefined()
    expect(record.cleanupError).toBeUndefined()
    for (const [path, bytes] of Object.entries(files)) expect(readFileSync(join(record.worktree!.path, path)).equals(bytes)).toBe(true)
    expect(await preservedRefs(f.repo)).toEqual([])
    expect(listKeptWorktrees(f.profile)).toEqual([expect.objectContaining({ dispatchId: record.id, threadId: record.threadId, path: record.worktree!.path, ignoredFiles: 2 })])
    // A later start does not try again: the record is settled.
    await f.service.recover()
    expect(existsSync(record.worktree!.path)).toBe(true)
  })

  it('a worktree with uncommitted changes stays untouched with no Git removal run, the record names the files, and the next start removes it through the verified delete once it is clean', async () => {
    const files = outputs()
    const f = await completedDispatch(files)
    const worktree = f.service.query(f.execution, f.context)!.worktree!.path
    const draft = Buffer.from('draft left by hand 6d02\r\n')
    await writeFile(join(worktree, 'draft.txt'), draft)
    const guard = installGitRemoveGuard()
    try {
      f.commit()
      await f.service.drainCleanup()
      const record = f.service.query(f.execution, f.context)!
      expect(record).toMatchObject({ state: 'completed', phase: 'cleanup', cleanupError: 'worktree_cleanup_failed', cleanupReason: 'Kept: it has uncommitted changes (draft.txt). Nothing in it was changed.' })
      expect(record.worktreeKept).toBeUndefined()
      expect(guard.removes()).toEqual([])
      expect(readFileSync(join(worktree, 'draft.txt')).equals(draft)).toBe(true)
      for (const [path, bytes] of Object.entries(files)) expect(readFileSync(join(worktree, path)).equals(bytes)).toBe(true)
      expect(await preservedRefs(f.repo)).toEqual([])
      expect(listKeptWorktrees(f.profile)).toEqual([])

      await rm(join(worktree, 'draft.txt'))
      await f.service.recover()
      const after = f.service.query(f.execution, f.context)!
      expect(after).toMatchObject({ state: 'completed', phase: 'complete', worktreeCopy: { files: 2 } })
      expect(after.cleanupError).toBeUndefined()
      expect(after.cleanupReason).toBeUndefined()
      expect(existsSync(worktree)).toBe(false)
      // Git only unregistered the folder, after Mousse's verified delete had removed it.
      expect(guard.removes().map((call) => call.path)).toEqual([worktree])
      guard.assertNoRemoveOfExisting()
      for (const [path, bytes] of Object.entries(files)) expect(restore(f.repo, after.worktreeCopy!.ref, path).equals(bytes)).toBe(true)
      expect(await adminRefs(f.repo)).toHaveLength(1)
      expect(f.effects()).toBe(1)
    } finally {
      guard.restore()
    }
  })

  it('Storage keeps a dispatch\'s left worktree that has uncommitted changes, names them, and runs no Git removal; once clean it removes it', async () => {
    const files = outputs()
    const f = await completedDispatch(files)
    const limit = KEEP_COPY_LIMITS.bytes
    KEEP_COPY_LIMITS.bytes = 1024
    try {
      f.commit()
      await f.service.drainCleanup()
    } finally {
      KEEP_COPY_LIMITS.bytes = limit
    }
    const record = f.service.query(f.execution, f.context)!
    expect(record.worktreeKept).toMatchObject({ ignoredFiles: 2 })
    const worktree = record.worktree!.path
    await writeFile(join(worktree, 'draft.txt'), 'draft\n')
    const guard = installGitRemoveGuard()
    try {
      const cleanup = storage(f)
      const { token } = await cleanup.planWithToken()
      const refused = await cleanup.run('manual', { plan: token })
      expect(refused.items.filter((item) => item.rule === 'dispatch-worktree')).toEqual([expect.objectContaining({ outcome: 'kept', reason: 'It has uncommitted changes (draft.txt), so it stays as it is. It can be removed once they are committed or discarded.' })])
      expect(guard.removes()).toEqual([])
      expect(readFileSync(join(worktree, 'draft.txt'), 'utf8')).toBe('draft\n')
      for (const [path, bytes] of Object.entries(files)) expect(readFileSync(join(worktree, path)).equals(bytes)).toBe(true)
      expect(listKeptWorktrees(f.profile)).toHaveLength(1)

      await rm(join(worktree, 'draft.txt'))
      const again = await cleanup.planWithToken()
      const confirmed = await cleanup.run('manual', { plan: again.token })
      expect(confirmed.items.filter((item) => item.rule === 'dispatch-worktree')).toEqual([expect.objectContaining({ outcome: 'removed', label: record.id })])
      expect(existsSync(worktree)).toBe(false)
      expect(guard.removes().map((call) => call.path)).toEqual([worktree])
      guard.assertNoRemoveOfExisting()
      await cleanup.stop()
    } finally {
      guard.restore()
    }
  })

  it('with no ignored files, removes the worktree after keeping only Git\'s own data of it', async () => {
    const f = await completedDispatch({})
    const worktree = f.service.query(f.execution, f.context)!.worktree!.path
    f.commit()
    await f.service.drainCleanup()
    const record = f.service.query(f.execution, f.context)!
    expect(record).toMatchObject({ state: 'completed', phase: 'complete' })
    expect(record.worktreeCopy).toBeUndefined()
    expect(record.worktreeKept).toBeUndefined()
    await expect(stat(worktree)).rejects.toMatchObject({ code: 'ENOENT' })
    const admin = await adminRefs(f.repo)
    expect(admin).toHaveLength(1)
    expect(await preservedRefs(f.repo)).toEqual(admin)
    expect(threadPreservedIndex(dispatchKeptFilesOwner(f.profile, record.id)).owns(admin[0]!)).toBe(true)
  })

  it('a start after the process ended before cleanup began keeps the ignored files, then removes the worktree', async () => {
    const files = outputs()
    const f = await completedDispatch(files)
    // The terminal transaction commits, and the process ends before its cleanup starts.
    const afterCommit = f.db.afterCommit
    f.db.afterCommit = () => undefined
    f.commit()
    f.db.afterCommit = afterCommit
    expect(f.service.query(f.execution, f.context)).toMatchObject({ state: 'completed', phase: 'cleanup' })
    await f.service.recover()
    const record = f.service.query(f.execution, f.context)!
    expect(record).toMatchObject({ phase: 'complete', worktreeCopy: { files: 2 } })
    await expect(stat(record.worktree!.path)).rejects.toMatchObject({ code: 'ENOENT' })
    for (const [path, bytes] of Object.entries(files)) expect(restore(f.repo, record.worktreeCopy!.ref, path).equals(bytes)).toBe(true)
  })

  it.each(['keeping', 'deleting'] as const)(
    'a start after the process was killed while cleanup was %s settles it from what is there and its record, keeping every byte',
    async (step) => {
      const files = outputs()
      const f = await fixture()
      await ignoreOutputs(f.repo)
      await f.service.bindRepository(f.request.repoId, f.repo)
      const worker = await sharedBuild({
        entryPoints: ['tests/net/bridge/dispatch/crash-worker.ts'],
        outfile: 'bridge-dispatch-crash-worker.mjs',
        bundle: true,
        packages: 'external',
        platform: 'node',
        format: 'esm',
        banner: {
          js: "import { createRequire as dispatchTestRequire } from 'node:module'; const require = dispatchTestRequire(import.meta.url); const __dirname = process.cwd();"
        },
        logLevel: 'silent'
      })
      const marker = join(f.root, 'cleanup-paused')
      const child = fork(
        worker,
        [JSON.stringify({ profile: f.profile, home: f.home, request: f.request, execution: f.execution, rpc: f.context.id, phase: `cleanup-${step}`, marker,
          outputs: Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, bytes.toString('base64')])) })],
        { execPath: process.execPath, env: { ...process.env, NODE_PATH: await realpath('node_modules') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
      )
      let stderr = ''
      child.stderr?.on('data', (chunk) => { stderr += String(chunk).slice(0, 2000) })
      let exited = false
      child.once('exit', () => { exited = true })
      try {
        for (let waited = 0; !existsSync(marker); waited += 20) {
          if (exited) throw new Error(`Child exited: ${stderr}`)
          if (waited > 30_000) throw new Error('Child fixture did not reach the cleanup step')
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        const ended = once(child, 'exit')
        child.kill('SIGKILL')
        await ended
      } finally {
        child.kill('SIGKILL')
      }
      const before = f.service.query(f.execution, f.context)!
      expect(before).toMatchObject({ state: 'completed', phase: 'cleanup', worktreeCleanup: { phase: step, files: 2 } })
      const worktree = before.worktree!.path
      expect(existsSync(worktree)).toBe(true)

      await f.service.recover()
      const after: DispatchRecord = f.service.query(f.execution, f.context)!
      expect(after.worktreeCleanup).toBeUndefined()
      if (step === 'deleting') {
        // The proof was recorded before the folder would move: the start check finishes the cleanup, as a verified delete.
        expect(before.worktreeCleanup!.path).toMatch(/\/\.deleting-[a-f0-9]{16}$/)
        expect(after).toMatchObject({ state: 'completed', phase: 'complete', worktreeCopy: { files: 2 } })
        expect(after.worktreeKept).toBeUndefined()
        expect(existsSync(worktree)).toBe(false)
        expect(existsSync(before.worktreeCleanup!.path!)).toBe(false)
        expect(await git(f.repo, ['worktree', 'list', '--porcelain'])).not.toContain(worktree)
        for (const [path, bytes] of Object.entries(files)) expect(restore(f.repo, after.worktreeCopy!.ref, path).equals(bytes)).toBe(true)
        expect(listKeptWorktrees(f.profile)).toEqual([])
      } else {
        expect(after).toMatchObject({ state: 'completed', phase: 'complete', worktreeKept: { ignoredFiles: 2, reason: expect.stringMatching(/^Kept, 2 ignored files: its cleanup stopped part way/) } })
        expect(existsSync(worktree)).toBe(true)
        for (const [path, bytes] of Object.entries(files)) expect(readFileSync(join(worktree, path)).equals(bytes)).toBe(true)
        expect(after.worktreeCopy).toBeUndefined()
        expect(listKeptWorktrees(f.profile)).toEqual([expect.objectContaining({ dispatchId: after.id, path: worktree })])
        await f.service.recover()
        expect(existsSync(worktree)).toBe(true)
      }
      expect(f.effects()).toBe(0)
    },
    60_000
  )

  it('a worktree a dispatch with no thread left in place is listed in Storage, and is deleted only when a confirmed plan names it', async () => {
    const files = outputs()
    const f = await fixture()
    await ignoreOutputs(f.repo)
    await f.service.bindRepository(f.request.repoId, f.repo)
    f.threads.ensureExecutionThread = () => {
      const worktree = f.service.query(f.execution, f.context)!.worktree!.path
      for (const [path, bytes] of Object.entries(files)) {
        mkdirSync(dirname(join(worktree, path)), { recursive: true })
        execFileSync('sh', ['-c', 'cat > "$1"', 'sh', join(worktree, path)], { input: bytes })
      }
      throw new Error('Execution project is unavailable')
    }
    const limit = KEEP_COPY_LIMITS.bytes
    KEEP_COPY_LIMITS.bytes = 1024
    try {
      await expect(f.service.run(f.request, f.context, f.execution)).rejects.toBeInstanceOf(NetError)
    } finally {
      KEEP_COPY_LIMITS.bytes = limit
    }
    const record = f.service.query(f.execution, f.context)!
    expect(record).toMatchObject({ state: 'failed', phase: 'complete', worktreeKept: { ignoredFiles: 2 } })
    expect(record.threadId).toBeUndefined()
    const worktree = record.worktree!.path

    const cleanup = storage(f)
    const { plan, token } = await cleanup.planWithToken()
    const row = plan.filter((item) => item.rule === 'dispatch-worktree')
    expect(row).toEqual([expect.objectContaining({ action: 'remove', key: `dispatch-worktree:${record.id}`, label: record.id, reason: expect.stringContaining('2 ignored files'), bytes: expect.any(Number) })])
    expect(row[0]!.bytes).toBeGreaterThan(3000)
    // It is not also listed as an unused worktree.
    expect(plan.filter((item) => item.rule === 'worktree-orphan')).toEqual([])

    // A run nobody confirmed leaves it, and says so.
    const unplanned = await cleanup.run('manual')
    expect(unplanned.items.filter((item) => item.rule === 'dispatch-worktree')).toEqual([expect.objectContaining({ outcome: 'kept' })])
    for (const [path, bytes] of Object.entries(files)) expect(readFileSync(join(worktree, path)).equals(bytes)).toBe(true)

    const confirmed = await cleanup.run('manual', { plan: token })
    expect(confirmed.items.filter((item) => item.rule === 'dispatch-worktree')).toEqual([expect.objectContaining({ outcome: 'removed', label: record.id })])
    expect(existsSync(worktree)).toBe(false)
    expect(await git(f.repo, ['worktree', 'list', '--porcelain'])).not.toContain(worktree)
    expect(listKeptWorktrees(f.profile)).toEqual([])
    expect((await cleanup.plan()).filter((item) => item.rule === 'dispatch-worktree')).toEqual([])
    await cleanup.stop()
  })

  it('the hourly sweep expires a dispatch’s copy after its Undo window, and not before', async () => {
    const start = Date.parse('2026-11-03T12:00:00Z')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(start)
    try {
      const f = await completedDispatch(outputs())
      f.commit()
      await f.service.drainCleanup()
      const record = f.service.query(f.execution, f.context)!
      expect(record.worktreeCopy).toBeDefined()
      const sweeper = new UndoRetentionSweeper({ list: () => [], profileHome: f.profile } as unknown as ResourceLifecycleStore)
      // The first pass belongs to starting up and never expires anything.
      await sweeper.tick()
      for (let day = 6; day < 30; day += 6) {
        vi.setSystemTime(start + day * DAY)
        await sweeper.tick()
      }
      vi.setSystemTime(start + 30 * DAY - 60 * 60 * 1000)
      await sweeper.tick()
      const admin = await adminRefs(f.repo)
      expect(admin).toHaveLength(1)
      expect((await preservedRefs(f.repo)).sort()).toEqual([record.worktreeCopy!.ref, admin[0]!].sort())
      expect(sweeper.outcomes.get(`dispatch:${record.id}:${f.repo}`)).toMatchObject({ expiredPreservedRefs: 0 })
      vi.setSystemTime(start + 30 * DAY + 60 * 60 * 1000)
      await sweeper.tick()
      // Both copies go together: the ignored files, and Git's own data of the worktree with the commits only it named.
      expect(await preservedRefs(f.repo)).toEqual([])
      expect(sweeper.outcomes.get(`dispatch:${record.id}:${f.repo}`)).toMatchObject({ expiredPreservedRefs: 2 })
      await sweeper.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
