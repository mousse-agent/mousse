import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { PROTOCOL_METHODS } from '../src/mms/protocol/types'
import { GUI_REQUIRED_METHODS } from '../src/main/mms/guiDaemonCompatibility'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import type { ReviewFileResult, ReviewFilesResult } from '../src/shared/review'
import { actionOptions, gitFoundationFixture } from './fixtures/gitFoundation'

describe('review.files and review.file through the daemon', () => {
  let f: ReturnType<typeof gitFoundationFixture>
  let mms: MousseMainService
  let server: MmsProtocolServer
  let client: LocalMmsClient
  let threadId: string
  let projectId: string
  let worktree: string
  const turnId = 'run:thread:abc%3Adef:ordinal:1'

  beforeEach(async () => {
    f = gitFoundationFixture()
    mms = await MousseMainService.create({ homeDir: f.home, headless: true, ownerKind: 'test' })
    await mms.start()
    const ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    const endpoint = await server.start()
    client = new LocalMmsClient({ homeDir: f.home, endpoint, ownerToken, clientType: 'gui' })
    await client.connect()
    const project = mms.projects.openProject(f.repo)
    projectId = project.id
    threadId = mms.threads.createThread('Review fixture', project.id).id
    const directory = mms.threads.getThreadDir(threadId)
    worktree = (await new ThreadWorkspaceManager(directory).provision(threadId, 'main', f.repo)).worktreePath
    await new ThreadActionService(directory).runCheckpointedAction({ ...actionOptions(worktree, turnId), threadId }, () => {
      writeFileSync(join(worktree, 'value.txt'), 'turn one\n'); writeFileSync(join(worktree, 'added.txt'), 'new\n')
    })
  }, 30_000)
  afterEach(async () => {
    await client?.close()
    await server?.stop()
    await mms?.stop()
    f?.dispose()
  })

  it('is part of the protocol and required by the GUI', () => {
    for (const method of ['review.files', 'review.file']) {
      expect(PROTOCOL_METHODS).toContain(method)
      expect(GUI_REQUIRED_METHODS).toContain(method)
    }
  })

  it('lists a turn and the thread, and reads one file of the turn', async () => {
    const turn = await client.request<ReviewFilesResult>('review.files', { threadId, scope: { kind: 'turn', turnId } })
    expect(turn.root).toBe(worktree)
    expect(turn.files.map((file) => [file.path, file.status])).toEqual([['added.txt', 'added'], ['value.txt', 'modified']])
    const thread = await client.request<ReviewFilesResult>('review.files', { threadId, scope: { kind: 'thread' } })
    expect(thread.files.map((file) => file.path)).toEqual(['added.txt', 'value.txt'])
    const file = await client.request<ReviewFileResult>('review.file', { threadId, scope: { kind: 'turn', turnId }, path: 'value.txt' })
    expect(file).toMatchObject({ root: worktree, path: 'value.txt', original: { content: 'base\n' }, modified: { content: 'turn one\n' } })
  })

  it('lists the working tree by thread or project, staged and unstaged apart', async () => {
    writeFileSync(join(worktree, 'value.txt'), 'turn one then edited\n')
    const unstaged = await client.request<ReviewFilesResult>('review.files', { threadId, scope: { kind: 'worktree' } })
    expect(unstaged.files.map((file) => file.path)).toEqual(['value.txt'])
    const staged = await client.request<ReviewFilesResult>('review.files', { threadId, scope: { kind: 'worktree', staged: true } })
    expect(staged.files).toEqual([])
    const byProject = await client.request<ReviewFilesResult>('review.files', { projectId, scope: { kind: 'worktree' } })
    expect(byProject.root).toBe(f.repo)
    expect(byProject.files).toEqual([])
  })

  it('says so when the project folder is not a Git repository', async () => {
    const plain = join(f.root, 'plain-folder')
    mkdirSync(plain)
    const project = mms.projects.openProject(plain)
    const result = await client.request<ReviewFilesResult>('review.files', { projectId: project.id, scope: { kind: 'worktree' } })
    expect(result).toMatchObject({ files: [], unavailable: 'Not a Git repository.' })
    await expect(client.request('review.file', { projectId: project.id, scope: { kind: 'worktree' }, path: 'a.txt' })).rejects.toThrow(/Not a Git repository/)
  })

  it('answers a turn that was never checkpointed with a reason instead of an error', async () => {
    const result = await client.request<ReviewFilesResult>('review.files', { threadId, scope: { kind: 'turn', turnId: 'missing' } })
    expect(result).toMatchObject({ files: [], unavailable: 'This turn was not checkpointed' })
    await expect(client.request('review.file', { threadId, scope: { kind: 'turn', turnId: 'missing' }, path: 'value.txt' })).rejects.toThrow(/not checkpointed/)
  })

  it('rejects an unknown scope, a path outside the root and a project id for a turn', async () => {
    await expect(client.request('review.files', { threadId, scope: { kind: 'bogus' } })).rejects.toThrow()
    await expect(client.request('review.files', { threadId })).rejects.toThrow()
    await expect(client.request('review.files', { projectId, scope: { kind: 'turn', turnId } })).rejects.toThrow()
    await expect(client.request('review.file', { threadId, scope: { kind: 'thread' }, path: '../outside.txt' })).rejects.toThrow()
    await expect(client.request('review.file', { threadId, scope: { kind: 'thread' }, path: 'value.txt', oldPath: '../../outside.txt' })).rejects.toThrow()
  })
})
