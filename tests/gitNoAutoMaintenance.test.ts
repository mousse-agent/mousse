import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tryGitAsync } from '../src/mms/actions/git'
import { GitHubCodeHost } from '../src/mms/git/GitHubCodeHost'
import { userAction, withUserRequest } from '../src/mms/git/gitPolicy'
import { GitService } from '../src/mms/git/GitService'
import { WorktreeManager } from '../src/mms/worktree/WorktreeManager'

const USER = userAction('button', 'Test action')
const roots: string[] = []
/** Git for the fixture only: none of the developer's own config. */
const FIXTURE_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

afterEach(() => {
  delete process.env.GIT_TRACE2_EVENT
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  roots.push(root)
  return root
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: FIXTURE_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
function repo(cwd: string): string {
  mkdirSync(cwd, { recursive: true })
  git(cwd, 'init', '-q', '-b', 'main')
  git(cwd, 'config', 'user.name', 'Housekeeping fixture')
  git(cwd, 'config', 'user.email', 'housekeeping@example.invalid')
  git(cwd, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(cwd, 'base.txt'), 'base\n')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-q', '-m', 'base')
  return cwd
}
function commitFile(cwd: string, name: string, text: string): string {
  writeFileSync(join(cwd, name), text)
  git(cwd, 'add', name)
  git(cwd, 'commit', '-q', '-m', name)
  return git(cwd, 'rev-parse', 'HEAD')
}

function blobSha(value: string): string {
  return createHash('sha1').update(`blob ${Buffer.byteLength(value)}\0${value}`).digest('hex')
}

/**
 * Makes the next automatic maintenance in `cwd` collect at once and in the foreground, and writes unreachable
 * objects it would delete. Git estimates loose objects from the `17/` fan-out folder, so the objects go there.
 */
function armHousekeeping(cwd: string, scratchDir: string): Map<string, string> {
  for (const [key, value] of [
    ['maintenance.auto', 'true'], ['maintenance.autoDetach', 'false'], ['gc.auto', '1'], ['gc.autoDetach', 'false'],
    ['gc.pruneExpire', 'now'], ['gc.reflogExpire', 'now'], ['gc.reflogExpireUnreachable', 'now'], ['fetch.writeCommitGraph', 'true']
  ]) git(cwd, 'config', key!, value!)
  const doomed = new Map<string, string>()
  for (let index = 0; doomed.size < 4; index++) {
    const value = `unreachable housekeeping bytes ${index}\n`
    const sha = blobSha(value)
    if (!sha.startsWith('17')) continue
    const file = join(scratchDir, 'blob-input')
    writeFileSync(file, value)
    git(cwd, 'hash-object', '-w', file)
    doomed.set(sha, value)
  }
  return doomed
}

/** The bytes each object still has in `cwd`, read back from Git. */
function survivingBytes(cwd: string, doomed: Map<string, string>): Map<string, string | null> {
  return new Map([...doomed.keys()].map((sha) => {
    try {
      return [sha, execFileSync('git', ['cat-file', 'blob', sha], { cwd, env: FIXTURE_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })]
    } catch {
      return [sha, null]
    }
  }))
}

interface TraceEvent { event: string; argv?: string[]; name?: string }

/** Every trace2 event the Git processes wrote into `dir` (one file per process). */
function traceEvents(dir: string): TraceEvent[] {
  return readdirSync(dir).flatMap((file) => readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as TraceEvent))
}

/** Git processes started for housekeeping: a `maintenance` or `gc` child, or a process running either. */
function housekeepingStarts(events: TraceEvent[]): string[] {
  const housekeeping = (argv: string[] | undefined): boolean => !!argv && argv.some((arg) => arg === 'maintenance' || arg === 'gc')
  return events.filter((event) => (event.event === 'child_start' || event.event === 'start') && housekeeping(event.argv)).map((event) => event.argv!.join(' '))
}

async function traced(root: string, work: () => Promise<unknown>): Promise<TraceEvent[]> {
  const dir = join(root, `trace-${Math.random().toString(16).slice(2)}`)
  mkdirSync(dir)
  process.env.GIT_TRACE2_EVENT = dir
  try {
    await work()
  } finally {
    delete process.env.GIT_TRACE2_EVENT
  }
  return traceEvents(dir)
}

interface Scenario {
  cwd: string
  run: () => Promise<unknown>
}

/** A repository with an upstream one commit ahead, a commit to fast-forward to, and a pull request head on the remote. */
function scenarioRepo(name: string): { cwd: string; ahead: string } {
  const root = scratch('mousse-housekeeping-')
  const remote = repo(join(root, `${name}-remote`))
  const cwd = repo(join(root, name))
  git(cwd, 'remote', 'add', 'origin', remote)
  git(cwd, 'fetch', '-q', '--no-auto-maintenance', 'origin')
  git(cwd, 'branch', '-q', '--set-upstream-to', 'origin/main')
  // Same base content, different commits: make the local branch an ancestor of the remote's.
  git(cwd, 'reset', '-q', '--hard', 'origin/main')
  commitFile(remote, 'upstream.txt', 'upstream\n')
  git(remote, 'update-ref', 'refs/pull/1/head', commitFile(remote, 'pr.txt', 'pull request\n'))
  git(remote, 'reset', '-q', '--hard', 'HEAD~1')
  git(cwd, 'checkout', '-q', '-b', 'side')
  const ahead = commitFile(cwd, 'side.txt', 'side\n')
  git(cwd, 'checkout', '-q', 'main')
  return { cwd, ahead }
}

const SCENARIOS: Record<string, () => Scenario> = {
  commit: () => {
    const { cwd } = scenarioRepo('commit')
    return { cwd, run: async () => { writeFileSync(join(cwd, 'new.txt'), 'new\n'); await new GitService().commit(cwd, USER, 'A commit') } }
  },
  'pull (fetch, then merge --ff-only)': () => {
    const { cwd } = scenarioRepo('pull')
    return { cwd, run: async () => expect((await new GitService().pull(cwd, USER)).status).not.toBe('conflicted') }
  },
  'Publish\'s merge --ff-only': () => {
    const { cwd, ahead } = scenarioRepo('publish-merge')
    return {
      cwd,
      run: async () => expect(await withUserRequest(USER, () => tryGitAsync(cwd, ['merge', '--ff-only', '--no-overwrite-ignore', ahead]))).toMatchObject({ ok: true })
    }
  },
  'pull request head fetch': () => {
    const { cwd } = scenarioRepo('pr-fetch')
    const host = new GitHubCodeHost()
    host.remoteForRepository = async () => 'origin'
    return { cwd, run: () => host.fetchPullRequestHead(cwd, { host: 'github.com', nameWithOwner: 'fixture/repo', number: 1 } as Parameters<GitHubCodeHost['fetchPullRequestHead']>[1]) }
  }
}

describe('Mousse\'s own Git never starts Git\'s automatic housekeeping', () => {
  it('the fixture does: plain Git deletes the unreachable objects after a commit', async () => {
    const root = scratch('mousse-housekeeping-control-')
    const cwd = repo(join(root, 'control'))
    const doomed = armHousekeeping(cwd, root)
    const events = await traced(root, async () => {
      writeFileSync(join(cwd, 'new.txt'), 'new\n')
      git(cwd, 'add', 'new.txt')
      execFileSync('git', ['commit', '-q', '-m', 'plain'], { cwd, env: { ...FIXTURE_ENV, GIT_TRACE2_EVENT: process.env.GIT_TRACE2_EVENT } })
    })
    expect(housekeepingStarts(events)).toContainEqual(expect.stringMatching(/maintenance run --auto/))
    expect([...survivingBytes(cwd, doomed).values()]).toEqual([null, null, null, null])
  })

  for (const [name, make] of Object.entries(SCENARIOS)) {
    it(`${name}: no maintenance or gc child, and the unreachable objects keep their bytes`, async () => {
      const scenario = make()
      const root = join(scenario.cwd, '..')
      const doomed = armHousekeeping(scenario.cwd, root)
      const events = await traced(root, scenario.run)
      // The trace saw the operation itself, so an empty result is not a missing trace.
      expect(events.some((event) => event.event === 'start')).toBe(true)
      expect(housekeepingStarts(events)).toEqual([])
      expect(survivingBytes(scenario.cwd, doomed)).toEqual(doomed)
      // A fetch does not write a commit-graph either.
      const info = join(scenario.cwd, '.git', 'objects', 'info')
      expect(existsSync(join(info, 'commit-graph')) || existsSync(join(info, 'commit-graphs'))).toBe(false)
    })
  }
})

/** Every path under `root`, with `.git` itself left out (Git's own files change on any read). */
function fileList(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (full === join(root, '.git')) continue
      out.push(relative(root, full) + (entry.isDirectory() ? '/' : ''))
      if (entry.isDirectory()) walk(full)
    }
  }
  walk(root)
  return out.sort()
}

describe('Starting the worktree service creates nothing in the repository', () => {
  it('init leaves the repository\'s file list and status unchanged', async () => {
    const cwd = repo(join(scratch('mousse-init-'), 'project'))
    const before = { files: fileList(cwd), status: git(cwd, 'status', '--porcelain', '--ignored', '--untracked-files=all') }
    const manager = new WorktreeManager(cwd)
    await manager.init()
    const report = await manager.scanOrphanWorktrees([])
    expect({ files: fileList(cwd), status: git(cwd, 'status', '--porcelain', '--ignored', '--untracked-files=all') }).toEqual(before)
    expect(existsSync(join(cwd, '.mousse-worktrees'))).toBe(false)
    expect(report).toMatchObject({ knownAgentDirs: [], ghostDirectories: [], staleGitWorktrees: [], recoverableKnown: [] })
  })

  it('an existing .mousse-worktrees folder is still scanned and left as it is', async () => {
    const cwd = repo(join(scratch('mousse-init-existing-'), 'project'))
    const ghost = join(cwd, '.mousse-worktrees', 'agent-deadbeef')
    mkdirSync(ghost, { recursive: true })
    writeFileSync(join(ghost, 'notes.txt'), 'progress only\n')
    const before = fileList(cwd)
    const manager = new WorktreeManager(cwd)
    await manager.init()
    const report = await manager.scanOrphanWorktrees([])
    expect(report.ghostDirectories.map((entry) => entry.path)).toEqual([ghost])
    expect(fileList(cwd)).toEqual(before)
    expect(readFileSync(join(ghost, 'notes.txt'), 'utf8')).toBe('progress only\n')
  })
})
