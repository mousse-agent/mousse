import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, stat, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { build } from 'esbuild'
import { newId, NetError, type RpcArtifactRef } from '../../../../src/shared/net'
import type { ResolvedAgentDefinition } from '../../../../src/shared/agents/types'
import { NetDatabase } from '../../../../src/mms/net/store/database'
import { FileKeyStore } from '../../../../src/mms/net/identity/FileKeyStore'
import { NetIdentityService } from '../../../../src/mms/net/identity/NetIdentityService'
import { ProjectManager } from '../../../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../../../src/mms/data/ThreadDataStore'
import type { RpcContext } from '../../../../src/mms/net/contracts'
import { DispatchService, portableRepository, normalizeRemote, verifyDispatchResult, type DispatchRequest, type DispatchRuntime } from '../../../../src/mms/bridge/dispatch'
import { git } from '../../../../src/mms/bridge/dispatch/git'
import { FakeClock } from '../../harness/FakeClock'
import type { Clock } from '../../../../src/mms/net/contracts'
import { inputRef } from '../../../../src/mms/bridge/dispatch/bundle'

const roots: string[] = [], databases: NetDatabase[] = []
afterEach(async () => { for (const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const definition = { definitionId: 'agent_dispatch', profileId: 'test', revision: 'revision-1', runtimeKind: 'mousse' } as ResolvedAgentDefinition
async function repository(path: string) {
  await mkdir(path, { recursive: true }); await git(path, ['init', '--template='])
  await writeFile(join(path, 'base.txt'), 'base\n'); await git(path, ['add', '.'])
  await git(path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'base'])
  await git(path, ['remote', 'add', 'origin', 'https://EXAMPLE.com/team/repository.git'])
  return git(path, ['rev-parse', 'HEAD'])
}
async function fixture(runtimeOverride?: DispatchRuntime['run'], clock?: Clock) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mousse-dispatch-'))); roots.push(root)
  const repo = join(root, 'repo'), profile = join(root, 'profile'), home = join(root, 'home')
  await mkdir(profile); await mkdir(home)
  const base = await repository(repo), identityRepo = await portableRepository(repo)
  const db = new NetDatabase({ profileDir: profile, clock }); databases.push(db)
  const keys = new FileKeyStore(profile), identity = new NetIdentityService({ database: db.database, keys, clock: db.clock, coordinator: db })
  await identity.bootstrapAuthority('Fixture')
  const projects = new ProjectManager(profile), threads = new ThreadDataStore(projects, profile, { profileId: 'test', allowLegacyProjectData: false })
  projects.setThreadStore(threads)
  let effects = 0, preparedBytes = Buffer.alloc(0), source = Buffer.alloc(0)
  db.database.exec('CREATE TABLE dispatch_test_publication(blob TEXT PRIMARY KEY); CREATE TABLE dispatch_test_terminal(execution TEXT PRIMARY KEY);')
  const runtime: DispatchRuntime = { resolveAgent: async () => structuredClone(definition), run: async request => {
    effects++
    if (runtimeOverride) return runtimeOverride(request)
    expect(await git(request.worktreePath, ['rev-parse', 'HEAD'])).toBe(base)
    await writeFile(join(request.worktreePath, 'result.txt'), 'verified model fixture\n')
    return { runId: request.executionId, profileId: 'test', threadId: request.threadId, definitionId: definition.definitionId, definitionRevision: definition.revision, runtimeKind: 'mousse', status: 'completed', text: 'done', history: [], usage: { elapsedMs: 1 } }
  } }
  const service = new DispatchService({ db, identity, installationHome: home, profileId: 'test', threads, runtime, artifacts: { readInput: async () => source, prepareResult: async bytes => {
    preparedBytes = Buffer.from(bytes)
    const ref: RpcArtifactRef = { stream: newId('stream'), event: newId('event'), blob: `blb_${hash(bytes)}` }
    return { ref, commit: () => { db.charge(1); db.database.prepare('INSERT INTO dispatch_test_publication VALUES(?)').run(ref.blob) } }
  } } })
  const roster = identity.verifySigned<import('../../../../src/shared/net').Roster>(identity.roster()!, keys.rootKey()!)
  const delegation = identity.verifySigned<import('../../../../src/shared/net').NodeDelegation>(roster.nodes[0], keys.rootKey()!)
  const self = identity.self()!, callbacks: Array<() => void> = [], controller = new AbortController()
  const context: RpcContext = { id: newId('rpc'), caller: { ...self, delegation }, signal: controller.signal, deadlineAt: db.clock.now() + 30_000, progress: () => undefined, onTerminalCommit: work => callbacks.push(work) }
  const request: DispatchRequest = { repoId: identityRepo.repoId, baseCommit: base, agent: 'agent_dispatch', prompt: 'Write result.txt', limits: { maxTurns: 2, maxToolCalls: 3, maxElapsedMs: 20_000 } }
  const execution = newId('execution')
  return { root, repo, profile, home, db, keys, identity, threads, service, request, execution, context, controller, effects: () => effects, callbacks, bytes: () => preparedBytes, source: (bytes: Buffer) => { source = bytes }, commit: () => db.transaction(() => { callbacks.forEach(work => work()); db.database.prepare('INSERT INTO dispatch_test_terminal VALUES(?)').run(execution) }) }
}

it('derives the same portable identity for clones and normalized transport/user differences', async () => {
  const f = await fixture(), clone = join(f.root, 'clone')
  await git(f.root, ['clone', '--no-hardlinks', f.repo, clone]); await git(clone, ['remote', 'set-url', 'origin', 'git@example.com:team/repository.git'])
  expect((await portableRepository(clone)).repoId).toBe(f.request.repoId)
  expect(normalizeRemote('ssh://git@EXAMPLE.com:22/team/repository.git')).toBe('example.com/team/repository')
  expect(() => normalizeRemote('https://example.com/team/repo.git?token=secret')).toThrow()
  await writeFile(join(clone, 'dirty.txt'), 'caller dirty'); expect((await portableRepository(clone)).repoId).toBe(f.request.repoId)
})

it('requires explicit binding and exact profile before worktree/model effects', async () => {
  const f = await fixture()
  await expect(f.service.run(f.request, f.context, f.execution)).rejects.toMatchObject({ code: 'repo_not_bound' })
  expect(f.effects()).toBe(0)
  await expect(f.service.bindRepository(`repo_${'a'.repeat(64)}`, f.repo)).rejects.toMatchObject({ code: 'conflict' })
  await f.service.bindRepository(f.request.repoId, f.repo)
  await expect(f.service.run({ ...f.request, localPath: '/tmp' }, f.context, f.execution)).rejects.toMatchObject({ code: 'bad_request' })
  await expect(f.service.run({ ...f.request, push: true }, f.context, f.execution)).rejects.toMatchObject({ code: 'forbidden' })
  expect(f.effects()).toBe(0)
})

it('runs in an actual isolated stable thread/worktree and atomically settles signed Git bundle', async () => {
  const f = await fixture(); await f.service.bindRepository(f.request.repoId, f.repo)
  await writeFile(join(f.repo, 'caller-only.txt'), 'dirty caller data')
  const signed = await f.service.run(f.request, f.context, f.execution), record = f.service.query(f.execution, f.context)!
  expect(record).toMatchObject({ state: 'running', phase: 'publishing' }); expect(f.effects()).toBe(1)
  expect(f.db.database.prepare('SELECT * FROM dispatch_test_publication').all()).toHaveLength(0)
  const result = verifyDispatchResult(f.identity, signed, { node: f.identity.self()!.node, user: f.identity.self()!.user, rpc: f.context.id, execution: f.execution, repoId: f.request.repoId, baseCommit: f.request.baseCommit, requestHash: record.requestHash })
  expect(result.bundleHash).toBe(hash(f.bytes()))
  expect(await git(f.repo, ['show', `${result.headCommit}:result.txt`])).toBe('verified model fixture')
  await expect(git(f.repo, ['show', `${result.headCommit}:caller-only.txt`])).rejects.toThrow()
  expect(f.threads.ensureExecutionThread(`bridge.dispatch:${f.execution}`, 'same').id).toBe(result.threadId)
  const bundle = join(f.root, 'result.bundle'); await writeFile(bundle, f.bytes())
  expect(await git(f.repo, ['bundle', 'list-heads', bundle])).toBe(`${result.headCommit} ${result.ref}`)
  f.commit(); await f.service.drainCleanup()
  expect(f.service.query(f.execution, f.context)).toMatchObject({ state: 'completed', phase: 'complete' })
  await expect(stat(record.worktree!.path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.db.database.prepare('SELECT * FROM dispatch_test_publication').all()).toHaveLength(1)
  expect(await f.service.run(f.request, f.context, f.execution)).toEqual(signed); expect(f.effects()).toBe(1)
  const altered = structuredClone(signed), body = JSON.parse(Buffer.from(altered.payload, 'base64url').toString()); body.headCommit = 'a'.repeat(40); altered.payload = Buffer.from(JSON.stringify(body)).toString('base64url')
  expect(() => verifyDispatchResult(f.identity, altered, { node: f.identity.self()!.node, user: f.identity.self()!.user, rpc: f.context.id, execution: f.execution, repoId: f.request.repoId, baseCommit: f.request.baseCommit, requestHash: record.requestHash })).toThrow()
})

it('keeps unpublished publishing work uncertain after terminal transaction rollback and never reruns', async () => {
  const f = await fixture(); await f.service.bindRepository(f.request.repoId, f.repo)
  await f.service.run(f.request, f.context, f.execution)
  expect(() => f.db.transaction(() => { f.callbacks.forEach(work => work()); throw new Error('terminal failure') })).toThrow('terminal failure')
  expect(f.db.database.prepare('SELECT * FROM dispatch_test_publication').all()).toHaveLength(0)
  expect(f.service.query(f.execution, f.context)).toMatchObject({ state: 'running', phase: 'publishing' })
  await f.service.recover()
  expect(f.service.query(f.execution, f.context)).toMatchObject({ state: 'uncertain', phase: 'publishing' })
  await expect(f.service.run(f.request, f.context, f.execution)).rejects.toMatchObject({ code: 'outcome_uncertain' }); expect(f.effects()).toBe(1)
})

it('imports a missing exact base through verified incremental quarantine without copying dirty files', async () => {
  const f = await fixture(), sender = join(f.root, 'sender')
  await git(f.root, ['clone', f.repo, sender]); await git(sender, ['remote', 'set-url', 'origin', 'git@example.com:team/repository.git'])
  await writeFile(join(sender, 'new.txt'), 'new base\n'); await git(sender, ['add', '.']); await git(sender, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'new'])
  const base = await git(sender, ['rev-parse', 'HEAD']); await git(sender, ['update-ref', inputRef(base), base])
  const bundle = join(f.root, 'input.bundle'); await git(sender, ['bundle', 'create', bundle, inputRef(base), `^${f.request.baseCommit}`]); const bytes = await readFile(bundle)
  f.source(bytes); f.request.baseCommit = base; f.request.inputBundle = { stream: newId('stream'), event: newId('event'), blob: `blb_${hash(bytes)}` }
  await f.service.bindRepository(f.request.repoId, f.repo)
  // The default fixture requires its original base, so use a fresh service runtime below.
  const f2 = await fixture(async request => ({ runId: request.executionId, profileId: 'test', threadId: request.threadId, definitionId: definition.definitionId, definitionRevision: definition.revision, runtimeKind: 'mousse', status: 'completed', text: await git(request.worktreePath, ['show', 'HEAD:new.txt']), history: [], usage: { elapsedMs: 1 } }))
  await f2.service.bindRepository(f.request.repoId, f.repo); f2.source(bytes)
  await f2.service.run(f.request, f2.context, f2.execution); f2.commit(); await f2.service.drainCleanup()
  expect(await git(f.repo, ['rev-parse', '--verify', inputRef(base)])).toBe(base); expect(f2.effects()).toBe(1)
})

it('rejects artifact hash mismatch and unexpected bundle refs before effects', async () => {
  const f = await fixture(); await f.service.bindRepository(f.request.repoId, f.repo)
  const bundle = join(f.root, 'unexpected.bundle'); await git(f.repo, ['bundle', 'create', bundle, 'HEAD']); const bytes = await readFile(bundle); f.source(bytes)
  const inputBundle: RpcArtifactRef = { stream: newId('stream'), event: newId('event'), blob: `blb_${'0'.repeat(64)}` }
  await expect(f.service.run({ ...f.request, inputBundle }, f.context, f.execution)).rejects.toMatchObject({ code: 'conflict' })
  inputBundle.blob = `blb_${hash(bytes)}`
  await expect(f.service.run({ ...f.request, inputBundle }, { ...f.context, id: newId('rpc') }, newId('execution'))).rejects.toMatchObject({ code: 'bad_request' })
  expect(f.effects()).toBe(0)
})

it('rejects a bundle containing a forbidden .git tree path in quarantine', async () => {
  const f = await fixture(), sender = join(f.root, 'malicious-sender')
  await git(f.root, ['clone', f.repo, sender])
  const blob = await git(sender, ['rev-parse', 'HEAD:base.txt']), treeFile = join(f.root, 'malformed-tree')
  await writeFile(treeFile, Buffer.concat([Buffer.from('100644 .git\0'), Buffer.from(blob, 'hex')]))
  const tree = await git(sender, ['hash-object', '--literally', '-t', 'tree', '-w', treeFile])
  const commit = await git(sender, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit-tree', tree, '-p', f.request.baseCommit, '-m', 'invalid .git path'])
  await git(sender, ['update-ref', inputRef(commit), commit])
  const bundle = join(f.root, 'malicious.bundle'); await git(sender, ['bundle', 'create', bundle, inputRef(commit), `^${f.request.baseCommit}`]); const bytes = await readFile(bundle)
  await f.service.bindRepository(f.request.repoId, f.repo); f.source(bytes)
  await expect(f.service.run({ ...f.request, baseCommit: commit, inputBundle: { stream: newId('stream'), event: newId('event'), blob: `blb_${hash(bytes)}` } }, f.context, f.execution)).rejects.toMatchObject({ code: 'bad_request' })
  expect(f.effects()).toBe(0); await expect(git(f.repo, ['rev-parse', '--verify', `${commit}^{commit}`])).rejects.toThrow()
})

it('fails expired admission without effects and enforces elapsed deadline during a running model', async () => {
  const clock = new FakeClock(Date.now())
  let started!: () => void
  const running = new Promise<void>(resolve => { started = resolve })
  const f = await fixture(async request => {
    expect(request.limits.maxElapsedMs).toBe(700)
    started()
    return new Promise(() => undefined)
  }, clock)
  await f.service.bindRepository(f.request.repoId, f.repo)
  await expect(f.service.run(f.request, { ...f.context, deadlineAt: clock.now() - 1 }, f.execution))
    .rejects.toMatchObject({ code: 'deadline_exceeded' })
  expect(f.effects()).toBe(0)

  const execution = newId('execution'), context = { ...f.context, id: newId('rpc') }
  const pending = f.service.run({ ...f.request, limits: { ...f.request.limits, maxElapsedMs: 700 } }, context, execution)
  const outcome = pending.catch(error => error)
  await running
  expect(f.effects()).toBe(1)
  clock.advance(700)
  expect(await outcome).toMatchObject({ code: 'outcome_uncertain' })
  expect(f.service.query(execution, context)).toMatchObject({ state: 'uncertain', error: 'deadline_exceeded' })
})

it('fetches a missing base only through an explicitly enabled owner-selected remote', async () => {
  let expected = ''
  const f = await fixture(async request => {
    expect(await git(request.worktreePath, ['rev-parse', 'HEAD'])).toBe(expected)
    return { runId: request.executionId, profileId: 'test', threadId: request.threadId, definitionId: definition.definitionId, definitionRevision: definition.revision, runtimeKind: 'mousse', status: 'completed', text: 'fetched', history: [], usage: { elapsedMs: 1 } }
  }), sender = join(f.root, 'fetch-source')
  await git(f.root, ['clone', f.repo, sender]); await writeFile(join(sender, 'new-base.txt'), 'new'); await git(sender, ['add', '.']); await git(sender, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'new base'])
  expected = await git(sender, ['rev-parse', 'HEAD'])
  await git(f.repo, ['remote', 'set-url', 'origin', `file://${sender}`]); f.request.repoId = (await portableRepository(f.repo)).repoId; f.request.baseCommit = expected; f.request.fetch = true
  await f.service.bindRepository(f.request.repoId, f.repo)
  await expect(f.service.run(f.request, f.context, f.execution)).rejects.toMatchObject({ code: 'bad_request' }); expect(f.effects()).toBe(0)
  await f.service.bindRepository(f.request.repoId, f.repo, { allowFetch: true, remote: 'origin' })
  const execution = newId('execution'); await f.service.run(f.request, f.context, execution)
  f.db.transaction(() => f.callbacks.forEach(work => work())); await f.service.drainCleanup()
  expect(f.service.query(execution, f.context)).toMatchObject({ state: 'completed', phase: 'complete' }); expect(f.effects()).toBe(1)
  expect((await git(sender, ['for-each-ref', '--format=%(refname)', 'refs/heads/mousse/dispatch/']))).toBe('')
})

it('persists cleanup refusal for a dirty owned worktree and retries cleanup without rerunning', async () => {
  const f = await fixture(); await f.service.bindRepository(f.request.repoId, f.repo)
  await f.service.run(f.request, f.context, f.execution)
  const worktree = f.service.query(f.execution, f.context)!.worktree!
  const extra = join(worktree.path, 'owner-extra.txt'); await writeFile(extra, 'retain this owner edit')
  f.commit(); await f.service.drainCleanup()
  expect(f.service.query(f.execution, f.context)).toMatchObject({ state: 'completed', phase: 'cleanup', cleanupError: 'worktree_cleanup_failed' })
  expect(await readFile(extra, 'utf8')).toBe('retain this owner edit')
  await rm(extra); await f.service.recover()
  expect(f.service.query(f.execution, f.context)).toMatchObject({ state: 'completed', phase: 'complete' }); expect(f.effects()).toBe(1)
})

it('disables installed checkout hooks through the actual Dispatch WorktreeManager seam', async () => {
  const f = await fixture(); await f.service.bindRepository(f.request.repoId, f.repo)
  const hooks = join(f.repo, '.git', 'hooks'); await mkdir(hooks, { recursive: true })
  const marker = join(f.root, 'hook-executed'), hook = join(hooks, 'post-checkout')
  await writeFile(hook, `#!/bin/sh\nprintf executed > '${marker}'\n`, { mode: 0o700 })
  await f.service.run(f.request, f.context, f.execution); f.commit(); await f.service.drainCleanup()
  await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' }); expect(f.effects()).toBe(1)
})

it('refuses configured clean filters before model effects or staging executes the external program', async () => {
  const f = await fixture(); await f.service.bindRepository(f.request.repoId, f.repo)
  const marker = join(f.root, 'clean-executed')
  await git(f.repo, ['config', 'filter.probe.clean', `sh -c "printf executed > '${marker}'; cat"`])
  await expect(f.service.run(f.request, f.context, f.execution)).rejects.toMatchObject({ code: 'profile_unsupported' })
  await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' }); expect(f.effects()).toBe(0)
})

it('cancels a running model without replay or unsafe cleanup', async () => {
  const f = await fixture(async request => { await writeFile(join(request.worktreePath, 'partial.txt'), 'effect'); return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(new NetError('cancelled')), { once: true })) })
  await f.service.bindRepository(f.request.repoId, f.repo)
  const pending = f.service.run(f.request, f.context, f.execution)
  for (let count = 0; count < 200 && f.effects() === 0; count++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(f.effects()).toBe(1); f.service.cancel(f.execution, f.context)
  await expect(pending).rejects.toMatchObject({ code: 'outcome_uncertain' })
  const record = f.service.query(f.execution, f.context)!; expect(record.state).toBe('uncertain')
  expect(await readFile(join(record.worktree!.path, 'partial.txt'), 'utf8')).toBe('effect')
  await f.service.recover(); await expect(f.service.run(f.request, f.context, f.execution)).rejects.toMatchObject({ code: 'outcome_uncertain' }); expect(f.effects()).toBe(1)
  await expect(f.service.run({ ...f.request, prompt: 'different' }, f.context, f.execution)).rejects.toMatchObject({ code: 'conflict' })
})

it.each(['preparing', 'running'] as const)('recovers an actual SIGKILL during %s without repeating provider effects', async phase => {
  const f = await fixture(); await f.service.bindRepository(f.request.repoId, f.repo)
  const worker = join(f.root, 'worker.mjs')
  await symlink(await realpath('node_modules'), join(f.root, 'node_modules'))
  await build({ entryPoints: ['tests/net/bridge/dispatch/crash-worker.ts'], outfile: worker, bundle: true, packages: 'external', platform: 'node', format: 'esm', plugins: [{ name: 'omit-unused-provider-bootstrap', setup: builder => {
    // ThreadDataStore imports the real snapshot parser; its unused model runner is not part of this crash worker.
    builder.onResolve({ filter: /orchestrator\/LlmClient$/ }, args => ({ path: resolve(args.resolveDir, `${args.path}.ts`), sideEffects: false }))
  } }], banner: { js: "import { createRequire as dispatchTestRequire } from 'node:module'; const require = dispatchTestRequire(import.meta.url); const __dirname = process.cwd();" }, logLevel: 'silent' })
  const child = fork(worker, [JSON.stringify({ profile: f.profile, home: f.home, request: f.request, execution: f.execution, rpc: f.context.id, phase })], { execPath: process.execPath, env: { ...process.env, NODE_PATH: await realpath('node_modules') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''; child.stderr?.on('data', chunk => { stderr += String(chunk).slice(0, 1000) })
  try {
    const ready = await Promise.race([once(child, 'message').then(([message]) => message), once(child, 'exit').then(() => { throw new Error(`Child exited: ${stderr}`) }), new Promise((_, reject) => setTimeout(() => reject(new Error('Child fixture did not reach durable phase')), 10_000))])
    expect(ready).toEqual({ ready: true })
    const exited = once(child, 'exit'); child.kill('SIGKILL'); expect((await exited)[1]).toBe('SIGKILL')
    const before = f.service.query(f.execution, f.context)!
    expect(before.phase).toBe(phase)
    await f.service.recover()
    const after = f.service.query(f.execution, f.context)!
    expect(after.state).toBe(phase === 'preparing' ? 'failed' : 'uncertain')
    if (phase === 'running') expect(await readFile(join(after.worktree!.path, 'crash-effect.txt'), 'utf8')).toBe('committed model effect before SIGKILL')
    await expect(f.service.run(f.request, f.context, f.execution)).rejects.toMatchObject({ code: phase === 'preparing' ? 'cancelled' : 'outcome_uncertain' })
    expect(f.effects()).toBe(0)
  } finally { child.kill('SIGKILL') }
}, 20_000)
