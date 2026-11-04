/**
 * Publish keeps the bytes it writes over in the person's checkout when Git converts them (`overwriteKeepingCopy`).
 * Every check brings the kept bytes back with the command the result shows, or reads the copy's blob, and compares the
 * bytes: a ref existing proves nothing.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, describe, expect, it } from 'vitest'
import { keptCopyRestoreCommand } from '../src/mms/actions/keptCopies'
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
function fixture(config: Record<string, string> = { 'core.autocrlf': 'input' }) {
  const n = ++count
  const cwd = join(root, `primary-${n}`), owner = join(root, `owner-${n}`), workspace = join(root, `worktree-${n}`)
  mkdirSync(cwd); mkdirSync(owner)
  git(cwd, 'init', '-q', '-b', 'main')
  for (const [key, value] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.invalid', 'commit.gpgsign': 'false', 'core.hooksPath': '/dev/null', ...config })) git(cwd, 'config', key, value)
  writeFileSync(join(cwd, 'base.txt'), 'base\n')
  writeFileSync(join(cwd, 'other.txt'), 'other\n')
  writeFileSync(join(cwd, 'gone.txt'), 'gone\n')
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
/** Runs the command `notice` shows for `path`, in the folder the copy names. */
function restoreFromNotice(notice: string, ref: string, top: string, path: string): void {
  const command = keptCopyRestoreCommand(ref, path, 'posix')
  expect(notice).toContain(command)
  execFileSync('sh', ['-c', command], { cwd: top })
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
