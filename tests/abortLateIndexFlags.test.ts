/**
 * Abort decides what it removes on the index as it is after its copy is kept: a flag set while the copy is kept never
 * leaves a tracked file missing. Every check reads the file back, and the copy's blob, as bytes.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { type KeptCopy } from '../src/mms/actions/keptCopies'
import { GitService } from '../src/mms/git/GitService'
import { userAction } from '../src/mms/git/gitPolicy'

process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_SYSTEM = '/dev/null'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-abort-flags-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const blob = (cwd: string, ref: string, path: string): Buffer => execFileSync('git', ['cat-file', 'blob', `${ref}:${path}`], { cwd })
const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
let count = 0

/** A conflicted merge or rebase stop in a new repository, with `other` written by the abort, and a CRLF hand resolution. */
function stopped(kind: 'merge' | 'rebase'): { cwd: string; keeper: string; resolution: Buffer } {
  const cwd = join(root, `repo-${++count}`), keeper = join(root, `owner-${count}`)
  mkdirSync(cwd); mkdirSync(keeper)
  git(cwd, 'init', '-q', '-b', 'main')
  for (const [key, value] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.invalid', 'commit.gpgsign': 'false', 'core.hooksPath': '/dev/null', 'core.autocrlf': 'input' })) git(cwd, 'config', key, value)
  writeFileSync(join(cwd, 'base.txt'), 'base\n'); writeFileSync(join(cwd, 'other'), 'old other\n')
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base')
  git(cwd, 'checkout', '-q', '-b', 'feature'); writeFileSync(join(cwd, 'base.txt'), 'feature\n'); writeFileSync(join(cwd, 'other'), 'feature other\n'); git(cwd, 'commit', '-qam', 'feature')
  git(cwd, 'checkout', '-q', 'main'); writeFileSync(join(cwd, 'base.txt'), 'main\n'); git(cwd, 'commit', '-qam', 'main')
  if (kind === 'rebase') git(cwd, 'checkout', '-q', 'feature')
  expect(() => git(cwd, kind, kind === 'rebase' ? 'main' : 'feature')).toThrow()
  const resolution = Buffer.from('hand resolution\r\n')
  writeFileSync(join(cwd, 'base.txt'), resolution)
  return { cwd, keeper, resolution }
}

/** Runs the abort with a `git` on PATH that sets `flag` on `other` once, when Git is asked for `when` and `ready` (sh) holds. */
async function abortWithFlag(s: { cwd: string; keeper: string }, kind: 'merge' | 'rebase', flag: string, when: string, ready = 'true'): Promise<KeptCopy> {
  const bin = join(root, `bin-${++count}`), fired = join(bin, 'fired')
  mkdirSync(bin)
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in\n  ${when}) if [ ! -e '${fired}' ] && ${ready}; then '${realGit}' -C '${s.cwd}' update-index ${flag} other; : > '${fired}'; fi ;;\nesac\nexec '${realGit}' "$@"\n`, { mode: 0o755 })
  const previous = process.env.PATH
  try {
    process.env.PATH = `${bin}:${previous}`
    return (await new GitService().abortInProgress(s.cwd, userAction('button', 'Abort'), kind, { owner: s.keeper }))!
  } finally {
    process.env.PATH = previous
    expect(existsSync(fired)).toBe(true)
  }
}

for (const flag of ['--skip-worktree', '--assume-unchanged']) {
  it(`merge Abort with ${flag} set on a removed file right before Git starts completes as plain Git does`, async () => {
    const s = stopped('merge')
    // The last check reads what the index stages; by then Mousse has removed `other`.
    const kept = await abortWithFlag(s, 'merge', flag, `*" diff-index -z --cached --name-only --no-renames "*`, `[ ! -e '${s.cwd}/other' ]`)
    expect(readFileSync(join(s.cwd, 'other'), 'utf8')).toBe('old other\n')
    expect(existsSync(join(s.cwd, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(blob(s.cwd, kept.ref, 'base.txt').equals(s.resolution)).toBe(true)
  })
  it(`rebase Abort with ${flag} set on a removed file right before Git starts keeps the file there`, async () => {
    const s = stopped('rebase')
    const kept = await abortWithFlag(s, 'rebase', flag, `*" diff-index -z --cached --name-only --no-renames "*`, `[ ! -e '${s.cwd}/other' ]`)
    expect(readFileSync(join(s.cwd, 'other'), 'utf8')).toBe('feature other\n')
    expect(blob(s.cwd, kept.ref, 'base.txt').equals(s.resolution)).toBe(true)
  })
}

for (const kind of ['merge', 'rebase'] as const) {
  for (const flag of ['--skip-worktree', '--assume-unchanged']) {
    it(`${kind} Abort with ${flag} set on a file while the copy is kept leaves the file as Git does`, async () => {
      const cwd = join(root, `repo-${++count}`), keeper = join(root, `owner-${count}`)
      mkdirSync(cwd); mkdirSync(keeper)
      git(cwd, 'init', '-q', '-b', 'main')
      for (const [key, value] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.invalid', 'commit.gpgsign': 'false', 'core.hooksPath': '/dev/null', 'core.autocrlf': 'input' })) git(cwd, 'config', key, value)
      writeFileSync(join(cwd, 'base.txt'), 'base\n'); writeFileSync(join(cwd, 'other'), 'old other\n')
      git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base')
      git(cwd, 'checkout', '-q', '-b', 'feature'); writeFileSync(join(cwd, 'base.txt'), 'feature\n'); writeFileSync(join(cwd, 'other'), 'feature other\n'); git(cwd, 'commit', '-qam', 'feature')
      git(cwd, 'checkout', '-q', 'main'); writeFileSync(join(cwd, 'base.txt'), 'main\n'); git(cwd, 'commit', '-qam', 'main')
      if (kind === 'rebase') git(cwd, 'checkout', '-q', 'feature')
      expect(() => git(cwd, kind, kind === 'rebase' ? 'main' : 'feature')).toThrow()
      const resolution = Buffer.from('hand resolution\r\n')
      writeFileSync(join(cwd, 'base.txt'), resolution)
      // The flag is set on `other`, which the abort writes, as the copy is named.
      const bin = join(root, `bin-${count}`), fired = join(bin, 'fired')
      mkdirSync(bin)
      writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in\n  *" update-ref --no-deref refs/mousse/preserved/"*) if [ ! -e '${fired}' ]; then '${realGit}' -C '${cwd}' update-index ${flag} other; : > '${fired}'; fi ;;\nesac\nexec '${realGit}' "$@"\n`, { mode: 0o755 })
      const previous = process.env.PATH
      let kept: KeptCopy
      try {
        process.env.PATH = `${bin}:${previous}`
        kept = (await new GitService().abortInProgress(cwd, userAction('button', 'Abort'), kind, { owner: keeper }))!
      } finally { process.env.PATH = previous }
      expect(existsSync(fired)).toBe(true)
      // The file is there with the bytes plain Git's abort leaves; the resolution is in the copy.
      expect(readFileSync(join(cwd, 'other'), 'utf8')).toBe(kind === 'rebase' ? 'feature other\n' : 'old other\n')
      expect(blob(cwd, kept.ref, 'base.txt').equals(resolution)).toBe(true)
    })
  }
}
