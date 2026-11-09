/**
 * Editing a prompt is a conversation branch that starts before its turn (`actions.fork` with `at: 'start'`): the files
 * and conversation from before that turn, made active, and the edited prompt sent there. The branch the turn ran on and
 * every edit of the same turn are its versions, which `actions.list` names for the prompt the conversation shows.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { ConversationBranchService } from '../src/mms/actions/ConversationBranchService'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { MousseMainService } from '../src/mms/MousseMainService'
import { dispatchMethod, promptVersionsOf } from '../src/mms/protocol/handlers'
import { WorkspaceResolver } from '../src/mms/workspace/WorkspaceResolver'
import type { ConversationBranch, ThreadAction } from '../src/shared/threadActions'
import { actionOptions, gitFoundationFixture } from './fixtures/gitFoundation'

describe('the versions of an edited prompt', () => {
  const branch = (id: string, parentTurnId: string, at?: 'start' | 'end'): ConversationBranch => ({
    id, name: id, parentBranchId: 'main', parentTurnId, ...(at ? { at } : {}), gitBranch: '', retainedRef: '',
    contextBoundary: { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' }, lifecycle: 'inactive', creationReason: 'fork', createdAt: ''
  })
  const action = (turnId: string, conversationBranchId: string) => ({
    turnId, conversationBranchId, actor: { kind: 'main' }, nativeContextStartBoundary: { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' }
  }) as ThreadAction
  const actions = [action('t1', 'main'), action('t2', 'main'), action('t2-edit', 'e1'), action('t2-edit-2', 'e2')]
  const branches = [branch('e1', 't2', 'start'), branch('e2', 't2', 'start'), branch('after', 't1')]

  it('names the original on the branch it ran on, and each edit on its own first turn, oldest first', () => {
    expect(promptVersionsOf(branches, actions, 'main')).toEqual([{ turnId: 't2', versions: ['main', 'e1', 'e2'], current: 0 }])
    expect(promptVersionsOf(branches, actions, 'e1')).toEqual([{ turnId: 't2-edit', versions: ['main', 'e1', 'e2'], current: 1 }])
    expect(promptVersionsOf(branches, actions, 'e2')).toEqual([{ turnId: 't2-edit-2', versions: ['main', 'e1', 'e2'], current: 2 }])
  })

  it('an edit of an edited prompt is another version of the same prompt, reachable from each version', () => {
    // t2 on main, edited into e1 (first turn t2-e1), which is edited again into e2 (first turn t2-e2).
    const nested = [action('t1', 'main'), action('t2', 'main'), action('t2-e1', 'e1'), action('t2-e2', 'e2')]
    const made = [{ ...branch('e1', 't2', 'start'), createdAt: '1' }, { ...branch('e2', 't2-e1', 'start'), parentBranchId: 'e1', createdAt: '2' }]
    expect(promptVersionsOf(made, nested, 'main')).toEqual([{ turnId: 't2', versions: ['main', 'e1', 'e2'], current: 0 }])
    expect(promptVersionsOf(made, nested, 'e1')).toEqual([{ turnId: 't2-e1', versions: ['main', 'e1', 'e2'], current: 1 }])
    expect(promptVersionsOf(made, nested, 'e2')).toEqual([{ turnId: 't2-e2', versions: ['main', 'e1', 'e2'], current: 2 }])
  })

  it('an edit of a later prompt on an edited version is its own prompt\'s version, not the earlier one\'s', () => {
    // e1 replaced t2 (first turn t2-e1) and went on with t3-e1; editing t3-e1 makes versions of that prompt only.
    const later = [action('t2', 'main'), action('t2-e1', 'e1'), action('t3-e1', 'e1'), action('t3-e3', 'e3')]
    const made = [{ ...branch('e1', 't2', 'start'), createdAt: '1' }, { ...branch('e3', 't3-e1', 'start'), parentBranchId: 'e1', createdAt: '2' }]
    expect(promptVersionsOf(made, later, 'e1')).toEqual([
      { turnId: 't2-e1', versions: ['main', 'e1'], current: 1 },
      { turnId: 't3-e1', versions: ['e1', 'e3'], current: 0 }
    ])
    expect(promptVersionsOf(made, later, 'e3')).toEqual([{ turnId: 't3-e3', versions: ['e1', 'e3'], current: 1 }])
  })

  it('shows none for a branch after a turn, an edit never sent, or a removed edit', () => {
    expect(promptVersionsOf([branch('after', 't1')], actions, 'after')).toEqual([])
    expect(promptVersionsOf([branch('e3', 't2', 'start')], actions, 'e3')).toEqual([])
    expect(promptVersionsOf([{ ...branch('e1', 't2', 'start'), lifecycle: 'tombstoned' }], actions, 'main')).toEqual([])
  })
})

describe('editing a prompt through the daemon', { timeout: 60_000 }, () => {
  let f: ReturnType<typeof gitFoundationFixture>
  let mms: MousseMainService
  beforeEach(async () => {
    f = gitFoundationFixture()
    mms = await MousseMainService.create({ homeDir: f.home, headless: true, ownerKind: 'test' })
    await mms.start()
  })
  afterEach(async () => { vi.restoreAllMocks(); await mms.stop(); f.dispose() })

  /** A thread with two recorded turns: the first writes `first.txt`, the second `second.txt`. */
  const twoTurns = async () => {
    const thread = mms.threads.createThread('Edit', mms.projects.openProject(f.repo).id)
    const directory = mms.threads.getThreadDir(thread.id)
    const cwd = (await new WorkspaceResolver(directory, thread.id, f.repo).resolve('agent')).workspacePath!
    const actions = new ThreadActionService(directory)
    const record = async (turnId: string, start: number, file: string, conversationBranchId = 'main') => (await actions.runCheckpointedAction({
      ...actionOptions(cwd, turnId), threadId: thread.id, conversationBranchId, presentationMessageStart: start, presentationMessageEnd: start + 2,
      nativeContextStartBoundary: { messageIndex: start, compactionGeneration: 0, fidelity: 'exact', safeBoundaryProof: 'test' },
      nativeContextBoundary: { messageIndex: start + 2, compactionGeneration: 0, fidelity: 'exact', safeBoundaryProof: 'test' }
    }, () => writeFileSync(join(cwd, file), `${turnId}\n`))).action
    const first = await record('t1', 0, 'first.txt')
    const second = await record('t2', 2, 'second.txt')
    const call = (method: string, params: Record<string, unknown> = {}) => dispatchMethod({ mms, globalSequence: () => 0 }, method, { threadId: thread.id, ...params })
    return { thread, cwd, first, second, record, call }
  }

  it('an edit of the second prompt shares the files as they are: making it, switching to it and back change no file', async () => {
    const { cwd, second, record, call } = await twoTurns()
    const { branch } = await call('actions.fork', { actionId: second.id, at: 'start', name: 'Edited' }) as { branch: ConversationBranch }
    expect(branch).toMatchObject({ parentTurnId: 't2', at: 'start', files: 'shared', contextBoundary: { messageIndex: 2 } })
    await call('actions.activateBranch', { conversationBranchId: branch.id })
    expect(readFileSync(join(cwd, 'first.txt'), 'utf8')).toBe('t1\n')
    expect(readFileSync(join(cwd, 'second.txt'), 'utf8')).toBe('t2\n')

    // The edited prompt's turn runs on the new branch; the conversation then shows its versions on that prompt.
    await record('t2-edit', 2, 'edited.txt', branch.id)
    expect((await call('actions.list') as { promptVersions: unknown }).promptVersions).toEqual([{ turnId: 't2-edit', versions: ['main', branch.id], current: 1 }])
    await call('actions.activateBranch', { conversationBranchId: 'main' })
    for (const file of ['first.txt', 'second.txt', 'edited.txt']) expect(existsSync(join(cwd, file))).toBe(true)
    expect((await call('actions.list') as { promptVersions: unknown }).promptVersions).toEqual([{ turnId: 't2', versions: ['main', branch.id], current: 0 }])
  })

  it('edits the first prompt, which has no turn before it, and leaves its files', async () => {
    const { cwd, first, call } = await twoTurns()
    const { branch } = await call('actions.fork', { actionId: first.id, at: 'start', activate: true }) as { branch: ConversationBranch }
    expect(branch.files).toBe('shared')
    expect(existsSync(join(cwd, 'first.txt'))).toBe(true)
    expect(existsSync(join(cwd, 'second.txt'))).toBe(true)
  })

  it('keeps a branch made before the first compaction free of the summary made later', async () => {
    const { thread, first, call } = await twoTurns()
    // The conversation was compacted after the first turn: its summary covers turns the edit cuts off.
    const native = mms.orchestrator.getNativeContext(thread.id)
    mms.orchestrator.replaceConversationState(thread.id, mms.orchestrator.getMessagesForPersistence(thread.id), {
      ...native, compaction: { generation: 1, summary: 'the second turn wrote second.txt', tokensBefore: 10, createdAt: 1 }
    })
    const { branch } = await call('actions.fork', { actionId: first.id, at: 'start', activate: true }) as { branch: ConversationBranch }
    expect(branch.contextBoundary.compaction).toBeUndefined()
    expect(mms.orchestrator.getNativeContext(thread.id).compaction).toBeUndefined()
    const saved = JSON.parse(readFileSync(join(mms.threads.getThreadDir(thread.id), 'conversation-contexts', `${encodeURIComponent(branch.id)}.json`), 'utf8'))
    expect(saved.nativeContext.compaction).toBeUndefined()
  })

  it('finishes a conversation-only switch that stopped after it was recorded, before the thread named the branch', async () => {
    const { thread, second, call } = await twoTurns()
    const directory = mms.threads.getThreadDir(thread.id)
    const { branch } = await call('actions.fork', { actionId: second.id, at: 'start' }) as { branch: ConversationBranch }
    // The process stopped right after the switch was recorded as pending: nothing else changed yet.
    new ThreadJournal(directory).append({ operationId: 'stopped-switch', operationType: 'conversation-activate', state: 'context_pending', details: { branchId: branch.id, restoreContext: true, conversationOnly: true } })
    expect(new ThreadWorkspaceManager(directory).load()!.conversationBranchId ?? 'main').toBe('main')
    const restored: string[] = []
    await new ConversationBranchService(directory).recoverPending(new ThreadWorkspaceManager(directory).load()!.worktreePath, (selected) => { restored.push(selected.id) })
    expect(restored).toEqual([branch.id])
    expect(new ThreadWorkspaceManager(directory).load()!.conversationBranchId).toBe(branch.id)
    expect(new ConversationBranchService(directory).list().find((item) => item.id === branch.id)?.lifecycle).toBe('active')
    expect(new ThreadJournal(directory).latestByOperation().get('stopped-switch')?.state).toBe('completed')
  })

  it('turns on an edited version never write over the files an inactive branch owns', async () => {
    const { cwd, first, record, call } = await twoTurns()
    // B owns its files: a branch after the first turn, switched to by a file switch, with a turn of its own.
    const { branch: b } = await call('actions.fork', { actionId: first.id }) as { branch: ConversationBranch }
    await call('actions.activateBranch', { conversationBranchId: b.id })
    expect(existsSync(join(cwd, 'second.txt'))).toBe(false)
    const own = await record('b1', 2, 'b.txt', b.id)
    // Edit B's prompt and run the edited version, which writes a file of its own.
    const { branch: e } = await call('actions.fork', { actionId: own.id, at: 'start', activate: true }) as { branch: ConversationBranch }
    await record('e1', 2, 'edited.txt', e.id)
    // Back on Main (conversation only: the files stay), then a file switch to B brings back B's own files.
    await call('actions.activateBranch', { conversationBranchId: 'main' })
    expect(existsSync(join(cwd, 'edited.txt'))).toBe(true)
    await call('actions.activateBranch', { conversationBranchId: b.id })
    expect(existsSync(join(cwd, 'b.txt'))).toBe(true)
    expect(existsSync(join(cwd, 'edited.txt'))).toBe(false)
  })

  it('keeps edits a file switch brought along through a conversation-only round trip', async () => {
    const { thread, cwd, first, second, call } = await twoTurns()
    const { branch: e } = await call('actions.fork', { actionId: second.id, at: 'start', activate: true }) as { branch: ConversationBranch }
    await call('actions.activateBranch', { conversationBranchId: 'main' })
    const { branch: b } = await call('actions.fork', { actionId: first.id }) as { branch: ConversationBranch }
    writeFileSync(join(cwd, 'notes.txt'), 'my notes\n')
    await call('actions.activateBranch', { conversationBranchId: b.id })
    expect(readFileSync(join(cwd, 'notes.txt'), 'utf8')).toBe('my notes\n')
    // B → E → B changes the conversation only; the notes still travel with the next file switch.
    await call('actions.activateBranch', { conversationBranchId: e.id })
    await call('actions.activateBranch', { conversationBranchId: b.id })
    await call('actions.activateBranch', { conversationBranchId: 'main' })
    expect(readFileSync(join(cwd, 'notes.txt'), 'utf8')).toBe('my notes\n')
    expect(new ThreadWorkspaceManager(mms.threads.getThreadDir(thread.id)).load()!.conversationBranchId).toBe('main')
  })

  it('finishes a switch that stopped before a newer one goes ahead, so recovery never puts it back over the newer one', async () => {
    const { thread, first, second, call } = await twoTurns()
    const directory = mms.threads.getThreadDir(thread.id)
    const { branch: a } = await call('actions.fork', { actionId: second.id, at: 'start' }) as { branch: ConversationBranch }
    const { branch: b } = await call('actions.fork', { actionId: first.id, at: 'start' }) as { branch: ConversationBranch }
    new ThreadJournal(directory).append({ operationId: 'stopped-a', operationType: 'conversation-activate', state: 'context_pending', details: { branchId: a.id, restoreContext: true, conversationOnly: true } })
    await call('actions.activateBranch', { conversationBranchId: b.id })
    expect(new ThreadJournal(directory).latestByOperation().get('stopped-a')?.state).toBe('completed')
    expect(new ThreadWorkspaceManager(directory).load()!.conversationBranchId).toBe(b.id)
    await new ConversationBranchService(directory).recoverPending(new ThreadWorkspaceManager(directory).load()!.worktreePath, () => undefined)
    expect(new ThreadWorkspaceManager(directory).load()!.conversationBranchId).toBe(b.id)
  })

  it('refuses to make or switch a branch while a turn or queued work is busy, before anything changes', async () => {
    const { second, call } = await twoTurns()
    const { branch } = await call('actions.fork', { actionId: second.id, at: 'start' }) as { branch: ConversationBranch }
    vi.spyOn(mms.orchestrator, 'isConversationHistoryBusy').mockReturnValue(true)
    await expect(call('actions.fork', { actionId: second.id, at: 'start' })).rejects.toMatchObject({ code: 'thread_busy' })
    await expect(call('actions.activateBranch', { conversationBranchId: branch.id })).rejects.toMatchObject({ code: 'thread_busy' })
    await expect(call('actions.fork', { actionId: second.id, at: 'middle' })).rejects.toMatchObject({ code: 'invalid_params' })
  })
})
