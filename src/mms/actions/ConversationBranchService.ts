import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from '../../shared/errors'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { ThreadJournal } from '../data/ThreadJournal'
import type { ConversationBranch, NativeContextBoundary } from '../../shared/threadActions'
import type { ConversationBranchId, ThreadWorkspaceMetadata } from '../../shared/workspace'
import { ThreadActionService, USER_CHANGES_TURN_PREFIX } from './ThreadActionService'
import { UndoRetentionService } from './UndoRetentionService'
import { withGitMutationLocks } from './GitOperationCoordinator'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import { ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import { ChangeReceiptService } from './ChangeReceiptService'
import { gitAsync, LISTING, mergeTreesAsync, refuseUnsafeChangesAsync, treeOfAsync, tryGitAsync } from './git'
import { restoreCommandsText, restoreKindOf } from './restoreCommands'
import { coverageNotice, exactBytesNotice, exactTreeOfAsync, namedGapsAsync, leftAsIsNotice, moveOutcome, moveProgressAsync, plannedExactAsync, plannedExactGapsAsync, preservedNotice, restoreChangeAsync, snapshotOfTreeAsync, takeSnapshotAsync, type Snapshot } from './snapshots'
import { retentionWindowText } from '../../shared/undoRetention'

/** The thread's first conversation branch: the one every thread starts on. */
export const FIRST_BRANCH_ID = 'main'

/** The selected conversation branch does not exist, was removed, or can't be switched to. Nothing was changed. */
export class ConversationBranchUnavailableError extends AppError {
  constructor(readonly branchId: string) {
    super({
      code: 'conversation_branch_unavailable',
      message: `Conversation branch ${branchId} is not available to switch to. Nothing was changed.`,
      details: { branchId }, errorInfo: { category: 'unavailable', retryable: false }
    })
    this.name = 'ConversationBranchUnavailableError'
  }
}

/** The person's edits since the last record overlap with the files of the branch being switched to. Nothing was changed. */
export class ConversationSwitchConflictError extends AppError {
  constructor(readonly files: string[], target: string, current: string) {
    super({
      code: 'restore_conflict',
      message: `Switching to ${target} would overwrite your edits in: ${files.join(', ') || 'some files'}. They stay on ${current}. Nothing was changed.`,
      details: { files }, errorInfo: { category: 'conflict', retryable: false }
    })
    this.name = 'ConversationSwitchConflictError'
  }
}

/** Files changed while the switch was writing them, so it wrote nothing. Nothing was changed. */
export class ConversationSwitchInterruptedError extends AppError {
  constructor(readonly files: string[], target: string) {
    super({
      code: 'restore_conflict',
      message: `${files.length ? files.join(', ') : 'A file'} changed while switching to ${target}. Nothing was changed. Try the switch again.`,
      details: { files }, errorInfo: { category: 'conflict', retryable: true }
    })
    this.name = 'ConversationSwitchInterruptedError'
  }
}

/** What `prepared` records for a switch: everything recovery needs to tell whether the files were changed. */
interface SwitchIntent {
  branchId: ConversationBranchId
  leaving: ConversationBranchId
  /** The files before the switch (the snapshot the merge was computed onto). */
  ours: string
  /** The tree the switch turns the files into. */
  expectedTree: string
  /** Its exact tree (see `snapshots.ts`), when the switch was exact; absent in intents written before. */
  expectedExactTree?: string
  /** The selected branch's own code (its ref when the switch began). */
  own: string
  /** The code of the branch being left: what it keeps when the switch does not happen. */
  base?: string
  restoreContext: boolean
}

type SwitchedIn = NonNullable<ThreadWorkspaceMetadata['switchedIn']>

/** Paths in words: "a.txt", "a.txt and b.txt", "a.txt, b.txt and 3 more". */
function pathsInWords(paths: string[]): string {
  const named = paths.slice(0, 5)
  const rest = paths.length - named.length
  if (rest > 0) return `${named.join(', ')} and ${rest} more`
  return named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}` : named[0]!
}

/** What an activation returns: the branch now active, and what the switch kept or left as it was, in words. */
export interface ConversationBranchActivation {
  branch: ConversationBranch
  notice?: string
}

export class ConversationBranchService {
  private readonly path: string
  private readonly actions: ThreadActionService
  private readonly journal: ThreadJournal
  constructor(private readonly threadDirectory: string) {
    this.path = join(threadDirectory, 'conversation-branches.json')
    this.actions = new ThreadActionService(threadDirectory)
    this.journal = new ThreadJournal(threadDirectory)
  }

  list(): ConversationBranch[] {
    return existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) as ConversationBranch[] : []
  }

  /**
   * The branch a switch to `branchId` would activate, or undefined when there is none to switch to: no record, or a
   * removed one. The thread's first branch counts while the thread is still on it, before its record is written. A
   * thread that left its first branch before first branches had records has none, and none is made up for it.
   */
  available(branchId: ConversationBranchId, metadata = new ThreadWorkspaceManager(this.threadDirectory).load()): ConversationBranch | undefined {
    const leaving = metadata?.conversationBranchId ?? FIRST_BRANCH_ID
    return this.withFirstBranch(this.list(), metadata, leaving).branches.find((branch) => branch.id === branchId && branch.lifecycle !== 'tombstoned')
  }

  /**
   * The branch list with a record for the thread's first branch, made while the thread is still on that branch: it is
   * `active`, pins its code under the thread's own ref, and starts its conversation at the latest action's boundary.
   * `added` says whether the record is new (and still to be written).
   */
  private withFirstBranch(branches: ConversationBranch[], metadata: ThreadWorkspaceMetadata | undefined, current: ConversationBranchId): { branches: ConversationBranch[]; added: boolean } {
    if (current !== FIRST_BRANCH_ID || branches.some((branch) => branch.id === FIRST_BRANCH_ID)) return { branches, added: false }
    const threadId = metadata?.threadId
    const boundary: NativeContextBoundary = this.actions.latest(FIRST_BRANCH_ID)?.nativeContextBoundary ?? { messageIndex: 0, compactionGeneration: 0, fidelity: 'legacy' }
    const first: ConversationBranch = {
      id: FIRST_BRANCH_ID,
      name: 'Main',
      gitBranch: metadata?.branch ?? '',
      // The ref the thread's first branch already pins its latest snapshot under; a thread with no workspace record has its own.
      retainedRef: threadId ? `refs/mousse/threads/${threadId}/${FIRST_BRANCH_ID}` : `refs/mousse/conversation-branches/${randomUUID()}`,
      contextBoundary: boundary,
      lifecycle: 'active',
      creationReason: 'initial',
      createdAt: new Date().toISOString()
    }
    return { branches: [first, ...branches], added: true }
  }

  /**
   * Makes another conversation branch the active one, and its files with it, by one three-way merge computed before
   * anything is written: from the code of the branch being left (`base`), onto the files now (`ours`), towards the
   * selected branch's own code (`theirs`). The branch's code is what it last recorded, or, while nothing has been
   * recorded since it was switched to, its own code from then (`switchedIn`): edits brought along on the way in come
   * along again. Edits made since (the person's own, in an editor or a terminal) come along; the branch being left
   * keeps its code under its ref, and the files as they are now stay pinned by the outside-changes record. When those
   * edits overlap with the selected branch's code, nothing changes and the files are named. HEAD, the Git branches
   * and the index are never touched.
   *
   * `saveContext` is told the branch being left once the switch is known to go ahead, before any file changes;
   * `restoreContext` is told the selected branch once its files are in place.
   */
  async activate(
    workspacePath: string,
    branchId: ConversationBranchId,
    expectedJournalRevision?: number,
    restoreContext?: (branch: ConversationBranch) => void | Promise<void>,
    saveContext?: (leaving: ConversationBranchId) => void | Promise<void>,
    assertIdle?: () => void
  ): Promise<ConversationBranchActivation> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, 'conversation-activate', async () => {
      // Under the thread's locks, which a turn holds while it runs: no turn can start between this check and the switch.
      assertIdle?.()
      this.actions.assertExpectedRevision(expectedJournalRevision)
      return this.activateHeld(workspacePath, branchId, restoreContext, saveContext)
    })
  }

  /** {@link activate}, under the locks the caller holds. */
  private async activateHeld(
    workspacePath: string,
    branchId: ConversationBranchId,
    restoreContext?: (branch: ConversationBranch) => void | Promise<void>,
    saveContext?: (leaving: ConversationBranchId) => void | Promise<void>
  ): Promise<ConversationBranchActivation> {
    {
      const manager = new ThreadWorkspaceManager(this.threadDirectory)
      const metadata = manager.load()
      const leaving = metadata?.conversationBranchId ?? FIRST_BRANCH_ID
      const { branches, added } = this.withFirstBranch(this.list(), metadata, leaving)
      const selected = branches.find((branch) => branch.id === branchId && branch.lifecycle !== 'tombstoned')
      if (!selected) throw new ConversationBranchUnavailableError(branchId)
      const threadId = metadata?.threadId
      const operationId = randomUUID()
      // A switch to or from a branch that shares the thread's files (an edited prompt's) changes the conversation
      // only: no file is read, merged, restored or refused, so it can't conflict and the folder stays as it is.
      const conversationOnly = selected.files === 'shared' || branches.find((branch) => branch.id === leaving)?.files === 'shared'
      // A switch that stopped is finished by recovery first; a newer one never goes ahead of it, or recovery would
      // later put the older one back over it.
      new ChangeReceiptService(this.threadDirectory).assertNoPendingOperation()
      if (conversationOnly && leaving !== selected.id) {
        // No file is read or recorded: the thread's files, and the ref and snapshot that record them, stay as they are.
        // The branch being left has its conversation saved first; then the switch is recorded as pending before the
        // branch list or the thread's record change, so recovery finishes it (`recoverPending`) whatever stopped it.
        this.journal.append({ operationId, operationType: 'conversation-activate', state: 'running', expectedPreState: { branchId, leaving, conversationOnly: true } })
        try {
          await saveContext?.(leaving)
        } catch (error) {
          this.journal.append({ operationId, operationType: 'conversation-activate', state: 'failed', details: { branchId, error: error instanceof Error ? error.message : String(error) } })
          throw error
        }
        this.journal.append({ operationId, operationType: 'conversation-activate', state: 'context_pending', details: { branchId: selected.id, restoreContext: Boolean(restoreContext), conversationOnly: true } })
        await this.settleConversation(workspacePath, branches, selected)
        if (restoreContext) await restoreContext(selected)
        this.journal.append({ operationId, operationType: 'conversation-activate', state: 'completed', details: { branchId: selected.id, conversationOnly: true } })
        return { branch: selected }
      }
      new ChangeReceiptService(this.threadDirectory).assertNoPendingOperation()
      await refuseUnsafeChangesAsync(workspacePath, 'Thread workspace', { discard: true })
      this.journal.append({
        operationId,
        operationType: 'conversation-activate',
        state: 'running',
        expectedPreState: { branchId, leaving, preBranch: await gitAsync(workspacePath, ['branch', '--show-current']), preSha: (await tryGitAsync(workspacePath, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])).stdout }
      })
      let intent: SwitchIntent | undefined
      // Once the outside changes are recorded: what the branch being left keeps when the switch does not happen.
      let staying: { base: string; current: string } | undefined
      try {
        if (leaving === selected.id) {
          // Already active: the files and the record stay as they are.
          await saveContext?.(leaving)
          for (const branch of branches) if (branch.lifecycle !== 'tombstoned') branch.lifecycle = branch.id === branchId ? 'active' : 'inactive'
          atomicWriteJsonSync(this.path, branches)
          return this.complete(operationId, selected, restoreContext)
        }
        const left = branches.find((branch) => branch.id === leaving && branch.lifecycle !== 'tombstoned')
        const leftName = left?.name ?? leaving
        const top = await gitAsync(workspacePath, ['rev-parse', '--show-toplevel'])
        // The whole merge is worked out before anything is written or recorded: a conflict leaves files and refs as they were.
        const ours = await takeSnapshotAsync(workspacePath, { reason: `before switching to conversation branch ${selected.id}`, threadId, operationId })
        const base = await this.leavingCode(workspacePath, metadata, leaving) ?? ours.sha
        const theirs = await gitAsync(workspacePath, ['rev-parse', '--verify', `${selected.retainedRef}^{commit}`])
        const merged = await mergeTreesAsync(top, base, ours.sha, theirs)
        if ('conflicts' in merged) throw new ConversationSwitchConflictError(merged.conflicts, selected.name, leftName)
        await saveContext?.(leaving)
        // Edits made outside Mousse since the last record are recorded for the branch being left: its receipt pins the
        // files as they are now. The branch's ref keeps its own code, so edits brought along stay out of it.
        const outside = await this.actions.recordOutsideChangesHeld({ threadId: threadId ?? '', conversationBranchId: leaving, workspacePath })
        const current = outside.startSha
        staying = { base, current }
        if (left) await gitAsync(workspacePath, ['update-ref', '--no-deref', left.retainedRef, base])
        if (added) atomicWriteJsonSync(this.path, branches)
        const restored = await restoreChangeAsync(workspacePath, { reason: `switch to conversation branch ${selected.id}`, threadId, operationId, base, ours: current, theirs, restoredTo: `on ${selected.name}`, keep: { owner: this.threadDirectory, action: 'Switching conversation branches' } }, (expectedTree, expectedExactTree) => {
          intent = { branchId: selected.id, leaving, ours: current, expectedTree, ...(expectedExactTree ? { expectedExactTree } : {}), own: theirs, base, restoreContext: Boolean(restoreContext) }
          this.journal.append({ operationId, operationType: 'conversation-activate', state: 'prepared', expectedPreState: { branchId, leaving, ours: current }, details: intent })
        })
        if ('conflicts' in restored) throw new ConversationSwitchConflictError(restored.conflicts, selected.name, leftName)
        const leftBehind = await this.leftBehind(workspacePath, metadata, leaving, current, restored.tree)
        const notice = [
          leftBehind.length && left ? await this.leftBehindNotice(workspacePath, { paths: leftBehind, target: selected.name, leftName, leftRef: left.retainedRef, base, current, receiptId: outside.action?.receiptId, operationId }) : '',
          restored.preserved ? preservedNotice(restored.preserved, new UndoRetentionService(this.threadDirectory).policy().windowMs) : '',
          restored.exact ? exactBytesNotice(restored.exact) : '',
          leftAsIsNotice(restored.leftAsIs) ?? '', coverageNotice(await namedGapsAsync(workspacePath, current, restored.snapshot.sha, ours.coverageGaps, restored.snapshot.coverageGaps)) ?? ''
        ].filter(Boolean).join(' ') || undefined
        await this.settle(workspacePath, branches, selected, restored.snapshot, { branchId: selected.id, snapshotSha: restored.snapshot.sha, own: theirs, at: new Date().toISOString() })
        return this.complete(operationId, selected, restoreContext, restored.snapshot.sha, notice)
      } catch (error) {
        const state = this.journal.latestByOperation().get(operationId)?.state
        if (state === 'context_pending') throw error
        if (state === 'prepared' && intent) {
          // Stopped after the intent. Git refuses the whole write when a file it writes was saved meanwhile ("not
          // uptodate"), before writing anything; otherwise, when none of the files it writes changed, nothing was
          // written either. Then the switch is settled as not done and the files named; else recovery tells from the files.
          const message = error instanceof Error ? error.message : String(error)
          const named = [...message.matchAll(/Entry '([^']+)' not uptodate/g)].map((match) => match[1]!)
          const refused = /not uptodate/.test(message)
          const planned = intent
          const progress = refused ? undefined : await plannedExactAsync(workspacePath, planned.ours, planned.expectedExactTree).then(async (exact) => moveProgressAsync(workspacePath, await treeOfAsync(workspacePath, planned.ours), planned.expectedTree, exact)).catch(() => undefined)
          if (!refused && (!progress || moveOutcome(progress) !== 'not-applied')) throw error
          const files = progress?.other.length ? progress.other : named
          this.journal.append({ operationId, operationType: 'conversation-activate', state: 'cancelled', details: { branchId, files, error: message } })
          this.stayOn(leaving, intent.base ?? intent.ours, intent.ours)
          if (refused || files.length) throw new ConversationSwitchInterruptedError(files, selected.name)
          throw error
        }
        this.journal.append({
          operationId,
          operationType: 'conversation-activate',
          state: 'failed',
          details: { branchId, error: error instanceof Error ? error.message : String(error) }
        })
        if (staying) this.stayOn(leaving, staying.base, staying.current)
        throw error
      }
    }
  }

  /**
   * A conversation-only switch: the selected branch is active and the thread's record says so. The files are the same,
   * so the selected branch takes them as its own: its ref is moved to the commit that records the files now (the
   * thread's `retainedRef`, which every turn's record moves), and becomes the thread's `retainedRef`. The branch left
   * keeps its ref as it was, so an inactive branch that owns its files never has them written over by turns on
   * another. The snapshot, HEAD and `switchedIn` (what a file switch brought along, which a later file switch merges
   * from) stay as they are. Reads a ref, never a file. Idempotent: recovery runs it again.
   */
  private async settleConversation(workspacePath: string, branches: ConversationBranch[], selected: ConversationBranch): Promise<void> {
    for (const branch of branches) if (branch.lifecycle !== 'tombstoned') branch.lifecycle = branch.id === selected.id ? 'active' : 'inactive'
    atomicWriteJsonSync(this.path, branches)
    const manager = new ThreadWorkspaceManager(this.threadDirectory)
    const metadata = manager.load()
    if (!metadata) return
    const files = metadata.retainedRef ? (await tryGitAsync(workspacePath, ['rev-parse', '--verify', '-q', `${metadata.retainedRef}^{commit}`])).stdout.trim() : ''
    if (files && metadata.retainedRef !== selected.retainedRef) await gitAsync(workspacePath, ['update-ref', '--no-deref', selected.retainedRef, files])
    if (metadata.conversationBranchId === selected.id && (!files || metadata.retainedRef === selected.retainedRef)) return
    atomicWriteJsonSync(manager.workspacePath, {
      ...metadata, conversationBranchId: selected.id, ...(files ? { retainedRef: selected.retainedRef } : {}), generation: (metadata.generation ?? 0) + 1
    })
  }

  /** Restores the selected branch's conversation and records the switch as done. */
  private async complete(operationId: string, selected: ConversationBranch, restoreContext: ((branch: ConversationBranch) => void | Promise<void>) | undefined, snapshotSha?: string, notice?: string): Promise<ConversationBranchActivation> {
    this.journal.append({ operationId, operationType: 'conversation-activate', state: 'context_pending', details: { branchId: selected.id, ...(snapshotSha ? { snapshotSha } : {}), restoreContext: Boolean(restoreContext), ...(notice ? { notice } : {}) } })
    if (restoreContext) await restoreContext(selected)
    this.journal.append({ operationId, operationType: 'conversation-activate', state: 'completed', details: { branchId: selected.id, ...(notice ? { notice } : {}) } })
    return { branch: selected, ...(notice ? { notice } : {}) }
  }

  /**
   * The code of the branch being left, without edits made since its last record: its own code from when it was
   * switched to, while no action has been recorded on it since (a turn, an Undo, a Redo, a revert or an
   * outside-changes record); otherwise its last record (`lastRecorded`). Files that match what it arrived with say
   * nothing: a turn may have recorded the edits brought along and then put the same bytes back.
   */
  private async leavingCode(workspacePath: string, metadata: ThreadWorkspaceMetadata | undefined, leaving: ConversationBranchId): Promise<string | undefined> {
    const arrived = metadata?.switchedIn
    if (arrived?.branchId === leaving && await this.readable(workspacePath, arrived.own) && !this.recordedSince(leaving, arrived.at)) return arrived.own
    return this.lastRecorded(workspacePath, metadata, leaving)
  }

  /** Whether an action was recorded on the branch after `at`. */
  private recordedSince(branchId: ConversationBranchId, at: string): boolean {
    return this.actions.list().some((action) => action.conversationBranchId === branchId && action.createdAt > at)
  }

  /**
   * A switch that did not happen: the branch being left stays active, with `base` as its own code and the files now
   * (`current`) as what it holds besides, so the outside-changes record the switch made does not count as a record of
   * the person's edits and a retry brings them along again.
   */
  private stayOn(leaving: ConversationBranchId, base: string, current: string): void {
    const manager = new ThreadWorkspaceManager(this.threadDirectory)
    const metadata = manager.load()
    if (!metadata || (metadata.conversationBranchId ?? FIRST_BRANCH_ID) !== leaving) return
    atomicWriteJsonSync(manager.workspacePath, { ...metadata, switchedIn: { branchId: leaving, own: base, snapshotSha: current, at: new Date().toISOString() } })
  }

  /**
   * The line a switch carries for the person's files it takes out of the folder: where their version stays, and a
   * command for each file that brings it back as it was before the switch (`restoreCommands.ts`). The branch's ref holds it when the file
   * there is the same; otherwise the outside-changes record of the switch, or a kept copy of the files before it, does
   * (for the Undo retention window).
   */
  private async leftBehindNotice(workspacePath: string, input: { paths: string[]; target: string; leftName: string; leftRef: string; base: string; current: string; receiptId?: string; operationId: string }): Promise<string> {
    const { paths } = input
    const literal = paths.map((path) => `:(literal)${path}`)
    const exact = !(await gitAsync(workspacePath, ['diff-tree', '-r', '--name-only', input.base, input.current, '--', ...literal], undefined, undefined, LISTING)).trim()
    let source = input.leftRef
    let kept = ''
    if (!exact) {
      const receipt = input.receiptId ? new ChangeReceiptService(this.threadDirectory).list().find((item) => item.id === input.receiptId) : undefined
      source = receipt?.retainedRefs[1] ?? `refs/mousse/preserved/${input.operationId}-${input.current.slice(0, 12)}`
      if (!receipt) await gitAsync(workspacePath, ['update-ref', '--no-deref', source, input.current])
      kept = ` (kept for ${retentionWindowText(new UndoRetentionService(this.threadDirectory).policy().windowMs)})`
    }
    const one = paths.length === 1
    const top = await gitAsync(workspacePath, ['rev-parse', '--show-toplevel'])
    // Each file comes back as what the ref has: a link as a link, an executable file with its mode.
    const listed = async (tree: string) => new Map((await gitAsync(workspacePath, ['ls-tree', '-z', tree, '--', ...literal], undefined, undefined, LISTING)).split('\0').filter(Boolean).map((line) => [line.slice(line.indexOf('\t') + 1), line.slice(0, line.indexOf(' '))]))
    const modes = await listed(source)
    // The ref holds a snapshot. Where it records the file's exact bytes (its first parent's tree, see `snapshots.ts`) the
    // command writes those as they are; otherwise Git's normal form, converted back as a checkout would.
    const exactTree = await exactTreeOfAsync(workspacePath, source)
    const exactModes = exactTree ? await listed(exactTree) : new Map<string, string>()
    const commands = restoreCommandsText(paths.map((path) => exactModes.has(path)
      ? { ref: `${source}^`, path, kind: restoreKindOf(exactModes.get(path)), normalized: false }
      : { ref: source, path, kind: restoreKindOf(modes.get(path)), normalized: true }))
    return `${pathsInWords(paths)} ${one ? 'is now as it was' : 'are now as they were'} on ${input.target}. Your ${one ? 'version stays' : 'versions stay'} on ${input.leftName}: switch back to it, or bring ${one ? 'it' : 'them'} back by running this in ${top}: ${commands}${kept}.`
  }

  private async readable(workspacePath: string, sha: string): Promise<boolean> {
    return (await tryGitAsync(workspacePath, ['cat-file', '-e', `${sha}^{commit}`])).ok
  }

  /**
   * The files that were the person's on the branch being left and that the switch changes: any an outside-changes
   * record on it touched, or that came along when it was switched to, even when a turn edited them since. Such a file
   * leaves the folder only because a record made it the branch's own (a turn or the outside-changes record before it).
   */
  private async leftBehind(workspacePath: string, metadata: ThreadWorkspaceMetadata | undefined, leaving: ConversationBranchId, from: string, to: string): Promise<string[]> {
    const changed = (await gitAsync(workspacePath, ['diff-tree', '-r', '-z', '--no-renames', '--name-only', from, to], undefined, undefined, LISTING)).split('\0').filter(Boolean)
    if (!changed.length) return []
    const personal = new Set<string>()
    const arrived = metadata?.switchedIn?.branchId === leaving ? metadata.switchedIn : undefined
    if (arrived && await this.readable(workspacePath, arrived.own) && await this.readable(workspacePath, arrived.snapshotSha)) {
      for (const path of (await gitAsync(workspacePath, ['diff-tree', '-r', '-z', '--no-renames', '--name-only', arrived.own, arrived.snapshotSha], undefined, undefined, LISTING)).split('\0').filter(Boolean)) personal.add(path)
    }
    for (const action of this.actions.list()) {
      if (action.conversationBranchId === leaving && action.turnId.startsWith(USER_CHANGES_TURN_PREFIX)) for (const change of action.changedPaths) personal.add(change.path)
    }
    return changed.filter((path) => personal.has(path))
  }

  /**
   * The files as last recorded on the branch being left, before edits made since: the workspace's latest snapshot, or
   * for a workspace recorded before snapshots, the branch's latest action or the HEAD it recorded. Undefined when none
   * can be read, so the switch counts nothing as edited since.
   */
  private async lastRecorded(workspacePath: string, metadata: ThreadWorkspaceMetadata | undefined, leaving: ConversationBranchId): Promise<string | undefined> {
    for (const candidate of [metadata?.snapshotSha, this.actions.latest(leaving)?.endSha, metadata?.headSha]) {
      if (candidate && await this.readable(workspacePath, candidate)) return candidate
    }
    return undefined
  }

  /**
   * Records `selected` as the active branch, whose files are `snapshot`. Its ref points at the files it arrived with,
   * as an active branch's ref always points at its latest snapshot (a rebuild of a missing worktree reads it);
   * `switchedIn` keeps its own code apart until the next record, and leaving puts the ref back on that code.
   */
  private async settle(workspacePath: string, branches: ConversationBranch[], selected: ConversationBranch, snapshot: Snapshot, switchedIn: SwitchedIn): Promise<void> {
    for (const branch of branches) if (branch.lifecycle !== 'tombstoned') branch.lifecycle = branch.id === selected.id ? 'active' : 'inactive'
    await gitAsync(workspacePath, ['update-ref', '--no-deref', selected.retainedRef, snapshot.sha])
    atomicWriteJsonSync(this.path, branches)
    const manager = new ThreadWorkspaceManager(this.threadDirectory)
    const metadata = manager.load()
    if (metadata) atomicWriteJsonSync(manager.workspacePath, { ...metadata, conversationBranchId: selected.id, retainedRef: selected.retainedRef, snapshotSha: snapshot.sha, headSha: snapshot.head ?? metadata.headSha, switchedIn, generation: (metadata.generation ?? 0) + 1 })
  }

  /**
   * Finishes a switch that stopped. One that stopped after its intent (`prepared`) is never replayed: the files the
   * switch writes are read from disk. All of them as planned finishes the switch; none of them cancels it; some only
   * stays pending for a person. One that stopped with only the conversation left (`context_pending`) restores the
   * conversation.
   */
  async recoverPending(workspacePath: string, restoreContext: (branch: ConversationBranch) => void | Promise<void>, heldThreadLease?: ThreadLeaseHandle, signal?: AbortSignal): Promise<void> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, 'branch-context-recovery', async () => {
      for (const entry of this.journal.latestByOperation().values()) {
        if (entry.operationType !== 'conversation-activate') continue
        if (entry.state === 'prepared') {
          const intent = entry.details as SwitchIntent
          const branches = this.list()
          const branch = branches.find((item) => item.id === intent.branchId)
          if (!branch || !intent.expectedTree || !intent.ours || !intent.own) throw new Error('Conversation branch recovery does not match the recorded branch.')
          const exact = await plannedExactAsync(workspacePath, intent.ours, intent.expectedExactTree)
          const outcome = moveOutcome(await moveProgressAsync(workspacePath, await treeOfAsync(workspacePath, intent.ours), intent.expectedTree, exact))
          if (outcome === 'partial') throw new Error('Switching conversation branches stopped partway, and the files match neither the state before nor the state after the switch; resolve the differences by hand.')
          if (outcome === 'not-applied') {
            this.journal.append({ operationId: entry.operationId, operationType: 'conversation-activate', state: 'cancelled', details: { branchId: intent.branchId, recoveredBeforeFiles: true } })
            this.stayOn(intent.leaving, intent.base ?? intent.ours, intent.ours)
            continue
          }
          // The files are recorded as the switch planned them; anything that appeared since is an edit made since.
          const snapshot = await snapshotOfTreeAsync(workspacePath, intent.expectedTree, { reason: `switch to conversation branch ${branch.id}`, threadId: new ThreadWorkspaceManager(this.threadDirectory).load()?.threadId, operationId: entry.operationId }, exact?.to, await plannedExactGapsAsync(workspacePath, intent.ours, intent.expectedTree))
          await this.settle(workspacePath, branches, branch, snapshot, { branchId: branch.id, snapshotSha: snapshot.sha, own: intent.own, at: new Date().toISOString() })
          this.journal.append({ operationId: entry.operationId, operationType: 'conversation-activate', state: 'context_pending', details: { branchId: branch.id, snapshotSha: snapshot.sha, restoreContext: intent.restoreContext, recovered: true } })
          if (intent.restoreContext) await restoreContext(branch)
          this.journal.append({ operationId: entry.operationId, operationType: 'conversation-activate', state: 'completed', details: { branchId: branch.id, recovered: true } })
          continue
        }
        if (entry.state !== 'context_pending') continue
        const details = entry.details as { branchId: string; restoreContext: boolean; conversationOnly?: boolean }
        const branches = this.list()
        const branch = branches.find((item) => item.id === details.branchId)
        // The files were switched before this entry was written; only the conversation side is left to restore.
        if (!branch) throw new Error('Conversation branch recovery does not match the recorded branch.')
        // A conversation-only switch may have stopped before the branch list or the thread's record named the branch.
        if (details.conversationOnly) await this.settleConversation(workspacePath, branches, branch)
        if (details.restoreContext) await restoreContext(branch)
        this.journal.append({ operationId: entry.operationId, operationType: 'conversation-activate', state: 'completed', details: { branchId: branch.id, recovered: true } })
      }
    }, signal, heldThreadLease)
  }

  /**
   * Starts a conversation branch at a turn's code: the turn's end snapshot (or, for `current`, a snapshot of the files
   * now) is pinned under `refs/mousse/conversation-branches/<id>`. No Git branch is made; the files and the checkout
   * are left as they are until the branch is activated.
   */
  async fork(
    workspacePath: string,
    sourceBranchId: ConversationBranchId,
    actionId: string,
    name: string,
    expectedJournalRevision?: number,
    codeMode: 'historical' | 'current' = 'historical',
    at: 'start' | 'end' = 'end',
    assertIdle?: () => void
  ): Promise<ConversationBranch> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, 'conversation-fork', async () => {
      assertIdle?.()
      this.actions.assertExpectedRevision(expectedJournalRevision)
      return this.forkHeld(workspacePath, sourceBranchId, actionId, name, codeMode, at)
    })
  }

  /**
   * Edits a prompt: one step, under the thread's locks, that makes a branch starting before the action's turn which
   * shares the thread's files (`files: 'shared'`) and switches to it. Only the conversation changes; no file does.
   * `created` is told the branch before the switch (its conversation is saved there), so the switch restores it.
   */
  async edit(
    workspacePath: string,
    sourceBranchId: ConversationBranchId,
    actionId: string,
    name: string,
    hooks: {
      expectedJournalRevision?: number
      assertIdle?: () => void
      created: (branch: ConversationBranch) => void | Promise<void>
      restoreContext: (branch: ConversationBranch) => void | Promise<void>
      saveContext: (leaving: ConversationBranchId) => void | Promise<void>
    }
  ): Promise<ConversationBranchActivation> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, 'conversation-edit', async () => {
      hooks.assertIdle?.()
      this.actions.assertExpectedRevision(hooks.expectedJournalRevision)
      await hooks.saveContext(sourceBranchId)
      const branch = await this.forkHeld(workspacePath, sourceBranchId, actionId, name, 'current', 'start')
      await hooks.created(branch)
      return this.activateHeld(workspacePath, branch.id, hooks.restoreContext, hooks.saveContext)
    })
  }

  private async forkHeld(
    workspacePath: string,
    sourceBranchId: ConversationBranchId,
    actionId: string,
    name: string,
    codeMode: 'historical' | 'current',
    at: 'start' | 'end'
  ): Promise<ConversationBranch> {
    {
      const action = this.actions.get(actionId)
      // A branch before a turn (an edited prompt) shares the thread's files and needs no snapshot of the action's, so
      // it works for a turn older than the Undo window, and for a turn that recorded no files.
      if (action?.scope === 'conversation' && at === 'end') throw new Error('Conversation-only turns have no repository snapshot to fork.')
      // A branch after a turn needs the turn to have finished well; one before it (an edited prompt) only needs it to
      // have finished, so a prompt after a stopped turn, or the first prompt, can be edited.
      if (!action || (at === 'end' ? action.state !== 'completed' : action.state === 'running')) throw new Error(at === 'end' ? 'Fork requires a completed action.' : 'Wait for the turn to finish before editing its prompt.')
      new ChangeReceiptService(this.threadDirectory).assertNoPendingOperation()
      if (codeMode === 'historical' && at === 'end') new UndoRetentionService(this.threadDirectory).assertAvailable(action)
      if (action.conversationBranchId !== sourceBranchId) throw new Error('Action does not belong to the source conversation branch.')
      const boundary = at === 'start' ? action.nativeContextStartBoundary : action.nativeContextBoundary
      if (!boundary?.safeBoundaryProof || (at === 'start' && boundary.fidelity === 'legacy')) throw new Error('The selected turn has no validated native-context boundary.')
      const id = randomUUID()
      const operationId = randomUUID()
      const retainedRef = `refs/mousse/conversation-branches/${id}`
      const metadata = new ThreadWorkspaceManager(this.threadDirectory).load()
      // A branch that shares the thread's files reads none: its ref only pins the thread's latest recorded files.
      const codeSha = at === 'start' ? metadata?.snapshotSha ?? action.endSha ?? action.startSha
        : codeMode === 'current' ? (await takeSnapshotAsync(workspacePath, { reason: 'fork', threadId: metadata?.threadId, operationId })).sha : action.endSha
      this.journal.append({
        operationId,
        operationType: 'conversation-fork',
        state: 'running',
        expectedPreState: { sourceBranchId, actionId, codeMode, codeSha, at }
      })
      try {
        await gitAsync(workspacePath, ['update-ref', '--no-deref', retainedRef, codeSha])
        const record: ConversationBranch = {
          id,
          name,
          parentBranchId: sourceBranchId,
          parentTurnId: action.turnId,
          ...(at === 'start' ? { at, files: 'shared' as const } : {}),
          // Conversation branches share the worktree and its Git branch; they differ in the snapshot they own.
          gitBranch: metadata?.branch ?? '',
          retainedRef,
          contextBoundary: boundary,
          lifecycle: 'inactive',
          creationReason: 'fork',
          createdAt: new Date().toISOString()
        }
        // The first fork also writes the record of the branch the thread started on, so it can be switched back to.
        const { branches } = this.withFirstBranch(this.list(), metadata, metadata?.conversationBranchId ?? FIRST_BRANCH_ID)
        branches.push(record)
        atomicWriteJsonSync(this.path, branches)
        this.journal.append({
          operationId,
          operationType: 'conversation-fork',
          state: 'completed',
          details: { branchId: id, actionId }
        })
        return record
      } catch (error) {
        this.journal.append({
          operationId,
          operationType: 'conversation-fork',
          state: 'failed',
          details: { actionId, error: error instanceof Error ? error.message : String(error) }
        })
        throw error
      }
    }
  }
}
