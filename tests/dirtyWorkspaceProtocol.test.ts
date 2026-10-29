import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { git, gitFoundationFixture } from './fixtures/gitFoundation'
import { testHarness } from '../src/mms/run/testkit/harness'
import { piAdapter } from './run/phase6Fixture'
import { PI_TEST_CAPABILITIES } from './support/piStub'

/** A message sent while the thread's worktree has the user's own edits, through the daemon protocol. */
describe('sending in a dirty thread workspace', () => {
  let f: ReturnType<typeof gitFoundationFixture>
  let mms: MousseMainService
  let server: MmsProtocolServer
  let client: LocalMmsClient
  beforeEach(async () => {
    f = gitFoundationFixture()
    mms = await MousseMainService.create({ homeDir: f.home, headless: true, ownerKind: 'test' })
    await mms.start()
    const ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    client = new LocalMmsClient({ homeDir: f.home, endpoint: await server.start(), ownerToken, clientType: 'gui' })
    await client.connect()
    // A Mousse-run runtime stands in for strong containment, so Undo restores without a review.
    vi.spyOn(mms.orchestrator, 'capabilitiesForThread').mockReturnValue(PI_TEST_CAPABILITIES as never)
  }, 30_000)
  afterEach(async () => {
    vi.restoreAllMocks()
    await client?.close()
    await server?.stop()
    await mms?.stop()
    f?.dispose()
  })

  function threadWithAgent(replies: Array<(cwd: string) => string>) {
    const provider = mms.providerAuth.models.getProviders().find((item) => mms.providerAuth.models.getModels(item.id).length > 0)!
    mms.settings.set({ provider: { llmProvider: provider.id, model: mms.providerAuth.models.getModels(provider.id)[0].id } })
    mms.orchestrator.setHarness(testHarness({ adapters: [piAdapter((input) => {
      const next = replies.shift()
      if (!next) throw new Error('Provider fixture exhausted')
      return next(input.cwd!)
    })], profileHome: mms.getProfileHomeDir() }))
    const thread = mms.threads.createThread('Dirty start', mms.projects.openProject(f.repo).id)
    return { thread, directory: mms.threads.getThreadDir(thread.id) }
  }

  it('runs the turn, and Undo leaves the user’s pending edits exactly as they were', async () => {
    const replies: Array<(cwd: string) => string> = [
      (cwd) => { writeFileSync(join(cwd, 'value.txt'), 'first turn\n'); return 'First.' },
      (cwd) => { writeFileSync(join(cwd, 'value.txt'), 'agent edit\n'); writeFileSync(join(cwd, 'agent.txt'), 'agent\n'); return 'Second.' }
    ]
    const { thread, directory } = threadWithAgent(replies)
    await client.request('orchestrator.send', { threadId: thread.id, content: 'First turn.', mode: 'agent' })
    const worktree = new ThreadWorkspaceManager(directory).load()!.worktreePath
    const head = git(worktree, 'rev-parse', 'HEAD')

    // The user edits a file and drops a screenshot into the worktree, without committing.
    writeFileSync(join(worktree, 'value.txt'), 'user edit\n')
    writeFileSync(join(worktree, 'screenshot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]))
    expect(await client.request('orchestrator.send', { threadId: thread.id, content: 'Second turn.', mode: 'agent' })).toMatchObject({ message: 'Second.' })

    const actions = new ThreadActionService(directory).list()
    const saved = actions.find((action) => action.turnId.startsWith('user-changes:'))!
    const turn = actions.at(-1)!
    expect(saved).toMatchObject({ actor: { kind: 'user' }, state: 'completed' })
    expect(saved.changedPaths.map((item) => item.path).sort()).toEqual(['screenshot.png', 'value.txt'])
    expect(turn.startSha).toBe(saved.endSha)
    expect(turn.changedPaths.map((item) => item.path).sort()).toEqual(['agent.txt', 'value.txt'])
    // The turns are snapshots: the thread's branch has no commit of Mousse's.
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(head)

    await client.request('actions.undoLatest', { threadId: thread.id })
    expect(f.read(worktree)).toBe('user edit\n')
    expect(readFileSync(join(worktree, 'screenshot.png')).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]))).toBe(true)
    expect(existsSync(join(worktree, 'agent.txt'))).toBe(false)
    expect(git(worktree, 'status', '--porcelain', '--untracked-files=all')).toBe('M value.txt\n?? screenshot.png')
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(head)
  }, 45_000)

  it('starts a turn during a merge conflict and records it; Undo refuses with Discard, which runs only when confirmed', async () => {
    const replies: Array<(cwd: string) => string> = [
      (cwd) => { writeFileSync(join(cwd, 'value.txt'), 'first turn\n'); return 'First.' },
      (cwd) => { writeFileSync(join(cwd, 'result.txt'), 'second turn result\n'); return 'Second.' },
      () => 'After discard.'
    ]
    const { thread, directory } = threadWithAgent(replies)
    await client.request('orchestrator.send', { threadId: thread.id, content: 'First turn.', mode: 'agent' })
    const worktree = new ThreadWorkspaceManager(directory).load()!.worktreePath
    const side = f.child('side')
    f.commit(side, 'side\n')
    // The agent's own work on the branch (its first turn's file) is committed, as an agent might.
    git(worktree, 'commit', '-qam', 'main')
    expect(() => git(worktree, 'merge', 'side')).toThrow()
    const mergeHead = git(worktree, 'rev-parse', 'HEAD')

    // A merge waiting in the worktree does not lock the thread: the next turn runs and is recorded with the files.
    expect(await client.request('orchestrator.send', { threadId: thread.id, content: 'Second turn.', mode: 'agent' })).toMatchObject({ message: 'Second.' })
    expect(new ThreadActionService(directory).list().at(-1)?.git).toMatchObject({ operationInProgress: 'merge' })
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(mergeHead)

    const refusal = await client.request('actions.undoLatest', { threadId: thread.id }).catch((error: unknown) => error)
    expect(refusal).toMatchObject({ code: 'workspace_conflict', details: { conflict: true, discard: true, operation: 'merge', files: ['value.txt', 'result.txt'] } })
    expect((refusal as Error).message).toContain(worktree)

    await expect(client.request('workspace.discardPendingChanges', { threadId: thread.id })).rejects.toMatchObject({ code: 'confirmation_required' })
    expect(git(worktree, 'rev-parse', '--verify', '-q', 'MERGE_HEAD')).not.toBe('')
    const discarded = await client.request<{ backupRef: string; snapshotSha?: string; notice: string }>('workspace.discardPendingChanges', { threadId: thread.id, confirmed: true })
    expect(discarded.backupRef).toMatch(/^refs\/mousse\/discarded\//)
    // The second turn's uncommitted result goes with the conflict, so it is kept where a person can find it, and the result says where.
    expect(git(worktree, 'show', `${discarded.backupRef}:result.txt`)).toBe('second turn result')
    expect(discarded.notice).toContain(discarded.backupRef)
    expect(git(worktree, 'show', `${discarded.snapshotSha}:result.txt`)).toBe('second turn result')
    expect(git(worktree, 'status', '--porcelain', '--untracked-files=all')).toBe('')
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(mergeHead)
    expect(await client.request('orchestrator.send', { threadId: thread.id, content: 'Continue.', mode: 'agent' })).toMatchObject({ message: 'After discard.' })
  }, 45_000)

  it('pushes the thread’s commits with uncommitted files in the worktree, and says those were not pushed', async () => {
    const replies: Array<(cwd: string) => string> = [(cwd) => { writeFileSync(join(cwd, 'value.txt'), 'first turn\n'); return 'First.' }]
    const { thread, directory } = threadWithAgent(replies)
    const origin = join(f.root, 'origin.git')
    git(f.root, 'init', '--bare', '-q', origin); git(f.repo, 'remote', 'add', 'origin', origin)
    await client.request('orchestrator.send', { threadId: thread.id, content: 'First turn.', mode: 'agent' })
    const worktree = new ThreadWorkspaceManager(directory).load()!.worktreePath
    git(worktree, 'commit', '-qam', 'the first turn')
    writeFileSync(join(worktree, 'draft.txt'), 'not committed\n')
    const result = await client.request<{ notice?: string }>('git.push', { threadId: thread.id })
    expect(result.notice).toBe('Pushed the commits. 1 uncommitted file was not pushed.')
    const branch = git(worktree, 'branch', '--show-current')
    expect(git(origin, 'rev-parse', branch)).toBe(git(worktree, 'rev-parse', 'HEAD'))
    expect(git(origin, 'ls-tree', '--name-only', branch).split('\n')).not.toContain('draft.txt')
    expect(existsSync(join(worktree, 'draft.txt'))).toBe(true)
    expect(git(origin, 'log', '--format=%s', branch)).not.toMatch(/mousse/i)
  }, 45_000)

  it('Undo and Redo keep pending edits; edits that overlap refuse the Undo and change nothing', async () => {
    const replies: Array<(cwd: string) => string> = [
      (cwd) => { writeFileSync(join(cwd, 'value.txt'), 'first turn\n'); return 'First.' },
      (cwd) => { writeFileSync(join(cwd, 'agent.txt'), 'agent\n'); return 'Second.' }
    ]
    const { thread, directory } = threadWithAgent(replies)
    await client.request('orchestrator.send', { threadId: thread.id, content: 'First turn.', mode: 'agent' })
    await client.request('orchestrator.send', { threadId: thread.id, content: 'Second turn.', mode: 'agent' })
    const worktree = new ThreadWorkspaceManager(directory).load()!.worktreePath
    writeFileSync(join(worktree, 'notes.md'), 'mine\n')
    await client.request('actions.undoLatest', { threadId: thread.id })
    expect(existsSync(join(worktree, 'agent.txt'))).toBe(false)
    expect(git(worktree, 'status', '--porcelain', '--untracked-files=all')).toBe('M value.txt\n?? notes.md')
    await client.request('actions.redo', { threadId: thread.id })
    expect(existsSync(join(worktree, 'agent.txt'))).toBe(true)
    expect(git(worktree, 'status', '--porcelain', '--untracked-files=all')).toBe('M value.txt\n?? agent.txt\n?? notes.md')
    expect(new ThreadActionService(directory).list().some((action) => action.turnId.startsWith('user-changes:'))).toBe(false)

    // The user now builds on the agent's file, which Undo deletes: Undo names it and changes nothing.
    writeFileSync(join(worktree, 'agent.txt'), 'built on it\n')
    await expect(client.request('actions.undoLatest', { threadId: thread.id })).rejects.toThrow(/agent\.txt/)
    expect(readFileSync(join(worktree, 'agent.txt'), 'utf8')).toBe('built on it\n')
    expect(readFileSync(join(worktree, 'notes.md'), 'utf8')).toBe('mine\n')
  }, 45_000)
})
