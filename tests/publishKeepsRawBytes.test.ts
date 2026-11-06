/**
 * Publish keeps the bytes it writes over in the person's checkout when Git converts them (`overwriteKeepingCopy`).
 * Every check brings the kept bytes back with the command the result shows, or reads the copy's blob, and compares the
 * bytes: a ref existing proves nothing.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, describe, expect, it } from 'vitest'
import { keptCopyRestoreCommand } from '../src/mms/actions/keptCopies'
import type { RestoreKind } from '../src/mms/actions/restoreCommands'
import { threadPreservedIndex } from '../src/mms/actions/preservedFiles'
import { PublishService, type PublishResult } from '../src/mms/actions/PublishService'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { CRASH_CHILD_REQUIRE } from './fixtures/gitFoundation'
import { pressed } from './support/userRequest'

process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_SYSTEM = '/dev/null'
process.env.MOUSSE_GIT_POLICY = 'refuse'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-publish-keeps-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
let count = 0

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const blob = (cwd: string, ref: string, path: string): Buffer => execFileSync('git', ['cat-file', 'blob', `${ref}:${path}`], { cwd })
const preserved = (cwd: string): string[] => git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/mousse/preserved/').split('\n').filter(Boolean)
const latest = (owner: string, id: string) => new ThreadJournal(owner).latestByOperation().get(id)

/**
 * The person's checkout (`main`, with base.txt and other.txt) and a thread's worktree beside it on its own branch, which
 * Publish brings into `main`. `config` is set in the checkout before anything is written.
 */
function fixture(config: Record<string, string> = { 'core.autocrlf': 'input' }, setup?: (cwd: string) => void) {
  const n = ++count
  const cwd = join(root, `primary-${n}`), owner = join(root, `owner-${n}`), workspace = join(root, `worktree-${n}`)
  mkdirSync(cwd); mkdirSync(owner)
  git(cwd, 'init', '-q', '-b', 'main')
  for (const [key, value] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.invalid', 'commit.gpgsign': 'false', 'core.hooksPath': '/dev/null', ...config })) git(cwd, 'config', key, value)
  writeFileSync(join(cwd, 'base.txt'), 'base\n')
  writeFileSync(join(cwd, 'other.txt'), 'other\n')
  writeFileSync(join(cwd, 'gone.txt'), 'gone\n')
  setup?.(cwd)
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base')
  git(cwd, 'worktree', 'add', '-q', '-b', 'mousse/source', workspace)
  return { cwd, owner, workspace, pre: git(cwd, 'rev-parse', 'HEAD') }
}

/** Writes `bytes` at `path` in the checkout, then stages it: Git's form is HEAD's, so the checkout is clean. */
function cleanRaw(cwd: string, path: string, bytes: string): Buffer {
  writeFileSync(join(cwd, path), bytes)
  git(cwd, 'add', path)
  expect(git(cwd, 'status', '--porcelain')).toBe('')
  return Buffer.from(bytes)
}

const publish = (f: { owner: string; workspace: string; cwd: string }, operationId: string): Promise<PublishResult> =>
  pressed('Publish', () => new PublishService(f.owner).publish(f.workspace, f.cwd, 'main', undefined, { operationId }))

/** A `git` on PATH that runs `script` (sh) when its arguments match the `case` pattern `when`, then the real Git. */
function launcher(when: string, script: string): string {
  const bin = join(root, `bin-${++count}`)
  mkdirSync(bin)
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in\n  ${when}) ${script} ;;\nesac\nexec '${realGit}' "$@"\n`, { mode: 0o755 })
  return bin
}
async function withPath<T>(bin: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.PATH
  try { process.env.PATH = `${bin}:${previous}`; return await run() } finally { process.env.PATH = previous }
}
/** The POSIX shells a person may paste a restore command into, of those installed here (`sh` always is). */
const SHELLS = ['sh', 'bash', 'zsh'].filter((shell) => shell === 'sh' || spawnSync(shell, ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0)
/** Runs the command `notice` shows for `path`, in the folder the copy names. */
function restoreFromNotice(notice: string, ref: string, top: string, path: string, kind?: RestoreKind, shell = 'sh'): void {
  const command = keptCopyRestoreCommand(ref, path, 'posix', kind)
  expect(notice).toContain(command)
  execFileSync(shell, ['-c', command], { cwd: top })
}

/**
 * Runs a publish in a child process that is killed (SIGKILL) when Git is asked for `when`, a `case` pattern; or, with
 * `phase` `before`/`after`, that exits around its `change-publish` `git_applied` record, with `script` run for `when`.
 */
async function publishCrashingAt(f: { owner: string; workspace: string; cwd: string }, when: string, operationId: string, crash: { phase: 'git' | 'before' | 'after'; script?: string } = { phase: 'git' }): Promise<void> {
  const bin = launcher(when, crash.script ?? 'kill -9 $PPID; exit 1')
  const configPath = join(root, `crash-${count}.json`)
  writeFileSync(configPath, JSON.stringify({ kind: 'publish', phase: crash.phase, thread: f.owner, repo: f.cwd, source: f.workspace, target: 'main', options: { operationId } }))
  const runner = join(root, `publish-crash-${count}.mjs`)
  await build({ entryPoints: ['tests/fixtures/git-foundation-operation-crash.ts'], outfile: runner, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', banner: { js: CRASH_CHILD_REQUIRE } })
  const home = join(root, `home-${count}`)
  mkdirSync(home)
  const child = spawnSync(process.execPath, [runner, configPath], { env: { ...process.env, MOUSSE_HOME: home, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8', timeout: 30_000 })
  if (crash.phase === 'git' || crash.script?.includes('kill -9')) expect(child.signal, child.stderr).toBe('SIGKILL')
  else expect(child.status, child.stderr).toBe(86)
}

/** A shell command that stages the blob of `bytes` at `path` in `cwd`'s index, as restoring a revision into the index only would. */
function stageBlob(cwd: string, path: string, bytes: string): string {
  const id = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd, input: bytes, encoding: 'utf8' }).trim()
  return `'${realGit}' -C '${cwd}' update-index --cacheinfo 100644,${id},${path}`
}

/** The copy a publish recorded holding before it emptied any path. */
function holdingOf(owner: string): { ref: string; files: string[]; kinds: Record<string, string> } {
  const entry = [...new ThreadJournal(owner).list()].reverse().find((item) => (item.details as { holding?: unknown } | undefined)?.holding)!
  return (entry.details as { holding: { ref: string; files: string[]; kinds: Record<string, string> } }).holding
}

describe('Publish keeps raw bytes Git converts in the person checkout', () => {
  it('R3-G: a CRLF file Git calls clean is kept, and the shown command brings it back byte for byte', async () => {
    const f = fixture()
    const original = cleanRaw(f.cwd, 'base.txt', 'base\r\n')
    writeFileSync(join(f.workspace, 'base.txt'), 'published\n')

    const result = await publish(f, 'publish-crlf')
    expect(result.state).toBe('completed')
    expect(readFileSync(join(f.cwd, 'base.txt'), 'utf8')).toBe('published\n')
    expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(result.publishSha)
    expect(git(f.cwd, 'status', '--porcelain')).toBe('')
    // Only the file whose bytes were not Git's form is named.
    expect(result.kept).toMatchObject({ files: ['base.txt'], windowMs: expect.any(Number) })
    const kept = result.kept!
    expect(blob(f.cwd, kept.ref, 'base.txt').equals(original)).toBe(true)
    expect(threadPreservedIndex(f.owner).owns(kept.ref)).toBe(true)
    expect([...new ThreadJournal(f.owner).latestByOperation().values()].find((entry) => entry.operationType === 'publish-keep')).toMatchObject({ state: 'completed', details: { ref: kept.ref } })
    expect(result.notice).toMatch(/^Publish wrote over base\.txt, whose bytes on disk were not exactly what Git holds for it .* is kept for 30 days as refs\/mousse\/preserved\//)
    restoreFromNotice(result.notice!, kept.ref, f.cwd, 'base.txt')
    expect(readFileSync(join(f.cwd, 'base.txt')).equals(original)).toBe(true)
  })

  it('a CRLF file the publish deletes is kept, and comes back byte for byte', async () => {
    const f = fixture()
    const original = cleanRaw(f.cwd, 'gone.txt', 'gone\r\n')
    rmSync(join(f.workspace, 'gone.txt'))

    const result = await publish(f, 'publish-delete')
    expect(result.state).toBe('completed')
    expect(existsSync(join(f.cwd, 'gone.txt'))).toBe(false)
    expect(git(f.cwd, 'status', '--porcelain')).toBe('')
    expect(result.kept?.files).toEqual(['gone.txt'])
    expect(blob(f.cwd, result.kept!.ref, 'gone.txt').equals(original)).toBe(true)
    restoreFromNotice(result.notice!, result.kept!.ref, f.cwd, 'gone.txt')
    expect(readFileSync(join(f.cwd, 'gone.txt')).equals(original)).toBe(true)
  })

  it('with merge.autostash set, a late CRLF save outside the publish stays exact and the index has no conflict', async () => {
    const f = fixture({ 'core.autocrlf': 'input', 'merge.autostash': 'true' })
    const original = cleanRaw(f.cwd, 'base.txt', 'base\r\n')
    writeFileSync(join(f.workspace, 'base.txt'), 'published\n')
    // The editor saves other.txt with CRLF while the copy is kept: Git's form is unchanged, so it reads as clean.
    const late = 'other\r\n'
    const bin = launcher(`*" update-ref --no-deref refs/mousse/preserved/"*`, `printf 'other\\r\\n' > '${f.cwd}/other.txt'`)

    const result = await withPath(bin, () => publish(f, 'publish-autostash'))
    expect(result.state).toBe('completed')
    expect(readFileSync(join(f.cwd, 'other.txt')).equals(Buffer.from(late))).toBe(true)
    expect(readFileSync(join(f.cwd, 'base.txt'), 'utf8')).toBe('published\n')
    expect(git(f.cwd, 'ls-files', '-u')).toBe('')
    expect(git(f.cwd, 'stash', 'list')).toBe('')
    expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(result.publishSha)
    restoreFromNotice(result.notice!, result.kept!.ref, f.cwd, 'base.txt')
    expect(readFileSync(join(f.cwd, 'base.txt')).equals(original)).toBe(true)
  })

  it('a save after the copy is kept goes into a fresh copy before Git runs; the earlier copy stays', async () => {
    const f = fixture()
    const original = cleanRaw(f.cwd, 'base.txt', 'base\r\n')
    writeFileSync(join(f.workspace, 'base.txt'), 'published\n')
    const saved = Buffer.from('saved after the copy 5d1a\r\n')
    const fired = join(root, `fired-${++count}`)
    const bin = launcher(`*" update-ref --no-deref refs/mousse/preserved/"*`, `if [ ! -e '${fired}' ]; then printf 'saved after the copy 5d1a\\r\\n' > '${f.cwd}/base.txt'; : > '${fired}'; fi`)

    const result = await withPath(bin, () => publish(f, 'publish-late-save'))
    expect(existsSync(fired)).toBe(true)
    expect(result.state).toBe('completed')
    expect(readFileSync(join(f.cwd, 'base.txt'), 'utf8')).toBe('published\n')
    const refs = preserved(f.cwd)
    expect(refs).toHaveLength(2)
    const earlier = refs.find((ref) => ref !== result.kept!.ref)!
    expect(blob(f.cwd, earlier, 'base.txt').equals(original)).toBe(true)
    restoreFromNotice(result.notice!, result.kept!.ref, f.cwd, 'base.txt')
    expect(readFileSync(join(f.cwd, 'base.txt')).equals(saved)).toBe(true)
  })

  it('a file that keeps changing refuses the publish, naming it, with the file and the branch as they are', async () => {
    const f = fixture()
    cleanRaw(f.cwd, 'base.txt', 'base\r\n')
    writeFileSync(join(f.workspace, 'base.txt'), 'published\n')
    // Every copy is out of date the moment it is named.
    const bin = launcher(`*" update-ref --no-deref refs/mousse/preserved/"*`, `printf 'save %s\\r\\n' "$$" > '${f.cwd}/base.txt'`)

    await expect(withPath(bin, () => publish(f, 'publish-changing'))).rejects.toMatchObject({ code: 'keep_copy_refused', message: expect.stringContaining('base.txt kept changing') })
    expect(readFileSync(join(f.cwd, 'base.txt'), 'utf8')).toMatch(/^save \d+\r\n$/)
    expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.pre)
    expect(latest(f.owner, 'publish-changing')?.state).toBe('cancelled')
  })

  it('Git failing while index.lock is held puts every removed file back byte for byte, and the branch does not move', async () => {
    const f = fixture()
    const base = cleanRaw(f.cwd, 'base.txt', 'base\r\n')
    const gone = cleanRaw(f.cwd, 'gone.txt', 'gone\r\n')
    writeFileSync(join(f.workspace, 'base.txt'), 'published\n')
    rmSync(join(f.workspace, 'gone.txt'))
    const lock = join(f.cwd, '.git', 'index.lock')
    // Another Git holds the index once the copy is kept, as an editor's Git would.
    const bin = launcher(`*" update-ref --no-deref refs/mousse/preserved/"*`, `: > '${lock}'`)
    try {
      await expect(withPath(bin, () => publish(f, 'publish-locked'))).rejects.toThrow(/index\.lock/)
    } finally { rmSync(lock, { force: true }) }
    expect(readFileSync(join(f.cwd, 'base.txt')).equals(base)).toBe(true)
    expect(readFileSync(join(f.cwd, 'gone.txt')).equals(gone)).toBe(true)
    expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.pre)
    expect(git(f.cwd, 'rev-parse', 'refs/heads/main')).toBe(f.pre)
    expect(git(f.cwd, 'status', '--porcelain')).toBe('')
    expect(latest(f.owner, 'publish-locked')?.state).toBe('cancelled')
  })

  it('a stop after files are removed and before the fast-forward: recovery puts them back byte for byte, naming one it cannot', async () => {
    const f = fixture()
    const base = cleanRaw(f.cwd, 'base.txt', 'base\r\n')
    const gone = cleanRaw(f.cwd, 'gone.txt', 'gone\r\n')
    writeFileSync(join(f.workspace, 'base.txt'), 'published\n')
    rmSync(join(f.workspace, 'gone.txt'))
    // Mousse stops (the computer turns off) as Git's fast-forward is about to start.
    const bin = launcher(`*" merge --ff-only "*`, `kill -9 $PPID; exit 1`)
    const configPath = join(root, `crash-${count}.json`)
    writeFileSync(configPath, JSON.stringify({ kind: 'publish', phase: 'git', thread: f.owner, repo: f.cwd, source: f.workspace, target: 'main', options: { operationId: 'publish-crash' } }))
    const runner = join(root, `publish-crash-${count}.mjs`)
    await build({ entryPoints: ['tests/fixtures/git-foundation-operation-crash.ts'], outfile: runner, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', banner: { js: CRASH_CHILD_REQUIRE } })
    const home = join(root, `home-${count}`)
    mkdirSync(home)
    const child = spawnSync(process.execPath, [runner, configPath], { env: { ...process.env, MOUSSE_HOME: home, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8', timeout: 30_000 })
    expect(child.signal, child.stderr).toBe('SIGKILL')
    // Stopped with both files removed and the branch where it was.
    expect(existsSync(join(f.cwd, 'base.txt'))).toBe(false)
    expect(existsSync(join(f.cwd, 'gone.txt'))).toBe(false)
    expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.pre)
    expect(latest(f.owner, 'publish-crash')).toMatchObject({ state: 'prepared', details: { holding: { files: ['base.txt', 'gone.txt'] } } })
    // Meanwhile something new is saved where gone.txt was.
    writeFileSync(join(f.cwd, 'gone.txt'), 'new\n')

    const settled = await new PublishService(f.owner).recoverPending(f.workspace, f.cwd)
    expect(settled).toEqual([{ operationId: 'publish-crash', state: 'cancelled', notRestored: ['gone.txt'] }])
    expect(readFileSync(join(f.cwd, 'base.txt')).equals(base)).toBe(true)
    expect(readFileSync(join(f.cwd, 'gone.txt'), 'utf8')).toBe('new\n')
    expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.pre)
    const record = latest(f.owner, 'publish-crash')!
    expect(record.state).toBe('cancelled')
    const reason = (record.details as { reason: string }).reason
    expect(reason).toContain('gone.txt could not be put back')
    // The command it names brings the kept bytes back.
    const holding = [...new ThreadJournal(f.owner).list()].reverse().find((entry) => (entry.details as { holding?: unknown } | undefined)?.holding)!
    const ref = (holding.details as { holding: { ref: string } }).holding.ref
    rmSync(join(f.cwd, 'gone.txt'))
    restoreFromNotice(reason, ref, f.cwd, 'gone.txt')
    expect(readFileSync(join(f.cwd, 'gone.txt')).equals(gone)).toBe(true)
    // A second recovery has nothing left to do.
    expect(await new PublishService(f.owner).recoverPending(f.workspace, f.cwd)).toEqual([])
  }, 60_000)

  it('a file that is not tracked where the publish adds one refuses, with nothing changed', async () => {
    const f = fixture()
    const base = cleanRaw(f.cwd, 'base.txt', 'base\r\n')
    writeFileSync(join(f.workspace, 'new.txt'), 'from the thread\n')
    writeFileSync(join(f.workspace, 'base.txt'), 'published\n')
    // The person's file appears after the checkout was found clean, before anything is kept.
    const mine = Buffer.from('my own new.txt\r\n')
    const bin = launcher(`*" merge-tree "*`, `printf 'my own new.txt\\r\\n' > '${f.cwd}/new.txt'`)

    await expect(withPath(bin, () => publish(f, 'publish-untracked'))).rejects.toMatchObject({ code: 'keep_copy_refused', message: expect.stringMatching(/^Publish was stopped: new\.txt is not tracked .* Nothing was changed\./) })
    expect(readFileSync(join(f.cwd, 'new.txt')).equals(mine)).toBe(true)
    expect(readFileSync(join(f.cwd, 'base.txt')).equals(base)).toBe(true)
    expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.pre)
    expect(preserved(f.cwd)).toEqual([])
    expect(latest(f.owner, 'publish-untracked')?.state).toBe('cancelled')
  })

  it('a repository that converts nothing fast-forwards as before: no copy, and no Git process of the keep runs', async () => {
    const f = fixture({})
    writeFileSync(join(f.workspace, 'base.txt'), 'published\n')
    rmSync(join(f.workspace, 'gone.txt'))
    const log = join(root, `git-log-${++count}`)
    const bin = launcher('*', `printf '%s\\0' "$*" >> '${log}'`)

    const result = await withPath(bin, () => publish(f, 'publish-plain'))
    expect(result.state).toBe('completed')
    expect(result.kept).toBeUndefined()
    expect(readFileSync(join(f.cwd, 'base.txt'), 'utf8')).toBe('published\n')
    // Each command as Mousse asked for it, without the `-c` settings and flags every run carries.
    const ran = readFileSync(log, 'utf8').split('\0').filter(Boolean).map((line) => line.replace(/^(?:(?:-c \S+|--no-optional-locks|--literal-pathspecs|--no-replace-objects) )*/, ''))
    // Between the publish commit and the fast-forward, the only Git processes added are the check's two reads: whether
    // autocrlf is on, and the attributes of the paths it writes. Before, only `branch --show-current` ran there; the write
    // set is the same `diff-tree` that looked for ignored files in the way.
    const commit = ran.findIndex((line) => line.startsWith('commit-tree ') && line.includes('-m Changes from a Mousse thread'))
    const merge = ran.findIndex((line) => line.startsWith('merge '))
    expect(ran.slice(commit + 1, merge + 1)).toEqual(['branch --show-current', 'config --get core.autocrlf', 'check-attr -z --stdin --all', `merge --ff-only --no-overwrite-ignore ${result.publishSha}`])
    expect(ran.filter((line) => line.startsWith('diff-tree '))).toEqual([`diff-tree -r -z --no-renames --name-status ${f.pre} ${git(f.cwd, 'rev-parse', `${result.publishSha}^{tree}`)}`])
    // Nothing of a keep anywhere: no copy, no proof, no other fast-forward.
    expect(ran.filter((line) => /refs\/mousse\/preserved|pack-objects|index-pack|hash-object|cat-file|--no-autostash/.test(line))).toEqual([])
    expect(preserved(f.cwd)).toEqual([])
    expect(readdirSync(join(f.cwd, '.git')).filter((name) => name.startsWith('mousse-keep-'))).toEqual([])
  })
})

describe('Publish over files Git converts: shapes, the index and recovery', () => {
  for (const [name, setup, change, check] of [
    ['a file that becomes a folder', (cwd: string) => writeFileSync(join(cwd, 'f2d'), 'file\n'), (w: string) => { rmSync(join(w, 'f2d')); mkdirSync(join(w, 'f2d')); writeFileSync(join(w, 'f2d', 'x'), 'x\n') }, (cwd: string) => expect(readFileSync(join(cwd, 'f2d', 'x'), 'utf8')).toBe('x\n')],
    ['a folder that becomes a file', (cwd: string) => { mkdirSync(join(cwd, 'd2f')); writeFileSync(join(cwd, 'd2f', 'y'), 'y\n') }, (w: string) => { rmSync(join(w, 'd2f'), { recursive: true }); writeFileSync(join(w, 'd2f'), 'now a file\n') }, (cwd: string) => expect(readFileSync(join(cwd, 'd2f'), 'utf8')).toBe('now a file\n')],
    ['a link that becomes a folder', (cwd: string) => symlinkSync('base.txt', join(cwd, 'lk')), (w: string) => { rmSync(join(w, 'lk')); mkdirSync(join(w, 'lk')); writeFileSync(join(w, 'lk', 'x'), 'x\n') }, (cwd: string) => expect(readFileSync(join(cwd, 'lk', 'x'), 'utf8')).toBe('x\n')],
    ['a folder that becomes a link', (cwd: string) => { mkdirSync(join(cwd, 'dl')); writeFileSync(join(cwd, 'dl', 'y'), 'y\n') }, (w: string) => { rmSync(join(w, 'dl'), { recursive: true }); symlinkSync('base.txt', join(w, 'dl')) }, (cwd: string) => expect(readlinkSync(join(cwd, 'dl'))).toBe('base.txt')]
  ] as const) {
    it(`${name}, with files already in Git's form, publishes; the old version stays in its commit and in the copy`, async () => {
      const f = fixture({ 'core.autocrlf': 'input' }, setup)
      change(f.workspace)
      const result = await publish(f, `publish-shape-${count}`)
      expect(result.state).toBe('completed')
      check(f.cwd)
      expect(git(f.cwd, 'status', '--porcelain')).toBe('')
      expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(result.publishSha)
      // Nothing was in other than Git's form, so nothing is named.
      expect(result.kept).toBeUndefined()
      expect(result.notice).toBeUndefined()
      // What was written over is still exactly in the commit the publish moved from, and in the copy kept to remove it.
      const [ref] = preserved(f.cwd)
      for (const path of git(f.cwd, 'ls-tree', '-r', '--name-only', f.pre).split('\n').filter((item) => /^(f2d|d2f|lk|dl)/.test(item))) {
        expect(blob(f.cwd, ref!, path).equals(blob(f.cwd, f.pre, path))).toBe(true)
      }
    })
  }

  it('a link whose target is its blob is held: a retargeted link is published with nothing kept or named', async () => {
    const f = fixture({ 'core.autocrlf': 'input' }, (cwd) => symlinkSync('base.txt', join(cwd, 'lk')))
    rmSync(join(f.workspace, 'lk')); symlinkSync('other.txt', join(f.workspace, 'lk'))
    const result = await publish(f, 'publish-link')
    expect(result.state).toBe('completed')
    expect(readlinkSync(join(f.cwd, 'lk'))).toBe('other.txt')
    expect(result.kept).toBeUndefined()
    expect(result.notice).toBeUndefined()
    expect(preserved(f.cwd)).toEqual([])
  })

  for (const [boundary, when] of [['after the copy is kept', `*" update-ref --no-deref refs/mousse/preserved/"*`], ['as the fast-forward starts', `*" merge --ff-only "*`]] as const) {
    it(`the published version staged ${boundary} still leaves the file on disk, and the copy restores the old bytes`, async () => {
      const f = fixture()
      const original = cleanRaw(f.cwd, 'base.txt', 'base\r\n')
      writeFileSync(join(f.workspace, 'base.txt'), 'published\n')
      const published = execFileSync('git', ['hash-object', '--stdin'], { cwd: f.cwd, input: 'published\n', encoding: 'utf8' }).trim()
      const fired = join(root, `fired-${++count}`)
      // Restoring that revision into the index only, as `git restore --staged --source` would.
      const bin = launcher(when, `if [ ! -e '${fired}' ]; then '${realGit}' -C '${f.cwd}' update-index --cacheinfo 100644,${published},base.txt; : > '${fired}'; fi`)

      const result = await withPath(bin, () => publish(f, `publish-staged-${count}`))
      expect(existsSync(fired)).toBe(true)
      expect(result.state).toBe('completed')
      expect(readFileSync(join(f.cwd, 'base.txt')).equals(Buffer.from('published\n'))).toBe(true)
      expect(result.notWritten).toBeUndefined()
      expect(git(f.cwd, 'status', '--porcelain')).toBe('')
      restoreFromNotice(result.notice!, result.kept!.ref, f.cwd, 'base.txt')
      expect(readFileSync(join(f.cwd, 'base.txt')).equals(original)).toBe(true)
    })
  }

  it('a checkout switched to another branch at the same commit after the copy refuses; files and both branches stay', async () => {
    const f = fixture()
    const original = cleanRaw(f.cwd, 'base.txt', 'base\r\n')
    git(f.cwd, 'branch', 'other')
    writeFileSync(join(f.workspace, 'base.txt'), 'published\n')
    const bin = launcher(`*" update-ref --no-deref refs/mousse/preserved/"*`, `'${realGit}' -C '${f.cwd}' symbolic-ref HEAD refs/heads/other`)

    await expect(withPath(bin, () => publish(f, 'publish-switched'))).rejects.toThrow(/left it/)
    expect(readFileSync(join(f.cwd, 'base.txt')).equals(original)).toBe(true)
    expect(git(f.cwd, 'rev-parse', 'refs/heads/main')).toBe(f.pre)
    expect(git(f.cwd, 'rev-parse', 'refs/heads/other')).toBe(f.pre)
    expect(latest(f.owner, 'publish-switched')?.state).toBe('cancelled')
  })

  it('an ignored file that appears where the publish adds one, after the ignored-file check, refuses with nothing changed', async () => {
    const f = fixture()
    const base = cleanRaw(f.cwd, 'base.txt', 'base\r\n')
    // Ignored in the person's checkout only (the rule ignores itself, so the checkout stays clean).
    writeFileSync(join(f.cwd, '.gitignore'), 'new.txt\n.gitignore\n')
    writeFileSync(join(f.workspace, 'new.txt'), 'from the thread\n')
    writeFileSync(join(f.workspace, 'base.txt'), 'published\n')
    const mine = Buffer.from('build output\r\n')
    const bin = launcher(`*" commit-tree "*"Changes from a Mousse thread"*`, `printf 'build output\\r\\n' > '${f.cwd}/new.txt'`)

    await expect(withPath(bin, () => publish(f, 'publish-ignored'))).rejects.toMatchObject({ code: 'keep_copy_refused', message: expect.stringMatching(/^Publish was stopped: new\.txt is not tracked .* Nothing was changed\./) })
    expect(readFileSync(join(f.cwd, 'new.txt')).equals(mine)).toBe(true)
    expect(readFileSync(join(f.cwd, 'base.txt')).equals(base)).toBe(true)
    expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.pre)
    expect(latest(f.owner, 'publish-ignored')?.state).toBe('cancelled')
  })

  /** An executable CRLF script the publish changes, and a link that becomes a folder (kept, as it overlaps). */
  function kindsFixture() {
    const f = fixture({ 'core.autocrlf': 'input' }, (cwd) => {
      writeFileSync(join(cwd, 'run.sh'), 'echo run\n'); chmodSync(join(cwd, 'run.sh'), 0o755)
      symlinkSync('base.txt', join(cwd, 'lk'))
    })
    const script = cleanRaw(f.cwd, 'run.sh', 'echo run\r\n')
    writeFileSync(join(f.workspace, 'run.sh'), 'echo published\n')
    rmSync(join(f.workspace, 'lk')); mkdirSync(join(f.workspace, 'lk')); writeFileSync(join(f.workspace, 'lk', 'x'), 'x\n')
    return { ...f, script }
  }
  const checkKinds = (cwd: string, script: Buffer): void => {
    expect(readFileSync(join(cwd, 'run.sh')).equals(script)).toBe(true)
    expect(statSync(join(cwd, 'run.sh')).mode & 0o777).toBe(0o755)
  }

  it('recovery names files it cannot put back with commands that make a link a link and keep 755, in sh, bash and zsh', async () => {
    const f = kindsFixture()
    await publishCrashingAt(f, `*" merge --ff-only "*`, 'publish-kinds')
    expect(lstatSync(join(f.cwd, 'run.sh'), { throwIfNoEntry: false })).toBeUndefined()
    expect(lstatSync(join(f.cwd, 'lk'), { throwIfNoEntry: false })).toBeUndefined()
    expect(holdingOf(f.owner)).toMatchObject({ files: ['run.sh'], kinds: { 'run.sh': 'executable', lk: 'link' } })
    // Something new is saved at both paths before recovery.
    writeFileSync(join(f.cwd, 'run.sh'), 'new\n'); writeFileSync(join(f.cwd, 'lk'), 'new\n')

    const settled = await new PublishService(f.owner).recoverPending(f.workspace, f.cwd)
    expect(settled).toEqual([{ operationId: 'publish-kinds', state: 'cancelled', notRestored: ['lk', 'run.sh'] }])
    const reason = (latest(f.owner, 'publish-kinds')!.details as { reason: string }).reason
    const { ref } = holdingOf(f.owner)
    for (const shell of SHELLS) {
      rmSync(join(f.cwd, 'run.sh')); rmSync(join(f.cwd, 'lk'))
      restoreFromNotice(reason, ref, f.cwd, 'run.sh', 'executable', shell)
      restoreFromNotice(reason, ref, f.cwd, 'lk', 'link', shell)
      checkKinds(f.cwd, f.script)
      expect(lstatSync(join(f.cwd, 'lk')).isSymbolicLink()).toBe(true)
      expect(readlinkSync(join(f.cwd, 'lk'))).toBe('base.txt')
    }
  }, 60_000)

  it('a publish that landed before its record: the recovered notice restores an executable as one, in sh, bash and zsh', async () => {
    const f = kindsFixture()
    await publishCrashingAt(f, `*" update-ref --no-deref refs/mousse/changes/"*`, 'publish-landed')
    expect(readFileSync(join(f.cwd, 'run.sh'), 'utf8')).toBe('echo published\n')

    const [settled] = await new PublishService(f.owner).recoverPending(f.workspace, f.cwd)
    expect(settled).toMatchObject({ state: 'completed', result: { kept: { files: ['run.sh'] } } })
    const result = (settled as { result: PublishResult }).result
    for (const shell of SHELLS) {
      restoreFromNotice(result.notice!, result.kept!.ref, f.cwd, 'run.sh', 'executable', shell)
      checkKinds(f.cwd, f.script)
    }
  }, 60_000)
})

describe('Publish over files Git converts: sparse checkouts, long paths and files Git skipped', () => {
  it('a cone-mode sparse checkout keeps the files outside its cone absent and flagged, as plain Git does', async () => {
    const f = fixture({ 'core.autocrlf': 'true' }, (cwd) => {
      mkdirSync(join(cwd, 'app')); writeFileSync(join(cwd, 'app', 'a.txt'), 'a\r\n')
      mkdirSync(join(cwd, 'lib')); writeFileSync(join(cwd, 'lib', 's.txt'), 's\r\n')
    })
    git(f.cwd, 'sparse-checkout', 'set', '--cone', 'app')
    expect(existsSync(join(f.cwd, 'lib', 's.txt'))).toBe(false)
    expect(readFileSync(join(f.workspace, 'lib', 's.txt'), 'utf8')).toBe('s\r\n')
    writeFileSync(join(f.workspace, 'lib', 's.txt'), 's changed\r\n')
    writeFileSync(join(f.workspace, 'lib', 'new.txt'), 'new\r\n')
    writeFileSync(join(f.workspace, 'app', 'a.txt'), 'a changed\r\n')

    const result = await publish(f, 'publish-sparse')
    expect(result.state).toBe('completed')
    expect(readFileSync(join(f.cwd, 'app', 'a.txt'), 'utf8')).toBe('a changed\r\n')
    expect(existsSync(join(f.cwd, 'lib', 's.txt'))).toBe(false)
    expect(existsSync(join(f.cwd, 'lib', 'new.txt'))).toBe(false)
    expect(git(f.cwd, 'ls-files', '-t', 'lib').split('\n').sort()).toEqual(['S lib/new.txt', 'S lib/s.txt'])
    expect(git(f.cwd, 'status', '--porcelain')).toBe('')
    expect(result.notWritten).toBeUndefined()
  })

  it('paths long enough to split the index listing into batches publish without a false change', async () => {
    const names = Array.from({ length: 37 }, (_, at) => `a${String(at).padStart(3, '0')}${'x'.repeat(196)}`), folder = 'z'.repeat(190)
    const f = fixture({ 'core.autocrlf': 'input' }, (cwd) => {
      for (const name of names) writeFileSync(join(cwd, name), 'base\n')
      mkdirSync(join(cwd, folder)); writeFileSync(join(cwd, folder, 'v'), 'child\n')
    })
    for (const name of names) writeFileSync(join(f.workspace, name), 'published\n')
    rmSync(join(f.workspace, folder), { recursive: true }); writeFileSync(join(f.workspace, folder), 'now a file\n')

    const result = await publish(f, 'publish-long-paths')
    expect(result.state).toBe('completed')
    for (const name of names) expect(readFileSync(join(f.cwd, name), 'utf8')).toBe('published\n')
    expect(readFileSync(join(f.cwd, folder), 'utf8')).toBe('now a file\n')
    expect(git(f.cwd, 'status', '--porcelain')).toBe('')
    // The folder's file was in Git's form: still in the commit the publish moved from, and in the copy that removed it.
    expect(blob(f.cwd, preserved(f.cwd)[0]!, `${folder}/v`).equals(blob(f.cwd, f.pre, `${folder}/v`))).toBe(true)
  })

  it('a stop after Git skipped a removed file (its new version staged): recovery writes it, and the copy restores the old bytes', async () => {
    const f = fixture()
    const original = cleanRaw(f.cwd, 'base.txt', 'base\r\n')
    writeFileSync(join(f.workspace, 'base.txt'), 'published\n')
    // The published version is staged as the fast-forward starts; Mousse stops right after Git succeeds.
    await publishCrashingAt(f, `*" merge --ff-only "*`, 'publish-skipped', { phase: 'git', script: `${stageBlob(f.cwd, 'base.txt', 'published\n')}; '${realGit}' "$@"; kill -9 $PPID; exit 1` })
    expect(existsSync(join(f.cwd, 'base.txt'))).toBe(false)
    const head = git(f.cwd, 'rev-parse', 'HEAD'), index = readFileSync(join(f.cwd, '.git', 'index'))

    const [settled] = await new PublishService(f.owner).recoverPending(f.workspace, f.cwd)
    expect(settled).toMatchObject({ state: 'completed' })
    const result = (settled as { result: PublishResult }).result
    expect(result.notWritten).toBeUndefined()
    expect(readFileSync(join(f.cwd, 'base.txt')).equals(Buffer.from('published\n'))).toBe(true)
    expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(head)
    expect(readFileSync(join(f.cwd, '.git', 'index')).equals(index)).toBe(true)
    restoreFromNotice(result.notice!, result.kept!.ref, f.cwd, 'base.txt')
    expect(readFileSync(join(f.cwd, 'base.txt')).equals(original)).toBe(true)
    expect(await new PublishService(f.owner).recoverPending(f.workspace, f.cwd)).toEqual([])
  }, 60_000)

  it('a skipped file recovery cannot write is named in notWritten, with the command that restores its old bytes', async () => {
    const f = fixture()
    const original = cleanRaw(f.cwd, 'base.txt', 'base\r\n')
    writeFileSync(join(f.workspace, 'base.txt'), 'published\n')
    await publishCrashingAt(f, `*" merge --ff-only "*`, 'publish-skipped-failing', { phase: 'git', script: `${stageBlob(f.cwd, 'base.txt', 'published\n')}; '${realGit}' "$@"; kill -9 $PPID; exit 1` })
    // Git cannot write the file during recovery either.
    const failing = launcher(`*" cat-file --filters "*`, 'exit 1')
    const [settled] = await withPath(failing, () => new PublishService(f.owner).recoverPending(f.workspace, f.cwd))
    const result = (settled as { result: PublishResult }).result
    expect(result).toMatchObject({ state: 'completed', notWritten: ['base.txt'] })
    expect(existsSync(join(f.cwd, 'base.txt'))).toBe(false)
    expect(result.notice).toContain('base.txt could not be written by the publish')
    restoreFromNotice(result.notice!, result.kept!.ref, f.cwd, 'base.txt')
    expect(readFileSync(join(f.cwd, 'base.txt')).equals(original)).toBe(true)
  }, 60_000)

  for (const phase of ['before', 'after'] as const) {
    it(`a stop ${phase} the publish's receipt is applied, when writing a skipped file had failed: recovery writes it`, async () => {
      const f = fixture()
      const original = cleanRaw(f.cwd, 'base.txt', 'base\r\n')
      writeFileSync(join(f.workspace, 'base.txt'), 'published\n')
      const stage = stageBlob(f.cwd, 'base.txt', 'published\n')
      await publishCrashingAt(f, '*', `publish-receipt-${phase}`, { phase, script: `case " $* " in *" merge --ff-only "*) ${stage} ;; *" cat-file --filters "* | *" checkout-index "*) exit 1 ;; esac` })
      expect(existsSync(join(f.cwd, 'base.txt'))).toBe(false)

      const [settled] = await new PublishService(f.owner).recoverPending(f.workspace, f.cwd)
      const result = (settled as { result: PublishResult }).result
      expect(result.state).toBe('completed')
      expect(readFileSync(join(f.cwd, 'base.txt')).equals(Buffer.from('published\n'))).toBe(true)
      expect(blob(f.cwd, result.kept!.ref, 'base.txt').equals(original)).toBe(true)
    }, 60_000)
  }

  it('a skipped file whose folder is replaced by a later save is named in notWritten; the save stays exact', async () => {
    const f = fixture({ 'core.autocrlf': 'input' }, (cwd) => { mkdirSync(join(cwd, 'dir')); writeFileSync(join(cwd, 'dir', 'value'), 'old\n') })
    cleanRaw(f.cwd, 'dir/value', 'old\r\n')
    writeFileSync(join(f.workspace, 'dir', 'value'), 'published\n')
    const save = Buffer.from('later parent save\r\n')
    const bin = launcher('*', `case " $* " in *" merge --ff-only "*) ${stageBlob(f.cwd, 'dir/value', 'published\n')} ;; *" ls-tree "*) if [ ! -e '${f.cwd}/dir/value' ] && [ -d '${f.cwd}/dir' ]; then rmdir '${f.cwd}/dir'; printf 'later parent save\\r\\n' > '${f.cwd}/dir'; fi ;; esac`)

    const result = await withPath(bin, () => publish(f, 'publish-blocked-parent'))
    expect(result.state).toBe('completed')
    expect(readFileSync(join(f.cwd, 'dir')).equals(save)).toBe(true)
    expect(result.notWritten).toEqual(['dir/value'])
    expect(result.notice).toContain('dir/value could not be written by the publish')
  })
})
