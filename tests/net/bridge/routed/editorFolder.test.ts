/**
 * `editor.folder`: the owner says which folder an editor on another computer opens for a thread. The folder
 * is the thread's ready worktree, else its project's folder, resolved on the owner from the thread id alone,
 * and the reply carries what the caller needs to build a Remote-SSH address.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EDITOR_FOLDER_PATH_MAX,
  editorFolderStyleOf,
  isSafeLoginName,
  remoteEditorPath,
  type EditorFolder
} from '../../../../src/shared/bridge/editorFolder'
import { ROUTED_METHODS, routedVersions } from '../../../../src/shared/bridge/routed'
import {
  forgetResolvedSensitiveFolders,
  sensitiveFolderContaining,
  type FolderRuleEnvironment
} from '../../../../src/mms/files/sensitiveFolders'
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

  it('passes `#`, `%`, `?` and non-ASCII letters through unencoded, for the caller to encode', () => {
    expect(remoteEditorPath('/home/ana/a#b/100%/what?/café/日本語', 'posix')).toBe(
      '/home/ana/a#b/100%/what?/café/日本語'
    )
    expect(remoteEditorPath('C:\\Users\\josé\\100% #1\\日本語', 'windows')).toBe(
      '/C:/Users/josé/100% #1/日本語'
    )
    // An already encoded name is a different name: it is not decoded.
    expect(remoteEditorPath('/home/ana/a%20b', 'posix')).toBe('/home/ana/a%20b')
  })

  it('accepts a login name only when it is safe in an SSH config’s User line', () => {
    for (const name of ['ana', 'Ana.Maria-2', 'svc_build', 'josé', '日本', 'a'.repeat(64)])
      expect(isSafeLoginName(name), name).toBe(true)
    for (const name of [
      '',
      'Ana Maria',
      'a"b',
      'a#b',
      'a\nb',
      'a b',
      "a'b",
      '-oProxyCommand=x',
      'a/b',
      '.ana',
      'a\\b',
      'DOMAIN\\ana',
      'a'.repeat(65),
      undefined,
      5
    ])
      expect(isSafeLoginName(name), String(name)).toBe(false)
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
      // The login name is sent only when it is safe in an SSH config.
      ...(isSafeLoginName(userInfo().username) ? { user: userInfo().username } : {})
    })
    // The folder is looked up, never made: the primary checkout is left as it was.
    expect(folder.path).not.toBe(primary)
  }, 120_000)

  it('is the project’s folder only for a thread that never had a worktree', async () => {
    const o = await routedOwner()
    const primary = repo()
    const project = o.f.mms.projects.openProject(primary)
    const plain = o.thread('Plain', project.id, primary)
    expect(await o.ok('editor.folder', { threadId: plain.id })).toMatchObject({
      path: primary,
      uriPath: expected(primary),
      kind: 'project'
    })
  }, 120_000)

  it('is refused, not answered with the project’s folder, while the thread’s worktree is not ready', async () => {
    const o = await routedOwner()
    const primary = repo()
    const project = o.f.mms.projects.openProject(primary)

    // A storage rule removed the checkout: the caller restores it (`workspace.restore`, a row of its own) and asks again.
    const retired = o.thread('Retired', project.id, primary)
    const manager = new ThreadWorkspaceManager(o.f.mms.threads.getThreadDir(retired.id))
    const { worktreePath } = await manager.provision(retired.id, 'main', primary)
    expect(await o.ok('editor.folder', { threadId: retired.id })).toMatchObject({
      path: worktreePath,
      kind: 'worktree'
    })
    rmSync(worktreePath, { recursive: true, force: true })
    for (let attempt = 0; attempt < 2; attempt++) {
      const refused = await o.call('editor.folder', { threadId: retired.id })
      expect(refused).toMatchObject({
        ok: false,
        error: { code: 'workspace_not_ready', details: { threadId: retired.id, state: 'missing' } }
      })
      expect(JSON.stringify(refused)).not.toContain(primary)
      expect(JSON.stringify(refused)).not.toContain(worktreePath)
    }
    // Asking never brings the checkout back.
    expect(manager.verify().lifecycle).toBe('missing')

    // Its HEAD moved (an agent committed in it): the worktree is still the thread's folder, as HEAD and the branch are the agent's to move.
    const moved = o.thread('Moved', project.id, primary)
    const movedMeta = await new ThreadWorkspaceManager(o.f.mms.threads.getThreadDir(moved.id)).provision(
      moved.id,
      'main',
      primary
    )
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'outside the thread'], {
      cwd: movedMeta.worktreePath,
      stdio: 'pipe'
    })
    expect(await o.ok('editor.folder', { threadId: moved.id })).toMatchObject({
      path: movedMeta.worktreePath,
      kind: 'worktree'
    })
  }, 180_000)

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
    // A project folder that became a file is not a folder to open.
    writeFileSync(gone, 'not a folder')
    expect(await o.call('editor.folder', { threadId: t.id })).toMatchObject({
      ok: false,
      error: { code: 'folder_missing' }
    })
  }, 120_000)

  it('is refused for a credentials folder, with the default table and a project that is one', async () => {
    const o = await routedOwner()
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'editor-folder-home-')))
    resources.push(() => rmSync(home, { recursive: true, force: true }))
    const ssh = join(home, '.ssh')
    mkdirSync(join(ssh, 'keys'), { recursive: true })
    const ordinary = join(home, 'work')
    mkdirSync(ordinary)
    const link = join(tmpdir(), `editor-folder-link-${newId('rpc')}`)
    symlinkSync(ssh, link, windows ? 'junction' : 'dir')
    resources.push(() => rmSync(link, { recursive: true, force: true }))
    // The default table reads this computer's home folder; point it at the fake one for the calls below.
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
    process.env.HOME = home
    process.env.USERPROFILE = home
    forgetResolvedSensitiveFolders()
    try {
      const project = (path: string) => o.f.mms.projects.openProject(path)
      const asked = async (path: string) => {
        const t = o.thread(`At ${path}`, project(path).id, path)
        return o.call('editor.folder', { threadId: t.id })
      }
      for (const path of [ssh, join(ssh, 'keys'), link]) {
        const refused = await asked(path)
        expect(refused, path).toMatchObject({
          ok: false,
          error: { code: 'folder_protected', message: expect.stringContaining('SSH keys') }
        })
        // The refusal says what the folder holds and names the thread, never a path.
        for (const spelled of [path, ssh, home]) expect(JSON.stringify(refused)).not.toContain(JSON.stringify(spelled).slice(1, -1))
      }
      // A folder beside it, and the home folder itself, are the owner's own choice and open as usual.
      expect(await asked(ordinary)).toMatchObject({ ok: true, result: { path: ordinary } })
      expect(await asked(home)).toMatchObject({ ok: true, result: { path: home } })
    } finally {
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      forgetResolvedSensitiveFolders()
    }
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

  it('names the owner’s system and login, and leaves out a login that is not safe in an SSH config', () => {
    const projectPath = directory()
    const ask = (user: string) =>
      resolveEditorFolder({ threadId: 't1', threadDirectory: directory(), projectPath, user })
    expect(ask('ana')).toMatchObject({
      path: projectPath,
      kind: 'project',
      platform: process.platform,
      user: 'ana'
    })
    for (const user of ['Ana Maria', 'a"b', 'a#b', 'a\nb', '']) expect(ask(user), user).not.toHaveProperty('user')
  })

  it('opens a project reached through a link under the link’s name, and checks where the link leads', () => {
    const real = directory()
    const link = join(directory(), 'linked project')
    symlinkSync(real, link, windows ? 'junction' : 'dir')
    const found = resolveEditorFolder({
      threadId: 't1',
      threadDirectory: directory(),
      projectPath: link
    })
    expect(found).toMatchObject({ path: link, uriPath: expected(link), kind: 'project' })

    // The same link into a credentials folder is refused: the real path is what is checked.
    const home = directory()
    mkdirSync(join(home, '.aws'))
    const environment: FolderRuleEnvironment = { platform: process.platform, home, env: {} }
    const sensitive = (path: string) => sensitiveFolderContaining(path, environment)
    forgetResolvedSensitiveFolders()
    const toAws = join(directory(), 'innocent')
    symlinkSync(join(home, '.aws'), toAws, windows ? 'junction' : 'dir')
    let thrown: unknown
    try {
      resolveEditorFolder({ threadId: 't1', threadDirectory: directory(), projectPath: toAws, sensitive })
    } catch (error) {
      thrown = error
    }
    forgetResolvedSensitiveFolders()
    expect(thrown).toMatchObject({ code: 'folder_protected', details: { threadId: 't1' } })
    expect(String((thrown as Error).message)).toContain('AWS credentials')
    for (const spelled of [toAws, home]) expect(String((thrown as Error).message)).not.toContain(spelled)
  })

  it('carries a folder name with `#`, `%`, a space and non-ASCII letters as it is spelled', () => {
    const name = join(directory(), 'a#b 100% café 日本')
    mkdirSync(name)
    const found = resolveEditorFolder({
      threadId: 't1',
      threadDirectory: directory(),
      projectPath: name
    })
    expect(found.path).toBe(name)
    expect(found.uriPath).toBe(expected(name))
    expect(found.uriPath).toContain('a#b 100% café 日本')
  })
})
