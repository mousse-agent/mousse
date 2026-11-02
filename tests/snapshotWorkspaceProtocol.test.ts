import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { configureSnapshotLimits } from '../src/mms/actions/snapshots'
import { snapshotWorkspacePath, snapshotsOffReason } from '../src/mms/workspace/SnapshotWorkspace'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { gitFoundationFixture } from './fixtures/gitFoundation'
import { testHarness } from '../src/mms/run/testkit/harness'
import { piAdapter } from './run/phase6Fixture'
import { PI_TEST_CAPABILITIES } from './support/piStub'

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

interface History {
  actions: Array<{ id: string; turnId: string; scope?: string; reversible: boolean; notice?: string }>
  undoTarget?: { actionId: string; turnId: string }
  undoUnavailableReason?: string
}

/** Turns in folders that have no Git (or no commit), and in threads with no project, through the daemon protocol. */
describe('Undo without Git', () => {
  let f: ReturnType<typeof gitFoundationFixture>
  let mms: MousseMainService
  let server: MmsProtocolServer
  let client: LocalMmsClient
  let folders = 0
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
    configureSnapshotLimits()
    await client?.close()
    await server?.stop()
    await mms?.stop()
    f?.dispose()
  })

  const folder = (): string => { const path = join(realpathSync(f.root), `folder-${folders += 1}`); mkdirSync(path); return path }

  function agent(replies: Array<(cwd: string) => string>, scratch?: string) {
    const provider = mms.providerAuth.models.getProviders().find((item) => mms.providerAuth.models.getModels(item.id).length > 0)!
    mms.settings.set({ provider: { llmProvider: provider.id, model: mms.providerAuth.models.getModels(provider.id)[0].id } })
    const adapter = piAdapter((input) => {
      const next = replies.shift()
      if (!next) throw new Error('Provider fixture exhausted')
      return next(input.cwd ?? scratch!)
    })
    // A runtime that keeps a private folder per thread, as Claude Code and Codex do.
    if (scratch) (adapter as unknown as { standaloneWorkspace: (threadId: string) => string }).standaloneWorkspace = () => scratch
    mms.orchestrator.setHarness(testHarness({ adapters: [adapter], profileHome: mms.getProfileHomeDir() }))
  }
  const projectThread = (work: string, name = 'Thread') => {
    const thread = mms.threads.createThread(name, mms.projects.openProject(work).id)
    return { thread, directory: mms.threads.getThreadDir(thread.id) }
  }
  const send = (threadId: string, content: string, mode = 'agent') => client.request<{ message: string }>('orchestrator.send', { threadId, content, mode })
  const history = (threadId: string) => client.request<History>('actions.list', { threadId })

  it('records the turns of a project that is not a Git repository, offers Undo and review, and never adds a .git', async () => {
    const work = folder()
    writeFileSync(join(work, 'notes.txt'), 'before\n')
    writeFileSync(join(work, '.gitignore'), 'secret.txt\n')
    agent([
      (cwd) => { writeFileSync(join(cwd, 'notes.txt'), 'first\n'); return 'First.' },
      (cwd) => { writeFileSync(join(cwd, 'notes.txt'), 'second\n'); mkdirSync(join(cwd, 'src')); writeFileSync(join(cwd, 'src', 'main.ts'), 'export {}\n'); writeFileSync(join(cwd, 'secret.txt'), 's\n'); mkdirSync(join(cwd, 'node_modules')); writeFileSync(join(cwd, 'node_modules', 'x.js'), 'x\n'); return 'Second.' }
    ])
    const { thread, directory } = projectThread(work)
    await send(thread.id, 'First turn.')
    expect(await send(thread.id, 'Second turn.')).toMatchObject({ message: 'Second.' })

    // Snapshot actions, like a Git thread's, and no worktree: the folder is the person's.
    const actions = new ThreadActionService(directory).list()
    expect(actions.map((action) => action.scope)).toEqual([undefined, undefined])
    const second = actions.at(-1)!
    expect(second).toMatchObject({ state: 'completed', reversible: true })
    expect(second.changedPaths.map((item) => item.path).sort()).toEqual(['notes.txt', 'src/main.ts'])
    expect(new ThreadWorkspaceManager(directory).load()).toBeUndefined()
    expect(existsSync(join(directory, 'workspace.json'))).toBe(false)
    expect(existsSync(join(work, '.git'))).toBe(false)
    expect(readdirSync(work).sort()).toEqual(['.gitignore', 'node_modules', 'notes.txt', 'secret.txt', 'src'])

    // The existing Undo control is offered for the latest turn.
    const listed = await history(thread.id)
    expect(listed.undoTarget).toMatchObject({ actionId: second.id, turnId: second.turnId })

    // Per-turn review, from the store.
    const review = await client.request<{ files: Array<{ path: string; status: string }>; unavailable?: string }>('review.files', { threadId: thread.id, scope: { kind: 'turn', turnId: second.turnId } })
    expect(review.unavailable).toBeUndefined()
    expect(review.files.map((file) => `${file.status}:${file.path}`).sort()).toEqual(['added:src/main.ts', 'modified:notes.txt'])
    const file = await client.request<{ original: { content: string }; modified: { content: string } }>('review.file', { threadId: thread.id, scope: { kind: 'turn', turnId: second.turnId }, path: 'notes.txt' })
    expect([file.original.content, file.modified.content]).toEqual(['first\n', 'second\n'])

    await client.request('actions.undoLatest', { threadId: thread.id })
    expect(readFileSync(join(work, 'notes.txt'), 'utf8')).toBe('first\n')
    expect(existsSync(join(work, 'src', 'main.ts'))).toBe(false)
    // What a snapshot never held is not touched.
    expect(readFileSync(join(work, 'secret.txt'), 'utf8')).toBe('s\n')
    expect(readFileSync(join(work, 'node_modules', 'x.js'), 'utf8')).toBe('x\n')
    expect(existsSync(join(work, '.git'))).toBe(false)

    // Redo brings the turn back; and the next Undo finds the thread whole.
    await client.request('actions.redo', { threadId: thread.id })
    expect(readFileSync(join(work, 'notes.txt'), 'utf8')).toBe('second\n')
    expect(existsSync(join(work, 'src', 'main.ts'))).toBe(true)
  }, 60_000)

  it('treats a repository with no commit the same, and leaves its .git as the person has it', async () => {
    const work = folder()
    git(work, 'init', '-q')
    agent([(cwd) => { writeFileSync(join(cwd, 'a.txt'), 'a\n'); return 'Done.' }])
    const { thread, directory } = projectThread(work)
    await send(thread.id, 'Make a file.')
    expect(new ThreadActionService(directory).list().at(-1)).toMatchObject({ state: 'completed', reversible: true })
    expect(git(work, 'for-each-ref')).toBe('')
    await client.request('actions.undoLatest', { threadId: thread.id })
    expect(existsSync(join(work, 'a.txt'))).toBe(false)
    expect(git(work, 'status', '--porcelain')).toBe('')
  }, 60_000)

  it('does not record a turn that only reads', async () => {
    const work = folder()
    agent([() => 'Just talking.'])
    const { thread, directory } = projectThread(work)
    await send(thread.id, 'What is here?', 'plan')
    expect(new ThreadActionService(directory).list().map((action) => action.scope)).toEqual(['conversation'])
    expect(existsSync(snapshotWorkspacePath(directory))).toBe(false)
  }, 60_000)

  it('runs a turn in a folder that is too large without snapshots, says why, and the next turn is recorded once it fits', async () => {
    const work = folder()
    for (let index = 0; index < 5; index += 1) writeFileSync(join(work, `f${index}.txt`), 'x\n')
    configureSnapshotLimits({ files: 4 })
    agent([
      (cwd) => { writeFileSync(join(cwd, 'agent.txt'), 'agent\n'); return 'Done anyway.' },
      (cwd) => { writeFileSync(join(cwd, 'after.txt'), 'after\n'); return 'Recorded.' }
    ])
    const { thread, directory } = projectThread(work)
    expect(await send(thread.id, 'First turn.')).toMatchObject({ message: 'Done anyway.' })
    // The turn succeeded and changed the folder; its conversation is recorded alone, with the reason.
    expect(readFileSync(join(work, 'agent.txt'), 'utf8')).toBe('agent\n')
    const [first] = new ThreadActionService(directory).list()
    expect(first).toMatchObject({ scope: 'conversation', state: 'completed' })
    expect(first!.notice).toMatch(/Undo is off for this folder because it is too large/)
    // Reported in the shape a Git thread's snapshot gaps take: the whole folder is not covered.
    expect(first!.notCovered).toBe('Not covered: . (too large (more than 4 files)).')
    expect(snapshotsOffReason(directory)).toMatch(/too large/)
    expect(existsSync(join(work, '.git'))).toBe(false)
    // Undo of that turn takes the conversation back only, and says so where the person sees the result.
    expect((await history(thread.id)).undoTarget).toMatchObject({ actionId: first!.id })
    const undone = await client.request<{ action: { notice?: string } }>('actions.undoLatest', { threadId: thread.id })
    expect(undone.action.notice).toMatch(/Undo is off for this folder because it is too large.*Only the conversation is taken back/)
    expect(readFileSync(join(work, 'agent.txt'), 'utf8')).toBe('agent\n')

    // Once the folder fits again, the turn is recorded with its files and the reason is gone.
    configureSnapshotLimits()
    await send(thread.id, 'Second turn.')
    const second = new ThreadActionService(directory).list().at(-1)!
    expect(second.scope).toBeUndefined()
    expect(second.changedPaths.map((item) => item.path)).toContain('after.txt')
    expect(snapshotsOffReason(directory)).toBeUndefined()
  }, 60_000)

  it('never snapshots a project that is the home folder, and the turn still runs', async () => {
    const work = folder()
    const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
    // The folder is the person's home as far as the process can tell.
    process.env.HOME = work
    process.env.USERPROFILE = work
    try {
      agent([(cwd) => { writeFileSync(join(cwd, 'a.txt'), 'a\n'); return 'Done.' }])
      const { thread, directory } = projectThread(work)
      expect(await send(thread.id, 'Hello.')).toMatchObject({ message: 'Done.' })
      expect(snapshotsOffReason(directory)).toMatch(/home or system folder/)
      expect(new ThreadActionService(directory).list().map((action) => action.scope)).toEqual(['conversation'])
      expect(readdirSync(work)).toEqual(['a.txt'])
    } finally {
      for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    }
  }, 60_000)

  it('threads of one project share the folder: Undo of one keeps the other’s files, and an overlap refuses and names the file', async () => {
    const work = folder()
    writeFileSync(join(work, 'shared.txt'), 'one\ntwo\n')
    agent([
      (cwd) => { writeFileSync(join(cwd, 'a.txt'), 'a\n'); writeFileSync(join(cwd, 'shared.txt'), 'ONE\ntwo\n'); return 'A.' },
      (cwd) => { writeFileSync(join(cwd, 'b.txt'), 'b\n'); writeFileSync(join(cwd, 'shared.txt'), 'Uno\ntwo\n'); return 'B.' },
      (cwd) => { writeFileSync(join(cwd, 'c.txt'), 'c\n'); return 'C.' }
    ])
    const a = projectThread(work, 'A')
    const b = projectThread(work, 'B')
    await send(a.thread.id, 'A turn.')
    await send(b.thread.id, 'B turn.')

    await expect(client.request('actions.undoLatest', { threadId: a.thread.id })).rejects.toThrow(/shared\.txt/)
    expect(readFileSync(join(work, 'shared.txt'), 'utf8')).toBe('Uno\ntwo\n')
    expect(existsSync(join(work, 'a.txt'))).toBe(true)

    await client.request('actions.undoLatest', { threadId: b.thread.id })
    expect(existsSync(join(work, 'b.txt'))).toBe(false)
    expect(existsSync(join(work, 'a.txt'))).toBe(true)
    // A thread's third turn works the same on the shared folder.
    await send(a.thread.id, 'Another A turn.')
    await client.request('actions.undoLatest', { threadId: a.thread.id })
    expect(existsSync(join(work, 'c.txt'))).toBe(false)
    expect(existsSync(join(work, 'a.txt'))).toBe(true)
  }, 90_000)

  it('records a thread with no project in its runtime’s private folder, and Undo restores it', async () => {
    const scratch = folder()
    agent([
      (cwd) => { writeFileSync(join(cwd, 'draft.md'), 'draft\n'); return 'Wrote it.' },
      (cwd) => { writeFileSync(join(cwd, 'draft.md'), 'revised\n'); writeFileSync(join(cwd, 'extra.md'), 'extra\n'); return 'Revised.' }
    ], scratch)
    const thread = mms.threads.createThread('No project')
    const directory = mms.threads.getThreadDir(thread.id)
    await send(thread.id, 'Write a draft.')
    await send(thread.id, 'Revise it.')
    const actions = new ThreadActionService(directory).list()
    expect(actions.map((action) => action.scope)).toEqual([undefined, undefined])
    expect(actions.at(-1)!.changedPaths.map((item) => item.path).sort()).toEqual(['draft.md', 'extra.md'])
    // The store is the thread's own.
    expect(existsSync(join(f.home, 'thread-snapshots', thread.id, 'snapshots.git'))).toBe(true)
    expect(existsSync(join(f.home, 'project-data'))).toBe(false)
    expect((await history(thread.id)).undoTarget).toBeDefined()
    await client.request('actions.undoLatest', { threadId: thread.id })
    expect(readFileSync(join(scratch, 'draft.md'), 'utf8')).toBe('draft\n')
    expect(existsSync(join(scratch, 'extra.md'))).toBe(false)
    expect(existsSync(join(scratch, '.git'))).toBe(false)
  }, 60_000)

  it('offers no Publish for a folder without Git, and refuses it cleanly', async () => {
    const work = folder()
    agent([(cwd) => { writeFileSync(join(cwd, 'a.txt'), 'a\n'); return 'Done.' }])
    const { thread } = projectThread(work)
    await send(thread.id, 'Make a file.')
    await expect(client.request('publish.start', { threadId: thread.id, targetBranch: 'main' })).rejects.toMatchObject({ code: 'workspace_not_ready' })
    expect(existsSync(join(work, '.git'))).toBe(false)
  }, 60_000)
})
