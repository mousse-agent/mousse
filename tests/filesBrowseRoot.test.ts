import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { dispatchMethod } from '../src/mms/protocol/handlers'
import type { ProtocolClientType } from '../src/mms/protocol/types'
import { folderAccess } from '../src/mms/files/folderAccess'
import { browsedRootRefusal, browsedSaveRefusal, normalizedBrowsedRoot } from '../src/mms/files/browsedRoot'
import { forgetFilesPlaces, listFilesPlaces, parseWindowsDrives } from '../src/mms/files/drives'
import { forgetResolvedSensitiveFolders } from '../src/mms/files/sensitiveFolders'
import { BROWSE_NEEDS_NEWER_SERVICE, browsedRootParams, browseSupport } from '../src/main/ipc/browsedRoot'
import { classifyRoutedMethod, ROUTED_FORBIDDEN_KEYS, ROUTED_METHODS } from '../src/shared/bridge/routed'

/**
 * The Files panel of a window on this computer can browse any folder of it (`root`), not only the thread's.
 * These tests hold who may name such a folder, which paths it may be, and where a save into it may land.
 */
describe('a folder the Files panel browses outside the thread', () => {
  let base: string
  let home: string
  let browsed: string
  let mms: MousseMainService

  beforeEach(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-files-browse-')))
    home = join(base, 'mousse-home')
    browsed = join(base, 'elsewhere')
    mkdirSync(home)
    mkdirSync(join(browsed, 'notes'), { recursive: true })
    writeFileSync(join(browsed, 'notes', 'todo.md'), 'buy milk\n')
    process.env.MOUSSE_HOME = home
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
  }, 30_000)

  afterEach(async () => {
    folderAccess.reset()
    await mms?.stop()
    delete process.env.MOUSSE_HOME
    rmSync(base, { recursive: true, force: true })
  })

  const as = (clientType: ProtocolClientType, bridge = false) => ({
    mms,
    globalSequence: () => 0,
    connection: {
      id: `conn-${clientType}`,
      capabilities: new Set<string>(),
      clientType,
      ...(bridge ? { bridgeCaller: { node: 'other-computer', user: 'me', maxPermissionMode: 'full' as const } } : {})
    }
  })
  const window = () => as('gui')
  const call = (ctx: ReturnType<typeof as>, method: string, params: Record<string, unknown>) => dispatchMethod(ctx as never, method, params)

  it('lists, reads, previews and saves there for a window of this computer, with no thread or project', async () => {
    const listed = await call(window(), 'files.list', { root: browsed, path: 'notes' }) as { entries: Array<{ name: string }> }
    expect(listed.entries.map((entry) => entry.name)).toEqual(['todo.md'])
    expect(await call(window(), 'files.read', { root: browsed, path: 'notes/todo.md' })).toMatchObject({ content: 'buy milk\n' })
    writeFileSync(join(browsed, 'dot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(await call(window(), 'files.readAsset', { root: browsed, path: 'dot.png' })).toMatchObject({ mimeType: 'image/png', size: 4 })
    await call(window(), 'files.writeDirect', { root: browsed, path: 'notes/todo.md', content: 'buy oat milk\n' })
    expect(readFileSync(join(browsed, 'notes', 'todo.md'), 'utf8')).toBe('buy oat milk\n')
  })

  it('resolves . and .. in the folder, and keeps every path of the call inside it', async () => {
    const listed = await call(window(), 'files.list', { root: join(browsed, 'notes', '..', '.', 'notes'), path: '' }) as { entries: Array<{ name: string }> }
    expect(listed.entries.map((entry) => entry.name)).toEqual(['todo.md'])
    await expect(call(window(), 'files.read', { root: join(browsed, 'notes'), path: '../../mousse-home/x' })).rejects.toThrow(/outside/)
    await expect(call(window(), 'files.writeDirect', { root: join(browsed, 'notes'), path: '../escaped.txt', content: 'x' })).rejects.toThrow(/outside/)
    expect(existsSync(join(browsed, 'escaped.txt'))).toBe(false)
    if (process.platform === 'win32')
      await expect(call(window(), 'files.read', { root: browsed, path: 'Z:\\other.txt' })).rejects.toThrow(/outside/)
  })

  it('is refused to the CLI, to an agent shell and to another computer, for reads and saves alike', async () => {
    for (const ctx of [as('cli'), as('test'), as('unknown'), as('bridge', true), as('gui', true)]) {
      for (const [method, params] of [
        ['files.list', { root: browsed, path: '' }],
        ['files.read', { root: browsed, path: 'notes/todo.md' }],
        ['files.readAsset', { root: browsed, path: 'notes/todo.md' }],
        ['files.writeDirect', { root: browsed, path: 'notes/new.txt', content: 'x' }],
        ['files.drives', {}]
      ] as const)
        await expect(call(ctx, method, params), `${ctx.connection.clientType} ${method}`).rejects.toMatchObject({ code: 'forbidden' })
    }
    expect(existsSync(join(browsed, 'notes', 'new.txt'))).toBe(false)
  })

  it('must be a full path of this computer, and a refused one is never touched', async () => {
    const probed: string[] = []
    folderAccess.reset({ probe: async (path) => { probed.push(path) }, commonDir: async () => null })
    const refused = process.platform === 'win32'
      ? ['notes', '.\\notes', '\\Users', 'C:Users', '\\\\server\\share', '//server/share', '\\\\?\\C:\\', '\\\\.\\PhysicalDrive0', '\\\\?\\UNC\\server\\share']
      : ['notes', './notes', '~/notes']
    for (const root of refused)
      await expect(call(window(), 'files.list', { root, path: '' }), root).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(call(window(), 'files.list', { root: `${browsed}\0x`, path: '' })).rejects.toMatchObject({ code: 'invalid_params' })
    // Nor is a folder another caller names.
    await expect(call(as('cli'), 'files.list', { root: browsed, path: '' })).rejects.toMatchObject({ code: 'forbidden' })
    expect(probed).toEqual([])
  })

  it('never saves into Git’s folder, the Mousse data folder, or through a link that leads there', async () => {
    mkdirSync(join(browsed, 'repo', '.git', 'hooks'), { recursive: true })
    await expect(call(window(), 'files.writeDirect', { root: join(browsed, 'repo'), path: '.git/hooks/pre-commit', content: 'x' }))
      .rejects.toMatchObject({ code: 'path_protected' })
    await expect(call(window(), 'files.writeDirect', { root: join(browsed, 'repo', '.git'), path: 'config', content: 'x' }))
      .rejects.toMatchObject({ code: 'path_protected' })
    await expect(call(window(), 'files.writeDirect', { root: home, path: 'settings.json', content: '{}' }))
      .rejects.toMatchObject({ code: 'path_protected' })
    await expect(call(window(), 'files.writeDirect', { root: base, path: 'mousse-home/new.json', content: '{}' }))
      .rejects.toMatchObject({ code: 'path_protected' })
    // A junction (Windows) or a symlink to the data folder inside the browsed folder.
    symlinkSync(home, join(browsed, 'data-link'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(call(window(), 'files.writeDirect', { root: browsed, path: 'data-link/planted.json', content: '{}' }))
      .rejects.toMatchObject({ code: 'path_protected' })
    expect(existsSync(join(home, 'planted.json'))).toBe(false)
    expect(existsSync(join(home, 'new.json'))).toBe(false)
    // Reading there stays possible: it is the person's own window.
    writeFileSync(join(browsed, 'repo', '.git', 'HEAD'), 'ref: refs/heads/main\n')
    expect(await call(window(), 'files.read', { root: join(browsed, 'repo'), path: '.git/HEAD' })).toMatchObject({ content: 'ref: refs/heads/main\n' })
  })

  it('fails at once on a drive that does not answer', async () => {
    folderAccess.reset({
      keyOf: (path) => (path.startsWith(browsed) ? 'stuck' : 'internal'),
      probe: async (path) => { if (path.startsWith(browsed)) await new Promise(() => undefined) },
      stuckAfterMs: 20
    })
    await expect(call(window(), 'files.list', { root: browsed, path: '' })).rejects.toMatchObject({ code: 'folder_not_answering' })
    await expect(call(window(), 'files.writeDirect', { root: browsed, path: 'x.txt', content: 'x' })).rejects.toMatchObject({ code: 'folder_not_answering' })
  })

  it('leaves a save without a browsed folder as it was', async () => {
    const project = mms.projects.openProject(browsed)
    await call(window(), 'files.writeDirect', { projectId: project.id, path: 'notes/plain.txt', content: 'x' })
    expect(readFileSync(join(browsed, 'notes', 'plain.txt'), 'utf8')).toBe('x')
  })

  it('lists this computer’s drives or volumes and its home folder for a window', async () => {
    forgetFilesPlaces()
    const places = await call(window(), 'files.drives', {}) as { home: string; drives: Array<{ path: string; label: string }> }
    expect(places.home).toBeTruthy()
    expect(places.drives.length).toBeGreaterThan(0)
    if (process.platform === 'win32') expect(places.drives.every((drive) => /^[A-Z]:\\$/.test(drive.path))).toBe(true)
    else expect(places.drives[0]).toEqual({ path: '/', label: '/' })
  }, 15_000)
})

describe('the rules for a browsed folder', () => {
  it('takes a drive path on Windows and a / path elsewhere, never a share or a device', () => {
    expect(browsedRootRefusal('C:\\Users\\me', 'win32')).toBeUndefined()
    expect(browsedRootRefusal('d:/notes', 'win32')).toBeUndefined()
    for (const root of ['\\\\nas\\media', '//nas/media', '\\\\?\\C:\\x', '\\\\.\\pipe\\mousse', '\\Users', 'C:Users', 'notes'])
      expect(browsedRootRefusal(root, 'win32'), root).toBeDefined()
    expect(browsedRootRefusal('/home/me', 'linux')).toBeUndefined()
    expect(browsedRootRefusal('//srv/share', 'linux')).toBeUndefined()
    for (const root of ['home/me', '~/x', 'C:\\x', '/a\0b']) expect(browsedRootRefusal(root, 'linux'), root).toBeDefined()
    expect(normalizedBrowsedRoot('C:\\a\\..\\..\\b\\.', 'win32')).toBe('C:\\b')
    expect(normalizedBrowsedRoot('/a/../../b/', 'linux')).toBe('/b')
  })

  it('refuses a save into the folders of the user’s sign-ins and keys', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-browse-keys-')))
    try {
      const environment = { home: base, platform: process.platform, env: {} }
      forgetResolvedSensitiveFolders()
      expect(browsedSaveRefusal(join(base, '.ssh', 'authorized_keys'), [], environment)).toMatch(/SSH keys/)
      expect(browsedSaveRefusal(join(base, 'notes', 'todo.md'), [], environment)).toBeUndefined()
      expect(browsedSaveRefusal(join(base, 'work', 'GIT~1', 'config'), [], environment) !== undefined).toBe(process.platform === 'win32')
    } finally {
      forgetResolvedSensitiveFolders()
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('is never part of a call from another computer', () => {
    expect(ROUTED_FORBIDDEN_KEYS).toContain('root')
    for (const [method, row] of Object.entries(ROUTED_METHODS)) expect(row.keys, method).not.toContain('root')
    expect(ROUTED_METHODS['files.drives']).toBeUndefined()
    expect(classifyRoutedMethod('files.drives')).toMatchObject({ kind: 'local' })
  })
})

describe('the Windows drive list', () => {
  it('keeps ready drives and network drives, and leaves out empty readers', () => {
    expect(parseWindowsDrives('C:\\|Fixed|True\r\nD:\\|CDRom|False\r\nz:\\|Network|Unknown\r\nnoise\r\n')).toEqual([
      { path: 'C:\\', label: 'C:' },
      { path: 'Z:\\', label: 'Z:' }
    ])
    expect(parseWindowsDrives('')).toEqual([])
  })

  it('is shared by calls close together', async () => {
    forgetFilesPlaces()
    const first = listFilesPlaces('linux', 1_000)
    expect(listFilesPlaces('linux', 2_000)).toBe(first)
    expect(listFilesPlaces('linux', 20_000)).not.toBe(first)
    forgetFilesPlaces()
  })
})

describe('a browsed folder sent from the main process', () => {
  it('goes only to a service that understands it, asked once per service', async () => {
    let instance = 'a'
    let asked = 0
    let methods = ['files.list']
    const supported = browseSupport(() => instance, async () => { asked += 1; return { methods } })
    expect(await browsedRootParams(undefined, supported)).toEqual({})
    expect(await browsedRootParams('', supported)).toEqual({})
    expect(asked).toBe(0)
    await expect(browsedRootParams('D:\\notes', supported)).rejects.toThrow(BROWSE_NEEDS_NEWER_SERVICE)
    await expect(browsedRootParams('D:\\notes', supported)).rejects.toThrow(BROWSE_NEEDS_NEWER_SERVICE)
    expect(asked).toBe(1)
    instance = 'b'
    methods = ['files.list', 'files.drives']
    expect(await browsedRootParams('D:\\notes', supported)).toEqual({ root: 'D:\\notes' })
    expect(asked).toBe(2)
  })

  it('asks again after the question failed', async () => {
    let fail = true
    const supported = browseSupport(() => 'a', async () => { if (fail) throw new Error('gone'); return { methods: ['files.drives'] } })
    await expect(browsedRootParams('/x', supported)).rejects.toThrow(BROWSE_NEEDS_NEWER_SERVICE)
    fail = false
    expect(await browsedRootParams('/x', supported)).toEqual({ root: '/x' })
  })
})
