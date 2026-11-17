/**
 * Dragging a file out of the window (`files:startDrag`): the main process hands the system only a file that belongs to
 * the thread, and a file with no path of its own (or another name) as a temporary copy under the name the chip shows.
 * Real files on disk; the daemon's answers (the thread's folder, its messages) are stubbed.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  getFileIcon: vi.fn(async () => ({ isEmpty: () => false, tag: 'file icon' }))
}))
vi.mock('electron', () => ({
  app: { getFileIcon: electron.getFileIcon },
  nativeImage: {
    createEmpty: () => ({ isEmpty: () => true }),
    createFromPath: () => ({ isEmpty: () => true }),
    createFromBuffer: () => ({ isEmpty: () => false, tag: 'fallback' })
  }
}))
vi.mock('../src/main/appIcon', () => ({ getAppIconPath: () => undefined }))

import { dragFilePath, DRAG_FOLDER, type FileDragDeps } from '../src/main/fileDrag'
import { startFileDrag } from '../src/main/ipc/fileDragIpc'
import { formatAttachedFilesMarker } from '../src/shared/attachedFilesMarker'
import { MAX_DRAG_BYTES } from '../src/shared/fileDrag'

let base: string
let workspace: string
let temp: string
let outside: string
let texts: string[]

const THREAD = 'thread-1'
const deps = (): FileDragDeps => ({
  temp,
  filesRoot: async (scope) => (scope.threadId === THREAD || scope.projectId === 'project-1' ? workspace : undefined),
  messageTexts: async (threadId) => (threadId === THREAD ? texts : [])
})
const write = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}
const drag = (item: unknown, scope: Record<string, unknown> = { threadId: THREAD }) => dragFilePath({ ...scope, item }, deps())

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'file-drag-')))
  workspace = join(base, 'workspace')
  temp = join(base, 'temp')
  outside = join(base, 'outside')
  mkdirSync(temp, { recursive: true })
  write(join(workspace, 'src', 'notes.txt'), 'notes')
  write(join(outside, 'secret.txt'), 'secret')
  texts = []
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('a file of the thread\'s folder', () => {
  it('drags the real file or folder, named relative to the folder or by its absolute path', async () => {
    expect(await drag({ kind: 'workspace', path: 'src/notes.txt' })).toBe(join(workspace, 'src', 'notes.txt'))
    expect(await drag({ kind: 'workspace', path: 'src' })).toBe(join(workspace, 'src'))
    expect(await drag({ kind: 'workspace', path: join(workspace, 'src', 'notes.txt') })).toBe(join(workspace, 'src', 'notes.txt'))
    expect(await drag({ kind: 'workspace', path: 'src/notes.txt' }, { projectId: 'project-1' })).toBe(join(workspace, 'src', 'notes.txt'))
    // Nothing is copied: the system gets the file itself.
    expect(existsSync(join(temp, DRAG_FOLDER))).toBe(false)
  })

  it.each([
    ['a path that climbs out', { kind: 'workspace', path: '../outside/secret.txt' }],
    ['an absolute path elsewhere', { kind: 'workspace', path: 'OUTSIDE' }],
    ['a missing file', { kind: 'workspace', path: 'src/gone.txt' }],
    ['a NUL in the path', { kind: 'workspace', path: 'src/notes.txt\0' }]
  ])('refuses %s', async (_name, item) => {
    await expect(drag(item.path === 'OUTSIDE' ? { ...item, path: join(outside, 'secret.txt') } : item)).rejects.toThrow()
  })

  it('refuses a link inside the folder that points out of it', async () => {
    symlinkSync(join(outside, 'secret.txt'), join(workspace, 'link.txt'))
    await expect(drag({ kind: 'workspace', path: 'link.txt' })).rejects.toThrow(/not in this thread's folder/)
  })

  it('refuses a thread without a folder, and a thread or project of another computer', async () => {
    await expect(drag({ kind: 'workspace', path: 'src/notes.txt' }, {})).rejects.toThrow(/no folder/)
    const node = `nod_${'a'.repeat(26)}`
    await expect(drag({ kind: 'workspace', path: 'src/notes.txt' }, { threadId: `${node}:${THREAD}` })).rejects.toThrow(/another computer/)
    await expect(drag({ kind: 'attachment', path: join(workspace, 'src', 'notes.txt') }, { projectId: `${node}:project-1` })).rejects.toThrow(/another computer/)
  })
})

describe('an attached file', () => {
  it('drags a file in the thread\'s folder or one its messages name, by its own path', async () => {
    expect(await drag({ kind: 'attachment', path: join(workspace, 'src', 'notes.txt'), name: 'notes.txt' })).toBe(join(workspace, 'src', 'notes.txt'))
    const picked = write(join(base, 'Downloads', 'report.pdf'), '%PDF')
    texts = [`Read this\n\n${formatAttachedFilesMarker([{ name: 'report.pdf', path: picked }])}`]
    expect(await drag({ kind: 'attachment', path: picked, name: 'report.pdf' })).toBe(picked)
  })

  it('refuses a file the thread never had', async () => {
    texts = ['report.pdf is in my Downloads']
    await expect(drag({ kind: 'attachment', path: join(outside, 'secret.txt'), name: 'secret.txt' })).rejects.toThrow(/not a file of this thread/)
    // Named by another thread's message is not enough.
    texts = []
    await expect(drag({ kind: 'attachment', path: join(outside, 'secret.txt') }, { threadId: 'thread-2' })).rejects.toThrow(/not a file of this thread/)
  })

  it('drags a pasted file Mousse kept for the thread as a copy under the name the chip shows, with the same bytes', async () => {
    const kept = write(join(temp, 'mousse-attachments', THREAD, '1a2b3c4d-notes.txt'), 'pasted text')
    const path = await drag({ kind: 'attachment', path: kept, name: 'notes.txt' })
    expect(basename(path)).toBe('notes.txt')
    expect(path.startsWith(join(temp, DRAG_FOLDER))).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('pasted text')
    expect(readFileSync(kept, 'utf8')).toBe('pasted text')
    // Another thread's pasted file is not this thread's.
    const other = write(join(temp, 'mousse-attachments', 'thread-2', 'aaaa1111-x.txt'), 'x')
    await expect(drag({ kind: 'attachment', path: other, name: 'x.txt' })).rejects.toThrow(/not a file of this thread/)
  })
})

describe('a file with no path of its own', () => {
  it('is written under its own name, in a folder of its own, and works for a thread of another computer', async () => {
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const first = await drag({ kind: 'bytes', name: 'screenshot.png', data })
    const second = await drag({ kind: 'bytes', name: 'screenshot.png', data }, { threadId: `nod_${'b'.repeat(26)}:${THREAD}` })
    expect(basename(first)).toBe('screenshot.png')
    expect(basename(second)).toBe('screenshot.png')
    expect(first).not.toBe(second)
    expect(new Uint8Array(readFileSync(first))).toEqual(data)
  })

  it('keeps the copy inside its folder whatever the name says, and refuses one too large', async () => {
    const path = await drag({ kind: 'bytes', name: '../../.ssh/authorized_keys', data: new Uint8Array([1]) })
    expect(path.startsWith(join(temp, DRAG_FOLDER))).toBe(true)
    expect(basename(path)).toBe('authorized_keys')
    await expect(drag({ kind: 'bytes', name: 'big.bin', data: new Uint8Array(MAX_DRAG_BYTES + 1) })).rejects.toThrow(/too large/)
  })

  it('removes copies of drags from more than a day ago when the next drag starts', async () => {
    const old = await drag({ kind: 'bytes', name: 'old.png', data: new Uint8Array([1]) })
    const longAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    utimesSync(dirname(old), longAgo, longAgo)
    const fresh = await drag({ kind: 'bytes', name: 'new.png', data: new Uint8Array([2]) })
    expect(existsSync(old)).toBe(false)
    expect(statSync(fresh).isFile()).toBe(true)
  })
})

describe('files:startDrag', () => {
  const sender = () => ({ isDestroyed: () => false, startDrag: vi.fn() })

  it('starts the system drag of the checked file with its icon, and says which file', async () => {
    const window = sender()
    const answer = await startFileDrag(window as never, { threadId: THREAD, item: { kind: 'workspace', path: 'src/notes.txt' } }, deps())
    expect(answer).toEqual({ path: join(workspace, 'src', 'notes.txt') })
    expect(window.startDrag).toHaveBeenCalledWith({ file: join(workspace, 'src', 'notes.txt'), icon: expect.objectContaining({ tag: 'file icon' }) })
  })

  it('starts nothing for a refused file and says why', async () => {
    const window = sender()
    const answer = await startFileDrag(window as never, { threadId: THREAD, item: { kind: 'workspace', path: '../outside/secret.txt' } }, deps())
    expect(answer).toEqual({ refused: expect.stringContaining('secret.txt') })
    expect(window.startDrag).not.toHaveBeenCalled()
  })

  it('drags with the app\'s icon when the system has none', async () => {
    electron.getFileIcon.mockRejectedValueOnce(new Error('no icon'))
    const window = sender()
    await startFileDrag(window as never, { threadId: THREAD, item: { kind: 'workspace', path: 'src/notes.txt' } }, deps())
    expect(window.startDrag).toHaveBeenCalledWith(expect.objectContaining({ icon: expect.objectContaining({ tag: 'fallback' }) }))
  })
})
