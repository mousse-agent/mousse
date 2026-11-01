import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { dispatchMethod } from '../src/mms/protocol/handlers'
import { FolderAccessGate, FolderNotAnsweringError, folderAccess, volumeKey, type FolderAccessDeps } from '../src/mms/files/folderAccess'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => { resolve = settle })
  return { promise, resolve }
}

/** Whether `promise` settles within a few macrotask turns. */
async function settledSoon(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  void promise.then(() => { settled = true }, () => { settled = true })
  for (let turn = 0; turn < 20 && !settled; turn += 1) await new Promise((r) => setTimeout(r, 5))
  return settled
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, stdio: 'ignore' })
}

/** The `/Volumes/<name>` part of a path, else the system volume. */
const byVolumesFolder = (path: string): string => path.split('/').slice(0, 3).join('/').startsWith('/Volumes/') ? path.split('/').slice(0, 3).join('/') : '/'

/** A gate over made-up paths: nothing is a symlink, nothing is a repository. */
function fakeGate(deps: Partial<FolderAccessDeps>): FolderAccessGate {
  return new FolderAccessGate({
    lstat: async () => ({ isSymbolicLink: () => false }),
    commonDir: async () => null,
    keyOf: byVolumesFolder,
    platform: 'darwin',
    ...deps
  })
}

describe('volumeKey', () => {
  it('tells volumes and macOS protected folders apart by path', () => {
    expect(volumeKey('/Volumes/Backup/code/app', 'darwin', '/Users/me')).toBe('/Volumes/Backup')
    expect(volumeKey('/Users/me/Documents/app', 'darwin', '/Users/me')).toBe('/Users/me/Documents')
    expect(volumeKey('/Users/me/Library/Mobile Documents/com~apple~CloudDocs/app', 'darwin', '/Users/me')).toBe('/Users/me/Library/Mobile Documents')
    expect(volumeKey('/Users/me/Library/CloudStorage/Dropbox/app', 'darwin', '/Users/me')).toBe('/Users/me/Library/CloudStorage/Dropbox')
    expect(volumeKey('/Users/me/code/app', 'darwin', '/Users/me')).toBe('/')
    expect(volumeKey('/media/me/usb/app', 'linux', '/home/me')).toBe('/media/me/usb')
    expect(volumeKey('/home/me/app', 'linux', '/home/me')).toBe('/')
  })
})

describe('FolderAccessGate', () => {
  it('shares one check per volume, and checks a volume again after the interval', async () => {
    let now = 0
    const pending = deferred()
    const probe = vi.fn(() => pending.promise)
    const gate = fakeGate({ probe, now: () => now, recheckMs: 60_000 })
    const first = gate.ready(['/Volumes/Backup/one'])
    const second = gate.ready(['/Volumes/Backup/two'])
    expect(await settledSoon(Promise.race([first, second]))).toBe(false)
    expect(probe).toHaveBeenCalledTimes(1)
    pending.resolve()
    await Promise.all([first, second])
    now = 59_000
    await gate.ready(['/Volumes/Backup/three'])
    expect(probe).toHaveBeenCalledTimes(1)
    // Past the interval: checked again, once for callers at the same time.
    now = 61_000
    await Promise.all([gate.ready(['/Volumes/Backup/one']), gate.ready(['/Volumes/Backup/four'])])
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('does not remember a failed check, so the next request checks again', async () => {
    const probe = vi.fn(async () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) })
    const gate = fakeGate({ probe })
    await expect(gate.ready(['/Volumes/Backup/app'])).resolves.toBeUndefined()
    await gate.ready(['/Volumes/Backup/app'])
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('lets other volumes through while one waits', async () => {
    const gate = fakeGate({ probe: (path) => path.startsWith('/Volumes/Stuck') ? new Promise(() => undefined) : Promise.resolve() })
    const waiting = gate.ready(['/Volumes/Stuck/app'])
    await gate.ready(['/Volumes/Other/app', '/Users/me/code'])
    expect(await settledSoon(waiting)).toBe(false)
  })

  it('never delays a healthy folder behind hung volumes', async () => {
    const probe = vi.fn((path: string) => path.startsWith('/Volumes/') ? new Promise<void>(() => undefined) : Promise.resolve())
    const gate = fakeGate({ probe, stuckAfterMs: 60_000 })
    const hung = [gate.ready(['/Volumes/Network/app']), gate.ready(['/Volumes/Usb/app'])]
    await expect(gate.ready(['/Users/me/code/app'])).resolves.toBeUndefined()
    expect(await settledSoon(Promise.race(hung))).toBe(false)
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('a cancelled wait releases its volume: the stuck check is left behind, and new requests fail at once', async () => {
    const answer = deferred()
    const probe = vi.fn(() => answer.promise)
    const gate = fakeGate({ probe, stuckAfterMs: 60_000 })
    const abort = new AbortController()
    const waiting = gate.ready(['/Volumes/Usb/app'], { signal: abort.signal })
    expect(await settledSoon(waiting)).toBe(false)
    abort.abort(new DOMException('Stopped', 'AbortError'))
    await expect(waiting).rejects.toThrow('Stopped')
    // No new check queues behind the stuck one.
    await expect(gate.ready(['/Volumes/Usb/other'], { whenNotAnswering: 'fail' })).rejects.toBeInstanceOf(FolderNotAnsweringError)
    expect(probe).toHaveBeenCalledTimes(1)
    // A turn waits for the check left behind; once the prompt is answered the volume is trusted again.
    const turn = gate.ready(['/Volumes/Usb/app'])
    expect(await settledSoon(turn)).toBe(false)
    answer.resolve()
    await turn
    await gate.ready(['/Volumes/Usb/third'], { whenNotAnswering: 'fail' })
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('a check that runs too long fails waiting requests at once and lets turns keep waiting', async () => {
    const answer = deferred()
    const gate = fakeGate({ probe: () => answer.promise, stuckAfterMs: 20 })
    const request = gate.ready(['/Volumes/Usb/app'], { whenNotAnswering: 'fail' })
    const turn = gate.ready(['/Volumes/Usb/app'])
    await expect(request).rejects.toMatchObject({ code: 'folder_not_answering', volume: '/Volumes/Usb' })
    expect(await settledSoon(turn)).toBe(false)
    answer.resolve()
    await expect(turn).resolves.toBeUndefined()
  })

  it('ends a wait when its signal aborts', async () => {
    const gate = fakeGate({ probe: () => new Promise(() => undefined) })
    const abort = new AbortController()
    const waiting = gate.ready(['/Volumes/Stuck/app'], { signal: abort.signal })
    abort.abort(new DOMException('Profile shutdown', 'AbortError'))
    await expect(waiting).rejects.toThrow('Profile shutdown')
  })
})

describe('FolderAccessGate on real folders', () => {
  let base: string

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-folder-access-')))
    mkdirSync(join(base, 'internal'), { recursive: true })
    mkdirSync(join(base, 'external'), { recursive: true })
  })

  afterEach(() => rmSync(base, { recursive: true, force: true }))

  /** `external/` stands in for a removable volume whose permission prompt is not answered yet. */
  function gateWithStuckExternal(probed: string[]): FolderAccessGate {
    const external = join(base, 'external')
    return new FolderAccessGate({
      keyOf: (path) => path === external || path.startsWith(external + sep) ? 'external' : 'internal',
      probe: async (path) => {
        probed.push(path)
        if (path.startsWith(external)) await new Promise(() => undefined)
      }
    })
  }

  it('checks where a symlink points, not where it is', async () => {
    mkdirSync(join(base, 'external', 'project'))
    mkdirSync(join(base, 'internal', 'other'))
    symlinkSync(join(base, 'external', 'project'), join(base, 'internal', 'link'))
    const probed: string[] = []
    const gate = gateWithStuckExternal(probed)
    const waiting = gate.ready([join(base, 'internal', 'link')])
    await gate.ready([join(base, 'internal', 'other')])
    expect(await settledSoon(waiting)).toBe(false)
    expect(probed).toContain(join(base, 'external', 'project'))
  })

  it("checks a linked worktree's repository on another volume", async () => {
    const repo = join(base, 'external', 'repo')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    writeFileSync(join(repo, 'file.txt'), 'one\n')
    git(repo, 'add', 'file.txt')
    git(repo, 'commit', '-q', '-m', 'one')
    git(repo, 'worktree', 'add', '-q', join(base, 'internal', 'worktree'))
    mkdirSync(join(base, 'internal', 'other'))
    const probed: string[] = []
    const gate = gateWithStuckExternal(probed)
    const waiting = gate.ready([join(base, 'internal', 'worktree')])
    await gate.ready([join(base, 'internal', 'other')])
    expect(await settledSoon(waiting)).toBe(false)
    expect(probed).toContain(join(repo, '.git'))
  })

  it('reads a real folder and passes over one that is not there', async () => {
    const gate = new FolderAccessGate()
    await gate.ready([join(base, 'internal'), join(base, 'missing'), 'relative/path'])
  })
})

describe('a folder waiting for a permission prompt', () => {
  let home: string
  let mms: MousseMainService
  let stopped: boolean

  beforeEach(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-folder-wait-')))
    process.env.MOUSSE_HOME = home
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
    stopped = false
  })

  afterEach(async () => {
    folderAccess.reset()
    if (!stopped) await mms.stop()
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  /** Two Git projects; the one on `external/` waits for its prompt until `answer()`. */
  async function projects() {
    const ctx = { mms, globalSequence: () => 0 }
    const stuckPath = join(home, 'external', 'stuck-project')
    const otherPath = join(home, 'internal', 'other-project')
    for (const path of [stuckPath, otherPath]) {
      mkdirSync(path, { recursive: true })
      git(path, 'init', '-q')
    }
    const stuck = (await dispatchMethod(ctx, 'projects.open', { path: stuckPath }) as { project: { id: string } }).project
    const other = (await dispatchMethod(ctx, 'projects.open', { path: otherPath }) as { project: { id: string } }).project
    const prompt = deferred()
    const external = join(home, 'external')
    folderAccess.reset({
      keyOf: (path) => path.startsWith(external) ? 'external' : 'internal',
      probe: async (path) => { if (path.startsWith(external)) await prompt.promise }
    })
    const thread = (await dispatchMethod(ctx, 'threads.create', { name: 'On the external volume', projectId: stuck.id }) as { thread: { id: string } }).thread
    return { ctx, stuck, other, thread, answer: prompt.resolve }
  }

  it('holds only Git work in that project; other projects and thread metadata answer meanwhile', async () => {
    const { ctx, stuck, other, thread, answer } = await projects()
    const waiting = dispatchMethod(ctx, 'git.status', { projectId: stuck.id })
    await expect(dispatchMethod(ctx, 'git.status', { projectId: other.id })).resolves.toBeDefined()
    await expect(dispatchMethod(ctx, 'threads.get', { threadId: thread.id })).resolves.toBeDefined()
    await expect(dispatchMethod(ctx, 'queue.list', { threadId: thread.id })).resolves.toBeDefined()
    await expect(dispatchMethod(ctx, 'orchestrator.isTurnActive', { threadId: thread.id })).resolves.toBeDefined()
    await expect(dispatchMethod(ctx, 'threads.rename', { threadId: thread.id, name: 'Renamed' })).resolves.toBeDefined()
    expect(await settledSoon(waiting)).toBe(false)
    // Once the prompt is answered, the waiting request finishes.
    answer()
    await expect(waiting).resolves.toBeDefined()
  })

  it("Stop reaches its handler at once and ends the thread's waiting request", async () => {
    const { ctx, thread } = await projects()
    const waiting = dispatchMethod(ctx, 'git.status', { threadId: thread.id })
    expect(await settledSoon(waiting)).toBe(false)
    await expect(dispatchMethod(ctx, 'orchestrator.abort', { threadId: thread.id })).resolves.toBeDefined()
    await expect(waiting).rejects.toMatchObject({ code: 'thread_stopped' })
  })

  it("a turn's wait ends with a Stop of its thread, or with its own signal", async () => {
    const { thread } = await projects()
    const waiting = mms.orchestrator.waitForThreadFolders(thread.id)
    expect(await settledSoon(waiting)).toBe(false)
    await mms.orchestrator.stopThread(thread.id, 'user')
    await expect(waiting).resolves.toBe('stopped')
    const abort = new AbortController()
    const cancelled = mms.orchestrator.waitForThreadFolders(thread.id, undefined, abort.signal)
    abort.abort()
    await expect(cancelled).resolves.toBe('aborted')
  })

  it('once the volume stops answering, its requests fail at once until the prompt is answered', async () => {
    const { ctx, stuck, answer } = await projects()
    folderAccess.reset({
      keyOf: (path) => path.startsWith(join(home, 'external')) ? 'external' : 'internal',
      probe: async (path) => { if (path.startsWith(join(home, 'external'))) await answered },
      stuckAfterMs: 20
    })
    let release!: () => void
    const answered = new Promise<void>((settle) => { release = settle })
    await expect(dispatchMethod(ctx, 'git.status', { projectId: stuck.id })).rejects.toMatchObject({ code: 'folder_not_answering' })
    await expect(dispatchMethod(ctx, 'git.branches', { projectId: stuck.id })).rejects.toMatchObject({ code: 'folder_not_answering' })
    release()
    answer()
    await new Promise((settle) => setTimeout(settle, 10))
    await expect(dispatchMethod(ctx, 'git.status', { projectId: stuck.id })).resolves.toBeDefined()
  })

  it('stopping the service does not wait on a pending prompt', async () => {
    const { ctx, stuck } = await projects()
    const waiting = dispatchMethod(ctx, 'git.status', { projectId: stuck.id })
    expect(await settledSoon(waiting)).toBe(false)
    const started = Date.now()
    stopped = true
    await mms.stop()
    expect(Date.now() - started).toBeLessThan(10_000)
    await expect(waiting).rejects.toMatchObject({ code: 'profile_draining' })
  })
})
