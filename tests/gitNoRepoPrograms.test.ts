import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { git as mousseGit } from '../src/mms/actions/git'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { GitService } from '../src/mms/git/GitService'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { clearRepoProgramCache, guardedSimpleGit, repoProgramOverrides, repoProgramProbes, trustExistingProjectsOnce, trustRepositoryPrograms, withoutRepoPrograms, writesThroughFilters } from '../src/mms/git/repoPrograms'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { actionOptions, gitFoundationFixture } from './fixtures/gitFoundation'

/**
 * Programs a repository can name for Git to run, each planted the way an agent with only file access
 * could, and each leaving a marker when it runs. Plain Git runs every one of them (the controls);
 * the Git that Mousse runs runs none.
 */

const roots: string[] = []
const previousGlobal = process.env.GIT_CONFIG_GLOBAL
const previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM
let root: string
let markers: string
let marker: string

const plain = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const slash = (path: string): string => path.replace(/\\/g, '/')
/** A shell command that records `name` and passes its input through (as a clean filter must). */
const command = (name: string, passThrough = false): string => `node "${slash(marker)}" "${slash(join(markers, name))}"${passThrough ? ' cat' : ''}`
const ran = (): string[] => (existsSync(markers) ? readdirSync(markers).sort() : [])

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mousse-repo-programs-')); roots.push(root)
  markers = join(root, 'markers'); mkdirSync(markers)
  marker = join(root, 'marker.cjs')
  writeFileSync(marker, "require('node:fs').writeFileSync(process.argv[2], 'ran'); if (process.argv[3] === 'cat') process.stdin.pipe(process.stdout)\n")
  // The user's own global config for these tests: nothing but an identity.
  const global = join(root, 'global.gitconfig')
  writeFileSync(global, '[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n')
  process.env.GIT_CONFIG_GLOBAL = global
  clearRepoProgramCache()
})
afterEach(() => {
  if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = previousGlobal
  if (previousNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
  else process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function repo(name = 'repo'): string {
  const cwd = join(root, name); mkdirSync(cwd)
  plain(cwd, 'init', '-q', '-b', 'main')
  plain(cwd, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(cwd, 'a.txt'), 'a\n'); writeFileSync(join(cwd, 'b.txt'), 'b\n')
  plain(cwd, 'add', '.'); plain(cwd, 'commit', '-qm', 'base')
  return cwd
}

function writeHook(dir: string, event: string, name: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, event), `#!/bin/sh\n${command(name)}\n`, { mode: 0o755 })
}

/** Each way an agent could make a commit run a program, applied to `cwd`. Filters on a file being committed refuse the checkpoint instead. */
const COMMIT_PLANTS: Record<string, (cwd: string) => void> = {
  'a post-commit hook in the hooks folder': (cwd) => writeHook(join(cwd, '.git', 'hooks'), 'post-commit', 'post-commit'),
  'a husky-style relative hooks path': (cwd) => { plain(cwd, 'config', 'core.hooksPath', '.husky/_'); writeHook(join(cwd, '.husky', '_'), 'post-commit', 'husky') },
  'a hook defined in config': (cwd) => { plain(cwd, 'config', 'hook.planted.event', 'post-commit'); plain(cwd, 'config', 'hook.planted.command', command('config-hook')) },
  'a .git file pointing at a planted git folder': (cwd) => {
    // Outside the worktree, as an agent that can write anywhere could put it.
    const planted = `${cwd}-planted`
    renameSync(join(cwd, '.git'), planted)
    writeFileSync(join(cwd, '.git'), `gitdir: ${slash(planted)}\n`)
    writeHook(join(planted, 'hooks'), 'post-commit', 'pointer')
  },
  'core.fsmonitor': (cwd) => plain(cwd, 'config', 'core.fsmonitor', command('fsmonitor')),
  'a clean filter': (cwd) => { plain(cwd, 'config', 'filter.evil.clean', command('clean', true)); writeFileSync(join(cwd, '.gitattributes'), 'a.txt filter=evil\n') },
  'a process filter': (cwd) => { plain(cwd, 'config', 'filter.proc.process', command('process')); writeFileSync(join(cwd, '.gitattributes'), 'a.txt filter=proc\n') }
}

describe('a checkpoint commit runs no program the repository configures', () => {
  for (const [plant, apply] of Object.entries(COMMIT_PLANTS)) {
    it(`${plant}: plain Git runs it, Mousse's checkpoint commands do not`, () => {
      const control = repo('control'); apply(control)
      writeFileSync(join(control, 'a.txt'), 'changed\n')
      plain(control, 'add', '-A'); spawnSync('git', ['commit', '--no-verify', '-qm', 'control'], { cwd: control })
      expect(ran().length).toBe(1)
      rmSync(markers, { recursive: true }); mkdirSync(markers)

      const cwd = repo(); apply(cwd)
      writeFileSync(join(cwd, 'a.txt'), 'changed\n')
      const before = mousseGit(cwd, ['rev-parse', 'HEAD'])
      // The commands `ThreadActionService.checkpoint` runs.
      const checkpoint = () => {
        mousseGit(cwd, ['add', '-A', '--', '.', ':(exclude).mousse/**'])
        mousseGit(cwd, ['commit', '--no-verify', '-m', 'checkpoint'])
      }
      if (plant.includes('filter')) {
        // The file is not stored unfiltered: Git refuses it, and says why.
        expect(checkpoint).toThrow(/repository's own config defines the "(evil|proc)" filter/)
        expect(mousseGit(cwd, ['rev-parse', 'HEAD'])).toBe(before)
      } else {
        checkpoint()
        expect(mousseGit(cwd, ['rev-parse', 'HEAD'])).not.toBe(before)
        expect(mousseGit(cwd, ['status', '--porcelain'])).toBe('')
      }
      expect(ran()).toEqual([])
    })
  }
})

describe('reads run no program the repository configures', () => {
  /** fsmonitor, a clean filter and a process filter, with a file each that Git has to read again. */
  function plantedForReads(cwd: string): void {
    plain(cwd, 'config', 'core.fsmonitor', command('fsmonitor'))
    plain(cwd, 'config', 'filter.evil.clean', command('clean', true))
    plain(cwd, 'config', 'filter.proc.process', command('process'))
    writeFileSync(join(cwd, '.gitattributes'), 'a.txt filter=evil\nb.txt filter=proc\n')
    writeFileSync(join(cwd, 'a.txt'), 'a changed\n'); writeFileSync(join(cwd, 'b.txt'), 'b changed\n')
  }

  it('plain git status and diff run them (control)', () => {
    const cwd = repo(); plantedForReads(cwd)
    spawnSync('git', ['status', '--porcelain'], { cwd })
    spawnSync('git', ['diff', '--', 'a.txt'], { cwd })
    spawnSync('git', ['diff', '--', 'b.txt'], { cwd })
    expect(ran()).toEqual(['clean', 'fsmonitor', 'process'])
  })

  it("the Git panel's status poll and diffs do not", async () => {
    const cwd = repo(); plantedForReads(cwd)
    const service = new GitService()
    const status = await service.getStatus(cwd)
    expect(status.changes.map((change) => change.path).sort()).toEqual(expect.arrayContaining(['a.txt', 'b.txt']))
    expect(await service.getDiff(cwd, 'a.txt', false)).toContain('+a changed')
    expect(await service.getDiff(cwd, 'b.txt', false)).toContain('+b changed')
    await service.getDiffStats(cwd)
    expect(ran()).toEqual([])
  })

  it('an external diff and a textconv driver are not used by the diff view', async () => {
    const cwd = repo()
    plain(cwd, 'config', 'diff.external', command('external'))
    plain(cwd, 'config', 'diff.conv.textconv', command('textconv'))
    writeFileSync(join(cwd, '.gitattributes'), 'a.txt diff=conv\n')
    writeFileSync(join(cwd, 'a.txt'), 'a changed\n')
    expect(await new GitService().getDiff(cwd, 'a.txt', false)).toContain('+a changed')
    expect(ran()).toEqual([])
  })
})

describe('a real checkpoint', () => {
  let f: ReturnType<typeof gitFoundationFixture>
  beforeEach(() => { f = gitFoundationFixture() })
  afterEach(() => f.dispose())

  it('commits the turn without running a planted hook, config hook or fsmonitor', async () => {
    writeHook(join(f.repo, '.husky', '_'), 'post-commit', 'husky')
    plain(f.repo, 'add', '-A'); plain(f.repo, 'commit', '-qm', 'files an agent wrote')
    const cwd = (await new ThreadWorkspaceManager(f.thread).provision('task', 'main', f.repo)).worktreePath
    // The thread's worktree shares the repository's config, which an agent with file access can write.
    plain(f.repo, 'config', 'core.hooksPath', '.husky/_')
    plain(f.repo, 'config', 'hook.planted.event', 'post-commit'); plain(f.repo, 'config', 'hook.planted.command', command('config-hook'))
    plain(f.repo, 'config', 'core.fsmonitor', command('fsmonitor'))
    // A hook whose name cannot be written as `-c` does not stop the checkpoint, and does not run.
    plain(f.repo, 'config', 'hook.x=y.event', 'post-commit'); plain(f.repo, 'config', 'hook.x=y.command', command('odd-hook'))
    const start = plain(cwd, 'rev-parse', 'HEAD')
    const { action } = await new ThreadActionService(f.thread).runCheckpointedAction(actionOptions(cwd, 'turn-1'), () => writeFileSync(join(cwd, 'value.txt'), 'turn\n'))
    expect(action.endSha).not.toBe(start)
    expect(action.changedPaths.map((change) => change.path)).toEqual(['value.txt'])
    expect(ran()).toEqual([])
  })
})

describe('files under a filter only the repository defines are refused, never stored unfiltered', () => {
  /** A git-crypt-like filter: `git-crypt unlock` writes it to the repository's own config. */
  function cryptRepo(): string {
    const cwd = repo()
    plain(cwd, 'config', 'filter.crypt.clean', command('crypt-clean', true))
    plain(cwd, 'config', 'filter.crypt.smudge', command('crypt-smudge', true))
    plain(cwd, 'config', 'filter.crypt.required', 'true')
    writeFileSync(join(cwd, '.gitattributes'), 'secrets.env filter=crypt\n')
    writeFileSync(join(cwd, 'secrets.env'), 'TOKEN=one\n')
    plain(cwd, 'add', '-A'); plain(cwd, 'commit', '-qm', 'secrets')
    rmSync(markers, { recursive: true }); mkdirSync(markers)
    return cwd
  }

  it('a checkpoint refuses an edited git-crypt file, with a message, and stores nothing', () => {
    const cwd = cryptRepo()
    writeFileSync(join(cwd, 'secrets.env'), 'TOKEN=two\n')
    expect(() => mousseGit(cwd, ['add', '-A', '--', '.', ':(exclude).mousse/**'])).toThrow(/"crypt" filter .*instead of storing them unfiltered/)
    expect(plain(cwd, 'diff', '--cached', '--name-only')).toBe('')
    expect(ran()).toEqual([])
  })

  it("the user's own Stage runs the filter, as a terminal would", async () => {
    const cwd = cryptRepo()
    writeFileSync(join(cwd, 'secrets.env'), 'TOKEN=two\n')
    await new GitService().stageAll(cwd)
    expect(ran()).toEqual(['crypt-clean'])
  })

  it('a Git LFS installed only in the repository (git lfs install --local) is refused rather than stored as content', () => {
    // As for a user without a system or global LFS install.
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    const cwd = repo()
    plain(cwd, 'config', 'filter.lfs.clean', command('lfs-clean', true))
    plain(cwd, 'config', 'filter.lfs.smudge', command('lfs-smudge', true))
    plain(cwd, 'config', 'filter.lfs.process', command('lfs-process'))
    plain(cwd, 'config', 'filter.lfs.required', 'true')
    writeFileSync(join(cwd, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
    writeFileSync(join(cwd, 'big.bin'), 'x'.repeat(4096))
    expect(() => mousseGit(cwd, ['add', '-A'])).toThrow(/"lfs" filter/)
    expect(plain(cwd, 'ls-files', 'big.bin')).toBe('')
    expect(ran()).toEqual([])
    // A read compares the files as stored instead.
    expect(mousseGit(cwd, ['status', '--porcelain'])).toContain('big.bin')
    expect(ran()).toEqual([])
  })

  it('only commands that write through filters keep the filter required', () => {
    expect(writesThroughFilters(['add', '-A'])).toBe(true)
    expect(writesThroughFilters(['-c', 'x=y', 'commit', '-m', 'm'])).toBe(true)
    expect(writesThroughFilters(['worktree', 'add', 'p'])).toBe(true)
    expect(writesThroughFilters(['worktree', 'remove', 'p'])).toBe(false)
    expect(writesThroughFilters(['status', '--porcelain'])).toBe(false)
    expect(writesThroughFilters(['diff', '--cached'])).toBe(false)
    expect(writesThroughFilters(['hash-object', '--stdin'])).toBe(false)
    expect(writesThroughFilters(['hash-object', '-w', 'f'])).toBe(true)
  })
})

describe('a filter the repository had when the user added it runs; one added or changed later does not', () => {
  let f: ReturnType<typeof gitFoundationFixture>
  beforeEach(() => { f = gitFoundationFixture() })
  afterEach(() => f.dispose())

  /** A git-crypt-like filter in the repository's own config, with a file under it committed. */
  function withCrypt(cwd: string, clean = command('crypt-clean', true)): void {
    plain(cwd, 'config', 'filter.crypt.clean', clean)
    plain(cwd, 'config', 'filter.crypt.smudge', command('crypt-smudge', true))
    plain(cwd, 'config', 'filter.crypt.required', 'true')
    writeFileSync(join(cwd, '.gitattributes'), 'secrets.env filter=crypt\n')
    writeFileSync(join(cwd, 'secrets.env'), 'TOKEN=one\n')
    plain(cwd, 'add', '-A'); plain(cwd, 'commit', '-qm', 'secrets')
    rmSync(markers, { recursive: true }); mkdirSync(markers)
  }
  const projects = () => new ProjectManager(join(f.root, 'profile'))

  it('present when the project was added: the thread worktree and the checkpoint run it', async () => {
    withCrypt(f.repo)
    projects().openProject(f.repo)
    const cwd = (await new ThreadWorkspaceManager(f.thread).provision('task', 'main', f.repo)).worktreePath
    expect(ran()).toContain('crypt-smudge')
    const { action } = await new ThreadActionService(f.thread).runCheckpointedAction(actionOptions(cwd, 'turn-1'), () => writeFileSync(join(cwd, 'secrets.env'), 'TOKEN=two\n'))
    expect(action.changedPaths.map((change) => change.path)).toEqual(['secrets.env'])
    expect(ran()).toContain('crypt-clean')
  })

  it('added after the project was added: still refused, with how to trust it', () => {
    projects().openProject(f.repo)
    withCrypt(f.repo)
    writeFileSync(join(f.repo, 'secrets.env'), 'TOKEN=two\n')
    expect(() => mousseGit(f.repo, ['add', '-A'])).toThrow(/Trust Git settings again/)
    expect(ran()).toEqual([])
  })

  it('a changed command for a trusted filter is refused until the user trusts the settings again', () => {
    withCrypt(f.repo)
    const manager = projects()
    const project = manager.openProject(f.repo)
    plain(f.repo, 'config', 'filter.crypt.clean', command('changed-clean', true))
    writeFileSync(join(f.repo, 'secrets.env'), 'TOKEN=two\n')
    expect(() => mousseGit(f.repo, ['add', '-A'])).toThrow(/"crypt" filter/)
    expect(ran()).toEqual([])
    expect(manager.trustGitSettings(project.id)).toEqual({ filters: ['crypt'] })
    mousseGit(f.repo, ['add', '-A'])
    expect(ran()).toEqual(['changed-clean'])
  })

  it('projects added before this version are recorded once, on the first start', () => {
    withCrypt(f.repo)
    const profile = join(f.root, 'existing-profile')
    trustExistingProjectsOnce(profile, [f.repo])
    writeFileSync(join(f.repo, 'secrets.env'), 'TOKEN=two\n')
    mousseGit(f.repo, ['add', '-A'])
    expect(ran()).toEqual(['crypt-clean'])
    // A later start does not record a filter changed since.
    plain(f.repo, 'config', 'filter.crypt.clean', command('changed-clean', true))
    trustExistingProjectsOnce(profile, [f.repo])
    writeFileSync(join(f.repo, 'secrets.env'), 'TOKEN=three\n')
    expect(() => mousseGit(f.repo, ['add', '-A'])).toThrow(/"crypt" filter/)
  })
})

const hasLfs = spawnSync('git', ['lfs', 'version']).status === 0
const hasSafePython = spawnSync('python', ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)']).status === 0

describe('round 2: Git LFS programs, an unreadable config, and code loaded from the worktree', () => {
  /** Git LFS as the user installs it (here in the test's global config, as Git for Windows does in its system config). */
  function userLfs(): void {
    const global = process.env.GIT_CONFIG_GLOBAL!
    writeFileSync(global, `${readFileSync(global, 'utf8')}[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n`)
  }

  it.skipIf(!hasLfs)('an LFS extension the repository defines runs under plain Git, not in a checkpoint, which refuses the LFS file', () => {
    userLfs()
    const plant = (cwd: string) => {
      // Git LFS splits the command on spaces itself, without quotes (temporary folders have no spaces).
      plain(cwd, 'config', 'lfs.extension.x.clean', `node ${slash(marker)} ${slash(join(markers, 'lfs-extension'))} cat`)
      plain(cwd, 'config', 'lfs.extension.x.smudge', 'cat')
      plain(cwd, 'config', 'lfs.extension.x.priority', '0')
      writeFileSync(join(cwd, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
      writeFileSync(join(cwd, 'big.bin'), 'content\n')
    }
    const control = repo('control'); plant(control)
    spawnSync('git', ['add', '-A'], { cwd: control })
    expect(ran()).toEqual(['lfs-extension'])
    rmSync(markers, { recursive: true }); mkdirSync(markers)

    const cwd = repo(); plant(cwd)
    expect(() => mousseGit(cwd, ['add', '-A'])).toThrow(/"lfs" filter/)
    expect(ran()).toEqual([])
  })

  it.skipIf(!hasLfs)('an LFS custom transfer agent the repository names runs under plain Git, not in a worktree Mousse creates', () => {
    userLfs()
    const plant = (cwd: string) => {
      writeFileSync(join(cwd, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
      writeFileSync(join(cwd, 'big.bin'), 'version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n')
      plain(cwd, 'add', '-A'); plain(cwd, 'commit', '-qm', 'pointer without its object')
      plain(cwd, 'config', 'lfs.standalonetransferagent', 'x')
      plain(cwd, 'config', 'lfs.customtransfer.x.path', 'node')
      plain(cwd, 'config', 'lfs.customtransfer.x.args', `"${slash(marker)}" "${slash(join(markers, 'transfer'))}"`)
    }
    const control = repo('control'); plant(control)
    spawnSync('git', ['worktree', 'add', join(root, 'control-tree')], { cwd: control })
    expect(ran()).toEqual(['transfer'])
    rmSync(markers, { recursive: true }); mkdirSync(markers)

    const cwd = repo(); plant(cwd)
    try { mousseGit(cwd, ['worktree', 'add', join(root, 'tree')]) } catch { /* the object cannot be fetched */ }
    expect(ran()).toEqual([])
  })

  it('a config that cannot be read in full refuses the command instead of running it without the overrides', () => {
    const cwd = repo()
    // Harmless entries, enough that the listing is past what Mousse reads.
    writeFileSync(join(cwd, 'padding.cfg'), `[pad]\n${'\ta = b\n'.repeat(300_000)}`)
    plain(cwd, 'config', 'include.path', slash(join(cwd, 'padding.cfg')))
    plain(cwd, 'config', 'filter.z.clean', command('padded-filter', true))
    writeFileSync(join(cwd, '.gitattributes'), '*.txt filter=z\n')
    writeFileSync(join(cwd, 'a.txt'), 'changed\n')
    expect(() => mousseGit(cwd, ['add', '-A'])).toThrow(/could not be read in full/)
    expect(ran()).toEqual([])
  }, 60_000)

  it.skipIf(!hasSafePython)("a trusted `python -m` filter does not import a module an agent wrote in the worktree", () => {
    const plant = (cwd: string) => {
      plain(cwd, 'config', 'filter.nb.clean', 'python -m json.tool')
      writeFileSync(join(cwd, '.gitattributes'), '*.ipynb filter=nb\n')
      mkdirSync(join(cwd, 'json'))
      const write = `open(${JSON.stringify(slash(join(markers, 'planted-module')))}, 'w').write('ran')\n`
      writeFileSync(join(cwd, 'json', '__init__.py'), write)
      writeFileSync(join(cwd, 'json', 'tool.py'), write)
      writeFileSync(join(cwd, 'n.ipynb'), '{"cells": []}\n')
    }
    const control = repo('control'); plant(control)
    spawnSync('git', ['add', '-A'], { cwd: control })
    expect(ran()).toEqual(['planted-module'])
    rmSync(markers, { recursive: true }); mkdirSync(markers)

    const cwd = repo(); plant(cwd)
    trustRepositoryPrograms(cwd)
    mousseGit(cwd, ['add', '-A'])
    expect(ran()).toEqual([])
    expect(plain(cwd, 'cat-file', '-p', ':n.ipynb')).toContain('"cells"')
  })
})

describe("the user's own actions keep the repository's programs; Mousse's own commands do not", () => {
  it("a per-repo core.sshCommand (a second GitHub account) reaches the user's Fetch, not Mousse's own Git", async () => {
    const cwd = repo()
    plain(cwd, 'config', 'core.sshCommand', command('ssh'))
    plain(cwd, 'remote', 'add', 'origin', 'ssh://git@example.invalid/work/repo.git')
    expect(withoutRepoPrograms(cwd, ['fetch'])).toContain('core.sshcommand=ssh')
    await new GitService().fetch(cwd).catch(() => undefined)
    expect(ran()).toEqual(['ssh'])
  })

  it("the user's branch switch runs post-checkout; a checkout Mousse runs does not", async () => {
    const cwd = repo()
    plain(cwd, 'branch', 'other')
    writeHook(join(cwd, '.git', 'hooks'), 'post-checkout', 'post-checkout')
    mousseGit(cwd, ['checkout', '-q', 'other'])
    expect(ran()).toEqual([])
    await new GitService().checkout(cwd, 'main')
    expect(ran()).toEqual(['post-checkout'])
  })
})

describe('settings are worked out for each command', () => {
  it('a filter written between two commands on one simple-git does not run', async () => {
    const cwd = repo()
    const git = guardedSimpleGit(cwd)
    await git.status()
    plain(cwd, 'config', 'filter.z.clean', command('late-filter', true))
    writeFileSync(join(cwd, '.gitattributes'), '*.txt filter=z\n')
    writeFileSync(join(cwd, 'a.txt'), 'changed\n')
    expect(await git.diff(['--no-ext-diff', '--no-textconv', '--', 'a.txt'])).toContain('+changed')
    expect(ran()).toEqual([])
  })

  it("polling the main checkout's status reads the repository's config once, and a folder that is not a repository once", async () => {
    const cwd = repo()
    const service = new GitService()
    writeFileSync(join(cwd, 'a.txt'), 'changed\n')
    await service.getStatus(cwd)
    const warm = repoProgramProbes()
    for (let poll = 0; poll < 3; poll++) await service.getStatus(cwd)
    expect(repoProgramProbes()).toBe(warm)

    const folder = join(root, 'plain-folder'); mkdirSync(folder)
    mousseGit(cwd, ['rev-parse', 'HEAD'])
    await service.getStatus(folder)
    const once = repoProgramProbes()
    await service.getStatus(folder)
    expect(repoProgramProbes()).toBe(once)
  })
})

describe('normal behaviour is kept', () => {
  it('line endings: a CRLF file is committed with LF under core.autocrlf and reads back clean', async () => {
    const cwd = repo()
    plain(cwd, 'config', 'core.autocrlf', 'true')
    writeFileSync(join(cwd, '.gitattributes'), '* text=auto\n')
    writeFileSync(join(cwd, 'crlf.txt'), 'one\r\ntwo\r\n')
    mousseGit(cwd, ['add', '-A']); mousseGit(cwd, ['commit', '--no-verify', '-m', 'crlf'])
    expect(plain(cwd, 'cat-file', '-p', 'HEAD:crlf.txt')).toBe('one\ntwo')
    expect((await new GitService().getStatus(cwd)).changes).toEqual([])
  })

  it("a filter from the user's own config still runs (as Git LFS installed globally does), and a repository cannot redefine it", () => {
    writeFileSync(process.env.GIT_CONFIG_GLOBAL!, `${readFileSync(process.env.GIT_CONFIG_GLOBAL!, 'utf8')}[filter "mine"]\n\tclean = ${command('global-filter', true).replace(/"/g, '\\"')}\n\trequired = true\n`)
    const cwd = repo()
    writeFileSync(join(cwd, '.gitattributes'), '*.bin filter=mine\n')
    plain(cwd, 'config', 'filter.mine.clean', command('repo-filter', true))
    writeFileSync(join(cwd, 'big.bin'), 'content\n')
    mousseGit(cwd, ['add', '-A']); mousseGit(cwd, ['commit', '--no-verify', '-m', 'filtered'])
    expect(ran()).toEqual(['global-filter'])
    expect(plain(cwd, 'cat-file', '-p', 'HEAD:big.bin')).toBe('content')
  })

  it('LFS pointers stay as stored under the user\'s own Git LFS, and checkpoints still work', async () => {
    // The user's Git LFS, as a system install provides it; its clean filter passes a pointer through unchanged.
    // Without one, a repository-local install is refused (see above), so the machine's own config is left out.
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    const userFilter = (name: string): string => command(name, true).replace(/"/g, '\\"')
    writeFileSync(process.env.GIT_CONFIG_GLOBAL!, `${readFileSync(process.env.GIT_CONFIG_GLOBAL!, 'utf8')}[filter "lfs"]\n\tclean = ${userFilter('user-lfs-clean')}\n\tsmudge = ${userFilter('user-lfs-smudge')}\n\trequired = true\n`)
    const cwd = repo()
    const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n'
    writeFileSync(join(cwd, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
    writeFileSync(join(cwd, 'big.bin'), pointer)
    // A repository-local LFS install: its programs are the repository's, so they do not run.
    plain(cwd, 'config', 'filter.lfs.clean', command('repo-lfs-clean', true)); plain(cwd, 'config', 'filter.lfs.smudge', command('repo-lfs-smudge', true)); plain(cwd, 'config', 'filter.lfs.required', 'true')
    mousseGit(cwd, ['add', '-A']); mousseGit(cwd, ['commit', '--no-verify', '-m', 'pointer'])
    expect(plain(cwd, 'cat-file', '-p', 'HEAD:big.bin')).toBe(pointer.trim())
    expect((await new GitService().getStatus(cwd)).changes).toEqual([])
    writeFileSync(join(cwd, 'a.txt'), 'next\n')
    mousseGit(cwd, ['add', '-A']); mousseGit(cwd, ['commit', '--no-verify', '-m', 'next'])
    expect(mousseGit(cwd, ['status', '--porcelain'])).toBe('')
    expect(ran()).toEqual(['user-lfs-clean'])
  })
})

describe('repoProgramOverrides', () => {
  const entry = (scope: string, key: string, value: string | null = 'x') => ({ scope, origin: 'file:x', key, value })

  it("puts back the user's value for a key the repository redefines, and empties one only the repository defines", () => {
    const { overrides } = repoProgramOverrides([
      entry('system', 'filter.lfs.clean', 'git-lfs clean -- %f'),
      entry('local', 'filter.lfs.clean', 'evil'),
      entry('local', 'filter.evil.smudge', 'evil'),
      entry('global', 'gpg.program', 'C:/gpg/gpg.exe'),
      entry('local', 'gpg.program', 'evil'),
      entry('local', 'core.sshcommand', 'evil'),
      entry('local', 'remote.origin.uploadpack', 'evil'),
      entry('local', 'merge.ours.driver', 'evil')
    ])
    expect(overrides).toEqual([
      'filter.lfs.clean=git-lfs clean -- %f',
      'filter.evil.smudge=',
      'gpg.program=C:/gpg/gpg.exe',
      'core.sshcommand=ssh',
      'remote.origin.uploadpack=git-upload-pack',
      'merge.ours.driver=false'
    ])
  })

  it("leaves a filter the repository empties (a pull request's pinned worktree) empty, rather than putting the user's back", () => {
    expect(repoProgramOverrides([entry('global', 'filter.lfs.process', 'git-lfs filter-process'), entry('worktree', 'filter.lfs.process', '')]).overrides).toEqual([])
  })

  it("resets credential helpers to the user's own when the repository adds one", () => {
    const { overrides } = repoProgramOverrides([
      entry('global', 'credential.helper', 'manager'),
      entry('local', 'credential.helper', 'evil'),
      entry('local', 'credential.https://example.com.helper', 'evil')
    ])
    expect(overrides).toEqual(['credential.helper=', 'credential.helper=manager'])
  })

  it("keeps the user's own empty helper resets, in order, when it puts their helpers back", () => {
    const { overrides } = repoProgramOverrides([
      entry('system', 'credential.helper', 'manager'),
      entry('global', 'credential.https://github.com.helper', ''),
      entry('global', 'credential.https://github.com.helper', '!gh auth git-credential'),
      entry('local', 'credential.helper', 'evil')
    ])
    expect(overrides).toEqual(['credential.helper=', 'credential.helper=manager', 'credential.https://github.com.helper=', 'credential.https://github.com.helper=!gh auth git-credential'])
  })

  it('does not refuse a repository for a hook name that cannot be written as -c', () => {
    expect(repoProgramOverrides([entry('local', 'hook.x=y.event', 'post-commit')]).hookNames).toEqual([])
  })

  it('collects config-defined hook names from every scope', () => {
    expect(repoProgramOverrides([entry('global', 'hook.lint.command'), entry('local', 'hook.planted.event')]).hookNames).toEqual(['lint', 'planted'])
  })

  it('refuses a repository that sets core.gitProxy, which cannot be overridden', () => {
    expect(() => repoProgramOverrides([entry('local', 'core.gitproxy', 'evil')])).toThrow(/core\.gitproxy/)
  })
})
