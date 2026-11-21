import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { git } from '../actions/git'
import { assertUndoRefMayBeClaimed } from '../actions/undoRefClaims'
import { expiredReceiptIdsFromJournal } from '../actions/UndoRetentionService'
import { ThreadJournal } from '../data/ThreadJournal'
import { resolveRepositoryIdentity, resolveRepositoryIdentityAsync } from '../git/RepositoryIdentity'
import { acquireRepositoryLease, RepositoryLeaseBusyError, tryAcquireRepositoryLease } from '../git/RepositoryLease'
import { READ_ONLY_GIT_ENV } from '../git/readOnlyGit'

const RECEIPT_REF = /^refs\/mousse\/changes\/([0-9a-f-]{36})\/(before|after)$/i

/** A pre-existing thread folder's live claims and the Git checkout that holds them. */
function threadUndoClaims(location: string) {
  const workspacePath = ['workspace.json', 'project-folder.json'].map((file) => join(location, file)).find(existsSync)
  if (!workspacePath) return undefined
  const workspace = JSON.parse(readFileSync(workspacePath, 'utf8')) as { worktreePath?: string; integrationTarget?: { checkoutPath?: string } }
  const paths = [workspace.worktreePath, workspace.integrationTarget?.checkoutPath].filter((path): path is string => Boolean(path && isAbsolute(path) && existsSync(path)))
  if (!paths.length) return undefined
  const journal = new ThreadJournal(location, { readOnly: true })
  const expired = expiredReceiptIdsFromJournal(journal.ofTypes('undo-retention'))
  const refs = new Map<string, string | undefined>()
  for (const receipt of journal.receipts()) {
    if (expired.has(receipt.id)) continue
    for (const name of receipt.retainedRefs ?? []) {
      const match = RECEIPT_REF.exec(name)
      if (match?.[1] === receipt.id) refs.set(name, match[2] === 'before' ? receipt.beforeSha : receipt.afterSha)
    }
  }
  const branches = join(location, 'conversation-branches.json')
  if (existsSync(branches)) {
    for (const { retainedRef } of JSON.parse(readFileSync(branches, 'utf8')) as Array<{ retainedRef?: string }>) {
      if (retainedRef && RECEIPT_REF.test(retainedRef) && !refs.has(retainedRef)) refs.set(retainedRef, undefined)
    }
  }
  return refs.size ? { paths, refs } : undefined
}

/** Registration and legacy copies publish pre-existing Undo claims under the same lease as release. */
export function withCopiedUndoClaims<T>(location: string, publish: () => T): T {
  const claims = threadUndoClaims(location)
  if (!claims) return publish()
  for (const cwd of claims.paths) {
    const repository = resolveRepositoryIdentity(cwd)
    if (!repository.capability.allowed) continue
    const lease = tryAcquireRepositoryLease(repository)
    if (!lease) throw new RepositoryLeaseBusyError()
    try {
      for (const ref of claims.refs.keys()) assertUndoRefMayBeClaimed(repository, RECEIPT_REF.exec(ref)![1]!)
      const listing = git(cwd, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', 'refs/mousse/changes/'], READ_ONLY_GIT_ENV)
      const direct = new Map(listing.split(/\r?\n/).map((row) => row.split('\0')).filter(([name, oid, symref]) => name && oid && !symref).map(([name, oid]) => [name!, oid!]))
      for (const [ref, expected] of claims.refs) {
        const oid = direct.get(ref)
        if (!oid || expected !== undefined && expected !== oid) throw new Error(`Cannot copy unavailable Undo reference: ${ref}`)
      }
      return publish()
    } finally { lease.release() }
  }
  throw new Error('Cannot verify the repository of the copied Undo history.')
}

/**
 * Moving a registered thread preserves its claim. Serialize the short rename and its durable location update with
 * release so the final scan cannot read its metadata at the old location and look for its journal after the move.
 */
export async function withMovingUndoClaims<T>(location: string, move: () => T, restore: boolean): Promise<T> {
  const claims = threadUndoClaims(location)
  if (!claims) return move()
  for (const cwd of claims.paths) {
    const repository = await resolveRepositoryIdentityAsync(cwd)
    if (!repository.capability.allowed) continue
    const lease = await acquireRepositoryLease(repository, { maxWaitMs: 30_000 })
    try {
      if (restore) for (const ref of claims.refs.keys()) assertUndoRefMayBeClaimed(repository, RECEIPT_REF.exec(ref)![1]!)
      return move()
    } finally { lease.release() }
  }
  // A registered owner remains in the inventory even when its repository is unavailable.
  return move()
}
