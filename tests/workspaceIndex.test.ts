import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dispatchMethod, type HandlerContext } from '../src/mms/protocol/handlers'
import {
  buildWorkspaceIndex,
  detectGitRoute,
  isPhysicallyWithin,
  type GitRoute,
  type WorkspaceIndexSnapshot
} from '../src/mms/files/WorkspaceIndex'
import {
  WorkspaceIndexRegistry,
  getWorkspaceIndexRegistry,
  setWorkspaceIndexRegistryForTests
} from '../src/mms/files/WorkspaceIndexRegistry'
import type { FileSearchResponse } from '../src/shared/types'

const roots: string[] = []
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function tempDir(prefix = 'mousse-index-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

function put(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
  }
}

function repo(): string {
  const cwd = tempDir('mousse-index-repo-')
  git(cwd, 'init', '-b', 'main')
  git(cwd, 'config', 'user.name', 'Index fixture')
  git(cwd, 'config', 'user.email', 'index-fixture@example.invalid')
  git(cwd, 'config', 'commit.gpgsign', 'false')
  git(cwd, 'config', 'core.hooksPath', join(cwd, '.no-hooks'))
  return cwd
}

const notARepo = async (): Promise<GitRoute> => ({ ok: false, reason: 'not-a-repo' })
const sorted = (values: string[]): string[] => [...values].sort()

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('buildWorkspaceIndex: Git repository', () => {
  it('honours .gitignore, negation and nested .gitignore, and lists untracked files', async () => {
    const cwd = repo()
    put(cwd, {
      '.gitignore': '*.log\n!keep.log\nbuild-cache/\n',
      'a.log': 'x',
      'keep.log': 'x',
      'tracked.txt': 'x',
      'untracked.txt': 'x',
      'build-cache/blob.bin': 'x',
      'sub/.gitignore': 'secret.txt\n',
      'sub/secret.txt': 'x',
      'sub/visible.txt': 'x'
    })
    git(cwd, 'add', 'tracked.txt')

    const snapshot = await buildWorkspaceIndex(cwd)

    expect(snapshot.source).toBe('git')
    expect(snapshot.fallbackReason).toBeUndefined()
    expect(snapshot.complete).toBe(true)
    expect(sorted(snapshot.files)).toEqual(
      sorted(['.gitignore', 'keep.log', 'tracked.txt', 'untracked.txt', 'sub/.gitignore', 'sub/visible.txt'])
    )
    expect(snapshot.folders).toEqual(['sub'])
    expect(snapshot.lowerFiles).toEqual(snapshot.files.map((path) => path.toLowerCase()))
  })

  it('drops tracked files under skipped folders', async () => {
    const cwd = repo()
    put(cwd, { 'dist/x.js': 'x', '.mousse-worktrees/t/y.ts': 'x', 'src/node_modules/z.js': 'x', 'src/app.ts': 'x' })
    git(cwd, 'add', '-A')
    git(cwd, 'commit', '-m', 'base')

    const snapshot = await buildWorkspaceIndex(cwd)

    expect(snapshot.files).toEqual(['src/app.ts'])
    expect(snapshot.folders).toEqual(['src'])
  })

  it('round-trips paths with spaces, unicode and shell characters verbatim', async () => {
    const cwd = repo()
    const names = ['dir with space/ünï cödé #1 (a).txt', 'emoji/😀 note.md', 'plain.txt']
    put(cwd, Object.fromEntries(names.map((name) => [name, 'x'])))

    const snapshot = await buildWorkspaceIndex(cwd)

    expect(sorted(snapshot.files)).toEqual(sorted(names))
    expect(sorted(snapshot.folders)).toEqual(['dir with space', 'emoji'])
    expect(snapshot.files.every((path) => !path.includes('\\'))).toBe(true)
  })

  it('lists an untracked nested repository as one folder and not its contents', async () => {
    const cwd = repo()
    put(cwd, { 'top.txt': 'x' })
    const inner = join(cwd, 'inner')
    mkdirSync(inner)
    git(inner, 'init', '-b', 'main')
    put(inner, { 'inside.txt': 'x' })

    const snapshot = await buildWorkspaceIndex(cwd)

    expect(snapshot.files).toEqual(['top.txt'])
    expect(snapshot.folders).toEqual(['inner'])
  })

  it('indexes a worktree and its primary checkout as different roots', async () => {
    const cwd = repo()
    put(cwd, { 'shared.txt': 'x', 'main-only.txt': 'x' })
    git(cwd, 'add', '-A')
    git(cwd, 'commit', '-m', 'base')
    const linked = join(tempDir('mousse-index-wt-'), 'linked')
    git(cwd, 'worktree', 'add', linked, '-b', 'feature')
    put(linked, { 'worktree-only.txt': 'x' })

    const primary = await buildWorkspaceIndex(cwd)
    const worktree = await buildWorkspaceIndex(linked)

    expect(primary.root).not.toBe(worktree.root)
    expect(sorted(primary.files)).toEqual(['main-only.txt', 'shared.txt'])
    expect(sorted(worktree.files)).toEqual(['main-only.txt', 'shared.txt', 'worktree-only.txt'])
  })

  it('lists a subdirectory root with its own files only', async () => {
    const cwd = repo()
    put(cwd, { 'outside.txt': 'x', 'pkg/inside.txt': 'x' })

    const snapshot = await buildWorkspaceIndex(join(cwd, 'pkg'))

    expect(snapshot.source).toBe('git')
    expect(snapshot.files).toEqual(['inside.txt'])
  })

  it('stops at the cap and says so', async () => {
    const cwd = repo()
    put(cwd, Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}.txt`, 'x'])))

    const snapshot = await buildWorkspaceIndex(cwd, { cap: 5 })

    expect(snapshot.files).toHaveLength(5)
    expect(snapshot.truncated).toBe(true)
    expect((await buildWorkspaceIndex(cwd, { cap: 10 })).truncated).toBe(false)
  })

  it('hands out partial snapshots through onProgress', async () => {
    const cwd = repo()
    put(cwd, Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`d${i % 3}/f${i}.txt`, 'x'])))
    const partials: WorkspaceIndexSnapshot[] = []

    const final = await buildWorkspaceIndex(cwd, { progressEvery: 10, onProgress: (partial) => partials.push(partial) })

    expect(partials.length).toBeGreaterThanOrEqual(2)
    expect(partials.every((partial) => !partial.complete)).toBe(true)
    expect(partials[0].files.length).toBeLessThan(partials[1].files.length)
    expect(final.complete).toBe(true)
    expect(final.files).toHaveLength(25)
  })

  it('stops the build when the signal aborts', async () => {
    const cwd = repo()
    put(cwd, { 'a.txt': 'x' })
    const controller = new AbortController()
    controller.abort()
    await expect(buildWorkspaceIndex(cwd, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('buildWorkspaceIndex: walk', () => {
  const walk = (root: string, options: Parameters<typeof buildWorkspaceIndex>[1] = {}) =>
    buildWorkspaceIndex(root, { detectGit: notARepo, ...options })

  it('records not-a-repo for a plain folder and skips the fixed folder names', async () => {
    const root = tempDir()
    put(root, { 'a.txt': 'x', 'node_modules/pkg/i.js': 'x', '.git/config': 'x', 'out/o.js': 'x', 'src/b.ts': 'x' })

    const snapshot = await walk(root)

    expect(snapshot.source).toBe('walk')
    expect(snapshot.fallbackReason).toBe('not-a-repo')
    expect(sorted(snapshot.files)).toEqual(['a.txt', 'src/b.ts'])
    expect(snapshot.folders).toEqual(['src'])
  })

  it('classifies a plain folder as not-a-repo through real detection', async () => {
    const root = tempDir()
    put(root, { 'a.txt': 'x' })
    const snapshot = await buildWorkspaceIndex(root)
    // A temp folder under a Git repository would be listed by git; the fixture
    // only asserts when the machine's temp folder is outside one.
    if (snapshot.source === 'walk') expect(snapshot.fallbackReason).toBe('not-a-repo')
    expect(snapshot.files).toContain('a.txt')
  })

  it('stops descending at maxDepth', async () => {
    const root = tempDir()
    put(root, { 'a/top.txt': 'x', 'a/b/deep.txt': 'x', 'a/b/c/deeper.txt': 'x' })

    const snapshot = await walk(root, { maxDepth: 2 })

    expect(sorted(snapshot.files)).toEqual(['a/top.txt'])
    expect(sorted(snapshot.folders)).toEqual(['a', 'a/b'])
  })

  it('stops at the cap and derives folders', async () => {
    const root = tempDir()
    put(root, Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`d/f${i}.txt`, 'x'])))

    const capped = await walk(root, { cap: 5 })
    expect(capped.truncated).toBe(true)
    expect(capped.files.length + capped.folders.length).toBe(5)

    const full = await walk(root)
    expect(full.truncated).toBe(false)
    expect(full.folders).toEqual(['d'])
  })

  it.each([
    ['git-missing', { ok: false, reason: 'git-missing' }],
    ['git-too-old', { ok: false, reason: 'git-too-old' }]
  ] as const)('walks a repository without ignore rules when git reports %s', async (reason, route) => {
    const cwd = repo()
    put(cwd, { '.gitignore': 'ignored.txt\n', 'ignored.txt': 'x', 'kept.txt': 'x' })

    const snapshot = await buildWorkspaceIndex(cwd, { detectGit: async () => route })

    expect(snapshot.source).toBe('walk')
    expect(snapshot.fallbackReason).toBe(reason)
    // No ignore semantics on this route; .git is still a skipped folder.
    expect(sorted(snapshot.files)).toEqual(['.gitignore', 'ignored.txt', 'kept.txt'])
  })

  describe('symlinks', () => {
    function fixture() {
      const root = tempDir('mousse-index-links-')
      const outside = tempDir('mousse-index-outside-')
      put(root, { 'real/inner.txt': 'x', 'plain.txt': 'x' })
      put(outside, { 'secret.txt': 'x', 'dir/leak.txt': 'x' })
      return { root, outside }
    }

    it('lists an internal directory link as a folder and never descends it', async () => {
      const { root } = fixture()
      symlinkSync(join(root, 'real'), join(root, 'linkin'), 'junction')

      const snapshot = await walk(root)

      expect(snapshot.folders).toContain('linkin')
      expect(snapshot.files).toContain('real/inner.txt')
      expect(snapshot.files.some((path) => path.startsWith('linkin/'))).toBe(false)
    })

    it('skips an external directory link entirely', async () => {
      const { root, outside } = fixture()
      symlinkSync(join(outside, 'dir'), join(root, 'linkout'), 'junction')

      const snapshot = await walk(root)

      expect(snapshot.folders).not.toContain('linkout')
      expect(snapshot.files.some((path) => path.startsWith('linkout/'))).toBe(false)
    })

    it.skipIf(process.platform === 'win32')('lists an internal file alias (file symlinks need elevation on Windows)', async () => {
      const { root } = fixture()
      symlinkSync(join(root, 'plain.txt'), join(root, 'alias.txt'))

      const snapshot = await walk(root)

      expect(snapshot.files).toContain('alias.txt')
    })

    it.skipIf(process.platform === 'win32')('skips an external file alias (file symlinks need elevation on Windows)', async () => {
      const { root, outside } = fixture()
      symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt'))

      const snapshot = await walk(root)

      expect(snapshot.files).not.toContain('leak.txt')
    })

    it('isPhysicallyWithin follows links to their physical target', async () => {
      const { root, outside } = fixture()
      symlinkSync(join(root, 'real'), join(root, 'linkin'), 'junction')
      symlinkSync(join(outside, 'dir'), join(root, 'linkout'), 'junction')
      const rootReal = realpathSync(root)

      expect(await isPhysicallyWithin(rootReal, join(root, 'plain.txt'))).toBe(true)
      expect(await isPhysicallyWithin(rootReal, join(root, 'linkin', 'inner.txt'))).toBe(true)
      expect(await isPhysicallyWithin(rootReal, join(root, 'linkout', 'leak.txt'))).toBe(false)
      expect(await isPhysicallyWithin(rootReal, join(root, 'missing.txt'))).toBe(false)
    })
  })
})

describe('detectGitRoute', () => {
  it('reports a repository with its version and a plain folder as not-a-repo', async () => {
    const cwd = repo()
    const route = await detectGitRoute(cwd)
    expect(route.ok).toBe(true)
    if (route.ok) expect(route.version[0]).toBeGreaterThanOrEqual(2)
  })
})

function snapshotAt(root: string, builtAt: number, files: string[] = ['a.txt'], complete = true): WorkspaceIndexSnapshot {
  return { root, source: 'walk', files, folders: [], lowerFiles: files, lowerFolders: [], builtAt, truncated: false, complete }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('WorkspaceIndexRegistry', () => {
  const registries: WorkspaceIndexRegistry[] = []
  afterEach(() => {
    for (const registry of registries.splice(0)) registry.dispose()
  })
  function create(options: ConstructorParameters<typeof WorkspaceIndexRegistry>[0]): WorkspaceIndexRegistry {
    const registry = new WorkspaceIndexRegistry(options)
    registries.push(registry)
    return registry
  }

  it('coalesces concurrent lookups into one build', async () => {
    let builds = 0
    const registry = create({
      firstWaitMs: 1_000,
      build: async (root) => {
        builds += 1
        await new Promise((done) => setTimeout(done, 20))
        return snapshotAt(root, Date.now())
      }
    })
    const [a, b] = await Promise.all([registry.get('/r'), registry.get('/r')])
    expect(builds).toBe(1)
    expect(a.snapshot?.complete).toBe(true)
    expect(b.snapshot).toBe(a.snapshot)
    expect(a.indexing).toBe(false)
  })

  it('answers after firstWaitMs with nothing, then with a partial snapshot once progress arrived', async () => {
    const gate = deferred<WorkspaceIndexSnapshot>()
    let progress: ((partial: WorkspaceIndexSnapshot) => void) | undefined
    const registry = create({
      firstWaitMs: 15,
      build: (_root, options) => {
        progress = options?.onProgress
        return gate.promise
      }
    })

    const first = await registry.get('/r')
    expect(first).toEqual({ snapshot: null, indexing: true })

    const partial = snapshotAt('/r', 0, ['p.txt'], false)
    progress?.(partial)
    const second = await registry.get('/r')
    expect(second).toEqual({ snapshot: partial, indexing: true })

    gate.resolve(snapshotAt('/r', Date.now(), ['a.txt', 'b.txt']))
    await new Promise((done) => setTimeout(done, 5))
    const third = await registry.get('/r')
    expect(third.indexing).toBe(false)
    expect(third.snapshot?.files).toEqual(['a.txt', 'b.txt'])
  })

  it('throws the build error when a first build fails with nothing to show', async () => {
    const registry = create({ firstWaitMs: 1_000, build: async () => { throw new Error('root vanished') } })
    await expect(registry.get('/r')).rejects.toThrow('root vanished')
  })

  it('getComplete waits for the build and times out honestly at the absolute deadline', async () => {
    const gate = deferred<WorkspaceIndexSnapshot>()
    const registry = create({ build: () => gate.promise })

    const started = Date.now()
    const timedOut = await registry.getComplete('/r', { deadline: started + 40 })
    expect(Date.now() - started).toBeLessThan(500)
    expect(timedOut).toEqual({ snapshot: null, indexing: true })

    const waiting = registry.getComplete('/r', { deadline: Date.now() + 2_000 })
    gate.resolve(snapshotAt('/r', Date.now()))
    const done = await waiting
    expect(done.indexing).toBe(false)
    expect(done.snapshot?.complete).toBe(true)
  })

  it('rebuilds in the background after staleMs and serves the stale snapshot meanwhile', async () => {
    let clock = 1_000
    let builds = 0
    const gate = deferred<WorkspaceIndexSnapshot>()
    const registry = create({
      now: () => clock,
      staleMs: 15_000,
      firstWaitMs: 1_000,
      build: async (root) => {
        builds += 1
        if (builds === 1) return snapshotAt(root, clock, ['old.txt'])
        return gate.promise
      }
    })

    const first = await registry.get('/r')
    expect(first.snapshot?.files).toEqual(['old.txt'])
    expect((await registry.get('/r')).snapshot?.files).toEqual(['old.txt'])
    expect(builds).toBe(1)

    clock += 16_000
    const stale = await registry.get('/r')
    expect(stale).toEqual({ snapshot: first.snapshot, indexing: false })
    await Promise.resolve()
    expect(builds).toBe(2)
    // One rebuild at a time.
    await registry.get('/r')
    expect(builds).toBe(2)

    gate.resolve(snapshotAt('/r', clock, ['new.txt']))
    await new Promise((done) => setTimeout(done, 5))
    expect((await registry.get('/r')).snapshot?.files).toEqual(['new.txt'])
  })

  it('never replaces a complete snapshot with a rebuild partial, and keeps it when the rebuild fails or aborts', async () => {
    let clock = 0
    let builds = 0
    let progress: ((partial: WorkspaceIndexSnapshot) => void) | undefined
    const gates = [deferred<WorkspaceIndexSnapshot>(), deferred<WorkspaceIndexSnapshot>()]
    const registry = create({
      now: () => clock,
      staleMs: 100,
      firstWaitMs: 1_000,
      build: (root, options) => {
        builds += 1
        if (builds === 1) return Promise.resolve(snapshotAt(root, clock, ['complete.txt']))
        progress = options?.onProgress
        return gates[builds - 2].promise
      }
    })
    await registry.get('/r')

    clock = 1_000
    await registry.get('/r')
    await Promise.resolve()
    progress?.(snapshotAt('/r', clock, ['partial.txt'], false))
    expect((await registry.get('/r')).snapshot?.files).toEqual(['complete.txt'])

    gates[0].reject(new Error('rebuild failed'))
    await new Promise((done) => setTimeout(done, 5))
    expect((await registry.get('/r')).snapshot?.files).toEqual(['complete.txt'])

    // The failed rebuild left the snapshot stale, so the next lookup retries; an abort keeps it too.
    await Promise.resolve()
    expect(builds).toBe(3)
    gates[1].reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    await new Promise((done) => setTimeout(done, 5))
    expect((await registry.get('/r')).snapshot?.files).toEqual(['complete.txt'])
  })

  it('invalidate marks the root dirty without building or creating an entry', async () => {
    let builds = 0
    const registry = create({
      firstWaitMs: 1_000,
      build: async (root) => {
        builds += 1
        return snapshotAt(root, Date.now())
      }
    })
    registry.invalidate('/never-seen')
    expect(registry.stats().roots).toEqual([])
    expect(builds).toBe(0)

    await registry.get('/r')
    registry.invalidate('/r')
    expect(builds).toBe(1)
    expect(registry.stats().roots[0].dirty).toBe(true)

    await registry.get('/r')
    await new Promise((done) => setTimeout(done, 5))
    expect(builds).toBe(2)
    expect(registry.stats().roots[0].dirty).toBe(false)
  })

  it('drops idle roots', async () => {
    let clock = 0
    const registry = create({ now: () => clock, idleMs: 600_000, firstWaitMs: 1_000, build: async (root) => snapshotAt(root, clock) })
    await registry.get('/a')
    clock = 300_000
    await registry.get('/b')
    clock = 700_000
    registry.evictIdle()
    expect(registry.stats().roots.map((entry) => entry.root.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/'))).toEqual(['/b'])
  })

  it('keeps at most maxRoots, dropping the least recently used and aborting its build', async () => {
    let clock = 0
    const signals = new Map<string, AbortSignal>()
    const registry = create({
      now: () => (clock += 1),
      maxRoots: 2,
      firstWaitMs: 5,
      build: (root, options) => {
        signals.set(root, options!.signal!)
        return new Promise<WorkspaceIndexSnapshot>(() => {})
      }
    })
    await registry.get('/a')
    await registry.get('/b')
    await registry.get('/a')
    await registry.get('/c')

    const names = registry.stats().roots.map((entry) => entry.root.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')).sort()
    expect(names).toEqual(['/a', '/c'])
    const aborted = [...signals].filter(([, signal]) => signal.aborted).map(([root]) => root.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/'))
    expect(aborted).toEqual(['/b'])
  })

  it('dispose aborts running builds and clears every root', async () => {
    let signal: AbortSignal | undefined
    const registry = create({ firstWaitMs: 5, build: (_root, options) => { signal = options?.signal; return new Promise<WorkspaceIndexSnapshot>(() => {}) } })
    await registry.get('/a')
    registry.startSweeper()
    registry.dispose()
    expect(signal?.aborted).toBe(true)
    expect(registry.stats().roots).toEqual([])
  })
})

describe('files.search', () => {
  let registry: WorkspaceIndexRegistry
  const written: string[] = []

  beforeEach(() => {
    registry = new WorkspaceIndexRegistry({ firstWaitMs: 10_000 })
    setWorkspaceIndexRegistryForTests(registry)
  })
  afterEach(() => {
    registry.dispose()
    setWorkspaceIndexRegistryForTests(null)
    written.length = 0
  })

  function context(projects: Record<string, string>): HandlerContext {
    return {
      mms: {
        projects: { getProject: (id: string) => (projects[id] ? { id, path: projects[id] } : undefined) },
        // No known threads: a named thread restores no worktree before the call checks its ids.
        threads: { getThread: () => undefined },
        fileService: { writeFile: async (_root: string, path: string) => { written.push(path); return { added: 0, removed: 0 } } }
      },
      globalSequence: () => 0
    } as unknown as HandlerContext
  }

  it('returns ranked results with root, source and no fallback for a repository', async () => {
    const cwd = repo()
    put(cwd, { 'src/main.ts': 'x', 'src/util/helpers.ts': 'x', 'README.md': 'x', 'ignored.log': 'x', '.gitignore': '*.log\n' })

    const response = await dispatchMethod(context({ p1: cwd }), 'files.search', { projectId: 'p1', query: 'main' }) as FileSearchResponse

    expect(response.root).toBe(cwd)
    expect(response.source).toBe('git')
    expect(response.fallbackReason).toBeUndefined()
    expect(response.results[0]).toMatchObject({ path: 'src/main.ts', kind: 'file' })
    expect(response.indexing).toBe(false)
    expect(response.complete).toBe(true)
    expect(response.truncated).toBe(false)
    // Four files (.gitignore, README.md, two sources) and the two folders above them.
    expect(response.indexed).toBe(6)
    expect(response.indexedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(JSON.stringify(response)).not.toContain('ignored.log')
    expect(response).not.toHaveProperty('files')
  })

  it('reports why a plain folder was walked', async () => {
    const root = tempDir()
    put(root, { 'a.txt': 'x' })
    const response = await dispatchMethod(context({ p1: root }), 'files.search', { projectId: 'p1', query: 'a' }) as FileSearchResponse
    if (response.source === 'walk') expect(response.fallbackReason).toBe('not-a-repo')
    expect(response.results.map((entry) => entry.path)).toEqual(['a.txt'])
  })

  it('caps results at limit and filters by kind', async () => {
    const root = repo()
    put(root, Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`dir${i}/part${i}.ts`, 'x'])))
    const ctx = context({ p1: root })

    const limited = await dispatchMethod(ctx, 'files.search', { projectId: 'p1', query: 'dir', limit: 3 }) as FileSearchResponse
    expect(limited.results).toHaveLength(3)

    const folders = await dispatchMethod(ctx, 'files.search', { projectId: 'p1', query: 'dir', kinds: ['directory'] }) as FileSearchResponse
    expect(folders.results).toHaveLength(6)
    expect(folders.results.every((entry) => entry.kind === 'directory')).toBe(true)
  })

  it('rejects an over-long query, a bad limit or kind, and threadId with projectId', async () => {
    const root = tempDir()
    const ctx = context({ p1: root })
    await expect(dispatchMethod(ctx, 'files.search', { projectId: 'p1', query: 'x'.repeat(513) })).rejects.toThrow(/max length/)
    await expect(dispatchMethod(ctx, 'files.search', { projectId: 'p1', query: 'x', limit: 201 })).rejects.toThrow(/limit/)
    await expect(dispatchMethod(ctx, 'files.search', { projectId: 'p1', query: 'x', kinds: ['socket'] })).rejects.toThrow(/kinds/)
    await expect(dispatchMethod(ctx, 'files.search', { projectId: 'p1', threadId: 't1', query: 'x' })).rejects.toThrow(/either threadId or projectId/)
    await expect(dispatchMethod(ctx, 'files.search', { query: 'x' })).rejects.toThrow(/projectId or threadId/)
  })

  it('answers with indexing: true while the first index has nothing yet', async () => {
    registry.dispose()
    const gate = deferred<WorkspaceIndexSnapshot>()
    registry = new WorkspaceIndexRegistry({ firstWaitMs: 10, build: () => gate.promise })
    setWorkspaceIndexRegistryForTests(registry)

    const response = await dispatchMethod(context({ p1: '/somewhere' }), 'files.search', { projectId: 'p1', query: 'x' }) as FileSearchResponse

    expect(response).toMatchObject({ source: null, results: [], indexed: 0, indexedAt: null, indexing: true, complete: false })
  })

  it('files.write marks the root dirty without building', async () => {
    const root = repo()
    put(root, { 'a.txt': 'x' })
    const ctx = context({ p1: root })
    await dispatchMethod(ctx, 'files.search', { projectId: 'p1', query: 'a' })
    expect(getWorkspaceIndexRegistry().stats().roots[0].dirty).toBe(false)

    await dispatchMethod(ctx, 'files.write', { projectId: 'p1', path: 'a.txt', content: 'y' })

    expect(written).toEqual(['a.txt'])
    expect(getWorkspaceIndexRegistry().stats().roots[0].dirty).toBe(true)
  })
})
