/**
 * Receipt release discovers ownership before it takes the repository lease, then holds the lease only for short
 * batches: each re-reads what it must under the lease, checks every claim from the records with nothing awaited until
 * its one Git transaction starts, and lets go when a turn wants the repository. These cases pin what that must keep:
 * - a turn that asks for the repository during a long release gets it between batches;
 * - a claim written by another thread after discovery (a fork copying the receipt) still keeps the ref;
 * - a thread registered after discovery makes the release discover again, not decide on a stand-in;
 * - a peer checkout changed after discovery so Git no longer opens it as laid out (`core.worktree`) is read again at
 *   the final check, from scratch, and keeps the refs;
 * - a stop between the recorded intent and the delete leaves the refs, and the next run finishes the release.
 */
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { buildSync } from 'esbuild'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { ResourceLifecycleCoordinator } from '../src/mms/lifecycle/ResourceLifecycleCoordinator'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { ChangeReceiptService } from '../src/mms/actions/ChangeReceiptService'
import { UndoService } from '../src/mms/actions/UndoService'
import { UndoRetentionSweeper } from '../src/mms/actions/UndoRetentionSweeper'
import { UndoRetentionService } from '../src/mms/actions/UndoRetentionService'
import { RELEASE_BATCH_SIZE, ReceiptRefReleaseService } from '../src/mms/actions/ReceiptRefReleaseService'
import { acquireRepositoryLease, getRepositoryLeasePath, repositoryLeaseWanted } from '../src/mms/git/RepositoryLease'
import { resolveRepositoryIdentity } from '../src/mms/git/RepositoryIdentity'
import { discoverOwnershipFacts } from '../src/mms/lifecycle/ownershipDiscovery'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { actionOptions, CRASH_CHILD_REQUIRE, git, gitFoundationFixture } from './fixtures/gitFoundation'
import { unverifiableThread } from './support/unverifiableThread'
import { ProfileManager } from '../src/mms/profiles/ProfileManager'
import { createInstallationPaths } from '../src/mms/profiles/paths'
import { seedLegacyNamedEpisode } from './fixtures/legacy-named-agent'
import * as inventory from '../src/mms/lifecycle/ResourceInventory'
import * as reservations from '../src/mms/actions/undoRefClaims'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'

// Each case makes several checkpoints, each a few Git processes; process starts are slow on Windows.
vi.setConfig({ testTimeout: 180_000 })

let f: ReturnType<typeof gitFoundationFixture>
beforeEach(() => { f = gitFoundationFixture() })
afterEach(() => { vi.restoreAllMocks(); f.dispose() })

async function fixture(receipts = 1) {
  writeFileSync(join(f.thread, 'meta.json'), JSON.stringify({ id: 'task' }))
  const store = new ResourceLifecycleStore({ profileId: 'default', profileHome: f.home, allowedTaskRoots: [f.root] })
  store.registerTask({ taskId: 'task', location: f.thread })
  const workspace = await new ThreadWorkspaceManager(f.thread).provision('task', 'main', f.repo)
  for (let i = 0; i < receipts; i++) {
    await new ThreadActionService(f.thread).runCheckpointedAction(actionOptions(workspace.worktreePath, `turn-${i}`), () => writeFileSync(join(workspace.worktreePath, 'value.txt'), `change ${i}\n`))
  }
  let now = Date.now()
  const retention = new UndoRetentionService(f.thread, () => now)
  await retention.configure(workspace.worktreePath, { windowMs: 1000, migrationGraceMs: 1000, maxForwardStepMs: 60 * 60_000 }, true)
  now += 10000
  await retention.sweep(workspace.worktreePath)
  return { store, workspace, receipts: new ChangeReceiptService(f.thread).list(),
    release: new ReceiptRefReleaseService(store, 'task', () => now), advance: (ms: number) => { now += ms; return now } }
}

const refExists = (ref: string): boolean => git(f.repo, 'for-each-ref', '--format=%(refname)', ref) === ref

it('a turn that asks for the repository during a long release gets it between batches', async () => {
  const { workspace, receipts, release, advance } = await fixture()
  // The other receipts use the same real snapshot. Seed their independent refs and expired journal entries together
  // so the test exercises batching without taking eleven copies of identical worktree files.
  const additional = Array.from({ length: RELEASE_BATCH_SIZE }, () => {
    const id = randomUUID()
    return { ...receipts[0]!, id, operationId: id, retainedRefs: [`refs/mousse/changes/${id}/before`, `refs/mousse/changes/${id}/after`] }
  })
  const transaction = additional.flatMap((receipt) => [
    `create ${receipt.retainedRefs[0]} ${receipt.beforeSha}`,
    `create ${receipt.retainedRefs[1]} ${receipt.afterSha}`
  ]).join('\n') + '\n'
  execFileSync('git', ['update-ref', '--stdin'], { cwd: f.repo, input: transaction })
  const journal = new ThreadJournal(f.thread)
  for (const receipt of additional) journal.append({ operationId: receipt.operationId, operationType: 'change-checkpoint', state: 'completed', details: { receipt } })
  journal.append({ operationId: randomUUID(), operationType: 'undo-retention', state: 'completed', details: {
    version: 1, kind: 'expire', at: advance(0), ids: additional.map((receipt) => receipt.id)
  } })
  // A turn of another thread asks for the repository lease while the first batch holds it.
  const identity = resolveRepositoryIdentity(f.repo)
  const order: string[] = []
  let turn: Promise<void> | undefined
  const result = await release.release(workspace.worktreePath, {
    afterCheck: () => {
      order.push('batch')
      turn ??= acquireRepositoryLease(identity).then((lease) => { order.push('turn'); lease.release() })
    }
  })
  await turn
  expect(result.retained).toEqual([])
  expect(result.releasedRefs).toHaveLength((receipts.length + additional.length) * 2)
  // The turn ran after the first batch and before the second, not after the whole release.
  expect(order).toEqual(['batch', 'turn', 'batch'])
})

it('a claim another thread writes after discovery still keeps the ref', async () => {
  const { store, workspace, receipts, release } = await fixture()
  const receipt = receipts[0]!
  const discovery = await discoverOwnershipFacts(store)
  // A copied thread registers its existing Undo history after ownership was discovered.
  const fork = join(f.root, 'fork')
  mkdirSync(join(fork, 'journal'), { recursive: true })
  writeFileSync(join(fork, 'meta.json'), JSON.stringify({ id: 'fork' }))
  writeFileSync(join(fork, 'workspace.json'), JSON.stringify({ ...workspace, threadId: 'fork' }))
  new ThreadJournal(fork).append({ operationId: 'copied', operationType: 'change-checkpoint', state: 'completed', details: { receipt } })
  store.registerTask({ taskId: 'fork', location: fork })
  const result = await release.release(workspace.worktreePath, { discovery })
  expect(result.releasedRefs).toEqual([])
  expect(result.retained).toEqual([{ receiptId: receipt.id, reason: expect.stringContaining('another task or profile') }])
  for (const ref of receipt.retainedRefs) expect(refExists(ref)).toBe(true)
})

it('a legacy thread copied into a known project after discovery prevents release', async () => {
  const { store, workspace, receipts, release } = await fixture()
  writeFileSync(join(f.home, 'projects.json'), JSON.stringify([{ path: f.repo }]))
  const discovery = await discoverOwnershipFacts(store)
  const identity = resolveRepositoryIdentity(f.repo)
  const held = await acquireRepositoryLease(identity)
  const running = release.release(workspace.worktreePath, { discovery })
  const copy = join(f.repo, '.mousse', '.data', 'legacy-copy')
  try {
    while (!repositoryLeaseWanted(identity.key)) await new Promise((done) => setImmediate(done))
    mkdirSync(copy, { recursive: true })
    writeFileSync(join(copy, 'meta.json'), '{"id":"legacy-copy"}')
    new ThreadJournal(copy).append({ operationId: 'copied', operationType: 'change-checkpoint', state: 'completed', details: { receipt: receipts[0] } })
  } finally { held.release() }
  await expect(running).rejects.toThrow('thread data it does not keep track of')
  expect(receipts[0]!.retainedRefs.every(refExists)).toBe(true)
})

it('a restore keeps its Undo claims at the trash location until it can take the repository lease', async () => {
  const { store, workspace, receipts } = await fixture()
  const location = join(f.home, 'thread-data', 'standalone', 'restored')
  mkdirSync(location, { recursive: true })
  writeFileSync(join(location, 'meta.json'), '{"id":"restored"}')
  writeFileSync(join(location, 'workspace.json'), JSON.stringify({ ...workspace, threadId: 'restored' }))
  registerThreadLifecycleGate(f.home, store)
  store.registerTask({ taskId: 'restored', location })
  new ThreadJournal(location).append({ operationId: 'copied', operationType: 'change-checkpoint', state: 'completed', details: { receipt: receipts[0] } })
  let reachedMove!: () => void
  const moves = new Promise<void>((done) => { reachedMove = done })
  const coordinator = new ResourceLifecycleCoordinator(store, {
    drain: async () => undefined,
    settleMutationOwnership: async () => undefined,
    projectIndex: () => undefined,
    onPhase: (record, phase) => { if (record.state === 'restore-moving' && phase === 'move-prepared') reachedMove() }
  })
  const trashed = await coordinator.trash({ taskId: 'restored', operationId: 'trash', keepWork: true })
  const identity = resolveRepositoryIdentity(f.repo)
  const held = await acquireRepositoryLease(identity)
  const restoring = coordinator.restore({ taskId: 'restored', operationId: 'restore' })
  try {
    await Promise.race([moves, restoring])
    let finished = false
    void restoring.then(() => { finished = true }, () => { finished = true })
    while (!finished && !repositoryLeaseWanted(identity.key)) await new Promise((done) => setImmediate(done))
    expect(store.require('restored').location).toBe(trashed.location)
    expect(repositoryLeaseWanted(identity.key)).toBe(true)
  } finally { held.release() }
  await expect(restoring).resolves.toMatchObject({ location, state: 'active' })
  expect(receipts[0]!.retainedRefs.every(refExists)).toBe(true)
})

it('a stuck ref leaves its receipt pending while other receipts finish in separate lease holds', async () => {
  const { workspace, receipts, release, advance } = await fixture(2)
  const [stuck, other] = receipts
  const identity = resolveRepositoryIdentity(f.repo)
  const lock = join(identity.commonDir, `${stuck!.retainedRefs[0]}.lock`)
  mkdirSync(dirname(lock), { recursive: true })
  writeFileSync(lock, '')
  const leases: string[] = []
  const result = await release.release(workspace.worktreePath, { afterCheck: () => {
    leases.push(JSON.parse(readFileSync(getRepositoryLeasePath(identity), 'utf8')).token)
  } })
  expect(new Set(leases).size).toBe(3)
  expect(result.releasedRefs).toEqual(other!.retainedRefs)
  expect(result.retained).toEqual([{ receiptId: stuck!.id, reason: expect.stringContaining('.lock') }])
  expect(stuck!.retainedRefs.every(refExists)).toBe(true)
  expect(other!.retainedRefs.some(refExists)).toBe(false)
  expect(result.oldestPendingReleaseAgeMs).toBeTypeOf('number')

  unlinkSync(lock)
  advance(5 * 60_000)
  const backingOff = await release.release(workspace.worktreePath)
  expect(backingOff.releasedRefs).toEqual([])
  expect(backingOff.oldestPendingReleaseAgeMs).toBe(result.oldestPendingReleaseAgeMs! + 5 * 60_000)
  advance(6 * 60_000)
  const recovered = await release.release(workspace.worktreePath)
  expect(recovered.releasedRefs).toEqual(stuck!.retainedRefs)
  expect(recovered.oldestPendingReleaseAgeMs).toBeNull()
})

it('a copied thread in another profile cannot publish the same-OID claim during release or after the releaser dies', async () => {
  const { workspace, receipts, release, advance } = await fixture()
  const receipt = receipts[0]!
  const profiles = ProfileManager.open(createInstallationPaths(f.home))
  const profile = profiles.initializeFresh({ displayName: 'Peer', slug: 'peer' })
  const profileHome = profiles.getPaths(profile.id).root
  const peer = new ResourceLifecycleStore({ profileId: profile.id, profileHome })
  // Stage the imported bytes outside the scanned thread roots. The new owner becomes visible at registration.
  const incoming = join(profileHome, 'incoming')
  const copy = join(incoming, 'copy')
  const copyStore = new ResourceLifecycleStore({ profileId: profile.id, profileHome, allowedTaskRoots: [incoming] })
  mkdirSync(copy, { recursive: true })
  writeFileSync(join(copy, 'meta.json'), '{"id":"copy"}')
  writeFileSync(join(copy, 'workspace.json'), JSON.stringify(workspace))
  new ThreadJournal(copy).append({ operationId: 'copied', operationType: 'change-checkpoint', state: 'completed', details: { receipt } })

  const bundle = join(f.root, 'release-child.mjs')
  buildSync({ stdin: { resolveDir: resolve('.'), loader: 'ts', contents: `
    import { writeSync } from 'node:fs'
    import { ReceiptRefReleaseService } from './src/mms/actions/ReceiptRefReleaseService'
    import { ResourceLifecycleStore } from './src/mms/lifecycle/ResourceLifecycleStore'
    const [home, root, checkout, now] = process.argv.slice(2)
    const store = new ResourceLifecycleStore({ profileId: 'default', profileHome: home, allowedTaskRoots: [root] })
    await new ReceiptRefReleaseService(store, 'task', () => Number(now)).release(checkout, { afterPrepared() {
      writeSync(1, 'prepared\\n')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
    } })
  ` }, bundle: true, platform: 'node', format: 'esm', outfile: bundle, banner: { js: CRASH_CHILD_REQUIRE } })
  const child = spawn(process.execPath, [bundle, f.home, f.root, workspace.worktreePath, String(advance(0))], { stdio: ['ignore', 'pipe', 'inherit'] })
  const exited = once(child, 'exit')
  try {
    const prepared = once(child.stdout, 'data').then(([chunk]) => String(chunk).trim())
    expect(await Promise.race([prepared, exited.then(([code]) => `child exited with ${code}`)])).toBe('prepared')
    expect(() => copyStore.registerTask({ taskId: 'copy', location: copy })).toThrow(/lease is busy/i)
    expect(receipt.retainedRefs.every(refExists)).toBe(true)
  } finally { child.kill('SIGKILL'); await exited }

  expect(() => copyStore.registerTask({ taskId: 'copy', location: copy })).toThrow('pending release')
  expect(peer.get('copy')).toBeUndefined()
  const fork = join(f.root, 'fork-workspace')
  mkdirSync(fork)
  await expect(new ThreadWorkspaceManager(fork).provision('fork', 'main', f.repo, undefined, undefined, undefined, {
    snapshot: receipt.afterSha, snapshotReceiptId: receipt.id
  })).rejects.toThrow('pending release')
  const recovered = await release.release(workspace.worktreePath)
  expect(recovered.releasedRefs).toEqual(receipt.retainedRefs)
  expect(receipt.retainedRefs.some(refExists)).toBe(false)
  expect(() => copyStore.registerTask({ taskId: 'copy', location: copy })).toThrow('unavailable Undo reference')
})

it('a thread registered while the release waits for the lease makes it discover again before deciding', async () => {
  const { store, workspace, receipts, release } = await fixture()
  const receipt = receipts[0]!
  // The release discovers, then waits for the lease while a new thread with a worktree in this repository appears.
  const identity = resolveRepositoryIdentity(f.repo)
  const held = await acquireRepositoryLease(identity)
  const running = release.release(workspace.worktreePath)
  while (!repositoryLeaseWanted(identity.key)) await new Promise((resolve) => setImmediate(resolve))
  const broken = unverifiableThread(store, { id: 'late', name: 'Fix prices', repo: f.repo, how: 'unlinked' })
  held.release()
  const result = await running
  // Discovered again, the new thread's worktree is read: it can't be verified, so it holds this repository's refs.
  expect(result.releasedRefs).toEqual([])
  expect(result.retained).toEqual([{ receiptId: receipt.id, reason: expect.stringContaining(broken.worktree) }])
  for (const ref of receipt.retainedRefs) expect(refExists(ref)).toBe(true)
})

it('a stop between the recorded intent and the delete keeps the refs, and the next run finishes the release', async () => {
  const { workspace, receipts, release } = await fixture(2)
  const stopped = await release.release(workspace.worktreePath, { afterPrepared: () => { throw new Error('stopped') } })
  expect(stopped.releasedRefs).toEqual([])
  expect(stopped.retained.map((item) => item.reason)).toEqual(['stopped', 'stopped'])
  for (const receipt of receipts) for (const ref of receipt.retainedRefs) expect(refExists(ref)).toBe(true)
  const prepared = [...new ThreadJournal(f.thread).latestByOperation().values()].filter((entry) => entry.operationType === 'undo-ref-release')
  expect(prepared.map((entry) => entry.state)).toEqual(['prepared', 'prepared'])
  const finished = await release.release(workspace.worktreePath)
  expect(finished.retained).toEqual([])
  expect(finished.releasedRefs.sort()).toEqual(receipts.flatMap((receipt) => receipt.retainedRefs).sort())
  for (const receipt of receipts) for (const ref of receipt.retainedRefs) expect(refExists(ref)).toBe(false)
  expect((await release.release(workspace.worktreePath)).releasedRefs).toEqual([])
})

it('a peer checkout that Git stops verifying after discovery is read again at the final check and keeps the refs', async () => {
  const { store, workspace, receipts, release } = await fixture()
  const receipt = receipts[0]!
  // A peer thread in the same repository, verified when ownership is discovered.
  const peer = unverifiableThread(store, { id: 'peer', name: 'Fix prices', repo: f.repo, how: 'intact' })
  const discovery = await discoverOwnershipFacts(store)
  // Then its own config moves its top level elsewhere: Git no longer opens it as the registered worktree.
  git(f.repo, 'config', 'extensions.worktreeConfig', 'true')
  mkdirSync(join(f.root, 'elsewhere'))
  const gitDir = readFileSync(join(peer.worktree, '.git'), 'utf8').trim().slice('gitdir: '.length)
  writeFileSync(join(gitDir, 'config.worktree'), `[core]\n\tworktree = ${join(f.root, 'elsewhere').replace(/\\/g, '/')}\n`)
  const result = await release.release(workspace.worktreePath, { discovery })
  expect(result.releasedRefs).toEqual([])
  expect(result.retained).toEqual([{ receiptId: receipt.id, reason: expect.stringContaining(peer.worktree) }])
  for (const ref of receipt.retainedRefs) expect(refExists(ref)).toBe(true)
})

it('keeps the refs when a previously verified peer now points at this repository without registration', async () => {
  const { store, workspace, receipts, release } = await fixture()
  const peer = unverifiableThread(store, { id: 'moved-peer', name: 'Moved peer', repo: join(f.root, 'different-repo'), how: 'intact' })
  const discovery = await discoverOwnershipFacts(store)
  const target = resolveRepositoryIdentity(f.repo)
  unlinkSync(join(peer.worktree, '.git'))
  writeFileSync(join(peer.worktree, '.git'), 'gitdir: ' + join(target.commonDir, 'worktrees', 'not-registered') + '\n')
  expect(git(f.repo, 'worktree', 'list', '--porcelain')).not.toContain('moved-peer')
  const result = await release.release(workspace.worktreePath, { discovery })
  expect(result.retained[0]).toMatchObject({ receiptId: receipts[0]!.id, reason: expect.stringContaining('Moved peer') })
  expect(receipts[0]!.retainedRefs.every(refExists)).toBe(true)
})

it('defers copy and restore while the repository of a live Undo claim is unavailable', async () => {
  const { store, workspace, receipts } = await fixture()
  const location = join(f.home, 'thread-data', 'standalone', 'restored')
  const staged = join(f.root, 'staged-restore')
  mkdirSync(staged)
  mkdirSync(dirname(location), { recursive: true })
  writeFileSync(join(staged, 'meta.json'), '{"id":"restored"}')
  const saveWorkspace = (dir: string, available: boolean) => writeFileSync(join(dir, 'workspace.json'), JSON.stringify({
    ...workspace, threadId: 'restored',
    worktreePath: available ? workspace.worktreePath : join(f.root, 'unavailable-worktree'),
    integrationTarget: { ...workspace.integrationTarget, checkoutPath: available ? f.repo : join(f.root, 'unavailable-primary') }
  }))
  const receipt = receipts[0]!
  saveWorkspace(staged, false)
  new ThreadJournal(staged).append({ operationId: 'copied', operationType: 'change-checkpoint', state: 'completed', details: { receipt } })
  renameSync(staged, location)
  expect(() => store.registerTask({ taskId: 'restored', location })).toThrow(/repository of the copied Undo history/)
  expect(store.get('restored')).toBeUndefined()
  saveWorkspace(location, true)
  store.registerTask({ taskId: 'restored', location })
  registerThreadLifecycleGate(f.home, store)
  const coordinator = new ResourceLifecycleCoordinator(store, {
    drain: async () => undefined, settleMutationOwnership: async () => undefined, projectIndex: () => undefined
  })
  const trashed = await coordinator.trash({ taskId: 'restored', operationId: 'trash', keepWork: true })
  saveWorkspace(trashed.location, false)
  await expect(coordinator.restore({ taskId: 'restored', operationId: 'restore' })).rejects.toThrow(/repository of the restored Undo history/)
  expect(store.require('restored').location).toBe(trashed.location)
  expect(existsSync(location)).toBe(false)
  expect(receipt.retainedRefs.every(refExists)).toBe(true)
})

it('a copied expired receipt still takes the lease when a named agent can recall it', async () => {
  const { store, workspace, receipts, release } = await fixture()
  const location = join(f.home, 'thread-data', 'standalone', 'recall-copy')
  const staged = join(f.root, 'staged-recall')
  mkdirSync(staged)
  mkdirSync(dirname(location), { recursive: true })
  writeFileSync(join(staged, 'meta.json'), '{"id":"recall-copy"}')
  writeFileSync(join(staged, 'workspace.json'), JSON.stringify({ ...workspace, threadId: 'recall-copy' }))
  const receipt = receipts[0]!
  const journal = new ThreadJournal(staged)
  journal.append({ operationId: 'copied', operationType: 'change-checkpoint', state: 'completed', details: { receipt } })
  for (const entry of new ThreadJournal(f.thread).ofTypes('undo-retention')) {
    journal.append({ operationId: entry.operationId, operationType: entry.operationType, state: entry.state, details: entry.details })
  }
  seedLegacyNamedEpisode(staged, { name: 'Reviewer', episodeId: 'review-episode', worktreePath: workspace.worktreePath, receiptId: receipt.id, resultSha: receipt.afterSha })
  renameSync(staged, location)
  const held = await acquireRepositoryLease(resolveRepositoryIdentity(f.repo))
  try {
    expect(() => store.registerTask({ taskId: 'recall-copy', location })).toThrow(/lease is busy/i)
    expect(store.get('recall-copy')).toBeUndefined()
  } finally { held.release() }
  store.registerTask({ taskId: 'recall-copy', location })
  expect((await release.release(workspace.worktreePath)).releasedRefs).toEqual([])
  expect(receipt.retainedRefs.every(refExists)).toBe(true)
})

it.each(['reserve', 'unlink'])('isolates a failed reservation %s from a sibling release', async (phase) => {
  const { workspace, receipts, release } = await fixture(2)
  const [stuck, sibling] = receipts
  const prepare = reservations.prepareUndoRefRelease
  const finish = reservations.finishUndoRefRelease
  if (phase === 'reserve') vi.spyOn(reservations, 'prepareUndoRefRelease').mockImplementation((repo, id, operation, retryAfter) => {
    if (id === stuck!.id) throw new Error('Simulated reservation write failure')
    return prepare(repo, id, operation, retryAfter)
  })
  else vi.spyOn(reservations, 'finishUndoRefRelease').mockImplementation((repo, id, operation) => {
    if (id === stuck!.id) throw new Error('Simulated reservation unlink failure')
    return finish(repo, id, operation)
  })
  const result = await release.release(workspace.worktreePath)
  expect(result.releasedRefs).toEqual(sibling!.retainedRefs)
  expect(result.retained[0]).toMatchObject({ receiptId: stuck!.id, reason: expect.stringMatching(/reservation (write|unlink) failure/) })
  expect(sibling!.retainedRefs.some(refExists)).toBe(false)
  expect(stuck!.retainedRefs.every(refExists)).toBe(phase === 'reserve')
  if (phase === 'unlink') expect(reservations.pendingUndoRefRelease(resolveRepositoryIdentity(f.repo), stuck!.id)).toBeDefined()
  vi.restoreAllMocks()
  expect((await release.release(workspace.worktreePath)).releasedRefs).toEqual(stuck!.retainedRefs)
})

it('checkpoints and undoes a new turn while a different receipt release is backed off', async () => {
  const { workspace, receipts, release } = await fixture()
  const stuck = receipts[0]!
  const identity = resolveRepositoryIdentity(f.repo)
  const lock = join(identity.commonDir, stuck.retainedRefs[0]! + '.lock')
  writeFileSync(lock, '')
  try {
    expect((await release.release(workspace.worktreePath)).releasedRefs).toEqual([])
    expect(reservations.pendingUndoRefRelease(identity, stuck.id)?.retryAfter).toBeTypeOf('number')
    await new UndoRetentionService(f.thread).configure(workspace.worktreePath, { windowMs: 60 * 60_000 }, true, true)
    const actions = new ThreadActionService(f.thread)
    await actions.runCheckpointedAction(actionOptions(workspace.worktreePath, 'new-turn'), () => {
      writeFileSync(join(workspace.worktreePath, 'value.txt'), 'new turn\n')
    })
    expect(f.read(workspace.worktreePath)).toBe('new turn\n')
    await new UndoService(f.thread).undoLatest('main', workspace.worktreePath)
    expect(f.read(workspace.worktreePath)).toBe('change 0\n')
    expect(stuck.retainedRefs.every(refExists)).toBe(true)
    expect(() => reservations.assertUndoRefMayBeClaimed(identity, stuck.id)).toThrow(/pending release/)
  } finally { unlinkSync(lock) }
})

it('releases the repository lease at its hold deadline even when ownership refresh stalls', async () => {
  const { store, workspace, receipts, advance } = await fixture()
  const discovery = await discoverOwnershipFacts(store)
  const identity = resolveRepositoryIdentity(f.repo)
  let refreshing = false
  vi.spyOn(inventory, 'rereadRepositoryFacts').mockImplementation(() => {
    refreshing = true
    return new Promise<void>(() => undefined)
  })
  const result = await new ReceiptRefReleaseService(store, 'task', () => advance(0), 12_000).release(workspace.worktreePath, { discovery })
  expect(refreshing).toBe(true)
  expect(result.retained[0]?.reason).toMatch(/lease deadline/)
  expect(result.releasedRefs).toEqual([])
  const lease = await acquireRepositoryLease(identity, { maxWaitMs: 1 })
  lease.release()
  expect(receipts[0]!.retainedRefs.every(refExists)).toBe(true)
})

it('reports the existing release backlog while the retention clock is suspended', async () => {
  const { store, workspace, receipts } = await fixture()
  const journal = new ThreadJournal(f.thread)
  const events = journal.ofTypes('undo-retention')
  const at = (events.at(-1)!.details as { at: number }).at
  journal.append({ operationId: randomUUID(), operationType: 'undo-retention', state: 'completed', details: { version: 1, kind: 'clock', at, suspended: true } })
  const sweeper = new UndoRetentionSweeper(store)
  await sweeper.tick()
  expect(sweeper.outcomes.get('task')).toMatchObject({ reason: 'Clock review required', releasedRefs: 0, oldestPendingReleaseAgeMs: expect.any(Number) })
  expect(receipts[0]!.retainedRefs.every(refExists)).toBe(true)
})
