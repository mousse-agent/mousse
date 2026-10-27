import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { git as mousseGit } from '../src/mms/actions/git'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { GitService } from '../src/mms/git/GitService'
import { clearRepoProgramCache, repoProgramOverrides } from '../src/mms/git/repoPrograms'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { actionOptions, gitFoundationFixture } from './fixtures/gitFoundation'

/**
 * Programs a repository can name for Git to run, each planted the way an agent with only file access
 * could, and each leaving a marker when it runs. Plain Git runs every one of them (the controls);
 * the Git that Mousse runs runs none.
 */

const roots: string[] = []
const previousGlobal = process.env.GIT_CONFIG_GLOBAL
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

/** Each way an agent could make a commit run a program, applied to `cwd`. */
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
      mousseGit(cwd, ['add', '-A', '--', '.', ':(exclude).mousse/**'])
      mousseGit(cwd, ['commit', '--no-verify', '-m', 'checkpoint'])
      expect(ran()).toEqual([])
      expect(mousseGit(cwd, ['rev-parse', 'HEAD'])).not.toBe(before)
      expect(mousseGit(cwd, ['status', '--porcelain'])).toBe('')
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

  it('commits the turn without running a planted hook, config hook, fsmonitor or filter', async () => {
    writeHook(join(f.repo, '.husky', '_'), 'post-commit', 'husky')
    writeFileSync(join(f.repo, '.gitattributes'), 'value.txt filter=evil\n')
    plain(f.repo, 'add', '-A'); plain(f.repo, 'commit', '-qm', 'files an agent wrote')
    const cwd = (await new ThreadWorkspaceManager(f.thread).provision('task', 'main', f.repo)).worktreePath
    // The thread's worktree shares the repository's config, which an agent with file access can write.
    plain(f.repo, 'config', 'core.hooksPath', '.husky/_')
    plain(f.repo, 'config', 'hook.planted.event', 'post-commit'); plain(f.repo, 'config', 'hook.planted.command', command('config-hook'))
    plain(f.repo, 'config', 'core.fsmonitor', command('fsmonitor'))
    plain(f.repo, 'config', 'filter.evil.clean', command('clean', true))
    const start = plain(cwd, 'rev-parse', 'HEAD')
    const { action } = await new ThreadActionService(f.thread).runCheckpointedAction(actionOptions(cwd, 'turn-1'), () => writeFileSync(join(cwd, 'value.txt'), 'turn\n'))
    expect(action.endSha).not.toBe(start)
    expect(action.changedPaths.map((change) => change.path)).toEqual(['value.txt'])
    expect(ran()).toEqual([])
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

  it('LFS pointers committed without a filter installed stay as stored, and checkpoints still work', async () => {
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
    expect(ran()).toEqual([])
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
      'merge.ours.driver=false',
      'filter.evil.required=false'
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

  it('collects config-defined hook names from every scope', () => {
    expect(repoProgramOverrides([entry('global', 'hook.lint.command'), entry('local', 'hook.planted.event')]).hookNames).toEqual(['lint', 'planted'])
  })

  it('refuses a repository that sets core.gitProxy, which cannot be overridden', () => {
    expect(() => repoProgramOverrides([entry('local', 'core.gitproxy', 'evil')])).toThrow(/core\.gitproxy/)
  })
})
