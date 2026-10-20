/**
 * SPEC §16.3 restore safety: weak containment reviews the diff instead of restoring, a workspace
 * another thread works in is refused (`workspace_shared`), and an allowed undo or revert is its own
 * run (`source: 'undo' | 'revert'`).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadActionService } from '../../src/mms/actions/ThreadActionService'
import { MousseMainService } from '../../src/mms/MousseMainService'
import { LocalMmsClient } from '../../src/mms/protocol/client'
import { MmsProtocolServer } from '../../src/mms/protocol/server'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/run/adapters/claudeSubscription/ClaudeSubscriptionAdapter'
import { PI_LOOP_CAPABILITIES } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import type { RunRecord } from '../../src/mms/run/types'
import { evaluateRestore, pathsOverlap, RESTORE_DIFF_MAX_CHARS, restoreDiff, restoreDiffSha, worktreeClaims } from '../../src/mms/run/workspace/restoreSafety'
import { WorkspaceResolver } from '../../src/mms/workspace/WorkspaceResolver'
import type { ThreadWorkspaceMetadata } from '../../src/shared/workspace'
import { actionOptions, gitFoundationFixture } from '../fixtures/gitFoundation'

describe('evaluateRestore (SPEC §16.3)', () => {
  let root: string | undefined
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = undefined
  })

  const metadata = (threadId: string, worktreePath: string, primary: string): ThreadWorkspaceMetadata => ({
    schemaVersion: 1, threadId, repositoryId: 'repo', conversationBranchId: 'main', branch: 'b', retainedRef: 'r',
    worktreePath, projectRelativeSubdirectory: '.', baseSha: 'a', headSha: 'a', lifecycle: 'ready',
    lastVerifiedAt: new Date().toISOString(), provenance: { ownerThreadId: threadId },
    integrationTarget: { checkoutPath: primary, baseSha: 'a' }
  })

  it('reviews the diff for weak containment, restores automatically for strong, and lets a reviewed restore proceed', () => {
    root = mkdtempSync(join(tmpdir(), 'mousse-restore-'))
    const worktree = join(root, 'worktrees', 't1')
    mkdirSync(worktree, { recursive: true })
    const owned = metadata('t1', worktree, join(root, 'primary'))
    expect(evaluateRestore({ threadId: 't1', caps: CLAUDE_SUBSCRIPTION_CAPABILITIES, metadata: owned, others: [] })).toEqual({ action: 'review', mode: 'review_diff' })
    expect(evaluateRestore({ threadId: 't1', caps: CLAUDE_SUBSCRIPTION_CAPABILITIES, metadata: owned, others: [], reviewed: true })).toEqual({ action: 'proceed', mode: 'review_diff' })
    expect(evaluateRestore({ threadId: 't1', caps: PI_LOOP_CAPABILITIES, metadata: owned, others: [] })).toEqual({ action: 'proceed', mode: 'auto' })
    expect(evaluateRestore({ threadId: 't1', caps: null, metadata: owned, others: [] })).toEqual({ action: 'review', mode: 'review_diff' })
  })

  it('refuses workspace_shared when the thread does not own the worktree or another thread overlaps it by realpath', () => {
    root = mkdtempSync(join(tmpdir(), 'mousse-restore-'))
    const primary = join(root, 'primary')
    const worktree = join(root, 'worktrees', 't1')
    mkdirSync(join(worktree, 'src'), { recursive: true })
    mkdirSync(primary)
    symlinkSync(worktree, join(root, 'alias'))
    const owned = metadata('t1', worktree, primary)
    const refuse = (others: Parameters<typeof evaluateRestore>[0]['others'], meta: ThreadWorkspaceMetadata | undefined = owned) =>
      evaluateRestore({ threadId: 't1', caps: PI_LOOP_CAPABILITIES, metadata: meta, others })
    // Not owned: another thread's worktree, the primary checkout, or none.
    expect(refuse([], { ...owned, provenance: { ownerThreadId: 't2' } })).toMatchObject({ action: 'refuse', reason: 'workspace_shared' })
    expect(refuse([], { ...owned, worktreePath: primary })).toMatchObject({ action: 'refuse', reason: 'workspace_shared' })
    expect(evaluateRestore({ threadId: 't1', caps: PI_LOOP_CAPABILITIES, metadata: undefined, others: [] })).toMatchObject({ action: 'refuse', reason: 'workspace_shared' })
    // Overlap through a symlink alias, a nested live cwd, or an enclosing worktree.
    expect(refuse([{ threadId: 't2', path: join(root, 'alias'), kind: 'worktree' }])).toMatchObject({ action: 'refuse', conflicts: [{ threadId: 't2' }] })
    expect(refuse([{ threadId: 't3', path: join(root, 'alias', 'src'), kind: 'live_cwd' }])).toMatchObject({ action: 'refuse', conflicts: [{ threadId: 't3' }] })
    expect(refuse([{ threadId: 't4', path: join(root, 'worktrees'), kind: 'worktree' }])).toMatchObject({ action: 'refuse' })
    // Siblings and the thread's own claims do not overlap.
    expect(refuse([{ threadId: 't2', path: join(root, 'worktrees', 't10'), kind: 'worktree' }, { threadId: 't1', path: worktree, kind: 'live_cwd' }])).toMatchObject({ action: 'proceed' })
    expect(pathsOverlap(join(root, 'worktrees', 't1'), join(root, 'worktrees', 't10'))).toBe(false)
  })
})

describe('restore inputs (SPEC §16.3)', () => {
  let root: string | undefined
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = undefined
  })
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

  it('claims the worktrees other threads recorded and skips threads without readable workspace metadata', () => {
    root = mkdtempSync(join(tmpdir(), 'mousse-claims-'))
    const directory = (name: string, workspace?: string) => {
      const path = join(root!, name)
      mkdirSync(path)
      if (workspace !== undefined) writeFileSync(join(path, 'workspace.json'), workspace)
      return path
    }
    const claims = worktreeClaims([
      { threadId: 't2', threadDirectory: directory('t2', JSON.stringify({ worktreePath: join(root, 'wt', 't2') })) },
      { threadId: 't3', threadDirectory: directory('t3', '{not json') },
      { threadId: 't4', threadDirectory: directory('t4') },
      { threadId: 't5', threadDirectory: directory('t5', JSON.stringify({ threadId: 't5' })) },
      { threadId: 't6', threadDirectory: join(root, 'missing') }
    ])
    expect(claims).toEqual([{ threadId: 't2', path: join(root, 'wt', 't2'), kind: 'worktree' }])
  })

  it('bounds the review diff, marks the cut, and returns nothing for an unknown revision', () => {
    root = mkdtempSync(join(tmpdir(), 'mousse-restore-diff-'))
    git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Restore fixture'); git(root, 'config', 'user.email', 'restore@example.invalid'); git(root, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(root, 'file.txt'), 'small\n'); git(root, 'add', '.'); git(root, 'commit', '-m', 'small')
    writeFileSync(join(root, 'file.txt'), 'small\nchanged\n'); git(root, 'commit', '-am', 'small change')
    expect(restoreDiff(root, 'HEAD~1', 'HEAD')).toContain('+changed')
    expect(restoreDiff(root, 'HEAD~1', 'HEAD')).not.toContain('truncated')
    writeFileSync(join(root, 'file.txt'), 'line\n'.repeat(Math.ceil(RESTORE_DIFF_MAX_CHARS / 5) + 100)); git(root, 'commit', '-am', 'large change')
    const diff = restoreDiff(root, 'HEAD~1', 'HEAD')
    expect(diff.endsWith('\n… diff truncated')).toBe(true)
    expect(diff).toHaveLength(RESTORE_DIFF_MAX_CHARS + '\n… diff truncated'.length)
    expect(restoreDiff(root, 'no-such-revision', 'HEAD')).toBe('')
  })
})

describe('undo and revert through the protocol (SPEC §16.3)', () => {
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
    const endpoint = await server.start()
    client = new LocalMmsClient({ homeDir: f.home, endpoint, ownerToken, clientType: 'gui' })
    await client.connect()
  }, 30_000)
  afterEach(async () => {
    vi.restoreAllMocks()
    await client?.close()
    await server?.stop()
    await mms?.stop()
    f?.dispose()
  })

  /** A thread with one recorded code action that wrote `value.txt`. */
  const threadWithAction = async (name: string) => {
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread(name, project.id)
    const directory = mms.threads.getThreadDir(thread.id)
    const workspace = (await new WorkspaceResolver(directory, thread.id, f.repo).resolve('agent')).workspacePath!
    const { action } = await new ThreadActionService(directory).runCheckpointedAction({
      ...actionOptions(workspace, `code-${name}`), threadId: thread.id,
      actor: { kind: 'workflow', id: 'run' }, runId: 'run',
      presentationMessageStart: 0, presentationMessageEnd: 0, nativeContextStartBoundary: undefined,
      nativeContextBoundary: { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' }
    }, () => writeFileSync(join(workspace, 'value.txt'), 'agent code\n'))
    return { thread, workspace, action }
  }
  const runs = async (threadId: string) => (await client.request<{ runs: RunRecord[] }>('runs.list', { threadId })).runs

  it('weak containment returns the diff to review, restores nothing, and restores as an undo run once reviewed', async () => {
    const { thread, workspace, action } = await threadWithAction('weak')
    mms.orchestrator.setThreadModelOverride(thread.id, { llmProvider: 'claude-subscription', model: 'sonnet' })
    const review = await client.request<{ requiresReview: boolean; diff: string; diffSha: string; actionId: string }>('actions.undoLatest', { threadId: thread.id })
    expect(review).toMatchObject({ requiresReview: true, actionId: action.id })
    expect(review.diffSha).toBe(restoreDiffSha(review.diff))
    expect(review.diff).toContain('-agent code')
    expect(review.diff).toContain('+base')
    expect(f.read(workspace)).toBe('agent code\n')
    expect(await runs(thread.id)).toEqual([])
    const events = mms.runEngine.listEvents(thread.id).filter((event) => event.type === 'restore.review_required')
    expect(events.map((event) => event.payload)).toMatchObject([{ kind: 'undo', actionId: action.id, mode: 'review_diff', diffSha: review.diffSha }])

    const revertReview = await client.request<{ requiresReview: boolean }>('actions.revertCode', { threadId: thread.id, actionId: action.id })
    expect(revertReview.requiresReview).toBe(true)

    // The bare `reviewed: true` names no diff and is refused; a sha of another diff gets a fresh review.
    await expect(client.request('actions.undoLatest', { threadId: thread.id, reviewed: true })).rejects.toMatchObject({ code: 'invalid_params' })
    const stale = await client.request<{ requiresReview: boolean }>('actions.undoLatest', { threadId: thread.id, reviewedDiffSha: restoreDiffSha('another diff') })
    expect(stale.requiresReview).toBe(true)
    expect(f.read(workspace)).toBe('agent code\n')

    const undone = await client.request<{ action: { id: string }; runId: string }>('actions.undoLatest', { threadId: thread.id, reviewedDiffSha: review.diffSha })
    expect(f.read(workspace)).toBe('base\n')
    // S2: the undo run records how it restored (no adapter rolls back natively today).
    expect(await runs(thread.id)).toMatchObject([{ runId: undone.runId, source: 'undo', status: 'completed', outcome: { undoStrategy: 'checkpoint' } }])
  }, 30_000)

  it('unknown capabilities fail closed: the diff is reviewed first (M6)', async () => {
    const { thread, workspace } = await threadWithAction('unknown')
    vi.spyOn(mms.orchestrator, 'capabilitiesForThread').mockReturnValue(null)
    const review = await client.request<{ requiresReview: boolean; diffSha: string }>('actions.undoLatest', { threadId: thread.id })
    expect(review.requiresReview).toBe(true)
    expect(f.read(workspace)).toBe('agent code\n')
    expect(await runs(thread.id)).toEqual([])
  }, 30_000)

  it('strong containment restores automatically; undo and revert are runs; a failure ends the run failed', async () => {
    const { thread, workspace, action } = await threadWithAction('auto')
    mms.orchestrator.setThreadModelOverride(thread.id, { llmProvider: 'openai', model: 'gpt-4o' })
    const reverted = await client.request<{ runId: string }>('actions.revertCode', { threadId: thread.id, actionId: action.id })
    expect(f.read(workspace)).toBe('base\n')
    await expect(client.request('actions.revertCode', { threadId: thread.id, actionId: 'missing-action' })).rejects.toThrow()
    const listed = await runs(thread.id)
    expect(listed.map((run) => [run.source, run.status])).toEqual([['revert', 'failed'], ['revert', 'completed']])
    expect(listed[1].runId).toBe(reverted.runId)
  }, 30_000)

  it('refuses workspace_shared while another thread\'s live turn runs in the worktree', async () => {
    const { thread, workspace } = await threadWithAction('shared')
    mms.orchestrator.setThreadModelOverride(thread.id, { llmProvider: 'openai', model: 'gpt-4o' })
    vi.spyOn(mms.orchestrator, 'liveWorkspaceClaims').mockReturnValue([{ threadId: 'reader', path: workspace, kind: 'live_cwd' }])
    await expect(client.request('actions.undoLatest', { threadId: thread.id })).rejects.toMatchObject({ code: 'workspace_shared' })
    expect(f.read(workspace)).toBe('agent code\n')
    expect(await runs(thread.id)).toEqual([])
  }, 30_000)
})
