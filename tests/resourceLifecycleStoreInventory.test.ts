import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { buildResourceInventory } from '../src/mms/lifecycle/ResourceInventory'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'
import { BrowserArtifactService } from '../src/mms/browser/BrowserArtifactService'

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
const json = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)) }
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'resource-inventory-')); homes.push(home)
  const store = new ResourceLifecycleStore({ profileId: '11111111-1111-4111-8111-111111111111', profileHome: home })
  registerThreadLifecycleGate(home, store)
  const location = join(home, 'thread-data', 'standalone', 'task')
  store.registerTask({ taskId: 'task', location, creating: true }); json(join(location, 'meta.json'), { id: 'task' })
  return { home, store, location, inventory: () => buildResourceInventory(store, store.require('task')) }
}

describe('source-derived lifecycle resource inventory', () => {
  it('includes actual browser artifact payload and worker-container associations without scanning cache data', async () => {
    const { home, inventory } = fixture()
    const service = new BrowserArtifactService({ profileId: '11111111-1111-4111-8111-111111111111', profileRoot: home, workerArtifactRoot: join(home, 'browser', 'worker-artifacts') })
    const artifact = await service.put({ profileId: '11111111-1111-4111-8111-111111111111', threadId: 'task', sessionId: 'session' }, { bytes: Buffer.from('image'), mediaType: 'image/png', displayName: 'image.png' }, 1024)
    json(join(home, 'browser', 'cache', 'unrelated.json'), { malformed: true })
    const result = inventory()
    expect(result.blockers).toEqual([])
    expect(result.resources.some((item) => item.kind === 'artifact' && item.identity === artifact.id && item.claims.some((claim) => claim.kind === 'conversation-attachment'))).toBe(true)
    expect(result.resources.some((item) => item.identity === join(home, 'artifacts', artifact.id))).toBe(true)
    expect(result.resources.some((item) => item.identity === join(home, 'browser', 'worker-artifacts', '11111111-1111-4111-8111-111111111111', 'session'))).toBe(true)
    expect(result.sources.some((item) => item.path.includes('cache'))).toBe(false)
    await service.dispose()
  })

  it('covers invocation ownership, run containers, request links and explicitly pinned snapshots', () => {
    const { home, store, inventory } = fixture()
    const child = join(home, 'thread-data', 'standalone', 'invocation')
    store.registerTask({ taskId: 'invocation', location: child, parentTaskId: 'task', creating: true }); json(join(child, 'meta.json'), { id: 'invocation' })
    const hash = 'a'.repeat(64), runId = '12345678-1234-1234-1234-123456789012'
    json(join(home, 'workflow-agent-bindings', 'invocations', 'call.json'), { version: 1, profileId: '11111111-1111-4111-8111-111111111111', parentThreadId: 'task', executionThreadId: 'invocation' })
    json(join(home, 'workflow-agent-bindings', 'admissions', 'request.json'), { version: 1, profileId: '11111111-1111-4111-8111-111111111111', threadId: 'task', pins: [{ snapshotHash: hash }] })
    json(join(home, 'workflow-agent-bindings', 'snapshots', `${hash}.json`), { version: 1, profileId: '11111111-1111-4111-8111-111111111111', snapshotHash: hash, snapshot: {} })
    json(join(home, 'workflow-admissions', 'request.json'), { version: 1, profileId: '11111111-1111-4111-8111-111111111111', request: { threadId: 'task', runId } })
    const run = join(home, 'workflow-runs', runId)
    json(join(run, 'manifest.json'), { version: 1, profileId: '11111111-1111-4111-8111-111111111111', threadId: 'task', runId })
    json(join(run, 'checkpoint.json'), { artifacts: [] })
    const result = inventory()
    expect(result.blockers).toEqual([])
    for (const expected of [child, join(run, 'staging'), join(run, 'scripts'), join(run, 'results'), join(home, 'workflow-agent-bindings', 'snapshots', `${hash}.json`), join(home, 'workflow-admissions', 'request.json')]) expect(result.resources.some((item) => item.identity === expected)).toBe(true)
    json(join(home, 'workflow-agent-bindings', 'invocations', 'call.json'), { version: 1, profileId: '11111111-1111-4111-8111-111111111111', parentThreadId: 'task', executionThreadId: 'unowned' })
    expect(inventory().blockers).toContain('Workflow execution thread lacks durable ownership edge: unowned')
  })

  it('verifies actual linked Git ownership and reports foreign paths or malformed agent entries', () => {
    const { home, location, inventory } = fixture()
    const repo = join(home, 'repo'), tree = join(home, 'owned-tree')
    mkdirSync(repo)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
    writeFileSync(join(repo, 'file.txt'), 'base'); git('add', '.'); git('commit', '-m', 'base')
    git('worktree', 'add', '-b', 'mousse/thread/task/main', tree)
    const repositoryId = createHash('sha256').update(realpathSync(resolve(repo, git('rev-parse', '--git-common-dir'))).toLowerCase()).digest('hex').slice(0, 32)
    json(join(location, 'workspace.json'), { schemaVersion: 1, threadId: 'task', repositoryId, worktreePath: tree, branch: 'mousse/thread/task/main' })
    const verified = inventory()
    expect(verified.blockers).toEqual([])
    expect(verified.resources.find((item) => item.identity === tree)?.ownership).toBe('verified')
    json(join(location, 'agents.json'), [null, { id: 'legacy', worktreePath: repo, branch: 'main' }])
    const ambiguous = inventory()
    expect(ambiguous.blockers.some((item) => item.includes('Unknown record'))).toBe(true)
    expect(ambiguous.resources.find((item) => item.identity === repo)?.ownership).toBe('unknown')
    expect(ambiguous.blockers.some((item) => item.includes('Unverified worktree'))).toBe(true)
  })
})
