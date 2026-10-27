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
import { GitControlCache, loadGitControl } from '../src/mms/files/gitControl'
import { isInsidePath, lexicalGuard, type PathGuard } from '../src/mms/files/pathGuard'
import { PathContainmentError, RoutedGuard, isGitName, realPathOrAncestor, startsPrograms } from '../src/mms/files/routedGuard'
import { forgetResolvedSensitiveFolders, sensitiveFolderContaining } from '../src/mms/files/sensitiveFolders'

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

const refusal = (code: 'path_outside_folder' | 'path_protected' | 'path_needs_full_access') =>
  expect.objectContaining({ name: 'PathContainmentError', code })

const guard = new RoutedGuard()

/** Looks up what the repositories around a change say about hooks and configuration, as the handler does before a save. */
const ready = (g: RoutedGuard, root: string, path: string): Promise<void> => g.prepare(root, path, 'write')

describe('a path from another computer', () => {
  it('names a file inside the real folder, and says where relative to it', async () => {
    const { root } = scratch()
    mkdirSync(join(root, 'src'))
    await ready(guard, root, 'src/new.ts')
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

  it('treats a name that starts with two dots as a name, not a step up', async () => {
    const { root } = scratch()
    writeFileSync(join(root, '..cache'), 'x')
    mkdirSync(join(root, '..data'))
    await ready(guard, root, '..data/new.txt')
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

  it('refuses Mousse control files, in any case, and nothing else under .mousse', async () => {
    const { root } = scratch()
    for (const path of ['.mousse/task-progress.json', '.MOUSSE/Materialized-Inputs.Exclude'])
      expect(() => guard.resolve(root, path, 'write'), path).toThrow(refusal('path_protected'))
    await ready(guard, root, '.mousse/notes.md')
    expect(guard.resolve(root, '.mousse/notes.md', 'write').relative).toBe('.mousse/notes.md')
  })

  it('knows the names Windows gives Git\u2019s folder, and device and stream names', async () => {
    const win = new RoutedGuard({ windows: true })
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
    for (const path of ['console.ts', 'nullable.txt', 'com10.txt', 'a.b']) {
      const { root } = scratch()
      await ready(win, root, path)
      expect(() => win.resolve(root, path, 'write'), path).not.toThrow()
    }
    // Without the Windows rules a short name is an ordinary name.
    const { root } = scratch()
    await ready(posix, root, 'GIT~1/x')
    expect(posix.resolve(root, 'GIT~1/x', 'write').relative).toBe('GIT~1/x')
  })

  it('refuses a change to a file that has another name, which could be a hook under that name', async () => {
    const { root } = scratch()
    linkSync(join(root, 'a.txt'), join(root, 'b.txt'))
    const files = new FileService()
    await ready(guard, root, 'b.txt')
    await expect(files.writeFile(root, 'b.txt', 'changed\n', guard)).rejects.toEqual(refusal('path_protected'))
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('one\n')
    unlinkSync(join(root, 'b.txt'))
    await files.writeFile(root, 'a.txt', 'changed\n', guard)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('changed\n')
  })
})

describe('what Git reads from the folder that can run programs', () => {
  function repository(at?: string) {
    const s = scratch()
    const where = at ? join(s.root, at) : s.root
    mkdirSync(where, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: where })
    return { ...s, where }
  }
  const config = (root: string, ...args: string[]) => execFileSync('git', ['config', ...args], { cwd: root })
  const write = async (g: RoutedGuard, root: string, path: string) => {
    await ready(g, root, path)
    return g.resolve(root, path, 'write')
  }

  it('finds every core.hooksPath, from the top of the working tree when relative, and every included file', async () => {
    const { root, base } = repository()
    mkdirSync(join(root, 'sub'))
    expect(await loadGitControl(root)).toEqual({ hookFolders: [], configFiles: expect.any(Array) })
    config(root, 'core.hooksPath', '.githooks')
    expect((await loadGitControl(root)).hookFolders).toEqual([join(root, '.githooks')])
    // From a folder below the top it is still taken from the top.
    expect((await loadGitControl(join(root, 'sub'))).hookFolders).toEqual([join(root, '.githooks')])
    config(root, '--add', 'core.hooksPath', join(base, 'elsewhere'))
    expect((await loadGitControl(root)).hookFolders).toEqual([join(root, '.githooks'), join(base, 'elsewhere')])
    // An include that applies, and one that is named but does not apply (yet).
    writeFileSync(join(root, 'shared.gitconfig'), '[user]\n  name = shared\n')
    config(root, 'include.path', join(root, 'shared.gitconfig'))
    config(root, 'includeIf.gitdir:/nowhere/.path', '../later.gitconfig')
    const { configFiles } = await loadGitControl(root)
    expect(configFiles).toEqual(
      expect.arrayContaining([join(root, '.git', 'config'), join(root, 'shared.gitconfig'), join(root, 'later.gitconfig')])
    )
  })
  it('cannot be written to: not a hooks folder, not an included file, whichever is written first', async () => {
    const { root } = repository()
    const guarded = new RoutedGuard({ git: new GitControlCache() })
    config(root, 'core.hooksPath', '.githooks')
    mkdirSync(join(root, '.githooks'))
    for (const path of ['.githooks/pre-commit', '.githooks/new/dir/hook', './.githooks/../.githooks/pre-push'])
      await expect(write(guarded, root, path), path).rejects.toEqual(refusal('path_protected'))
    expect((await write(guarded, root, 'src/app.ts')).relative).toBe('src/app.ts')
    expect(guarded.resolve(root, '.githooks/pre-commit', 'read').relative).toBe('.githooks/pre-commit')
    // Through a link that leads into the folder as well.
    folderLink(join(root, '.githooks'), join(root, 'hooks-alias'))
    await expect(write(guarded, root, 'hooks-alias/pre-commit')).rejects.toEqual(refusal('path_protected'))
  })

  it('refuses the file a repository includes, at any limit, and the order hook first and config second leads nowhere', async () => {
    const { root } = repository()
    // The repository includes a file from its working tree, as monorepos do: relative to .git, so `../`.
    writeFileSync(join(root, 'shared.gitconfig'), '[user]\n  name = shared\n')
    config(root, 'include.path', '../shared.gitconfig')
    config(root, 'includeIf.gitdir:/nowhere/.path', '../later.gitconfig')
    const linked = fileLink(join(root, 'shared.gitconfig'), join(root, 'link.gitconfig'))
    for (const ceiling of ['ask', 'accept_edits', 'full'] as const) {
      const guarded = new RoutedGuard({ ceiling, git: new GitControlCache() })
      // The file that applies, and the one that could apply after a change of folder or branch.
      for (const path of ['shared.gitconfig', 'later.gitconfig', './sub/../shared.gitconfig'])
        await expect(write(guarded, root, path), `${ceiling} ${path}`).rejects.toEqual(refusal('path_protected'))
      // Through a link that leads to it.
      if (linked)
        await expect(write(guarded, root, 'link.gitconfig'), `${ceiling} link`).rejects.toEqual(refusal('path_protected'))
      // The first half of the order trick is an ordinary file, as it must be; the second half, which would make it a hook, is refused.
      expect((await write(guarded, root, 'scripts/pre-commit')).relative).toBe('scripts/pre-commit')
      await expect(write(guarded, root, 'shared.gitconfig')).rejects.toEqual(refusal('path_protected'))
    }
  })

  it("holds to a nested repository's own hooks folder and configuration", async () => {
    const { root, where } = repository('vendor/lib')
    config(where, 'core.hooksPath', 'h')
    writeFileSync(join(where, 'local.gitconfig'), '')
    config(where, 'include.path', '../local.gitconfig')
    const guarded = new RoutedGuard({ git: new GitControlCache() })
    await expect(write(guarded, root, 'vendor/lib/h/pre-commit')).rejects.toEqual(refusal('path_protected'))
    await expect(write(guarded, root, 'vendor/lib/local.gitconfig')).rejects.toEqual(refusal('path_protected'))
    await expect(write(guarded, root, 'vendor/lib/.git/config')).rejects.toEqual(refusal('path_protected'))
    expect((await write(guarded, root, 'vendor/lib/src/a.ts')).relative).toBe('vendor/lib/src/a.ts')
    expect((await write(guarded, root, 'other/pre-commit')).relative).toBe('other/pre-commit')
  })

  it('refuses a change when the settings cannot be read, rather than allowing it, and reads nothing twice in a short time', async () => {
    const { root } = scratch()
    let loads = 0
    let clock = 1_000
    const failing = new GitControlCache(
      async () => {
        loads += 1
        throw new Error('no git')
      },
      10_000,
      () => clock
    )
    const broken = new RoutedGuard({ git: failing })
    await ready(broken, root, 'a.txt')
    expect(() => broken.resolve(root, 'a.txt', 'write')).toThrow(refusal('path_protected'))
    expect(broken.resolve(root, 'a.txt', 'read').relative).toBe('a.txt')
    // Nobody looked: the same refusal.
    expect(() => new RoutedGuard({ git: new GitControlCache(async () => ({ hookFolders: [], configFiles: [] })) }).resolve(root, 'a.txt', 'write')).toThrow(
      refusal('path_protected')
    )

    const counted = new GitControlCache(
      async () => {
        loads += 1
        return { hookFolders: [], configFiles: [] }
      },
      10_000,
      () => clock
    )
    loads = 0
    await Promise.all([counted.prepare(root), counted.prepare(root)])
    await counted.prepare(root)
    expect(loads).toBe(1)
    clock += 10_001
    await counted.prepare(root)
    expect(loads).toBe(2)
  })
})

describe('files that start programs by themselves', () => {
  const programs = [
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.claude/hooks/pre-tool.sh',
    '.mcp.json',
    '.cursor/mcp.json',
    '.cursor/hooks.json',
    '.codex/config.toml',
    'opencode.json',
    '.husky/pre-commit',
    '.husky/_/husky.sh',
    'lefthook.yml',
    'lefthook-local.yaml',
    '.lefthook/pre-commit/lint.sh',
    '.pre-commit-config.yaml',
    '.mousse/workflows/release.json',
    'packages/app/.claude/settings.json',
    '.CLAUDE/Settings.JSON',
    'sub/.Husky/commit-msg'
  ]
  const ordinary = [
    'package.json',
    'Makefile',
    '.vscode/tasks.json',
    '.vscode/settings.json',
    '.envrc',
    '.github/workflows/ci.yml',
    '.gitlab-ci.yml',
    '.claude/commands/review.md',
    'CLAUDE.md',
    'src/app.ts',
    'docs/husky.md',
    'lefthook.md',
    'mcp.json.example'
  ]

  it('are named by one rule', () => {
    for (const path of programs) expect(startsPrograms(path), path).toBe(true)
    for (const path of ordinary) expect(startsPrograms(path), path).toBe(false)
  })

  it('are refused below Full access and allowed at Full access, from any folder', async () => {
    const { root } = scratch()
    for (const folder of ['.claude', '.claude/hooks', '.husky', '.cursor', '.codex', '.lefthook/pre-commit', '.mousse/workflows', 'packages/app/.claude'])
      mkdirSync(join(root, folder), { recursive: true })
    for (const ceiling of ['ask', 'accept_edits'] as const) {
      const limited = new RoutedGuard({ ceiling, git: new GitControlCache() })
      for (const path of programs)
        await expect(ready(limited, root, path).then(() => limited.resolve(root, path, 'write')), `${ceiling} ${path}`).rejects.toEqual(
          refusal('path_needs_full_access')
        )
      // They are readable, and ordinary files are writable, at the same limit.
      expect(limited.resolve(root, '.claude/settings.json', 'read').relative).toBe('.claude/settings.json')
      for (const path of ordinary) {
        await ready(limited, root, path)
        expect(limited.resolve(root, path, 'write').relative, path).toBe(path)
      }
    }
    const full = new RoutedGuard({ ceiling: 'full', git: new GitControlCache() })
    for (const path of programs) {
      await ready(full, root, path)
      // A file system that ignores case names the folder as it has it.
      expect(full.resolve(root, path, 'write').relative.toLowerCase(), path).toBe(path.toLowerCase())
    }
    // Git's own files are refused at every limit, Full access included.
    await expect(ready(full, root, '.git/hooks/x').then(() => full.resolve(root, '.git/hooks/x', 'write'))).rejects.toEqual(refusal('path_protected'))
  })
})

describe('a credentials folder inside a project that is already registered', () => {
  it('is not read or changed from another computer, whatever the project is', async () => {
    const { root } = scratch()
    const home = join(root, 'home')
    for (const folder of ['.ssh', '.config/gh', 'code', 'dotfiles/aws']) mkdirSync(join(home, folder), { recursive: true })
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'PRIVATE')
    writeFileSync(join(home, 'dotfiles', 'aws', 'credentials'), 'KEYS')
    writeFileSync(join(home, 'code', 'a.txt'), 'a')
    // ~/.aws is a link into the dotfiles, as it often is.
    folderLink(join(home, 'dotfiles', 'aws'), join(home, '.aws'))
    forgetResolvedSensitiveFolders()
    const environment = { platform: process.platform, home, env: {} }
    const guarded = new RoutedGuard({ git: new GitControlCache(), sensitive: (real) => sensitiveFolderContaining(real, environment) })
    // The project is the home folder.
    for (const path of ['.ssh/id_ed25519', '.aws/credentials', 'dotfiles/aws/credentials', '.config/gh/hosts.yml'])
      for (const intent of ['read', 'inspect'] as const)
        expect(() => guarded.resolve(home, path, intent), `${path} ${intent}`).toThrow(refusal('path_protected'))
    await ready(guarded, home, '.ssh/id_ed25519')
    expect(() => guarded.resolve(home, '.ssh/id_ed25519', 'write')).toThrow(refusal('path_protected'))
    expect(guarded.resolve(home, 'code/a.txt', 'read').relative).toBe('code/a.txt')
    // The same project is the owner's own business in a window of this computer.
    expect(lexicalGuard.resolve(home, '.ssh/id_ed25519', 'read').relative).toBe('.ssh/id_ed25519')
  })
})
describe('a path compared with the folder it is in', () => {
  it('does not take a sibling that differs only in case for the folder when file names are case sensitive', () => {
    expect(isInsidePath('/a/proj/x', '/a/Proj', false)).toBe(false)
    expect(isInsidePath('/a/Proj/x', '/a/Proj', false)).toBe(true)
    // A deny list folds case, which is the safe way round.
    expect(isInsidePath('/a/proj/x', '/a/Proj', true)).toBe(true)
  })
})

describe('a file written for another computer', () => {
  const files = new FileService()

  it('is created, replaced and counted like a local save', async () => {
    const { root } = scratch()
    await ready(guard, root, 'new.txt')
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

  it('counts the lines of a very large save by scanning, not by splitting both files', async () => {
    const { root } = scratch()
    await ready(guard, root, 'big.txt')
    // Above the size that is counted line by line, only the difference in lines is counted.
    const old = 'a line\n'.repeat(400_000)
    expect(Buffer.byteLength(old)).toBeGreaterThan(2 * 1024 * 1024)
    expect(await files.writeFile(root, 'big.txt', old, guard)).toBe(400_000)
    expect(await files.writeFile(root, 'big.txt', 'a line\n'.repeat(400_123), guard)).toBe(123)
    expect(readFileSync(join(root, 'big.txt'), 'utf8')).toBe('a line\n'.repeat(400_123))
    // A small file over a big one, and the reverse.
    expect(await files.writeFile(root, 'big.txt', 'short\n', guard)).toBe(400_122)
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
