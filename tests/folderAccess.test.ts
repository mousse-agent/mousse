import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { dispatchMethod } from '../src/mms/protocol/handlers'
import { FolderAccessGate, folderAccess, volumeKey } from '../src/mms/files/folderAccess'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => { resolve = settle })
  return { promise, resolve }
}

/** Settles `promise` within a few macrotask turns, or reports it as still waiting. */
async function settledSoon(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  void promise.then(() => { settled = true }, () => { settled = true })
  for (let turn = 0; turn < 20 && !settled; turn += 1) await new Promise((r) => setTimeout(r, 5))
  return settled
}

describe('volumeKey', () => {
  it('tells volumes and macOS protected folders apart by path alone', () => {
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
  it('shares one check per volume and remembers a volume that answered', async () => {
    const pending = deferred()
    const probe = vi.fn(() => pending.promise)
    const gate = new FolderAccessGate(probe, (path) => path.split('/').slice(0, 3).join('/'))
    const first = gate.ready(['/Volumes/Backup/one'])
    const second = gate.ready(['/Volumes/Backup/two'])
    expect(probe).toHaveBeenCalledTimes(1)
    expect(await settledSoon(Promise.race([first, second]))).toBe(false)
    pending.resolve()
    await Promise.all([first, second])
    await gate.ready(['/Volumes/Backup/three'])
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('does not remember a failed check, so the next request checks again', async () => {
    const probe = vi.fn(async () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) })
    const gate = new FolderAccessGate(probe, () => 'volume')
    await expect(gate.ready(['/Volumes/Backup/app'])).resolves.toBeUndefined()
    await gate.ready(['/Volumes/Backup/app'])
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('lets other volumes through while one volume waits', async () => {
    const stuck = new Promise<void>(() => undefined)
    const gate = new FolderAccessGate(async (path) => { if (path.startsWith('/Volumes/Stuck')) await stuck }, (path) => path.split('/').slice(0, 3).join('/'))
    const waiting = gate.ready(['/Volumes/Stuck/app'])
    await gate.ready(['/Volumes/Other/app'])
    expect(await settledSoon(waiting)).toBe(false)
  })

  it('reads a real folder and passes over one that is not there', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mousse-folder-access-'))
    try {
      const gate = new FolderAccessGate(undefined, (path) => path)
      await gate.ready([dir, join(dir, 'missing'), 'relative/path'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('a folder waiting for a permission prompt', () => {
  let home: string
  let mms: MousseMainService

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-folder-wait-'))
    process.env.MOUSSE_HOME = home
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
  })

  afterEach(async () => {
    folderAccess.reset()
    await mms.stop()
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  it('holds only the request for that project; another project is answered meanwhile', async () => {
    const ctx = { mms, globalSequence: () => 0 }
    const stuckPath = join(home, 'external', 'stuck-project')
    const otherPath = join(home, 'internal', 'other-project')
    mkdirSync(stuckPath, { recursive: true })
    mkdirSync(otherPath, { recursive: true })
    const stuck = (await dispatchMethod(ctx, 'projects.open', { path: stuckPath }) as { project: { id: string } }).project
    const other = (await dispatchMethod(ctx, 'projects.open', { path: otherPath }) as { project: { id: string } }).project

    // The external volume's prompt is not answered yet: its check waits until `answer` is called.
    const prompt = deferred()
    folderAccess.reset(
      async (path) => { if (path.startsWith(join(home, 'external'))) await prompt.promise },
      (path) => path.startsWith(join(home, 'external')) ? 'external' : 'internal'
    )

    const waiting = dispatchMethod(ctx, 'threads.create', { name: 'On the external volume', projectId: stuck.id })
    const answered = await dispatchMethod(ctx, 'threads.create', { name: 'On this computer', projectId: other.id }) as { thread: { projectId?: string } }
    expect(answered.thread.projectId).toBe(other.id)
    await expect(dispatchMethod(ctx, 'projects.list', {})).resolves.toBeDefined()
    expect(await settledSoon(waiting)).toBe(false)

    // Once the prompt is answered, the waiting request finishes.
    prompt.resolve()
    const finished = await waiting as { thread: { projectId?: string } }
    expect(finished.thread.projectId).toBe(stuck.id)
  })
})
