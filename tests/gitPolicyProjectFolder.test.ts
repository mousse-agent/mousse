import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { git as actionGit } from '../src/mms/actions/git'
import { UndoService } from '../src/mms/actions/UndoService'
import { onGitPolicyEntry, userAction, withUserRequest, type GitPolicyEntry } from '../src/mms/git/gitPolicy'
import { ResourceLifecycleCoordinator } from '../src/mms/lifecycle/ResourceLifecycleCoordinator'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'
import { WorkspaceResolver } from '../src/mms/workspace/WorkspaceResolver'
import { gitFoundationFixture } from './fixtures/gitFoundation'

/**
 * The central Git check on a thread that works in its project's own folder (the primary checkout), with refusal on and
 * every decision recorded: making its record, a turn as the orchestrator runs it (outside changes, begin, checkpoint),
 * Undo under the user's request as its handler runs it, and purging the thread. None may need anything it is not
 * allowed, and HEAD, the index and the branches of the person's checkout stay as they were.
 */
const plain = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const boundary = { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' as const }

let f: ReturnType<typeof gitFoundationFixture>
let entries: GitPolicyEntry[]
let stop: () => void
const previousMode = process.env.MOUSSE_GIT_POLICY
beforeEach(() => {
  f = gitFoundationFixture()
  entries = []
  stop = onGitPolicyEntry((entry) => entries.push(entry))
})
afterEach(() => {
  stop()
  if (previousMode === undefined) delete process.env.MOUSSE_GIT_POLICY
  else process.env.MOUSSE_GIT_POLICY = previousMode
  f.dispose()
})
const violations = () => entries.filter((entry) => entry.kind === 'violation').map((entry) => `${entry.command} (${entry.decision.reason})`)
const state = () => ({
  head: plain(f.repo, 'rev-parse', 'HEAD'),
  branch: plain(f.repo, 'symbolic-ref', '-q', 'HEAD'),
  branches: plain(f.repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/'),
  index: plain(f.repo, 'ls-files', '--stage'),
  staged: plain(f.repo, '--no-optional-locks', 'diff', '--cached', '--name-status')
})

describe('under MOUSSE_GIT_POLICY=refuse, a thread in its project folder', () => {
  it('a turn, Undo and the purge of the thread need nothing they are not allowed', async () => {
    // A thread as the lifecycle store knows it, and the person's own uncommitted work: a staged edit and a new file.
    const profile = join(f.home, 'profile'), task = join(profile, 'thread-data', 'task')
    mkdirSync(task, { recursive: true }); writeFileSync(join(task, 'meta.json'), JSON.stringify({ id: 'task' })); writeFileSync(join(task, 'messages.json'), '[]')
    const store = new ResourceLifecycleStore({ profileId: 'p', profileHome: profile }); store.registerTask({ taskId: 'task', location: task })
    registerThreadLifecycleGate(profile, store)
    writeFileSync(join(f.repo, 'value.txt'), 'staged by the person\n'); plain(f.repo, 'add', 'value.txt')
    writeFileSync(join(f.repo, 'mine.txt'), 'the person\'s\n')
    const before = state()
    process.env.MOUSSE_GIT_POLICY = 'refuse'

    // The resolver makes the project folder's record: no worktree, only the thread's pin.
    const execution = await new WorkspaceResolver(task, 'task', f.repo, 'project-folder').resolve('agent')
    expect(execution).toMatchObject({ lifecycle: 'ready', placement: 'project-folder', capability: { checkpointable: true, undoable: true, publishable: false } })

    // A turn as the orchestrator runs it.
    const actions = new ThreadActionService(task)
    const options = { threadId: 'task', turnId: 'turn-1', conversationBranchId: 'main', workspacePath: f.repo, presentationMessageStart: 0, presentationMessageEnd: 2, nativeContextStartBoundary: boundary, nativeContextBoundary: { ...boundary, messageIndex: 2 } }
    const { startSha } = await actions.recordOutsideChanges({ threadId: 'task', conversationBranchId: 'main', workspacePath: f.repo, presentationMessageStart: 0, nativeContextBoundary: boundary })
    actions.beginTurn(options, startSha)
    writeFileSync(join(f.repo, 'value.txt'), 'the agent\'s edit\n'); writeFileSync(join(f.repo, 'agent.txt'), 'new\n')
    const turn = await actions.checkpointExistingTurn(options, startSha, 'completed')
    expect(turn.changedPaths.map((change) => change.path).sort()).toEqual(['agent.txt', 'value.txt'])
    expect(state()).toEqual(before)

    // Undo, as the button's handler runs it.
    await withUserRequest(userAction('button', 'Undo'), () => new UndoService(task).undoLatest('main', f.repo))
    expect(f.read(f.repo)).toBe('staged by the person\n')
    expect(existsSync(join(f.repo, 'agent.txt'))).toBe(false)
    expect(f.read(f.repo, 'mine.txt')).toBe('the person\'s\n')
    expect(state()).toEqual(before)

    // Trash, then purge: the thread's refs go, nothing in the folder does.
    expect(plain(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/mousse/threads/task/')).not.toBe('')
    const coordinator = new ResourceLifecycleCoordinator(store, { drain: async () => {}, settleMutationOwnership: async () => {}, projectIndex: () => {}, projectPurged: () => {} })
    await coordinator.trash({ taskId: 'task', operationId: 'trash' })
    const preview = await coordinator.cleanup.preview('task')
    expect(preview.blockers).toEqual([])
    expect((await coordinator.purge({ taskId: 'task', operationId: 'purge', expectedGeneration: preview.generation, previewDigest: preview.digest })).state).toBe('purged')
    expect(plain(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/mousse/threads/task/', 'refs/mousse/changes/')).toBe('')
    expect(f.read(f.repo, 'mine.txt')).toBe('the person\'s\n')
    expect(state()).toEqual(before)

    expect(violations()).toEqual([])
    // Control: the check is on for these runners. Moving the person's branch through the same runner is refused and recorded.
    expect(() => actionGit(f.repo, ['update-ref', 'refs/heads/main', before.head])).toThrow(/does not run/)
    expect(violations()).toHaveLength(1)
  }, 60_000)
})
