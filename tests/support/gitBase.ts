import { execFileSync } from 'node:child_process'
import { constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beginFixturePhase } from './phaseTiming'

/** One private, closed base per file. Only independent copies ever leave this closure. */
export function committedGitTemplate(initialize: (repo: string) => void): (destination: string) => string {
  let base: { repo: string; sha: string } | undefined
  return (destination) => {
    if (existsSync(destination) && readdirSync(destination).length) throw new Error('Git fixture destination must be empty')
    if (!base) {
      const repo = mkdtempSync(join(tmpdir(), 'mousse-git-base-'))
      const finish = beginFixturePhase('git-base', 'build')
      try {
        initialize(repo)
        // A linked checkout or a registered worktree would retain paths into another fixture.
        if (!lstatSync(join(repo, '.git')).isDirectory() || existsSync(join(repo, '.git', 'worktrees'))) {
          throw new Error('Git fixture template must be an ordinary repository without linked worktrees')
        }
        const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
        base = { repo, sha }
        process.once('exit', () => rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
      } catch (error) {
        rmSync(repo, { recursive: true, force: true })
        throw error
      } finally { finish() }
    }
    const finish = beginFixturePhase('git-base', 'copy')
    try {
      // Node 26 refuses to copy a folder onto an existing one, even an empty one, so copy what it contains.
      mkdirSync(destination, { recursive: true })
      for (const entry of readdirSync(base.repo)) {
        // Copy-on-write when supported, with ordinary independent copies as the portable fallback.
        cpSync(join(base.repo, entry), join(destination, entry), { recursive: true, force: false, errorOnExist: true, mode: constants.COPYFILE_FICLONE })
      }
      return base.sha
    } finally { finish() }
  }
}
