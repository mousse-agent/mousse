/**
 * The composer's worktree toggle: a thread that chose its project's folder keeps that choice and never
 * gets a worktree; a thread that never chose still gets one.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { WorkspaceResolver } from '../src/mms/workspace/WorkspaceResolver'

describe('thread worktree choice', () => {
  let root: string
  let repo: string
  let store: ThreadDataStore
  const previousHome = process.env.MOUSSE_HOME

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mousse-worktree-choice-'))
    repo = join(root, 'repo')
    mkdirSync(repo)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
    git('init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'value.txt'), 'base\n')
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base')
    process.env.MOUSSE_HOME = join(root, 'home')
    store = new ThreadDataStore(new ProjectManager())
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  it('records off at creation and from the toggle, and leaves it unset when no choice is made', () => {
    expect(store.createThread('Folder', undefined, undefined, { worktreeEnabled: false }).worktreeEnabled).toBe(false)
    expect(store.createThread('Worktree', undefined, undefined, { worktreeEnabled: true }).worktreeEnabled).toBe(true)
    const unset = store.createThread('No choice')
    expect(unset.worktreeEnabled).toBeUndefined()
    expect(store.setThreadWorktreeEnabled(unset.id, false).worktreeEnabled).toBe(false)
    expect(store.getThread(unset.id)?.worktreeEnabled).toBe(false)
  })

  it('an editing turn of a thread with its worktree off runs in the project folder and provisions nothing', async () => {
    const thread = store.createThread('Folder', undefined, undefined, { worktreeEnabled: false })
    const directory = store.getThreadDir(thread.id)
    const execution = await new WorkspaceResolver(directory, thread.id, repo, false).resolve('agent')
    expect(execution.workspacePath).toBe(repo)
    expect(execution.lifecycle).toBe('unprovisioned')
    expect(execution.capability).toMatchObject({ gitBacked: true, checkpointable: false })
    expect(new ThreadWorkspaceManager(directory).load()).toBeUndefined()
  }, 30_000)

  it('an editing turn of a thread with its worktree on gets a worktree of its own', async () => {
    const thread = store.createThread('Worktree', undefined, undefined, { worktreeEnabled: true })
    const directory = store.getThreadDir(thread.id)
    const execution = await new WorkspaceResolver(directory, thread.id, repo).resolve('agent')
    expect(execution.workspacePath).not.toBe(repo)
    expect(new ThreadWorkspaceManager(directory).load()?.lifecycle).toBe('ready')
  }, 30_000)
})
