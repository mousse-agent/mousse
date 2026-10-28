/**
 * `editor.folder`: the owner says which folder an editor on another computer opens for a thread. The folder
 * is the thread's ready worktree, else its project's folder, resolved on the owner from the thread id alone,
 * and the reply carries what the caller needs to build a Remote-SSH address.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EDITOR_FOLDER_PATH_MAX,
  editorFolderStyleOf,
  remoteEditorPath,
  type EditorFolder
} from '../../../../src/shared/bridge/editorFolder'
import { ROUTED_METHODS, routedVersions } from '../../../../src/shared/bridge/routed'
import { resolveEditorFolder } from '../../../../src/mms/workspace/editorFolder'
import { ThreadWorkspaceManager } from '../../../../src/mms/workspace/ThreadWorkspaceManager'
import { newId } from '../../../../src/shared/net'
import { cleanup, resources } from '../hub/fixture'
import { repo, routedOwner } from './routedFixture'

afterEach(cleanup)

const windows = process.platform === 'win32'

describe('the path of a Remote-SSH address', () => {
  it('turns a Windows folder into a path from the drive, and leaves a posix one as it is', () => {
    expect(remoteEditorPath('C:\\x', 'windows')).toBe('/C:/x')
    expect(remoteEditorPath('C:\\Users\\Ana Maria\\my app', 'windows')).toBe('/C:/Users/Ana Maria/my app')
    expect(remoteEditorPath('d:/work/app', 'windows')).toBe('/d:/work/app')
    // Trailing and repeated separators and `.` segments are dropped; a drive's root stays a root.
    expect(remoteEditorPath('C:\\work\\\\app\\', 'windows')).toBe('/C:/work/app')
    expect(remoteEditorPath('C:\\work\\.\\app', 'windows')).toBe('/C:/work/app')
    expect(remoteEditorPath('C:\\', 'windows')).toBe('/C:/')

    expect(remoteEditorPath('/home/ana/app', 'posix')).toBe('/home/ana/app')
    expect(remoteEditorPath('/Users/ana/My App/', 'posix')).toBe('/Users/ana/My App')
    expect(remoteEditorPath('/srv//app/./x', 'posix')).toBe('/srv/app/x')
    expect(remoteEditorPath('/', 'posix')).toBe('/')
    // A backslash is an ordinary character in a posix name.
    expect(remoteEditorPath('/home/ana/a\\b', 'posix')).toBe('/home/ana/a\\b')
  })

  it('refuses what an address cannot carry', () => {
    const windowsRefused = [
      'C:relative',
      'relative\\path',
      '\\\\server\\share\\app',
      '//server/share/app',
      '\\\\?\\C:\\app',
      '/home/ana/app',
      'C:\\work\\..\\..\\other',
      'C:\\work\\app:stream',
      'C:\\work\\a*b',
      'C:\\work\\app\n'
    ]
    for (const path of windowsRefused) expect(remoteEditorPath(path, 'windows'), path).toBeUndefined()
    const posixRefused = ['relative/path', '', 'C:\\work', '/home/../etc', '/home/ana/\u0000x', '/a/b\u001b']
    for (const path of posixRefused) expect(remoteEditorPath(path, 'posix'), path).toBeUndefined()
    expect(remoteEditorPath(`/${'a'.repeat(EDITOR_FOLDER_PATH_MAX)}`, 'posix')).toBeUndefined()
    for (const value of [undefined, null, 5, {}]) expect(remoteEditorPath(value, 'posix')).toBeUndefined()
  })

  it('writes paths the Windows way only for a Windows owner', () => {
    expect(editorFolderStyleOf('win32')).toBe('windows')
    for (const platform of ['linux', 'darwin', 'freebsd']) expect(editorFolderStyleOf(platform)).toBe('posix')
  })
})

describe('the row', () => {
  it('is a read of a thread that takes nothing but the thread, at version 1', () => {
    expect(ROUTED_METHODS['editor.folder']).toMatchObject({
      capability: 'read',
      durable: false,
      target: 'thread',
      via: 'protocol',
      keys: ['threadId'],
      version: 1
    })
    expect(routedVersions()['editor.folder']).toBe(1)
  })
})

/** What a thread's folder is for a caller on the owner's own system, as a reader of the reply would work it out. */
const expected = (path: string) => (windows ? `/${path.replaceAll('\\', '/')}` : path)

describe('the folder an editor opens for a thread', () => {
  it('is the thread’s ready worktree, and says which system writes it', async () => {
    const o = await routedOwner()
    const primary = repo()
    const project = o.f.mms.projects.openProject(primary)
    const t = o.thread('With a worktree', project.id, primary)
    const metadata = await new ThreadWorkspaceManager(o.f.mms.threads.getThreadDir(t.id)).provision(
      t.id,
      'main',
      primary
    )
    expect(metadata.lifecycle).toBe('ready')
    expect(metadata.worktreePath).not.toBe(primary)

    const folder = (await o.ok('editor.folder', { threadId: t.id })) as EditorFolder
    expect(folder).toEqual({
      path: metadata.worktreePath,
      uriPath: expected(metadata.worktreePath),
      style: windows ? 'windows' : 'posix',
      platform: process.platform,
      kind: 'worktree',
      ...(userInfo().username ? { user: userInfo().username } : {})
    })
    // The folder is looked up, never made: the primary checkout is left as it was.
    expect(folder.path).not.toBe(primary)
  }, 120_000)

  it('is the project’s folder for a thread that has no worktree, and when its worktree was retired', async () => {
    const o = await routedOwner()
    const primary = repo()
    const project = o.f.mms.projects.openProject(primary)
    const plain = o.thread('Plain', project.id, primary)
    expect(await o.ok('editor.folder', { threadId: plain.id })).toMatchObject({
      path: primary,
      uriPath: expected(primary),
      kind: 'project'
    })

    const retired = o.thread('Retired', project.id, primary)
    const manager = new ThreadWorkspaceManager(o.f.mms.threads.getThreadDir(retired.id))
    const { worktreePath } = await manager.provision(retired.id, 'main', primary)
    expect(await o.ok('editor.folder', { threadId: retired.id })).toMatchObject({
      path: worktreePath,
      kind: 'worktree'
    })
    // A storage rule removed the checkout: the project's folder is opened, and the checkout is not brought back.
    rmSync(worktreePath, { recursive: true, force: true })
    const after = await o.ok('editor.folder', { threadId: retired.id })
    expect(after).toMatchObject({ path: primary, kind: 'project' })
    expect(manager.verify().lifecycle).toBe('missing')
  }, 120_000)

  it('is refused for a thread that is not there, has no folder, or whose folder is gone', async () => {
    const o = await routedOwner()
    expect(await o.call('editor.folder', { threadId: 'no-such-thread' })).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'thread_not_found',
        details: { threadId: 'no-such-thread' }
      })
    })
    const loose = o.thread('No folder')
    expect(await o.call('editor.folder', { threadId: loose.id })).toMatchObject({
      ok: false,
      error: { code: 'thread_has_no_folder' }
    })

    const gone = realpathSync(mkdtempSync(join(tmpdir(), 'editor-folder-gone-')))
    resources.push(() => rmSync(gone, { recursive: true, force: true }))
    const project = o.f.mms.projects.openProject(gone)
    const t = o.thread('Folder removed', project.id, gone)
    expect(await o.ok('editor.folder', { threadId: t.id })).toMatchObject({ path: gone })
    rmSync(gone, { recursive: true, force: true })
    const refused = await o.call('editor.folder', { threadId: t.id })
    expect(refused).toMatchObject({ ok: false, error: { code: 'folder_missing' } })
    // A refusal names the thread, never the owner's path.
    expect(JSON.stringify(refused)).not.toContain(gone)
  }, 120_000)

  it('is not given for a thread in the trash', async () => {
    const o = await routedOwner()
    const primary = repo()
    const project = o.f.mms.projects.openProject(primary)
    const t = o.thread('Trashed', project.id, primary)
    expect(await o.ok('editor.folder', { threadId: t.id })).toMatchObject({ path: primary })
    await o.ok('threads.trash', { threadId: t.id })
    const refused = await o.call('editor.folder', { threadId: t.id })
    expect(refused).toMatchObject({ ok: false, error: { code: 'thread_not_found' } })
    expect(JSON.stringify(refused)).not.toContain(primary)
  }, 120_000)

  it('takes no path, folder or other key from the caller', async () => {
    const o = await routedOwner()
    const primary = repo()
    const project = o.f.mms.projects.openProject(primary)
    const t = o.thread('Asked', project.id, primary)
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'editor-folder-elsewhere-')))
    resources.push(() => rmSync(elsewhere, { recursive: true, force: true }))
    for (const extra of [
      { path: elsewhere },
      { cwd: elsewhere },
      { projectPath: elsewhere },
      { projectId: project.id },
      { folder: elsewhere },
      { expectedJournalGeneration: 0 }
    ])
      await expect(o.call('editor.folder', { threadId: t.id, ...extra }), JSON.stringify(extra)).rejects.toMatchObject({
        code: 'bad_request'
      })
    await expect(o.call('editor.folder', {})).rejects.toMatchObject({ code: 'bad_request' })
    await expect(o.call('editor.folder', { threadId: '' })).rejects.toMatchObject({ code: 'bad_request' })
    // What the owner answers is still its own folder for the thread.
    expect(await o.ok('editor.folder', { threadId: t.id })).toMatchObject({ path: primary })
  }, 120_000)

  it('is refused to a device without Works on threads, and its reads are counted without the path', async () => {
    const without = await routedOwner({ caps: ['read', 'chat', 'write'] })
    const primary = repo()
    const project = without.f.mms.projects.openProject(primary)
    const t = without.thread('Not for a phone', project.id, primary)
    await expect(
      without.f.caller().rpc(
        'routed.editor.folder',
        { threadId: t.id },
        { id: newId('rpc'), deadlineMs: 5000 }
      )
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(without.audit.reads(without.f.callerNode)).toEqual([])

    // A computer with the grant: the read is counted, a refusal is counted too, and no row records the path.
    const o = await routedOwner()
    const mine = o.f.mms.projects.openProject(primary)
    const thread = o.thread('Audited', mine.id, primary)
    await o.ok('editor.folder', { threadId: thread.id })
    await o.call('editor.folder', { threadId: 'missing' })
    expect(o.audit.reads(o.f.callerNode)).toEqual([expect.objectContaining({ calls: 2 })])
    expect(o.audit.recent(20, o.f.callerNode)).toEqual([])
    expect(JSON.stringify(o.audit.reads(o.f.callerNode))).not.toContain(primary)
  }, 120_000)
})

describe('the folder on the owner', () => {
  const directory = (): string => {
    const path = realpathSync(mkdtempSync(join(tmpdir(), 'editor-folder-unit-')))
    resources.push(() => rmSync(path, { recursive: true, force: true }))
    return path
  }

  it('is refused, without naming it, when the owner’s system cannot write it as an address', () => {
    const projectPath = directory()
    // A system whose paths are written the other way: no path of this one is a path of that one.
    const platform = windows ? 'linux' : 'win32'
    let thrown: unknown
    try {
      resolveEditorFolder({ threadId: 't1', threadDirectory: directory(), projectPath, platform })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({ code: 'folder_not_openable', details: { threadId: 't1' } })
    expect(String((thrown as Error).message)).not.toContain(projectPath)
  })

  it('names the owner’s system and login', () => {
    const projectPath = directory()
    const found = resolveEditorFolder({
      threadId: 't1',
      threadDirectory: directory(),
      projectPath,
      user: 'ana'
    })
    expect(found).toMatchObject({ path: projectPath, kind: 'project', platform: process.platform, user: 'ana' })
  })
})
