import { randomUUID } from 'node:crypto'
import { access, lstat, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import { ThreadJournal } from '../data/ThreadJournal'
import { withGitMutationLocks } from './GitOperationCoordinator'
import { currentUserRequest, withoutUserRequest, withUserRequest, type UserAction } from '../git/gitPolicy'
import { git, gitAsync, LISTING, mergeTreesAsync, requireCleanAsync, treeOfAsync, tryGitAsync } from './git'
import { convertedPathsAsync, publishedRef, sameTreeAsync, takeSnapshotAsync } from './snapshots'
import { KeepCopyRefusedError, keptPathsText, listZOver, writeBackKeptFiles, type KeptCopy } from './keptCopies'
import { indexAt, namedFew, overwriteKeepingCopy, untrackedInTheWay } from './overwriteKeepingCopy'
import { ChangeReceiptService } from './ChangeReceiptService'
import { ThreadActionService } from './ThreadActionService'
import { ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import { mergeIdentityAsync } from './leftMerge'
import { resolveRepositoryIdentityAsync } from '../git/RepositoryIdentity'
import { waitForFolderAccess } from '../files/folderAccess'

/** Whether `path` is there, as `existsSync` answers, once its volume answers; never blocks the daemon. */
async function exists(path: string): Promise<boolean> {
  await waitForFolderAccess([path])
  return access(path).then(() => true, () => false)
}

export interface PublishOptions {
  operationId?: string
  heldThreadLease?: ThreadLeaseHandle
  /** The thread's files as the person reviewed them (a snapshot, or any commit with the same files). Publishing refuses when the files differ. */
  expectedSourceSha?: string
  expectedTargetSha?: string
  expectedJournalRevision?: number
  /** The commit message in the primary checkout. */
  message?: string
  /** The user's request to publish; the commit and the fast-forward in the primary checkout run under it. */
  userRequested?: UserAction
}

export interface PublishResult {
  operationId: string
  /** The snapshot of the thread's files that was published. */
  sourceSha?: string
  receiptId?: string
  state: 'completed' | 'conflict'
  prePublishSha: string
  publishSha?: string
  conflictFiles?: string[]
  /**
   * Files in the primary checkout whose bytes on disk were not exactly what Git holds for them (line endings, an encoding
   * or a filter's form), which the publish wrote over: kept as one copy of the thread's, for its Undo window.
   */
  kept?: PublishKept
  /** What the result says about `kept`: which files, for how long, and the command that brings each back. */
  notice?: string
}

export interface PublishKept { ref: string; files: string[]; windowMs: number }

/**
 * What a publish that writes over converted bytes records before it empties any path: its copy, and the kept paths it is
 * about to empty, so recovery after a stop before Git's fast-forward puts them back.
 */
interface PublishHolding extends PublishKept {
  /** The repository's top folder, which the copy's paths are relative to. */
  top: string
  emptied: string[]
  /** Each kept file's permission bits, as the copy recorded them. */
  permissions: Record<string, number>
}

/** Git's fast-forward failed; its message is Git's. */
class FastForwardFailed extends Error {
  constructor(readonly stderr: string) { super(stderr || 'Git refused the update') }
}

/** What `prepared` records: the commit is made before the primary moves, so recovery can tell whether it landed. */
interface PublishIntent {
  prePublishSha: string
  targetBranch: string
  sourceBranch?: string
  sourceSha: string
  publishSha: string
  tree: string
}

const DEFAULT_MESSAGE = 'Changes from a Mousse thread'
/** A publish in one of these states started and did not finish; `recovery_required` is what older versions left. */
const PENDING_STATES = ['prepared', 'git_applied', 'recovery_required']

export type PublishRecovery =
  | { operationId: string; state: 'completed'; result: PublishResult }
  /** `notRestored`: files a stopped publish had set aside that could not be put back, because something stands there now. */
  | { operationId: string; state: 'cancelled'; mergeInProgress?: string; notRestored?: string[] }
  /** The primary checkout could not be read; the publish stays as it is and is looked at again on the next recovery. */
  | { operationId: string; state: 'pending'; reason: string }

/**
 * Every path moving from `from` to `to` writes or removes (`diff-tree -r --no-renames`), with its status letter: added,
 * changed, type changed or deleted. Reads only.
 */
async function writeSetOf(checkout: string, from: string, to: string): Promise<Array<{ status: string; path: string }>> {
  const fields = (await gitAsync(checkout, ['diff-tree', '-r', '-z', '--no-renames', '--name-status', from, to], undefined, undefined, LISTING)).split('\0')
  const set: Array<{ status: string; path: string }> = []
  for (let at = 0; at + 1 < fields.length; at += 2) if (fields[at]) set.push({ status: fields[at]!, path: fields[at + 1]! })
  return set
}

/**
 * Untracked, ignored files in `checkout` that writing `written` (the paths the new tree adds or changes) would write
 * over: at one of them, or a folder above one. Reads only.
 */
async function ignoredInTheWay(checkout: string, written: readonly string[]): Promise<string[]> {
  if (!written.length) return []
  const candidates = new Set<string>()
  for (const path of written) {
    const parts = path.split('/')
    for (let depth = 1; depth <= parts.length; depth++) candidates.add(parts.slice(0, depth).join('/'))
  }
  const found = new Set<string>()
  const list = [...candidates]
  for (let start = 0; start < list.length; start += 500) {
    const chunk = list.slice(start, start + 500).map((path) => `:(literal)${path}`)
    for (const path of (await gitAsync(checkout, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...chunk], undefined, undefined, LISTING)).split('\0').filter(Boolean)) found.add(path)
  }
  return [...found].sort()
}

/**
 * Publishes the thread's files into the primary checkout as one commit on its current branch, made with the person's
 * own Git identity. The files come from the thread's latest snapshot, not its branch, so uncommitted turn results are
 * published and Mousse's snapshots never reach the primary's history. The result is a three-way merge of the snapshot
 * onto the primary (base: what the thread last published, else where it started); a conflict refuses with the file
 * names and changes nothing. The primary must be clean and on the target branch.
 */
export class PublishService {
  private readonly journal: ThreadJournal
  constructor(private readonly threadDirectory: string) {
    this.journal = new ThreadJournal(threadDirectory)
  }

  async publish(
    threadWorkspace: string,
    primaryCheckout: string,
    targetBranch: string,
    signal?: AbortSignal,
    options: PublishOptions = {}
  ): Promise<PublishResult> {
    return withGitMutationLocks(this.threadDirectory, primaryCheckout, 'publish', async () => {
      const previous = options.operationId ? this.journal.latestByOperation().get(options.operationId) : undefined
      if (previous?.state === 'completed') {
        const result = previous.details as PublishResult
        if (await this.differs(threadWorkspace, options.expectedSourceSha, result.sourceSha) || (options.expectedTargetSha && result.prePublishSha !== options.expectedTargetSha)) throw new Error('Publish operation identity was reused for different revisions.')
        return result
      }
      const receipts = new ChangeReceiptService(this.threadDirectory)
      if (previous && PENDING_STATES.includes(previous.state)) {
        const intent = this.intentOf(options.operationId!)
        if (!intent || await this.differs(threadWorkspace, options.expectedSourceSha, intent.expected.sourceSha) || (options.expectedTargetSha && intent.expected.prePublishSha !== options.expectedTargetSha) || intent.expected.targetBranch !== targetBranch) throw new Error('Publish recovery requires the original reviewed revisions.')
        // The earlier attempt is recorded first. Only when it did not land does this explicit Publish go on to publish again.
        const recovered = await withoutUserRequest(() => this.settle(primaryCheckout, options.operationId!, intent.expected, intent.paths.holding))
        if (recovered.state === 'completed') return recovered.result
        if (recovered.state === 'pending') throw new Error(`An earlier publish is not settled yet: ${recovered.reason}.`)
      }
      // Another publish that did not finish is settled first; one that cannot be settled yet stops only this publish.
      for (const entry of this.journal.latestByOperation().values()) {
        if (entry.operationId === options.operationId || !['publish', 'change-publish'].includes(entry.operationType) || !PENDING_STATES.includes(entry.state)) continue
        const intent = this.intentOf(entry.operationId)
        const recorded = intent?.paths.primaryCheckout
        const checkout = recorded && await exists(recorded) ? recorded : primaryCheckout
        const settled = intent ? await withoutUserRequest(() => this.settle(checkout, entry.operationId, intent.expected, intent.paths.holding)) : undefined
        if (settled?.state === 'pending') throw new Error(`An earlier publish is not settled yet: ${settled.reason}.`)
      }
      receipts.assertNoPendingOperation()
      new ThreadActionService(this.threadDirectory).assertExpectedRevision(options.expectedJournalRevision)
      if ((await resolveRepositoryIdentityAsync(threadWorkspace)).key !== (await resolveRepositoryIdentityAsync(primaryCheckout)).key) throw new Error('Publish destination belongs to a different repository.')
      const metadata = new ThreadWorkspaceManager(this.threadDirectory).load()
      // The thread's files as they are now. Edits made outside Mousse since the last action are recorded first, so a
      // refused publish still leaves the next review looking at the files that would be published.
      const source = metadata && await gitAsync(metadata.worktreePath, ['rev-parse', '--show-toplevel']) === await gitAsync(threadWorkspace, ['rev-parse', '--show-toplevel'])
        ? (await new ThreadActionService(this.threadDirectory).recordOutsideChangesHeld({ threadId: metadata.threadId, conversationBranchId: metadata.conversationBranchId, workspacePath: threadWorkspace })).startSha
        : (await takeSnapshotAsync(threadWorkspace, { reason: 'publish', operationId: options.operationId })).sha
      if (await this.differs(threadWorkspace, options.expectedSourceSha, source)) throw new Error('Publish source revision changed; refresh review.')
      const prePublishSha = await gitAsync(primaryCheckout, ['rev-parse', 'HEAD'])
      if (options.expectedTargetSha && prePublishSha !== options.expectedTargetSha) throw new Error('Publish destination revision changed; refresh review.')
      const currentTarget = await gitAsync(primaryCheckout, ['branch', '--show-current'])
      if (currentTarget !== targetBranch) throw new Error(`Primary checkout must be on ${targetBranch}, found ${currentTarget}`)
      // The primary's files are rewritten in place, so nothing in them may be waiting: no uncommitted edit is set aside or merged over.
      await requireCleanAsync(primaryCheckout, 'Primary checkout')
      const operationId = options.operationId ?? randomUUID()
      const base = (metadata && (await tryGitAsync(primaryCheckout, ['rev-parse', '--verify', '-q', `${publishedRef(metadata.threadId)}^{commit}`])).stdout) || metadata?.baseSha || await gitAsync(primaryCheckout, ['merge-base', prePublishSha, source])
      const top = await gitAsync(primaryCheckout, ['rev-parse', '--show-toplevel'])
      const merged = await mergeTreesAsync(top, base, prePublishSha, source)
      if ('conflicts' in merged) return { operationId, state: 'conflict', prePublishSha, sourceSha: source, conflictFiles: merged.conflicts }
      // Nothing to add: the primary already has these files, as when the same changes were merged another way.
      if (merged.tree === await treeOfAsync(primaryCheckout, prePublishSha)) return this.completePublish(primaryCheckout, operationId, prePublishSha, source, prePublishSha)
      // Every path the fast-forward writes or removes. A deleted file is written over too: its bytes are gone after.
      const writeSet = await writeSetOf(primaryCheckout, prePublishSha, merged.tree)
      // An ignored file in the primary is the person's (a local config, a build output) and is never written over.
      const ignored = await ignoredInTheWay(primaryCheckout, writeSet.filter((item) => /^[AMT]/.test(item.status)).map((item) => item.path))
      if (ignored.length) throw new Error(`Publish would overwrite ignored files in ${primaryCheckout}: ${ignored.slice(0, 10).join(', ')}${ignored.length > 10 ? ` and ${ignored.length - 10} more` : ''}. Move them aside, then publish again. Nothing was changed.`)
      // The commit and the move of the primary's branch are the user's request; nothing else in a publish borrows it.
      const request = options.userRequested ?? currentUserRequest()
      const asked = <T>(work: () => T): T => request ? withUserRequest(request, work) : work()
      const publishSha = await asked(() => this.commit(primaryCheckout, merged.tree, prePublishSha, options.message))
      const sourceBranch = (await tryGitAsync(threadWorkspace, ['branch', '--show-current'])).stdout || undefined
      const intent = { prePublishSha, targetBranch, sourceBranch, sourceSha: source, publishSha, tree: merged.tree } satisfies PublishIntent
      this.journal.append({ operationId, operationType: 'publish', state: 'prepared', expectedPreState: intent, details: { threadWorkspace, primaryCheckout } })
      // Where Git converts a file it writes (line endings, an encoding, a filter), the bytes on disk may be ones no commit
      // holds, though Git calls the checkout clean: those are kept first, and Git writes only where nothing stands.
      const paths = writeSet.map((item) => item.path)
      const converted = await convertedPathsAsync(top, paths)
      if (converted.length) {
        const kept = await this.fastForwardKeepingCopy({ top, primaryCheckout, threadWorkspace, operationId, intent, paths, asked })
        return this.completePublish(primaryCheckout, operationId, prePublishSha, source, publishSha, kept)
      }
      // The branch, the index and the files move together or not at all; a fast-forward refuses before touching anything
      // it cannot update, and never writes over an ignored file.
      const moved = await asked(() => tryGitAsync(primaryCheckout, ['merge', '--ff-only', '--no-overwrite-ignore', publishSha]))
      if (!moved.ok) {
        // The branch did not move, so there is nothing to recover: the attempt is closed and the thread stays usable.
        const left = await gitAsync(primaryCheckout, ['status', '--porcelain', '--untracked-files=all'], undefined, undefined, LISTING)
        this.journal.append({ operationId, operationType: 'publish', state: 'cancelled', details: { prePublishSha, targetBranch, error: moved.stderr, ...(left ? { leftFiles: true } : {}) } })
        throw new Error(`Publish could not update ${primaryCheckout}: ${moved.stderr || 'Git refused the update'}. ${left ? 'Some of its files may have been updated; check git status there.' : 'Nothing was changed.'}`)
      }
      return this.completePublish(primaryCheckout, operationId, prePublishSha, source, publishSha)
    }, signal, options.heldThreadLease)
  }

  /** Whether the reviewed revision names other files than the one published. A missing one never differs. */
  private async differs(cwd: string, expected: string | undefined, actual: string | undefined): Promise<boolean> {
    // Publish commits Git's form of the files, so a file whose line endings alone changed since the review is the same.
    return Boolean(expected) && (!actual || !await sameTreeAsync(cwd, expected!, actual, { exact: false }))
  }

  /** The one commit in the primary, with the tree the merge produced and the person's own author and committer. */
  private async commit(primaryCheckout: string, tree: string, parent: string, message = DEFAULT_MESSAGE): Promise<string> {
    try {
      return await gitAsync(primaryCheckout, ['commit-tree', tree, '-p', parent, '-m', message.trim() || DEFAULT_MESSAGE])
    } catch (error) {
      const detail = String((error as { stderr?: unknown }).stderr ?? (error as Error).message)
      if (/ident|who you are|user\.(name|email)|empty name|empty email/i.test(detail)) throw new Error(`Git does not know who you are in ${primaryCheckout}. Set user.name and user.email, then publish again.`, { cause: error })
      throw error
    }
  }

  /**
   * The fast-forward of the primary to the publish commit, where it writes over files Git converts
   * ({@link overwriteKeepingCopy}): files whose bytes on disk are not Git's form of their commit's are kept as the
   * thread's copy (`publish-keep`) and removed, proven, so Git only creates; the rest are left for Git to write over, as
   * the commit it moves from holds them. A file that is not tracked where the publish adds one refuses, as Git's
   * fast-forward does. Before any path is emptied the copy is recorded (`holding`), so recovery can put the files back.
   * When Git fails, every removed file is put back and the publish is cancelled. Returns what was kept, if anything.
   */
  private async fastForwardKeepingCopy(input: { top: string; primaryCheckout: string; threadWorkspace: string; operationId: string; intent: PublishIntent; paths: string[]; asked: <T>(work: () => T) => T }): Promise<KeptCopy | undefined> {
    const { top, primaryCheckout, operationId, intent, paths } = input
    const cancel = (details: Record<string, unknown>): void => { this.journal.append({ operationId, operationType: 'publish', state: 'cancelled', details: { prePublishSha: intent.prePublishSha, targetBranch: intent.targetBranch, ...details } }) }
    try {
      const done = await overwriteKeepingCopy({
        owner: this.threadDirectory, top, operationType: 'publish-keep', action: 'Publish', held: 'left',
        round: async () => {
          const untracked = await untrackedInTheWay(top, intent.publishSha, paths, (await indexAt(top, paths)).modes)
          if (untracked.length) {
            const one = untracked.length === 1
            throw new KeepCopyRefusedError(`Publish was stopped: ${namedFew(untracked)} ${one ? 'is' : 'are'} not tracked and ${one ? 'stands' : 'stand'} where the publish puts a file in ${primaryCheckout}, and Git's fast-forward refuses to write over ${one ? 'it' : 'them'}. Nothing was changed. Move ${one ? 'it' : 'them'} aside, then publish again.`, untracked)
          }
          return { target: intent.publishSha, writes: paths }
        },
        holding: (kept, emptied) => {
          const files = [...kept.digests.keys()].sort()
          const permissions = Object.fromEntries([...kept.permissions].filter(([path]) => emptied.some((item) => path === item || path.startsWith(`${item}/`))))
          const holding: PublishHolding = { ref: kept.ref, files, windowMs: kept.windowMs, top, emptied: [...emptied], permissions }
          this.journal.append({ operationId, operationType: 'publish', state: 'prepared', expectedPreState: intent, details: { threadWorkspace: input.threadWorkspace, primaryCheckout, holding } })
        },
        // `--no-autostash`: with `merge.autostash` set, Git would stash the emptied paths and apply them again as conflicts.
        run: async (beforeStart) => {
          const moved = await input.asked(() => tryGitAsync(primaryCheckout, ['merge', '--ff-only', '--no-overwrite-ignore', '--no-autostash', intent.publishSha], undefined, {
            beforeStart: () => {
              // The fast-forward writes what changed from HEAD: only from the commit the copy was worked out from.
              if (git(primaryCheckout, ['rev-parse', 'HEAD']) !== intent.prePublishSha) throw new FastForwardFailed(`${intent.targetBranch} moved while the publish was being prepared`)
              beforeStart()
            }
          }))
          if (!moved.ok) throw new FastForwardFailed(moved.stderr)
        },
        stoppedPartWay: (error, kept, left) => Object.assign(new Error(`Publish could not update ${primaryCheckout}: ${error instanceof Error ? error.message : String(error)}. Git stopped part way, after it wrote over ${left.length === 1 ? left[0] : `${left.length} files`}. ${keptPathsText(kept, left)}`, { cause: error }), { partWay: true })
      })
      return done?.kept && done.kept.digests.size ? done.kept : undefined
    } catch (error) {
      if (error instanceof KeepCopyRefusedError) { cancel({ error: error.message }); throw error }
      if ((error as { partWay?: boolean }).partWay) { cancel({ error: (error as Error).message, leftFiles: true }); throw error }
      if (!(error instanceof FastForwardFailed)) { cancel({ error: error instanceof Error ? error.message : String(error) }); throw error }
      // Every removed file is back; the branch did not move.
      const left = await gitAsync(primaryCheckout, ['status', '--porcelain', '--untracked-files=all'], undefined, undefined, LISTING)
      cancel({ error: error.stderr, ...(left ? { leftFiles: true } : {}) })
      throw new Error(`Publish could not update ${primaryCheckout}: ${error.stderr || 'Git refused the update'}. ${left ? 'Some of its files may have been updated; check git status there.' : 'Nothing was changed.'}`, { cause: error })
    }
  }

  private async completePublish(primaryCheckout: string, operationId: string, prePublishSha: string, sourceSha: string, publishSha: string, kept?: KeptCopy | PublishHolding): Promise<PublishResult> {
    const receipts = new ChangeReceiptService(this.threadDirectory)
    const metadata = new ThreadWorkspaceManager(this.threadDirectory).load()
    // The next publish brings in only what the thread changed after these files.
    if (metadata) await gitAsync(primaryCheckout, ['update-ref', '--no-deref', publishedRef(metadata.threadId), sourceSha])
    const receipt = await receipts.record(primaryCheckout, {
      operationId, kind: 'publish', actor: { kind: 'user' }, beforeSha: prePublishSha, afterSha: publishSha,
      introducedCommits: prePublishSha === publishSha ? [] : [publishSha],
      contributions: [{ baseSha: prePublishSha, resultSha: sourceSha }], externalEffects: [],
      publishedReceiptIds: this.includedReceipts()
    })
    const result: PublishResult = { operationId, state: 'completed', prePublishSha, publishSha, sourceSha, receiptId: receipt.id, ...(kept ? keptResult(kept) : {}) }
    this.journal.append({ operationId, operationType: 'publish', state: 'completed', details: result })
    return result
  }

  /**
   * The thread's receipts whose changes are in the published files: every receipt but a publish, on the active
   * conversation branch, that has not been undone. The files are the thread's latest, so all of them are in.
   */
  private includedReceipts(): string[] {
    const active = new ThreadWorkspaceManager(this.threadDirectory).load()?.conversationBranchId
    const actions = new ThreadActionService(this.threadDirectory).list()
    return new ChangeReceiptService(this.threadDirectory).list().filter((item) => {
      if (item.kind === 'publish') return false
      const action = actions.find((entry) => entry.receiptId === item.id || entry.id === item.actionId)
      if (!action) return true
      return (!active || action.conversationBranchId === active) && action.state !== 'undone'
    }).map((item) => item.id)
  }

  /**
   * Settles every publish that did not finish: one that landed is recorded as completed, any other is cancelled. It
   * never publishes again and never touches the primary's index or branches. Its only write: a publish that stopped
   * after setting files aside and before its fast-forward (`holding`, the branch not moved) gets them put back, each only
   * where nothing stands. A publish an older version left waiting (`recovery_required`) is settled the same way.
   */
  async recoverPending(_threadWorkspace: string, primaryCheckout: string, heldThreadLease?: ThreadLeaseHandle): Promise<PublishRecovery[]> {
    // Recovery only records what an interrupted publish did; it never runs under the user's request.
    return withoutUserRequest(async () => {
      const pending = [...this.journal.latestByOperation().values()].filter((entry) => ['publish', 'change-publish'].includes(entry.operationType) && PENDING_STATES.includes(entry.state))
      if (!pending.length) return []
      // The primary cannot even be locked when it cannot be read: nothing is decided, and the next recovery tries again.
      if (!await exists(primaryCheckout) || !(await tryGitAsync(primaryCheckout, ['rev-parse', '--git-dir'])).ok) return pending.map((entry) => ({ operationId: entry.operationId, state: 'pending' as const, reason: `${primaryCheckout} could not be read` }))
      return withGitMutationLocks(this.threadDirectory, primaryCheckout, 'publish-recovery', async () => {
        // One at a time, in the journal's order.
        const settled: PublishRecovery[] = []
        for (const entry of pending) {
          const intent = this.intentOf(entry.operationId)
          if (!intent) {
            this.journal.append({ operationId: entry.operationId, operationType: 'publish', state: 'cancelled', details: { recovered: true, reason: 'The publish left no record of what it was about to do; nothing was checked or changed.' } })
            settled.push({ operationId: entry.operationId, state: 'cancelled' as const })
            continue
          }
          // The checkout the publish was made in; the one the thread now names when that one is gone.
          const recorded = intent.paths.primaryCheckout
          const checkout = recorded && await exists(recorded) ? recorded : primaryCheckout
          settled.push(await this.settle(checkout, entry.operationId, intent.expected, intent.paths.holding))
        }
        return settled
      }, undefined, heldThreadLease)
    })
  }

  /** The intent a publish recorded before it moved the primary, and where it ran. */
  private intentOf(operationId: string): { expected: PublishIntent; paths: { threadWorkspace?: string; primaryCheckout?: string; holding?: PublishHolding } } | undefined {
    const intent = [...this.journal.list()].reverse().find((entry) => entry.operationId === operationId && entry.state === 'prepared')
    const expected = intent?.expectedPreState as PublishIntent | undefined
    if (!expected?.prePublishSha || !expected.sourceSha || !expected.targetBranch) return undefined
    return { expected, paths: (intent!.details ?? {}) as { threadWorkspace?: string; primaryCheckout?: string; holding?: PublishHolding } }
  }

  /**
   * Records how an interrupted publish ended, from the target branch's tip: completed when its commit is there (or,
   * for one made before snapshots, its merge), cancelled otherwise. Never publishes again. A cancelled one that had set
   * files aside (`holding`) with the branch where it was puts them back, create-only, and names any it could not.
   */
  private async settle(primaryCheckout: string, operationId: string, expected: PublishIntent, holding?: PublishHolding): Promise<PublishRecovery> {
    const tip = await exists(primaryCheckout) ? (await tryGitAsync(primaryCheckout, ['rev-parse', '--verify', '-q', `refs/heads/${expected.targetBranch}^{commit}`])).stdout : ''
    const contains = async (sha: string): Promise<boolean> => Boolean(tip) && (tip === sha || (await tryGitAsync(primaryCheckout, ['merge-base', '--is-ancestor', sha, tip])).ok)
    const receipt = new ChangeReceiptService(this.threadDirectory).list().find((item) => item.operationId === operationId)
    // A publish interrupted before snapshots was a merge commit that has the reviewed commit as a parent.
    const mergedBefore = !expected.publishSha && Boolean(tip) && tip !== expected.prePublishSha && await contains(expected.sourceSha)
    const landed = receipt?.afterSha && await contains(receipt.afterSha) ? receipt.afterSha : expected.publishSha && await contains(expected.publishSha) ? expected.publishSha : mergedBefore ? tip : undefined
    if (landed) return { operationId, state: 'completed', result: await this.completePublish(primaryCheckout, operationId, expected.prePublishSha, expected.sourceSha, landed, holding?.files.length ? holding : undefined) }
    if (!tip) {
      // The checkout reads, and the branch is gone: the publish can never land there, so it is closed and later ones go on.
      const readable = await exists(primaryCheckout) && (await tryGitAsync(primaryCheckout, ['rev-parse', '--git-dir'])).ok
      if (readable && !(await tryGitAsync(primaryCheckout, ['show-ref', '--verify', '-q', `refs/heads/${expected.targetBranch}`])).ok) {
        this.journal.append({ operationId, operationType: 'publish', state: 'cancelled', details: { recovered: true, prePublishSha: expected.prePublishSha, targetBranch: expected.targetBranch, reason: `The publish did not land: target branch ${expected.targetBranch} no longer exists, and nothing was changed by recovery.` } })
        return { operationId, state: 'cancelled' }
      }
      // Unreadable now (a disk that is not mounted): nothing is decided, and recovery tries again.
      return { operationId, state: 'pending', reason: `${primaryCheckout} or its branch ${expected.targetBranch} could not be read` }
    }
    // A publish made before snapshots merged in the primary; a merge it left there is reported, and stays abortable.
    const mergeInProgress = !expected.publishSha && (await tryGitAsync(primaryCheckout, ['rev-parse', '--verify', '-q', 'MERGE_HEAD'])).ok ? primaryCheckout : undefined
    // Files it set aside before its fast-forward go back where nothing stands, only while the branch is where it was.
    const putBack = holding && tip === expected.prePublishSha ? await putBackHeld(holding) : undefined
    const held = holding && !putBack && holding.files.length ? ` The files it had set aside are kept: ${keptPathsText(noticeCopy(holding), holding.files)}` : ''
    const reason = mergeInProgress ? `a merge from an earlier version is still in progress in ${primaryCheckout}; abort it or finish it with Git`
      : putBack ? `${expected.targetBranch} did not move, and ${putBack.length ? `${namedFew(putBack)} could not be put back, because something else stands there now. ${keptPathsText(noticeCopy(holding!), putBack).replace(/\.$/, '')}` : 'the files it had set aside are back as they were'}`
      : tip === expected.prePublishSha ? `${expected.targetBranch} did not move, and nothing was changed by recovery` : `${expected.targetBranch} moved elsewhere, and nothing was changed by recovery`
    this.journal.append({ operationId, operationType: 'publish', state: 'cancelled', details: { recovered: true, prePublishSha: expected.prePublishSha, targetBranch: expected.targetBranch, tip, ...(mergeInProgress ? { mergeInProgress, mergeIdentity: await mergeIdentityAsync(mergeInProgress), sourceSha: expected.sourceSha } : {}), ...(putBack?.length ? { notRestored: putBack } : {}), reason: `The publish did not land: ${reason}.${held}` } })
    return { operationId, state: 'cancelled', ...(mergeInProgress ? { mergeInProgress } : {}), ...(putBack?.length ? { notRestored: putBack } : {}) }
  }
}

/** What a copy is, for a notice: its paths are the files it holds. */
function noticeCopy(kept: PublishKept & { top: string }): Parameters<typeof keptPathsText>[0] {
  return { ref: kept.ref, windowMs: kept.windowMs, top: kept.top, digests: new Map(kept.files.map((path) => [path, ''])) }
}

/** The result's `kept` and `notice` for a copy a publish kept: what it wrote over, and how to bring each file back. */
function keptResult(kept: KeptCopy | PublishHolding): Pick<PublishResult, 'kept' | 'notice'> {
  const files = 'files' in kept ? kept.files : [...kept.digests.keys()].sort()
  const notice = 'files' in kept ? noticeCopy(kept) : kept
  const one = files.length === 1
  return {
    kept: { ref: kept.ref, files, windowMs: kept.windowMs },
    notice: `Publish wrote over ${namedFew(files)}, whose bytes on disk were not exactly what Git holds for ${one ? 'it' : 'them'} (line endings, an encoding or a filter's form). ${keptPathsText(notice, files)}`
  }
}

/**
 * Puts back the files a publish set aside before its fast-forward, which did not run: each kept file under a path it was
 * about to empty is created where nothing stands, never written over. Returns the files that could not be put back
 * because something else stands there now; one standing there with the kept bytes was never removed, or is back.
 */
async function putBackHeld(holding: PublishHolding): Promise<string[]> {
  const sha = (await tryGitAsync(holding.top, ['rev-parse', '--verify', '-q', `${holding.ref}^{commit}`])).stdout
  if (!sha) return holding.files.filter((path) => holding.emptied.some((item) => path === item || path.startsWith(`${item}/`)))
  const rows = holding.emptied.length ? (await listZOver(holding.top, ['ls-tree', '-r', '-z', sha], holding.emptied)).map((line) => {
    const tab = line.indexOf('\t')
    const [mode, , id] = line.slice(0, tab).split(' ') as [string, string, string]
    return { mode, id, path: line.slice(tab + 1) }
  }).filter((row) => row.mode !== '160000') : []
  const left = new Set(await writeBackKeptFiles(holding.top, sha, rows.map((row) => row.path), new Map(Object.entries(holding.permissions))))
  const differs: string[] = []
  for (const row of rows.filter((item) => left.has(item.path))) {
    const absolute = join(holding.top, ...row.path.split('/'))
    const info = await lstat(absolute).catch(() => undefined)
    const same = !info ? false
      : row.mode === '120000' ? info.isSymbolicLink() && await readlink(absolute) === (await gitAsync(holding.top, ['cat-file', 'blob', row.id]))
      : info.isFile() && (await gitAsync(holding.top, ['hash-object', '--no-filters', '--', absolute])) === row.id
    if (!same) differs.push(row.path)
  }
  return differs.sort()
}
