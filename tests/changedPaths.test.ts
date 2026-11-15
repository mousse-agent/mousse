/**
 * A checkpoint lists the paths its turn changed, with each path's blob before and after, from one Git command however
 * many paths changed. Two commands per path held the repository's lease for minutes when a turn moved its branch by
 * many commits on a busy daemon. Real repository; the expected blobs are read from Git directly.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { changedPathsAsync, changedPathsSteps } from '../src/mms/actions/git'

describe('changedPaths', () => {
  let dir: string | undefined
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined })

  const repo = () => {
    dir = mkdtempSync(join(tmpdir(), 'mousse-changed-paths-'))
    const cwd = dir
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
    git('init', '-q')
    git('config', 'user.email', 'test@example.test')
    git('config', 'user.name', 'Test')
    // Git's porcelain diff quotes such paths and finds renames by default: neither may change what is listed.
    git('config', 'core.quotePath', 'true')
    git('config', 'diff.renames', 'true')
    const commit = () => { git('add', '-A'); git('commit', '-qm', 'c', '--allow-empty'); return git('rev-parse', 'HEAD') }
    const blob = (rev: string, path: string) => git('rev-parse', `${rev}:${path}`)
    return { cwd, git, commit, blob }
  }

  it('lists each changed path with its blobs on both sides', async () => {
    const r = repo()
    const w = (path: string, text: string) => writeFileSync(join(r.cwd, path), text)
    w('kept.txt', 'same\n'); w('edited.txt', 'before\n'); w('removed.txt', 'gone\n'); w('moved-from.txt', 'a file long enough to be found as a rename\n'); w('mode.sh', 'echo\n')
    const start = r.commit()
    w('edited.txt', 'after\n'); unlinkSync(join(r.cwd, 'removed.txt')); w('added.txt', 'new\n'); w('café é.txt', 'accents\n')
    r.git('mv', 'moved-from.txt', 'moved-to.txt')
    chmodSync(join(r.cwd, 'mode.sh'), 0o755)
    symlinkSync('kept.txt', join(r.cwd, 'link'))
    const end = r.commit()

    const listed = await changedPathsAsync(r.cwd, start, end)
    const byPath = Object.fromEntries(listed.map((change) => [change.path, change]))
    // Rows: added, removed, edited, mode only, non-ASCII name with a space, symlink, both sides of a rename. `kept.txt` is not listed.
    expect(Object.keys(byPath).sort()).toEqual(['added.txt', 'café é.txt', 'edited.txt', 'link', 'mode.sh', 'moved-from.txt', 'moved-to.txt', 'removed.txt'])
    expect(byPath['added.txt']).toEqual({ path: 'added.txt', afterHash: r.blob(end, 'added.txt') })
    expect(byPath['removed.txt']).toEqual({ path: 'removed.txt', beforeHash: r.blob(start, 'removed.txt') })
    expect(byPath['edited.txt']).toEqual({ path: 'edited.txt', beforeHash: r.blob(start, 'edited.txt'), afterHash: r.blob(end, 'edited.txt') })
    expect(byPath['mode.sh']).toEqual({ path: 'mode.sh', beforeHash: r.blob(start, 'mode.sh'), afterHash: r.blob(end, 'mode.sh') })
    expect(byPath['café é.txt']).toEqual({ path: 'café é.txt', afterHash: r.blob(end, 'café é.txt') })
    expect(byPath['link']).toEqual({ path: 'link', afterHash: r.blob(end, 'link') })
    expect(byPath['moved-from.txt']).toEqual({ path: 'moved-from.txt', beforeHash: r.blob(start, 'moved-from.txt') })
    expect(byPath['moved-to.txt']).toEqual({ path: 'moved-to.txt', afterHash: r.blob(end, 'moved-to.txt') })
    expect(await changedPathsAsync(r.cwd, end, end)).toEqual([])
  })

  it('runs one Git command however many paths changed', async () => {
    const r = repo()
    const start = r.commit()
    for (let index = 0; index < 200; index += 1) writeFileSync(join(r.cwd, `file-${index}.txt`), `${index}\n`)
    const end = r.commit()
    const steps = changedPathsSteps(r.cwd, start, end)
    let commands = 0
    let next = steps.next()
    while (!next.done) {
      commands += 1
      next = steps.next(await next.value.async())
    }
    expect(next.value).toHaveLength(200)
    expect(commands).toBe(1)
  })
})
