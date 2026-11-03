import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { projectKeptFilesOwner } from '../src/mms/actions/keptCopies'
import { threadPreservedIndex } from '../src/mms/actions/preservedFiles'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { MousseMainService } from '../src/mms/MousseMainService'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import type { GitKeptCopy, GitStatusSnapshot } from '../src/shared/types'
import { git, gitFoundationFixture } from './fixtures/gitFoundation'

type Discarded = { status: GitStatusSnapshot; kept?: GitKeptCopy }
const preserved = (cwd: string) => git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/mousse/preserved/').split('\n').filter(Boolean)

describe('Git panel Discard keeps a copy', () => {
  let f: ReturnType<typeof gitFoundationFixture>
  let mms: MousseMainService
  let server: MmsProtocolServer
  let client: LocalMmsClient

  beforeEach(async () => {
    f = gitFoundationFixture()
    git(f.repo, 'config', 'core.hooksPath', join(f.root, 'no-hooks'))
    git(f.repo, 'config', 'commit.gpgsign', 'false')
    mms = await MousseMainService.create({ homeDir: f.home, headless: true, ownerKind: 'test' })
    await mms.start()
    const ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    const endpoint = await server.start()
    client = new LocalMmsClient({ homeDir: f.home, endpoint, ownerToken, clientType: 'gui' })
    await client.connect()
  }, 30_000)
  afterEach(async () => {
    await client?.close()
    await server?.stop()
    await mms?.stop()
    f?.dispose()
  })

  it('in the person’s own checkout: the project keeps the copy, the confirm’s window comes from its policy, and the result names the copy', async () => {
    const project = mms.projects.openProject(f.repo)
    const binary = randomBytes(32 * 1024)
    writeFileSync(join(f.repo, 'scratch.bin'), binary)
    writeFileSync(join(f.repo, 'value.txt'), 'staged\n'); git(f.repo, 'add', 'value.txt'); writeFileSync(join(f.repo, 'value.txt'), 'working\n')
    const status = await client.request<{ status: GitStatusSnapshot }>('git.status', { projectId: project.id })
    expect(status.status.discardKeptForMs).toBe(30 * 24 * 60 * 60 * 1000)

    const result = await client.request<Discarded>('git.discard', { projectId: project.id, paths: ['scratch.bin', 'value.txt'] })
    expect(result.status.changes).toEqual([])
    expect(existsSync(join(f.repo, 'scratch.bin'))).toBe(false)
    const kept = result.kept!
    expect(preserved(f.repo)).toEqual([kept.ref])
    expect(kept.notice).toBe(`A copy is kept for 30 days as ${kept.ref}. To bring a file back: git restore --source=${kept.ref} -- <path> (its staged version: --source=${kept.ref}^2 --staged).`)
    // Owned by the project's data folder, where the sweep looks.
    const owner = projectKeptFilesOwner(mms.threads.lifecycleStore.profileHome, project.id)
    expect(threadPreservedIndex(owner).owns(kept.ref)).toBe(true)
    expect(JSON.parse(readFileSync(join(owner, 'owner.json'), 'utf8'))).toMatchObject({ projectId: project.id, folders: [git(f.repo, 'rev-parse', '--show-toplevel')] })

    git(f.repo, 'restore', `--source=${kept.ref}`, '--', 'scratch.bin', 'value.txt')
    expect(readFileSync(join(f.repo, 'scratch.bin')).equals(binary)).toBe(true)
    expect(readFileSync(join(f.repo, 'value.txt'), 'utf8')).toBe('working\n')
    git(f.repo, 'restore', `--source=${kept.ref}^2`, '--staged', '--', 'value.txt')
    expect(git(f.repo, 'show', ':value.txt')).toBe('staged')
  })

  it('in a project-folder thread: the discard is a recorded action of the person and the thread owns the copy', async () => {
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread('Folder thread', project.id, undefined, { worktreeEnabled: false })
    const directory = mms.threads.getThreadDir(thread.id)
    writeFileSync(join(f.repo, 'draft.txt'), 'the thread’s draft\n')
    expect((await client.request<{ status: GitStatusSnapshot }>('git.status', { threadId: thread.id })).status.discardKeptForMs).toBe(30 * 24 * 60 * 60 * 1000)

    const result = await client.request<Discarded>('git.discard', { threadId: thread.id, paths: ['draft.txt'] })
    expect(existsSync(join(f.repo, 'draft.txt'))).toBe(false)
    const kept = result.kept!
    expect(threadPreservedIndex(directory).owns(kept.ref)).toBe(true)
    expect([...new ThreadJournal(directory).latestByOperation().values()].find((entry) => entry.operationType === 'git-discard')).toMatchObject({ state: 'completed' })
    const action = new ThreadActionService(directory).list().at(-1)!
    expect(action).toMatchObject({ actor: { kind: 'user' }, externalEffects: [expect.objectContaining({ description: 'Discarded 1 file' })] })
    // The snapshot before the action has the file too.
    expect(git(f.repo, 'show', `${action.startSha}:draft.txt`)).toBe('the thread’s draft')
    git(f.repo, 'restore', `--source=${kept.ref}`, '--', 'draft.txt')
    expect(readFileSync(join(f.repo, 'draft.txt'), 'utf8')).toBe('the thread’s draft\n')
  })
})
