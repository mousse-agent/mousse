import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileService } from '../src/mms/files/FileService'
import { lexicalGuard, type PathGuard } from '../src/mms/files/pathGuard'
import {
  PathContainmentError,
  RoutedGuard,
  hookFolders,
  isGitName,
  realPathOrAncestor
} from '../src/mms/files/routedGuard'

const windows = process.platform === 'win32'
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

/** A folder to work in, and another beside it that nothing may reach. */
function scratch() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'guard-')))
  cleanups.push(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'root')
  const outside = join(base, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.txt'), 'secret\n')
  writeFileSync(join(root, 'a.txt'), 'one\n')
  return { base, root, outside }
}

/** A junction on Windows (no privilege needed) and a plain link elsewhere. */
const folderLink = (target: string, path: string): void =>
  symlinkSync(target, path, windows ? 'junction' : 'dir')

/** A link to a file, or false where this account may not make one (Windows without developer mode). */
function fileLink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, 'file')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false
    throw error
  }
}

const refusal = (code: 'path_outside_folder' | 'path_protected') =>
  expect.objectContaining({ name: 'PathContainmentError', code })

const guard = new RoutedGuard()

describe('a path from another computer', () => {
  it('names a file inside the real folder, and says where relative to it', () => {
    const { root } = scratch()
    mkdirSync(join(root, 'src'))
    expect(guard.resolve(root, 'a.txt', 'read')).toEqual({ absolute: join(root, 'a.txt'), relative: 'a.txt' })
    expect(guard.resolve(root, 'src/new.ts', 'write')).toEqual({
      absolute: join(root, 'src', 'new.ts'),
      relative: 'src/new.ts'
    })
    expect(guard.resolve(root, '', 'read')).toEqual({ absolute: root, relative: '' })
    expect(guard.resolve(root, '.', 'read').relative).toBe('')
  })

  it('refuses a way out of the folder, a path of another disk or share, and a device path', () => {
    const { root } = scratch()
    const refused = [
      '../outside/secret.txt',
      'src/../../outside/secret.txt',
      '..',
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      'C:/Windows/win.ini',
      '\\\\host\\share\\file.txt',
      '//host/share/file.txt',
      '\\\\?\\C:\\Windows\\win.ini',
      '\\\\?\\UNC\\host\\share\\file.txt',
      '\\\\.\\pipe\\anything',
      'a\0b',
      ...(windows ? ['..\\outside\\secret.txt'] : [])
    ]
    for (const path of refused)
      for (const intent of ['read', 'write', 'inspect'] as const)
        expect(() => guard.resolve(root, path, intent), `${JSON.stringify(path)} (${intent})`).toThrow(
          refusal('path_outside_folder')
        )
  })

  it('treats a name that starts with two dots as a name, not a step up', () => {
    const { root } = scratch()
    writeFileSync(join(root, '..cache'), 'x')
    mkdirSync(join(root, '..data'))
    expect(guard.resolve(root, '..cache', 'read').relative).toBe('..cache')
    expect(guard.resolve(root, '..data/new.txt', 'write').relative).toBe('..data/new.txt')
    // A window of this computer had the same false refusal.
    expect(lexicalGuard.resolve(root, '..cache', 'read').relative).toBe('..cache')
    expect(() => lexicalGuard.resolve(root, '..', 'read')).toThrow('Path is outside the project root')
  })

  it('refuses a link or junction that leads out of the folder, for a folder and for a file in it', () => {
    const { root, outside } = scratch()
    folderLink(outside, join(root, 'out'))
    for (const path of ['out', 'out/secret.txt', 'out/new.txt', 'out/deeper/new.txt'])
      for (const intent of ['read', 'write', 'inspect'] as const) {
        // Git and the review read a link at the end of a path as the link, so `out` itself is shown, not followed.
        if (path === 'out' && intent === 'inspect') continue
        expect(() => guard.resolve(root, path, intent), `${path} (${intent})`).toThrow(
          refusal('path_outside_folder')
        )
      }
    // The same link works for a window of this computer, which follows what the user linked.
    expect(readFileSync(lexicalGuard.resolve(root, 'out/secret.txt', 'read').absolute, 'utf8')).toBe('secret\n')
  })

  it('follows a link that stays inside the folder, and names the file it really is', () => {
    const { root } = scratch()
    mkdirSync(join(root, 'real'))
    writeFileSync(join(root, 'real', 'x.txt'), 'x')
    folderLink(join(root, 'real'), join(root, 'alias'))
    expect(guard.resolve(root, 'alias/x.txt', 'read')).toEqual({
      absolute: join(root, 'real', 'x.txt'),
      relative: 'real/x.txt'
    })
  })

  it('refuses a link that leads nowhere for a write, because the write would create what it points at', () => {
    const { root, outside } = scratch()
    if (!fileLink(join(outside, 'created.txt'), join(root, 'dangling'))) return
    for (const intent of ['read', 'write'] as const)
      expect(() => guard.resolve(root, 'dangling', intent)).toThrow(refusal('path_outside_folder'))
  })

  it('looks at a link at the end of a path as a link, for Git and the review, but not at a link above it', () => {
    const { root, outside } = scratch()
    folderLink(outside, join(root, 'out'))
    if (fileLink(join(outside, 'secret.txt'), join(root, 'secret-link.txt'))) {
      expect(guard.resolve(root, 'secret-link.txt', 'inspect').relative).toBe('secret-link.txt')
      expect(() => guard.resolve(root, 'secret-link.txt', 'read')).toThrow(refusal('path_outside_folder'))
    }
    expect(() => guard.resolve(root, 'out/secret.txt', 'inspect')).toThrow(refusal('path_outside_folder'))
  })

  it('works when the folder itself is spelled through a link', () => {
    const { base, root } = scratch()
    const alias = join(base, 'root-alias')
    folderLink(root, alias)
    // The root may be spelled through a link: what matters is where it really is.
    expect(guard.resolve(alias, 'a.txt', 'read')).toEqual({ absolute: join(root, 'a.txt'), relative: 'a.txt' })
  })
})

describe('what another computer may not change', () => {
  const refused = (path: string, g: RoutedGuard = guard) => {
    const { root } = scratch()
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
    return () => g.resolve(root, path, 'write')
  }

  it("refuses Git's own folder at any depth and in any case, and a worktree's .git file", () => {
    for (const path of [
      '.git/hooks/pre-commit',
      '.git/config',
      '.GIT/config',
      '.Git/hooks/post-checkout',
      'vendor/lib/.git/config',
      '.git'
    ])
      expect(refused(path), path).toThrow(refusal('path_protected'))
  })

  it('refuses it through a link that leads into it', () => {
    const { root } = scratch()
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
    folderLink(join(root, '.git', 'hooks'), join(root, 'docs'))
    expect(() => guard.resolve(root, 'docs/pre-commit', 'write')).toThrow(refusal('path_protected'))
    // Reading what is there is the Files panel's own view; only a change is refused.
    expect(guard.resolve(root, 'docs', 'read').relative).toBe('.git/hooks')
  })

  it('refuses Mousse control files, in any case, and nothing else under .mousse', () => {
    const { root } = scratch()
    for (const path of ['.mousse/task-progress.json', '.MOUSSE/Materialized-Inputs.Exclude'])
      expect(() => guard.resolve(root, path, 'write'), path).toThrow(refusal('path_protected'))
    expect(guard.resolve(root, '.mousse/notes.md', 'write').relative).toBe('.mousse/notes.md')
  })

  it('knows the names Windows gives Git\u2019s folder, and device and stream names', () => {
    const win = new RoutedGuard({ windows: true, caseless: true })
    const posix = new RoutedGuard({ windows: false })
    for (const name of ['.git', '.GIT', 'GIT~1', 'git~2', '.git.', '.git '])
      expect(isGitName(name, true), name).toBe(true)
    for (const name of ['.gitignore', 'git', 'gitx', 'GIT~', 'x.git', '.github'])
      expect(isGitName(name, true), name).toBe(false)
    // Elsewhere a short name is only a name, and case is still folded.
    expect(isGitName('GIT~1', false)).toBe(false)
    expect(isGitName('.GIT', false)).toBe(true)
    for (const path of ['GIT~1/hooks/pre-commit', '.git./config', '.git /config', '.git::$INDEX_ALLOCATION/x'])
      expect(refused(path, win), path).toThrow(PathContainmentError)
    for (const path of ['NUL', 'con.txt', 'Aux', 'COM1', 'lpt9.log', 'src/PRN.md', 'a:b', 'file.txt:stream', 'name.', 'name '])
      expect(refused(path, win), path).toThrow(refusal('path_outside_folder'))
    // Names that only look like those are fine.
    for (const path of ['console.ts', 'nullable.txt', 'com10.txt', 'a.b'])
      expect(() => win.resolve(scratch().root, path, 'write'), path).not.toThrow()
    // Without the Windows rules a short name is an ordinary name.
    expect(posix.resolve(scratch().root, 'GIT~1/x', 'write').relative).toBe('GIT~1/x')
  })

  it('refuses a change to a file that has another name, which could be a hook under that name', async () => {
    const { root } = scratch()
    linkSync(join(root, 'a.txt'), join(root, 'b.txt'))
    const files = new FileService()
    await expect(files.writeFile(root, 'b.txt', 'changed\n', guard)).rejects.toEqual(refusal('path_protected'))
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('one\n')
    unlinkSync(join(root, 'b.txt'))
    await files.writeFile(root, 'a.txt', 'changed\n', guard)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('changed\n')
  })
})

describe('the folders Git runs hooks from', () => {
  function repository() {
    const s = scratch()
    execFileSync('git', ['init', '-q'], { cwd: s.root })
    return s
  }
  const config = (root: string, ...args: string[]) => execFileSync('git', ['config', ...args], { cwd: root })

  it('are the real paths of every core.hooksPath, from the top of the working tree when relative', () => {
    const { root, base } = repository()
    expect(hookFolders(root)).toEqual([])
    mkdirSync(join(root, 'sub'))
    config(root, 'core.hooksPath', '.githooks')
    expect(hookFolders(root)).toEqual([join(root, '.githooks')])
    // From a folder below the top it is still taken from the top.
    expect(hookFolders(join(root, 'sub'))).toEqual([join(root, '.githooks')])
    config(root, '--add', 'core.hooksPath', join(base, 'elsewhere'))
    expect(hookFolders(root)).toEqual([join(root, '.githooks'), join(base, 'elsewhere')])
  })

  it('cannot be written to, and the repository can still be changed everywhere else', async () => {
    const { root } = repository()
    config(root, 'core.hooksPath', '.githooks')
    const strict = new RoutedGuard({ hookFolders })
    mkdirSync(join(root, '.githooks'))
    for (const path of ['.githooks/pre-commit', '.githooks/new/dir/hook', './.githooks/../.githooks/pre-push'])
      expect(() => strict.resolve(root, path, 'write'), path).toThrow(refusal('path_protected'))
    expect(strict.resolve(root, 'src/app.ts', 'write').relative).toBe('src/app.ts')
    expect(strict.resolve(root, '.githooks/pre-commit', 'read').relative).toBe('.githooks/pre-commit')
    // Through a link that leads into the folder as well.
    folderLink(join(root, '.githooks'), join(root, 'hooks-alias'))
    expect(() => strict.resolve(root, 'hooks-alias/pre-commit', 'write')).toThrow(refusal('path_protected'))
    // Without the setting the folder is an ordinary one.
    config(root, '--unset-all', 'core.hooksPath')
    expect(strict.resolve(root, '.githooks/pre-commit', 'write').relative).toBe('.githooks/pre-commit')
  })

  it('refuses a change when the setting cannot be read, rather than allowing it', () => {
    const { root } = scratch()
    const broken = new RoutedGuard({
      hookFolders: () => {
        throw new PathContainmentError('path_protected', 'could not be read')
      }
    })
    expect(() => broken.resolve(root, 'a.txt', 'write')).toThrow(refusal('path_protected'))
    expect(broken.resolve(root, 'a.txt', 'read').relative).toBe('a.txt')
    // Not a repository: nothing to run.
    expect(hookFolders(root)).toEqual([])
  })
})

describe('a file written for another computer', () => {
  const files = new FileService()

  it('is created, replaced and counted like a local save', async () => {
    const { root } = scratch()
    expect(await files.writeFile(root, 'new.txt', 'a\nb\n', guard)).toBeGreaterThan(0)
    expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('a\nb\n')
    // The lines counted are the same as a window's save of the same change.
    const local = new FileService()
    writeFileSync(join(root, 'twin.txt'), 'one\n')
    expect(await files.writeFile(root, 'a.txt', 'one\ntwo\n', guard)).toBe(await local.writeFile(root, 'twin.txt', 'one\ntwo\n'))
    // A shorter file replaces the longer one completely.
    await files.writeFile(root, 'a.txt', 'x', guard)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('x')
    // A multi-byte file is written whole.
    const text = '\u00e9\u4e2d\u6587\ud83d\ude00\n'.repeat(1000)
    await files.writeFile(root, 'a.txt', text, guard)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe(text)
  })

  it('never goes through a link put in the way after the path was checked', async () => {
    const { root, outside } = scratch()
    const victim = join(outside, 'secret.txt')
    if (!fileLink(victim, join(root, 'swapped'))) return
    // A guard that approves the spelling and was then outrun: the file it names is a link by the time it is opened.
    const outrun: PathGuard = {
      contained: true,
      resolve: () => ({ absolute: join(root, 'swapped'), relative: 'swapped' })
    }
    await expect(files.writeFile(root, 'swapped', 'overwritten\n', outrun)).rejects.toMatchObject({
      name: 'PathContainmentError'
    })
    expect(readFileSync(victim, 'utf8')).toBe('secret\n')
    // A name taken by a link between the check and the creation is not followed either, and nothing is left behind.
    const gone = join(outside, 'never-created.txt')
    if (fileLink(gone, join(root, 'fresh'))) {
      const fresh: PathGuard = { contained: true, resolve: () => ({ absolute: join(root, 'fresh'), relative: 'fresh' }) }
      await expect(files.writeFile(root, 'fresh', 'x', fresh)).rejects.toBeTruthy()
      expect(existsSync(gone)).toBe(false)
    }
  })

  it('reads and lists through the real path, and stats a file by its real name', async () => {
    const { root, outside } = scratch()
    mkdirSync(join(root, 'real'))
    writeFileSync(join(root, 'real', 'x.txt'), 'x')
    folderLink(join(root, 'real'), join(root, 'alias'))
    folderLink(outside, join(root, 'out'))
    expect((await files.listDir(root, 'alias', guard)).map((entry) => entry.path)).toEqual(['real/x.txt'])
    expect(await files.readFile(root, 'alias/x.txt', guard)).toBe('x')
    expect(await files.stat(root, 'alias/x.txt', guard)).toMatchObject({ path: 'real/x.txt', kind: 'file' })
    await expect(files.readFile(root, 'out/secret.txt', guard)).rejects.toMatchObject({ code: 'path_outside_folder' })
    await expect(files.listDir(root, 'out', guard)).rejects.toMatchObject({ code: 'path_outside_folder' })
    await expect(files.stat(root, 'out', guard)).rejects.toMatchObject({ code: 'path_outside_folder' })
    writeFileSync(join(outside, 'pic.png'), 'png')
    await expect(files.readAsset(root, 'out/pic.png', guard)).rejects.toMatchObject({ code: 'path_outside_folder' })
    await expect(files.readAssetRange(root, 'out/pic.png', 0, 10, guard)).rejects.toMatchObject({ code: 'path_outside_folder' })
    if (fileLink(join(outside, 'pic.png'), join(root, 'x.png')))
      await expect(files.readAsset(root, 'x.png', guard)).rejects.toMatchObject({ code: 'path_outside_folder' })
    // A window of this computer follows the same links.
    expect((await files.readAsset(root, 'out/pic.png')).size).toBe(3)
    expect(await files.readFile(root, 'out/secret.txt')).toBe('secret\n')
  })
})

describe.skipIf(!windows)('on Windows', () => {
  /** The 8.3 spelling of a path, or the path itself where the volume makes none. */
  const shortName = (path: string): string =>
    spawnSync('cmd', ['/d', '/s', '/c', `"for %I in ("${path}") do @echo %~sI"`], {
      encoding: 'utf8',
      windowsVerbatimArguments: true
    }).stdout.trim() || path

  it('knows a folder by its short name and in any case', () => {
    const { root } = scratch()
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
    const short = shortName(join(root, '.git'))
    // The short spelling of Git's folder is Git's folder, whether or not the volume makes one.
    expect(() => guard.resolve(root, `${short.split('\\').pop()}/hooks/pre-commit`, 'write')).toThrow(refusal('path_protected'))
    expect(() => guard.resolve(root, '.GIT\\HOOKS\\pre-commit', 'write')).toThrow(refusal('path_protected'))
    expect(guard.resolve(root, 'A.TXT', 'read')).toEqual({ absolute: join(root, 'a.txt'), relative: 'a.txt' })
    // A root spelled with its short name or in other case is still the same folder.
    for (const spelled of [shortName(root), root.toUpperCase(), root.toLowerCase()])
      expect(guard.resolve(spelled, 'a.txt', 'read').relative, spelled).toBe('a.txt')
  })

  it('refuses a junction, and a drive made with subst, that lead out of the folder', () => {
    const { root, outside } = scratch()
    folderLink(outside, join(root, 'junction'))
    expect(() => guard.resolve(root, 'junction/secret.txt', 'read')).toThrow(refusal('path_outside_folder'))
    const letter = 'YXWVUTSRQ'.split('').find((candidate) => !existsSync(`${candidate}:\\`))
    if (!letter) return
    execFileSync('subst', [`${letter}:`, outside])
    cleanups.push(() => spawnSync('subst', [`${letter}:`, '/d']))
    try {
      folderLink(`${letter}:\\`, join(root, 'drive'))
      expect(() => guard.resolve(root, 'drive/secret.txt', 'read')).toThrow(refusal('path_outside_folder'))
    } finally {
      spawnSync('subst', [`${letter}:`, '/d'])
    }
    expect(realPathOrAncestor(join(root, 'junction', 'x'))).toBe(join(outside, 'x'))
  })
})
