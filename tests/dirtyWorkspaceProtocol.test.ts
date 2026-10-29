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

  it('runs the turn, and Undo gives the user’s pending edits back exactly', async () => {
    const replies: Array<(cwd: string) => string> = [
      (cwd) => { writeFileSync(join(cwd, 'value.txt'), 'first turn\n'); return 'First.' },
      (cwd) => { writeFileSync(join(cwd, 'value.txt'), 'agent edit\n'); writeFileSync(join(cwd, 'agent.txt'), 'agent\n'); return 'Second.' }
    ]
    const { thread, directory } = threadWithAgent(replies)
    await client.request('orchestrator.send', { threadId: thread.id, content: 'First turn.', mode: 'agent' })
    const worktree = new ThreadWorkspaceManager(directory).load()!.worktreePath

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

    await client.request('actions.undoLatest', { threadId: thread.id })
    expect(f.read(worktree)).toBe('user edit\n')
    expect(readFileSync(join(worktree, 'screenshot.png')).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]))).toBe(true)
    expect(existsSync(join(worktree, 'agent.txt'))).toBe(false)
    expect(git(worktree, 'status', '--porcelain', '--untracked-files=all')).toBe('')
  }, 45_000)

  it('refuses a turn during a merge conflict with Discard, which runs only when confirmed', async () => {
    const replies: Array<(cwd: string) => string> = [
      (cwd) => { writeFileSync(join(cwd, 'value.txt'), 'first turn\n'); return 'First.' },
      () => 'After discard.'
    ]
    const { thread, directory } = threadWithAgent(replies)
    await client.request('orchestrator.send', { threadId: thread.id, content: 'First turn.', mode: 'agent' })
    const worktree = new ThreadWorkspaceManager(directory).load()!.worktreePath
    const head = git(worktree, 'rev-parse', 'HEAD')
    const side = f.child('side')
    f.commit(side, 'side\n')
    expect(() => git(worktree, 'merge', 'side')).toThrow()

    const refusal = await client.request('orchestrator.send', { threadId: thread.id, content: 'Blocked.', mode: 'agent' }).catch((error: unknown) => error)
    expect(refusal).toMatchObject({ code: 'workspace_conflict', details: { conflict: true, discard: true, operation: 'merge', files: ['value.txt'] } })
    expect((refusal as Error).message).toContain(worktree)
    expect(mms.orchestrator.getOrCreateSession(thread.id).isTurnRunning()).toBe(false)

    await expect(client.request('workspace.discardPendingChanges', { threadId: thread.id })).rejects.toMatchObject({ code: 'confirmation_required' })
    expect(git(worktree, 'rev-parse', '--verify', '-q', 'MERGE_HEAD')).not.toBe('')
    const discarded = await client.request<{ backupRef: string }>('workspace.discardPendingChanges', { threadId: thread.id, confirmed: true })
    expect(discarded.backupRef).toMatch(/^refs\/mousse\/discarded\//)
    expect(git(worktree, 'status', '--porcelain', '--untracked-files=all')).toBe('')
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(head)
    expect(await client.request('orchestrator.send', { threadId: thread.id, content: 'Continue.', mode: 'agent' })).toMatchObject({ message: 'After discard.' })
  }, 45_000)

  it('Undo and Redo keep pending edits uncommitted; edits that overlap stay under a ref with a quiet line in the thread', async () => {
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
    expect(git(worktree, 'status', '--porcelain', '--untracked-files=all')).toBe('?? notes.md')
    await client.request('actions.redo', { threadId: thread.id })
    expect(existsSync(join(worktree, 'agent.txt'))).toBe(true)
    expect(git(worktree, 'status', '--porcelain', '--untracked-files=all')).toBe('?? notes.md')
    expect(new ThreadActionService(directory).list().some((action) => action.turnId.startsWith('user-changes:'))).toBe(false)

    // The user now builds on the agent's file, which Undo deletes.
    writeFileSync(join(worktree, 'agent.txt'), 'built on it\n')
    await client.request('actions.undoLatest', { threadId: thread.id })
    expect(existsSync(join(worktree, 'agent.txt'))).toBe(false)
    expect(git(worktree, 'status', '--porcelain', '--untracked-files=all')).toBe('')
    const [ref] = git(worktree, 'for-each-ref', '--format=%(refname)', 'refs/mousse/pending-changes').split('\n')
    expect(git(worktree, 'show', `${ref}:agent.txt`)).toBe('built on it')
    await vi.waitFor(() => expect(mms.orchestrator.getMessagesForPersistence(thread.id).at(-1)).toMatchObject({
      role: 'system', kind: 'warning', content: expect.stringContaining(`agent.txt changed in both. They are saved in Git; to restore them, run \`git stash apply ${ref}\``)
    }))
  }, 45_000)
})
